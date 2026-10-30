//! GDT：把 CPU 从「bootloader 随手留的段」切换到我们自己定义的一套
//!
//! 长模式里段寄存器基本是摆设（基址恒为 0、界限恒为全开），但内核栈和
//! 用户态 TSS 还是要靠 GDT 描述。这里走标准的三段：
//!
//!   index 0  null      —— CPU 规定第 0 项必须是空的
//!   index 1  code      —— 内核代码段（64 位，DPL 0）
//!   index 2  data      —— 内核数据段（64 位，DPL 0）
//!   index 3  tss       —— 任务状态段，存 RSP0 和 IST
//!
//! 换 GDT 必须同时 `lgdt` + 重装 CS/DS，否则 CPU 还在用旧选择子。
//! 重装 CS 只能靠一个 far return，所以下面用 inline asm 推一个
//! 「返回地址 + 代码段选择子」再 `retfq` —— 这不是玄学，是 x86 唯一的路。

use core::mem::size_of;
use spin::Mutex;
use x86_64::instructions::segmentation::{Segment, CS, DS, ES, SS};
use x86_64::instructions::tables::load_tss;
use x86_64::registers::segmentation::SegmentSelector;
use x86_64::structures::gdt::{Descriptor, GlobalDescriptorTable};
use x86_64::structures::tss::TaskStateSegment;
use x86_64::VirtAddr;

/// 双重故障要一个独立的栈：如果内核栈已经溢出，用它自己的栈就等于
/// 继续往坏掉的地方写，CPU 会直接三重故障（表现为「机器一重启」）。
pub const DOUBLE_FAULT_IST: u16 = 0;

/// 中断处理栈（键盘、定时器都在这上面跑）
const STACK_SIZE: usize = 16 * 1024;
static mut STACK: [u8; STACK_SIZE] = [0; STACK_SIZE];

fn tss() -> &'static TaskStateSegment {
    static mut TSS: TaskStateSegment = TaskStateSegment::new();
    // SAFETY: 只在 init 期间写一次，之后只读
    unsafe {
        TSS.interrupt_stack_table[DOUBLE_FAULT_IST as usize] = {
            let stack_start = VirtAddr::from_ptr(&raw const STACK);
            stack_start + STACK_SIZE as u64
        };
        &TSS
    }
}

struct Selectors {
    code: SegmentSelector,
    data: SegmentSelector,
    tss: SegmentSelector,
}

static SELECTORS: Mutex<Option<Selectors>> = Mutex::new(None);

pub fn init() {
    static mut GDT: GlobalDescriptorTable = GlobalDescriptorTable::new();
    // SAFETY: 只在启动时初始化一次；GDT 要活到机器下电，所以是静态的
    let gdt = unsafe { &mut *(&raw mut GDT) };
    let code = gdt.append(Descriptor::kernel_code_segment());
    let data = gdt.append(Descriptor::kernel_data_segment());
    let tss_sel = gdt.append(Descriptor::tss_segment(tss()));

    gdt.load();

    // SAFETY: 选择子刚由本 GDT 分配，指向的就是上面那几个描述符
    unsafe {
        CS::set_reg(code);
        DS::set_reg(data);
        ES::set_reg(data);
        SS::set_reg(data);
        load_tss(tss_sel);
    }

    *SELECTORS.lock() = Some(Selectors { code, data, tss: tss_sel });
}

pub fn code_selector() -> SegmentSelector {
    SELECTORS
        .lock()
        .as_ref()
        .map(|s| s.code)
        .unwrap_or(SegmentSelector::new(0, x86_64::PrivilegeLevel::Ring0))
}

pub fn data_selector() -> SegmentSelector {
    SELECTORS
        .lock()
        .as_ref()
        .map(|s| s.data)
        .unwrap_or(SegmentSelector::new(0, x86_64::PrivilegeLevel::Ring0))
}

pub fn tss_selector() -> SegmentSelector {
    SELECTORS
        .lock()
        .as_ref()
        .map(|s| s.tss)
        .unwrap_or(SegmentSelector::new(0, x86_64::PrivilegeLevel::Ring0))
}

pub fn stack_size() -> usize {
    size_of::<[u8; STACK_SIZE]>()
}
