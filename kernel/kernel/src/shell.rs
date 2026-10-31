//! 内核 shell
//!
//! 一个行编辑器加一组命令。所有交互都落在这一个循环里：
//! `read_key_blocking` 拿键，改缓冲区，重画提示符那一行。
//!
//! 没有进程、没有线程：shell 就是这台机器上唯一的执行流。
//! 命令执行期间键盘中断照样进队列，只是没人取。

use crate::fs;
use crate::interrupts::{self, Key};
use crate::vga::{self, CYAN, LIGHT_GRAY, WHITE, YELLOW};
use alloc::{
    format,
    string::{String, ToString},
    vec::Vec,
};

const MAX_LINE: usize = 256;
const HISTORY_CAP: usize = 32;

struct Line {
    buf: [u8; MAX_LINE],
    len: usize,
    /// 光标相对缓冲区开头的字节位置
    cur: usize,
}

impl Line {
    fn new() -> Self {
        Line { buf: [0; MAX_LINE], len: 0, cur: 0 }
    }

    fn as_str(&self) -> &str {
        core::str::from_utf8(&self.buf[..self.len]).unwrap_or("")
    }

    fn clear(&mut self) {
        self.len = 0;
        self.cur = 0;
    }

    fn set(&mut self, s: &str) {
        self.clear();
        for b in s.bytes().take(MAX_LINE) {
            self.buf[self.len] = b;
            self.len += 1;
        }
        self.cur = self.len;
    }

    fn insert(&mut self, b: u8) {
        if self.len >= MAX_LINE - 1 {
            return;
        }
        // 光标在中间时整体右移
        let mut i = self.len;
        while i > self.cur {
            self.buf[i] = self.buf[i - 1];
            i -= 1;
        }
        self.buf[self.cur] = b;
        self.cur += 1;
        self.len += 1;
    }

    fn backspace(&mut self) -> bool {
        if self.cur == 0 {
            return false;
        }
        let mut i = self.cur - 1;
        while i + 1 < self.len {
            self.buf[i] = self.buf[i + 1];
            i += 1;
        }
        self.len -= 1;
        self.cur -= 1;
        true
    }

    fn delete(&mut self) -> bool {
        if self.cur >= self.len {
            return false;
        }
        let mut i = self.cur;
        while i + 1 < self.len {
            self.buf[i] = self.buf[i + 1];
            i += 1;
        }
        self.len -= 1;
        true
    }
}

pub struct Shell {
    line: Line,
    history: Vec<String>,
    /// 历史浏览位置，`None` 表示正在编辑新行
    hist_pos: Option<usize>,
    /// 退出标志：Esc 或 exit/logout/desktop 置位，让 run 返回到桌面
    quit: bool,
}

impl Shell {
    pub fn new() -> Self {
        Shell { line: Line::new(), history: Vec::new(), hist_pos: None, quit: false }
    }

    /// 主循环。正常时一直跑；Esc / exit / logout / desktop 会返回，交还桌面。
    pub fn run(&mut self) {
        self.banner();
        loop {
            self.prompt();
            let line = self.read_line();
            let trimmed = line.trim().to_string();
            if trimmed.is_empty() {
                if self.quit {
                    return;
                }
                continue;
            }
            self.remember(&trimmed);
            self.dispatch(&trimmed);
            if self.quit {
                return;
            }
        }
    }

    fn remember(&mut self, s: &str) {
        if self.history.last().map(|h| h == s).unwrap_or(false) {
            return;
        }
        if self.history.len() >= HISTORY_CAP {
            self.history.remove(0);
        }
        self.history.push(s.to_string());
    }

    // ------------------------------------------------------------ 显示

    fn banner(&self) {
        vga::write_str("\n");
        vga::set_color(CYAN, vga::BLACK);
        vga::write_str("  LumeOS 0.1-rust");
        vga::reset_color();
        vga::write_str(&format!(
            "   {} frames free   {} KB heap free\n",
            crate::memory::free_frames(),
            crate::memory::heap_free() / 1024
        ));
        // 开机致辞来自 /etc/motd，和真 Unix 一个路子
        if let Some(idx) = fs::resolve("/etc/motd") {
            if let Some(bytes) = fs::content_of(idx) {
                if let Ok(text) = core::str::from_utf8(bytes) {
                    vga::set_color(vga::DARK_GRAY, vga::BLACK);
                    for l in text.lines() {
                        vga::write_str("  ");
                        vga::write_str(l);
                        vga::write_str("\n");
                    }
                    vga::reset_color();
                }
            }
        }
        vga::write_str("\n  type ");
        vga::set_color(WHITE, vga::BLACK);
        vga::write_str("help");
        vga::reset_color();
        vga::write_str(" for the command list\n\n");
    }

