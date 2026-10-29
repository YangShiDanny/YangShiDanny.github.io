/* ============================================================
   应用定义：Terminal / Files / Editor / Settings / About
   每个应用提供 mount(body, win) —— 由窗口管理器调用。
   ============================================================ */

const esc = (s) =>
  String(s).replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));

const pad = (s, n) => String(s) + ' '.repeat(Math.max(0, n - String(s).length));
const fmtSize = (n) => (n < 1024 ? n + ' B' : (n / 1024).toFixed(1) + ' K');

/* 中文/全角字符在等宽字体里占两格，而 pad() 是按 JS 字符数算的，
   所以纯空格对齐一到中文就歪。这里按"显示宽度"算：
   全角（CJK、全角标点等）记 2，其余记 1。 */
const dispWidth = (s) =>
  Array.from(String(s)).reduce((w, ch) => {
    const cp = ch.codePointAt(0);
    /* 常用全角区间：CJK 统一表意、扩展 A、兼容表意、全角标点/字母、假名、谚文 */
    const wide =
      (cp >= 0x1100 && cp <= 0x115f) ||
      (cp >= 0x2e80 && cp <= 0x303e) ||
      (cp >= 0x3041 && cp <= 0x33ff) ||
      (cp >= 0x3400 && cp <= 0x4dbf) ||
      (cp >= 0x4e00 && cp <= 0x9fff) ||
      (cp >= 0xa000 && cp <= 0xa4cf) ||
      (cp >= 0xac00 && cp <= 0xd7a3) ||
      (cp >= 0xf900 && cp <= 0xfaff) ||
      (cp >= 0xfe30 && cp <= 0xfe6f) ||
      (cp >= 0xff00 && cp <= 0xff60) ||
      (cp >= 0xffe0 && cp <= 0xffe6);
    return w + (wide ? 2 : 1);
  }, 0);

/* 按显示宽度补空格，给终端里需要成列的输出用 */
const padW = (s, n) => {
  const str = String(s);
  return str + ' '.repeat(Math.max(0, n - dispWidth(str)));
};

/* ---------------------------------------------------------- */
/*  Python runtime (Pyodide)                                   */
/* ---------------------------------------------------------- */
/* 包来自 Pyodide 官方 release，不重新打包、不改内容。
   pyodide-core 是"刚好能启动"的最小集：CPython + 标准库编到 WASM，
   不含 numpy/pandas 那些预编译 wheel（那些是 pyodide-*.tar.bz2 里另外的部分）。
   README 里有对他们的致谢。 */
const PYODIDE = {
  version: '314.0.7',
  bytes: 6757104,
  direct:
    'https://github.com/pyodide/pyodide/releases/download/314.0.7/pyodide-core-314.0.7.tar.bz2',
  get sources() {
    /* 两个镜像 + 直连。公共代理经常挂，多一条路就多一分成功率；
       反正探测是并行的，多一个候选不多等。 */
    return [
      { id: 'gh-proxy', label: 'gh-proxy.com', url: 'https://gh-proxy.com/' + this.direct },
      { id: 'gh-dpik', label: 'gh.dpik.top', url: 'https://gh.dpik.top/' + this.direct },
      { id: 'direct', label: 'GitHub', url: this.direct }
    ];
  }
};

