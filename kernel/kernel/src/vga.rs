//! 帧缓冲文字渲染器（framebuffer text renderer）
//!
//! bootloader 0.11 不会让固件停在 VGA 文字模式，而是建立一个线性 framebuffer
//! 并让显卡跑在图形模式（QEMU 里通常 1280×720）。所以在裸机内核里往 0xB8000
//! 写字符字节根本到不了屏幕 —— 那里是位图，不是字符缓冲。
//!
//! 正确做法是直接往 framebuffer 里逐像素画字。我们用 `noto-sans-mono-bitmap`
//! 这个预光栅化的等宽字体（默认只含 Basic Latin，正好够终端用），把每个字符
//! 按强度混合前景/背景色，画进对应的像素块。这样既能在真机上出字，也能用
//! QEMU 的 `screendump` 把图形画面拍成 PNG 来验证。
//!
//! 配色照 LumeOS 的暗色主题：近黑底、白字、青蓝作强调。

use alloc::{vec, vec::Vec};
use bootloader_api::info::{FrameBuffer, FrameBufferInfo, PixelFormat};
use core::fmt::{self, Write};
use noto_sans_mono_bitmap::{get_raster, FontWeight, RasterHeight};
use spin::Mutex;
use x86_64::instructions::interrupts;

/// 公开的最大尺寸，给 shell 当缓冲上界用（实际行列数在 init 时算出来）
pub const WIDTH: usize = 240;
pub const HEIGHT: usize = 100;

/* ---------- 调色板：LumeOS 暗色主题的 16 色版 ---------- */
pub const BLACK: u8 = 0x0;
pub const BLUE: u8 = 0x1;
pub const GREEN: u8 = 0x2;
pub const CYAN: u8 = 0x3;
pub const RED: u8 = 0x4;
pub const MAGENTA: u8 = 0x5;
pub const BROWN: u8 = 0x6;
pub const LIGHT_GRAY: u8 = 0x7;
pub const DARK_GRAY: u8 = 0x8;
pub const LIGHT_BLUE: u8 = 0x9;
pub const LIGHT_GREEN: u8 = 0xA;
pub const LIGHT_CYAN: u8 = 0xB;
pub const LIGHT_RED: u8 = 0xC;
pub const PINK: u8 = 0xD;
pub const YELLOW: u8 = 0xE;
pub const WHITE: u8 = 0xF;

/// (r, g, b) 调色板，索引就是上面的 0x0..0xF
const PALETTE: [(u8, u8, u8); 16] = [
    (12, 12, 16),    // 0 近黑
    (54, 54, 150),   // 1 蓝
    (60, 180, 90),   // 2 绿
    (70, 200, 200),  // 3 青
    (210, 70, 70),   // 4 红
    (190, 90, 210),  // 5 品红
    (190, 130, 50),  // 6 棕
    (180, 180, 190), // 7 浅灰
    (100, 100, 110), // 8 深灰
    (110, 150, 255), // 9 亮蓝
    (110, 230, 130), // A 亮绿
    (110, 235, 235), // B 亮青
    (240, 110, 110), // C 亮红
    (240, 150, 225), // D 粉
    (235, 225, 110), // E 黄
    (235, 235, 245), // F 白
];

#[derive(Clone, Copy)]
struct Cell {
    ch: u8,
    fg: u8,
    bg: u8,
}

struct Writer {
    /// framebuffer 的可写切片基址（内核生命周期内一直有效）
    fb_ptr: usize,
    fb_len: usize,
    info: FrameBufferInfo,
    glyph_w: usize,
    glyph_h: usize,
    cell_w: usize,
    cell_h: usize,
    cols: usize,
    rows: usize,
    col: usize,
    row: usize,
    fg: u8,
    bg: u8,
    cur_row: usize,
    cur_col: usize,
    cur_visible: bool,
    /// viewport 左上角的像素坐标：Writer 的所有文字/填充都限制在它里面，
    /// 这样同一个 Writer 就能被「装进」窗口客户区，而桌面在它周围画边框。
    vx: usize,
    vy: usize,
    cells: Vec<Cell>,
}

