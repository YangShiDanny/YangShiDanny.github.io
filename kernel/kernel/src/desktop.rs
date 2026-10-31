//! LumeOS 桌面环境
//!
//! 启动之后不再是直愣愣的终端，而是一张和 Web 版 LumeOS 一个路子的桌面：
//! 近黑背景 + 确定性星空、顶部菜单栏（左边 LumeOS、右边实时时钟）、
//! 左侧桌面图标列、底部居中的 Dock。鼠标能在上面移、能点图标开应用。
//!
//! 应用分两种：
//!  - Terminal：真窗口 —— 把全局文字 Writer 的 viewport 指到窗口客户区，
//!    然后跑现有的 shell，Esc / exit / logout / desktop 交还桌面。
//!  - Files / Settings / About：静态窗口，直接在客户区画文字内容。
//!
//! 没有重叠窗口管理（一次只一个打开的应用），但视觉上和交互上已经是
//! 一个真正的桌面，而不是一张静止的画。

use crate::fs;
use crate::interrupts::{self, Key};
use crate::mouse;
use crate::vga;
use alloc::{format, vec::Vec};
use core::sync::atomic::{AtomicIsize, Ordering};
use spin::Mutex;

/* ---------- 配色（RGB 元组，和 vga 调色板同源） ---------- */
const BG: (u8, u8, u8) = (12, 12, 16);
const PANEL: (u8, u8, u8) = (22, 22, 28);
const PANEL_BORDER: (u8, u8, u8) = (46, 46, 54);
const TEXT: (u8, u8, u8) = (222, 222, 232);
const DIM: (u8, u8, u8) = (130, 130, 140);
const WIN_BG: (u8, u8, u8) = (18, 18, 24);
const WIN_BORDER: (u8, u8, u8) = (60, 60, 70);

#[derive(Clone, Copy, PartialEq, Eq)]
enum App {
    Terminal,
    Files,
    Settings,
    About,
}

#[derive(Clone, Copy, PartialEq, Eq)]
enum OpenApp {
    None,
    Terminal,
    App(App),
}

#[derive(Clone, Copy)]
struct Rect {
    x: usize,
    y: usize,
    w: usize,
    h: usize,
}
impl Rect {
    fn contains(&self, x: i32, y: i32) -> bool {
        x >= self.x as i32
            && x < (self.x + self.w) as i32
            && y >= self.y as i32
            && y < (self.y + self.h) as i32
    }
}

struct Icon {
    app: App,
    label: &'static str,
}

const ICONS: &[Icon] = &[
    Icon { app: App::Terminal, label: "Terminal" },
    Icon { app: App::Files, label: "Files" },
    Icon { app: App::Settings, label: "Settings" },
    Icon { app: App::About, label: "About" },
];

fn app_accent(a: App) -> (u8, u8, u8) {
    match a {
        App::Terminal => (70, 200, 200),
        App::Files => (110, 150, 255),
        App::Settings => (235, 225, 110),
        App::About => (110, 230, 130),
    }
}

fn app_title(a: App) -> &'static str {
    match a {
        App::Terminal => "Terminal",
        App::Files => "Files",
        App::Settings => "Settings",
        App::About => "About",
    }
}

/// 图标线色：对齐 Web 版 `--on-panel`（浅色描边，不是彩色色块）
const ICON_COL: (u8, u8, u8) = (226, 226, 236);

/// 可点击区域：桌面列（对齐 Web `.desk-icons` top:46 left:18）+ Dock
/// （对齐 Web `.dock` bottom:14、item 48、gap 4、padding 8）。
fn icon_rects() -> Vec<(App, Rect)> {
    let sw = vga::screen_w();
    let sh = vga::screen_h();
    let mut v = Vec::new();
    // 左侧桌面图标列：图标 24px 居中 + 下方标签
    let cw = 76usize;
    let ch = 58usize;
    let step = 66usize;
    for (i, ic) in ICONS.iter().enumerate() {
        v.push((ic.app, Rect { x: 18, y: 46 + i * step, w: cw, h: ch }));
    }
    // 底部 Dock
    let n = ICONS.len();
    let item = 48usize;
    let gap = 4usize;
    let pad = 8usize;
    let dw = n * item + (n - 1) * gap + pad * 2;
    let dh = item + pad * 2;
    let dx = (sw - dw) / 2;
    let dy = sh - 14 - dh;
    for (i, ic) in ICONS.iter().enumerate() {
        v.push((
            ic.app,
            Rect { x: dx + pad + i * (item + gap), y: dy + pad, w: item, h: item },
        ));
    }
    v
}