    fn prompt(&self) {
        let path = fs::cwd_path();
        // 家目录缩成 ~，和所有人都认识的那个提示符一致
        let shown = match path.strip_prefix("/home/lume") {
            Some(rest) if rest.is_empty() => "~".to_string(),
            Some(rest) => format!("~{rest}"),
            None => path,
        };
        vga::set_color(vga::LIGHT_GREEN, vga::BLACK);
        vga::write_str("lume");
        vga::set_color(vga::DARK_GRAY, vga::BLACK);
        vga::write_str(":");
        vga::set_color(vga::LIGHT_BLUE, vga::BLACK);
        vga::write_str(&shown);
        vga::set_color(vga::DARK_GRAY, vga::BLACK);
        vga::write_str("$ ");
        vga::set_color(LIGHT_GRAY, vga::BLACK);
    }

    /// 从清空的行开始收键，回车时返回整行
    fn read_line(&mut self) -> String {
        self.line.clear();
        self.hist_pos = None;
        // 提示符已经画过，记下它的行列，用来做全行重画
        let (pl, pc) = vga::cursor_pos();

        loop {
            let key = interrupts::read_key_blocking();
            match key {
                Key::Char(b) => {
                    self.line.insert(b);
                    self.redraw(pl, pc);
                }
                Key::Enter => {
                    vga::write_str("\n");
                    return self.line.as_str().to_string();
                }
                Key::Backspace => {
                    if self.line.backspace() {
                        self.redraw(pl, pc);
                    }
                }
                Key::Delete => {
                    if self.line.delete() {
                        self.redraw(pl, pc);
                    }
                }
                Key::Left => {
                    if self.line.cur > 0 {
                        self.line.cur -= 1;
                        self.sync_cursor(pl, pc);
                    }
                }
                Key::Right => {
                    if self.line.cur < self.line.len {
                        self.line.cur += 1;
                        self.sync_cursor(pl, pc);
                    }
                }
                Key::Home => {
                    self.line.cur = 0;
                    self.sync_cursor(pl, pc);
                }
                Key::End => {
                    self.line.cur = self.line.len;
                    self.sync_cursor(pl, pc);
                }
                Key::Up => {
                    if self.history.is_empty() {
                        continue;
                    }
                    let next = match self.hist_pos {
                        None => self.history.len() - 1,
                        Some(0) => 0,
                        Some(i) => i - 1,
                    };
                    self.hist_pos = Some(next);
                    let s = self.history[next].clone();
                    self.line.set(&s);
                    self.redraw(pl, pc);
                }
                Key::Down => {
                    match self.hist_pos {
                        None => {}
                        Some(i) if i + 1 >= self.history.len() => {
                            self.hist_pos = None;
                            self.line.clear();
                            self.redraw(pl, pc);
                        }
                        Some(i) => {
                            self.hist_pos = Some(i + 1);
                            let s = self.history[i + 1].clone();
                            self.line.set(&s);
                            self.redraw(pl, pc);
                        }
                    }
                }
                Key::Tab => {
                    self.complete();
                    self.redraw(pl, pc);
                }
                // Esc：放弃当前行并交还桌面
                Key::Esc => {
                    self.quit = true;
                    return String::new();
                }
                // Ctrl+L 清屏、Ctrl+C 弃行、Ctrl+U 清到行首 —— 三个顺手的老习惯
                Key::Ctrl(b'l') => {
                    vga::clear();
                    self.prompt();
                    self.line.clear();
                    self.redraw(vga::cursor_pos().0, 0);
                }
                Key::Ctrl(b'c') => {
                    vga::write_str("^C\n");
                    return String::new();
                }
                Key::Ctrl(b'u') => {
                    while self.line.backspace() {}
                    self.redraw(pl, pc);
                }
                _ => {}
            }
        }
    }

