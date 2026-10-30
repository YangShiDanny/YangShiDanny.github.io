//! 内存：物理帧分配 + 内核堆
//!
//! bootloader 交给我们的 `BootInfo` 里有一张内存地图（哪些区间能用、
//! 哪些是显存/ACPI 保留）。我们在「能用的」区间上切一个堆出来，
//! 然后用一个链表分配器把它变成 `Box` / `Vec` / `String` 能用的地方。
//!
//! 为什么自己写链表分配器：内核里的分配需求很粗糙（建个文件节点、
//! 拼个字符串），不像用户态那样追求碎片率。链表分配器 100 行以内，
//! 逻辑一眼看得完，出问题也好查 —— 这在裸机上比性能重要得多。
//!
//! 后续要上分页的话，`FRAMES` 这套位图可以直接接 `map_page`。

use alloc::alloc::{GlobalAlloc, Layout};
use alloc::format;
use bootloader_api::info::MemoryRegionKind;
use core::ptr::null_mut;
use spin::Mutex;
use x86_64::VirtAddr;

/// 整个物理内存被映射到虚拟地址空间的这个偏移上。
///
/// bootloader 0.11 建的是一张全新的页表，只映射内核段、栈、bootinfo 和
/// framebuffer 那几个 4 KiB 页；其余物理内存通过这条 linear mapping 暴露出来。
/// 堆、以及任何「拿物理地址当指针」的地方，都得先加这个偏移。
pub const PHYS_OFFSET: u64 = 0x0000_1000_0000_0000;

pub const PAGE_SIZE: u64 = 4096;

/* ---------- 物理帧位图 ---------- */

/// 记账用的位图：一帧一位。512 KiB 位图能管 4 GiB / 4 KiB = 1M 帧。
const FRAME_BITS: usize = 1 << 20;
static mut FRAME_BITMAP: [u8; FRAME_BITS / 8] = [0; FRAME_BITS / 8];

pub struct FrameBitmap {
    next: usize,
    used: u64,
    /// 内存地图里登记为「可用」的帧总数。有了它 free = avail - used 才准，
    /// 否则只能报「还没分配出去」的位图空位数，把保留区也算进去了。
    avail: u64,
}

impl FrameBitmap {
    const fn new() -> Self {
        FrameBitmap { next: 0, used: 0, avail: 0 }
    }

    fn set(&mut self, idx: usize) {
        if idx / 8 < FRAME_BITS / 8 {
            // SAFETY: 索引已做上界检查
            unsafe { FRAME_BITMAP[idx / 8] |= 1 << (idx % 8) };
        }
    }

    fn clear(&mut self, idx: usize) {
        if idx / 8 < FRAME_BITS / 8 {
            // SAFETY: 同上
            unsafe { FRAME_BITMAP[idx / 8] &= !(1 << (idx % 8)) };
        }
    }

    fn get(&self, idx: usize) -> bool {
        if idx / 8 >= FRAME_BITS / 8 {
            return true; // 越界当作已占用，别把帧发给别人
        }
        // SAFETY: 只读，索引已检查
        unsafe { FRAME_BITMAP[idx / 8] & (1 << (idx % 8)) != 0 }
    }

    /// 登记一帧「可以分配」：把位清零并把扫描指针退回去
    fn mark_available(&mut self, addr: u64) {
        let idx = (addr / PAGE_SIZE) as usize;
        self.clear(idx);
        if idx < self.next {
            self.next = idx;
        }
    }

    pub fn alloc(&mut self) -> Option<u64> {
        let mut idx = self.next;
        while idx < FRAME_BITS {
            if !self.get(idx) {
                self.set(idx);
                self.used += 1;
                self.next = idx + 1;
                return Some(idx as u64 * PAGE_SIZE);
            }
            idx += 1;
        }
        None
    }

    pub fn free(&mut self, addr: u64) {
        let idx = (addr / PAGE_SIZE) as usize;
        if self.get(idx) {
            self.clear(idx);
            self.used = self.used.saturating_sub(1);
            self.next = self.next.min(idx);
        }
    }

    pub fn used_frames(&self) -> u64 {
        self.used
    }

    /// 内存地图登记过的可用帧总数（不含保留区）
    pub fn avail_frames(&self) -> u64 {
        self.avail
    }
}

static FRAMES: Mutex<FrameBitmap> = Mutex::new(FrameBitmap::new());

/// 还剩多少帧没发出去。`df` / `free` / 开机横幅都用这个数。
pub fn free_frames() -> u64 {
    let f = FRAMES.lock();
    f.avail_frames().saturating_sub(f.used_frames())
}

pub fn frames_used() -> u64 {
    FRAMES.lock().used_frames()
}