/// Dock 面板外框（含 padding），画玻璃条用
fn dock_rect() -> Rect {
    let sw = vga::screen_w();
    let sh = vga::screen_h();
    let n = ICONS.len();
    let item = 48usize;
    let gap = 4usize;
    let pad = 8usize;
    let dw = n * item + (n - 1) * gap + pad * 2;
    let dh = item + pad * 2;
    Rect { x: (sw - dw) / 2, y: sh - 14 - dh, w: dw, h: dh }
}

fn window_rect() -> Rect {
    let sw = vga::screen_w();
    let sh = vga::screen_h();
    let ww = (sw - 80).min(840);
    let wh = (sh - 80).min(540);
    Rect { x: (sw - ww) / 2, y: (sh - wh) / 2, w: ww, h: wh }
}

fn close_rect(r: Rect) -> Rect {
    Rect { x: r.x + r.w - 26, y: r.y + 3, w: 22, h: 22 }
}

fn client_rect(r: Rect) -> Rect {
    Rect { x: r.x + 2, y: r.y + 28, w: r.w - 4, h: r.h - 30 }
}

fn hit_test(x: i32, y: i32) -> Option<App> {
    for (app, r) in icon_rects() {
        if r.contains(x, y) {
            return Some(app);
        }
    }
    None
}

/* ---------- 24×24 线框图标（对齐 Web icons.js 的描边风格） ---------- */

fn plot(x: i32, y: i32, col: (u8, u8, u8)) {
    if x >= 0 && y >= 0 {
        let (ux, uy) = (x as usize, y as usize);
        if ux < vga::screen_w() && uy < vga::screen_h() {
            vga::pixel(ux, uy, col);
        }
    }
}

/// Bresenham 直线
fn line(x0: i32, y0: i32, x1: i32, y1: i32, col: (u8, u8, u8)) {
    let dx = (x1 - x0).abs();
    let dy = -(y1 - y0).abs();
    let sx = if x0 < x1 { 1 } else { -1 };
    let sy = if y0 < y1 { 1 } else { -1 };
    let (mut x, mut y) = (x0, y0);
    let mut err = dx + dy;
    loop {
        plot(x, y, col);
        if x == x1 && y == y1 {
            break;
        }
        let e2 = 2 * err;
        if e2 >= dy {
            err += dy;
            x += sx;
        }
        if e2 <= dx {
            err += dx;
            y += sy;
        }
    }
}

/// 中点圆描边（8 分对称）
fn circle_stroke(cx: i32, cy: i32, r: i32, col: (u8, u8, u8)) {
    let (mut x, mut y) = (0i32, r);
    let mut d = 1 - r;
    while x <= y {
        for (px, py) in [
            (cx + x, cy + y), (cx - x, cy + y), (cx + x, cy - y), (cx - x, cy - y),
            (cx + y, cy + x), (cx - y, cy + x), (cx + y, cy - x), (cx - y, cy - x),
        ] {
            plot(px, py, col);
        }
        if d < 0 {
            d += 2 * x + 3;
        } else {
            d += 2 * (x - y) + 5;
            y -= 1;
        }
        x += 1;
    }
}

/// 1/4 圆弧：圆心 (cx,cy)，象限方向 (qx,qy) ∈ {1,-1}
fn arc_quarter(cx: i32, cy: i32, r: i32, qx: i32, qy: i32, col: (u8, u8, u8)) {
    let (mut x, mut y) = (0i32, r);
    let mut d = 1 - r;
    while x <= y {
        plot(cx + qx * x, cy + qy * y, col);
        plot(cx + qx * y, cy + qy * x, col);
        if d < 0 {
            d += 2 * x + 3;
        } else {
            d += 2 * (x - y) + 5;
            y -= 1;
        }
        x += 1;
    }
}