    /// 全行重画：回到提示符末尾，重写缓冲区，用空格擦掉尾巴
    fn redraw(&self, prow: usize, pcol: usize) {
        // (prow, pcol) 已经是提示符之后的位置，直接当作行首锚点
        vga::set_cursor(prow, pcol);
        vga::write_str(self.line.as_str());
        // 擦尾：内容可能比上一次短
        vga::write_str("  ");
        vga::write_str("\x08\x08");
        self.sync_cursor(prow, pcol);
    }

    fn prefix_len(&self) -> usize {
        // "lume:" + 路径 + "$ " —— 路径长度得算，因为 cd 会改它
        let path = fs::cwd_path();
        let shown = match path.strip_prefix("/home/lume") {
            Some(rest) if rest.is_empty() => "~".to_string(),
            Some(rest) => format!("~{rest}"),
            None => path,
        };
        5 + shown.len() + 2
    }

    /// 把块状光标挪到逻辑光标处（行首锚点 + 行内偏移）
    fn sync_cursor(&self, prow: usize, pcol: usize) {
        let abs = pcol + self.line.cur;
        let (mut r, mut c) = (prow, abs);
        while c >= vga::WIDTH {
            c -= vga::WIDTH;
            r += 1;
        }
        vga::set_cursor(r.min(vga::HEIGHT - 1), c);
    }

    /// Tab 补全：唯一匹配直接补完，多个匹配列出候选
    fn complete(&mut self) {
        let text = self.line.as_str().to_string();
        let (head, frag) = match text.rfind(' ') {
            Some(i) => (&text[..=i], &text[i + 1..]),
            None => ("", text.as_str()),
        };
        // 片段里带路径时，只补最后一段
        let (dir_part, stem) = match frag.rfind('/') {
            Some(i) => (&frag[..=i], &frag[i + 1..]),
            None => ("", frag),
        };
        let dir_idx = if dir_part.is_empty() {
            fs::cwd_index()
        } else {
            match fs::resolve(dir_part) {
                Some(i) => i,
                None => return,
            }
        };
        let mut hits: Vec<(String, bool)> = fs::list(dir_idx)
            .into_iter()
            .filter(|(n, _, _)| n.starts_with(stem))
            .map(|(n, d, _)| (n, d))
            .collect();
        match hits.len() {
            0 => {}
            1 => {
                let (name, is_dir) = hits.remove(0);
                let mut done = format!("{head}{dir_part}{name}");
                if is_dir {
                    done.push('/');
                }
                self.line.set(&done);
            }
            _ => {
                vga::write_str("\n");
                for (n, d) in hits.iter() {
                    vga::set_color(if *d { vga::LIGHT_BLUE } else { LIGHT_GRAY }, vga::BLACK);
                    vga::write_str(n);
                    if *d {
                        vga::write_str("/");
                    }
                    vga::write_str("  ");
                }
                vga::reset_color();
                vga::write_str("\n");
                // 重画提示符和已输入内容
                self.prompt();
                vga::write_str(self.line.as_str());
            }
        }
    }

    // ------------------------------------------------------------ 命令

    fn dispatch(&mut self, line: &str) {
        let mut parts = line.split_whitespace();
        let cmd = parts.next().unwrap_or("");
        let args: Vec<&str> = parts.collect();
        let arg = args.first().copied().unwrap_or("");

        match cmd {
            "help" => self.cmd_help(),
            "ls" => self.cmd_ls(arg),
            "cd" => self.cmd_cd(arg),
            "pwd" => vga::write_str(&format!("{}\n", fs::cwd_path())),
            "cat" => self.cmd_cat(arg),
            "echo" => self.cmd_echo(&args),
            "write" => self.cmd_write(&args),
            "touch" => self.cmd_touch(arg),
            "mkdir" => self.cmd_mkdir(arg),
            "rm" => self.cmd_rm(arg),
            "tree" => self.cmd_tree(),
            "df" => self.cmd_df(),
            "free" => self.cmd_free(),
            "uptime" => self.cmd_uptime(),
            "neofetch" => self.cmd_neofetch(),
            "clear" => {
                vga::clear();
            }
            "reboot" => self.cmd_reboot(),
            "halt" => self.cmd_halt(),
            "exit" | "logout" | "desktop" => {
                self.quit = true;
            }
            "crash" => crate::interrupts::trigger_breakpoint(),
            // 调试用：把显存前 n 个字符打到串口，确认 VGA 写入真的落到了 0xB8000
            "vga" => {
                // 把整屏字符层抄到串口，确认 framebuffer 渲染真的出字了
                crate::serial::write_str("\n--- screen (framebuffer text) ---\n");
                let rows = crate::vga::rows();
                let cols = crate::vga::cols();
                let mut buf = alloc::vec::Vec::with_capacity(cols);
                for r in 0..rows {
                    buf.clear();
                    for c in 0..cols {
                        let ch = crate::vga::read_char(r, c);
                        buf.push(if (0x20..0x7F).contains(&ch) { ch } else { b'.' });
                    }
                    while buf.last() == Some(&b'.') {
                        buf.pop();
                    }
                    if let Ok(s) = core::str::from_utf8(&buf) {
                        crate::serial::write_str(s);
                        crate::serial::write_str("\n");
                    }
                }
                crate::serial::write_str("--- END ---\n");
            }
            other => {
                vga::set_color(vga::LIGHT_RED, vga::BLACK);
                vga::write_str(other);
                vga::reset_color();
                vga::write_str(": command not found. try `help`\n");
            }
        }
        vga::reset_color();
    }

