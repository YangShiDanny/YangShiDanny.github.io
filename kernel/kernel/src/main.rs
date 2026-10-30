//! 内核入口
//!
//! 真的裸机内核：bootloader 把 CPU 从 16 位实模式带到 64 位长模式，
//! 然后跳到 `kernel_main`。从这里往下没有任何操作系统兜底 ——
//! 没有 libc、没有现成的堆、连屏幕都得自己一格一格写。
//!
//! 初始化顺序有依赖，不能乱：
//!
//!   serial → gdt → idt → vga → pic → (开中断) → 内存 → 堆 → fs → shell
//!
//!   串口最先，它不依赖任何东西，是 panic 时唯一的证人。
//!   GDT/IDT 必须在**写屏之前**：VGA 驱动的每个函数都包了
//!   without_interrupts，IDT 为空时任何异常都会三重故障。
//!   PIC 重映射要在开中断之前，否则 IRQ 会撞上 CPU 异常号。
//!   堆要在 fs 之前，因为 fs 全是 Vec/String。

#![no_std]
#![no_main]
#![feature(abi_x86_interrupt)]

extern crate alloc;

mod fs;
mod gdt;
mod interrupts;
mod memory;
mod serial;
mod shell;
mod vga;

use bootloader_api::{config::Mapping, entry_point, BootInfo};
use core::panic::PanicInfo;

static BOOT_CONFIG: bootloader_api::BootloaderConfig = {
    let mut cfg = bootloader_api::BootloaderConfig::new_default();
    cfg.kernel_stack_size = 256 * 1024;
    // 打开物理内存线性映射：虚拟 PHYS_OFFSET + phys 就是物理 phys。
    // 堆就靠这个偏移把物理地址翻译成可写虚拟地址（见 memory.rs）。
    cfg.mappings.physical_memory = Some(Mapping::FixedAddress(crate::memory::PHYS_OFFSET));
    cfg
};

entry_point!(kernel_main, config = &BOOT_CONFIG);

fn kernel_main(boot_info: &'static mut BootInfo) -> ! {
    serial::init();
    serial::write_str("LumeOS: control handed over by bootloader\n");

    // 先把 GDT/IDT 立起来。VGA 的每个写入函数都要拿自旋锁、都包了
    // without_interrupts，IDT 为空时任何异常都会解引用地址 0 的 IDT，
    // 立刻三重故障 —— 机器静默重启，屏幕上什么都留不下。
    gdt::init();
    interrupts::init_idt();

    // 先把 framebuffer 从 BootInfo 里取出来 —— memory::init 会把整个
    // `&'static mut BootInfo` 拿走，之后就访问不到字段了。bootloader 给的是
    // 图形模式下的线性 framebuffer，交给 VGA 驱动去画字。
    let fb_opt = core::mem::replace(
        &mut boot_info.framebuffer,
        bootloader_api::info::Optional::None,
    );
    let framebuffer = match fb_opt.into_option() {
        Some(fb) => fb,
        None => {
            serial::write_str("LumeOS: no framebuffer from bootloader!\n");
            loop {
                x86_64::instructions::hlt();
            }
        }
    };

    memory::init(boot_info);

    vga::init(framebuffer);
    vga::splash();

    // SAFETY: IDT 已装好，PIC 还没重映射；这一步把 IRQ 挪到 0x20 之后
    unsafe { interrupts::PICS.lock().initialize() };
    x86_64::instructions::interrupts::enable();

    vga::boot_line("gdt/idt  loaded, interrupts live");
    vga::boot_line("memory   frame bitmap ready");

    // 堆在 memory::init 里已经就位，从这里往下才能用 Vec/String
    let heap_kb = memory::heap_total() / 1024;
    vga::boot_line_fmt(format_args!("heap     {heap_kb} KB linked-list allocator"));

    let now = interrupts::uptime_ms();
    fs::init(now);
    let u = fs::usage();
    vga::boot_line_fmt(format_args!(
        "lumeFS   {} files, {} dirs, in RAM",
        u.files, u.dirs
    ));

    vga::boot_done();
    serial::write_str("LumeOS: handing over to the shell\n");

    // 不返回：从此这台机器的时间全花在等按键上
    shell::Shell::new().run();
}

#[panic_handler]
fn panic(info: &PanicInfo) -> ! {
    vga::panic_screen(info);
    serial::panic_print(info);
    x86_64::instructions::interrupts::disable();
    loop {
        x86_64::instructions::hlt();
    }
}