/// 圆角矩形描边（terminal 图标的外框）
fn stroke_round_rect(x: i32, y: i32, w: i32, h: i32, r: i32, col: (u8, u8, u8)) {
    for dx in (x + r)..=(x + w - r) {
        plot(dx, y, col);
        plot(dx, y + h, col);
    }
    for dy in (y + r)..=(y + h - r) {
        plot(x, dy, col);
        plot(x + w, dy, col);
    }
    arc_quarter(x + r, y + r, r, -1, -1, col);
    arc_quarter(x + w - r, y + r, r, 1, -1, col);
    arc_quarter(x + r, y + h - r, r, -1, 1, col);
    arc_quarter(x + w - r, y + h - r, r, 1, 1, col);
}

/// 按应用画 24×24 线框图标，(ox,oy) 为图标左上角。
/// 形状逐一对应 Web icons.js 里的 SVG 路径。
fn draw_line_icon(app: App, ox: usize, oy: usize, col: (u8, u8, u8)) {
    let x = ox as i32;
    let y = oy as i32;
    match app {
        // <rect x="2.5" y="4" width="19" height="16" rx="3"/> + ">_" 提示符
        App::Terminal => {
            stroke_round_rect(x + 2, y + 4, 19, 16, 3, col);
            line(x + 7, y + 9, x + 10, y + 12, col);
            line(x + 10, y + 12, x + 7, y + 14, col);
            line(x + 13, y + 15, x + 17, y + 15, col);
        }
        // 文件夹：tab + 斜坡 + 主体圆角轮廓
        App::Files => {
            line(x + 6, y + 5, x + 9, y + 5, col); // tab 顶
            line(x + 9, y + 5, x + 11, y + 8, col); // 斜坡
            line(x + 11, y + 8, x + 19, y + 8, col); // 右顶边
            arc_quarter(x + 19, y + 10, 2, 1, -1, col); // 右上角
            line(x + 21, y + 10, x + 21, y + 17, col); // 右边
            arc_quarter(x + 19, y + 17, 2, 1, 1, col); // 右下角
            line(x + 19, y + 19, x + 5, y + 19, col); // 底边
            arc_quarter(x + 5, y + 17, 2, -1, 1, col); // 左下角
            line(x + 3, y + 17, x + 3, y + 8, col); // 左边
            arc_quarter(x + 5, y + 7, 2, -1, -1, col); // 左上角
        }
        // 齿轮：中圆 + 8 根齿
        App::Settings => {
            circle_stroke(x + 12, y + 12, 3, col);
            const TEETH: [(i32, i32, i32, i32); 8] = [
                (18, 12, 21, 12), (17, 17, 19, 19), (12, 18, 12, 21), (7, 17, 5, 19),
                (6, 12, 3, 12), (7, 7, 5, 5), (12, 6, 12, 3), (17, 7, 19, 5),
            ];
            for (x0, y0, x1, y1) in TEETH {
                line(x + x0, y + y0, x + x1, y + y1, col);
            }
        }
        // 四角星（sparkle）
        App::About => {
            const STAR: [(i32, i32); 8] = [
                (12, 3), (14, 10), (21, 12), (14, 14),
                (12, 21), (10, 14), (3, 12), (10, 10),
            ];
            for i in 0..8 {
                let (x0, y0) = STAR[i];
                let (x1, y1) = STAR[(i + 1) % 8];
                line(x + x0, y + y0, x + x1, y + y1, col);
            }
        }
    }
}

/// 确定性星空：每次重画用同一个种子，星星位置稳定不动
fn draw_starfield() {
    let sw = vga::screen_w();
    let sh = vga::screen_h();
    let mut seed: u32 = 0x9E37_79B9;
    for _ in 0..240 {
        seed = seed.wrapping_mul(1664525).wrapping_add(1013904223);
        let sx = ((seed >> 8) % sw as u32) as usize;
        seed = seed.wrapping_mul(1664525).wrapping_add(1013904223);
        let sy = ((seed >> 8) % sh as u32) as usize;
        let b = 60u32 + ((seed >> 20) % 120);
        vga::pixel(sx, sy, (b as u8, b as u8, (b + 12) as u8));
    }
}

/* ---------- 光标：Web 版同款 —— 9px 实心白点 + 1px 深色描边 ---------- */
fn draw_cursor(x: i32, y: i32) {
    let (cx, cy) = (x as usize, y as usize);
    vga::fill_circle(cx, cy, 5, (8, 8, 12));
    vga::fill_circle(cx, cy, 4, (250, 250, 252));
}