    fn cmd_help(&self) {
        const ROWS: &[(&str, &str)] = &[
            ("help", "this list"),
            ("ls [path]", "list a directory"),
            ("cd <path>", "change directory, `cd` goes home"),
            ("pwd", "print working directory"),
            ("cat <file>", "print a file"),
            ("echo <text>", "print text"),
            ("write <file> <text>", "create or overwrite a file"),
            ("touch <file>", "create an empty file"),
            ("mkdir <dir>", "create a directory"),
            ("rm <path>", "remove a file, or a directory and everything in it"),
            ("tree", "everything, indented"),
            ("df", "file system usage"),
            ("free", "heap and frame allocator"),
            ("uptime", "ms since the bootloader let go"),
            ("neofetch", "the machine, tersely"),
            ("clear", "wipe the screen, or Ctrl+L"),
            ("crash", "raise a breakpoint on purpose"),
            ("reboot / halt", "leave, or stop trying"),
        ];
        for (name, desc) in ROWS {
            vga::set_color(WHITE, vga::BLACK);
            vga::write_str("  ");
            // 手动补到 20 列，比 format! 里塞一堆空格好读
            let mut w = name.len();
            vga::write_str(name);
            while w < 22 {
                vga::write_str(" ");
                w += 1;
            }
            vga::set_color(vga::DARK_GRAY, vga::BLACK);
            vga::write_str(desc);
            vga::write_str("\n");
        }
        vga::reset_color();
    }

    fn cmd_ls(&self, arg: &str) {
        let target = if arg.is_empty() { "." } else { arg };
        let idx = match fs::resolve(target) {
            Some(i) => i,
            None => return err_no_file(target),
        };
        if !fs::is_dir(idx) {
            vga::write_str(target);
            vga::write_str("\n");
            return;
        }
        let entries = fs::list(idx);
        if entries.is_empty() {
            vga::set_color(vga::DARK_GRAY, vga::BLACK);
            vga::write_str("  (empty)\n");
            vga::reset_color();
            return;
        }
        for (name, is_dir, size) in entries {
            if is_dir {
                vga::set_color(vga::LIGHT_BLUE, vga::BLACK);
                vga::write_str("  ");
                vga::write_str(&name);
                vga::write_str("/\n");
            } else {
                vga::set_color(LIGHT_GRAY, vga::BLACK);
                vga::write_str("  ");
                vga::write_str(&name);
                vga::set_color(vga::DARK_GRAY, vga::BLACK);
                // 右对齐的尺寸，粗粗模仿一下 ls -l 的那一列
                let s = format!("{}", size);
                let pad = 26usize.saturating_sub(name.len() + s.len());
                for _ in 0..pad.max(1) {
                    vga::write_str(" ");
                }
                vga::write_str(&s);
                vga::write_str(" B\n");
            }
        }
        vga::reset_color();
    }

    fn cmd_cd(&self, arg: &str) {
        let target = if arg.is_empty() || arg == "~" {
            "/home/lume"
        } else {
            arg
        };
        match fs::resolve(target) {
            Some(i) if fs::is_dir(i) => fs::set_cwd(i),
            Some(_) => {
                vga::set_color(vga::LIGHT_RED, vga::BLACK);
                vga::write_str(target);
                vga::write_str(": not a directory\n");
                vga::reset_color();
            }
            None => err_no_file(target),
        }
    }

