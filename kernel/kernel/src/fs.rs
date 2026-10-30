//! LumeFS 的真实内核实现
//!
//! 和浏览器里那份 `public/LumeOS/js/fs.js` 是同一个设计血统：
//! 一棵按**绝对路径**索引的树，节点只有「目录」和「文件」两种。
//! 区别在于这里没有 localStorage 可赖 —— 所有东西都靠 `alloc::` 在
//! 我们自己搭的链表堆上分配，机器断电就没了。
//!
//! 存成扁平的 `Vec<Node>`，靠 `parent` 索引串起来，而不是每个目录拿一个
//! `Vec<子节点>`。这么做有两个实际好处：
//!
//!   1. 找路径从根开始逐段比对 `name`，不用递归，栈深度恒定；
//!   2. 删除目录时要连根拔掉整棵子树，扁平结构用一次标记扫描就能清干净，
//!      不用写递归析构（裸机上的递归析构很容易把内核栈打穿）。
//!
//! 索引：`0` 恒为根 `/`。

use alloc::{
    string::{String, ToString},
    vec::Vec,
};

/// 就是那个 `/` 的名字。根节点用它占位，正常条目不会叫这个。
const ROOT_NAME: &str = "";

pub const MAX_NAME: usize = 64;
/// 单文件上限。堆总共才几十 MB，再大就该换页了，这里先兜住。
pub const MAX_FILE: usize = 256 * 1024;

#[derive(Clone, Copy, PartialEq, Eq)]
pub enum Kind {
    Dir,
    File,
}

impl Kind {
    pub fn is_dir(self) -> bool {
        matches!(self, Kind::Dir)
    }
}

struct Node {
    name: String,
    kind: Kind,
    /// 父节点在 `NODES` 里的下标；根是 `usize::MAX`
    parent: usize,
    /// 只有目录用：第一级子节点下标（链表头）
    first_child: usize,
    /// 同级兄弟链表的下一个
    next_sibling: usize,
    /// 只有文件用
    content: Vec<u8>,
    /// 逻辑修改时刻，单位是启动以来的毫秒（没有 RTC，拿不到真实日期）
    mtime: u64,
}

impl Node {
    fn new(name: &str, kind: Kind, parent: usize, now: u64) -> Self {
        Node {
            name: name.to_string(),
            kind,
            parent,
            first_child: usize::MAX,
            next_sibling: usize::MAX,
            content: Vec::new(),
            mtime: now,
        }
    }

    fn is_dir(&self) -> bool {
        self.kind.is_dir()
    }
}

/// 全局节点表。索引稳定，永不移动 —— 用 `Box<Vec<_>>` 没必要，
/// `Vec` 扩容只会搬动元素数据，下标语义不受影响。
static mut NODES: Vec<Node> = Vec::new();
static mut CWD: usize = 0;
static mut READY: bool = false;

fn nodes() -> &'static mut Vec<Node> {
    // SAFETY: 裸机单核，文件系统操作全部在 shell 里顺序执行，
    // 没有任何中断处理程序会碰 NODES。
    unsafe { &mut *(&raw mut NODES) }
}

// ---------------------------------------------------------------- 初始化

