//! IDT + PIC + PS/2 键盘 + PIT 定时器
//!
//! 中断是整个系统的心跳。没有它，CPU 只会闷头跑我们写的那几行，
//! 键盘按下去没人理，时间也没法流动。这里做四件事：
//!
//!  1. 建 IDT，前 32 项是 CPU 异常（除零、非法指令、缺页……），
//!     32 往后是外部 IRQ。
//!  2. 重映射 8259 PIC：BIOS 把 IRQ0..7 放在 0x08..0x0F，正好压在
//!     CPU 异常上；不挪走的话，「定时器一到」会被当成「双重故障」。
//!  3. IRQ0 → PIT 定时器，每 10 ms 一跳，给 uptime 和光标闪烁当心拍。
//!  4. IRQ1 → PS/2 键盘，把扫描码翻成按键事件塞进环形队列，
//!     shell 在需要的时候取。
//!
//! 扫描码表用的是 set 1（PC 兼容），这也是 QEMU 的默认。

use core::sync::atomic::{AtomicBool, AtomicU32, AtomicU64, Ordering};
use pic8259::ChainedPics;
use spin::Mutex;
use x86_64::instructions::interrupts;
use x86_64::instructions::port::Port;
use x86_64::structures::idt::{InterruptDescriptorTable, InterruptStackFrame};
use x86_64::structures::idt::PageFaultErrorCode;

/// PIC 重映射后的向量偏移：IRQ0..15 → 0x20..0x2F
pub const PIC_1_OFFSET: u8 = 32;
pub const PIC_2_OFFSET: u8 = PIC_1_OFFSET + 8;

pub static PICS: Mutex<ChainedPics> =
    Mutex::new(unsafe { ChainedPics::new(PIC_1_OFFSET, PIC_2_OFFSET) });

static IDT: Mutex<Option<&'static InterruptDescriptorTable>> = Mutex::new(None);

/* ---------- 时钟 ---------- */

/// PIT 频率：100 Hz = 每 10 ms 一跳。够 uptime 用，也不至于太吵。
pub const TICK_HZ: u64 = 100;

static TICKS: AtomicU64 = AtomicU64::new(0);

pub fn ticks() -> u64 {
    TICKS.load(Ordering::Relaxed)
}

/// 开机以来的毫秒数
pub fn uptime_ms() -> u64 {
    ticks() * 1000 / TICK_HZ
}

pub fn uptime_secs() -> u64 {
    uptime_ms() / 1000
}

/// 真正把 PIT（8254 定时器）编程成 100 Hz。
///
/// bootloader 接管后会把 PIT 改掉甚至关掉，所以这里必须显式重设一遍，
/// 否则 IRQ0 不响，`TICKS` 永远是 0，`uptime_ms()` 恒为 0 —— 任何靠它计时的
/// 地方（启动延时、桌面时钟）都会卡住。命令字 0x36 = 通道0 + 先低后高 +
/// 模式3(方波) + 二进制；分频值 = 1_193_182 / 100 ≈ 11932。
pub fn init_pit() {
    let divisor: u16 = (1_193_182 / TICK_HZ as u32) as u16;
    // SAFETY: 0x43 是 PIT 控制端口，0x40 是通道0 数据端口
    unsafe {
        let mut ctrl: Port<u8> = Port::new(0x43);
        let mut ch0: Port<u8> = Port::new(0x40);
        ctrl.write(0x36);
        ch0.write((divisor & 0xFF) as u8);
        ch0.write((divisor >> 8) as u8);
    }
}

/* ---------- 键盘 ---------- */

/// 按键：不是「扫描码」，是「人类按了什么」
#[derive(Clone, Copy, PartialEq, Eq, Debug)]
pub enum Key {
    Char(u8),
    Enter,
    Backspace,
    Tab,
    Esc,
    Up,
    Down,
    Left,
    Right,
    Home,
    End,
    Delete,
    Ctrl(u8),
    F(u8),
    Unknown,
}

const QUEUE_LEN: usize = 128;

