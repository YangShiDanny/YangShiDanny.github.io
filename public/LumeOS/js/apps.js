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
          ['open <app|url>', 'launch an app, or open a URL in the built-in browser'],
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
            完整键位表在菜单栏的 <b>TIPS</b>；Licence 原文在 <b>LICENCE</b>。
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
          <p class="about-tip">
            <a href="#ab-lic" role="button" data-act="openlicence">打开完整的 Licence 窗口 →</a>
          </p>
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
    /* 锚点跳转：默认 a[href="#id"] 会改 location.hash，
       在这个页面里等于把整个站点导航走 —— 必须拦下来改成滚动。
       注意顺序：动作按钮要先判，因为 <a href="#" data-act="..."> 同时命中两个分支。 */
    body.addEventListener('click', (e) => {
      if (e.target.closest('[data-act="openlicence"]')) {
        e.preventDefault();
        window.LumeOS.openApp('licence');
        return;
      }
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
          <iframe class="brw-frame" data-frame
                  referrerpolicy="no-referrer"
                  sandbox="allow-scripts allow-same-origin allow-forms allow-popups allow-popups-to-escape-sandbox"></iframe>
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

const APPS = {
  terminal: TerminalApp,
  files: FilesApp,
  editor: EditorApp,
  settings: SettingsApp,
  about: AboutApp,
  tips: TipsApp,
  licence: LicenceApp,
  browser: BrowserApp
};