/// 建好根并塞一份初始内容。和浏览器版的 SEED 保持一致的目录骨架，
/// 但文件内容换成「这就是真的内核」这件事本身值得写的话。
pub fn init(now: u64) {
    if unsafe { READY } {
        return;
    }
    let n = nodes();
    n.clear();
    n.push(Node::new(ROOT_NAME, Kind::Dir, usize::MAX, now));

    mkdir_p("/home/lume/Desktop", now);
    mkdir_p("/home/lume/work", now);
    mkdir_p("/etc", now);
    mkdir_p("/var/log", now);

    let readme = "# LumeOS\n\
        \n\
        You are looking at an actual kernel.\n\
        Not a tab, not a canvas, not a simulation.\n\
        Rust, no_std, booted by a bootloader out of a 34 KB ELF\n\
        onto a machine with no operating system underneath.\n\
        \n\
        What exists in here right now:\n\
        - a 25-row VGA text buffer, written one cell at a time\n\
        - an IDT with real page-fault and double-fault handlers\n\
        - a 4 KiB frame bitmap over the memory map the BIOS handed us\n\
        - a linked-list heap, because `alloc` needs somewhere to live\n\
        - PS/2 scancodes decoded by hand, set 1, shift and ctrl included\n\
        - this file system, which is a Vec of nodes and nothing else\n\
        \n\
        What does not exist:\n\
        - processes. there is one thread of execution and it is this prompt.\n\
        - a clock with a date. the PIT ticks at 100 Hz; time is ms since boot.\n\
        - persistence. power off and every byte above is gone.\n\
        \n\
        Try: ls, cd work, cat ../README.md, df, neofetch\n";

    let notes = "scratch pad\n\
        -----------\n\
        \n\
        [x] kernel entry point, bootloader hands over in long mode\n\
        [x] serial console, the only witness when things go wrong\n\
        [x] VGA writer with hardware cursor and scrolling\n\
        [x] GDT + TSS + double fault IST\n\
        [x] IDT, PIC remapped to 0x20, PIT at 100 Hz\n\
        [x] PS/2 keyboard, set 1, shift/ctrl tracked through E0 prefixes\n\
        [x] frame bitmap + linked-list heap\n\
        [x] file system + shell\n\
        [ ] write the fs back to disk. needs an ATA driver.\n\
        [ ] a second stack so a fault can tell you something useful\n\
        \n\
        the whole thing is smaller than the favicon of the website\n\
        that describes it. that is the joke, and it is a good one.\n";

    let hello = "// hello.lume - this machine is named after it\n\
        // there is no interpreter in here yet. the compiler is.\n\
        \n\
        fn main() {\n\
        \x20\x20\x20\x20println!(\"hello from ring 0\");\n\
        }\n";

    let motd = "LumeOS bootstrap complete.\n\
        One process. Zero drivers. Everything below this line is ours.\n";

    let _ = write_file("/home/lume/README.md", readme.as_bytes(), now);
    let _ = write_file("/home/lume/notes.txt", notes.as_bytes(), now);
    let _ = write_file("/home/lume/work/hello.lume", hello.as_bytes(), now);
    let _ = write_file("/etc/motd", motd.as_bytes(), now);

    unsafe {
        CWD = 0;
        READY = true;
    }
}

// ---------------------------------------------------------------- 查找

fn find_child(dir: usize, name: &str) -> Option<usize> {
    let n = nodes();
    let mut cur = n[dir].first_child;
    while cur != usize::MAX {
        if n[cur].name == name {
            return Some(cur);
        }
        cur = n[cur].next_sibling;
    }
    None
}

/// 把一个路径解析成节点下标。相对路径从 `cwd` 起算。
pub fn resolve(path: &str) -> Option<usize> {
    let n = nodes();
    let mut cur = if path.starts_with('/') { 0 } else { unsafe { CWD } };

    for seg in path.split('/') {
        if seg.is_empty() || seg == "." {
            continue;
        }
        if seg == ".." {
            cur = if cur == 0 { 0 } else { n[cur].parent };
            continue;
        }
        if !n[cur].is_dir() {
            return None;
        }
        cur = find_child(cur, seg)?;
    }
    Some(cur)
}

/// 拆出「父目录」和「最后一段名字」。给写文件和删除用。
fn split_parent(path: &str) -> Option<(usize, String)> {
    let trimmed = path.trim_end_matches('/');
    if trimmed.is_empty() || trimmed == "/" {
        return None;
    }
    let (dir_part, name) = match trimmed.rfind('/') {
        Some(i) => (&trimmed[..i], &trimmed[i + 1..]),
        None => ("", trimmed),
    };
    let dir_path = if dir_part.is_empty() {
        if path.starts_with('/') { "/" } else { "." }
    } else {
        dir_part
    };
    let parent = resolve(dir_path)?;
    Some((parent, name.to_string()))
}

pub fn is_dir(idx: usize) -> bool {
    nodes().get(idx).map(Node::is_dir).unwrap_or(false)
}