/// 别名，给 shell 的 `free` 命令读，名字顺手一点
pub fn used_frames() -> u64 {
    frames_used()
}

/* ---------- 堆 ---------- */

/// 堆从哪开始、多长。由 bootloader 给的那块 `ramdisk`/可用内存决定，
/// 这里退一步用「可用区间里挑一块最大的后面部分」，稳。
static HEAP_START: Mutex<usize> = Mutex::new(0);
static HEAP_END: Mutex<usize> = Mutex::new(0);

pub struct LockedHeap(Mutex<Heap>);

impl LockedHeap {
    pub const fn empty() -> Self {
        LockedHeap(Mutex::new(Heap::empty()))
    }
}

struct Heap {
    head: Option<&'static mut ListNode>,
    /// 统计用：分配过多少字节（单调递增，不随释放减少）
    peak: usize,
}

/// 链表节点。`NodeRef` 把「指向节点的指针」和「节点的生命周期」拆开，
/// 这样 `find_region` 里取走一个节点、同时改前驱的 next，不会同时借两次。
struct NodeRef {
    node: *mut ListNode,
    size: usize,
}

impl NodeRef {
    fn new(size: usize) -> Self {
        NodeRef {
            node: null_mut(),
            size,
        }
    }
    fn start(&self) -> usize {
        self.node as usize
    }
    fn end(&self) -> usize {
        self.node as usize + self.size
    }
}

struct ListNode {
    size: usize,
    next: Option<&'static mut ListNode>,
}

impl ListNode {
    fn new(size: usize) -> Self {
        ListNode { size, next: None }
    }
    fn start_addr(&self) -> usize {
        self as *const Self as usize
    }
    fn end_addr(&self) -> usize {
        self.start_addr() + self.size
    }
}

impl Heap {
    const fn empty() -> Self {
        Heap {
            head: None,
            peak: 0,
        }
    }

    unsafe fn init(&mut self, start: usize, size: usize) {
        self.add_free_region(start, size);
    }

    unsafe fn add_free_region(&mut self, addr: usize, size: usize) {
        // 对齐到 ListNode 的大小，保证写进去的链表节点本身是合法的
        let align = core::mem::align_of::<ListNode>();
        let mut addr = addr;
        let mut size = size;
        let offset = addr % align;
        if offset != 0 {
            addr += align - offset;
            size = size.saturating_sub(align - offset);
        }
        if size < core::mem::size_of::<ListNode>() {
            return;
        }
        let mut node = ListNode::new(size);
        node.next = self.head.take();
        let node_ptr = addr as *mut ListNode;
        node_ptr.write(node);
        self.head = Some(&mut *node_ptr);
    }

    fn find_region(&mut self, size: usize, align: usize) -> Option<(NodeRef, usize)> {
        // 遍历链表找第一个装得下的节点。
        // 用裸指针走，是为了能同时「取走节点」和「改前驱的 next」，
        // 这两件事用 &mut 一起做就借不动了。
        let mut prev: *mut Option<&'static mut ListNode> = &mut self.head;
        loop {
            // SAFETY: prev 要么是 &self.head，要么是上一个节点的 next 字段；
            // 链表节点全在静态堆上，本轮遍历内不会失效
            match unsafe { (*prev).as_mut() } {
                Some(n) => {
                    let node_ptr: *mut ListNode = *n as *mut ListNode;
                    // SAFETY: node_ptr 刚由有效引用取得
                    let node = unsafe { &mut *node_ptr };
                    match Self::alloc_from_region(node, size, align) {
                        Ok(alloc_start) => {
                            let region = NodeRef {
                                node: node_ptr,
                                size: node.size,
                            };
                            // 摘链：前驱直接指向当前节点的后继
                            let next = node.next.take();
                            // SAFETY: prev 指向前驱（或 head），写入是链表本来的语义
                            unsafe { *prev = next };
                            return Some((region, alloc_start));
                        }
                        Err(()) => {
                            // SAFETY: 同上，取 next 字段地址作为下一轮的 prev
                            prev = unsafe { &mut (*node_ptr).next };
                        }
                    }
                }
                None => return None,
            }
        }
    }

    fn alloc_from_region(region: &ListNode, size: usize, align: usize) -> Result<usize, ()> {
        let alloc_start = align_up(region.start_addr(), align);
        let alloc_end = alloc_start.checked_add(size).ok_or(())?;
        if alloc_end > region.end_addr() {
            return Err(());
        }
        let excess = region.end_addr() - alloc_end;
        if excess > 0 && excess < core::mem::size_of::<ListNode>() {
            // 剩余太碎，整块给出去，别留个没法用的洞
            return Err(());
        }
        Ok(alloc_start)
    }
}

