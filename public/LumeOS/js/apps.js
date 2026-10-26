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

  mount(body) {
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

    let cwd = LumeFS.HOME;
    const history = [];
    let histIdx = 0;
    /* py setup 正在下载时置位，防止用户连按回车开好几个 6.4MB 的请求 */
    const state = { pyBusy: false };

    const promptPath = () => {
      if (cwd === LumeFS.HOME) return '~';
      if (cwd.startsWith(LumeFS.HOME + '/')) return '~' + cwd.slice(LumeFS.HOME.length);
      return cwd;
    };

    const syncPrompt = () => {
      psPath.textContent = promptPath();
    };

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
          ['pwd', 'print working directory'],
          ['open <app>', 'launch an app (try: files, editor, about)'],
          ['lume <run|build> <file>', 'compile a .lume file in the browser'],
          ['py <setup|run|status>', 'install the Python runtime locally'],
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
          print('');
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
              return;
            }
            const m = rec.meta || {};
            const d = rec.at ? new Date(rec.at).toLocaleString() : '?';
            print(`<span class="dim">version  </span>Pyodide ${esc(m.version || PY.version)}`);
            print(`<span class="dim">size     </span>${human(m.size || PY.bytes)}`);
            print(`<span class="dim">source   </span>${esc(m.url || PY.direct)}`);
            print(`<span class="dim">stored   </span>${esc(d)}`);
            if (m.mirrored) printDim('(fetched through ' + (m.via || 'a proxy') + ')');
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
            /* 先量一下两条路谁快，省得盲选。只发 Range 取 1 字节，
               量的是连接 + 首字节，不真拉包。 */
            printDim(`probing sources…`);
            const probes = PY.sources.map((s) =>
              fetch(s.url, { headers: { Range: 'bytes=0-0' }, cache: 'no-store' })
                .then((r) => ({ s: s, ok: r.ok || r.status === 206 }))
                .catch(() => ({ s: s, ok: false }))
            );

            Promise.all(probes)
              .then((res) => {
                const alive = res.filter((r) => r.ok).map((r) => r.s);
                const order = alive.length ? alive.concat(PY.sources.filter((s) => !alive.includes(s))) : PY.sources;
                const pick = order[0];
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
                  printDim(`试一下：写到 work/hello.py，然后 <span class="u">py run work/hello.py</span>`);
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
          print(`<span class="err">py: the runtime is installed, but wiring it into the VM is not done yet.</span>`);
          printDim('`py setup` and `py status` work today; `py run` lands in a later pass.');
          return;
        }

        printDim(`py: unknown subcommand '${sub}' — try: py help`);
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
        const lines = [
          '<span class="u">lume</span>@lumeos',
          '<span class="dim">-----------</span>',
          `<span class="dim">OS      </span>${esc(info.os)}`,
          `<span class="dim">Kernel  </span>${esc(info.kernel)}`,
          `<span class="dim">Shell   </span>lumesh`,
          `<span class="dim">WM      </span>lume-wm`,
          `<span class="dim">Uptime  </span>${esc(info.uptime)}`,
          `<span class="dim">Apps    </span>${info.apps}`,
          `<span class="dim">Theme   </span>${esc(info.theme)}`
        ];
        logo.forEach((row, i) => {
          print(`<span class="u">${esc(row)}</span>   ${lines[i] || ''}`);
        });
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
      print(`<span class="dim">${esc(promptPath())} %</span> ${esc(line)}`);
      if (!line) return;

      history.push(line);
      histIdx = history.length;

      const parts = line.match(/(?:[^\s"]+|"[^"]*")+/g) || [];
      const cmd = parts[0].toLowerCase();
      const args = parts.slice(1).map((a) => a.replace(/^"|"$/g, ''));

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
          areaMenu(box.left - 60, box.bottom + 6);
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
      if (!isDir) items.push({ ico: 'duplicate', label: 'Duplicate', run: () => window.LumeOS.duplicate(path) });
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
          { ico: 'newfolder', label: 'New Folder', run: () => window.LumeOS.newItem(cwd(), 'dir') },
          '|',
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
    const KIND = { lume: 'lume', md: 'doc', markdown: 'doc' };

    const ext = path ? extOf(path) : '';
    const isLume = ext === 'lume';
    const isMd = !!(window.LumeMarkdown && (LumeMarkdown.isMarkdown(path) || window.LumeMarkdown.isMarkdown('.' + ext)));
    /* .lume 走 Lume 高亮，.md 走 Markdown 高亮，都是「pre 上色 + textarea 透明」双图层 */
    const syntax = !!(path && window.LumeHighlight && LumeHighlight.isLume(path)) || isMd;
    let previewing = false;

    const paint = () => {
      if (!syntax) return;
      codeEl.innerHTML = isMd && window.LumeMarkdown ? LumeMarkdown.render(area.value) : LumeHighlight.render(area.value);
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
    runBtn.hidden = !isLume;
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

    /* 在编辑器里直接跑：和终端 lume run 是同一个 VM */
    const run = () => {
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
      if (isLume) items.push({ ico: 'run', label: 'Run File', hint: '⌘⏎', run: run });
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
        sub: isLume ? 'lume source' : area.value.trim() ? 'text' : 'empty buffer',
        items: items
      });
    });

    body.querySelector('[data-act="save"]').addEventListener('click', save);
    runBtn.addEventListener('click', run);
    previewBtn.addEventListener('click', () => setPreview(!previewing));
    body.querySelector('[data-act="close-out"]').addEventListener('click', () => {
      outPanel.hidden = true;
    });

    /* 自动缩进 / 括号配对 / 关键字补全（.lume 才启用代码行为） */
    if (window.LumeEdit) {
      LumeEdit.attach({ area, wrap, lang: isLume ? 'lume' : isMd ? 'md' : 'text' });
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
  width: 580,
  height: 470,

  mount(body) {
    const OS = window.LumeOS;

    body.innerHTML = `
      <div class="settings">
        <section class="set-group">
          <p class="set-label">Appearance</p>
          <div class="set-row">
            <div><span class="name">Theme</span><span class="desc">Dark by default, light when the sun is up.</span></div>
            <div class="seg" data-set="theme">
              <button data-v="dark">Dark</button><button data-v="light">Light</button>
            </div>
          </div>
          <div class="set-row">
            <div><span class="name">Accent</span><span class="desc">Used by the terminal, dock and highlights.</span></div>
            <div class="swatches" data-set="accent">
              <button class="swatch" data-v="#33aaff" style="background:#33aaff" aria-label="Blue"></button>
              <button class="swatch" data-v="#a78bfa" style="background:#a78bfa" aria-label="Violet"></button>
              <button class="swatch" data-v="#34d399" style="background:#34d399" aria-label="Green"></button>
              <button class="swatch" data-v="#f472b6" style="background:#f472b6" aria-label="Pink"></button>
              <button class="swatch" data-v="#fbbf24" style="background:#fbbf24" aria-label="Amber"></button>
            </div>
          </div>
          <div class="set-row">
            <div><span class="name">Wallpaper</span><span class="desc">Sixty lines of canvas drawing stars.</span></div>
            <div class="seg" data-set="wall">
              <button data-v="stars">Stars</button><button data-v="grid">Grid</button><button data-v="plain">Plain</button>
            </div>
          </div>
        </section>

        <section class="set-group">
          <p class="set-label">System</p>
          <div class="set-row">
            <div><span class="name">Chinese IME</span><span class="desc">Type pinyin in any text field. Tap Shift alone to switch 中 / EN.</span></div>
            <div class="seg" data-set="ime">
              <button data-v="cn">中</button><button data-v="en">EN</button><button data-v="off">Off</button>
            </div>
          </div>
          <div class="set-row">
            <div><span class="name">About this system</span><span class="desc">Who built this, and why.</span></div>
            <div class="seg"><button data-act="about">Open</button></div>
          </div>
          <div class="set-row">
            <div><span class="name">Reset everything</span><span class="desc">Wipe local files, theme and preferences.</span></div>
            <div class="seg"><button data-act="reset">Reset</button></div>
          </div>
          <p class="set-note">Nothing here talks to a server. Everything you change lives in this browser's localStorage and disappears the moment you clear site data.</p>
        </section>
      </div>`;

    const sync = () => {
      const root = document.documentElement;
      const theme = root.dataset.theme || 'dark';
      const wall = root.dataset.wall || 'stars';
      const accent = getComputedStyle(root).getPropertyValue('--accent').trim();

      body.querySelectorAll('[data-set="theme"] button').forEach((b) => b.classList.toggle('on', b.dataset.v === theme));
      body.querySelectorAll('[data-set="wall"] button').forEach((b) => b.classList.toggle('on', b.dataset.v === wall));
      body.querySelectorAll('[data-set="accent"] .swatch').forEach((b) => b.classList.toggle('on', b.dataset.v === accent));

      const ime = window.LumeIME;
      const imeVal = !ime || !ime.on ? 'off' : ime.mode;
      body.querySelectorAll('[data-set="ime"] button').forEach((b) => b.classList.toggle('on', b.dataset.v === imeVal));
    };

    body.addEventListener('click', (e) => {
      const seg = e.target.closest('[data-set] button');
      if (seg) {
        const kind = seg.closest('[data-set]').dataset.set;
        const v = seg.dataset.v;
        if (kind === 'theme') OS.setTheme(v);
        if (kind === 'wall') OS.setWall(v);
        if (kind === 'accent') OS.setAccent(v);
        if (kind === 'ime' && window.LumeIME) {
          if (v === 'off') window.LumeIME.setOn(false);
          else {
            window.LumeIME.setOn(true);
            window.LumeIME.setMode(v);
          }
        }
        sync();
        return;
      }
      const act = e.target.closest('[data-act]');
      if (act) {
        if (act.dataset.act === 'about') OS.openApp('about');
        if (act.dataset.act === 'reset') {
          if (confirm('Reset LumeOS? Local files, theme and preferences will be wiped.')) {
            localStorage.clear();
            location.reload();
          }
        }
      }
    });

    window.addEventListener('themechange', sync);
    document.addEventListener('lume:ime', sync);
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
  width: 620,
  height: 400,

  mount(body) {
    const info = window.LumeOS.systemInfo();

    const ascii = [
      '██╗     ██╗   ██╗███╗   ███╗███████╗',
      '██║     ██║   ██║████╗ ████║██╔════╝',
      '██║     ██║   ██║██╔████╔██║█████╗  ',
      '██║     ██║   ██║██║╚██╔╝██║██╔══╝  ',
      '███████╗╚██████╔╝██║ ╚═╝ ██║███████╗',
      '╚══════╝ ╚═════╝ ╚═╝     ╚═╝╚══════╝'
    ].join('\n');

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

        <p class="about-foot">
          Build ${esc(info.build)} · made by 羊史 (Yangshi) · no frameworks, no build step, no telemetry.<br />
          A toy, but a careful one.
        </p>
      </div>`;
  }
};

/* ---------------------------------------------------------- */
/*  Tips                                                      */
/* ---------------------------------------------------------- */
const TIPS = [
  {
    k: 'Window',
    rows: [
      ['⌘K', 'Spotlight — jump to any app or file'],
      ['Drag', 'Move a window by its titlebar'],
      ['Double-click', 'The titlebar to maximize / restore'],
      ['Right-click', 'A Dock icon for New Window / Show All'],
      ['Drag on desktop', 'Rubber-band select multiple icons']
    ]
  },
  {
    k: 'Editor',
    rows: [
      ['⌘S', 'Save the current file'],
      ['⌘⇧V', 'Toggle Markdown preview'],
      ['⌘/', 'Toggle line comment (Lume)'],
      ['Tab / ⇧Tab', 'Indent or outdent the selection'],
      ['( [ { " \'', 'Closes itself; Backspace deletes the pair']
    ]
  },
  {
    k: 'Input',
    rows: [
      ['Shift', 'Switch Chinese / English'],
      ['Space', 'Commit the highlighted candidate'],
      ['1–9', 'Pick a candidate directly'],
      ['= / -', 'Next / previous candidate page'],
      ['⌨ tray icon', 'On-screen keyboard for touch or no-IME setups']
    ]
  },
  {
    k: 'Shell',
    rows: [
      ['help', 'List every command'],
      ['ls · cd · cat', 'Browse the pretend filesystem'],
      ['neofetch', 'System summary'],
      ['clear', 'Wipe the terminal']
    ]
  }
];

const TipsApp = {
  id: 'tips',
  name: 'Tips',
  icon: 'info',
  width: 560,
  height: 520,
  transient: true,   /* 不在 Dock 固定，只在菜单栏入口开窗 */

  mount(body) {
    body.innerHTML = `
      <div class="tips-doc">
        <div class="tips-head">
          <h2>Quick tips</h2>
          <p>The short version of everything that is not obvious.</p>
        </div>
        ${TIPS.map(
          (g) => `
          <section class="tips-group">
            <h3>${esc(g.k)}</h3>
            <dl>
              ${g.rows
                .map(
                  ([key, text]) =>
                    `<dt><kbd>${esc(key)}</kbd></dt><dd>${esc(text)}</dd>`
                )
                .join('')}
            </dl>
          </section>`
        ).join('')}
      </div>`;
  }
};

/* ---------------------------------------------------------- */
/*  Licence                                                   */
/* ---------------------------------------------------------- */
const LicenceApp = {
  id: 'licence',
  name: 'Licence',
  icon: 'about',
  width: 620,
  height: 540,
  transient: true,

  mount(body) {
    body.innerHTML = `
      <div class="lic-doc">
        <div class="lic-head">
          <h2>Licence &amp; credits</h2>
          <p>This site and LumeOS are personal work, shared so others can read the source.</p>
        </div>

        <section>
          <h3>Website content</h3>
          <p>
            The text, layout and images of this site are
            <b>© ${new Date().getFullYear()} Yangshi</b>, all rights reserved.
            You are welcome to read, quote with a link back, or learn from the code.
            Please do not republish the writing or the visual design as your own.
          </p>
        </section>

        <section>
          <h3>LumeOS source</h3>
          <p>
            The LumeOS code (HTML / CSS / JavaScript under
            <code>/LumeOS</code>) is released under the
            <b>MIT Licence</b>. Use it, fork it, ship it — just keep the
            copyright notice:
          </p>
          <pre class="lic-legal">MIT License

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
        </section>

        <section>
          <h3>Third-party</h3>
          <dl class="lic-credits">
            <dt>Input dictionary</dt>
            <dd>rime-ice (雾凇拼音) — MPL-2.0, compiled into a static JSON table.</dd>
            <dt>Cal Sans</dt>
            <dd>Display typeface by Cal.com — SIL Open Font License 1.1.</dd>
            <dt>Inter</dt>
            <dd>UI typeface by Rasmus Andersson — SIL Open Font License 1.1.</dd>
            <dt>Icons</dt>
            <dd>Hand-written inline SVG, MIT, no icon-font dependency.</dd>
          </dl>
        </section>

        <p class="lic-foot">
          LumeOS is a personal toy system. "Lume" and the star mark are not
          trademarks of anyone but me.
        </p>
      </div>`;
  }
};

const APPS = {
  terminal: TerminalApp,
  files: FilesApp,
  editor: EditorApp,
  settings: SettingsApp,
  about: AboutApp,
  tips: TipsApp,
  licence: LicenceApp
};