/* ---------- 终端等文字环境的指针 overlay ----------
   桌面态的光标由 draw_scene 每帧重画；但终端窗口是阻塞 shell，
   没人重画桌面，指针就「消失」了。这里给文字环境一个独立 overlay：
   位置一动就恢复底下的像素块、再把白点画到新位置。
   保存/恢复都是 11×11 的小块（白点 r=5 直径 11），开销可忽略。 */

const OV: usize = 11; // 块边长（奇数，中心对齐）

struct Overlay {
    x: usize,
    y: usize,
    under: [[(u8, u8, u8); OV]; OV],
}

static OV_STATE: Mutex<Option<Overlay>> = Mutex::new(None);
static OV_LAST_MOUSE: AtomicIsize = AtomicIsize::new(isize::MIN);

/// 终端里调用：跟随鼠标画白点（带底下像素的保存/恢复）
pub fn cursor_overlay() {
    let mx = mouse::x();
    let my = mouse::y();
    let key = ((mx as isize) << 32) | (my as isize & 0xFFFF_FFFF);
    if OV_LAST_MOUSE.load(Ordering::Relaxed) == key {
        return; // 没动，不重画（避免覆盖 shell 刚输出的文字）
    }
    OV_LAST_MOUSE.store(key, Ordering::Relaxed);
    let mut st = OV_STATE.lock();
    // 恢复旧块
    if let Some(old) = st.take() {
        for dy in 0..OV {
            for dx in 0..OV {
                vga::pixel(old.x + dx, old.y + dy, old.under[dy][dx]);
            }
        }
    }
    let (sw, sh) = (vga::screen_w(), vga::screen_h());
    let cx = (mx.max(0) as usize).min(sw - 1);
    let cy = (my.max(0) as usize).min(sh - 1);
    let x0 = cx.saturating_sub(OV / 2);
    let y0 = cy.saturating_sub(OV / 2);
    // 保存新块底下像素
    let mut under = [[(0u8, 0u8, 0u8); OV]; OV];
    for dy in 0..OV {
        for dx in 0..OV {
            under[dy][dx] = vga::read_pixel(x0 + dx, y0 + dy);
        }
    }
    *st = Some(Overlay { x: x0, y: y0, under });
    draw_cursor(mx, my);
}

/// 整帧重绘后调用：旧保存块已过期（屏幕内容全变了，恢复反而画错），
/// 直接丢弃，然后强制把光标画到当前位置。
pub fn cursor_overlay_force() {
    *OV_STATE.lock() = None;
    OV_LAST_MOUSE.store(isize::MIN, Ordering::Relaxed);
    cursor_overlay();
}

/// 离开文字环境前调用：恢复底下的像素
pub fn cursor_overlay_clear() {
    OV_LAST_MOUSE.store(isize::MIN, Ordering::Relaxed);
    let mut st = OV_STATE.lock();
    if let Some(old) = st.take() {
        for dy in 0..OV {
            for dx in 0..OV {
                vga::pixel(old.x + dx, old.y + dy, old.under[dy][dx]);
            }
        }
    }
}

fn draw_window_frame(title: &str, accent: (u8, u8, u8)) {
    let r = window_rect();
    vga::fill_rect(r.x + 3, r.y + 3, r.w, r.h, (0, 0, 0));
    vga::fill_rect(r.x, r.y, r.w, r.h, WIN_BG);
    vga::stroke_rect(r.x, r.y, r.w, r.h, WIN_BORDER);
    vga::fill_rect(r.x + 1, r.y + 1, r.w - 2, 26, accent);
    vga::text(r.x + 10, r.y + 7, title, (16, 16, 20), Some(accent));
    let cb = close_rect(r);
    vga::fill_rect(cb.x, cb.y, cb.w, cb.h, (200, 80, 80));
    vga::text(cb.x + cb.w / 2 - 3, cb.y + 4, "x", (255, 255, 255), Some((200, 80, 80)));
}