pub fn name_of(idx: usize) -> &'static str {
    match nodes().get(idx) {
        Some(_) if idx == 0 => "/",
        Some(n) => &n.name,
        None => "?",
    }
}

pub fn kind_of(idx: usize) -> Option<Kind> {
    nodes().get(idx).map(|n| n.kind)
}

pub fn len_of(idx: usize) -> usize {
    nodes().get(idx).map(|n| n.content.len()).unwrap_or(0)
}

pub fn mtime_of(idx: usize) -> u64 {
    nodes().get(idx).map(|n| n.mtime).unwrap_or(0)
}

pub fn content_of(idx: usize) -> Option<&'static [u8]> {
    nodes().get(idx).map(|n| n.content.as_slice())
}

pub fn cwd_index() -> usize {
    unsafe { CWD }
}

pub fn set_cwd(idx: usize) {
    if is_dir(idx) {
        unsafe { CWD = idx };
    }
}

/// 当前工作目录的绝对路径，拼回去给提示符用
pub fn cwd_path() -> String {
    let n = nodes();
    let mut cur = unsafe { CWD };
    if cur == 0 {
        return String::from("/");
    }
    let mut parts: Vec<&str> = Vec::new();
    while cur != 0 && cur != usize::MAX {
        parts.push(&n[cur].name);
        cur = n[cur].parent;
    }
    let mut out = String::new();
    for p in parts.iter().rev() {
        out.push('/');
        out.push_str(p);
    }
    out
}

/// 取子节点列表（名字 + 是否目录），给 `ls` 用。
/// 返回的是拷出来的 `Vec`：`ls` 之后要逐行写屏，
/// 而写屏会 `lock`，不能一边持着 `NODES` 的裸引用一边往下走。
pub fn list(dir: usize) -> Vec<(String, bool, usize)> {
    let n = nodes();
    let mut out = Vec::new();
    let mut cur = n[dir].first_child;
    while cur != usize::MAX {
        out.push((n[cur].name.clone(), n[cur].is_dir(), n[cur].content.len()));
        cur = n[cur].next_sibling;
    }
    // 目录在前、文件在后，各自按字典序 —— 和别人家 ls 一样
    out.sort_by(|a, b| match (a.1, b.1) {
        (true, false) => core::cmp::Ordering::Less,
        (false, true) => core::cmp::Ordering::Greater,
        _ => a.0.cmp(&b.0),
    });
    out
}

// ---------------------------------------------------------------- 改动

fn push_file(parent: usize, name: &str, data: &[u8], now: u64) -> Result<usize, &'static str> {
    if find_child(parent, name).is_some() {
        return Err("exists");
    }
    let n = nodes();
    let idx = n.len();
    let mut node = Node::new(name, Kind::File, parent, now);
    node.content = Vec::from(data);
    n.push(node);
    // 头插到父目录的子链表
    let old_first = n[parent].first_child;
    n[idx].next_sibling = old_first;
    n[parent].first_child = idx;
    Ok(idx)
}

/// 写文件：不存在就建，存在就整份覆盖
pub fn write_file(path: &str, data: &[u8], now: u64) -> Result<usize, &'static str> {
    if data.len() > MAX_FILE {
        return Err("too large");
    }
    if let Some(idx) = resolve(path) {
        if is_dir(idx) {
            return Err("is a directory");
        }
        let n = nodes();
        n[idx].content.clear();
        n[idx].content.extend_from_slice(data);
        n[idx].mtime = now;
        return Ok(idx);
    }
    let (parent, name) = split_parent(path).ok_or("bad path")?;
    if !is_dir(parent) {
        return Err("not a directory");
    }
    if name.len() > MAX_NAME {
        return Err("name too long");
    }
    push_file(parent, &name, data, now)
}

