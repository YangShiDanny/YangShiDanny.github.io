//! PS/2 鼠标驱动（aux 设备，IRQ12）
//!
//! 桌面环境得有鼠标才会成立。PS/2 鼠标走辅助设备通道：发命令要先往 0x64
//! 写 0xD4，再把具体命令写进 0x60。鼠标以 3 字节包上报位移和按键：
//!
//!   byte0: Y溢出 X溢出 Y符号 X符号 1 中键 右键 左键
//!   byte1: X 位移（9 位有符号，符号在 byte0 的 X符号 位）
//!   byte2: Y 位移（9 位有符号，符号在 byte0 的 Y符号 位）
//!
//! 我们把位移累加成「绝对坐标」，夹在屏幕范围内，外带一个左键按下沿，
//! 给桌面做点击命中检测用。

use crate::interrupts;
use spin::Mutex;
use x86_64::instructions::interrupts::without_interrupts;
use x86_64::instructions::port::Port;

struct State {
    x: i32,
    y: i32,
    /// 左键当前是否按下
    left: bool,
    /// 自上次 take_click 以来是否发生过一次「按下」沿
    click_edge: bool,
    idx: u8,
    buf: [u8; 3],
}

static STATE: Mutex<State> = Mutex::new(State {
    x: 0,
    y: 0,
    left: false,
    click_edge: false,
    idx: 0,
    buf: [0; 3],
});

/* ---------- 底层 PS/2 端口 helpers ---------- */

unsafe fn ps2_wait_input() {
    let mut status: Port<u8> = Port::new(0x64);
    while status.read() & 0x02 != 0 {
        core::hint::spin_loop();
    }
}

unsafe fn ps2_wait_output() {
    let mut status: Port<u8> = Port::new(0x64);
    while status.read() & 0x01 == 0 {
        core::hint::spin_loop();
    }
}

unsafe fn ps2_cmd(b: u8) {
    ps2_wait_input();
    let mut c: Port<u8> = Port::new(0x64);
    c.write(b);
}

unsafe fn ps2_data(b: u8) {
    ps2_wait_input();
    let mut d: Port<u8> = Port::new(0x60);
    d.write(b);
}

unsafe fn ps2_read() -> u8 {
    ps2_wait_output();
    let mut d: Port<u8> = Port::new(0x60);
    d.read()
}

/// 给鼠标发命令（0xD4 前缀 + 命令 + 读 ACK）
unsafe fn mouse_cmd(b: u8) -> u8 {
    ps2_cmd(0xD4);
    ps2_data(b);
    ps2_read()
}

/// 初始化鼠标：开启 aux 通道、允许 IRQ12、设默认参数、开始上报
pub fn init() {
    unsafe {
        // 1) 开启 aux 设备（0xA8）
        ps2_cmd(0xA8);
        // 2) 读配置字节，打开 IRQ12 位（bit1），写回
        ps2_cmd(0x20);
        let mut status = ps2_read();
        status |= 0x02;
        ps2_cmd(0x60);
        ps2_data(status);
        // 3) 设默认参数（0xF6），再开启数据上报（0xF4）
        let _ = mouse_cmd(0xF6);
        let _ = mouse_cmd(0xF4);
    }
    // 起始位置放在屏幕中心
    let (w, h) = (crate::vga::screen_w() as i32, crate::vga::screen_h() as i32);
    without_interrupts(|| {
        let mut s = STATE.lock();
        s.x = w / 2;
        s.y = h / 2;
    });
}

/// IRQ12 处理：收齐 3 字节后解析位移与按键
pub extern "x86-interrupt" fn mouse_handler(_frame: x86_64::structures::idt::InterruptStackFrame) {
    let mut data: Port<u8> = Port::new(0x60);
    let b = unsafe { data.read() };
    let mut s = STATE.lock();
    let idx = s.idx as usize;
    s.buf[idx] = b;
    s.idx += 1;
    if s.idx == 3 {
        s.idx = 0;
        let b0 = s.buf[0];
        // PS/2 鼠标位移是 9 位有符号：低 8 位在 byte1/byte2，第 9 位符号在 byte0
        // 的 bit4(X) / bit5(Y)。只当 i8 会把超过 ±127 的位移（比如 QEMU 把一次大
        // 幅移动拆成多个包，单包含量可能到 ±255）解错符号，光标会朝反方向飞。
        let mut dx = s.buf[1] as i16;
        if b0 & 0x10 != 0 {
            dx -= 256;
        }
        let mut dy = s.buf[2] as i16;
        if b0 & 0x20 != 0 {
            dy -= 256;
        }
        let (sw, sh) = (crate::vga::screen_w() as i32, crate::vga::screen_h() as i32);
        s.x += dx as i32;
        // PS/2 的 Y 正方向朝屏幕上方，转成屏幕坐标要反一下
        s.y -= dy as i32;
        if s.x < 0 {
            s.x = 0;
        }
        if s.x >= sw {
            s.x = sw - 1;
        }
        if s.y < 0 {
            s.y = 0;
        }
        if s.y >= sh {
            s.y = sh - 1;
        }
        let left = b0 & 0x01 != 0;
        // 上升沿：从「没按」变「按」记一次点击
        if left && !s.left {
            s.click_edge = true;
        }
        s.left = left;
    }
    unsafe { crate::interrupts::PICS.lock().notify_end_of_interrupt(interrupts::PIC_2_OFFSET + 4) };
}

/// 当前 X（绝对坐标）
pub fn x() -> i32 {
    without_interrupts(|| STATE.lock().x)
}

/// 当前 Y（绝对坐标）
pub fn y() -> i32 {
    without_interrupts(|| STATE.lock().y)
}

/// 取走一次点击沿（取过即清）。桌面用它做命中检测
pub fn take_click() -> bool {
    without_interrupts(|| {
        let mut s = STATE.lock();
        let v = s.click_edge;
        s.click_edge = false;
        v
    })
}
