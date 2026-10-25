/* ============================================================
   应用定义：Terminal / Files / Editor / Settings / About
   每个应用提供 mount(body, win) —— 由窗口管理器调用。
   ============================================================ */

const esc = (s) =>
  String(s).replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));

const pad = (s, n) => String(s) + ' '.repeat(Math.max(0, n - String(s).length));
const fmtSize = (n) => (n < 1024 ? n + ' B' : (n / 1024).toFixed(1) + ' K');

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
          ['neofetch', 'system information'],
          ['theme <dark|light>', 'switch appearance'],
          ['wall <stars|grid|plain>', 'change wallpaper'],
          ['accent <#hex>', 'set the accent color'],
          ['date', 'current time'],
          ['uptime', 'how long this tab has been alive'],
          ['history', 'recent commands'],
          ['clear', 'clear the screen'],
          ['banner', 'print the logo'],
          ['exit', 'close this window']
        ];
        printDim('available commands');
        rows.forEach(([cmd, desc]) => print(`  <span class="u">${pad(cmd, 22)}</span><span class="dim">${esc(desc)}</span>`));
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
          print(`  <span class="u">${pad('lume run <file>', 22)}</span><span class="dim">解释执行，打印 say 的输出</span>`);
          print(`  <span class="u">${pad('lume build <file>', 22)}</span><span class="dim">生成 &lt;stem&gt;.c 写进工作目录</span>`);
          print(`  <span class="u">${pad('lume help', 22)}</span><span class="dim">this list</span>`);
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
  width: 660,
  height: 440,

  mount(body) {
    let cwd = LumeFS.HOME;

    body.innerHTML = `
      <div class="files">
        <aside class="files-side">
          <p class="files-root">Places</p>
          <button class="files-nav" data-go="/home/lume">${ICON.home}<span>Home</span></button>
          <button class="files-nav" data-go="/home/lume/work">${ICON.folder}<span>Work</span></button>
          <button class="files-nav" data-go="/etc">${ICON.folder}<span>System</span></button>
          <button class="files-nav" data-go="/var/log">${ICON.folder}<span>Logs</span></button>
        </aside>
        <div class="files-main"></div>
      </div>`;

    const main = body.querySelector('.files-main');
    const navs = Array.from(body.querySelectorAll('.files-nav'));

    const render = () => {
      const items = LumeFS.list(cwd);
      const crumbs = cwd.split('/').filter(Boolean);

      main.innerHTML =
        `<div class="files-crumbs"><b>lumeos</b>` +
        crumbs.map((c) => `<span>/</span><span>${esc(c)}</span>`).join('') +
        `</div>` +
        (items.length
          ? items
              .map(
                (i) => `
            <button class="files-row" data-path="${esc(i.path)}" data-type="${i.type}">
              ${i.type === 'dir' ? ICON.folder : ICON.file}
              <span>${esc(i.name)}</span>
              <span class="sz">${i.type === 'dir' ? '—' : fmtSize(LumeFS.size(i.path))}</span>
            </button>`
              )
              .join('')
          : `<div class="files-empty">this folder is empty</div>`);

      navs.forEach((n) => n.classList.toggle('active', n.dataset.go === cwd));
    };

    main.addEventListener('click', (e) => {
      const row = e.target.closest('.files-row');
      if (!row) return;
      if (row.dataset.type === 'dir') {
        cwd = row.dataset.path;
        render();
      } else {
        window.LumeOS.openApp('editor', { path: row.dataset.path });
      }
    });

    body.querySelector('.files-side').addEventListener('click', (e) => {
      const nav = e.target.closest('.files-nav');
      if (!nav) return;
      cwd = nav.dataset.go;
      render();
    });

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
          <button class="editor-btn run" type="button" data-act="run" title="Run (⌘⏎)" hidden>Run</button>
          <button class="editor-btn primary" type="button" data-act="save" title="Save (⌘S)">Save</button>
        </div>
        <div class="editor-wrap">
          <pre class="editor-code" aria-hidden="true" hidden><code></code></pre>
          <textarea class="editor-area" spellcheck="false" wrap="off" aria-label="Editor"></textarea>
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
    const syntax = !!(path && window.LumeHighlight && LumeHighlight.isLume(path));

    /* .lume 文件走语法高亮：文字画在下面的 <pre> 里，textarea 只负责输入和光标 */
    const paint = () => {
      if (!syntax) return;
      codeEl.innerHTML = LumeHighlight.render(area.value);
      codeBox.scrollTop = area.scrollTop;
      codeBox.scrollLeft = area.scrollLeft;
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
    });

    body.querySelector('[data-act="save"]').addEventListener('click', save);
    runBtn.addEventListener('click', run);
    body.querySelector('[data-act="close-out"]').addEventListener('click', () => {
      outPanel.hidden = true;
    });

    /* 自动缩进 / 括号配对 / 关键字补全（.lume 才启用代码行为） */
    if (window.LumeEdit) {
      LumeEdit.attach({ area, wrap, lang: isLume ? 'lume' : 'text' });
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
    };

    body.addEventListener('click', (e) => {
      const seg = e.target.closest('[data-set] button');
      if (seg) {
        const kind = seg.closest('[data-set]').dataset.set;
        const v = seg.dataset.v;
        if (kind === 'theme') OS.setTheme(v);
        if (kind === 'wall') OS.setWall(v);
        if (kind === 'accent') OS.setAccent(v);
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

const APPS = {
  terminal: TerminalApp,
  files: FilesApp,
  editor: EditorApp,
  settings: SettingsApp,
  about: AboutApp
};