impl Writer {
    const fn new() -> Self {
        Writer {
            fb_ptr: 0,
            fb_len: 0,
            info: FrameBufferInfo {
                byte_len: 0,
                width: 0,
                height: 0,
                pixel_format: PixelFormat::Rgb,
                bytes_per_pixel: 4,
                stride: 0,
            },
            glyph_w: 9,
            glyph_h: 16,
            cell_w: 10,
            cell_h: 16,
            cols: 0,
            rows: 0,
            col: 0,
            row: 0,
            fg: LIGHT_GRAY,
            bg: BLACK,
            cur_row: 0,
            cur_col: 0,
            cur_visible: false,
            vx: 0,
            vy: 0,
            cells: Vec::new(),
        }
    }

    /// 画一个像素。off 越界或 framebuffer 未初始化时静默放弃
    fn put_pixel(&self, x: usize, y: usize, rgb: (u8, u8, u8)) {
        if self.fb_len == 0 {
            return;
        }
        let w = self.info.width;
        let h = self.info.height;
        if x >= w || y >= h {
            return;
        }
        let bpp = self.info.bytes_per_pixel.max(1);
        let off = (y * self.info.stride + x) * bpp;
        if off + 2 >= self.fb_len {
            return;
        }
        let p = self.fb_ptr as *mut u8;
        unsafe {
            match self.info.pixel_format {
                PixelFormat::Bgr => {
                    *(p.add(off)) = rgb.2;
                    *(p.add(off + 1)) = rgb.1;
                    *(p.add(off + 2)) = rgb.0;
                }
                _ => {
                    *(p.add(off)) = rgb.0;
                    *(p.add(off + 1)) = rgb.1;
                    *(p.add(off + 2)) = rgb.2;
                }
            }
        }
    }

    /// 把 viewport 区域填成某个颜色（调色板索引）。viewport 之外不动 ——
    /// 这样终端窗口 `clear` 时只会擦掉客户区，不会把窗口框外的桌面抹掉。
    fn fill_screen(&self, ci: u8) {
        let (r, g, b) = PALETTE[ci as usize];
        let w = self.info.width;
        let h = self.info.height;
        let stride = self.info.stride;
        let bpp = self.info.bytes_per_pixel.max(1);
        let vx = self.vx;
        let vy = self.vy;
        let vw = (self.cols * self.cell_w).min(w.saturating_sub(vx));
        let vh = (self.rows * self.cell_h).min(h.saturating_sub(vy));
        let p = self.fb_ptr as *mut u8;
        for y in vy..vy + vh {
            let row_off = y * stride * bpp;
            for x in vx..vx + vw {
                let off = row_off + x * bpp;
                if off + 2 >= self.fb_len {
                    continue;
                }
                unsafe {
                    match self.info.pixel_format {
                        PixelFormat::Bgr => {
                            *(p.add(off)) = b;
                            *(p.add(off + 1)) = g;
                            *(p.add(off + 2)) = r;
                        }
                        _ => {
                            *(p.add(off)) = r;
                            *(p.add(off + 1)) = g;
                            *(p.add(off + 2)) = b;
                        }
                    }
                }
            }
        }
    }

    /// 重画一个字符格。`invert` 用来画块状光标（前景/背景互换）
    fn draw_cell(&self, r: usize, c: usize, invert: bool) {
        if r >= self.rows || c >= self.cols {
            return;
        }
        let x0 = self.vx + c * self.cell_w;
        let y0 = self.vy + r * self.cell_h;
        let cell = self.cells[r * self.cols + c];
        let (fg_i, bg_i) = if invert {
            (cell.bg, cell.fg)
        } else {
            (cell.fg, cell.bg)
        };
        let fg = PALETTE[fg_i as usize];
        let bg = PALETTE[bg_i as usize];
        let ch = cell.ch;
        let raster = match get_raster(ch as char, FontWeight::Regular, RasterHeight::Size16) {
            Some(r) => r,
            None => get_raster('?', FontWeight::Regular, RasterHeight::Size16).unwrap(),
        };
        let gw = raster.width().min(self.cell_w);
        let gh = raster.height().min(self.cell_h);
        let rows = raster.raster();
        for py in 0..self.cell_h {
            for px in 0..self.cell_w {
                let inten: u32 = if px < gw && py < gh {
                    rows[py][px] as u32
                } else {
                    0
                };
                let r = (fg.0 as u32 * inten + bg.0 as u32 * (255 - inten)) / 255;
                let g = (fg.1 as u32 * inten + bg.1 as u32 * (255 - inten)) / 255;
                let b = (fg.2 as u32 * inten + bg.2 as u32 * (255 - inten)) / 255;
                self.put_pixel(x0 + px, y0 + py, (r as u8, g as u8, b as u8));
            }
        }
    }

