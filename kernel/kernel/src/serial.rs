//! COM1（0x3F8）串口：内核最早的输出通道
//!
//! 为什么第一个初始化它：VGA 要等 bootloader 交出帧缓冲，而串口只要
//! 16550 在（QEMU 一定有），一条 `outb 0x3F8` 就能吐字节。panic 时屏幕
//! 可能已经花了，串口是唯一还诚实的证人。
//!
//! 用法：`qemu-system-x86_64 ... -serial stdio`，当 stdout 看。

use core::fmt::{self, Write};
use spin::Mutex;
use uart_16550::SerialPort;

struct Port(Mutex<Option<SerialPort>>);

impl Port {
    const fn new() -> Self {
        Port(Mutex::new(None))
    }
}

static SERIAL: Port = Port::new();

pub fn init() {
    // SAFETY: 0x3F8 是 COM1 的标准基址
    let mut port = unsafe { SerialPort::new(0x3F8) };
    port.init();
    *SERIAL.0.lock() = Some(port);
}

pub fn write_str(s: &str) {
    if let Some(port) = SERIAL.0.lock().as_mut() {
        let _ = port.write_str(s);
    }
}

pub fn write_fmt(args: fmt::Arguments) {
    if let Some(port) = SERIAL.0.lock().as_mut() {
        let _ = port.write_fmt(args);
    }
}

/// panic 专用：带一点现场信息，方便从串口日志直接定位
pub fn panic_print(info: &core::panic::PanicInfo) {
    write_str("\n=== KERNEL PANIC ===\n");
    if let Some(loc) = info.location() {
        write_fmt(format_args!("at {}:{}:{}\n", loc.file(), loc.line(), loc.column()));
    }
    write_fmt(format_args!("{}\n", info.message()));
    write_str("====================\n");
}
