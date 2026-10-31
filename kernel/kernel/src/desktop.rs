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
    glyph: &'static str,
    accent: (u8, u8, u8),
}

const ICONS: &[Icon] = &[
    Icon { app: App::Terminal, label: "Terminal", glyph: ">_", accent: (70, 200, 200) },
    Icon { app: App::Files, label: "Files", glyph: "F", accent: (110, 150, 255) },
    Icon { app: App::Settings, label: "Settings", glyph: "S", accent: (235, 225, 110) },
    Icon { app: App::About, label: "About", glyph: "?", accent: (110, 230, 130) },
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

/// 所有可点击图标的位置：先是左侧桌面列，再是底部 Dock。
fn icon_rects() -> Vec<(App, Rect)> {
    let sw = vga::screen_w();
    let sh = vga::screen_h();
    let mut v = Vec::new();
    let boxs = 60usize;
    let gap = 94usize;
    let x0 = 46usize;
    let y0 = 58usize;
    for (i, ic) in ICONS.iter().enumerate() {
        v.push((ic.app, Rect { x: x0, y: y0 + i * gap, w: boxs, h: boxs }));
    }
    let docks = 56usize;
    let dgap = 84usize;
    let n = ICONS.len();
    let dw = n * dgap + 20;
    let dx = (sw - dw) / 2;
    let dy = sh - 72 - 14;
    for (i, ic) in ICONS.iter().enumerate() {
        v.push((ic.app, Rect { x: dx + 12 + i * dgap, y: dy + 8, w: docks, h: docks }));
    }
    v
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

/// 圆角图标块：实色方块 + 四角用背景色圆挖掉，做出圆角
fn round_icon(x: usize, y: usize, s: usize, accent: (u8, u8, u8)) {
    vga::fill_rect(x, y, s, s, accent);
    let rad = 12usize;
    vga::fill_circle(x, y, rad, BG);
    vga::fill_circle(x + s, y, rad, BG);
    vga::fill_circle(x, y + s, rad, BG);
    vga::fill_circle(x + s, y + s, rad, BG);
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

const CURSOR: &[&str] = &[
    "XX..........",
    "XXXX........",
    "XX.XX.......",
    "XX..XX......",
    "XX...XX.....",
    "XX....XX....",
    "XX.....XX...",
    "XX......XX..",
    "XX...XXXXX..",
    "XX..XX......",
    "XX.XX.......",
    "XXXX........",
    "XX..........",
];

/// 经典箭头光标（先画黑色投影，再画白色本体）
fn draw_cursor(x: i32, y: i32) {
    let x = x as usize;
    let y = y as usize;
    for (ry, row) in CURSOR.iter().enumerate() {
        for (rx, c) in row.chars().enumerate() {
            if c == 'X' {
                vga::pixel(x + rx + 1, y + ry + 1, (0, 0,0));
            }
        }
    }
    for (ry, row) in CURSOR.iter().enumerate() {
        for (rx, c) in row.chars().enumerate() {
            if c == 'X' {
                vga::pixel(x + rx, y + ry, (245, 245, 250));
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
    let sh = vga::screen_h();
    vga::fill_rect(0, 0, sw, sh, BG);
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

    // 左侧桌面图标列
    for (i, ic) in ICONS.iter().enumerate() {
        let r = rects[i].1;
        round_icon(r.x, r.y, r.w, ic.accent);
        let gw = ic.glyph.len() * 9 + 1;
        vga::text(r.x + (r.w - gw) / 2, r.y + r.w / 2 - 8, ic.glyph, (245, 245, 250), Some(ic.accent));
        let lw = ic.label.len() * 9 + 1;
        vga::text(r.x + (r.w - lw) / 2, r.y + r.h + 4, ic.label, TEXT, Some(BG));
    }

    // 底部 Dock
    let dw = n * 84 + 20;
    let dx = (sw - dw) / 2;
    let dy = sh - 72 - 14;
    vga::fill_rect(dx, dy, dw, 72, PANEL);
    vga::fill_circle(dx, dy, 14, BG);
    vga::fill_circle(dx + dw, dy, 14, BG);
    vga::fill_circle(dx, dy + 72, 14, BG);
    vga::fill_circle(dx + dw, dy + 72, 14, BG);
    for i in 0..n {
        let r = rects[n + i].1;
        round_icon(r.x, r.y, r.w, ICONS[i].accent);
        let gw = ICONS[i].glyph.len() * 9 + 1;
        vga::text(
            r.x + (r.w - gw) / 2,
            r.y + r.w / 2 - 8,
            ICONS[i].glyph,
            (245, 245, 250),
            Some(ICONS[i].accent),
        );
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

    draw_cursor(mouse::x(), mouse::y());
}

/// 打开终端：画窗框，把文字 viewport 指到客户区，跑 shell，回来时撤销 viewport
fn launch_terminal() {
    let accent = app_accent(App::Terminal);
    draw_window_frame(app_title(App::Terminal), accent);
    let r = window_rect();
    let c = client_rect(r);
    vga::set_viewport(c.x, c.y, c.w, c.h);
    crate::shell::Shell::new().run();
    vga::reset_viewport();
}

fn to_open(app: App) -> OpenApp {
    match app {
        App::Terminal => OpenApp::Terminal,
        other => OpenApp::App(other),
    }
}

/// 桌面主循环，永不返回
pub fn run() -> ! {
    let mut open = OpenApp::None;
    let mut last_x = -1i32;
    let mut last_y = -1i32;
    let mut last_sec = !0u64;
    let mut last_open = open;
    loop {
        // Terminal 是阻塞式的：单独拎出来跑，跑完交还桌面
        if let OpenApp::Terminal = open {
            launch_terminal();
            open = OpenApp::None;
            last_x = -1;
            last_y = -1;
            last_sec = !0;
            last_open = open;
            continue;
        }

        let mx = mouse::x();
        let my = mouse::y();
        let sec = interrupts::uptime_secs();
        // 重绘条件：鼠标动了、秒数变了、或者「打开/关闭应用」的状态变了。
        // 最后这条很关键 —— 用键盘/鼠标开应用后，若不立刻重绘，窗口要等下一个
        // 时钟跳变（最多 1 秒）才冒出来，看着像没反应。
        if open != last_open || mx != last_x || my != last_y || sec != last_sec {
            draw_scene(open);
            last_x = mx;
            last_y = my;
            last_sec = sec;
            last_open = open;
        }

        // 鼠标点击：命中检测
        if mouse::take_click() {
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

        x86_64::instructions::hlt();
    }
}