    fn newline(&mut self) {
        self.col = 0;
        if self.row + 1 >= self.rows {
            self.scroll();
        } else {
            self.row += 1;
        }
    }

    /// 整体上移一行，最后一行清空 —— 传统终端的做法（只在 viewport 内）
    fn scroll(&mut self) {
        if self.rows == 0 {
            return;
        }
        let vx = self.vx;
        let vy = self.vy;
        let vw = (self.cols * self.cell_w).min(self.info.width.saturating_sub(vx));
        let vh = (self.rows * self.cell_h).min(self.info.height.saturating_sub(vy));
        let bpp = self.info.bytes_per_pixel.max(1);
        let stride = self.info.stride;
        let p = self.fb_ptr as *mut u8;
        if vh > self.cell_h {
            // 只搬 viewport 里的像素，不碰窗口框外的桌面像素
            for y in 0..(vh - self.cell_h) {
                let src_off = (vy + y + self.cell_h) * stride * bpp + vx * bpp;
                let dst_off = (vy + y) * stride * bpp + vx * bpp;
                unsafe { core::ptr::copy(p.add(src_off), p.add(dst_off), vw * bpp) };
            }
            // 底部新空出的 band 填成当前背景色
            let bg = PALETTE[self.bg as usize];
            let fill_from = vy + vh - self.cell_h;
            for y in fill_from..vy + vh {
                let row_off = y * stride * bpp;
                for x in vx..vx + vw {
                    let off = row_off + x * bpp;
                    if off + 2 >= self.fb_len {
                        continue;
                    }
                    unsafe {
                        match self.info.pixel_format {
                            PixelFormat::Bgr => {
                                *(p.add(off)) = bg.2;
                                *(p.add(off + 1)) = bg.1;
                                *(p.add(off + 2)) = bg.0;
                            }
                            _ => {
                                *(p.add(off)) = bg.0;
                                *(p.add(off + 1)) = bg.1;
                                *(p.add(off + 2)) = bg.2;
                            }
                        }
                    }
                }
            }
        }
        // 2) 字符回填缓冲同步上移
        let cols = self.cols;
        for r in 1..self.rows {
            self.cells
                .copy_within((r * cols)..((r + 1) * cols), (r - 1) * cols);
        }
        let last = (self.rows - 1) * cols;
        for c in 0..cols {
            self.cells[last + c] = Cell {
                ch: b' ',
                fg: self.fg,
                bg: self.bg,
            };
        }
        // 3) 光标跟着内容上移
        if self.cur_visible {
            let (or, oc) = (self.cur_row, self.cur_col);
            self.draw_cell(or, oc, false);
            if self.cur_row > 0 {
                self.cur_row -= 1;
            }
            self.draw_cell(self.cur_row, self.cur_col, true);
        } else if self.cur_row > 0 {
            self.cur_row -= 1;
        }
    }

    fn write_byte(&mut self, b: u8) {
        match b {
            b'\n' => self.newline(),
            b'\r' => self.col = 0,
            0x08 => {
                // 退格：光标左移一格，擦成空格
                if self.col > 0 {
                    self.col -= 1;
                } else if self.row > 0 {
                    self.row -= 1;
                    self.col = self.cols.saturating_sub(1);
                }
                let idx = self.row * self.cols + self.col;
                self.cells[idx] = Cell {
                    ch: b' ',
                    fg: self.fg,
                    bg: self.bg,
                };
                self.draw_cell(self.row, self.col, false);
            }
            0x09 => {
                // Tab：四个空格
                for _ in 0..4 {
                    self.write_byte(b' ');
                }
            }
            _ => {
                if self.col >= self.cols {
                    self.newline();
                }
                let idx = self.row * self.cols + self.col;
                self.cells[idx] = Cell {
                    ch: b,
                    fg: self.fg,
                    bg: self.bg,
                };
                self.draw_cell(self.row, self.col, false);
                self.col += 1;
            }
        }
    }

    fn write_bytes(&mut self, s: &[u8]) {
        for &b in s {
            self.write_byte(b);
        }
    }

    fn clear_inner(&mut self) {
        self.fill_screen(self.bg);
        for c in self.cells.iter_mut() {
            *c = Cell {
                ch: b' ',
                fg: self.fg,
                bg: self.bg,
            };
        }
        self.col = 0;
        self.row = 0;
        self.cur_row = 0;
        self.cur_col = 0;
        self.cur_visible = false;
    }