    fn cmd_cat(&self, arg: &str) {
        if arg.is_empty() {
            vga::write_str("usage: cat <file>\n");
            return;
        }
        let idx = match fs::resolve(arg) {
            Some(i) => i,
            None => return err_no_file(arg),
        };
        if fs::is_dir(idx) {
            vga::write_str(arg);
            vga::write_str(": is a directory\n");
            return;
        }
        match fs::content_of(idx).and_then(|b| core::str::from_utf8(b).ok()) {
            Some(text) => {
                for l in text.lines() {
                    vga::write_str(l);
                    vga::write_str("\n");
                }
            }
            None => vga::write_str("(not valid utf-8)\n"),
        }
    }

    fn cmd_echo(&self, args: &[&str]) {
        let text = args.join(" ");
        vga::write_str(&text);
        vga::write_str("\n");
    }

    /// `write <file> <text...>` —— 内容里允许有空格，所以从第二个词开始整段拼回去
    fn cmd_write(&self, args: &[&str]) {
        if args.len() < 2 {
            vga::write_str("usage: write <file> <text>\n");
            return;
        }
        let path = args[0];
        let body = args[1..].join(" ");
        let now = interrupts::uptime_ms();
        // set_color 返回旧配色，别拿它当 match 的值 —— 两边分支类型要对齐成 ()
        match fs::write_file(path, body.as_bytes(), now) {
            Ok(_) => {
                vga::set_color(vga::LIGHT_GREEN, vga::BLACK);
                vga::write_str("wrote ");
                vga::write_str(&format!("{} bytes\n", body.len()));
                vga::reset_color();
            }
            Err(e) => err_msg(path, e),
        }
    }

    fn cmd_touch(&self, arg: &str) {
        if arg.is_empty() {
            vga::write_str("usage: touch <file>\n");
            return;
        }
        let now = interrupts::uptime_ms();
        // 已存在就算成功，不覆盖内容
        if fs::resolve(arg).is_some() {
            return;
        }
        match fs::write_file(arg, b"", now) {
            Ok(_) => {}
            Err(e) => err_msg(arg, e),
        }
    }

    fn cmd_mkdir(&self, arg: &str) {
        if arg.is_empty() {
            vga::write_str("usage: mkdir <dir>\n");
            return;
        }
        let now = interrupts::uptime_ms();
        match fs::mkdir(arg, now) {
            Ok(_) => {}
            Err(e) => err_msg(arg, e),
        }
    }

    fn cmd_rm(&self, arg: &str) {
        if arg.is_empty() {
            vga::write_str("usage: rm <path>\n");
            return;
        }
        match fs::remove(arg) {
            Ok(_) => {}
            Err(e) => err_msg(arg, e),
        }
    }

    fn cmd_tree(&self) {
        fn walk(idx: usize, depth: usize, budget: &mut usize) {
            if *budget == 0 {
                return;
            }
            for (name, is_dir, size) in fs::list(idx) {
                if *budget == 0 {
                    return;
                }
                *budget -= 1;
                for _ in 0..depth {
                    vga::write_str("  ");
                }
                if is_dir {
                    vga::set_color(vga::LIGHT_BLUE, vga::BLACK);
                    vga::write_str(&name);
                    vga::write_str("/\n");
                } else {
                    vga::set_color(LIGHT_GRAY, vga::BLACK);
                    vga::write_str(&name);
                    vga::set_color(vga::DARK_GRAY, vga::BLACK);
                    vga::write_str(&format!("  {size} B\n"));
                }
            }
            for (name, is_dir, _) in fs::list(idx) {
                if is_dir {
                    let _ = name;
                    if let Some(child) = fs::resolve(&format!("{}/{}", fs::display_path(idx), name)) {
                        walk(child, depth + 1, budget);
                    }
                }
            }
        }
        vga::set_color(vga::LIGHT_BLUE, vga::BLACK);
        vga::write_str("/\n");
        vga::reset_color();
        let mut budget = 200; // 防止堆里东西太多刷屏
        walk(0, 1, &mut budget);
        vga::reset_color();
    }

