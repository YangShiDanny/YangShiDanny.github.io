/* ============================================================
   LumeOS 内核
   开机序列 / 壁纸 / 光标 / 窗口管理 / Dock / 菜单 / Spotlight
   ============================================================ */

(function () {
  'use strict';

  const root = document.documentElement;
  const startedAt = Date.now();
  const BUILD = '2026.10.26';

  const $ = (sel, ctx) => (ctx || document).querySelector(sel);
  const $$ = (sel, ctx) => Array.from((ctx || document).querySelectorAll(sel));

  const el = {
    boot: $('#boot'),
    bootBar: $('#boot-bar'),
    bootLog: $('#boot-log'),
    desktop: $('#desktop'),
    windows: $('#windows'),
    deskIcons: $('#desk-icons'),
    dockInner: $('#dock-inner'),
    dockPower: $('#dock-power'),
    mbApp: $('#mb-app'),
    mbBack: $('#mb-back'),
    mbLogo: $('#mb-logo'),
    mbClock: $('#mb-clock'),
    mbSearch: $('#mb-search'),
    mbTheme: $('#mb-theme'),
    sysMenu: $('#sys-menu'),
    ctxMenu: $('#ctx-menu'),
    spot: $('#spotlight'),
    spotInput: $('#spot-input'),
    spotResults: $('#spot-results'),
    toasts: $('#toasts'),
    veil: $('#veil'),
    wallpaper: $('#wallpaper')
  };

  /* -------------------------------------------------------- */
  /*  壁纸：canvas 星点                                          */
  /* -------------------------------------------------------- */
  const wall = (function () {
    const canvas = el.wallpaper;
    const ctx = canvas.getContext('2d');
    const reduce = window.matchMedia('(prefers-reduced-motion: reduce)').matches;
    let stars = [];
    let raf = 0;
    let dpr = 1;

    function color() {
      return root.dataset.theme === 'light' ? [60, 60, 85] : [255, 255, 255];
    }

    function resize() {
      const w = window.innerWidth;
      const h = window.innerHeight;
      dpr = Math.min(window.devicePixelRatio || 1, 2);
      canvas.width = w * dpr;
      canvas.height = h * dpr;
      canvas.style.width = w + 'px';
      canvas.style.height = h + 'px';
      ctx.setTransform(dpr, 0, 0, dpr, 0, 0);

      const count = Math.min(300, Math.floor((w * h) / 5200));
      stars = [];
      for (let i = 0; i < count; i++) {
        stars.push({
          x: Math.random() * w,
          y: Math.random() * h,
          r: Math.random() * 1.3 + 0.35,
          a: Math.random() * 0.5 + 0.3,
          sp: Math.random() * 0.0016 + 0.0004,
          ph: Math.random() * Math.PI * 2
        });
      }
    }

    function draw(t) {
      const [r, g, b] = color();
      const w = window.innerWidth;
      const h = window.innerHeight;
      ctx.clearRect(0, 0, w, h);
      for (const s of stars) {
        const tw = s.a * (0.55 + 0.45 * Math.sin((t || 0) * s.sp + s.ph));
        ctx.beginPath();
        ctx.fillStyle = 'rgba(' + r + ',' + g + ',' + b + ',' + tw + ')';
        ctx.arc(s.x, s.y, s.r, 0, Math.PI * 2);
        ctx.fill();
      }
    }

    function loop(t) {
      draw(t);
      raf = requestAnimationFrame(loop);
    }

    function start() {
      cancelAnimationFrame(raf);
      if (reduce) draw(0);
      else raf = requestAnimationFrame(loop);
    }

    window.addEventListener('resize', () => {
      resize();
      if (reduce) draw(0);
    });
    window.addEventListener('themechange', () => {
      if (reduce) draw(0);
    });

    resize();
    start();
    return { redraw: () => draw(0) };
  })();

  /* -------------------------------------------------------- */
  /*  光标                                                      */
  /* -------------------------------------------------------- */
  (function cursor() {
    const dot = $('#cursor');
    const ring = $('#cursor-ring');
    if (!dot || !ring || window.matchMedia('(pointer: coarse)').matches) return;

    let mx = innerWidth / 2;
    let my = innerHeight / 2;
    let rx = mx;
    let ry = my;
    let mode = 'idle';

    window.addEventListener('mousemove', (e) => {
      mx = e.clientX;
      my = e.clientY;
      dot.style.left = mx + 'px';
      dot.style.top = my + 'px';
      dot.classList.remove('is-hidden');
      ring.classList.remove('is-hidden');
    });
    document.addEventListener('mouseleave', () => {
      dot.classList.add('is-hidden');
      ring.classList.add('is-hidden');
    });

    (function animate() {
      rx += (mx - rx) * 0.2;
      ry += (my - ry) * 0.2;
      ring.style.left = rx + 'px';
      ring.style.top = ry + 'px';
      requestAnimationFrame(animate);
    })();

    function setMode(next) {
      if (next === mode) return;
      mode = next;
      dot.classList.toggle('is-text', next === 'text');
      dot.classList.toggle('is-link', next === 'link');
      ring.classList.toggle('is-link', next === 'link');
    }

    /* 元素自身是否直接含可见文字（不含子元素里的文字） */
    function hasOwnText(node) {
      for (let n = node.firstChild; n; n = n.nextSibling) {
        if (n.nodeType === 3 && n.nodeValue.trim()) return true;
      }
      return false;
    }

    /* 文本类标签，即使文字在子节点里也算（如 <p><a>…</a></p> 的外层已归链接） */
    const TEXT_TAGS = /^(p|h[1-6]|span|li|code|pre|label|small|strong|em|b|i|td|th|dd|dt|blockquote)$/i;

    function modeFor(t) {
      if (!(t instanceof Element)) return 'idle';

      if (
        t.closest(
          'a,button,[role="button"],summary,label,' +
            '.dock-item,.dock-power,.desk-icon,.menu-item,.win-light,.mb-btn,' +
            '.seg,.swatch,.primary,.editor-btn,.files-row,.set-row,.veil-btn,.back'
        )
      ) {
        return 'link';
      }
      if (t.closest('textarea,select,input,[contenteditable="true"]')) return 'text';
      if (t.closest('.win-resize')) return 'idle';
      /* 标题栏是拖拽区，保持原点 */
      if (t.closest('.win-titlebar,.mb-clock,.menubar')) return 'idle';

      /* 文字上竖线：自身带文字，或位于文本标签内 */
      if (hasOwnText(t)) return 'text';
      if (TEXT_TAGS.test(t.tagName) && t.textContent.trim()) return 'text';

      return 'idle';
    }

    /* 光标本体 pointer-events:none，e.target 始终是它底下的真实元素 */
    window.addEventListener(
      'mousemove',
      (e) => setMode(modeFor(e.target)),
      { passive: true }
    );
    document.addEventListener('mouseover', (e) => setMode(modeFor(e.target)));
    /* 拖拽/滚动/内容变化后指针不动也要刷新状态 */
    window.addEventListener('scroll', () => setMode(modeFor(document.elementFromPoint(mx, my))), {
      passive: true
    });
  })();

  /* -------------------------------------------------------- */
  /*  时钟                                                      */
  /* -------------------------------------------------------- */
  const pad2 = (n) => String(n).padStart(2, '0');

  function clockText(withSeconds) {
    const d = new Date();
    const hm = pad2(d.getHours()) + ':' + pad2(d.getMinutes());
    return withSeconds ? hm + ':' + pad2(d.getSeconds()) : hm;
  }

  function tickClock() {
    el.mbClock.textContent = clockText(true);
    const veilTime = $('#veil-time');
    if (veilTime) veilTime.textContent = clockText(false);
  }
  setInterval(tickClock, 1000);
  tickClock();

  /* -------------------------------------------------------- */
  /*  通知                                                      */
  /* -------------------------------------------------------- */
  function toast(message) {
    const node = document.createElement('div');
    node.className = 'toast';
    node.innerHTML = '<span class="dot"></span><span></span>';
    node.lastElementChild.textContent = message;
    el.toasts.appendChild(node);
    setTimeout(() => {
      node.classList.add('out');
      setTimeout(() => node.remove(), 260);
    }, 2600);
  }

  /* -------------------------------------------------------- */
  /*  主题 / 壁纸 / 强调色                                       */
  /* -------------------------------------------------------- */
  function setTheme(mode) {
    root.dataset.theme = mode;
    try {
      localStorage.setItem('lume.theme', mode);
    } catch (e) {}
    const meta = document.querySelector('meta[name="theme-color"]');
    if (meta) meta.setAttribute('content', mode === 'light' ? '#f2f2f1' : '#050507');
    window.dispatchEvent(new Event('themechange'));
  }

  function setWall(name) {
    root.dataset.wall = name;
    try {
      localStorage.setItem('lume.wall', name);
    } catch (e) {}
    toast('Wallpaper → ' + name);
  }

  function setAccent(hex) {
    root.style.setProperty('--accent', hex);
    try {
      localStorage.setItem('lume.accent', hex);
    } catch (e) {}
    window.dispatchEvent(new Event('themechange'));
  }

  /* -------------------------------------------------------- */
  /*  窗口管理                                                  */
  /* -------------------------------------------------------- */
  const LIGHT = {
    close:
      '<svg viewBox="0 0 10 10" fill="none" stroke="currentColor" stroke-width="1.4" stroke-linecap="round"><path d="M3 3l4 4M7 3L3 7"/></svg>',
    min: '<svg viewBox="0 0 10 10" fill="none" stroke="currentColor" stroke-width="1.4" stroke-linecap="round"><path d="M3 5h4"/></svg>',
    max: '<svg viewBox="0 0 10 10" fill="none" stroke="currentColor" stroke-width="1.4" stroke-linecap="round"><path d="M3 6.6V3h3.6"/><path d="M7 3.4V7H3.4"/></svg>'
  };

  const wins = new Map();
  let zTop = 100;
  let cascade = 0;
  let focusedKey = null;

  function focusWin(key) {
    const win = wins.get(key);
    if (!win) return;
    zTop += 1;
    win.el.style.zIndex = String(zTop);
    focusedKey = key;
    wins.forEach((w, k) => w.el.classList.toggle('focused', k === key));
    el.mbApp.textContent = win.app.name;
  }

  function updateDockState() {
    const running = new Set();
    wins.forEach((w) => running.add(w.app.id));
    $$('.dock-item[data-app]').forEach((item) => {
      item.classList.toggle('running', running.has(item.dataset.app));
    });
  }

  function closeWin(key) {
    const win = wins.get(key);
    if (!win) return;

    win.el.classList.add('closing');
    win.el.style.pointerEvents = 'none';
    wins.delete(key);
    updateDockState();

    if (focusedKey === key) {
      focusedKey = null;
      const last = Array.from(wins.keys()).pop();
      if (last) focusWin(last);
      else el.mbApp.textContent = 'LumeOS';
    }

    setTimeout(() => win.el.remove(), 190);
  }

  function toggleMax(win) {
    if (win.max) {
      win.max = false;
      win.el.classList.remove('max');
      Object.assign(win.el.style, win.prev || {});
      win.prev = null;
    } else {
      const area = el.windows.getBoundingClientRect();
      win.prev = {
        left: win.el.style.left,
        top: win.el.style.top,
        width: win.el.style.width,
        height: win.el.style.height
      };
      win.max = true;
      win.el.classList.add('max');
      win.el.style.left = '8px';
      win.el.style.top = '6px';
      win.el.style.width = area.width - 16 + 'px';
      win.el.style.height = area.height - 88 + 'px';
    }
  }

  function dragWin(win, event) {
    if (win.max || event.button !== 0) return;
    const node = win.el;
    const rect = node.getBoundingClientRect();
    const area = el.windows.getBoundingClientRect();
    const offX = event.clientX - rect.left;
    const offY = event.clientY - rect.top;

    node.classList.add('dragging');

    function move(ev) {
      let x = ev.clientX - area.left - offX;
      let y = ev.clientY - area.top - offY;
      x = Math.min(Math.max(x, -rect.width + 140), area.width - 140);
      y = Math.min(Math.max(y, 0), area.height - 46);
      node.style.left = x + 'px';
      node.style.top = y + 'px';
    }
    function up() {
      node.classList.remove('dragging');
      window.removeEventListener('pointermove', move);
      window.removeEventListener('pointerup', up);
    }
    window.addEventListener('pointermove', move);
    window.addEventListener('pointerup', up);
  }

  function resizeWin(win, event) {
    event.preventDefault();
    const node = win.el;
    const rect = node.getBoundingClientRect();

    function move(ev) {
      node.style.width = Math.max(340, ev.clientX - rect.left) + 'px';
      node.style.height = Math.max(220, ev.clientY - rect.top) + 'px';
    }
    function up() {
      window.removeEventListener('pointermove', move);
      window.removeEventListener('pointerup', up);
    }
    window.addEventListener('pointermove', move);
    window.addEventListener('pointerup', up);
  }

  function openApp(appId, opts) {
    opts = opts || {};
    const app = APPS[appId];
    if (!app) return;

    const key = app.id + (opts.path ? ':' + opts.path : '');

    /* 单例应用（Files）：已经有窗口就复用，直接在里面跳目录，不再开第二个 */
    if (app.single) {
      const found = Array.from(wins.entries()).find(([, w]) => w.app.id === app.id);
      if (found) {
        const w = found[1];
        if (w.minimized) {
          w.minimized = false;
          w.el.style.display = '';
        }
        focusWin(found[0]);
        if (opts.path && w.navigate) w.navigate(opts.path);
        return found[0];
      }
    }

    if (wins.has(key) && !opts.forceNew) {
      const win = wins.get(key);
      if (win.minimized) {
        win.minimized = false;
        win.el.style.display = '';
      }
      focusWin(key);
      return key;
    }

    /* Dock / 菜单 / Spotlight 启动时不带 path：只要这个应用已有窗口
       （哪怕当初是带 path 开的，key 对不上），就还原并聚焦它，
       而不是再开一个一模一样的新窗口 —— 最小化后点 Dock 尤其明显 */
    if (!opts.forceNew && !opts.path) {
      let foundKey = null;
      wins.forEach((w, k) => {
        if (w.app.id === app.id) foundKey = k;
      });
      if (foundKey) {
        const w = wins.get(foundKey);
        if (w.minimized) {
          w.minimized = false;
          w.el.style.display = '';
        }
        focusWin(foundKey);
        return foundKey;
      }
    }

    const area = el.windows.getBoundingClientRect();
    const narrow = area.width < 720;
    const width = narrow ? area.width - 16 : Math.min(app.width, area.width - 48);
    const height = narrow ? area.height - 90 : Math.min(app.height, area.height - 110);

    const step = cascade++ % 6;
    const left = narrow ? 8 : Math.max(8, (area.width - width) / 2 + step * 26 - 60);
    const top = narrow ? 6 : Math.max(6, (area.height - height) / 2 - 30 + step * 22);

    const node = document.createElement('div');
    node.className = 'window';
    node.style.width = width + 'px';
    node.style.height = height + 'px';
    node.style.left = left + 'px';
    node.style.top = top + 'px';
    node.innerHTML =
      '<div class="win-titlebar">' +
      '<div class="win-lights">' +
      '<button class="win-light close" type="button" data-act="close" aria-label="Close">' + LIGHT.close + '</button>' +
      '<button class="win-light min" type="button" data-act="min" aria-label="Minimize">' + LIGHT.min + '</button>' +
      '<button class="win-light max" type="button" data-act="max" aria-label="Maximize">' + LIGHT.max + '</button>' +
      '</div>' +
      '<div class="win-title"></div>' +
      '<span class="win-meta"></span>' +
      '</div>' +
      '<div class="win-body"></div>' +
      '<div class="win-resize" title="Resize"></div>';

    el.windows.appendChild(node);

    const win = {
      key,
      app,
      el: node,
      max: false,
      minimized: false,
      prev: null,
      setTitle: function (text) {
        node.querySelector('.win-title').textContent = text;
        if (focusedKey === key) el.mbApp.textContent = text;
        const dockItem = document.querySelector('.dock-item[data-app="' + app.id + '"]');
        if (dockItem) dockItem.querySelector('.dock-tip').textContent = text;
      }
    };
    win.setTitle(app.name);
    wins.set(key, win);

    node.addEventListener('pointerdown', () => focusWin(key));

    $$('.win-light', node).forEach((btn) => {
      btn.addEventListener('click', (e) => {
        e.stopPropagation();
        const act = btn.dataset.act;
        if (act === 'close') closeWin(key);
        if (act === 'max') toggleMax(win);
        if (act === 'min') {
          win.minimized = true;
          node.style.display = 'none';
          /* 最小化的是当前焦点窗口时，把焦点交给剩下最上面那个可见窗口 */
          if (focusedKey === key) {
            let pick = null;
            wins.forEach((w, k) => {
              if (!w.minimized) pick = k;
            });
            if (pick) focusWin(pick);
            else {
              focusedKey = null;
              wins.forEach((w) => w.el.classList.remove('focused'));
              el.mbApp.textContent = 'LumeOS';
            }
          }
        }
      });
    });

    node.querySelector('.win-titlebar').addEventListener('pointerdown', (e) => {
      if (e.target.closest('.win-light')) return;
      dragWin(win, e);
    });
    node.querySelector('.win-resize').addEventListener('pointerdown', (e) => resizeWin(win, e));

    const body = node.querySelector('.win-body');
    try {
      app.mount(body, win, opts);
    } catch (err) {
      body.innerHTML = '<div class="files-empty">failed to launch: ' + err.message + '</div>';
    }

    focusWin(key);
    updateDockState();
    return key;
  }

  function closeFocused() {
    if (!focusedKey) return;
    closeWin(focusedKey);
  }

  /* -------------------------------------------------------- */
  /*  Dock                                                      */
  /* -------------------------------------------------------- */
  function buildDock() {
    Object.keys(APPS).forEach((id) => {
      const app = APPS[id];
      /* transient 应用（Tips / Licence）只在菜单栏有入口，不进 Dock */
      if (app.transient) return;
      const btn = document.createElement('button');
      btn.className = 'dock-item';
      btn.type = 'button';
      btn.dataset.app = id;
      btn.setAttribute('aria-label', app.name);
      btn.innerHTML =
        '<span class="dock-tile">' + ICON[app.icon] + '</span>' +
        '<span class="dock-tip">' + app.name + '</span>';
      btn.addEventListener('click', () => openApp(id));
      el.dockInner.appendChild(btn);
    });
  }

  /* -------------------------------------------------------- */
  /*  桌面图标：应用快捷方式 + /home/lume/Desktop 里的真实文件     */
  /* -------------------------------------------------------- */
  function makeDeskIcon(svg, label, meta) {
    /* 用 div 而不是 button：右键改名时要在里面塞 input，button 里放 input 是非法的 */
    const btn = document.createElement('div');
    btn.className = 'desk-icon';
    btn.setAttribute('role', 'button');
    btn.tabIndex = 0;
    if (meta.app) btn.dataset.app = meta.app;
    if (meta.path) {
      btn.dataset.path = meta.path;
      btn.dataset.type = meta.type;
    }
    btn.innerHTML = svg + '<span></span>';
    btn.querySelector('span').textContent = label;
    btn.title = meta.app ? APPS[meta.app].name : meta.path;
    return btn;
  }

  function buildDeskIcons() {
    const frag = document.createDocumentFragment();

    [
      ['terminal', 'Terminal'],
      ['files', 'Files'],
      ['about', 'About']
    ].forEach(([id, label]) => {
      frag.appendChild(makeDeskIcon(ICON[APPS[id].icon], label, { app: id }));
    });

    LumeFS.list(LumeFS.DESKTOP).forEach((item) => {
      frag.appendChild(
        makeDeskIcon(item.type === 'dir' ? ICON.folder : ICON.file, item.name, {
          path: item.path,
          type: item.type
        })
      );
    });

    el.deskIcons.innerHTML = '';
    el.deskIcons.appendChild(frag);
  }

  function openPath(path, type) {
    if (type === 'dir' || LumeFS.isDir(path)) openApp('files', { path: path });
    else openApp('editor', { path: path });
  }

  /* -------------------------------------------------------- */
  /*  菜单                                                      */
  /* -------------------------------------------------------- */
  function closeMenus() {
    el.sysMenu.hidden = true;
    el.ctxMenu.hidden = true;
    el.mbLogo.classList.remove('open');
  }

  function openSysMenu(x, y) {
    el.sysMenu.hidden = false;
    el.mbLogo.classList.add('open');

    if (typeof x === 'number' && typeof y === 'number') {
      /* 从菜单栏任意位置右键唤起：贴着鼠标放，别出屏 */
      const box = el.sysMenu.getBoundingClientRect();
      el.sysMenu.style.left = Math.round(Math.min(Math.max(8, x), innerWidth - box.width - 8)) + 'px';
      el.sysMenu.style.top = Math.round(Math.min(y, innerHeight - box.height - 8)) + 'px';
      return;
    }

    const rect = el.mbLogo.getBoundingClientRect();
    el.sysMenu.style.left = Math.round(rect.left) + 'px';
    el.sysMenu.style.top = Math.round(rect.bottom + 6) + 'px';
  }

  /* 右键菜单：与系统菜单共用一套行结构（图标 / 标签 / 提示），
     所以两边看起来是同一个控件。items 里 '|' 表示分隔线。 */
  let ctxItems = [];

  function menuHTML(spec) {
    let html = '';
    if (spec.title) {
      html +=
        '<div class="menu-head"><span class="menu-title">' +
        spec.title +
        '</span><span class="menu-sub">' +
        (spec.sub || '') +
        '</span></div>';
    }
    spec.items.forEach((it, i) => {
      if (it === '|') {
        html += '<div class="menu-sep"></div>';
        return;
      }
      html +=
        '<button class="menu-item' + (it.danger ? ' danger' : '') + '" type="button" data-i="' + i + '">' +
        '<span class="menu-ico">' + (ICON[it.ico] || '') + '</span>' +
        '<span class="menu-label">' + it.label + '</span>' +
        '<span class="menu-hint' + (it.next ? ' is-next' : '') + '">' +
        (it.dot ? '<span class="menu-dot"></span>' : it.hint || '') +
        '</span>' +
        '</button>';
    });
    return html;
  }

  function popMenu(x, y, spec) {
    ctxItems = spec.items;
    el.ctxMenu.innerHTML = menuHTML(spec);
    el.ctxMenu.hidden = false;

    /* 先量尺寸再定位，避免贴边时被裁掉 */
    const box = el.ctxMenu.getBoundingClientRect();
    const maxX = Math.max(8, innerWidth - box.width - 8);
    const maxY = Math.max(8, innerHeight - box.height - 8);
    el.ctxMenu.style.left = Math.round(Math.min(Math.max(8, x), maxX)) + 'px';
    el.ctxMenu.style.top = Math.round(Math.min(Math.max(8, y), maxY)) + 'px';
  }

  function openCtxMenu(x, y) {
    const running = new Set();
    wins.forEach((w) => running.add(w.app.id));
    const wall = root.dataset.wall || 'stars';
    const theme = root.dataset.theme === 'light' ? 'light' : 'dark';
    const nextWall = ['stars', 'grid', 'plain'][(['stars', 'grid', 'plain'].indexOf(wall) + 1) % 3];

    const launch = (id) => () => openApp(id);

    popMenu(x, y, {
      title: 'Desktop',
      sub: `lume 1.0 · ${wins.size} window${wins.size === 1 ? '' : 's'}`,
      items: [
        { ico: 'newfile', label: 'New File', hint: '⌘⇧N', run: () => newItem(LumeFS.DESKTOP, 'file') },
        { ico: 'newfolder', label: 'New Folder', run: () => newItem(LumeFS.DESKTOP, 'dir') },
        '|',
        { ico: 'search', label: 'Spotlight…', hint: '⌘K', run: openSpot },
        '|',
        { ico: 'terminal', label: 'Terminal', dot: running.has('terminal'), run: launch('terminal') },
        { ico: 'files', label: 'Files', dot: running.has('files'), run: launch('files') },
        { ico: 'settings', label: 'Settings', dot: running.has('settings'), run: launch('settings') },
        '|',
        { ico: 'wall', label: 'Cycle wallpaper', hint: `→ ${nextWall}`, next: true, run: () => setWall(nextWall) },
        {
          ico: 'theme',
          label: 'Toggle theme',
          hint: `→ ${theme === 'dark' ? 'light' : 'dark'}`,
          next: true,
          run: () => setTheme(theme === 'dark' ? 'light' : 'dark')
        },
        '|',
        { ico: 'about', label: 'About LumeOS', run: () => openApp('about') }
      ]
    });
  }

  function openWinMenu(x, y, win) {
    const rect = win.el.getBoundingClientRect();
    const isFront = focusedKey === win.key;
    const minimize = () => {
      win.minimized = true;
      win.el.style.display = 'none';
      updateDockState();
    };

    popMenu(x, y, {
      title: win.app.name,
      sub: `${Math.round(rect.width)}×${Math.round(rect.height)} · ${isFront ? 'front' : 'back'}`,
      items: [
        { ico: 'min', label: 'Minimize', run: minimize },
        { ico: 'max', label: win.max ? 'Restore' : 'Zoom', run: () => toggleMax(win) },
        '|',
        { ico: 'close', label: 'Close Window', hint: '⌥W', danger: true, run: () => closeWin(win.key) }
      ]
    });
  }

  /* -------------------------------------------------------- */
  /*  文件操作：桌面和 Files 共用同一套                          */
  /* -------------------------------------------------------- */
  function newItem(dir, kind) {
    const base = kind === 'dir' ? 'untitled folder' : 'untitled.txt';
    const path = LumeFS.unique(dir, base);
    const ok = kind === 'dir' ? LumeFS.mkdir(path) : LumeFS.write(path, '');
    if (!ok) {
      toast('Could not create ' + base + ' in ' + LumeFS.baseOf(dir));
      return null;
    }
    toast((kind === 'dir' ? 'New folder · ' : 'New file · ') + LumeFS.baseOf(path));
    return path;
  }

  function duplicateItem(path) {
    if (!LumeFS.exists(path) || LumeFS.isDir(path)) return;
    const name = LumeFS.baseOf(path);
    const dot = name.lastIndexOf('.');
    const copyName = dot > 0 ? name.slice(0, dot) + ' copy' + name.slice(dot) : name + ' copy';
    const dest = LumeFS.unique(LumeFS.parentOf(path), copyName);
    if (LumeFS.write(dest, LumeFS.read(path) || '')) toast('Duplicated as ' + LumeFS.baseOf(dest));
  }

  /* 桌面的位置由内核约定，改名或删掉会让桌面图标无处可取 */
  const PROTECTED = ['/', LumeFS.HOME, LumeFS.DESKTOP];
  const isProtected = (path) => PROTECTED.indexOf(LumeFS.norm(path)) >= 0;

  function deleteItem(path) {
    const name = LumeFS.baseOf(path);
    if (isProtected(path)) return toast(name === '/' ? 'Not this one' : name + ' is part of the system');
    if (!LumeFS.remove(path)) return toast('Could not delete ' + name);
    toast('Moved to trash · ' + name);
  }

  /** 就地改名：label 原地换成输入框，回车提交、Esc 取消、失焦按提交算 */
  function inlineRename(labelEl, path, done) {
    if (!labelEl || !labelEl.parentNode) return;
    if (isProtected(path)) {
      toast('That folder is part of the system');
      return;
    }
    const input = document.createElement('input');
    input.className = 'inline-rename';
    input.value = LumeFS.baseOf(path);
    input.spellcheck = false;
    input.setAttribute('aria-label', 'Rename');
    labelEl.replaceWith(input);

    let settled = false;
    const finish = (commit) => {
      if (settled) return;
      settled = true;
      const value = input.value;
      if (!commit || !value.trim() || value.trim() === LumeFS.baseOf(path)) return done(false);
      if (LumeFS.rename(path, value)) done(true);
      else {
        toast('"' + value.trim() + '" already exists here');
        done(false);
      }
    };

    input.addEventListener('keydown', (e) => {
      e.stopPropagation();
      if (e.key === 'Enter') {
        e.preventDefault();
        finish(true);
      }
      if (e.key === 'Escape') {
        e.preventDefault();
        finish(false);
      }
    });
    input.addEventListener('blur', () => finish(true));
    setTimeout(() => {
      input.focus();
      input.select();
    }, 0);
  }

  function openDeskIconMenu(x, y, btn) {
    const path = btn.dataset.path;

    if (!path) {
      const app = btn.dataset.app;
      popMenu(x, y, {
        title: APPS[app].name,
        sub: 'Application',
        items: [
          { ico: APPS[app].icon, label: 'Open', run: () => openApp(app) },
          '|',
          { ico: 'search', label: 'Find with Spotlight', hint: '⌘K', run: openSpot }
        ]
      });
      return;
    }

    const isDir = btn.dataset.type === 'dir';
    const items = [
      { ico: isDir ? 'files' : 'editor', label: 'Open', run: () => openPath(path, btn.dataset.type) },
      { ico: 'files', label: 'Show in Files', run: () => openApp('files', { path: LumeFS.parentOf(path) }) },
      '|',
      {
        ico: 'rename',
        label: 'Rename…',
        run: () => inlineRename(btn.querySelector('span'), path, () => buildDeskIcons())
      }
    ];
    if (!isDir) items.push({ ico: 'duplicate', label: 'Duplicate', run: () => duplicateItem(path) });
    items.push('|', { ico: 'trash', label: 'Move to Trash', danger: true, run: () => deleteItem(path) });

    popMenu(x, y, {
      title: LumeFS.baseOf(path),
      sub: (isDir ? 'Folder' : fmtSize(LumeFS.size(path))) + ' · Desktop',
      items: items
    });
  }

  function openDockMenu(x, y, item) {
    const id = item.dataset.app;
    const appWins = Array.from(wins.entries()).filter(([, w]) => w.app.id === id);
    const running = appWins.length > 0;
    const items = [
      { ico: APPS[id].icon, label: 'Open', run: () => openApp(id) },
      { ico: 'plus', label: 'New Window', run: () => openApp(id, { forceNew: true }) }
    ];
    if (running) {
      items.push('|', {
        ico: 'desktop',
        label: 'Show All Windows',
        run: () => {
          let last = null;
          appWins.forEach(([k, w]) => {
            if (w.minimized) {
              w.minimized = false;
              w.el.style.display = '';
            }
            last = k;
          });
          if (last) focusWin(last);
        }
      });
      /* 多于一个窗口时，把每个窗口列出来，点哪个还原哪个 */
      if (appWins.length > 1) {
        appWins.forEach(([k, w]) => {
          items.push({
            ico: w.app.icon,
            label: (w.el.querySelector('.win-title') || {}).textContent || w.app.name,
            hint: w.minimized ? 'min' : '',
            run: () => {
              if (w.minimized) {
                w.minimized = false;
                w.el.style.display = '';
              }
              focusWin(k);
            }
          });
        });
      }
      items.push('|', {
        ico: 'close',
        label: appWins.length > 1 ? 'Close All Windows' : 'Close Window',
        danger: true,
        run: () => appWins.forEach(([k]) => closeWin(k))
      });
    }
    popMenu(x, y, { title: APPS[id].name, sub: running ? appWins.length + ' running' : 'Application', items: items });
  }

  /* 把剪贴板内容塞进输入框；浏览器不给读就提示用 ⌘V */
  function pasteInto(field) {
    field.focus();
    if (!navigator.clipboard || !navigator.clipboard.readText) {
      toast('Press ⌘V instead');
      return;
    }
    navigator.clipboard.readText().then(
      (text) => {
        if (!text) return;
        const a = field.selectionStart;
        const b = field.selectionEnd;
        field.setSelectionRange(a, b);
        if (!document.execCommand('insertText', false, text)) {
          const v = field.value;
          field.value = v.slice(0, a) + text + v.slice(b);
          field.setSelectionRange(a + text.length, a + text.length);
          field.dispatchEvent(new Event('input', { bubbles: true }));
        }
      },
      () => toast('Clipboard is not readable here — press ⌘V instead')
    );
  }

  /* 文字区域的右键菜单：以前这里会弹浏览器原生菜单 */
  function openEditMenu(x, y, field) {
    const run = (cmd) => () => {
      field.focus();
      try {
        document.execCommand(cmd);
      } catch (e) {
        toast('This browser blocked that action');
      }
    };

    popMenu(x, y, {
      title: 'Edit',
      sub: field.tagName.toLowerCase() === 'textarea' ? 'text editor' : 'text field',
      items: [
        { ico: 'cut', label: 'Cut', hint: '⌘X', run: run('cut') },
        { ico: 'copy', label: 'Copy', hint: '⌘C', run: run('copy') },
        { ico: 'paste', label: 'Paste', hint: '⌘V', run: () => pasteInto(field) },
        '|',
        {
          ico: 'selectall',
          label: 'Select All',
          hint: '⌘A',
          run: () => {
            field.focus();
            field.select();
          }
        }
      ]
    });
  }

  function runSysCommand(cmd) {
    closeMenus();
    if (cmd === 'about') openApp('about');
    if (cmd === 'settings') openApp('settings');
    if (cmd === 'lock') lockScreen();
    if (cmd === 'restart') location.reload();
    if (cmd === 'shutdown') powerOff();
    if (cmd === 'home') location.href = '/';
  }

  /* -------------------------------------------------------- */
  /*  Spotlight                                                 */
  /* -------------------------------------------------------- */
  let spotRows = [];
  let spotIndex = 0;

  function walkFiles(dir, out) {
    LumeFS.list(dir).forEach((item) => {
      if (item.type === 'dir') walkFiles(item.path, out);
      else out.push(item);
    });
    return out;
  }

  function buildSearchIndex() {
    const apps = Object.keys(APPS).filter((id) => !APPS[id].transient).map((id) => ({
      kind: 'app',
      id,
      name: APPS[id].name,
      icon: APPS[id].icon,
      hint: 'Application'
    }));
    const files = walkFiles('/', []).map((f) => ({
      kind: 'file',
      id: f.path,
      name: f.name,
      icon: 'file',
      hint: f.path
    }));
    return apps.concat(files);
  }

  function renderSpot(query) {
    const all = buildSearchIndex();
    const q = query.trim().toLowerCase();
    const rows = q
      ? all.filter((item) => item.name.toLowerCase().includes(q) || item.hint.toLowerCase().includes(q))
      : all.slice(0, 9);

    spotRows = rows.slice(0, 9);
    spotIndex = 0;

    if (!spotRows.length) {
      el.spotResults.innerHTML = '<div class="spot-empty">nothing matches "' + q + '"</div>';
      return;
    }

    el.spotResults.innerHTML = spotRows
      .map(
        (item, i) =>
          '<button class="spot-row' + (i === 0 ? ' active' : '') + '" type="button" data-i="' + i + '">' +
          (ICON[item.icon] || ICON.file) +
          '<span class="spot-name">' + item.name + '</span>' +
          '<span class="spot-kind">' + (item.kind === 'app' ? 'App' : 'File') + '</span>' +
          '</button>'
      )
      .join('');
  }

  function openSpot() {
    closeMenus();
    el.spot.hidden = false;
    el.spotInput.value = '';
    renderSpot('');
    setTimeout(() => el.spotInput.focus(), 30);
  }

  function closeSpot() {
    el.spot.hidden = true;
  }

  function activateSpot(index) {
    const item = spotRows[index];
    if (!item) return;
    closeSpot();
    if (item.kind === 'app') openApp(item.id);
    else openApp('editor', { path: item.id });
  }

  /* -------------------------------------------------------- */
  /*  锁屏 / 关机                                                */
  /* -------------------------------------------------------- */
  function lockScreen() {
    el.veil.hidden = false;
    el.veil.innerHTML =
      '<div class="veil-inner">' +
      '<div class="veil-time" id="veil-time">' + clockText(false) + '</div>' +
      '<div class="veil-date">' + new Date().toDateString() + '</div>' +
      '<button class="veil-btn" type="button" id="veil-btn">Press any key to continue</button>' +
      '</div>';
    el.veil.onclick = unlock;
    setTimeout(() => (document.onkeydown = unlockKey), 200);
  }

  function unlockKey() {
    unlock();
  }

  function unlock() {
    el.veil.hidden = true;
    el.veil.innerHTML = '';
    el.veil.onclick = null;
    document.onkeydown = null;
  }

  function powerOff() {
    el.veil.hidden = false;
    el.veil.innerHTML =
      '<div class="veil-inner">' +
      '<div class="veil-time" style="font-size:clamp(1.75rem,5vw,2.75rem);letter-spacing:0.02em">goodbye.</div>' +
      '<div class="veil-date">press anywhere to reboot</div>' +
      '</div>';
    el.veil.onclick = function () {
      try {
        sessionStorage.removeItem('lume.booted');
      } catch (e) {}
      location.reload();
    };
  }

  /* -------------------------------------------------------- */
  /*  开机                                                      */
  /* -------------------------------------------------------- */
  const BOOT_LINES = [
    'lume bios v2.4 · detecting hardware',
    'memory ............... 16384 MB ok',
    'mounting /dev/lume0 .. rw, noatime',
    'modules .............. lume-gfx lume-wm lume-fs',
    'compositor ........... 1920x1080 @ 60hz',
    'shell ................ /bin/lumesh',
    'loading applications . 5 found',
    'reaching desktop ..... ready'
  ];

  function runBoot(done) {
    let line = 0;
    let progress = 0;

    const lineTimer = setInterval(() => {
      if (line >= BOOT_LINES.length) {
        clearInterval(lineTimer);
        return;
      }
      el.bootLog.textContent += BOOT_LINES[line++] + '\n';
    }, 190);

    const barTimer = setInterval(() => {
      progress = Math.min(100, progress + 100 / 20);
      el.bootBar.style.width = progress + '%';
      if (progress >= 100) clearInterval(barTimer);
    }, 100);

    setTimeout(() => {
      clearInterval(lineTimer);
      el.boot.classList.add('done');
      el.desktop.classList.add('awake');
      el.desktop.removeAttribute('aria-hidden');
      if (typeof done === 'function') done();
    }, 2350);
  }

  /* -------------------------------------------------------- */
  /*  系统信息                                                  */
  /* -------------------------------------------------------- */
  function uptimeText() {
    const s = Math.floor((Date.now() - startedAt) / 1000);
    const h = Math.floor(s / 3600);
    const m = Math.floor((s % 3600) / 60);
    if (h) return h + 'h ' + m + 'm';
    if (m) return m + 'm ' + (s % 60) + 's';
    return s + 's';
  }

  function engineName() {
    const ua = navigator.userAgent;
    let m = ua.match(/Edg\/([\d.]+)/);
    if (m) return 'Blink · Edge ' + m[1].split('.')[0];
    m = ua.match(/Chrome\/([\d.]+)/);
    if (m) return 'Blink · Chrome ' + m[1].split('.')[0];
    m = ua.match(/Firefox\/([\d.]+)/);
    if (m) return 'Gecko · Firefox ' + m[1].split('.')[0];
    m = ua.match(/Version\/([\d.]+).*Safari/);
    if (m) return 'WebKit · Safari ' + m[1].split('.')[0];
    return 'unknown';
  }

  function systemInfo() {
    return {
      os: 'LumeOS 1.0 "Nebula"',
      kernel: '1.0.0-nebula',
      uptime: uptimeText(),
      apps: Object.keys(APPS).filter((id) => !APPS[id].transient).length,
      theme: root.dataset.theme === 'light' ? 'light' : 'dark',
      engine: engineName(),
      memory: (navigator.deviceMemory || 16) + ' GB',
      build: BUILD,
      wm: 'vanilla'
    };
  }

  /* -------------------------------------------------------- */
  /*  事件绑定                                                  */
  /* -------------------------------------------------------- */
  el.mbBack.addEventListener('click', () => {
    location.href = '/';
  });

  el.deskIcons.addEventListener('click', (e) => {
    clearPicked();
    const btn = e.target.closest('.desk-icon');
    if (!btn) return;
    if (btn.dataset.app) return openApp(btn.dataset.app);
    if (btn.dataset.path) return openPath(btn.dataset.path, btn.dataset.type);
  });

  el.deskIcons.addEventListener('keydown', (e) => {
    if (e.key !== 'Enter' && e.key !== ' ') return;
    const btn = e.target.closest('.desk-icon');
    if (!btn) return;
    e.preventDefault();
    btn.click();
  });

  /* ---------- 桌面框选：空白处拖拽出圆角选框，套住图标即选中 ---------- */
  function clearPicked() {
    $$('.desk-icon.picked', el.deskIcons).forEach((n) => n.classList.remove('picked'));
  }

  function startMarquee(e) {
    clearPicked();
    const area = el.desktop.getBoundingClientRect();
    const sx = e.clientX - area.left;
    const sy = e.clientY - area.top;

    const box = document.createElement('div');
    box.className = 'marquee';
    el.desktop.appendChild(box);

    const move = (ev) => {
      const cx = Math.max(0, Math.min(ev.clientX - area.left, area.width));
      const cy = Math.max(0, Math.min(ev.clientY - area.top, area.height));
      const x = Math.min(sx, cx);
      const y = Math.min(sy, cy);
      const w = Math.abs(cx - sx);
      const h = Math.abs(cy - sy);
      box.style.left = x + 'px';
      box.style.top = y + 'px';
      box.style.width = w + 'px';
      box.style.height = h + 'px';

      const b1 = { l: x, t: y, r: x + w, b: y + h };
      $$('.desk-icon', el.deskIcons).forEach((n) => {
        const r = n.getBoundingClientRect();
        const l2 = r.left - area.left;
        const t2 = r.top - area.top;
        const hit = !(b1.r < l2 || b1.l > l2 + r.width || b1.b < t2 || b1.t > t2 + r.height);
        n.classList.toggle('picked', hit);
      });
    };
    const up = () => {
      window.removeEventListener('pointermove', move);
      window.removeEventListener('pointerup', up);
      box.remove();
    };
    window.addEventListener('pointermove', move);
    window.addEventListener('pointerup', up);
  }

  el.desktop.addEventListener('pointerdown', (e) => {
    if (e.button !== 0) return;
    /* 只认桌面空白处：窗口 / Dock / 菜单栏 / 图标 / 输入控件都不算 */
    if (e.target.closest('.window, .dock, .menubar, .menu, .desk-icon, #spotlight, #veil, button, input, textarea, select')) return;
    closeMenus();
    startMarquee(e);
  });

  /* 文件系统变化 → 桌面图标跟着变（新建/改名/删除都算） */
  window.addEventListener('lume:fs', () => buildDeskIcons());

  el.mbLogo.addEventListener('click', (e) => {
    e.stopPropagation();
    if (el.sysMenu.hidden) openSysMenu();
    else closeMenus();
  });

  el.sysMenu.addEventListener('click', (e) => {
    const item = e.target.closest('.menu-item');
    if (item) runSysCommand(item.dataset.cmd);
  });

  el.ctxMenu.addEventListener('click', (e) => {
    const item = e.target.closest('.menu-item');
    if (!item) return;
    const spec = ctxItems[Number(item.dataset.i)];
    closeMenus();
    if (spec && spec.run) spec.run();
  });

  el.mbSearch.addEventListener('click', openSpot);
  el.mbTheme.addEventListener('click', () => setTheme(root.dataset.theme === 'light' ? 'dark' : 'light'));
  el.dockPower.addEventListener('click', powerOff);

  /* 菜单栏左侧的 Tips / Licence 标签：开一个普通窗口，但不进 Dock */
  const mbTips = $('#mb-tips');
  const mbLicence = $('#mb-licence');
  if (mbTips) mbTips.addEventListener('click', () => openApp('tips'));
  if (mbLicence) mbLicence.addEventListener('click', () => openApp('licence'));

  /* 点版本号：顺手弹出系统菜单里的信息（复用 About） */
  const mbVer = $('#mb-ver');
  if (mbVer) {
    mbVer.addEventListener('click', () => openApp('about'));
    mbVer.title = 'LumeOS 1.0 “Nebula” · click for About';
  }

  document.addEventListener('click', (e) => {
    if (!e.target.closest('#sys-menu') && !e.target.closest('#mb-logo')) {
      el.sysMenu.hidden = true;
      el.mbLogo.classList.remove('open');
    }
    if (!e.target.closest('#ctx-menu')) el.ctxMenu.hidden = true;
  });

  /* 全站接管右键：任何地方都不再弹浏览器原生菜单。
     应用内部（Files / Editor / Terminal）会自己 stopPropagation，
     所以到这里的只剩桌面、标题栏、Dock、菜单栏和纯文字区。 */
  document.addEventListener('contextmenu', (e) => {
    if (e.defaultPrevented) return;
    e.preventDefault();

    const t = e.target;

    /* 已经弹出来的菜单上再点右键：不重复弹，也不穿越到底下的桌面 */
    if (t.closest('.menu, #spotlight, #veil')) return;

    const winEl = t.closest('.window');

    if (winEl) {
      const key = Array.from(wins.keys()).find((k) => wins.get(k).el === winEl);
      const win = key && wins.get(key);

      if (t.closest('.win-titlebar')) {
        closeMenus();
        if (win) openWinMenu(e.clientX, e.clientY, win);
        return;
      }
      /* 正文里的输入框 / 文本区给编辑菜单 */
      const field = t.closest('input:not([type="hidden"]), textarea');
      if (field && !field.readOnly && !field.disabled) {
        closeMenus();
        openEditMenu(e.clientX, e.clientY, field);
        return;
      }
      /* 其余正文还没自带菜单——给一个通用的窗口菜单，总比原生菜单好 */
      closeMenus();
      if (win) openWinMenu(e.clientX, e.clientY, win);
      return;
    }

    const deskIcon = t.closest('.desk-icon');
    if (deskIcon) {
      closeMenus();
      openDeskIconMenu(e.clientX, e.clientY, deskIcon);
      return;
    }

    const dockItem = t.closest('.dock-item[data-app]');
    if (dockItem) {
      closeMenus();
      openDockMenu(e.clientX, e.clientY, dockItem);
      return;
    }

    if (t.closest('.menubar')) {
      openSysMenu(e.clientX, e.clientY);
      return;
    }
    if (t.closest('.dock')) return;

    closeMenus();
    openCtxMenu(e.clientX, e.clientY);
  });

  el.spot.addEventListener('click', (e) => {
    if (e.target === el.spot) closeSpot();
  });

  el.spotInput.addEventListener('input', () => renderSpot(el.spotInput.value));

  el.spotInput.addEventListener('keydown', (e) => {
    if (e.key === 'Escape') {
      closeSpot();
    } else if (e.key === 'ArrowDown' || e.key === 'ArrowUp') {
      e.preventDefault();
      if (!spotRows.length) return;
      spotIndex = (spotIndex + (e.key === 'ArrowDown' ? 1 : -1) + spotRows.length) % spotRows.length;
      $$('.spot-row', el.spotResults).forEach((row, i) => row.classList.toggle('active', i === spotIndex));
    } else if (e.key === 'Enter') {
      e.preventDefault();
      activateSpot(spotIndex);
    }
  });

  el.spotResults.addEventListener('click', (e) => {
    const row = e.target.closest('.spot-row');
    if (row) activateSpot(Number(row.dataset.i));
  });

  document.addEventListener('keydown', (e) => {
    const mod = e.metaKey || e.ctrlKey;

    // 锁屏 / 关机状态下先解锁，别让快捷键穿透
    if (!el.veil.hidden) {
      if (e.key === 'Escape' || e.key === 'Enter' || e.key === ' ') unlock();
      return;
    }

    if (mod && e.key.toLowerCase() === 'k') {
      e.preventDefault();
      if (el.spot.hidden) openSpot();
      else closeSpot();
      return;
    }
    if (e.key === 'Escape') {
      if (!el.spot.hidden) closeSpot();
      else closeMenus();
      return;
    }
    if (e.altKey && e.key.toLowerCase() === 'w') {
      e.preventDefault();
      closeFocused();
    }
    if (mod && e.shiftKey && e.key.toLowerCase() === 'l') {
      e.preventDefault();
      lockScreen();
    }
    if (mod && e.shiftKey && e.key.toLowerCase() === 'n') {
      e.preventDefault();
      newItem(LumeFS.DESKTOP, 'file');
    }
  });

  /* -------------------------------------------------------- */
  /*  启动                                                      */
  /* -------------------------------------------------------- */
  buildDock();
  buildDeskIcons();

  /* 系统菜单里的图标占位一次性填上，右键菜单是动态生成的 */
  $$('.menu-ico[data-ico]').forEach((node) => {
    node.innerHTML = ICON[node.dataset.ico] || '';
  });

  const alreadyBooted = (function () {
    try {
      return sessionStorage.getItem('lume.booted') === '1';
    } catch (e) {
      return false;
    }
  })();

  if (alreadyBooted) {
    el.boot.remove();
    el.desktop.classList.add('awake');
    el.desktop.removeAttribute('aria-hidden');
    setTimeout(() => toast('Welcome back to LumeOS'), 400);
  } else {
    runBoot(() => {
      try {
        sessionStorage.setItem('lume.booted', '1');
      } catch (e) {}
      setTimeout(() => toast('LumeOS 1.0 · press ⌘K to search'), 500);
    });
  }

  window.LumeOS = {
    openApp: openApp,
    closeFocused: closeFocused,
    toast: toast,
    setTheme: setTheme,
    setWall: setWall,
    setAccent: setAccent,
    systemInfo: systemInfo,
    uptimeText: uptimeText,
    redrawWallpaper: wall.redraw,
    /* 给应用复用的系统能力：右键菜单、文件操作、就地改名 */
    popMenu: popMenu,
    closeMenus: closeMenus,
    newItem: newItem,
    duplicate: duplicateItem,
    remove: deleteItem,
    inlineRename: inlineRename,
    openPath: openPath,
    pasteInto: pasteInto,
    deskDir: LumeFS.DESKTOP
  };
})();