    fn panic_inner(&mut self, info: &core::panic::PanicInfo) {
        self.fg = WHITE;
        self.bg = RED;
        self.clear_inner();
        self.fg = WHITE;
        self.bg = RED;
        self.write_str("\n  KERNEL PANIC\n\n");
        if let Some(loc) = info.location() {
            self.write_str("  at ");
            self.write_str(loc.file());
            self.write_str(":");
            self.write_str(&alloc::format!("{}", loc.line()));
            self.write_str("\n");
        }
        let msg = info.message();
        self.write_str("  ");
        self.write_fmt(format_args!("{msg}\n"));
    }
}

impl fmt::Write for Writer {
    fn write_str(&mut self, s: &str) -> fmt::Result {
        self.write_bytes(s.as_bytes());
        Ok(())
    }
}

static WRITER: Mutex<Writer> = Mutex::new(Writer::new());

/* ---------- 对外 API ---------- */

/// 用 bootloader 给的 framebuffer 初始化屏幕。
///
/// 必须在 `memory::init` 之后调用（字符回填缓冲用到了堆）。
pub fn init(framebuffer: FrameBuffer) {
    // framebuffer.info() 与 into_buffer() 在 bootloader_api 0.11 里都是安全方法
    let info = framebuffer.info();
    let buf = framebuffer.into_buffer();
    interrupts::without_interrupts(|| {
        let mut w = WRITER.lock();
        let sample =
            get_raster('A', FontWeight::Regular, RasterHeight::Size16).expect("font missing");
        let gw = sample.width();
        let gh = sample.height();
        let cell_w = gw + 1; // 字间留 1px，免得黏在一起
        let cell_h = gh;
        let cols = info.width / cell_w.max(1);
        let rows = info.height / cell_h.max(1);
        w.fb_ptr = buf.as_mut_ptr() as usize;
        w.fb_len = buf.len();
        w.info = info;
        w.glyph_w = gw;
        w.glyph_h = gh;
        w.cell_w = cell_w;
        w.cell_h = cell_h;
        w.cols = cols;
        w.rows = rows;
        w.vx = 0;
        w.vy = 0;
        w.fg = LIGHT_GRAY;
        w.bg = BLACK;
        w.cells = vec![
            Cell {
                ch: b' ',
                fg: LIGHT_GRAY,
                bg: BLACK
            };
            cols * rows
        ];
        drop(w);
    });
    clear();
}

pub fn write_str(s: &str) {
    interrupts::without_interrupts(|| {
        WRITER.lock().write_str(s);
    });
}

pub fn write_fmt(args: fmt::Arguments) {
    interrupts::without_interrupts(|| {
        WRITER.lock().write_fmt(args);
    });
}

pub fn set_color(fg: u8, bg: u8) {
    interrupts::without_interrupts(|| {
        let mut w = WRITER.lock();
        w.fg = fg;
        w.bg = bg;
    });
}

/// 还原默认配色（浅灰字 / 黑底）
pub fn reset_color() {
    interrupts::without_interrupts(|| {
        let mut w = WRITER.lock();
        w.fg = LIGHT_GRAY;
        w.bg = BLACK;
    });
}

pub fn clear() {
    interrupts::without_interrupts(|| {
        WRITER.lock().clear_inner();
    });
}

pub fn cursor_pos() -> (usize, usize) {
    interrupts::without_interrupts(|| {
        let w = WRITER.lock();
        (w.row, w.col)
    })
}

/// 把写入位置（和块状光标）挪到 (row, col)。
///
/// 会先把旧位置重画回普通字符，再在新位置反色。逻辑写入位置也跟着变 ——
/// shell 的全行重画全靠它。
pub fn set_cursor(row: usize, col: usize) {
    interrupts::without_interrupts(|| {
        let mut w = WRITER.lock();
        let r = row.min(w.rows.saturating_sub(1));
        let c = col.min(w.cols.saturating_sub(1));
        if w.cur_visible {
            w.draw_cell(w.cur_row, w.cur_col, false);
        }
        w.cur_row = r;
        w.cur_col = c;
        w.cur_visible = true;
        w.row = r;
        w.col = c;
        w.draw_cell(r, c, true);
    });
}

/// 读回某格当前字符（用于串口导出屏幕内容）
pub fn read_char(row: usize, col: usize) -> u8 {
    interrupts::without_interrupts(|| {
        let w = WRITER.lock();
        if row >= w.rows || col >= w.cols {
            return b' ';
        }
        w.cells[row * w.cols + col].ch
    })
}