    fn cmd_df(&self) {
        let u = fs::usage();
        vga::write_str(&format!(
            "  {} nodes   {} dirs   {} files   {} B content\n",
            u.nodes, u.dirs, u.files, u.bytes
        ));
        vga::set_color(vga::DARK_GRAY, vga::BLACK);
        vga::write_str("  in-memory only. nothing is written to the disk you booted from.\n");
        vga::reset_color();
    }

    fn cmd_free(&self) {
        let used = crate::memory::used_frames();
        let free = crate::memory::free_frames();
        let heap_used = crate::memory::heap_used();
        let heap_free = crate::memory::heap_free();
        vga::write_str(&format!(
            "  frames  {} used  {} free  ({} MiB used, {} MiB free)\n",
            used,
            free,
            used * 4 / 1024,
            free * 4 / 1024
        ));
        vga::write_str(&format!(
            "  heap    {} KiB used  {} KiB free\n",
            heap_used / 1024,
            heap_free / 1024
        ));
    }

    fn cmd_uptime(&self) {
        let ms = interrupts::uptime_ms();
        vga::write_str(&format!(
            "  up {}m {}.{:02}s   {} ticks at {} Hz\n",
            ms / 60_000,
            (ms % 60_000) / 1000,
            (ms % 1000) / 10,
            interrupts::ticks(),
            interrupts::TICK_HZ
        ));
    }

    fn cmd_neofetch(&self) {
        let logo = [
            "    ___       ",
            "   /   \\___   ",
            "  /  o  \\  \\  ",
            "  \\_____/_  /  ",
            "        /__/   ",
            "             ",
            "             ",
            "             ",
        ];
        let ms = interrupts::uptime_ms();
        let info = [
            format!(
                "\x1b{}\x1b{}",
                "lume", "OS 0.1-rust  (x86_64 bare metal)"
            ),
            format!("kernel    no_std, no libc, {} KB", 0),
            format!("build     nightly, build-std"),
            format!("uptime    {}s", ms / 1000),
            format!("shell     built-in"),
            format!("mem       {} MiB free", crate::memory::free_frames() * 4 / 1024),
            format!("fs        {} files in {} dirs", fs::usage().files, fs::usage().dirs),
        ];
        // VGA 没有 ANSI，`.split` 里的 \x1b 只是占位，这里直接自绘
        for i in 0..logo.len().max(info.len()) {
            let left = logo.get(i).copied().unwrap_or("             ");
            vga::set_color(vga::LIGHT_CYAN, vga::BLACK);
            vga::write_str("  ");
            vga::write_str(left);
            vga::reset_color();
            if let Some(line) = info.get(i) {
                // 第一行拆成「键 + 值」两段上色
                let mut it = line.splitn(2, "     ");
                let k = it.next().unwrap_or("");
                let v = it.next().unwrap_or("");
                vga::set_color(vga::LIGHT_GREEN, vga::BLACK);
                vga::write_str(k);
                if !v.is_empty() {
                    vga::reset_color();
                    vga::write_str("  ");
                    vga::write_str(v.trim_start());
                }
            }
            vga::write_str("\n");
        }
        vga::reset_color();
    }

    fn cmd_reboot(&self) {
        vga::write_str("  rebooting...\n");
        // 等键盘控制器缓冲区空，再发 0xFE 到命令口
        unsafe {
            use x86_64::instructions::port::Port;
            let mut status: Port<u8> = Port::new(0x64);
            for _ in 0..1000 {
                if status.read() & 0x02 == 0 {
                    break;
                }
            }
            let mut cmd: Port<u8> = Port::new(0x64);
            cmd.write(0xFE);
        }
        // 万一没重启成，至少别继续跑
        loop {
            x86_64::instructions::hlt();
        }
    }

    fn cmd_halt(&self) {
        vga::set_color(YELLOW, vga::BLACK);
        vga::write_str("\n  halted. it is safe to close the window.\n");
        vga::reset_color();
        loop {
            x86_64::instructions::interrupts::disable();
            x86_64::instructions::hlt();
        }
    }
}

fn err_no_file(path: &str) {
    err_msg(path, "no such file or directory");
}

fn err_msg(path: &str, msg: &str) {
    vga::set_color(vga::LIGHT_RED, vga::BLACK);
    vga::write_str("  ");
    vga::write_str(path);
    vga::write_str(": ");
    vga::write_str(msg);
    vga::write_str("\n");
    vga::reset_color();
}