struct KeyQueue {
    buf: [Key; QUEUE_LEN],
    head: usize,
    tail: usize,
}

impl KeyQueue {
    const fn new() -> Self {
        KeyQueue {
            buf: [Key::Unknown; QUEUE_LEN],
            head: 0,
            tail: 0,
        }
    }

    fn push(&mut self, k: Key) -> bool {
        let next = (self.tail + 1) % QUEUE_LEN;
        if next == self.head {
            return false; // 满了就丢，宁可丢键也不死锁
        }
        self.buf[self.tail] = k;
        self.tail = next;
        true
    }

    fn pop(&mut self) -> Option<Key> {
        if self.head == self.tail {
            return None;
        }
        let k = self.buf[self.head];
        self.head = (self.head + 1) % QUEUE_LEN;
        Some(k)
    }
}

static KEYS: Mutex<KeyQueue> = Mutex::new(KeyQueue::new());

/// 取一个按键，队列空了返回 None
pub fn poll_key() -> Option<Key> {
    interrupts::without_interrupts(|| KEYS.lock().pop())
}

/// 屏蔽中断地等一个键 —— shell 的主循环就靠它
pub fn read_key_blocking() -> Key {
    loop {
        if let Some(k) = poll_key() {
            return k;
        }
        // hlt 让 CPU 睡到这个中断为止：不忙等，笔记本风扇不会转
        x86_64::instructions::hlt();
    }
}

/* ---------- 扫描码 set 1 ---------- */

/// 普通键（无修饰）。0 表示该扫描码没有对应字符。
/// set 1 表，下标就是扫描码。
const SCAN: [u8; 0x3A] = [
    /* 0x00 0x01 0x02 0x03 0x04 0x05 0x06 0x07 */ 0, 27, b'1', b'2', b'3', b'4', b'5', b'6',
    /* 0x08 0x09 0x0A 0x0B 0x0C 0x0D 0x0E 0x0F */ b'7', b'8', b'9', b'0', b'-', b'=', 8, 9,
    /* 0x10 0x11 0x12 0x13 0x14 0x15 0x16 0x17 */ b'q', b'w', b'e', b'r', b't', b'y', b'u', b'i',
    /* 0x18 0x19 0x1A 0x1B 0x1C 0x1D 0x1E 0x1F */ b'o', b'p', b'[', b']', 13, 0, b'a', b's',
    /* 0x20 0x21 0x22 0x23 0x24 0x25 0x26 0x27 */ b'd', b'f', b'g', b'h', b'j', b'k', b'l', b';',
    /* 0x28 0x29 0x2A 0x2B 0x2C 0x2D 0x2E 0x2F */ b'\'', b'`', 0, b'\\', b'z', b'x', b'c', b'v',
    /* 0x30 0x31 0x32 0x33 0x34 0x35 0x36 0x37 */ b'b', b'n', b'm', b',', b'.', b'/', 0, b'*',
    /* 0x38 0x39 */ 0, 32,
];

/// Shift 组合。0 表示该扫描码没有对应字符。
/// set 1 表，下标就是扫描码。
const SCAN_SHIFT: [u8; 0x3A] = [
    /* 0x00 0x01 0x02 0x03 0x04 0x05 0x06 0x07 */ 0, 27, b'!', b'@', b'#', b'$', b'%', b'^',
    /* 0x08 0x09 0x0A 0x0B 0x0C 0x0D 0x0E 0x0F */ b'&', b'*', b'(', b')', b'_', b'+', 8, 9,
    /* 0x10 0x11 0x12 0x13 0x14 0x15 0x16 0x17 */ b'Q', b'W', b'E', b'R', b'T', b'Y', b'U', b'I',
    /* 0x18 0x19 0x1A 0x1B 0x1C 0x1D 0x1E 0x1F */ b'O', b'P', b'{', b'}', 13, 0, b'A', b'S',
    /* 0x20 0x21 0x22 0x23 0x24 0x25 0x26 0x27 */ b'D', b'F', b'G', b'H', b'J', b'K', b'L', b':',
    /* 0x28 0x29 0x2A 0x2B 0x2C 0x2D 0x2E 0x2F */ b'"', b'~', 0, b'|', b'Z', b'X', b'C', b'V',
    /* 0x30 0x31 0x32 0x33 0x34 0x35 0x36 0x37 */ b'B', b'N', b'M', b'<', b'>', b'?', 0, b'*',
    /* 0x38 0x39 */ 0, 32,
];