fn draw_files() {
    let r = window_rect();
    let c = client_rect(r);
    let entries = fs::list(fs::cwd_index());
    let mut y = c.y + 8;
    vga::text(c.x + 6, y, &fs::cwd_path(), DIM, Some(WIN_BG));
    y += 22;
    for (name, is_dir, size) in entries {
        let line = if is_dir {
            format!("  {name} /")
        } else {
            format!("  {name}    {size} B")
        };
        let col = if is_dir { (110, 150, 255) } else { TEXT };
        vga::text(c.x + 6, y, &line, col, Some(WIN_BG));
        y += 18;
        if y > c.y + c.h - 12 {
            break;
        }
    }
}

fn draw_settings() {
    let r = window_rect();
    let c = client_rect(r);
    let lines = [
        "  LumeOS Settings",
        "",
        "  Theme        Dark (default)",
        "  Accent       Cyan",
        "  Wallpaper    Starfield",
        "  Screensaver  90s",
        "",
        "  (placeholder — not wired to anything yet)",
    ];
    let mut y = c.y + 10;
    for l in lines {
        vga::text(c.x + 6, y, l, TEXT, Some(WIN_BG));
        y += 20;
    }
}

fn draw_about() {
    let r = window_rect();
    let c = client_rect(r);
    let lines = [
        "  LumeOS 0.1-rust",
        "",
        "  A bare-metal OS written in Rust.",
        "  x86_64, no_std, no libc.",
        "",
        "  Bootloader  0.11 (framebuffer mode)",
        "  Shell       built-in, runs in a window",
        "  FS           lumeFS (in RAM)",
        "",
        "  (c) you. it boots. that's the point.",
    ];
    let mut y = c.y + 10;
    for l in lines {
        vga::text(c.x + 6, y, l, TEXT, Some(WIN_BG));
        y += 20;
    }
}

/// 整个场景：背景 + 菜单栏 + 图标 + Dock + 打开的窗口 + 光标
fn draw_scene(open: OpenApp) {
    let sw = vga::screen_w();
    vga::fill_rect(0, 0, sw, vga::screen_h(), BG);
    draw_starfield();

    // 顶部菜单栏
    vga::fill_rect(0, 0, sw, 26, PANEL);
    vga::fill_rect(0, 25, sw, 1, PANEL_BORDER);
    vga::text(14, 6, "LumeOS", (235, 235, 245), Some(PANEL));
    let t = interrupts::uptime_ms() / 1000;
    let clk = format!("{:02}:{:02}:{:02}", t / 3600, (t % 3600) / 60, t % 60);
    let cw = clk.len() * 9 + 1;
    vga::text(sw - cw - 14, 6, &clk, TEXT, Some(PANEL));

    let rects = icon_rects();
    let n = ICONS.len();

    // 左侧桌面图标列：线框图标 + 下方标签（透明底，星星从底下透出）
    for (i, ic) in ICONS.iter().enumerate() {
        let r = rects[i].1;
        draw_line_icon(ic.app, r.x + (r.w - 24) / 2, r.y + 6, ICON_COL);
        let lw = ic.label.len() * 9 + 1;
        vga::text(
            r.x + (r.w - lw) / 2,
            r.y + 6 + 24 + 5,
            ic.label,
            TEXT,
            None,
        );
    }

    // 底部 Dock：玻璃条（面板 + 1px 边线 + 圆角挖角），里面是线框图标
    let d = dock_rect();
    vga::fill_rect(d.x, d.y, d.w, d.h, PANEL);
    vga::stroke_rect(d.x, d.y, d.w, d.h, (58, 58, 66));
    let rad = 12usize;
    vga::fill_circle(d.x, d.y, rad, BG);
    vga::fill_circle(d.x + d.w, d.y, rad, BG);
    vga::fill_circle(d.x, d.y + d.h, rad, BG);
    vga::fill_circle(d.x + d.w, d.y + d.h, rad, BG);
    for i in 0..n {
        let r = rects[n + i].1;
        draw_line_icon(ICONS[i].app, r.x + (r.w - 24) / 2, r.y + (r.h - 24) / 2, ICON_COL);
    }

    // 打开的应用窗口（Terminal 不在这里画，它由 launch_terminal 接管）
    if let OpenApp::App(app) = open {
        let accent = app_accent(app);
        draw_window_frame(app_title(app), accent);
        match app {
            App::Files => draw_files(),
            App::Settings => draw_settings(),
            App::About => draw_about(),
            App::Terminal => {}
        }
    }
    // 光标不在这里画：由 cursor_overlay 统一管理（全屏重绘后调
    // cursor_overlay_force 强制补画，避免重绘间隙里的中间帧被看到）
}