/// 建一级目录。已存在算成功（幂等）。
pub fn mkdir(path: &str, now: u64) -> Result<usize, &'static str> {
    if let Some(idx) = resolve(path) {
        return if is_dir(idx) { Ok(idx) } else { Err("exists as file") };
    }
    let (parent, name) = split_parent(path).ok_or("bad path")?;
    if !is_dir(parent) {
        return Err("no such directory");
    }
    if name.len() > MAX_NAME {
        return Err("name too long");
    }
    if find_child(parent, &name).is_some() {
        return Err("exists");
    }
    let n = nodes();
    let idx = n.len();
    n.push(Node::new(&name, Kind::Dir, parent, now));
    let old_first = n[parent].first_child;
    n[idx].next_sibling = old_first;
    n[parent].first_child = idx;
    Ok(idx)
}

/// 连 `/a/b/c` 这种一路建下来
pub fn mkdir_p(path: &str, now: u64) -> Option<usize> {
    let mut acc = String::new();
    if !path.starts_with('/') {
        acc.push_str(&cwd_path());
    }
    for seg in path.split('/') {
        if seg.is_empty() || seg == "." {
            continue;
        }
        if seg == ".." {
            let t = acc.rfind('/').unwrap_or(0);
            acc.truncate(t);
            continue;
        }
        acc.push('/');
        acc.push_str(seg);
        mkdir(&acc, now).ok()?;
    }
    resolve(&acc)
}

/// 删一个节点。目录会连整棵子树一起拔掉。
pub fn remove(path: &str) -> Result<(), &'static str> {
    let idx = resolve(path).ok_or("no such file")?;
    if idx == 0 {
        return Err("refusing to remove /");
    }
    // 把任务交给递归版本，但深度受 MAX_NAME/路径长度天然限制
    remove_node(idx);

    // 链式摘除：从父目录的子链表里剪掉这一节
    let n = nodes();
    let parent = n[idx].parent;
    let mut prev = usize::MAX;
    let mut cur = n[parent].first_child;
    while cur != usize::MAX {
        if cur == idx {
            let next = n[cur].next_sibling;
            if prev == usize::MAX {
                n[parent].first_child = next;
            } else {
                n[prev].next_sibling = next;
            }
            break;
        }
        prev = cur;
        cur = n[cur].next_sibling;
    }
    // 如果删的是当前目录本身，退回根
    if unsafe { CWD } == idx {
        unsafe { CWD = 0 };
    }
    Ok(())
}

/// 把子树里的每个节点内容清空（真正回收内存的是 `shrink`）。
/// 注意这里不碰 `NODES` 的重排 —— 下标稳定，其它节点的父子关系不会错位。
fn remove_node(idx: usize) {
    let n = nodes();
    let mut cur = n[idx].first_child;
    while cur != usize::MAX {
        let next = n[cur].next_sibling;
        remove_node(cur);
        cur = next;
    }
    n[idx].content.clear();
    n[idx].content.shrink_to_fit();
    n[idx].name.clear();
    n[idx].name.shrink_to_fit();
    n[idx].kind = Kind::File;
}

/// 统计：节点数、目录数、文件数、占用字节
pub struct Usage {
    pub nodes: usize,
    pub dirs: usize,
    pub files: usize,
    pub bytes: usize,
}

pub fn usage() -> Usage {
    let n = nodes();
    let mut u = Usage { nodes: 0, dirs: 0, files: 0, bytes: 0 };
    for (i, node) in n.iter().enumerate() {
        if i == 0 {
            continue;
        }
        u.nodes += 1;
        if node.is_dir() {
            u.dirs += 1;
        } else {
            u.files += 1;
            u.bytes += node.content.len();
        }
    }
    u
}

/// 判断路径在 cwd 下面该显示成什么 —— 给 `cd` 的成功提示用
pub fn display_path(idx: usize) -> String {
    let n = nodes();
    if idx == 0 {
        return String::from("/");
    }
    let mut parts: Vec<&str> = Vec::new();
    let mut cur = idx;
    while cur != 0 && cur != usize::MAX {
        parts.push(&n[cur].name);
        cur = n[cur].parent;
    }
    let mut out = String::new();
    for p in parts.iter().rev() {
        out.push('/');
        out.push_str(p);
    }
    out
}