static SHIFT: AtomicBool = AtomicBool::new(false);
static CTRL: AtomicBool = AtomicBool::new(false);
/// E0 前缀：方向键、Delete 这些扩展键会先发 0xE0
static EXTENDED: AtomicBool = AtomicBool::new(false);

fn decode(sc: u8) -> Key {
    let ext = EXTENDED.swap(false, Ordering::SeqCst);
    let shift = SHIFT.load(Ordering::SeqCst);
    let ctrl = CTRL.load(Ordering::SeqCst);

    if ext {
        return match sc {
            0x48 => Key::Up,
            0x50 => Key::Down,
            0x4B => Key::Left,
            0x4D => Key::Right,
            0x47 => Key::Home,
            0x4F => Key::End,
            0x53 => Key::Delete,
            _ => Key::Unknown,
        };
    }

    match sc {
        0x2A | 0x36 => {
            SHIFT.store(true, Ordering::SeqCst);
            Key::Unknown
        }
        0x1D => {
            CTRL.store(true, Ordering::SeqCst);
            Key::Unknown
        }
        _ => {
            let idx = sc as usize;
            if idx >= SCAN.len() {
                return Key::Unknown;
            }
            let base = if shift { SCAN_SHIFT[idx] } else { SCAN[idx] };
            if base == 0 {
                return Key::Unknown;
            }
            if ctrl {
                // Ctrl 组合统一折成小写控制字符，shell 只认几个（^C ^D ^L ^A ^E）
                let c = base.to_ascii_lowercase();
                return Key::Ctrl(c);
            }
            match base {
                b'\r' => Key::Enter,
                8 => Key::Backspace,
                9 => Key::Tab,
                27 => Key::Esc,
                c => Key::Char(c),
            }
        }
    }
}

fn handle_scancode(sc: u8) {
    match sc {
        0xE0 => {
            EXTENDED.store(true, Ordering::SeqCst);
            return;
        }
        // 松开：抬起修饰键状态
        0xAA | 0xB6 => {
            SHIFT.store(false, Ordering::SeqCst);
            return;
        }
        0x9D => {
            CTRL.store(false, Ordering::SeqCst);
            return;
        }
        _ => {}
    }
    if sc & 0x80 != 0 {
        return; // 其它键的松开事件不关心
    }
    let k = decode(sc);
    if k != Key::Unknown {
        KEYS.lock().push(k);
    }
}

/* ---------- 中断处理 ---------- */

extern "x86-interrupt" fn timer_handler(_frame: InterruptStackFrame) {
    TICKS.fetch_add(1, Ordering::Relaxed);
    unsafe { PICS.lock().notify_end_of_interrupt(PIC_1_OFFSET) };
}

extern "x86-interrupt" fn keyboard_handler(_frame: InterruptStackFrame) {
    let mut port: Port<u8> = Port::new(0x60);
    // SAFETY: 0x60 是 PS/2 数据端口；有中断就说明有数据可读
    let sc = unsafe { port.read() };
    handle_scancode(sc);
    unsafe { PICS.lock().notify_end_of_interrupt(PIC_1_OFFSET + 1) };
}

/// 串口收到的字节（我们暂时只收不发），留着给以后接 COM 输入
static COM1_RX: AtomicU32 = AtomicU32::new(0);

extern "x86-interrupt" fn com1_handler(_frame: InterruptStackFrame) {
    let mut port: Port<u8> = Port::new(0x3F8);
    let b = unsafe { port.read() };
    COM1_RX.store(b as u32, Ordering::Relaxed);
    unsafe { PICS.lock().notify_end_of_interrupt(PIC_1_OFFSET + 4) };
}