/// 只重画顶栏右侧的时钟。整帧重绘太重（清屏→星空→图标→Dock，
/// framebuffer 直写没有 vsync，中间帧被显示器采到就是肉眼可见的闪烁），
/// 稳态下每秒只需要动这一小块。
fn redraw_clock() {
    let sw = vga::screen_w();
    let t = interrupts::uptime_ms() / 1000;
    let clk = format!("{:02}:{:02}:{:02}", t / 3600, (t % 3600) / 60, t % 60);
    let cw = clk.len() * 9 + 1;
    // 擦除区不碰 y=25 的面板边线
    vga::fill_rect(sw - cw - 18, 1, cw + 18, 24, PANEL);
    vga::text(sw - cw - 14, 6, &clk, TEXT, Some(PANEL));
}

/// 打开终端：画窗框，把文字 viewport 指到客户区，跑 shell，回来时撤销 viewport
fn launch_terminal() {
    cursor_overlay_clear();
    let accent = app_accent(App::Terminal);
    draw_window_frame(app_title(App::Terminal), accent);
    let r = window_rect();
    let c = client_rect(r);
    vga::set_viewport(c.x, c.y, c.w, c.h);
    crate::shell::Shell::new().run();
    cursor_overlay_clear();
    vga::reset_viewport();
}

fn to_open(app: App) -> OpenApp {
    match app {
        App::Terminal => OpenApp::Terminal,
        other => OpenApp::App(other),
    }
}

/// 桌面主循环，永不返回
///
/// 重绘策略（防闪烁的关键）：
///  - 开/关应用 → 整帧 draw_scene（低频，闪一次无感）
///  - 时钟跳变  → 只重画顶栏右侧小块 redraw_clock
///  - 鼠标移动  → cursor_overlay 的 11×11 像素块保存/恢复，不碰整屏
pub fn run() -> ! {
    let mut open = OpenApp::None;
    let mut last_open = open;
    let mut last_sec = !0u64;
    let mut need_full = true; // 开机第一帧必须整帧画，否则屏幕是空的
    loop {
        // Terminal 是阻塞式的：单独拎出来跑，跑完交还桌面
        if let OpenApp::Terminal = open {
            launch_terminal();
            open = OpenApp::None;
            last_open = open;
            last_sec = !0;
            need_full = true;
            continue;
        }

        let sec = interrupts::uptime_secs();
        if need_full || open != last_open {
            draw_scene(open);
            cursor_overlay_force();
            need_full = false;
            last_open = open;
            last_sec = sec;
        } else if sec != last_sec {
            redraw_clock();
            last_sec = sec;
        }

        // 鼠标点击：命中检测
        if mouse::take_click() {
            let mx = mouse::x();
            let my = mouse::y();
            if let OpenApp::App(_) = open {
                let r = window_rect();
                if close_rect(r).contains(mx, my) {
                    open = OpenApp::None;
                } else if r.contains(mx, my) {
                    // 点在窗口体内（非关闭钮）：忽略
                } else if let Some(app) = hit_test(mx, my) {
                    open = to_open(app);
                } else {
                    open = OpenApp::None;
                }
            } else if let Some(app) = hit_test(mx, my) {
                open = to_open(app);
            }
        }

        // 键盘快捷键：桌面态用字母开应用，Esc 关窗口
        if let Some(key) = interrupts::poll_key() {
            match key {
                Key::Esc => {
                    if let OpenApp::App(_) = open {
                        open = OpenApp::None;
                    }
                }
                Key::Char(b't') if matches!(open, OpenApp::None) => open = OpenApp::Terminal,
                Key::Char(b'f') if matches!(open, OpenApp::None) => open = OpenApp::App(App::Files),
                Key::Char(b's') if matches!(open, OpenApp::None) => open = OpenApp::App(App::Settings),
                Key::Char(b'a') if matches!(open, OpenApp::None) => open = OpenApp::App(App::About),
                _ => {}
            }
        }

        // 鼠标移动：增量画光标（内部判断没动就直接返回）
        cursor_overlay();

        x86_64::instructions::hlt();
    }
}