pub fn cols() -> usize {
    interrupts::without_interrupts(|| WRITER.lock().cols)
}

pub fn rows() -> usize {
    interrupts::without_interrupts(|| WRITER.lock().rows)
}

/// 开机横幅
pub fn splash() {
    clear();
    set_color(CYAN, BLACK);
    write_str("\n");
    write_str("   L U M E O S\n");
    set_color(DARK_GRAY, BLACK);
    write_str("   a bare-metal OS   -   x86_64   -   written in Rust\n");
    write_str("\n");
}

/// 启动日志的一行：左边小标签，右边内容
pub fn boot_line(msg: &str) {
    set_color(DARK_GRAY, BLACK);
    write_str("  [ ok ] ");
    reset_color();
    write_str(msg);
    write_str("\n");
}

pub fn boot_line_fmt(args: fmt::Arguments) {
    set_color(DARK_GRAY, BLACK);
    write_str("  [ ok ] ");
    reset_color();
    write_fmt(args);
    write_str("\n");
}

pub fn boot_done() {
    write_str("\n");
    set_color(LIGHT_GRAY, BLACK);
    write_str("  ready. type 'help' to list commands.\n\n");
    reset_color();
}

pub fn panic_screen(info: &core::panic::PanicInfo) {
    interrupts::without_interrupts(|| {
        WRITER.lock().panic_inner(info);
    });
}

/* ---------- 图形图元（绝对像素坐标，不受 viewport 影响） ---------- */

/// 取 framebuffer 基址 / 长度 / 描述符。供下面的图元函数用。
fn fb_raw() -> (usize, usize, FrameBufferInfo) {
    let w = WRITER.lock();
    (w.fb_ptr, w.fb_len, w.info)
}

/// 画一个像素（越界静默放弃）
pub fn pixel(x: usize, y: usize, rgb: (u8, u8, u8)) {
    let (ptr, len, info) = fb_raw();
    let w = info.width;
    let h = info.height;
    if x >= w || y >= h {
        return;
    }
    let bpp = info.bytes_per_pixel.max(1);
    let off = (y * info.stride + x) * bpp;
    if off + 2 >= len {
        return;
    }
    let p = ptr as *mut u8;
    unsafe {
        match info.pixel_format {
            PixelFormat::Bgr => {
                *(p.add(off)) = rgb.2;
                *(p.add(off + 1)) = rgb.1;
                *(p.add(off + 2)) = rgb.0;
            }
            _ => {
                *(p.add(off)) = rgb.0;
                *(p.add(off + 1)) = rgb.1;
                *(p.add(off + 2)) = rgb.2;
            }
        }
    }
}

/// 实心矩形
pub fn fill_rect(x: usize, y: usize, w: usize, h: usize, rgb: (u8, u8, u8)) {
    let (ptr, len, info) = fb_raw();
    let sw = info.width;
    let sh = info.height;
    let x1 = (x + w).min(sw);
    let y1 = (y + h).min(sh);
    let bpp = info.bytes_per_pixel.max(1);
    let p = ptr as *mut u8;
    for yy in y..y1 {
        let row_off = yy * info.stride * bpp;
        for xx in x..x1 {
            let off = row_off + xx * bpp;
            if off + 2 >= len {
                continue;
            }
            unsafe {
                match info.pixel_format {
                    PixelFormat::Bgr => {
                        *(p.add(off)) = rgb.2;
                        *(p.add(off + 1)) = rgb.1;
                        *(p.add(off + 2)) = rgb.0;
                    }
                    _ => {
                        *(p.add(off)) = rgb.0;
                        *(p.add(off + 1)) = rgb.1;
                        *(p.add(off + 2)) = rgb.2;
                    }
                }
            }
        }
    }
}

/// 矩形边框（1px）
pub fn stroke_rect(x: usize, y: usize, w: usize, h: usize, rgb: (u8, u8, u8)) {
    if w == 0 || h == 0 {
        return;
    }
    fill_rect(x, y, w, 1, rgb);
    fill_rect(x, y + h - 1, w, 1, rgb);
    fill_rect(x, y, 1, h, rgb);
    fill_rect(x + w - 1, y, 1, h, rgb);
}