extern "x86-interrupt" fn breakpoint_handler(frame: InterruptStackFrame) {
    crate::vga::write_fmt(format_args!(
        "\n  breakpoint at {:#x}\n",
        frame.instruction_pointer.as_u64()
    ));
}

extern "x86-interrupt" fn double_fault_handler(frame: InterruptStackFrame, _code: u64) -> ! {
    crate::serial::write_str("\n!! DOUBLE FAULT\n");
    crate::vga::clear();
    crate::vga::set_color(crate::vga::WHITE, crate::vga::RED);
    crate::vga::write_str("  DOUBLE FAULT\n");
    crate::vga::reset_color();
    crate::vga::write_fmt(format_args!("\n  rip = {:#x}\n", frame.instruction_pointer.as_u64()));
    crate::vga::write_str("\n  the kernel stack probably overflowed.\n");
    loop {
        x86_64::instructions::hlt();
    }
}

extern "x86-interrupt" fn page_fault_handler(frame: InterruptStackFrame, code: PageFaultErrorCode) {
    let addr = x86_64::registers::control::Cr2::read();
    crate::serial::write_fmt(format_args!(
        "\n!! PAGE FAULT at {addr:?} code {code:?}\n"
    ));
    crate::vga::clear();
    crate::vga::set_color(crate::vga::WHITE, crate::vga::RED);
    crate::vga::write_str("  PAGE FAULT\n");
    crate::vga::reset_color();
    crate::vga::write_fmt(format_args!("\n  address {addr:?}\n  rip {:#x}\n", frame.instruction_pointer.as_u64()));
    loop {
        x86_64::instructions::hlt();
    }
}

extern "x86-interrupt" fn general_protection(frame: InterruptStackFrame, code: u64) {
    crate::serial::write_fmt(format_args!("\n!! GP FAULT code {code}\n"));
    crate::vga::clear();
    crate::vga::set_color(crate::vga::WHITE, crate::vga::RED);
    crate::vga::write_str("  GENERAL PROTECTION FAULT\n");
    crate::vga::reset_color();
    crate::vga::write_fmt(format_args!("\n  error {code}  rip {:#x}\n", frame.instruction_pointer.as_u64()));
    loop {
        x86_64::instructions::hlt();
    }
}

pub fn init_idt() {
    static mut IDT: InterruptDescriptorTable = InterruptDescriptorTable::new();
    // SAFETY: IDT 是静态的，只在启动时写；load 之后 CPU 直接引用它
    let idt = unsafe { &mut *(&raw mut IDT) };

    idt.breakpoint.set_handler_fn(breakpoint_handler);
    // SAFETY: 双重故障用 IST1，栈由 gdt.rs 提供，不是内核栈
    unsafe {
        idt.double_fault
            .set_handler_fn(double_fault_handler)
            .set_stack_index(crate::gdt::DOUBLE_FAULT_IST);
    }
    idt.page_fault.set_handler_fn(page_fault_handler);
    idt.general_protection_fault.set_handler_fn(general_protection);

    idt[PIC_1_OFFSET].set_handler_fn(timer_handler);
    idt[PIC_1_OFFSET + 1].set_handler_fn(keyboard_handler);
    idt[PIC_1_OFFSET + 4].set_handler_fn(com1_handler);
    // IRQ12（aux 鼠标）挂在第二个 PIC 上：IRQ12 → PIC_2_OFFSET + 4
    idt[PIC_2_OFFSET + 4].set_handler_fn(crate::mouse::mouse_handler);

    idt.load();
    *IDT_REF.lock() = Some(idt);
}

static IDT_REF: Mutex<Option<&'static InterruptDescriptorTable>> = Mutex::new(None);

/// 保险起见对外留个断点触发器，方便调试
pub fn trigger_breakpoint() {
    x86_64::instructions::interrupts::int3();
}

#[allow(dead_code)]
fn _unused(_: &'static InterruptDescriptorTable) -> Option<&'static InterruptDescriptorTable> {
    *IDT.lock()
}