/* ---------------------------------------------------------- */
/*  Terminal                                                   */
/* ---------------------------------------------------------- */
const TerminalApp = {
  id: 'terminal',
  name: 'Terminal',
  icon: 'terminal',
  width: 700,
  height: 420,

  mount(body, win, opts = {}) {
    body.innerHTML = `
      <div class="term">
        <div class="term-out" tabindex="-1"></div>
        <form class="term-form" autocomplete="off">
          <span class="term-ps"><span class="u">lume</span>@lumeos <span class="path">~</span> %</span>
          <input class="term-input" type="text" spellcheck="false" autocapitalize="off" aria-label="Terminal input" />
        </form>
      </div>`;

    const out = body.querySelector('.term-out');
    const form = body.querySelector('.term-form');
    const input = body.querySelector('.term-input');
    const psPath = body.querySelector('.term-ps .path');

    /* 右键「Open Terminal Here」传进来的目录；不存在就退回 ~ */
    let cwd = opts.cwd && LumeFS.isDir(opts.cwd) ? LumeFS.norm(opts.cwd) : LumeFS.HOME;
    const history = [];
    let histIdx = 0;
    /* py setup 正在下载时置位，防止用户连按回车开好几个 6.4MB 的请求 */
    const state = { pyBusy: false };

    /* 终端动画（cmatrix / sl）同一时刻只允许一个，下一条命令进来就停掉。 */
    let live = null;
    const stopLive = () => {
      if (live) {
        try { live.stop(); } catch (e) { /* noop */ }
        if (live.el && live.el.parentNode) live.el.parentNode.removeChild(live.el);
        live = null;
      }
    };

    const promptPath = () => {
      if (cwd === LumeFS.HOME) return '~';
      if (cwd.startsWith(LumeFS.HOME + '/')) return '~' + cwd.slice(LumeFS.HOME.length);
      return cwd;
    };

    const syncPrompt = () => {
      psPath.textContent = promptPath();
    };

    /* openApp 复用同一个 key 的窗口时会调这个，把新目录喂进来 */
    if (win) {
      win.navigate = (p) => {
        const dest = LumeFS.norm(p);
        if (!LumeFS.isDir(dest) || dest === cwd) return;
        cwd = dest;
        syncPrompt();
        print(`<span class="dim">→ ${esc(promptPath())}</span>`);
      };
    }

    const scroll = () => {
      out.scrollTop = out.scrollHeight;
    };

    const print = (html = '') => {
      const div = document.createElement('div');
      div.className = 'term-line';
      div.innerHTML = html;
      out.appendChild(div);
      scroll();
    };

    const printDim = (text) => print(`<span class="dim">${esc(text)}</span>`);

    /* 打断正在跑的 python。前面说过 Python 跑在 worker 里，所以这里
       唯一的真手段就是杀掉 worker —— 死循环也停得掉，代价是那次的
       全局变量全丢（终端里会明说）。见 lume-py.js。 */
    const stopPython = () => {
      if (!state.pyBusy) {
        printDim('python: nothing is running');
        return false;
      }
      print('<span class="dim">^C</span>');
      const stopped = window.LumePy ? window.LumePy.interrupt() : false;
      printDim(
        stopped
          ? 'KeyboardInterrupt · runtime killed, it restarts on the next run'
          : 'python: nothing to interrupt'
      );
      state.pyBusy = false;
      return stopped;
    };

    const greet = () => {
      printDim('LumeOS 1.0.0-nebula  ·  tty1  ·  ' + new Date().toLocaleString());
      print('');
      print('Type <span class="u">help</span> to see what this machine can do.');
      print('');
    };

    const COMMANDS = {
      help() {
        const rows = [
          ['help', 'this list'],
          ['ls [path]', 'list a directory'],
          ['cd <path>', 'change directory'],
          ['cat <file>', 'print a file'],
          ['write <file> [text]', 'create or overwrite a file'],
          ['edit <file>', 'open a file in the editor'],
          ['pwd', 'print working directory'],
          ['open <app|url>', 'launch an app, or open a URL in the built-in browser'],
          ['lume <run|build> <file>', 'compile a .lume file in the browser'],
          ['py <setup|run|status>', 'install the Python runtime locally'],
          ['git <init|status|commit>', 'a real git, running inside this tab'],
          ['curl <url>', 'GET a URL (CORS-limited)'],
          ['wget <url> [-O file]', 'download a URL into LumeFS'],
          ['cmatrix', 'the matrix has you'],
          ['sl', 'a little train zooms by'],
          ['fortune', 'random words of wisdom'],
          ['cowsay <text>', 'an opinionated cow'],
          ['stop', 'kill a running python program (or Ctrl+C)'],
          ['neofetch', 'system information'],
          ['theme <dark|light>', 'switch appearance'],
          ['wall <stars|grid|plain>', 'change wallpaper'],
          ['accent <#hex>', 'set the accent color'],
          ['date', 'current time'],
          ['uptime', 'how long this tab has been alive'],
          ['history', 'recent commands'],
          ['clear', 'clear the screen'],
          ['banner', 'print the logo'],
          ['shutdown', 'power off (click anywhere to quit)'],
          ['exit', 'close this window']
        ];
        printDim('available commands');
        /* 用按显示宽度补的 padW：描述里带中文时也不会把整列顶歪。
           列宽 26 是按最长那条（lume <run|build> <file>，23 格）留出的余量。 */
        rows.forEach(([cmd, desc]) =>
          print(`  <span class="u">${esc(padW(cmd, 26))}</span><span class="dim">${esc(desc)}</span>`)
        );
        print('');
      },

      pwd() {
        print(cwd);
      },

      ls(args) {
        const target = args[0] ? LumeFS.resolve(cwd, args[0]) : cwd;
        if (!LumeFS.isDir(target)) {
          printDim(`ls: ${args[0] || target}: no such directory`);
          return;
        }
        const items = LumeFS.list(target);
        if (!items.length) {
          printDim('(empty)');
          return;
        }
        print(
          items
            .map((i) => (i.type === 'dir' ? `<span class="u">${esc(i.name)}/</span>` : esc(i.name)))
            .join('   ')
        );
      },

      cd(args) {
        const target = args[0] ? LumeFS.resolve(cwd, args[0]) : LumeFS.HOME;
        if (!LumeFS.isDir(target)) {
          printDim(`cd: ${args[0] || target}: no such directory`);
          return;
        }
        cwd = target;
        syncPrompt();
      },

      cat(args) {
        if (!args[0]) {
          printDim('usage: cat <file>');
          return;
        }
        const target = LumeFS.resolve(cwd, args[0]);
        const content = LumeFS.read(target);
        if (content == null) {
          printDim(`cat: ${args[0]}: no such file`);
          return;
        }
        print(esc(content));
      },

      /* 终端里没有编辑器，所以给一条能「直接造一个文件」的路。
         没有它，py 的提示（写到 work/hello.py）就落不了地：
         用户手上根本没有造 .py 文件的手段。 */
      write(args) {
        if (!args[0]) {
          printDim('usage: write <file> [text…]   e.g. write work/hello.py "print(1+1)"');
          return;
        }
        const target = LumeFS.resolve(cwd, args[0]);
        const body = args.slice(1).join(' ');

        /* 父目录不在就一级级建出来 —— 和 `mkdir -p` 一样，
           否则 write work/sub/a.py 会因为 work/sub 不存在而静默失败 */
        const segs = target.split('/').filter(Boolean);
        let walk = '';
        for (let i = 0; i < segs.length - 1; i++) {
          walk += '/' + segs[i];
          if (!LumeFS.isDir(walk) && !LumeFS.mkdir(walk)) {
            print(`<span class="err">write: cannot create ${esc(walk)}</span>`);
            return;
          }
        }

        if (LumeFS.isDir(target)) {
          print(`<span class="err">write: ${esc(target)} is a directory</span>`);
          return;
        }
        if (!LumeFS.write(target, body)) {
          print(`<span class="err">write: ${esc(target)}: cannot write</span>`);
          return;
        }
        printDim(`wrote ${target}  ·  ${body.length} chars`);
      },

      /* 打开编辑器改文件；文件不存在就先建一个空的 */
      edit(args) {
        if (!args[0]) {
          printDim('usage: edit <file>');
          return;
        }
        const target = LumeFS.resolve(cwd, args[0]);
        if (!LumeFS.exists(target)) {
          const segs = target.split('/').filter(Boolean);
          let walk = '';
          for (let i = 0; i < segs.length - 1; i++) {
            walk += '/' + segs[i];
            if (!LumeFS.isDir(walk)) LumeFS.mkdir(walk);
          }
          LumeFS.write(target, '');
        }
        window.LumeOS.openApp('editor', { path: target });
        printDim(`editing ${target}`);
      },

      lume(args) {
        const sub = (args[0] || '').toLowerCase();

        if (!sub || sub === 'help' || sub === '--help' || sub === '-h') {
          printDim(`lume ${window.LumeVM ? LumeVM.version : '0.2.0'}  ·  in-browser subset`);
          print('');
          print(`  <span class="u">${esc(padW('lume run <file>', 22))}</span><span class="dim">解释执行，打印 say 的输出</span>`);
          print(`  <span class="u">${esc(padW('lume build <file>', 22))}</span><span class="dim">生成 &lt;stem&gt;.c 写进工作目录</span>`);
          print(`  <span class="u">${esc(padW('lume help', 22))}</span><span class="dim">this list</span>`);
          print('');
          printDim('浏览器里没有 clang，run 走的是同一棵 AST 的求值器；');
          printDim('要真的编译成可执行文件，用仓库里的 cargo：');
          print(`  <span class="u">cargo run -- run  main.lume</span>`);
          print(`  <span class="u">cargo run -- build main.lume</span>`);
          print('');
          return;
        }

        if (!window.LumeVM) {
          printDim('lume: vm module not loaded');
          return;
        }

        const file = args[1];
        if (!file) {
          printDim(`usage: lume ${sub} <file.lume>`);
          return;
        }

        const target = LumeFS.resolve(cwd, file);
        const src = LumeFS.read(target);
        if (src == null) {
          printDim(`lume: ${file}: no such file`);
          return;
        }

        const base = LumeFS.baseOf(target);

        if (sub === 'run') {
          const t0 = performance.now();
          const res = LumeVM.run(src, { name: base });
          const ms = performance.now() - t0;

          if (!res.ok) {
            print(`<span class="err">${esc(res.message)}</span>`);
            return;
          }

          print(
            `<span class="dim">lex</span> ${res.tokens} tokens   ` +
              `<span class="dim">parse</span> ${res.fns} fn   ` +
              `<span class="dim">vm</span> ${ms.toFixed(1)} ms`
          );
          print('');
          res.output.forEach((line) => print(line ? esc(line) : '&nbsp;'));
          print('');
          return;
        }

        if (sub === 'build') {
          const res = LumeVM.build(src, { name: base });
          if (!res.ok) {
            print(`<span class="err">${esc(res.message)}</span>`);
            return;
          }
          const outPath = target.replace(/\.lume$/i, '.c');
          const wrote = LumeFS.write(outPath, res.c);
          print(
            `<span class="dim">lex</span> ${res.tokens} tokens   ` +
              `<span class="dim">parse</span> ${res.fns} fn   ` +
              `<span class="dim">codegen</span> ${res.lines} lines`
          );
          if (wrote) {
            print(`<span class="dim">wrote</span> ${esc(outPath)}`);
            printDim(`看它：Files 里打开 ${LumeFS.baseOf(outPath)}，或 cat ${LumeFS.baseOf(outPath)}`);
          } else {
            printDim('写文件失败');
          }
          print('');
          return;
        }

        printDim(`lume: unknown subcommand '${sub}' — try: lume help`);
      },

      open(args) {
        const name = (args[0] || '').toLowerCase();
        const app = Object.keys(APPS).find((k) => k === name || APPS[k].name.toLowerCase() === name);
        if (!app) {
          /* "open example.com" —— 看着像地址就直接丢给浏览器，
             省得用户先开浏览器再敲一遍 */
          const raw = args.join(' ');
          if (raw && /[./:]/.test(raw) && APPS.browser) {
            window.LumeOS.openApp('browser', { url: raw, forceNew: true });
            printDim(`opening ${raw}…`);
            return;
          }
          printDim(`open: unknown app '${name}'. try: ${Object.keys(APPS).join(', ')}`);
          return;
        }
        window.LumeOS.openApp(app);
        printDim(`launching ${APPS[app].name}…`);
      },

      /* ---------- py：把 Python 运行时装进浏览器本地 ----------
         「装」的实质就是下回来存进 IndexedDB。包不是我们的，
         是 Pyodide 官方 release 里的 pyodide-core（CPython + 标准库，
         经 Emscripten 编到 WASM）。这里只负责搬运和记录版本，
         不修改、不重新打包，README 里有对他们的致谢。

         直连和镜像都给：GitHub releases 在大陆经常挂住，
         gh-proxy 是同一个文件的公共代理，可用性高得多。 */
      py(args) {
        const sub = (args[0] || '').toLowerCase();
        const PY = PYODIDE;
        const KEY = 'pyodide-core';

        const human = (n) =>
          n >= 1048576 ? (n / 1048576).toFixed(1) + ' MB' : (n / 1024).toFixed(0) + ' KB';

        const usage = () => {
          print(`<span class="dim">LumeOS python runtime</span>  ·  Pyodide ${PY.version}`);
          print('');
          print(`  <span class="u">${esc(padW('py setup', 22))}</span><span class="dim">下载并装进浏览器本地</span>`);
          print(`  <span class="u">${esc(padW('py status', 22))}</span><span class="dim">看装没装、占多少空间</span>`);
          print(`  <span class="u">${esc(padW('py run <file.py>', 22))}</span><span class="dim">跑一个 .py 文件</span>`);
          print(`  <span class="u">${esc(padW('py remove', 22))}</span><span class="dim">删掉本地运行时</span>`);
          print('');
          printDim(`包大小约 ${human(PY.bytes)}，只需装一次，之后离线可用。`);
          /* localhost 上如果放了 vendor 目录，连这一步都能省 */
          if (window.LumePy && window.LumePy.local) {
            printDim('localhost：优先吃 vendor/pyodide 里的文件，不用 setup。');
          }
          printDim('跑的时候按 Ctrl+C 打断（触屏上敲 stop）。');
          print('');
        };

        /* localhost + vendor 目录：py run 根本不用 IndexedDB 里的包。
           说清楚，免得用户以为非得先 setup 一遍。 */
        const noteLocal = () => {
          if (!window.LumePy || !window.LumePy.local) return;
          window.LumePy.probeVendor().then((v) => {
            if (!v) return;
            print(
              `<span class="dim">dev      </span>localhost → vendor/pyodide ` +
              `<span class="dim">(${esc(String(v.version || '?'))}, no download)</span>`
            );
          });
        };

        if (!sub || sub === 'help' || sub === '--help' || sub === '-h') {
          usage();
          return;
        }

        if (sub === 'status') {
          if (!window.LumeStore) {
            print(`<span class="err">py: storage module not loaded</span>`);
            return;
          }
          window.LumeStore.get(KEY).then((rec) => {
            if (!rec) {
              printDim('python runtime  not installed');
              printDim(`run <span class="u">py setup</span> to fetch it (${human(PY.bytes)})`);
              noteLocal();
              return;
            }
            const m = rec.meta || {};
            const d = rec.at ? new Date(rec.at).toLocaleString() : '?';
            print(`<span class="dim">version  </span>Pyodide ${esc(m.version || PY.version)}`);
            print(`<span class="dim">size     </span>${human(m.size || PY.bytes)}`);
            print(`<span class="dim">source   </span>${esc(m.url || PY.direct)}`);
            print(`<span class="dim">stored   </span>${esc(d)}`);
            if (m.mirrored) printDim('(fetched through ' + (m.via || 'a proxy') + ')');
            noteLocal();
            print('');
            window.LumeStore.estimate().then((est) => {
              if (est && est.usage != null) {
                printDim(`origin usage  ${human(est.usage)}` + (est.quota ? ` / ${human(est.quota)} available` : ''));
              }
            });
          });
          return;
        }

        if (sub === 'remove') {
          if (!window.LumeStore) {
            print(`<span class="err">py: storage module not loaded</span>`);
            return;
          }
          window.LumeStore.del(KEY).then(() => printDim('python runtime removed'));
          return;
        }

        if (sub === 'setup' || sub === 'install') {
          if (!window.LumeStore) {
            print(`<span class="err">py: storage module not loaded</span>`);
            return;
          }
          if (state.pyBusy) {
            printDim('py: already downloading, hang on…');
            return;
          }

          /* 已经装过就别重复下 6.4MB，除非加 --force */
          const force = args.includes('--force') || args.includes('-f');
          window.LumeStore.get(KEY).then((rec) => {
            if (rec && !force) {
              printDim(`already installed (Pyodide ${(rec.meta || {}).version || PY.version})`);
              printDim('use <span class="u">py setup --force</span> to re-download');
              return;
            }
            download();
          });

          function download() {
            state.pyBusy = true;
            /* 先量一下每条路谁快，省得盲选。
               只发 Range 取 64KB，量的是「连接 + 首字节 + 一小段吞吐」，
               不真拉 6.4MB。首字节快但吞吐烂的源（常见于受限代理）
               会被这一步直接排到后面。 */
            printDim(`probing sources (${PY.sources.length})…`);
            const measure = (s) => {
              const t0 = performance.now();
              return fetch(s.url, { headers: { Range: 'bytes=0-65535' }, cache: 'no-store' })
                .then((r) => {
                  const ttfb = performance.now() - t0;
                  if (!r.ok && r.status !== 206) throw new Error(String(r.status));
                  /* 有 body 就读一小段，拿真实吞吐；没有就当它只支持 HEAD */
                  if (!r.body) return { s, ttfb, kbps: 0, ok: true };
                  const reader = r.body.getReader();
                  let got = 0;
                  const t1 = performance.now();
                  return reader
                    .read()
                    .then(({ value, done }) => {
                      got = done ? 0 : (value || []).length;
                      const dt = Math.max(1, performance.now() - t1);
                      try {
                        reader.cancel();
                      } catch (e) {}
                      return { s, ttfb, kbps: (got / 1024 / dt) * 1000, ok: true };
                    })
                    .catch(() => ({ s, ttfb, kbps: 0, ok: true }));
                })
                .catch(() => ({ s, ttfb: Infinity, kbps: 0, ok: false }));
            };

            const probes = PY.sources.map(measure);

            Promise.all(probes)
              .then((res) => {
                /* 排序：先看连通，再按 ttfb + 吞吐折算的综合分。
                   吞吐折算成「拉完整个包要多久」，和 ttfb 同一量纲才好比。 */
                const score = (r) => {
                  if (!r.ok) return Infinity;
                  const fullSec = r.kbps > 0 ? PY.bytes / 1024 / r.kbps : 0;
                  return r.ttfb + fullSec * 1000 * 0.6;
                };
                const ranked = res.slice().sort((a, b) => score(a) - score(b));
                const alive = ranked.filter((r) => r.ok).map((r) => r.s);
                const dead = PY.sources.filter((s) => !alive.includes(s));
                const order = alive.concat(dead);

                /* 把测速结果打出来：用户知道为什么选这条，
                   下次网变了也能自己换 */
                ranked.forEach((r) => {
                  const mark = r.s === order[0] ? ' <span class="u">← fastest</span>' : '';
                  const line = r.ok
                    ? `${String(Math.round(r.ttfb)).padStart(5)} ms  ${r.kbps > 0 ? (r.kbps / 1024).toFixed(1) + ' MB/s' : '   n/a  '}`
                    : '<span class="err">unreachable</span>';
                  print(`<span class="dim">  ${esc(padW(r.s.label, 14))}</span>${line}${mark}`);
                });

                if (!alive.length) {
                  print(`<span class="err">py: every source is unreachable</span>`);
                  state.pyBusy = false;
                  return null;
                }

                const pick = order[0];
                print('');
                print(`<span class="dim">fetching</span> ${human(PY.bytes)} via ${esc(pick.label)}`);
                printDim('(first setup only — it stays in this browser)');
                return tryFetch(order, 0);
              })
              .then((r) => {
                if (!r) {
                  print(`<span class="err">py: download failed on every source</span>`);
                  printDim('check your connection, or try again later');
                  state.pyBusy = false;
                  return;
                }
                return window.LumeStore.put(
                  KEY,
                  r.blob,
                  { version: PY.version, size: r.blob.size, url: r.url, mirrored: r.mirrored, via: r.via }
                ).then(() => {
                  print('');
                  print(`<span class="u">installed</span>  Pyodide ${esc(PY.version)}  ·  ${human(r.blob.size)}`);
                  printDim('stored in this browser — offline from now on');
                  print('');
                  /* 这行走 print 不是 printDim：里面有 .u 标记。
                     printDim 会把它整段 esc 掉，屏幕上就露出 <span> 字样。 */
                  print(
                    `<span class="dim">try it —</span> ` +
                      `<span class="u">write work/hello.py "print('hello from python')"</span>` +
                      `<span class="dim"> then </span>` +
                      `<span class="u">py run work/hello.py</span>`
                  );
                  state.pyBusy = false;
                });
              })
              .catch((e) => {
                print(`<span class="err">py: ${esc(e.message || String(e))}</span>`);
                state.pyBusy = false;
              });
          }

          /* 逐个源试，前一个失败就换下一个。用 XMLHttpRequest 而不是 fetch，
             因为要看下载进度——6.4MB 在慢网下能等十几秒，
             不给进度条用户会以为卡死了，然后再按一次回车又开一个下载。 */
          function tryFetch(list, i) {
            if (i >= list.length) return Promise.resolve(null);
            const src = list[i];
            return new Promise((resolve) => {
              const xhr = new XMLHttpRequest();
              xhr.open('GET', src.url, true);
              xhr.responseType = 'blob';
              let lastPct = -1;

              const bar = (pct) => {
                const w = 22;
                const filled = Math.round((pct / 100) * w);
                const line = '█'.repeat(filled) + '░'.repeat(w - filled);
                /* 就地更新同一行，别每次重绘都刷一条新输出 */
                if (!bar.el) {
                  bar.el = document.createElement('div');
                  bar.el.className = 'term-line';
                  out.appendChild(bar.el);
                }
                bar.el.innerHTML =
                  `<span class="u">${line}</span> <span class="dim">${String(pct).padStart(3)}%</span>`;
                scroll();
              };

              xhr.onprogress = (e) => {
                if (!e.lengthComputable) return;
                const pct = Math.floor((e.loaded / e.total) * 100);
                if (pct !== lastPct) {
                  lastPct = pct;
                  bar(pct);
                }
              };
              xhr.onload = () => {
                if (xhr.status >= 200 && xhr.status < 300 && xhr.response) {
                  bar(100);
                  resolve({ blob: xhr.response, url: src.url, mirrored: src.id !== 'direct', via: src.label });
                } else {
                  printDim(`${src.label}: HTTP ${xhr.status}, trying next…`);
                  resolve(tryFetch(list, i + 1));
                }
              };
              xhr.onerror = () => {
                printDim(`${src.label}: unreachable, trying next…`);
                resolve(tryFetch(list, i + 1));
              };
              xhr.ontimeout = () => {
                printDim(`${src.label}: timed out, trying next…`);
                resolve(tryFetch(list, i + 1));
              };
              xhr.timeout = 120000;
              xhr.send();
            });
          }
          return;
        }

        if (sub === 'run') {
          const file = args[1];
          if (!file) {
            print(`<span class="err">py: usage: py run &lt;file.py&gt;</span>`);
            return;
          }
          const full = LumeFS.resolve(cwd, file);
          const code = LumeFS.read(full);
          if (code == null) {
            print(`<span class="err">py: no such file: ${esc(full)}</span>`);
            printDim(`先造一个：write ${file} "print(1+1)"`);
            return;
          }
          if (!window.LumePy) {
            print(`<span class="err">py: runtime module not loaded</span>`);
            return;
          }
          if (state.pyBusy) {
            printDim('python is still busy — press ^C (or type stop) to kill it');
            return;
          }
          state.pyBusy = true;
          const t0 = performance.now();
          /* stdout/stderr 是「批处理」给的，一次可能好几行，逐行落成
             终端里的一行一句，别整段塞进一个 div */
          const dump = (text, isErr) => {
            String(text).split('\n').forEach((line, i, arr) => {
              if (i === arr.length - 1 && line === '') return;
              print(isErr ? `<span class="err">${esc(line)}</span>` : esc(line));
            });
          };
          /* 引导是异步的（解 bz2 / 拉 wasm 都要几秒），终端命令本身同步返回，
             后续输出靠回调回来即可。 */
          window.LumePy
            .run(code, {
              log: (s) => printDim(s),
              out: (s) => dump(s, false),
              err: (s) => dump(s, true)
            })
            .then((r) => {
              if (r.value) printDim('=> ' + r.value);
              const ms = r.ms != null ? r.ms : Math.round(performance.now() - t0);
              print(`<span class="u">done</span> <span class="dim">· ${ms} ms</span>`);
            })
            .catch((e) => {
              /* Ctrl+C 打断的收尾已经由 stopPython 打印过了，
                 这里再吐一遍 KeyboardInterrupt 只是噪音 */
              if (e && e.interrupted) return;
              const msg = e && e.message ? e.message : String(e);
              const lines = msg.split('\n').filter((l) => l.trim());
              /* traceback 最有用的信息在末尾，倒着最多给 12 行 */
              const tail = lines.slice(-12);
              if (lines.length > tail.length) printDim(`… ${lines.length - tail.length} more lines`);
              tail.forEach((l) => print(`<span class="err">${esc(l)}</span>`));
            })
            .finally(() => {
              state.pyBusy = false;
            });
          return;
        }

        printDim(`py: unknown subcommand '${sub}' — try: py help`);
      },

      /* ---------- git ----------
         isomorphic-git 跑在 LumeGit 里（js/lume-git.js）：
         工作区还是 LumeFS，.git 目录存 IndexedDB，所以 Files / Editor
         看到的文件是真的，git 看到的也真的是同一个文件。 */
      git(args) {
        const sub = (args[0] || '').toLowerCase();
        const G = window.LumeGit;

        const usage = () => {
          print(`<span class="dim">git</span>  ·  isomorphic-git ${G ? G.version : ''}  ·  inside this tab`);
          print('');
          [
            ['git init', '在这个目录建一个仓库'],
            ['git status', '谁改了、谁还没加进暂存区'],
            ['git add <path|.>', '加进暂存区'],
            ['git commit -m "msg"', '提交'],
            ['git log [n]', '最近的提交'],
            ['git branch [name]', '列分支 / 建分支'],
            ['git checkout <ref>', '切分支或回到某个提交'],
            ['git clone <url> [dir]', '从网上下一个仓库（走 CORS 代理）'],
            ['git remote', '看远端地址'],
            ['git push / git pull', '推上去 / 拉下来']
          ].forEach(([c, d]) => print(`  <span class="u">${esc(padW(c, 26))}</span><span class="dim">${esc(d)}</span>`));
          print('');
          printDim('仓库元数据存在 IndexedDB 里，不占 localStorage；');
          printDim('工作区文件仍然是 LumeFS，Files / Editor 里直接能改。');
          print('');
        };

        if (!G) {
          printDim('git: module not loaded');
          return;
        }
        if (!sub || sub === 'help' || sub === '--help' || sub === '-h') {
          usage();
          return;
        }

        /* 命令都是异步的，统一收口，别让一个 rejected promise 变成
           一个没人管的 console 错误 */
        const fail = (verb) => (e) => {
          const msg = (e && e.message) || String(e);
          if (e && e.code === 'ENOREPO') {
            print(`<span class="err">git ${verb}: ${esc(msg)}</span>`);
            printDim(`先来一步：git init`);
            return;
          }
          print(`<span class="err">git ${verb}: ${esc(msg)}</span>`);
        };

        /* 进度：clone / push 会走网络，不给点反馈会像卡死 */
        const progress = (() => {
          let last = '';
          return (ev) => {
            if (!ev || !ev.phase) return;
            const line = ev.phase + (ev.total ? `  ${ev.loaded}/${ev.total}` : '');
            if (line === last) return;
            last = line;
            print(`<span class="dim">${esc(line)}</span>`);
          };
        })();

        if (sub === 'init') {
          G.init(cwd)
            .then(() => {
              print(`<span class="u">Initialized</span> <span class="dim">empty git repository in</span> ${esc(cwd)}/.git`);
            })
            .catch(fail('init'));
          return;
        }

        if (sub === 'status') {
          G.status(cwd)
            .then(async (rows) => {
              const branch = (await G.currentBranch(cwd)) || 'main';
              print(`<span class="dim">On branch</span> ${esc(branch)}`);

              const staged = rows.filter((r) => r.staged);
              const unstaged = rows.filter((r) => !r.staged && !r.untracked);
              const untracked = rows.filter((r) => r.untracked);
              const label = { A: 'new file', M: 'modified', D: 'deleted' };

              if (staged.length) {
                print('');
                printDim('Changes to be committed:');
                staged.forEach((r) =>
                  print(`  <span class="u">${esc(padW(label[r.x] || 'changed', 12))}</span>${esc(r.path)}`)
                );
              }
              if (unstaged.length) {
                print('');
                printDim('Changes not staged for commit:');
                unstaged.forEach((r) =>
                  print(`  <span class="u">${esc(padW(label[r.y] || 'changed', 12))}</span>${esc(r.path)}`)
                );
              }
              if (untracked.length) {
                print('');
                printDim('Untracked files:');
                untracked.forEach((r) => print(`  <span class="dim">${esc(r.path)}</span>`));
              }
              print('');
              if (!rows.length) {
                printDim('nothing to commit, working tree clean');
              } else {
                printDim(
                  staged.length
                    ? 'ready to commit — git commit -m "…"'
                    : 'nothing staged yet — git add . first'
                );
              }
            })
            .catch(fail('status'));
          return;
        }

        if (sub === 'add') {
          const what = args.slice(1).join(' ').trim();
          if (!what) {
            printDim('usage: git add <path…|.>');
            return;
          }
          const files = what === '.' || what === '-A' || what === '--all' ? null : what.split(/\s+/);
          G.add(cwd, files)
            .then(() => printDim(files ? `added ${files.join(' ')}` : 'added everything that changed'))
            .catch(fail('add'));
          return;
        }

        if (sub === 'commit') {
          let msg = '';
          const rest = args.slice(1);
          const mi = rest.findIndex((a) => a === '-m' || a === '--message');
          if (mi >= 0) msg = rest.slice(mi + 1).join(' ');
          else msg = rest.join(' ');
          if (!msg) {
            printDim('usage: git commit -m "message"');
            return;
          }
          G.commit(cwd, msg)
            .then((sha) => {
              const head = String(sha).slice(0, 7);
              print(`<span class="u">[${esc(head)}]</span> ${esc(msg)}`);
            })
            .catch(fail('commit'));
          return;
        }

        if (sub === 'log') {
          const n = Number(args[1]) || 12;
          G.log(cwd, n)
            .then((commits) => {
              if (!commits.length) {
                printDim('no commits yet');
                return;
              }
              commits.forEach((c, i) => {
                const short = c.oid.slice(0, 7);
                const when = new Date(c.commit.author.timestamp * 1000).toLocaleString();
                const head = i === 0 ? ' <span class="u">(HEAD)</span>' : '';
                print(`<span class="u">${esc(short)}</span>${head}  ${esc(c.commit.message.split('\n')[0])}`);
                print(`          <span class="dim">${esc(c.commit.author.name)} · ${esc(when)}</span>`);
              });
            })
            .catch(fail('log'));
          return;
        }

        if (sub === 'branch') {
          const name = args[1];
          if (name) {
            G.createBranch(cwd, name, false)
              .then(() => printDim(`branch ${name} created`))
              .catch(fail('branch'));
            return;
          }
          Promise.all([G.branches(cwd), G.currentBranch(cwd)])
            .then(([list, cur]) => {
              if (!list.length) {
                printDim('no branches yet — make a commit first');
                return;
              }
              list.forEach((b) =>
                print(b === cur ? `<span class="u">* ${esc(b)}</span>` : `  ${esc(b)}`)
              );
            })
            .catch(fail('branch'));
          return;
        }

        if (sub === 'checkout') {
          const ref = args[1];
          if (!ref) {
            printDim('usage: git checkout <branch|commit>');
            return;
          }
          G.checkout(cwd, ref)
            .then(() => printDim(`switched to ${ref}`))
            .catch(fail('checkout'));
          return;
        }

        if (sub === 'clone') {
          const url = args[1];
          if (!url) {
            printDim('usage: git clone <url> [dir]');
            return;
          }
          const target = LumeFS.resolve(cwd, args[2] || url.replace(/\.git$/, '').split('/').pop() || 'repo');
          if (LumeFS.exists(target) && !LumeFS.isDir(target)) {
            print(`<span class="err">git clone: ${esc(target)} exists and is a file</span>`);
            return;
          }
          if (!LumeFS.exists(target)) LumeFS.mkdir(target);
          printDim(`cloning into ${target} …`);
          G.clone(target, url, { onProgress: progress })
            .then(() => print(`<span class="u">cloned</span> ${esc(url)} <span class="dim">→</span> ${esc(target)}`))
            .catch(fail('clone'));
          return;
        }

        if (sub === 'remote') {
          G.remotes(cwd)
            .then((list) => {
              if (!list.length) {
                printDim('no remotes — git clone adds one, or edit .git/config');
                return;
              }
              list.forEach((r) => print(`<span class="u">${esc(r.remote)}</span>  ${esc(r.url)}`));
            })
            .catch(fail('remote'));
          return;
        }

        if (sub === 'push' || sub === 'pull' || sub === 'fetch') {
          printDim(`${sub} …`);
          const opts = { onProgress: progress };
          G[sub](cwd, opts)
            .then(() => print(`<span class="u">${sub} ok</span>`))
            .catch((e) => {
              fail(sub)(e);
              if (/CORS|Failed to fetch|401|403/i.test((e && e.message) || '')) {
                printDim('远端要认证的话，public 仓库才能直接拉；私有库需要 token，');
                printDim('浏览器里还得有 CORS 代理（默认走 cors.isomorphic-git.org）。');
              }
            });
          return;
        }

        printDim(`git: unknown subcommand '${sub}' — try: git help`);
      },

      neofetch() {
        const info = window.LumeOS.systemInfo();
        const logo = [
          '    ▄▄▄▄▄▄▄▄▄    ',
          '  ▄█████████▄  ',
          ' ███▀     ▀███ ',
          ' ███   ▄▄  ███ ',
          ' ███   ▀▀  ███ ',
          ' ███▄     ▄███ ',
          '  ▀█████████▀  ',
          '    ▀▀▀▀▀▀▀▀▀   '
        ];
        /* cache 这一行是给「为什么这次打开很快」一个可见的解释：
           local = 本地同版本命中，没下东西；fetched = 刚下过并存好了；
           partial = 下了但没存成（无痕/配额满），下次还得再下 */
        const cacheText =
          info.cache === 'local' ? 'local · same build, nothing fetched'
          : info.cache === 'fetched' ? 'fetched · stored for next time'
          : info.cache === 'partial' ? 'fetched · could not store (private mode?)'
          : 'off · version.json unavailable';
        const lines = [
          '<span class="u">lume</span>@lumeos',
          '<span class="dim">-----------</span>',
          `<span class="dim">OS      </span>${esc(info.os)}`,
          `<span class="dim">Kernel  </span>${esc(info.kernel)}`,
          `<span class="dim">Shell   </span>lumesh`,
          `<span class="dim">WM      </span>lume-wm`,
          `<span class="dim">Uptime  </span>${esc(info.uptime)}`,
          `<span class="dim">Apps    </span>${info.apps}`,
          `<span class="dim">Theme   </span>${esc(info.theme)}`,
          `<span class="dim">Build   </span>${esc(info.build)}`,
          `<span class="dim">Cache   </span>${esc(cacheText)}`
        ];
        logo.forEach((row, i) => {
          print(`<span class="u">${esc(row)}</span>   ${lines[i] || ''}`);
        });
        /* logo 只有 8 行，多出来的信息接在下面，不然就丢了 */
        lines.slice(logo.length).forEach((l) => print(`                ${l}`));
        print('');
      },

      theme(args) {
        const v = (args[0] || '').toLowerCase();
        if (v !== 'dark' && v !== 'light') {
          printDim('usage: theme <dark|light>');
          return;
        }
        window.LumeOS.setTheme(v);
        printDim(`theme → ${v}`);
      },

      wall(args) {
        const v = (args[0] || '').toLowerCase();
        if (!['stars', 'grid', 'plain'].includes(v)) {
          printDim('usage: wall <stars|grid|plain>');
          return;
        }
        window.LumeOS.setWall(v);
        printDim(`wallpaper → ${v}`);
      },

      accent(args) {
        const v = args[0] || '';
        if (!/^#[0-9a-f]{6}$/i.test(v)) {
          printDim('usage: accent <#rrggbb>');
          return;
        }
        window.LumeOS.setAccent(v);
        printDim(`accent → ${v}`);
      },

      date() {
        print(new Date().toString());
      },

      uptime() {
        print('up ' + window.LumeOS.uptimeText() + ', 1 user, load average: 0.42, 0.31, 0.28');
      },

      whoami() {
        print('lume');
      },

      hostname() {
        print('lumeos');
      },

      uname() {
        print('LumeOS lumeos 1.0.0-nebula #1 SMP PREEMPT_DYNAMIC x86_64 Lume');
      },

      echo(args) {
        print(esc(args.join(' ')));
      },

      history() {
        history.forEach((h, i) => print(`  ${String(i + 1).padStart(3)}  ${esc(h)}`));
      },

      clear() {
        out.innerHTML = '';
      },

      banner() {
        const logo = [
          '██╗     ██╗   ██╗███╗   ███╗███████╗',
          '██║     ██║   ██║████╗ ████║██╔════╝',
          '██║     ██║   ██║██╔████╔██║█████╗  ',
          '██║     ██║   ██║██║╚██╔╝██║██╔══╝  ',
          '███████╗╚██████╔╝██║ ╚═╝ ██║███████╗',
          '╚══════╝ ╚═════╝ ╚═╝     ╚═╝╚══════╝'
        ];
        logo.forEach((row) => print(`<span class="u">${esc(row)}</span>`));
        print('');
        printDim('a pretend operating system. no disk, no network, no regrets.');
        print('');
      },

      sudo() {
        printDim('lume is not in the sudoers file. this incident has been reported to nobody.');
      },

      exit() {
        window.LumeOS.closeFocused();
      },

      /* ---- 网络：curl / wget（受 CORS 限制，尽量用支持 CORS 的公开 API）---- */
      curl(args) {
        const url = args[0];
        if (!url) { printDim('usage: curl <url>'); return; }
        printDim('→ ' + url);
        fetch(url, { mode: 'cors' })
          .then((r) => {
            print(`<span class="dim">HTTP ${r.status} ${esc(r.statusText || '')}</span>`);
            return r.text();
          })
          .then((txt) => {
            if (txt.length > 6000) txt = txt.slice(0, 6000) + `\n… (${(txt.length - 6000)} more bytes truncated)`;
            print(`<pre class="curl-out">${esc(txt)}</pre>`);
          })
          .catch((e) => {
            print(`<span class="err">curl: ${esc(e.message)}</span>`);
            printDim('CORS 可能拦了跨域请求；试试 httpbin.org/get 或 jsonplaceholder.typicode.com/todos/1');
          });
      },

      wget(args) {
        let url = null, out2 = null;
        for (let i = 0; i < args.length; i++) {
          if (args[i] === '-O') out2 = args[++i];
          else if (!url) url = args[i];
        }
        if (!url) { printDim('usage: wget <url> [-O file]'); return; }
        if (!out2) {
          out2 = decodeURIComponent(url.split('/').pop().split('?')[0]);
          if (!out2) out2 = 'index.html';
        }
        const dest = LumeFS.resolve(cwd, out2);
        printDim('→ ' + url + '  →  ' + LumeFS.baseOf(dest));
        fetch(url, { mode: 'cors' })
          .then((r) => r.text())
          .then((txt) => {
            const wrote = LumeFS.write(dest, txt);
            print(`<span class="dim">saved ${txt.length} bytes → ${esc(LumeFS.baseOf(dest))}${wrote ? '' : ' (write failed)'}</span>`);
          })
          .catch((e) => {
            print(`<span class="err">wget: ${esc(e.message)}</span>`);
          });
      },

      /* ---- 终端彩蛋 ---- */
      fortune() {
        const quotes = [
          'Unix is user-friendly. It just picks its friends carefully.',
          'There are 10 kinds of people: those who understand binary, and those who don’t.',
          'The best way to predict the future is to invent it.',
          'Talk is cheap. Show me the code. — Linus Torvalds',
          'First, solve the problem. Then, write the code.',
          'Premature optimization is the root of all evil. — Donald Knuth',
          'A Lume a day keeps the segfault away.',
          'Walking on water and developing software from a spec are easy if both are frozen.',
          'Have you tried turning it off and on again?'
        ];
        printDim('“' + quotes[Math.floor(Math.random() * quotes.length)] + '”');
      },

      cowsay(args) {
        const t = (args.join(' ') || 'Moo!').trim();
        const inner = ' ' + t + ' ';
        const top = ' ' + '_'.repeat(inner.length);
        const bot = ' ' + '-'.repeat(inner.length);
        const cow = [
          "        \\   ^__^",
          "         \\  (oo)\\_______",
          "            (__)\\       )\\/\\",
          "                ||----w |",
          "                ||     ||"
        ];
        print('<pre class="cow">' + esc(top) + '\n< ' + esc(t) + ' >\n' + esc(bot) +
          '\n' + cow.map(esc).join('\n') + '</pre>');
      },

      cmatrix() {
        stopLive();
        const canvas = document.createElement('canvas');
        canvas.width = Math.min(560, (out.clientWidth || 540) - 28);
        canvas.height = 240;
        canvas.style.cssText = 'display:block;background:#000;margin:8px 0;border-radius:6px;';
        out.appendChild(canvas);
        const ctx = canvas.getContext('2d');
        const fontSize = 12;
        const cols = Math.max(1, Math.floor(canvas.width / fontSize));
        const drops = new Array(cols).fill(0).map(() => Math.random() * (canvas.height / fontSize));
        const glyphs = '01アイウエオカキクケコ日月木水火土山川ABCDEFｱｲｳ0123456789';
        const id = setInterval(() => {
          ctx.fillStyle = 'rgba(0,0,0,0.09)';
          ctx.fillRect(0, 0, canvas.width, canvas.height);
          ctx.fillStyle = '#27f08a';
          ctx.font = fontSize + 'px monospace';
          for (let i = 0; i < cols; i++) {
            const ch = glyphs[Math.floor(Math.random() * glyphs.length)];
            ctx.fillText(ch, i * fontSize, drops[i] * fontSize);
            if (drops[i] * fontSize > canvas.height && Math.random() > 0.975) drops[i] = 0;
            drops[i]++;
          }
        }, 55);
        live = { el: canvas, stop: () => clearInterval(id) };
        scroll();
      },

      sl() {
        stopLive();
        const el = document.createElement('div');
        el.className = 'term-line';
        out.appendChild(el);
        const train = '  ===[o][o]==   chug-chug   🚂  ';
        const pad = 54;
        let pos = 0, loops = 0;
        const id = setInterval(() => {
          el.textContent = ' '.repeat(pos) + train;
          pos++;
          if (pos > pad) {
            pos = 0; loops++;
            if (loops >= 2) { clearInterval(id); el.textContent = ''; live = null; return; }
          }
          scroll();
        }, 70);
        live = { el, stop: () => clearInterval(id) };
      },

      /* 关机不是关窗口，是整个系统下线。
         和不带参数的 py 一样，这里也接受 --help。 */
      shutdown(args) {
        if (args && args[0] && /^--?(h|help)$/i.test(args[0])) {
          printDim('usage: shutdown  ·  关机，之后点任意处即可离开本页');
          return;
        }
        window.LumeOS.shutdown();
      }
    };

    const run = (raw) => {
      const line = raw.trim();
      stopLive();
      print(`<span class="dim">${esc(promptPath())} %</span> ${esc(line)}`);
      if (!line) return;

      history.push(line);
      histIdx = history.length;

      const parts = line.match(/(?:[^\s"]+|"[^"]*")+/g) || [];
      const cmd = parts[0].toLowerCase();
      const args = parts.slice(1).map((a) => a.replace(/^"|"$/g, ''));

      /* python 跑着的时候，敲 stop 跟按 Ctrl+C 一个效果（手机上没有
         Ctrl 键，自绘键盘也没有 —— 这条路是给触屏留的）。
         空闲时也给一句明确回应，比 command not found 像样。 */
      if (/^(stop|kill|\^c|ctrl-c)$/i.test(cmd)) {
        stopPython();
        return;
      }

      if (COMMANDS[cmd]) {
        try {
          COMMANDS[cmd](args);
        } catch (err) {
          printDim('error: ' + err.message);
        }
      } else {
        printDim(`lumesh: command not found: ${cmd}`);
        printDim("type 'help' for a list of things that do exist.");
      }
    };

    form.addEventListener('submit', (e) => {
      e.preventDefault();
      const value = input.value;
      input.value = '';
      run(value);
    });

    input.addEventListener('keydown', (e) => {
      if (e.key === 'ArrowUp') {
        e.preventDefault();
        if (histIdx > 0) {
          histIdx--;
          input.value = history[histIdx] || '';
        }
      } else if (e.key === 'ArrowDown') {
        e.preventDefault();
        if (histIdx < history.length - 1) {
          histIdx++;
          input.value = history[histIdx] || '';
        } else {
          histIdx = history.length;
          input.value = '';
        }
      } else if (e.key === 'Tab') {
        e.preventDefault();
        const tokens = input.value.split(/\s+/);
        const last = tokens[tokens.length - 1] || '';
        const slash = last.lastIndexOf('/');
        const dirPart = slash >= 0 ? last.slice(0, slash + 1) : '';
        const prefix = slash >= 0 ? last.slice(slash + 1) : last;
        const dir = LumeFS.resolve(cwd, dirPart || '.');
        const matches = LumeFS.list(dir)
          .filter((i) => i.name.startsWith(prefix))
          .map((i) => i.name + (i.type === 'dir' ? '/' : ''));
        if (matches.length === 1) {
          tokens[tokens.length - 1] = dirPart + matches[0];
          input.value = tokens.join(' ');
        } else if (matches.length > 1) {
          print(`<span class="dim">${esc(promptPath())} %</span> ${esc(input.value)}`);
          printDim(matches.join('   '));
        }
      } else if (e.key === 'l' && (e.ctrlKey || e.metaKey)) {
        e.preventDefault();
        out.innerHTML = '';
      }
    });

    body.addEventListener('keydown', (e) => {
      /* 只有 python 正在跑的时候才抢 Ctrl+C —— 空闲时它还是「复制」。
         挂在 body 上而不是输入框上：焦点跑到输出区时也能按 */
      if (!state.pyBusy) return;
      if ((e.ctrlKey || e.metaKey) && (e.key === 'c' || e.key === 'C')) {
        e.preventDefault();
        stopPython();
      }
    });

    body.addEventListener('mousedown', (e) => {
      if (window.getSelection().toString()) return;
      if (e.target.tagName !== 'INPUT') input.focus();
    });

    /* 右键：终端自己的菜单（清屏 / 复制 / 粘贴），不弹浏览器原生菜单 */
    body.addEventListener('contextmenu', (e) => {
      e.preventDefault();
      e.stopPropagation();

      const OS = window.LumeOS;
      OS.closeMenus();
      const picked = window.getSelection().toString();

      OS.popMenu(e.clientX, e.clientY, {
        title: 'Terminal',
        sub: promptPath() + ' %',
        items: [
          {
            ico: 'paste',
            label: 'Paste',
            hint: '⌘V',
            run: () => {
              input.focus();
              OS.pasteInto(input);
            }
          },
          {
            ico: 'copy',
            label: picked ? 'Copy Selection' : 'Copy',
            hint: '⌘C',
            run: () => {
              if (picked && navigator.clipboard && navigator.clipboard.writeText) {
                navigator.clipboard.writeText(picked).then(
                  () => OS.toast('Copied ' + picked.length + ' characters'),
                  () => OS.toast('Clipboard is blocked here')
                );
              } else if (!picked) {
                OS.toast('Select some output first');
              }
            }
          },
          '|',
          {
            ico: 'refresh',
            label: 'Clear Screen',
            hint: '⌃L',
            run: () => {
              out.innerHTML = '';
              input.focus();
            }
          }
        ]
      });
    });

    /* 提示符里的路径是写死在标记里的 ~，右键从别的目录进来时要刷一次 */
    syncPrompt();
    /* 从右键「Open Terminal Here」进来的窗口，标题带上目录名，
       同时开几个终端时一眼能分清谁是谁 */
    if (win && win.setTitle && cwd !== LumeFS.HOME) {
      win.setTitle('Terminal — ' + LumeFS.baseOf(cwd));
    }
    greet();
    setTimeout(() => input.focus(), 60);
  }
};

/* ---------------------------------------------------------- */
/*  Files                                                      */
/* ---------------------------------------------------------- */
const FilesApp = {
  id: 'files',
  name: 'Files',
  icon: 'files',
  width: 700,
  height: 460,
  single: true,

  mount(body, win, opts = {}) {
    const start = opts.path && LumeFS.isDir(opts.path) ? LumeFS.norm(opts.path) : LumeFS.HOME;

    /* 浏览历史：hist[hi] 是当前目录，hi 后面是可以前进的部分 */
    let hist = [start];
    let hi = 0;
    let selected = null;

    body.innerHTML = `
      <div class="files">
        <aside class="files-side">
          <p class="files-root">Places</p>
          <button class="files-nav" data-go="/home/lume">${ICON.home}<span>Home</span></button>
          <button class="files-nav" data-go="/home/lume/Desktop">${ICON.desktop}<span>Desktop</span></button>
          <button class="files-nav" data-go="/home/lume/work">${ICON.folder}<span>Work</span></button>
          <button class="files-nav" data-go="/etc">${ICON.folder}<span>System</span></button>
          <button class="files-nav" data-go="/var/log">${ICON.folder}<span>Logs</span></button>
        </aside>
        <div class="files-pane">
          <div class="files-bar">
            <button class="files-tool" type="button" data-act="back" aria-label="Back" title="Back">${ICON.back}</button>
            <button class="files-tool" type="button" data-act="fwd" aria-label="Forward" title="Forward">${ICON.forward}</button>
            <button class="files-tool" type="button" data-act="up" aria-label="Enclosing folder" title="Enclosing folder">${ICON.up}</button>
            <div class="files-crumbs" id="files-crumbs"></div>
            <button class="files-tool" type="button" data-act="new" aria-label="New item" title="New file or folder">${ICON.plus}</button>
          </div>
          <div class="files-main"></div>
        </div>
      </div>`;

    const main = body.querySelector('.files-main');
    const crumbsEl = body.querySelector('.files-crumbs');
    const navs = Array.from(body.querySelectorAll('.files-nav'));
    const backBtn = body.querySelector('[data-act="back"]');
    const fwdBtn = body.querySelector('[data-act="fwd"]');
    const upBtn = body.querySelector('[data-act="up"]');

    const cwd = () => hist[hi];

    const render = () => {
      /* 窗口已经关掉了就别再往脱离文档的节点里画 */
      if (!body.isConnected) return;

      /* 当前目录被删掉了（比如在终端里 rm -r）就退回父目录 */
      if (!LumeFS.isDir(cwd())) {
        const parent = LumeFS.parentOf(cwd());
        if (parent && LumeFS.isDir(parent)) {
          hist[hi] = parent;
        } else {
          hist = [LumeFS.HOME];
          hi = 0;
        }
      }

      const cur = cwd();
      const items = LumeFS.list(cur);

      let acc = '';
      crumbsEl.innerHTML =
        '<button class="crumb" type="button" data-go="/">lumeos</button>' +
        cur
          .split('/')
          .filter(Boolean)
          .map((part) => {
            acc += '/' + part;
            return (
              '<span class="crumb-sep">/</span>' +
              '<button class="crumb" type="button" data-go="' + esc(acc) + '">' + esc(part) + '</button>'
            );
          })
          .join('');

      main.innerHTML = items.length
        ? items
            .map(
              (i) => `
            <div class="files-row${i.path === selected ? ' active' : ''}" role="button" tabindex="0" data-path="${esc(i.path)}" data-type="${i.type}">
              ${i.type === 'dir' ? ICON.folder : ICON.file}
              <span class="name">${esc(i.name)}</span>
              <span class="sz">${i.type === 'dir' ? '—' : fmtSize(LumeFS.size(i.path))}</span>
            </div>`
            )
            .join('')
        : `<div class="files-empty">this folder is empty — right-click to make something</div>`;

      backBtn.disabled = hi === 0;
      fwdBtn.disabled = hi >= hist.length - 1;
      upBtn.disabled = cur === '/';
      navs.forEach((n) => n.classList.toggle('active', n.dataset.go === cur));
      win.setTitle(LumeFS.baseOf(cur) === '/' ? 'Files' : LumeFS.baseOf(cur));
    };

    const go = (path, mode) => {
      const next = LumeFS.norm(path);
      if (!LumeFS.isDir(next)) return;
      if (next === cwd() && mode !== 'replace') {
        render();
        return;
      }
      if (mode === 'replace') {
        hist[hi] = next;
      } else {
        hist = hist.slice(0, hi + 1);
        hist.push(next);
        hi = hist.length - 1;
      }
      selected = null;
      render();
    };

    const openRow = (path, type) => {
      if (type === 'dir' || LumeFS.isDir(path)) go(path);
      else window.LumeOS.openApp('editor', { path: path });
    };

    /* --- 工具栏 --- */
    body.querySelector('.files-bar').addEventListener('click', (e) => {
      const tool = e.target.closest('.files-tool');
      if (tool) {
        const act = tool.dataset.act;
        if (act === 'back' && hi > 0) {
          hi -= 1;
          selected = null;
          render();
        }
        if (act === 'fwd' && hi < hist.length - 1) {
          hi += 1;
          selected = null;
          render();
        }
        if (act === 'up' && cwd() !== '/') go(LumeFS.parentOf(cwd()));
        if (act === 'new') {
          const box = tool.getBoundingClientRect();
          window.LumeOS.closeMenus();
          /* 必须等到本轮 click 冒泡结束再开菜单：document 上有个「点空白收菜单」
             的监听，会把刚打开的 #ctx-menu 立刻关掉（因为 + 按钮不在菜单里），
             于是菜单闪一下就没了，加号看着像没反应。setTimeout(0) 让这次 click
             先跑完冒泡 → 关干净 → 再开新菜单。 */
          setTimeout(() => areaMenu(box.left - 60, box.bottom + 6), 0);
        }
        return;
      }
      const crumb = e.target.closest('.crumb');
      if (crumb) go(crumb.dataset.go);
    });

    /* --- 文件行 --- */
    main.addEventListener('click', (e) => {
      const row = e.target.closest('.files-row');
      if (!row) return;
      selected = row.dataset.path;
      Array.from(main.querySelectorAll('.files-row')).forEach((r) => r.classList.toggle('active', r === row));
      openRow(row.dataset.path, row.dataset.type);
    });

    main.addEventListener('keydown', (e) => {
      if (e.key !== 'Enter' && e.key !== ' ') return;
      const row = e.target.closest('.files-row');
      if (!row) return;
      e.preventDefault();
      row.click();
    });

    body.querySelector('.files-side').addEventListener('click', (e) => {
      const nav = e.target.closest('.files-nav');
      if (!nav) return;
      go(nav.dataset.go);
    });

    /* --- 右键：行菜单 / 空白处菜单。stopPropagation 让内核别再弹桌面菜单 --- */
    const rowMenu = (x, y, path, type, row) => {
      const isDir = type === 'dir';
      const items = [
        { ico: isDir ? 'files' : 'editor', label: 'Open', run: () => openRow(path, type) },
        {
          ico: 'rename',
          label: 'Rename…',
          run: () => window.LumeOS.inlineRename(row.querySelector('.name'), path, render)
        }
      ];
      if (isDir) {
        items.push({
          ico: 'terminal',
          label: 'Open Terminal Here',
          run: () => window.LumeOS.openApp('terminal', { cwd: path, path: path })
        });
      } else {
        items.push({ ico: 'duplicate', label: 'Duplicate', run: () => window.LumeOS.duplicate(path) });
      }
      items.push('|', {
        ico: 'trash',
        label: 'Move to Trash',
        danger: true,
        run: () => {
          window.LumeOS.remove(path);
          selected = null;
        }
      });

      window.LumeOS.popMenu(x, y, {
        title: LumeFS.baseOf(path),
        sub: isDir ? 'Folder' : fmtSize(LumeFS.size(path)),
        items: items
      });
    };

    const areaMenu = (x, y) => {
      const base = LumeFS.baseOf(cwd());
      window.LumeOS.popMenu(x, y, {
        title: base === '/' ? 'lumeos' : base,
        sub: 'lume-fs · ' + cwd(),
        items: [
          { ico: 'newfile', label: 'New File', hint: '⌘⇧N', run: () => window.LumeOS.newItem(cwd(), 'file') },
          { ico: 'newfile', label: 'New Python File', run: () => window.LumeOS.newItem(cwd(), 'file', 'untitled.py') },
          { ico: 'newfolder', label: 'New Folder', run: () => window.LumeOS.newItem(cwd(), 'dir') },
          '|',
          {
            ico: 'terminal',
            label: 'Open Terminal Here',
            run: () => window.LumeOS.openApp('terminal', { cwd: cwd(), path: cwd() })
          },
          { ico: 'refresh', label: 'Refresh', run: render },
          {
            ico: 'up',
            label: 'Enclosing Folder',
            hint: '↑',
            run: () => {
              if (cwd() !== '/') go(LumeFS.parentOf(cwd()));
            }
          }
        ]
      });
    };

    main.addEventListener('contextmenu', (e) => {
      e.preventDefault();
      e.stopPropagation();
      window.LumeOS.closeMenus();
      const row = e.target.closest('.files-row');
      if (row) {
        selected = row.dataset.path;
        render();
        const fresh = main.querySelector('.files-row[data-path="' + CSS.escape(row.dataset.path) + '"]');
        rowMenu(e.clientX, e.clientY, row.dataset.path, row.dataset.type, fresh || row);
      } else {
        areaMenu(e.clientX, e.clientY);
      }
    });

    /* 侧边栏的空白处也给菜单，不然右键会漏到桌面 */
    body.querySelector('.files-side').addEventListener('contextmenu', (e) => {
      e.preventDefault();
      e.stopPropagation();
      window.LumeOS.closeMenus();
      areaMenu(e.clientX, e.clientY);
    });

    win.navigate = (path) => go(path);

    window.addEventListener('lume:fs', render);
    render();
  }
};

/* ---------------------------------------------------------- */
/*  Editor                                                     */
/* ---------------------------------------------------------- */
const EditorApp = {
  id: 'editor',
  name: 'Editor',
  icon: 'editor',
  width: 620,
  height: 420,

  mount(body, win, opts = {}) {
    let path = opts.path && LumeFS.exists(opts.path) ? opts.path : null;
    let dirty = false;

    body.innerHTML = `
      <div class="editor">
        <div class="editor-bar">
          <span class="file">untitled</span>
          <span class="lang" hidden>txt</span>
          <span class="spacer"></span>
          <span class="words">0 words</span>
          <button class="editor-btn" type="button" data-act="preview" title="Toggle preview (⌘⇧V)" hidden>Preview</button>
          <button class="editor-btn run" type="button" data-act="run" title="Run (⌘⏎)" hidden>Run</button>
          <button class="editor-btn primary" type="button" data-act="save" title="Save (⌘S)">Save</button>
        </div>
        <div class="editor-wrap">
          <pre class="editor-code" aria-hidden="true" hidden><code></code></pre>
          <textarea class="editor-area" spellcheck="false" wrap="off" aria-label="Editor"></textarea>
          <div class="editor-md" hidden></div>
        </div>
        <div class="editor-out" hidden>
          <div class="editor-out-bar">
            <span>Output</span>
            <span class="spacer"></span>
            <span class="meta"></span>
            <button class="close" type="button" data-act="close-out" aria-label="Hide output">×</button>
          </div>
          <pre class="editor-out-body"></pre>
        </div>
      </div>`;

    const area = body.querySelector('.editor-area');
    const wrap = body.querySelector('.editor-wrap');
    const codeBox = body.querySelector('.editor-code');
    const codeEl = codeBox.querySelector('code');
    const langTag = body.querySelector('.editor-bar .lang');
    const fileLabel = body.querySelector('.editor-bar .file');
    const words = body.querySelector('.editor-bar .words');
    const runBtn = body.querySelector('[data-act="run"]');
    const previewBtn = body.querySelector('[data-act="preview"]');
    const mdView = body.querySelector('.editor-md');
    const outPanel = body.querySelector('.editor-out');
    const outMeta = body.querySelector('.editor-out-bar .meta');
    const outBody = body.querySelector('.editor-out-body');

    /* 扩展名 → 标签文字 / 配色：.lume 用强调色，纯文本用中性色，md 用绿 */
    const extOf = (p) => {
      const base = LumeFS.baseOf(p);
      const i = base.lastIndexOf('.');
      return i > 0 ? base.slice(i + 1).toLowerCase() : '';
    };
    const KIND = { lume: 'lume', md: 'doc', markdown: 'doc', py: 'py', pyw: 'py' };

    const ext = path ? extOf(path) : '';
    const isLume = ext === 'lume';
    const isPy = ext === 'py' || ext === 'pyw';
    const isMd = !!(window.LumeMarkdown && (LumeMarkdown.isMarkdown(path) || window.LumeMarkdown.isMarkdown('.' + ext)));
    /* .lume / .py / .md 都走「pre 上色 + textarea 透明」双图层 */
    const syntax = !!(path && window.LumeHighlight && (LumeHighlight.isLume(path) || LumeHighlight.isPython(path))) || isMd;
    let previewing = false;

    const paint = () => {
      if (!syntax) return;
      codeEl.innerHTML = isMd && window.LumeMarkdown
        ? LumeMarkdown.render(area.value)
        : isPy
          ? LumeHighlight.renderPython(area.value)
          : LumeHighlight.render(area.value);
      codeBox.scrollTop = area.scrollTop;
      codeBox.scrollLeft = area.scrollLeft;
    };

    /* Markdown 预览：直接把编辑器换成渲染结果，再点一次切回来 */
    const renderPreview = () => {
      if (!isMd || !window.LumeMarkdown) return;
      mdView.innerHTML = LumeMarkdown.toHTML(area.value);
    };

    const setPreview = (on) => {
      if (!isMd) return;
      previewing = on;
      mdView.hidden = !on;
      area.hidden = on;
      codeBox.hidden = on || !syntax;
      wrap.classList.toggle('previewing', on);
      previewBtn.classList.toggle('on', on);
      previewBtn.textContent = on ? 'Edit' : 'Preview';
      if (on) renderPreview();
      else {
        paint();
        area.focus();
      }
    };

    const sync = () => {
      const text = area.value;
      const n = text.trim() ? text.trim().split(/\s+/).length : 0;
      words.textContent = n + (n === 1 ? ' word' : ' words');
      fileLabel.textContent = (path ? LumeFS.baseOf(path) : 'untitled') + (dirty ? ' •' : '');
      win.setTitle(path ? LumeFS.baseOf(path) : 'Editor');
    };

    if (path) {
      area.value = LumeFS.read(path) || '';
    } else {
      area.value =
        '# a blank page\n\nNothing here is permanent — press Save and it goes into the fake filesystem.\nOpen Files and it will be there.\n';
    }

    codeBox.hidden = !syntax;
    area.classList.toggle('is-code', syntax);

    if (ext) {
      langTag.hidden = false;
      langTag.textContent = ext.toUpperCase();
      langTag.dataset.kind = KIND[ext] || 'text';
    }
    runBtn.hidden = !(isLume || isPy);
    previewBtn.hidden = !isMd;

    const save = () => {
      if (!path) {
        window.LumeOS.toast('Untitled buffers are not saved — open a file from Files first.');
        return;
      }
      LumeFS.write(path, area.value);
      dirty = false;
      sync();
      window.LumeOS.toast('Saved ' + LumeFS.baseOf(path));
    };

    /* Python 的 stdout/stderr 是分片回传的，逐段往 <pre> 里追加，
       不走「拼一整段 innerHTML」那条路 —— 跑长脚本时能边跑边看。 */
    let pyBusy = false;
    const pyAppend = (text, cls) => {
      const frag = document.createDocumentFragment();
      String(text).split('\n').forEach((line, i, arr) => {
        if (i === arr.length - 1 && line === '') return;
        const span = document.createElement('span');
        span.className = cls ? 'line ' + cls : 'line';
        span.textContent = line;
        frag.appendChild(span);
        frag.appendChild(document.createTextNode('\n'));
      });
      outBody.appendChild(frag);
      outBody.scrollTop = outBody.scrollHeight;
    };

    /* .py 的 Run：跟终端 `py run` 共用同一个 worker 运行时 */
    const runPython = () => {
      if (!window.LumePy) {
        outPanel.hidden = false;
        outBody.innerHTML = '<span class="err">python runtime module not loaded</span>';
        outMeta.textContent = 'error';
        return;
      }
      if (pyBusy) {
        window.LumeOS.toast('Python is still running — wait, or press ^C in the terminal');
        return;
      }
      pyBusy = true;
      outPanel.hidden = false;
      outBody.innerHTML = '';
      outMeta.textContent = 'starting python…';
      const t0 = performance.now();

      window.LumePy
        .run(area.value, {
          log: (s) => { outMeta.textContent = s; },
          out: (s) => pyAppend(s, ''),
          err: (s) => pyAppend(s, 'err')
        })
        .then((r) => {
          if (r.value) pyAppend('=> ' + r.value, 'dim');
          const ms = r.ms != null ? r.ms : Math.round(performance.now() - t0);
          outMeta.textContent = 'done · ' + ms + ' ms';
        })
        .catch((e) => {
          if (e && e.interrupted) { outMeta.textContent = 'interrupted'; return; }
          const lines = String((e && e.message) || e).split('\n').filter((l) => l.trim());
          /* traceback 有用的信息在最后，倒着最多给 12 行 */
          lines.slice(-12).forEach((l) => pyAppend(l, 'err'));
          outMeta.textContent = 'error';
        })
        .finally(() => { pyBusy = false; });
    };

    /* 在编辑器里直接跑：lume 走浏览器 VM，py 走 worker 里的 CPython */
    const run = () => {
      if (isPy) {
        runPython();
        return;
      }
      if (!isLume || !window.LumeVM) return;
      const name = path ? LumeFS.baseOf(path) : 'untitled.lume';
      const t0 = performance.now();
      const res = LumeVM.run(area.value, { name: name });
      const ms = Math.max(1, Math.round(performance.now() - t0));

      outPanel.hidden = false;
      if (res.ok) {
        outBody.innerHTML = res.output.length
          ? res.output.map((line) => '<span class="line">' + esc(line) + '</span>').join('\n')
          : '<span class="dim">ran clean, printed nothing</span>';
        outMeta.textContent = res.output.length + ' lines · ' + ms + ' ms';
      } else {
        outBody.innerHTML = '<span class="err">' + esc(res.message) + '</span>';
        outMeta.textContent = 'error · ' + ms + ' ms';
      }
      outBody.scrollTop = 0;
    };

    area.addEventListener('input', () => {
      dirty = true;
      sync();
      paint();
    });

    area.addEventListener('scroll', () => {
      if (!syntax) return;
      codeBox.scrollTop = area.scrollTop;
      codeBox.scrollLeft = area.scrollLeft;
    });

    area.addEventListener('keydown', (e) => {
      const mod = e.ctrlKey || e.metaKey;
      if (mod && e.key === 's') {
        e.preventDefault();
        save();
      }
      if (mod && e.key === 'Enter') {
        e.preventDefault();
        run();
      }
      if (mod && e.shiftKey && (e.key === 'v' || e.key === 'V')) {
        e.preventDefault();
        setPreview(!previewing);
      }
    });

    /* 右键菜单：运行 / 保存 + 剪贴板。自己接管，别漏给浏览器 */
    area.addEventListener('contextmenu', (e) => {
      e.preventDefault();
      e.stopPropagation();

      const OS = window.LumeOS;
      OS.closeMenus();

      const exec = (cmd) => () => {
        area.focus();
        try {
          document.execCommand(cmd);
        } catch (err) {
          OS.toast('This browser blocked that action');
        }
      };

      const items = [];
      if (isMd) {
        items.push({
          ico: 'editor',
          label: previewing ? 'Edit Markdown' : 'Preview Markdown',
          hint: '⌘⇧V',
          run: () => setPreview(!previewing)
        });
        items.push('|');
      }
      if (isLume || isPy) items.push({ ico: 'run', label: 'Run File', hint: '⌘⏎', run: run });
      items.push({ ico: 'save', label: 'Save', hint: '⌘S', run: save });
      items.push('|');
      items.push({ ico: 'cut', label: 'Cut', hint: '⌘X', run: exec('cut') });
      items.push({ ico: 'copy', label: 'Copy', hint: '⌘C', run: exec('copy') });
      items.push({ ico: 'paste', label: 'Paste', hint: '⌘V', run: () => OS.pasteInto(area) });
      items.push('|');
      items.push({
        ico: 'selectall',
        label: 'Select All',
        hint: '⌘A',
        run: () => {
          area.focus();
          area.select();
        }
      });

      OS.popMenu(e.clientX, e.clientY, {
        title: path ? LumeFS.baseOf(path) : 'untitled',
        sub: isLume ? 'lume source' : isPy ? 'python source' : area.value.trim() ? 'text' : 'empty buffer',
        items: items
      });
    });

    body.querySelector('[data-act="save"]').addEventListener('click', save);
    runBtn.addEventListener('click', run);
    previewBtn.addEventListener('click', () => setPreview(!previewing));
    body.querySelector('[data-act="close-out"]').addEventListener('click', () => {
      outPanel.hidden = true;
    });

    /* 自动缩进 / 括号配对 / 关键字补全（lume 与 python 才启用代码行为） */
    if (window.LumeEdit) {
      LumeEdit.attach({
        area: area,
        wrap: wrap,
        lang: isLume ? 'lume' : isPy ? 'python' : isMd ? 'md' : 'text'
      });
    }

    sync();
    paint();
    setTimeout(() => area.focus(), 60);
  }
};

/* ---------------------------------------------------------- */
/*  Settings                                                   */
/* ---------------------------------------------------------- */
const SettingsApp = {
  id: 'settings',
  name: 'Settings',
  icon: 'settings',
  width: 780,
  height: 560,

  mount(body) {
    const OS = window.LumeOS || {};
    const info = OS.systemInfo ? OS.systemInfo() : {};

    /* ---------- 数据表：全部写在上面，HTML 只负责摆 ---------- */
    const ACCENTS = [
      ['#33aaff', 'Azure'], ['#a78bfa', 'Violet'], ['#34d399', 'Mint'],
      ['#f472b6', 'Rose'], ['#fbbf24', 'Amber'], ['#ff7a45', 'Ember']
    ];
    const IDLES = [[30000, '30 s'], [90000, '90 s'], [300000, '5 min'], [0, 'Never']];

    const fmt = (b) => (b < 1024 ? b + ' B' : b < 1048576 ? (b / 1024).toFixed(1) + ' KB' : (b / 1048576).toFixed(2) + ' MB');

    /* 文件系统用量：递归数一遍 HOME，内容长度按字符算（够用来给个量级） */
    const fsStats = () => {
      let files = 0, bytes = 0;
      const walk = (dir) => {
        try {
          LumeFS.list(dir).forEach((f) => {
            if (f.type === 'dir') walk(f.path);
            else { files += 1; bytes += (LumeFS.read(f.path) || '').length; }
          });
        } catch (e) {}
      };
      walk(LumeFS.HOME);
      return { files: files, bytes: bytes };
    };
    /* localStorage 全量：key + value 各按 2 字节/字符估（UTF-16） */
    const storeBytes = () => {
      let n = 0;
      try {
        for (let i = 0; i < localStorage.length; i++) {
          const k = localStorage.key(i) || '';
          n += (k.length + (localStorage.getItem(k) || '').length) * 2;
        }
      } catch (e) {}
      return n;
    };

    /* ---------- 线性图标：统一 24 格、1.6 描边，跟菜单栏一套 ---------- */
    const I = {
      look: '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.6" aria-hidden="true"><circle cx="12" cy="12" r="8.2"/><path d="M12 3.8a8.2 8.2 0 0 0 0 16.4Z" fill="currentColor" stroke="none"/></svg>',
      input: '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.6" stroke-linecap="round" aria-hidden="true"><rect x="2.6" y="6" width="18.8" height="12" rx="2.6"/><path d="M7 10.4h.01M10.4 10.4h.01M13.8 10.4h.01M17.2 10.4h.01M8 14.2h8"/></svg>',
      system: '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.6" stroke-linecap="round" aria-hidden="true"><circle cx="12" cy="12" r="3.1"/><path d="M12 2.6v2M12 19.4v2M2.6 12h2M19.4 12h2M5.4 5.4l1.4 1.4M17.2 17.2l1.4 1.4M18.6 5.4l-1.4 1.4M6.8 17.2l-1.4 1.4"/></svg>',
      about: '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.6" stroke-linecap="round" aria-hidden="true"><circle cx="12" cy="12" r="8.6"/><path d="M12 11.2v5.4"/><circle cx="12" cy="7.9" r="1.05" fill="currentColor" stroke="none"/></svg>'
    };

    const tabs = [
      ['look', I.look, 'Look &amp; Feel'],
      ['input', I.input, 'Input'],
      ['system', I.system, 'System'],
      ['about', I.about, 'About']
    ].map((t, i) =>
      '<button class="set-tab' + (i === 0 ? ' on' : '') + '" data-tab="' + t[0] + '" type="button" role="tab">' +
        t[1] + '<span>' + t[2] + '</span></button>'
    ).join('');

    body.innerHTML = `
      <div class="settings2">
        <aside class="set-rail">
          <div class="set-brand">
            <span class="set-mark" aria-hidden="true"></span>
            <div><b>Settings</b><small>LumeOS 1.0</small></div>
          </div>
          <nav class="set-nav" role="tablist">${tabs}</nav>
          <div class="set-rail-foot"><span>1.0</span><i aria-hidden="true"></i><span>nebula</span></div>
        </aside>

        <div class="set-main">
          <div class="set-scroll">

            <section class="set-pane on" data-pane="look">
              <header class="set-head">
                <h2>Look &amp; Feel</h2>
                <p>Every change lands the instant you pick it — there is no Save button in this system.</p>
              </header>

              <div class="set-block">
                <p class="set-cap">Theme</p>
                <div class="pick-row" data-set="theme">
                  <button class="pick" data-v="dark" type="button">
                    <span class="pick-art pa-dark"><i class="pa-bar"></i><i class="pa-win"></i><i class="pa-dock"></i></span>
                    <span class="pick-meta"><b>Dark</b><small>Pure black, mono labels</small></span>
                  </button>
                  <button class="pick" data-v="light" type="button">
                    <span class="pick-art pa-light"><i class="pa-bar"></i><i class="pa-win"></i><i class="pa-dock"></i></span>
                    <span class="pick-meta"><b>Light</b><small>Paper white, same bones</small></span>
                  </button>
                </div>
              </div>

              <div class="set-block">
                <p class="set-cap">Accent</p>
                <div class="sw-row" data-set="accent">
                  ${ACCENTS.map(([c, n]) =>
                    '<button class="sw" data-v="' + c + '" style="--c:' + c + '" type="button" title="' + n + '" aria-label="' + n + '"></button>'
                  ).join('')}
                </div>
                <p class="set-hint">Drives the terminal cursor, dock dots, text selection and syntax keywords.</p>
              </div>

              <div class="set-block">
                <p class="set-cap">Wallpaper</p>
                <div class="pick-row" data-set="wall">
                  <button class="pick" data-v="stars" type="button">
                    <span class="pick-art pa-wall pa-stars"></span>
                    <span class="pick-meta"><b>Stars</b><small>Drifting canvas dust</small></span>
                  </button>
                  <button class="pick" data-v="grid" type="button">
                    <span class="pick-art pa-wall pa-grid"></span>
                    <span class="pick-meta"><b>Grid</b><small>Blueprint lines</small></span>
                  </button>
                  <button class="pick" data-v="plain" type="button">
                    <span class="pick-art pa-wall pa-plain"></span>
                    <span class="pick-meta"><b>Plain</b><small>Nothing at all</small></span>
                  </button>
                </div>
              </div>
            </section>

            <section class="set-pane" data-pane="input">
              <header class="set-head">
                <h2>Input</h2>
                <p>The pinyin engine runs inside this tab. No IME service, no network.</p>
              </header>

              <div class="set-block">
                <p class="set-cap">Chinese IME</p>
                <div class="set-card">
                  <div class="set-row">
                    <div class="set-row-txt">
                      <b>Active layout</b>
                      <small>Tap Shift on its own to flip 中 / EN without opening this panel.</small>
                    </div>
                    <div class="seg" data-set="ime">
                      <button data-v="cn" type="button">中</button>
                      <button data-v="en" type="button">EN</button>
                      <button data-v="off" type="button">Off</button>
                    </div>
                  </div>
                  <div class="set-row">
                    <div class="set-row-txt">
                      <b>Dictionary</b>
                      <small>Full pinyin, 简拼 abbreviations and sentence-level segmentation.</small>
                    </div>
                    <span class="set-pill" id="set-ime-state">—</span>
                  </div>
                </div>
              </div>

              <div class="set-block">
                <p class="set-cap">Keys</p>
                <div class="key-list">
                  <div class="key-row"><kbd>Shift</kbd><span>Swap 中 / EN</span></div>
                  <div class="key-row"><kbd>⌘K</kbd><span>Spotlight — apps, files, commands</span></div>
                  <div class="key-row"><kbd>⌘⇧L</kbd><span>Lock the screen</span></div>
                  <div class="key-row"><kbd>⌘S</kbd><span>Save the file you are editing</span></div>
                  <div class="key-row"><kbd>⌘↵</kbd><span>Run the current .lume file</span></div>
                </div>
              </div>
            </section>

            <section class="set-pane" data-pane="system">
              <header class="set-head">
                <h2>System</h2>
                <p>Idle behaviour, notifications, and the switch you should read twice.</p>
              </header>

              <div class="set-block">
                <p class="set-cap">Screensaver</p>
                <div class="set-card">
                  <div class="set-row">
                    <div class="set-row-txt">
                      <b>Enter after</b>
                      <small>Stars drift in once nothing moves. Any pointer or key wakes it.</small>
                    </div>
                    <div class="seg" data-set="idle">
                      ${IDLES.map(([ms, n]) => '<button data-v="' + ms + '" type="button">' + n + '</button>').join('')}
                    </div>
                  </div>
                  <div class="set-row">
                    <div class="set-row-txt">
                      <b>Preview</b>
                      <small>See it now instead of waiting out the timer.</small>
                    </div>
                    <button class="set-btn" data-act="screensaver" type="button">Run now</button>
                  </div>
                </div>
              </div>

              <div class="set-block">
                <p class="set-cap">Notifications</p>
                <div class="set-card">
                  <div class="set-row">
                    <div class="set-row-txt">
                      <b>Send a test</b>
                      <small>Lands under the bell at the top right, plus a toast.</small>
                    </div>
                    <button class="set-btn" data-act="notify" type="button">Notify me</button>
                  </div>
                  <div class="set-row">
                    <div class="set-row-txt">
                      <b>Walking tour</b>
                      <small>Four stops around the desktop, normally shown once per session.</small>
                    </div>
                    <button class="set-btn" data-act="tour" type="button">Replay</button>
                  </div>
                </div>
              </div>

              <div class="set-block">
                <p class="set-cap">Danger zone</p>
                <div class="set-card danger">
                  <div class="set-row">
                    <div class="set-row-txt">
                      <b>Reset everything</b>
                      <small>Files, theme, accent, IME and preferences. The tab reloads.</small>
                    </div>
                    <button class="set-btn danger" data-act="reset" type="button">Wipe</button>
                  </div>
                </div>
              </div>
            </section>

            <section class="set-pane" data-pane="about">
              <header class="set-head">
                <h2>About</h2>
                <p>What this machine pretends to be, and how much room it is using.</p>
              </header>

              <div class="set-hero">
                <div class="set-hero-mark" aria-hidden="true">L</div>
                <div class="set-hero-txt">
                  <b>LumeOS 1.0</b>
                  <span>nebula · ${esc(info.wm || 'vanilla')} window manager</span>
                </div>
                <button class="set-btn" data-act="about" type="button">Open About</button>
              </div>

              <div class="spec-grid">
                ${[
                  ['Kernel', info.kernel], ['Build', info.build],
                  ['Uptime', info.uptime], ['Apps', (info.apps || 0) + ' installed'],
                  ['Memory', info.memory], ['Theme', info.theme],
                  ['Engine', info.engine], ['Cache', info.cache]
                ].map(([k, v]) =>
                  '<div class="spec"><span>' + k + '</span><b>' + esc(v == null || v === '' ? '—' : v) + '</b></div>'
                ).join('')}
              </div>

              <div class="set-block">
                <p class="set-cap">Storage</p>
                <div class="set-card" id="set-storage"></div>
              </div>
            </section>

          </div>

          <footer class="set-foot">
            <span class="set-foot-dot" aria-hidden="true"></span>
            Nothing here talks to a server · everything lives in this tab's localStorage and dies with the cache
          </footer>
        </div>
      </div>`;

    const root = document.documentElement;
    const q = (s) => body.querySelector(s);
    const paint = (sel, on) => body.querySelectorAll(sel).forEach((b) => b.classList.toggle('on', on(b)));

    const sync = () => {
      const theme = root.dataset.theme || 'dark';
      const wall = root.dataset.wall || 'stars';
      const accent = (getComputedStyle(root).getPropertyValue('--accent') || '').trim().toLowerCase();
      const ime = window.LumeIME;
      const imeVal = !ime || !ime.on ? 'off' : ime.mode;
      const idle = OS.getIdleLimit ? OS.getIdleLimit() : 90000;

      paint('[data-set="theme"] [data-v]', (b) => b.dataset.v === theme);
      paint('[data-set="wall"] [data-v]', (b) => b.dataset.v === wall);
      paint('[data-set="accent"] [data-v]', (b) => b.dataset.v.toLowerCase() === accent);
      paint('[data-set="ime"] [data-v]', (b) => b.dataset.v === imeVal);
      paint('[data-set="idle"] [data-v]', (b) => Number(b.dataset.v) === idle);

      const pill = q('#set-ime-state');
      if (pill) pill.textContent = imeVal === 'off' ? 'off' : imeVal === 'cn' ? '中 · pinyin' : 'EN · pass-through';

      const storage = q('#set-storage');
      if (storage) {
        const fs = fsStats(), total = storeBytes();
        const pct = Math.min(100, (total / (5 * 1048576)) * 100);
        storage.innerHTML =
          '<div class="meter"><i style="width:' + (pct < 0.6 ? 0.6 : pct).toFixed(2) + '%"></i></div>' +
          '<div class="meter-legend">' +
            '<span><b>' + fs.files + '</b> files · ' + fmt(fs.bytes) + '</span>' +
            '<span><b>' + fmt(total) + '</b> / ~5 MB localStorage</span>' +
          '</div>';
      }
    };

    body.addEventListener('click', (e) => {
      /* 侧栏切页 */
      const tab = e.target.closest('.set-tab');
      if (tab) {
        body.querySelectorAll('.set-tab').forEach((b) => b.classList.toggle('on', b === tab));
        body.querySelectorAll('.set-pane').forEach((p) => {
          const on = p.dataset.pane === tab.dataset.tab;
          p.classList.toggle('on', on);
          if (on) { p.classList.remove('in'); void p.offsetWidth; p.classList.add('in'); }
        });
        q('.set-scroll').scrollTop = 0;
        return;
      }

      /* 所有选项：主题 / 强调色 / 壁纸 / 输入法 / 屏保延时的 data-v 都走这一条 */
      const chip = e.target.closest('[data-set] [data-v]');
      if (chip) {
        const kind = chip.closest('[data-set]').dataset.set;
        const v = chip.dataset.v;
        if (kind === 'theme') OS.setTheme(v);
        else if (kind === 'wall') OS.setWall(v);
        else if (kind === 'accent') OS.setAccent(v);
        else if (kind === 'idle') OS.setIdleLimit(Number(v));
        else if (kind === 'ime' && window.LumeIME) {
          if (v === 'off') window.LumeIME.setOn(false);
          else { window.LumeIME.setOn(true); window.LumeIME.setMode(v); }
        }
        sync();
        return;
      }

      const act = e.target.closest('[data-act]');
      if (!act) return;
      const a = act.dataset.act;
      if (a === 'about') OS.openApp && OS.openApp('about');
      else if (a === 'notify' && OS.postNotification) {
        OS.postNotification({ title: 'Test notification', body: 'If you can read this, the bell works.', app: 'Settings' });
      } else if (a === 'tour' && OS.replayTour) OS.replayTour();
      else if (a === 'screensaver' && OS.screensaver) OS.screensaver();
      else if (a === 'reset') {
        /* 不做原生 confirm：先按一次变成「再按一次」，三秒不动就自己撤回 */
        if (act.dataset.armed === '1') { localStorage.clear(); location.reload(); return; }
        act.dataset.armed = '1';
        act.classList.add('armed');
        act.textContent = 'Click again';
        setTimeout(() => {
          if (!act.isConnected) return;
          act.dataset.armed = '';
          act.classList.remove('armed');
          act.textContent = 'Wipe';
        }, 3000);
      }
    });

    window.addEventListener('themechange', sync);
    document.addEventListener('lume:ime', sync);
    autoCleanup(body, () => {
      window.removeEventListener('themechange', sync);
      document.removeEventListener('lume:ime', sync);
    });
    sync();
  }
};

/* ---------------------------------------------------------- */
/*  About                                                      */
/* ---------------------------------------------------------- */
const AboutApp = {
  id: 'about',
  name: 'About',
  icon: 'about',
  width: 700,
  height: 560,

  mount(body, win) {
    const info = window.LumeOS.systemInfo();

    const ascii = [
      '██╗     ██╗   ██╗███╗   ███╗███████╗',
      '██║     ██║   ██║████╗ ████║██╔════╝',
      '██║     ██║   ██║██╔████╔██║█████╗  ',
      '██║     ██║   ██║██║╚██╔╝██║██╔══╝  ',
      '███████╗╚██████╔╝██║ ╚═╝ ██║███████╗',
      '╚══════╝ ╚═════╝ ╚═╝     ╚═╝╚══════╝'
    ].join('\n');

    /* 用法指导按「先干什么」排，不按功能分类排。
       新用户第一个问题永远是「我能做什么」，
       而不是「窗口管理器有哪些快捷键」。 */
    const GUIDE = [
      {
        k: 'Getting around',
        rows: [
          ['⌘K / Ctrl K', 'Spotlight — jump to any app or file'],
          ['Dock', 'Click to launch; right-click for New Window'],
          ['Titlebar', 'Drag to move; double-click to zoom'],
          ['⌘⇧L', 'Lock the screen'],
          ['Right-click', 'The desktop for wallpaper / theme / new file']
        ]
      },
      {
        k: 'Writing',
        rows: [
          ['Editor', 'Plain text with syntax highlighting and live Markdown preview'],
          ['⌘S', 'Save to the pretend filesystem (it survives reloads)'],
          ['⌘⇧V', 'Toggle Markdown preview'],
          ['( [ { " \'', 'Auto-closes; Backspace removes the pair'],
          ['Shift', 'Switch the built-in IME between 中 / EN']
        ]
      },
      {
        k: 'Terminal',
        rows: [
          ['help', 'Every command that exists'],
          ['lume run x.lume', 'Run a tiny scripting language in-browser'],
          ['py setup', 'Fetch a Python runtime into this browser (one time)'],
          ['shutdown', 'Power off — then quit the tab or reboot']
        ]
      },
      {
        k: 'Touch devices',
        rows: [
          ['Long-press', 'Same as right-click — menus work without a mouse'],
          ['⌨ tray key', 'On-screen keyboard when there is no hardware one'],
          ['Honest note', 'This desktop is built for a pointer; phones work but feel cramped']
        ]
      }
    ];

    body.innerHTML = `
      <div class="about">
        <div class="about-hero">
          <h1>LumeOS</h1>
          <span>1.0 · nebula</span>
        </div>

        <div class="neo">
          <pre>${esc(ascii)}</pre>
          <div class="neo-info"><b>lume@lumeos</b>
<span class="k">-----------</span>
OS         ${esc(info.os)}
Kernel     ${esc(info.kernel)}
Shell      lumesh
WM         lume-wm
Uptime     ${esc(info.uptime)}
Apps       ${info.apps} running
Theme      ${esc(info.theme)}
Engine     ${esc(info.engine)}
Memory     ${esc(info.memory)}</div>
        </div>

        <nav class="about-jump">
          <a href="#ab-guide">How to use</a>
          <a href="#ab-lic">Licence</a>
          <a href="#ab-cred">Credits</a>
        </nav>

        <section class="about-sec" id="ab-guide">
          <h2>How to use</h2>
          ${GUIDE.map(
            (g) => `
            <div class="about-guide-group">
              <h3>${esc(g.k)}</h3>
              <dl class="about-guide">
                ${g.rows
                  .map(([k, v]) => `<dt><kbd>${esc(k)}</kbd></dt><dd>${esc(v)}</dd>`)
                  .join('')}
              </dl>
            </div>`
          ).join('')}
          <p class="about-tip">
            全部键位都在上面这张表里；Licence 原文见下方 <a href="#ab-lic">Licence</a> 一节。
          </p>
        </section>

        <section class="about-sec" id="ab-lic">
          <h2>Licence</h2>
          <p>
            本站的文字、排版与图像 © ${new Date().getFullYear()} 羊史 (Yangshi)，保留所有权利。
            欢迎阅读、带链接引用、或从代码里学习；请不要把正文与视觉设计原样搬走当成自己的作品。
          </p>
          <p>
            <b>LumeOS 源码</b>（<code>/LumeOS</code> 下的 HTML / CSS / JavaScript）以
            <b>MIT Licence</b> 发布 —— 可以随意使用、修改、分发，只要保留版权声明。
          </p>
          <details class="about-legal">
            <summary>MIT Licence 全文</summary>
            <pre>MIT License

Copyright (c) ${new Date().getFullYear()} Yangshi

Permission is hereby granted, free of charge, to any person obtaining a copy
of this software and associated documentation files (the "Software"), to deal
in the Software without restriction, including without limitation the rights
to use, copy, modify, merge, publish, distribute, sublicense, and/or sell
copies of the Software, and to permit persons to whom the Software is
furnished to do so, subject to the following conditions:

The above copyright notice and this permission notice shall be included in all
copies or substantial portions of the Software.

THE SOFTWARE IS PROVIDED "AS IS", WITHOUT WARRANTY OF ANY KIND, EXPRESS OR
IMPLIED, INCLUDING BUT NOT LIMITED TO THE WARRANTIES OF MERCHANTABILITY,
FITNESS FOR A PARTICULAR PURPOSE AND NONINFRINGEMENT. IN NO EVENT SHALL THE
AUTHORS OR COPYRIGHT HOLDERS BE LIABLE FOR ANY CLAIM, DAMAGES OR OTHER
LIABILITY, WHETHER IN AN ACTION OF CONTRACT, TORT OR OTHERWISE, ARISING FROM,
OUT OF OR IN CONNECTION WITH THE SOFTWARE OR THE USE OR OTHER DEALINGS IN THE
SOFTWARE.</pre>
          </details>
        </section>

        <section class="about-sec" id="ab-cred">
          <h2>Credits</h2>
          <dl class="about-credits">
            <dt>rime-ice（雾凇拼音）</dt>
            <dd>输入法词库来源 · MPL-2.0</dd>
            <dt>Pyodide</dt>
            <dd>浏览器里的 Python 运行时 · MPL-2.0</dd>
            <dt>Cal Sans</dt>
            <dd>标题字体 · SIL Open Font License 1.1</dd>
            <dt>Inter</dt>
            <dd>正文字体 · SIL Open Font License 1.1</dd>
            <dt>Astro</dt>
            <dd>本站的构建工具 · MIT</dd>
            <dt>gh-proxy.com · gh.dpik.top</dt>
            <dd>下载镜像代理，用于大陆网络可访问性</dd>
          </dl>
        </section>

        <p class="about-foot">
          Build ${esc(info.build)} · made by 羊史 (Yangshi) · no frameworks, no build step, no telemetry.<br />
          A toy, but a careful one.
        </p>
      </div>`;

    /* 锚点跳转：默认 a[href="#id"] 会改 location.hash，
       在这个页面里等于把整个站点导航走 —— 必须拦下来改成滚动。 */
    body.addEventListener('click', (e) => {
      const a = e.target.closest('a[href^="#"]');
      if (a) {
        e.preventDefault();
        const id = a.getAttribute('href').slice(1);
        const target = id && body.querySelector('#' + id);
        if (target) target.scrollIntoView({ behavior: 'smooth', block: 'start' });
      }
    });

    /* 窗口标题跟着滚动位置变，读完一段就知道自己在哪一节。
       判定用「这一节的顶边已经滚过视口上沿一定距离」，
       阈值要比 .about 的 padding-top 大一点 —— 否则停在顶部时
       第一节判不出来，标题会一直空着。 */
    const shell = body.querySelector('.about');
    const marks = Array.from(body.querySelectorAll('.about-sec'));
    const LABEL = { 'ab-guide': 'How to use', 'ab-lic': 'Licence', 'ab-cred': 'Credits' };
    let lastId = null;

    const sync = () => {
      const y = shell.scrollTop + 140;
      let cur = marks.length ? marks[0].id : '';
      for (const m of marks) {
        if (m.offsetTop <= y) cur = m.id;
      }
      if (cur === lastId) return;
      lastId = cur;
      const label = LABEL[cur] || '';
      if (win && win.setTitle) win.setTitle(label ? 'About — ' + label : 'About');
    };

    shell.addEventListener('scroll', sync, { passive: true });
    sync();
  }
};


/* ---------------------------------------------------------- */
/*  Browser                                                   */
/* ---------------------------------------------------------- */
/* 内置 iframe 浏览器。
   最大的坑是：绝大多数站点都发 X-Frame-Options: DENY 或
   Content-Security-Policy: frame-ancestors 'none'，iframe 会被直接拒掉。
   前端没有任何办法绕过（这是浏览器强制执行的），也探测不到被拒的确切原因
   —— onload 不触发、onerror 也不给信息，只能等超时。

   所以这个浏览器的定位必须是「能开的就开，开不了就一键交给真实浏览器」，
   而不是假装什么都能打开。判断不了的时候不报错，而是坦白说清楚，
   并把「在浏览器中打开」放在最显眼的位置。 */
const BROWSER = {
  KEY: 'lume.browser',        /* localStorage：收藏夹 + 历史 + 上次地址 */
  LOAD_TIMEOUT: 4200,         /* 超过这个时间还没 onload，基本可以判定被拒 */

  /* 判断一个地址能不能塞进 iframe。
     不追求全对，只求「明显会被拒的别浪费用户四秒」。
     返回三态：'bad'（地址本身就废了）/ 'blocked'（明知会被拒）/ 'maybe'（值得一试）。 */
  verdict(url) {
    let host = '';
    let proto = '';
    try {
      const u = new URL(url);
      host = u.host.toLowerCase();
      proto = u.protocol.toLowerCase();
    } catch (e) {
      return 'bad';
    }
    /* 没 host 或者不是 http(s)：chrome: / about: / file: 这类 iframe 一律打不开。
       用户时常手打 "chrome://settings"，得当场给个明确说法，别空等超时。 */
    if (!host || (proto !== 'http:' && proto !== 'https:')) return 'bad';

    /* 明确声明禁止嵌入的站点，直接不给试 */
    const BLOCKED = [
      'google.com', 'www.google.com', 'youtube.com', 'www.youtube.com',
      'github.com', 'twitter.com', 'x.com', 'facebook.com',
      'instagram.com', 'linkedin.com', 'reddit.com', 'zhihu.com',
      'weibo.com', 'bilibili.com', 'taobao.com', 'tmall.com',
      'jd.com', 'wechat.com', 'qq.com', 'baidu.com', 'amazon.com'
    ];
    if (BLOCKED.some((d) => host === d || host.endsWith('.' + d))) return 'blocked';

    return 'maybe';
  },

  hostOf(url) {
    try {
      return new URL(url).host.toLowerCase();
    } catch (e) {
      return '';
    }
  },

  /* 用户可能只打 "example.com"，补协议。
     也接受 "搜索词" —— 走 DuckDuckGo，因为它允许被 iframe 嵌入。 */
  normalize(input) {
    const s = (input || '').trim();
    if (!s) return '';
    if (/^https?:\/\//i.test(s)) return s;
    /* 手打 scheme://... 的（chrome://、file://、ftp://）原样放行，
       交给 verdict 判 bad —— 不能当成搜索词丢给 DuckDuckGo，
       否则用户明明输了个地址，却被搜了一通。 */
    if (/^[a-z][a-z0-9+.-]*:\/\//i.test(s)) return s;
    /* localhost 可能带路径，得像域名那样允许尾巴 */
    if (/^localhost(:\d+)?([\/?#].*)?$/i.test(s)) return 'http://' + s;
    if (/^[a-z0-9-]+(\.[a-z0-9-]+)+([\/?#].*)?$/i.test(s)) return 'https://' + s;
    return 'https://duckduckgo.com/?q=' + encodeURIComponent(s);
  },

  read() {
    try {
      return JSON.parse(localStorage.getItem(this.KEY) || '{}') || {};
    } catch (e) {
      return {};
    }
  },

  write(data) {
    try {
      localStorage.setItem(this.KEY, JSON.stringify(data));
    } catch (e) {
      /* 隐私模式下 localStorage 会抛错，收藏夹失效但不该让浏览器崩掉 */
    }
  },

  bookmarks() {
    const d = this.read();
    return Array.isArray(d.marks) ? d.marks : [];
  },

  isMarked(url) {
    return this.bookmarks().some((m) => m.url === url);
  },

  toggleMark(url, title) {
    const d = this.read();
    const marks = Array.isArray(d.marks) ? d.marks : [];
    const i = marks.findIndex((m) => m.url === url);
    if (i >= 0) marks.splice(i, 1);
    else marks.unshift({ url, title: title || this.hostOf(url) || url, at: Date.now() });
    d.marks = marks.slice(0, 60);
    this.write(d);
    return i < 0;
  },

  remember(url) {
    if (!url) return;
    const d = this.read();
    const hist = Array.isArray(d.hist) ? d.hist.filter((h) => h !== url) : [];
    hist.unshift(url);
    d.hist = hist.slice(0, 40);
    d.last = url;
    this.write(d);
  },

  last() {
    return this.read().last || '';
  }
};

const BrowserApp = {
  id: 'browser',
  name: 'Browser',
  icon: 'browser',
  width: 900,
  height: 620,

  mount(body, win, opts) {
    /* 冷启动优先恢复上次那一页（跟真浏览器一致）；
       从没访问过就落在起始页，而不是硬塞一个 example.com。 */
    const start = (opts && opts.url) || BROWSER.last() || '';

    body.innerHTML = `
      <div class="brw">
        <div class="brw-bar">
          <button class="brw-btn" type="button" data-act="back" aria-label="Back">${ICON.back}</button>
          <button class="brw-btn" type="button" data-act="fwd" aria-label="Forward">${ICON.forward}</button>
          <button class="brw-btn" type="button" data-act="reload" aria-label="Reload">${ICON.reload}</button>
          <button class="brw-btn" type="button" data-act="home" aria-label="Home">${ICON.home2}</button>
          <form class="brw-addr-wrap">
            <span class="brw-scheme" data-scheme>https</span>
            <input class="brw-addr" type="text" spellcheck="false" autocomplete="off"
                   placeholder="address or search…" />
          </form>
          <button class="brw-btn brw-star" type="button" data-act="star" aria-label="Bookmark">${ICON.star}</button>
          <button class="brw-btn brw-go-out" type="button" data-act="external" aria-label="Open in real browser">${ICON.external}</button>
        </div>

        <div class="brw-panel" hidden data-panel="marks">
          <div class="brw-panel-head">
            <span>Bookmarks</span>
            <button class="brw-panel-x" type="button" data-act="closepanel" aria-label="Close">${ICON.close}</button>
          </div>
          <div class="brw-marks" data-marks></div>
        </div>

        <div class="brw-view">
          <!-- 沙箱不给 allow-popups：页面里 target="_blank" / window.open 的链接
               会在真实浏览器（Edge）里开新标签页、直接跳出 LumeOS。
               拦下之后这类点击不再外逃，普通链接照常在框内跳转；
               真想开出去走工具栏的「Open in real browser」按钮。 -->
          <iframe class="brw-frame" data-frame
                  referrerpolicy="no-referrer"
                  sandbox="allow-scripts allow-same-origin allow-forms"></iframe>
          <div class="brw-block" data-block hidden>
            <div class="brw-block-inner">
              <div class="brw-block-ico">${ICON.external}</div>
              <h3 data-block-title>This page refuses to be framed</h3>
              <p data-block-text></p>
              <div class="brw-block-actions">
                <button class="brw-cta" type="button" data-act="external">Open in real browser</button>
                <button class="brw-cta ghost" type="button" data-act="home">Go home</button>
              </div>
              <p class="brw-block-note">
                Many sites send <code>X-Frame-Options</code> or
                <code>frame-ancestors</code> to stop embedding. That is enforced by
                the browser itself — no page can override it.
              </p>
            </div>
          </div>
        </div>

        <div class="brw-status">
          <span class="brw-st-host" data-st-host>—</span>
          <span class="brw-st-sep">·</span>
          <span class="brw-st-msg" data-st-msg>ready</span>
        </div>
      </div>`;

    const $ = (s) => body.querySelector(s);
    const frame = $('[data-frame]');
    const block = $('[data-block]');
    const addr = $('.brw-addr');
    const stHost = $('[data-st-host]');
    const stMsg = $('[data-st-msg]');
    const starBtn = $('[data-act="star"]');
    const marksBox = $('[data-marks]');
    const panel = $('[data-panel]');

    /* 会话内的前进/后退。iframe 的 history 跨域读不到，
       只能自己记一份栈 —— 够用，也不会有同步问题。 */
    const stack = { list: [], i: -1 };
    let current = '';
    let timer = 0;

    function say(msg) {
      stMsg.textContent = msg;
    }

    function paintStar() {
      const on = current ? BROWSER.isMarked(current) : false;
      starBtn.innerHTML = on ? ICON.starfill : ICON.star;
      starBtn.classList.toggle('on', on);
      starBtn.title = on ? 'Remove bookmark' : 'Bookmark this page';
    }

    function paintMarks() {
      const marks = BROWSER.bookmarks();
      if (!marks.length) {
        marksBox.innerHTML = '<p class="brw-empty">No bookmarks yet. Hit the star.</p>';
        return;
      }
      marksBox.innerHTML = marks
        .map(
          (m, i) => `
        <div class="brw-mark" data-i="${i}">
          <span class="brw-mark-ico">${ICON.link}</span>
          <span class="brw-mark-text">
            <b>${esc(m.title)}</b>
            <em>${esc(m.url)}</em>
          </span>
          <button class="brw-mark-del" type="button" data-del="${i}" aria-label="Remove">${ICON.close}</button>
        </div>`
        )
        .join('');
    }

    function showPanel(on) {
      panel.hidden = !on;
      if (on) paintMarks();
    }

    /* 真正的加载。done 里再判一次超时 —— 如果 onload 没来，
       说明被 X-Frame-Options / CSP 拒了。 */
    function load(url, push) {
      if (!url) return say('no address');

      current = url;
      BROWSER.remember(url);

      if (push !== false) {
        stack.list = stack.list.slice(0, stack.i + 1);
        stack.list.push(url);
        stack.i = stack.list.length - 1;
      }

      addr.value = url;
      const host = BROWSER.hostOf(url);
      stHost.textContent = host || '—';
      $('[data-scheme]').textContent = (/^https:/i.test(url) ? 'https' : 'http');

      const verdict = BROWSER.verdict(url);
      block.hidden = true;
      block.classList.remove('is-home');
      say('loading…');
      paintStar();
      paintMarks();

      clearTimeout(timer);

      /* 地址本身就废了：立刻报错，不要空等超时 */
      if (verdict === 'bad') {
        frame.removeAttribute('src');
        frame.hidden = true;
        showBlock(url, 'bad');
        return;
      }

      if (verdict === 'blocked') {
        /* 明知会被拒，就别让用户盯着白屏等四秒 */
        frame.removeAttribute('src');
        frame.hidden = true;
        showBlock(url, 'blocked');
        return;
      }

      frame.hidden = false;
      /* 换 src 让浏览器重新请求；onload 里的时间戳由计时器兜底 */
      frame.src = url;
      win.setTitle('Browser — ' + (host || 'new tab'));

      timer = setTimeout(() => {
        /* onload 会在上面清掉这个计时器；能走到这里说明没加载出来 */
        frame.hidden = true;
        showBlock(url, 'timeout');
      }, BROWSER.LOAD_TIMEOUT);
    }

    /* kind: 'blocked' 预判被拒 / 'timeout' 超时 / 'bad' 地址非法 */
    function showBlock(url, kind) {
      clearTimeout(timer);
      block.hidden = false;
      block.classList.remove('is-home');

      const TITLE = {
        blocked: 'This site blocks embedding',
        timeout: 'Nothing loaded — likely blocked',
        bad: 'That address will not open'
      };
      const NOTE = {
        blocked: '',
        timeout:
          ' 常见原因是站点发了 <code>X-Frame-Options</code> 或 CSP <code>frame-ancestors</code>，' +
          '也可能是地址写错了、或者网络连不上。',
        bad: ' 只能打开 <code>https://</code> 或 <code>http://</code> 开头的普通网页。'
      };

      $('[data-block-title]').textContent = TITLE[kind] || TITLE.timeout;
      $('[data-block-text]').innerHTML = '<code>' + esc(url) + '</code> 没有在框里打开。' + (NOTE[kind] || '');
      block.querySelector('.brw-block-ico').innerHTML = ICON.external;
      /* 起始页会把 actions 换成快捷格，这里必须还原，否则从起始页
         开一个失败地址后，CTA 按钮就再也回不来了 */
      block.querySelector('.brw-block-actions').innerHTML =
        '<button class="brw-cta" type="button" data-act="external">Open in real browser</button>' +
        '<button class="brw-cta ghost" type="button" data-act="home">Go home</button>';
      say(kind === 'bad' ? 'invalid address' : 'blocked — open it outside');
    }

    frame.addEventListener('load', () => {
      clearTimeout(timer);
      /* 真的加载出来了：收掉遮罩，把 iframe 放出来。
         注意 load 在 about:blank 上也会触发，所以只在有 src 时算数。 */
      if (!frame.getAttribute('src')) return;
      block.hidden = true;
      block.classList.remove('is-home');
      frame.hidden = false;
      say('loaded');
      /* 跨域时 contentDocument 为 null，读不到标题，只能拿 host 凑 */
      try {
        const t = frame.contentDocument && frame.contentDocument.title;
        if (t) win.setTitle('Browser — ' + t);
      } catch (e) {
        /* 跨域，忽略 */
      }
    });

    /* ---------- 地址栏 ---------- */
    const form = $('.brw-addr-wrap');
    form.addEventListener('submit', (e) => {
      e.preventDefault();
      const url = BROWSER.normalize(addr.value);
      if (!url) return;
      addr.blur();
      load(url);
    });
    addr.addEventListener('focus', () => addr.select());

    /* ---------- 按钮 ---------- */
    body.addEventListener('click', (e) => {
      const btn = e.target.closest('[data-act]');
      if (btn) {
        const act = btn.dataset.act;
        if (act === 'back') {
          if (stack.i > 0) {
            stack.i -= 1;
            load(stack.list[stack.i], false);
            say('back');
          } else say('no history');
        } else if (act === 'fwd') {
          if (stack.i < stack.list.length - 1) {
            stack.i += 1;
            load(stack.list[stack.i], false);
            say('forward');
          } else say('no history');
        } else if (act === 'reload') {
          if (current) {
            const u = current;
            /* 先清 src 再设回来，强制重新请求 */
            frame.removeAttribute('src');
            requestAnimationFrame(() => load(u, false));
          }
        } else if (act === 'home') {
          goHome();
        } else if (act === 'star') {
          if (!current) return say('nothing to bookmark');
          const on = BROWSER.toggleMark(current, BROWSER.hostOf(current));
          paintStar();
          paintMarks();
          say(on ? 'bookmarked' : 'removed');
        } else if (act === 'external') {
          const url = current || BROWSER.normalize(addr.value);
          if (!url) return say('no address');
          window.open(url, '_blank', 'noopener,noreferrer');
          say('opened in a real tab');
        } else if (act === 'closepanel') {
          showPanel(false);
        }
        return;
      }

      /* 点收藏项：直接加载 */
      const mark = e.target.closest('.brw-mark');
      if (mark && !e.target.closest('[data-del]')) {
        const m = BROWSER.bookmarks()[Number(mark.dataset.i)];
        if (m) {
          showPanel(false);
          load(m.url);
        }
        return;
      }

      /* 删收藏 */
      const del = e.target.closest('[data-del]');
      if (del) {
        e.stopPropagation();
        const list = BROWSER.bookmarks();
        const m = list[Number(del.dataset.del)];
        if (m) {
          BROWSER.toggleMark(m.url, m.title);
          paintMarks();
          paintStar();
        }
      }
    });

    /* 点状态栏也能拉开收藏夹 —— 省一个工具栏按钮的位置 */
    $('.brw-status').addEventListener('click', () => showPanel(panel.hidden));

    /* ---------- 起始页 ---------- */
    /* goHome 会清掉历史栈 —— 否则点过 Home 再点 Back，
       会载回上一页，但 current / 地址栏还停在空态，界面就自相矛盾了。 */
    function goHome() {
      clearTimeout(timer);
      showPanel(false);
      frame.removeAttribute('src');
      frame.hidden = true;
      stack.list = [];
      stack.i = -1;
      current = '';
      addr.value = '';
      stHost.textContent = '—';
      starBtn.innerHTML = ICON.star;
      starBtn.classList.remove('on');
      win.setTitle('Browser');
      say('new tab');
      homeScreen();
    }

    function homeScreen() {
      const marks = BROWSER.bookmarks().slice(0, 6);
      const tiles = marks.length
        ? marks
            .map(
              (m, i) =>
                `<button class="brw-tile" type="button" data-tile="${i}">
                   <span class="brw-tile-ico">${ICON.browser}</span>
                   <b>${esc(m.title)}</b>
                 </button>`
            )
            .join('')
        : ['example.com', 'developer.mozilla.org', 'duckduckgo.com']
            .map(
              (h) =>
                `<button class="brw-tile" type="button" data-suggest="${h}">
                   <span class="brw-tile-ico">${ICON.browser}</span>
                   <b>${esc(h)}</b>
                 </button>`
            )
            .join('');

      /* 起始页复用 block 那层容器，样式一致，省一套 CSS */
      block.hidden = false;
      block.classList.add('is-home');
      block.querySelector('.brw-block-ico').innerHTML = ICON.browser;
      $('[data-block-title]').textContent = 'Where to?';
      $('[data-block-text]').innerHTML =
        'Type an address above, or pick something below. ' +
        'Sites that block embedding will offer a one-click handoff to your real browser.';
      block.querySelector('.brw-block-actions').innerHTML = '<div class="brw-tiles">' + tiles + '</div>';
    }

    /* 起始页里的快捷格是动态生成的，外层 [data-act] 委托管不到，
       这里单独接一层。注意 block 是 body 的子孙，事件会冒泡到上面的
       [data-act] 处理器 —— 所以只认带 data-suggest / data-tile 的点击，
       带 data-act 的（Go home / Open in real browser）直接放行给上层。 */
    block.addEventListener('click', (e) => {
      if (e.target.closest('[data-act]')) return;
      if (!block.classList.contains('is-home')) return;
      const s = e.target.closest('[data-suggest]');
      if (s) return load(BROWSER.normalize(s.dataset.suggest));
      const t = e.target.closest('[data-tile]');
      if (t) {
        const m = BROWSER.bookmarks()[Number(t.dataset.tile)];
        if (m) load(m.url);
      }
    });

    /* 外部（Spotlight / 菜单 / 链接）可以带着网址进来。
       窗口已经开着时会复用，由 openApp 调这个 navigate 换地址。 */
    win.navigate = (url) => {
      const u = BROWSER.normalize(url);
      if (u) load(u, true);
    };

    /* 直接进地址就直接开，不进起始页 */
    if (start) load(start, true);
    else goHome();
  }
};

/* ============================================================ */
/*  Games + Dev tools (canvas / fetch)                           */
/* ============================================================ */

/* 只在本窗口聚焦且还挂在 DOM 上时才接管键盘，避免抢别的窗口的键。 */
function gameFocusGuard(body) {
  const win = body.closest('.window');
  return () => !!(win && win.classList.contains('focused') && body.isConnected);
}

/* 窗口关掉后清掉挂在 document 上的监听器，避免泄漏。 */
function autoCleanup(body, fn) {
  const t = setInterval(() => {
    if (!body.isConnected) { clearInterval(t); fn(); }
  }, 400);
}

/* ---------------- Snake ---------------- */
const SnakeApp = {
  id: 'snake', name: 'Snake', icon: 'snake', width: 380, height: 470,
  mount(body) {
    body.innerHTML = `
      <div class="game-wrap">
        <div class="game-bar">
          <span class="game-title">Snake</span>
          <span class="game-score">Score: <b>0</b></span>
          <button class="game-btn" data-act="restart">Restart</button>
        </div>
        <div class="game-board"><canvas class="game-canvas" width="340" height="340"></canvas></div>
        <div class="game-hint">Arrows / WASD · eat the green dot · don't bite yourself</div>
      </div>`;
    const cv = body.querySelector('.game-canvas');
    const boardEl = body.querySelector('.game-board');
    const ctx = cv.getContext('2d');
    const scoreEl = body.querySelector('.game-score b');
    const N = 17;
    let S = 20, snake, dir, nextDir, food, score, alive, timer;

    const fit = () => {
      const w = boardEl.clientWidth, h = boardEl.clientHeight;
      if (!w || !h) return;
      const size = Math.max(60, Math.min(w, h));
      if (size === cv.width) { draw(); return; }
      cv.width = cv.height = size; S = size / N; draw();
    };

    const randFood = () => {
      let p;
      do { p = { x: (Math.random() * N) | 0, y: (Math.random() * N) | 0 }; }
      while (snake && snake.some((s) => s.x === p.x && s.y === p.y));
      return p;
    };
    const draw = () => {
      ctx.fillStyle = '#0a0a0e'; ctx.fillRect(0, 0, cv.width, cv.height);
      ctx.strokeStyle = 'rgba(255,255,255,0.05)';
      for (let i = 0; i <= N; i++) {
        ctx.beginPath(); ctx.moveTo(i * S, 0); ctx.lineTo(i * S, cv.height); ctx.stroke();
        ctx.beginPath(); ctx.moveTo(0, i * S); ctx.lineTo(cv.width, i * S); ctx.stroke();
      }
      ctx.fillStyle = '#27f08a';
      ctx.fillRect(food.x * S + 3, food.y * S + 3, S - 6, S - 6);
      snake.forEach((s, i) => {
        ctx.fillStyle = i === 0 ? '#6ea8fe' : '#3b6ea5';
        ctx.fillRect(s.x * S + 1, s.y * S + 1, S - 2, S - 2);
      });
      if (!alive) {
        ctx.fillStyle = 'rgba(0,0,0,0.62)'; ctx.fillRect(0, 0, cv.width, cv.height);
        ctx.fillStyle = '#fff'; ctx.font = 'bold 22px monospace'; ctx.textAlign = 'center';
        ctx.fillText('Game Over', cv.width / 2, cv.height / 2);
      }
    };
    const reset = () => {
      snake = [{ x: 8, y: 8 }, { x: 7, y: 8 }, { x: 6, y: 8 }];
      dir = { x: 1, y: 0 }; nextDir = dir; food = randFood();
      score = 0; alive = true; scoreEl.textContent = '0'; draw();
    };
    const step = () => {
      if (!alive) return;
      dir = nextDir;
      const head = { x: snake[0].x + dir.x, y: snake[0].y + dir.y };
      if (head.x < 0 || head.y < 0 || head.x >= N || head.y >= N ||
          snake.some((s) => s.x === head.x && s.y === head.y)) { alive = false; draw(); return; }
      snake.unshift(head);
      if (head.x === food.x && head.y === food.y) { score++; scoreEl.textContent = String(score); food = randFood(); }
      else snake.pop();
      draw();
    };
    const onKey = (e) => {
      if (!alive) return;
      const k = e.key.toLowerCase();
      let nd = null;
      if (k === 'arrowup' || k === 'w') nd = { x: 0, y: -1 };
      else if (k === 'arrowdown' || k === 's') nd = { x: 0, y: 1 };
      else if (k === 'arrowleft' || k === 'a') nd = { x: -1, y: 0 };
      else if (k === 'arrowright' || k === 'd') nd = { x: 1, y: 0 };
      if (!nd) return;
      if (nd.x === -dir.x && nd.y === -dir.y) return; /* no reversing */
      nextDir = nd; e.preventDefault();
    };
    const guard = gameFocusGuard(body);
    const docKey = (e) => { if (!guard()) return; onKey(e); };
    document.addEventListener('keydown', docKey);
    window.addEventListener('resize', fit);
    const ro = new ResizeObserver(() => fit());
    ro.observe(boardEl);
    body.querySelector('[data-act="restart"]').addEventListener('click', reset);
    reset(); fit();
    timer = setInterval(() => {
      if (!body.isConnected) { clearInterval(timer); document.removeEventListener('keydown', docKey); ro.disconnect(); return; }
      step();
    }, 120);
  }
};

/* ---------------- 2048 ---------------- */
const Game2048App = {
  id: 'g2048', name: '2048', icon: 'g2048', width: 380, height: 470,
  mount(body) {
    body.innerHTML = `
      <div class="game-wrap">
        <div class="game-bar">
          <span class="game-title">2048</span>
          <span class="game-score">Score: <b>0</b></span>
          <button class="game-btn" data-act="restart">Restart</button>
        </div>
        <div class="game-board"><canvas class="game-canvas" width="340" height="340"></canvas></div>
        <div class="game-hint">Arrows / WASD to slide tiles</div>
      </div>`;
    const cv = body.querySelector('.game-canvas');
    const boardEl = body.querySelector('.game-board');
    const ctx = cv.getContext('2d');
    const scoreEl = body.querySelector('.game-score b');
    const N = 4;
    let S = 85;

    const fit = () => {
      const w = boardEl.clientWidth, h = boardEl.clientHeight;
      if (!w || !h) return;
      const size = Math.max(60, Math.min(w, h));
      if (size === cv.width) { draw(); return; }
      cv.width = cv.height = size; S = size / N; draw();
    };
    const COLORS = { 2: '#3a3f4b', 4: '#4a5568', 8: '#7c5cff', 16: '#a855f7', 32: '#db2777',
      64: '#e11d48', 128: '#f59e0b', 256: '#fbbf24', 512: '#34d399', 1024: '#22d3ee', 2048: '#22c55e' };
    let grid, score, anim = false, raf = 0;

    const roundRect = (x, y, w, h, r) => {
      ctx.beginPath();
      ctx.moveTo(x + r, y); ctx.arcTo(x + w, y, x + w, y + h, r); ctx.arcTo(x + w, y + h, x, y + h, r);
      ctx.arcTo(x, y + h, x, y, r); ctx.arcTo(x, y, x + w, y, r); ctx.closePath();
    };

    /* 画一块方块（c/r 是格坐标；scale 用于合并 / 新生时"弹"一下） */
    const drawTile = (c, r, value, scale) => {
      const size = (S - 12) * scale;
      const cx = c * S + S / 2, cy = r * S + S / 2;
      ctx.fillStyle = COLORS[value] || '#22c55e';
      roundRect(cx - size / 2, cy - size / 2, size, size, 8 * scale); ctx.fill();
      if (value) {
        ctx.fillStyle = '#fff';
        ctx.font = 'bold ' + Math.round((value < 100 ? 30 : value < 1000 ? 26 : 20) * scale) + 'px monospace';
        ctx.textAlign = 'center'; ctx.textBaseline = 'middle';
        ctx.fillText(String(value), cx, cy);
      }
    };

    /* 空格底槽：只在盘面为 0 的位置画 */
    const drawSlots = (g) => {
      for (let r = 0; r < N; r++) for (let c = 0; c < N; c++) {
        if (!g[r][c]) {
          ctx.fillStyle = '#1a1d27';
          roundRect(c * S + 6, r * S + 6, S - 12, S - 12, 8); ctx.fill();
        }
      }
    };

    /* 静态绘制。scaleMap: "r,c" -> 缩放，给被合并 / 新生的格子用 */
    const draw = (scaleMap) => {
      ctx.fillStyle = '#11131a'; ctx.fillRect(0, 0, cv.width, cv.height);
      drawSlots(grid);
      for (let r = 0; r < N; r++) for (let c = 0; c < N; c++) {
        const v = grid[r][c];
        if (!v) continue;
        const sc = scaleMap ? (scaleMap.get(r + ',' + c) || 1) : 1;
        drawTile(c, r, v, sc);
      }
    };

    const addTile = () => {
      const empty = [];
      for (let r = 0; r < N; r++) for (let c = 0; c < N; c++) if (!grid[r][c]) empty.push([r, c]);
      if (!empty.length) return null;
      const [r, c] = empty[(Math.random() * empty.length) | 0];
      grid[r][c] = Math.random() < 0.9 ? 2 : 4;
      return { r, c };
    };

    /* 把行/列切成"从移动方向起排"的格子序列 */
    const linesFor = (d) => {
      const lines = [];
      if (d === 'left' || d === 'right') {
        for (let r = 0; r < N; r++) {
          const line = [];
          for (let i = 0; i < N; i++) line.push({ r, c: d === 'left' ? i : N - 1 - i });
          lines.push(line);
        }
      } else {
        for (let c = 0; c < N; c++) {
          const line = [];
          for (let i = 0; i < N; i++) line.push({ r: d === 'up' ? i : N - 1 - i, c });
          lines.push(line);
        }
      }
      return lines;
    };

    /* 只计算不改 grid：目标盘面 + 每块方块的滑动轨迹 + 合并格 + 得分 */
    const computeMove = (d) => {
      const next = Array.from({ length: N }, () => Array(N).fill(0));
      const anims = [], mergedCells = [];
      let gained = 0, moved = false;
      for (const line of linesFor(d)) {
        const tiles = [];
        for (const p of line) if (grid[p.r][p.c]) tiles.push({ value: grid[p.r][p.c], r: p.r, c: p.c });
        let outIdx = 0;
        for (let i = 0; i < tiles.length; i++) {
          const t = tiles[i], nx = tiles[i + 1], to = line[outIdx];
          anims.push({ value: t.value, fromR: t.r, fromC: t.c, toR: to.r, toC: to.c });
          if (nx && nx.value === t.value) {
            anims.push({ value: nx.value, fromR: nx.r, fromC: nx.c, toR: to.r, toC: to.c });
            next[to.r][to.c] = t.value * 2;
            gained += t.value * 2;
            mergedCells.push({ r: to.r, c: to.c });
            i++; /* 两块合成一块 */
          } else {
            next[to.r][to.c] = t.value;
          }
          outIdx++;
        }
      }
      moved = mergedCells.length > 0 || anims.some((a) => a.fromR !== a.toR || a.fromC !== a.toC);
      return { next, anims, mergedCells, gained, moved };
    };

    /* 滑动帧：按缓动把每块从 from 插值到 to（合并的两块一起滑到同一格） */
    const renderSlide = (plan, e) => {
      ctx.fillStyle = '#11131a'; ctx.fillRect(0, 0, cv.width, cv.height);
      drawSlots(plan.next);
      for (const a of plan.anims) {
        const r = a.fromR + (a.toR - a.fromR) * e;
        const c = a.fromC + (a.toC - a.fromC) * e;
        drawTile(c, r, a.value, 1);
      }
    };

    /* 合并 / 新生之后的"弹一下" */
    const runPop = (keys) => {
      if (!keys.length) return;
      const dur = 150, t0 = performance.now();
      const step = (now) => {
        const t = Math.min(1, (now - t0) / dur);
        const sc = t < 0.5 ? 1 + (t / 0.5) * 0.12 : 1.12 - ((t - 0.5) / 0.5) * 0.12;
        const map = new Map();
        for (const k of keys) map.set(k, sc);
        draw(map);
        if (t < 1) raf = requestAnimationFrame(step);
        else draw();
      };
      raf = requestAnimationFrame(step);
    };

    const move = (d) => {
      if (anim) return; /* 滑动这一拍里不吃新输入 */
      const plan = computeMove(d);
      if (!plan.moved) return;
      anim = true;
      score += plan.gained;
      scoreEl.textContent = String(score);
      cancelAnimationFrame(raf);

      const dur = 130, t0 = performance.now();
      const step = (now) => {
        const t = Math.min(1, (now - t0) / dur);
        const e = 1 - Math.pow(1 - t, 3); /* ease-out cubic */
        renderSlide(plan, e);
        if (t < 1) { raf = requestAnimationFrame(step); return; }
        grid = plan.next;
        anim = false;
        const born = addTile();
        const keys = plan.mergedCells.map((m) => m.r + ',' + m.c);
        if (born) keys.push(born.r + ',' + born.c);
        draw();
        runPop(keys);
      };
      raf = requestAnimationFrame(step);
    };
    const onKey = (e) => {
      const k = e.key.toLowerCase();
      let d = null;
      if (k === 'arrowup' || k === 'w') d = 'up';
      else if (k === 'arrowdown' || k === 's') d = 'down';
      else if (k === 'arrowleft' || k === 'a') d = 'left';
      else if (k === 'arrowright' || k === 'd') d = 'right';
      if (!d) return;
      e.preventDefault(); move(d);
    };
    const guard = gameFocusGuard(body);
    const docKey = (e) => { if (!guard()) return; onKey(e); };
    document.addEventListener('keydown', docKey);
    const reset = () => {
      cancelAnimationFrame(raf); anim = false;
      grid = Array.from({ length: N }, () => Array(N).fill(0));
      score = 0; scoreEl.textContent = '0'; addTile(); addTile(); draw();
    };
    body.querySelector('[data-act="restart"]').addEventListener('click', reset);
    grid = Array.from({ length: N }, () => Array(N).fill(0));
    score = 0; fit(); addTile(); addTile(); draw();
    const ro = new ResizeObserver(() => fit());
    ro.observe(boardEl);
    const cleanup = () => { document.removeEventListener('keydown', docKey); ro.disconnect(); };
    autoCleanup(body, cleanup);
  }
};

/* ---------------- Minesweeper ---------------- */
const MinesApp = {
  id: 'mine', name: 'Minesweeper', icon: 'mine', width: 380, height: 440,
  mount(body) {
    body.innerHTML = `
      <div class="game-wrap">
        <div class="game-bar">
          <span class="game-title">Mines</span>
          <span class="game-score">Mines: <b>40</b></span>
          <button class="game-btn" data-act="restart">New</button>
        </div>
        <div class="game-board"><canvas class="game-canvas" width="340" height="340"></canvas></div>
        <div class="game-hint">Left-click reveal · Right-click flag</div>
      </div>`;
    const cv = body.querySelector('.game-canvas');
    const boardEl = body.querySelector('.game-board');
    const ctx = cv.getContext('2d');
    const N = 17, MINES = 40;
    let S = 20, board, revealed, flagged, dead, cleared, minesPlaced;

    const fit = () => {
      const w = boardEl.clientWidth, h = boardEl.clientHeight;
      if (!w || !h) return;
      const size = Math.max(60, Math.min(w, h));
      if (size === cv.width) { draw(); return; }
      cv.width = cv.height = size; S = size / N; draw();
    };

    const reset = () => {
      board = Array.from({ length: N }, () => Array(N).fill(0));
      revealed = Array.from({ length: N }, () => Array(N).fill(false));
      flagged = Array.from({ length: N }, () => Array(N).fill(false));
      dead = false; cleared = false; minesPlaced = false;
      draw();
    };

    /* 首次点击后才布雷，且保证点击格及其 8 邻格都不是雷，避免第一下就踩雷。 */
    const placeMines = (sr, sc) => {
      const safe = new Set();
      for (let dr = -1; dr <= 1; dr++) for (let dc = -1; dc <= 1; dc++) {
        const rr = sr + dr, cc = sc + dc;
        if (rr >= 0 && cc >= 0 && rr < N && cc < N) safe.add(rr * N + cc);
      }
      let placed = 0;
      while (placed < MINES) {
        const r = (Math.random() * N) | 0, c = (Math.random() * N) | 0;
        const idx = r * N + c;
        if (board[r][c] !== -1 && !safe.has(idx)) { board[r][c] = -1; placed++; }
      }
      for (let r = 0; r < N; r++) for (let c = 0; c < N; c++) if (board[r][c] !== -1) {
        let n = 0;
        for (let dr = -1; dr <= 1; dr++) for (let dc = -1; dc <= 1; dc++) {
          const rr = r + dr, cc = c + dc;
          if (rr >= 0 && cc >= 0 && rr < N && cc < N && board[rr][cc] === -1) n++;
        }
        board[r][c] = n;
      }
      minesPlaced = true;
    };
    const draw = () => {
      ctx.fillStyle = '#11131a'; ctx.fillRect(0, 0, cv.width, cv.height);
      for (let r = 0; r < N; r++) for (let c = 0; c < N; c++) {
        const x = c * S, y = r * S;
        if (revealed[r][c]) {
          ctx.fillStyle = '#232733'; ctx.fillRect(x + 1, y + 1, S - 2, S - 2);
          const v = board[r][c];
          if (v === -1) { ctx.fillStyle = '#e11d48'; ctx.fillRect(x + 1, y + 1, S - 2, S - 2); }
          else if (v > 0) {
            ctx.fillStyle = '#9fb3c8'; ctx.font = 'bold 13px monospace';
            ctx.textAlign = 'center'; ctx.textBaseline = 'middle';
            ctx.fillText(String(v), x + S / 2, y + S / 2);
          }
        } else {
          ctx.fillStyle = flagged[r][c] ? '#3a2f1a' : '#2b3040';
          ctx.fillRect(x + 1, y + 1, S - 2, S - 2);
          if (flagged[r][c]) {
            ctx.fillStyle = '#fbbf24'; ctx.font = '13px monospace';
            ctx.textAlign = 'center'; ctx.textBaseline = 'middle';
            ctx.fillText('⚑', x + S / 2, y + S / 2);
          }
        }
      }
      if (dead) { ctx.fillStyle = 'rgba(0,0,0,0.55)'; ctx.fillRect(0, 0, cv.width, cv.height); ctx.fillStyle = '#fff'; ctx.font = 'bold 22px monospace'; ctx.textAlign = 'center'; ctx.fillText('Boom!', cv.width / 2, cv.height / 2); }
      if (cleared) { ctx.fillStyle = 'rgba(0,0,0,0.55)'; ctx.fillRect(0, 0, cv.width, cv.height); ctx.fillStyle = '#22c55e'; ctx.font = 'bold 22px monospace'; ctx.textAlign = 'center'; ctx.fillText('Cleared!', cv.width / 2, cv.height / 2); }
    };
    const flood = (sr, sc) => {
      const stack = [[sr, sc]];
      while (stack.length) {
        const [y, x] = stack.pop();
        if (y < 0 || x < 0 || y >= N || x >= N || revealed[y][x] || flagged[y][x]) continue;
        revealed[y][x] = true;
        if (board[y][x] === 0) for (let dr = -1; dr <= 1; dr++) for (let dc = -1; dc <= 1; dc++) stack.push([y + dr, x + dc]);
      }
    };
    const reveal = (r, c) => {
      if (dead || cleared || flagged[r][c] || revealed[r][c]) return;
      if (!minesPlaced) placeMines(r, c);
      if (board[r][c] === -1) { dead = true; revealed[r][c] = true; draw(); return; }
      flood(r, c); draw();
      let ok = true;
      for (let rr = 0; rr < N; rr++) for (let cc = 0; cc < N; cc++) if (board[rr][cc] !== -1 && !revealed[rr][cc]) ok = false;
      if (ok) cleared = true;
    };
    const cell = (e) => {
      const rect = cv.getBoundingClientRect();
      const sx = cv.width / rect.width, sy = cv.height / rect.height;
      return [((e.clientX - rect.left) * sx / S) | 0, ((e.clientY - rect.top) * sy / S) | 0];
    };
    cv.addEventListener('click', (e) => {
      if (!body.isConnected) return;
      const [c, r] = cell(e);
      if (r >= 0 && c >= 0 && r < N && c < N) reveal(r, c);
    });
    cv.addEventListener('contextmenu', (e) => {
      e.preventDefault();
      if (!body.isConnected) return;
      const [c, r] = cell(e);
      if (r >= 0 && c >= 0 && r < N && c < N && !revealed[r][c]) { flagged[r][c] = !flagged[r][c]; draw(); }
    });
    body.querySelector('[data-act="restart"]').addEventListener('click', reset);
    const ro = new ResizeObserver(() => fit());
    ro.observe(boardEl);
    reset(); fit();
    autoCleanup(body, () => ro.disconnect());
  }
};

/* ---------------- API Tester (mini Postman) ---------------- */
const ApiApp = {
  id: 'api', name: 'API Tester', icon: 'api', width: 580, height: 500,
  mount(body) {
    body.innerHTML = `
      <div class="api">
        <div class="api-row">
          <div class="api-dd">
            <button class="api-dd-btn" type="button" aria-haspopup="listbox" aria-expanded="false">
              <span class="api-dd-cur">GET</span><span class="api-dd-car">▾</span>
            </button>
            <div class="api-dd-list" role="listbox" hidden>
              <button class="api-dd-opt is-on" type="button" role="option" data-m="GET">GET</button>
              <button class="api-dd-opt" type="button" role="option" data-m="POST">POST</button>
              <button class="api-dd-opt" type="button" role="option" data-m="PUT">PUT</button>
              <button class="api-dd-opt" type="button" role="option" data-m="DELETE">DELETE</button>
              <button class="api-dd-opt" type="button" role="option" data-m="PATCH">PATCH</button>
            </div>
          </div>
          <input class="api-url" type="text" spellcheck="false"
            placeholder="https://httpbin.org/get" value="https://httpbin.org/get" />
          <button class="api-send">Send</button>
        </div>
        <details class="api-det"><summary>Headers (JSON)</summary>
          <textarea class="api-headers" spellcheck="false">{}</textarea></details>
        <details class="api-det"><summary>Body (JSON / text)</summary>
          <textarea class="api-body" spellcheck="false"></textarea></details>
        <div class="api-resp">
          <div class="api-meta"></div>
          <pre class="api-out"></pre>
        </div>
        <div class="api-note">浏览器的 CORS 会拦大部分跨域请求。试试 httpbin.org 或 jsonplaceholder.typicode.com。</div>
      </div>`;
    const $ = (s) => body.querySelector(s);
    const urlEl = $('.api-url'), headersEl = $('.api-headers'),
      bodyEl = $('.api-body'), sendBtn = $('.api-send'), metaEl = $('.api-meta'), outEl = $('.api-out');

    /* 自绘下拉：不用浏览器原生 <select>，换成跟系统同一套材质风格的浮层菜单 */
    let method = 'GET';
    const dd = $('.api-dd'), ddBtn = $('.api-dd-btn'), ddCur = $('.api-dd-cur'), ddList = $('.api-dd-list');
    const closeDd = () => { ddList.hidden = true; dd.classList.remove('open'); ddBtn.setAttribute('aria-expanded', 'false'); };
    const openDd = () => { ddList.hidden = false; dd.classList.add('open'); ddBtn.setAttribute('aria-expanded', 'true'); };
    ddBtn.addEventListener('click', (e) => { e.stopPropagation(); if (ddList.hidden) openDd(); else closeDd(); });
    ddList.addEventListener('click', (e) => {
      const opt = e.target.closest('.api-dd-opt');
      if (!opt) return;
      method = opt.dataset.m;
      ddCur.textContent = method;
      ddList.querySelectorAll('.api-dd-opt').forEach((o) => o.classList.toggle('is-on', o === opt));
      closeDd();
    });
    const outsideDd = (e) => { if (!e.target.closest('.api-dd')) closeDd(); };
    document.addEventListener('click', outsideDd);
    autoCleanup(body, () => document.removeEventListener('click', outsideDd));

    const send = async () => {
      const url = urlEl.value.trim();
      if (!url) { metaEl.textContent = 'URL 不能为空'; return; }
      let headers = {};
      try { headers = JSON.parse(headersEl.value || '{}'); }
      catch (err) { metaEl.textContent = 'Headers 不是合法 JSON'; return; }
      const bodyText = bodyEl.value;
      metaEl.textContent = '请求中…'; outEl.textContent = '';
      const t0 = performance.now();
      try {
        const init = { method, headers };
        if (method !== 'GET' && method !== 'DELETE' && bodyText) init.body = bodyText;
        const res = await fetch(url, Object.assign(init, { mode: 'cors' }));
        const ms = Math.round(performance.now() - t0);
        const text = await res.text();
        metaEl.textContent = `${res.status} ${res.statusText} · ${ms} ms · ${text.length} B`;
        let pretty = text;
        try { pretty = JSON.stringify(JSON.parse(text), null, 2); } catch (e) { /* keep raw */ }
        if (pretty.length > 20000) pretty = pretty.slice(0, 20000) + '\n…(truncated)';
        outEl.textContent = pretty;
      } catch (err) {
        metaEl.textContent = '错误：' + err.message;
        outEl.textContent = 'CORS 或网络问题可能导致失败。试试支持 CORS 的公开 API（httpbin.org、jsonplaceholder）。';
      }
    };
    sendBtn.addEventListener('click', send);
    urlEl.addEventListener('keydown', (e) => { if (e.key === 'Enter') send(); });
  }
};

const APPS = {
  terminal: TerminalApp,
  files: FilesApp,
  editor: EditorApp,
  settings: SettingsApp,
  about: AboutApp,
  browser: BrowserApp,
  snake: SnakeApp,
  g2048: Game2048App,
  mine: MinesApp,
  api: ApiApp
};