/// 实心圆（光栅化）
pub fn fill_circle(cx: usize, cy: usize, r: usize, rgb: (u8, u8, u8)) {
    if r == 0 {
        return;
    }
    let _ = fb_raw(); // 确保 framebuffer 已初始化（pixel() 内部会再取一次）
    let rr = r as i64 * r as i64;
    for yy in (cy as i64 - r as i64)..=(cy as i64 + r as i64) {
        for xx in (cx as i64 - r as i64)..=(cx as i64 + r as i64) {
            let dx = xx - cx as i64;
            let dy = yy - cy as i64;
            if dx * dx + dy * dy <= rr && xx >= 0 && yy >= 0 {
                pixel(xx as usize, yy as usize, rgb);
            }
        }
    }
}

/// 在像素坐标 (x, y) 处画一行等宽文字。
/// `bg = None` 时透明（只画字形像素，可叠在图标上）；`Some` 时画实心底。
pub fn text(x: usize, y: usize, s: &str, fg: (u8, u8, u8), bg: Option<(u8, u8, u8)>) {
    let (_, _, info) = fb_raw();
    if info.width == 0 {
        return;
    }
    let mut cx = x;
    for ch in s.chars() {
        let ras = match get_raster(ch, FontWeight::Regular, RasterHeight::Size16) {
            Some(r) => r,
            None => match get_raster('?', FontWeight::Regular, RasterHeight::Size16) {
                Some(r) => r,
                None => return,
            },
        };
        let gw = ras.width();
        let gh = ras.height();
        let rows = ras.raster();
        for py in 0..gh {
            for px in 0..gw {
                let inten = rows[py][px] as u32;
                if inten == 0 {
                    if let Some(b) = bg {
                        pixel(cx + px, y + py, b);
                    }
                } else if let Some(b) = bg {
                    let r = (fg.0 as u32 * inten + b.0 as u32 * (255 - inten)) / 255;
                    let g = (fg.1 as u32 * inten + b.1 as u32 * (255 - inten)) / 255;
                    let b2 = (fg.2 as u32 * inten + b.2 as u32 * (255 - inten)) / 255;
                    pixel(cx + px, y + py, (r as u8, g as u8, b2 as u8));
                } else {
                    pixel(cx + px, y + py, fg);
                }
            }
        }
        cx += gw + 1;
        if cx >= info.width {
            return;
        }
    }
}

pub fn screen_w() -> usize {
    WRITER.lock().info.width
}

pub fn screen_h() -> usize {
    WRITER.lock().info.height
}

/* ---------- viewport：把全局 Writer 装进窗口客户区 ---------- */

/// 让之后的所有文字/清屏都限制在 (px, py, pw, ph) 这块像素矩形里。
pub fn set_viewport(px: usize, py: usize, pw: usize, ph: usize) {
    interrupts::without_interrupts(|| {
        let mut w = WRITER.lock();
        let cw = w.cell_w.max(1);
        let ch = w.cell_h.max(1);
        w.vx = px;
        w.vy = py;
        w.cols = pw / cw;
        w.rows = ph / ch;
        w.fg = LIGHT_GRAY;
        w.bg = BLACK;
        w.cells = vec![Cell {
            ch: b' ',
            fg: LIGHT_GRAY,
            bg: BLACK,
        };
        w.cols * w.rows];
        w.col = 0;
        w.row = 0;
        w.cur_row = 0;
        w.cur_col = 0;
        w.cur_visible = false;
    });
}

/// 撤销 viewport，恢复整屏渲染（窗口关闭后调用）
pub fn reset_viewport() {
    interrupts::without_interrupts(|| {
        let mut w = WRITER.lock();
        let cw = w.cell_w.max(1);
        let ch = w.cell_h.max(1);
        w.vx = 0;
        w.vy = 0;
        w.cols = w.info.width / cw;
        w.rows = w.info.height / ch;
        w.cells = vec![Cell {
            ch: b' ',
            fg: LIGHT_GRAY,
            bg: BLACK,
        };
        w.cols * w.rows];
        w.col = 0;
        w.row = 0;
        w.cur_row = 0;
        w.cur_col = 0;
        w.cur_visible = false;
    });
}

/// 把当前 viewport 的所有字符格重画一遍（桌面重绘后用来恢复窗口里的内容）
pub fn repaint() {
    interrupts::without_interrupts(|| {
        let w = WRITER.lock();
        for r in 0..w.rows {
            for c in 0..w.cols {
                w.draw_cell(r, c, r == w.cur_row && c == w.cur_col && w.cur_visible);
            }
        }
    });
}