fn align_up(addr: usize, align: usize) -> usize {
    (addr + align - 1) & !(align - 1)
}

unsafe impl GlobalAlloc for LockedHeap {
    unsafe fn alloc(&self, layout: Layout) -> *mut u8 {
        let mut heap = self.0.lock();
        let (size, align) = (layout.size(), layout.align());
        let size = size.max(core::mem::size_of::<ListNode>());
        match heap.find_region(size, align) {
            Some((region, alloc_start)) => {
                let alloc_end = alloc_start + size;
                let excess = region.end() - alloc_end;
                if excess > 0 {
                    heap.add_free_region(alloc_end, excess);
                }
                if size > heap.peak {
                    heap.peak = size;
                }
                alloc_start as *mut u8
            }
            None => null_mut(),
        }
    }

    unsafe fn dealloc(&self, ptr: *mut u8, layout: Layout) {
        let size = layout.size().max(core::mem::size_of::<ListNode>());
        self.0.lock().add_free_region(ptr as usize, size);
    }
}

/// 堆里此刻还剩多少空闲字节（只把链表节点的大小加起来，够看个大概）
pub fn heap_free() -> usize {
    ALLOCATOR.0.lock().free_bytes()
}

/// 堆总大小减去空闲，就是分出去的部分
pub fn heap_used() -> usize {
    let (start, end) = heap_used_range();
    let total = end.saturating_sub(start);
    total.saturating_sub(heap_free())
}

/// 堆的总字节数
pub fn heap_total() -> usize {
    let (start, end) = heap_used_range();
    end.saturating_sub(start)
}

impl Heap {
    fn free_bytes(&self) -> usize {
        let mut total = 0;
        let mut cur = self.head.as_ref();
        while let Some(n) = cur {
            total += n.size;
            cur = n.next.as_ref();
        }
        total
    }
}

#[global_allocator]
pub static ALLOCATOR: LockedHeap = LockedHeap::empty();

/// 从内存地图里挑一块做堆，并把所有可用帧登记进位图
pub fn init(boot_info: &'static mut bootloader_api::BootInfo) {
    let regions = &boot_info.memory_regions;
    let mut best: Option<(u64, u64)> = None;
    for r in regions.iter() {
        if r.kind != MemoryRegionKind::Usable {
            continue;
        }
        let len = r.end - r.start;
        if len < 4 * 1024 * 1024 {
            continue; // 太碎，不做堆
        }
        if best.map(|(_, bl)| len > bl).unwrap_or(true) {
            best = Some((r.start, len));
        }
    }

    // 帧位图：先把所有帧标成「已占用」（默认全 1 太费，改为从 0 起逐个 free）
    // 这里用 alloc 的逆操作登记可用帧：free 会把位清掉并计入可用
    for r in regions.iter() {
        if r.kind != MemoryRegionKind::Usable {
            continue;
        }
        let mut addr = r.start;
        while addr + PAGE_SIZE <= r.end {
            let mut f = FRAMES.lock();
            f.mark_available(addr);
            f.avail += 1;
            addr += PAGE_SIZE;
        }
    }

    if let Some((start, len)) = best {
        // 堆放在这块区间的后半段：前面留给内核自己的代码/数据/栈。
        //
        // **关键**：这里拿到的是物理地址，但内核跑在 bootloader 新建的页表上，
        // 低端物理地址并不直接可写（0x4a41000 那种地址会立刻缺页）。
        // 必须走 linear mapping：虚拟地址 = PHYS_OFFSET + 物理地址。
        let heap_phys = start + len / 2;
        let heap_start = (PHYS_OFFSET + heap_phys) as usize;
        let heap_size = (len / 2) as usize;
        *HEAP_START.lock() = heap_start;
        *HEAP_END.lock() = heap_start + heap_size;
        // SAFETY: 这段物理内存 bootloader 明确报「可用」，且已被 linear mapping 覆盖；
        // 内核镜像、栈、bootinfo 都在该区间前半段，不会重叠
        unsafe { ALLOCATOR.0.lock().init(heap_start, heap_size) };
    }
}

pub fn heap_used_range() -> (usize, usize) {
    (*HEAP_START.lock(), *HEAP_END.lock())
}

/// 物理地址 → 可访问的虚拟地址。
///
/// 内核跑在 bootloader 新建的页表上，物理内存通过 linear mapping 暴露在
/// `PHYS_OFFSET` 处，所以「物理地址」不能直接当指针用。
pub fn phys_to_virt(addr: u64) -> VirtAddr {
    VirtAddr::new(addr + PHYS_OFFSET)
}
