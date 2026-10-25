/* ============================================================
   LumeFS — 一个假的、种子化的文件系统
   Terminal / Files / Editor 三个应用共享同一份数据，
   文件内容改动会写进 localStorage。
   ============================================================ */

const LumeFS = (function () {
  /* v3：hello.lume 换成可被浏览器 VM 真正跑通的版本，另加 syntax.lume */
  const KEY = 'lume.fs.v3';

  const SEED = {
    '/': { type: 'dir' },
    '/home': { type: 'dir' },
    '/home/lume': { type: 'dir' },
    '/home/lume/work': { type: 'dir' },
    '/etc': { type: 'dir' },
    '/var': { type: 'dir' },
    '/var/log': { type: 'dir' },

    '/home/lume/README.md': {
      type: 'file',
      content: `# LumeOS

A pretend operating system that lives at yangshidanny.github.io/lume-os

It boots in your browser, holds five tiny apps, and one large ambition:
to feel like a real machine for about thirty seconds.

## Philosophy

- No backend. No accounts. Nothing leaves this tab.
- Everything you type stays in localStorage and dies with the cache.
- The window manager is a few hundred lines of plain JavaScript.
- Every animation is a cubic-bezier(0.2, 0.8, 0.2, 1) away from feeling right.

## Things worth trying

1. Drag a window around by its title bar.
2. Press Cmd+K or Ctrl+K and type "term".
3. Open Terminal and run \`neofetch\`.
4. Toggle the theme from the menu bar.
5. Open work/hello.lume — .lume files get syntax colour in the editor.
6. Run it: \`cd work\`, then \`lume run hello.lume\`; \`lume build hello.lume\` writes hello.c.
7. Right-click the desktop.
`
    },

    '/home/lume/notes.txt': {
      type: 'file',
      content: `scratch pad
-----------

[x] boot sequence, 2.4s, logs scrolling in the corner
[x] terminal: real command parsing, not a fake echo
[x] traffic lights that only light up on hover
[ ] dock magnification is still a single-icon scale
[ ] window snapping to edges
[ ] ask someone whether the traffic lights look too macOS

the pointer shape switching to a bar over text took twenty minutes
and nobody will ever notice it. that is the job.
`
    },

    '/home/lume/work/hello.lume': {
      type: 'file',
      content: `// hello.lume — 这台机器就是以它命名的
// Terminal 里：cd work，然后 lume run hello.lume
// 想看生成物：lume build hello.lume，会写出 hello.c

fn sq(x: int) -> int {
    return x * x
}

fn even(x: int) -> bool {
    return x % 2 == 0
}

fn dist(ax: float, ay: float, bx: float, by: float) -> float {
    dx := ax - bx
    dy := ay - by
    return sqrt(dx * dx + dy * dy)
}

fn main() {
    name := "lume"

    // 插值里能放表达式
    say("hello, {name} — 3^2 = {sq(3)}")

    // for 走范围，0..n 左闭右开
    total: int = 0
    for i in 0..10 {
        if even(i) {
            total += sq(i)
        }
    }
    say("sum of squares of evens under 10 = {total}")

    // 数组 + 下标 + len()
    xs := [3, 1, 4, 1, 5, 9, 2, 6]
    best := xs[0]
    for i in 1..xs.len() {
        if xs[i] > best {
            best = xs[i]
        }
    }
    say("{xs.len()} numbers, max = {best}")

    say("distance = {dist(0.0, 0.0, 3.0, 4.0)}")

    // while 照常
    n := 27
    steps := 0
    while n != 1 {
        if n % 2 == 0 { n = n / 2 } else { n = 3 * n + 1 }
        steps += 1
    }
    say("collatz(27) = {steps} steps")
}
`
    },

    '/home/lume/work/syntax.lume': {
      type: 'file',
      content: `// syntax.lume — 真编译器的其余语法，浏览器 VM 只吃其中一部分
// 这个文件主要拿来看高亮；run 它会被明确拒绝

struct Point {
    x: float
    y: float

    fn len2() -> float {
        return x * x + y * y
    }
}

enum Mode {
    Fast = 0
    Safe = 10
    Cold
}

@fastmath
fn total(xs: [int], n: int) -> int {
    acc: int = 0
    par for i in 0..n {
        acc += xs[i]
    }
    return acc
}

// 管道会融合成单个 for 循环，见 src/codegen/pipe.rs
fn evens(xs: [int]) -> [int] {
    return xs |> map(sq) |> filter(even)
}

fn fib(n: int) -> int {
    if n < 2 { return n }
    return fib(n - 1) + fib(n - 2)
}
`
    },

    '/home/lume/work/site.txt': {
      type: 'file',
      content: `the personal site lives at yangshidanny.github.io
it has a starfield, a custom cursor and too many rgba() values

this OS started as a joke about how many divs a desktop needs.
the answer is 41. plus one canvas.
`
    },

    '/etc/lume.conf': {
      type: 'file',
      content: `# LumeOS runtime configuration
# this file is read-only by tradition; use Settings to change anything

[display]
theme       = dark
accent      = #33aaff
wallpaper   = stars
scale       = 1.0

[shell]
dock        = bottom
magnify     = true
terminal    = /bin/lumesh

[kernel]
name        = lume
version     = 1.0.0-nebula
arch        = x86_64
uptime      = since you opened this tab
`
    },

    '/var/log/boot.log': {
      type: 'file',
      content: `[    0.000000] LumeOS 1.0.0-nebula (lume@nebula) booting
[    0.000312] ACPI: early table checksum verification done
[    0.004178] memory: 16384MB available, 8192MB reserved for wondering
[    0.019884] lume-fs: mounting /dev/lume0 at / [rw]
[    0.041226] lume-ps2: pointer device detected, replacing with custom cursor
[    0.098441] lume-gfx: framebuffer 1920x1080, compositor started
[    0.211003] lume-net: loopback only, nothing leaves this tab
[    0.744019] lume-shell: loading 5 applications
[    1.382910] lume-shell: dock ready
[    2.401233] systemd-lite: reached target desktop.target
`
    }
  };

  const data = {};
  for (const key of Object.keys(SEED)) data[key] = Object.assign({}, SEED[key]);

  // 恢复上次编辑过的文件内容
  try {
    const saved = JSON.parse(localStorage.getItem(KEY) || '{}');
    for (const path of Object.keys(saved)) {
      if (data[path] && data[path].type === 'file') data[path].content = saved[path];
    }
  } catch (e) {}

  function save() {
    try {
      const out = {};
      for (const path of Object.keys(data)) {
        if (data[path].type === 'file') out[path] = data[path].content;
      }
      localStorage.setItem(KEY, JSON.stringify(out));
    } catch (e) {}
  }

  function norm(path) {
    if (!path) return '/';
    let p = String(path).trim();
    if (!p.startsWith('/')) p = '/' + p;
    const parts = [];
    for (const seg of p.split('/')) {
      if (!seg || seg === '.') continue;
      if (seg === '..') parts.pop();
      else parts.push(seg);
    }
    return '/' + parts.join('/');
  }

  function parentOf(path) {
    const p = norm(path);
    if (p === '/') return null;
    const i = p.lastIndexOf('/');
    return i <= 0 ? '/' : p.slice(0, i);
  }

  function baseOf(path) {
    const p = norm(path);
    if (p === '/') return '/';
    return p.slice(p.lastIndexOf('/') + 1);
  }

  /** 解析 cwd + 目标路径，支持 . .. ~ */
  function resolve(cwd, target) {
    let t = (target || '').trim();
    if (t === '~') return '/home/lume';
    if (t.startsWith('~/')) t = '/home/lume/' + t.slice(2);
    if (t.startsWith('/')) return norm(t);
    if (!t) return norm(cwd);
    return norm(norm(cwd) + '/' + t);
  }

  function exists(path) {
    return Object.prototype.hasOwnProperty.call(data, norm(path));
  }

  function isDir(path) {
    const n = data[norm(path)];
    return !!n && n.type === 'dir';
  }

  function list(path) {
    const dir = norm(path);
    return Object.keys(data)
      .filter((k) => k !== '/' && parentOf(k) === dir)
      .map((k) => ({ path: k, name: baseOf(k), type: data[k].type }))
      .sort((a, b) => {
        if (a.type !== b.type) return a.type === 'dir' ? -1 : 1;
        return a.name.localeCompare(b.name);
      });
  }

  function read(path) {
    const n = data[norm(path)];
    return n && n.type === 'file' ? n.content : null;
  }

  function write(path, content) {
    const n = norm(path);
    if (data[n] && data[n].type === 'dir') return false;
    if (!data[n]) {
      const parent = parentOf(n);
      if (!parent || !data[parent] || data[parent].type !== 'dir') return false;
      data[n] = { type: 'file', content: '' };
    }
    data[n].content = String(content);
    save();
    window.dispatchEvent(new CustomEvent('lume:fs', { detail: { path: n } }));
    return true;
  }

  function size(path) {
    const c = read(path);
    if (c == null) return 0;
    return new Blob([c]).size;
  }

  return { norm, parentOf, baseOf, resolve, exists, isDir, list, read, write, size, HOME: '/home/lume' };
})();
