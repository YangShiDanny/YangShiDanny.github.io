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
      ring.classList.toggle('is-link', next === 'link');
    }

    document.addEventListener('mouseover', (e) => {
      const t = e.target;
      if (!(t instanceof Element)) return;
      if (t.closest('a,button,.dock-item,.win-light')) setMode('link');
      else if (t.closest('input,textarea')) setMode('text');
      else setMode('idle');
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
    if (win.max) return;
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

    if (wins.has(key) && !opts.forceNew) {
      const win = wins.get(key);
      if (win.minimized) {
        win.minimized = false;
        win.el.style.display = '';
      }
      focusWin(key);
      return key;
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
  /*  桌面图标                                                  */
  /* -------------------------------------------------------- */
  function buildDeskIcons() {
    [
      ['terminal', 'Terminal'],
      ['files', 'Files'],
      ['about', 'About']
    ].forEach(([id, label]) => {
      const btn = document.createElement('button');
      btn.className = 'desk-icon';
      btn.type = 'button';
      btn.innerHTML = ICON[APPS[id].icon] + '<span>' + label + '</span>';
      btn.addEventListener('click', () => openApp(id));
      el.deskIcons.appendChild(btn);
    });
  }

  /* -------------------------------------------------------- */
  /*  菜单                                                      */
  /* -------------------------------------------------------- */
  function closeMenus() {
    el.sysMenu.hidden = true;
    el.ctxMenu.hidden = true;
    el.mbLogo.classList.remove('open');
  }

  function openSysMenu() {
    const rect = el.mbLogo.getBoundingClientRect();
    el.sysMenu.hidden = false;
    el.sysMenu.style.left = Math.round(rect.left) + 'px';
    el.sysMenu.style.top = Math.round(rect.bottom + 6) + 'px';
    el.mbLogo.classList.add('open');
  }

  function openCtxMenu(x, y) {
    const items = [
      ['Terminal', 'terminal', 'open'],
      ['Files', 'files', 'open'],
      ['Settings', 'settings', 'open'],
      ['|', '', ''],
      ['Cycle wallpaper', 'wall', 'cmd'],
      ['Toggle theme', 'theme', 'cmd'],
      ['|', '', ''],
      ['About LumeOS', 'about', 'open']
    ];

    el.ctxMenu.innerHTML = items
      .map(([label, action, kind]) => {
        if (label === '|') return '<div class="menu-sep"></div>';
        return (
          '<button class="menu-item" type="button" data-kind="' + kind + '" data-action="' + action + '">' +
          label +
          '</button>'
        );
      })
      .join('');

    el.ctxMenu.hidden = false;
    const box = el.ctxMenu.getBoundingClientRect();
    el.ctxMenu.style.left = Math.min(x, innerWidth - box.width - 8) + 'px';
    el.ctxMenu.style.top = Math.min(y, innerHeight - box.height - 8) + 'px';
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
    const apps = Object.keys(APPS).map((id) => ({
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
      apps: Object.keys(APPS).length,
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
    const action = item.dataset.action;
    closeMenus();
    if (item.dataset.kind === 'open') openApp(action);
    if (action === 'wall') {
      const order = ['stars', 'grid', 'plain'];
      const next = order[(order.indexOf(root.dataset.wall || 'stars') + 1) % order.length];
      setWall(next);
    }
    if (action === 'theme') setTheme(root.dataset.theme === 'light' ? 'dark' : 'light');
  });

  el.mbSearch.addEventListener('click', openSpot);
  el.mbTheme.addEventListener('click', () => setTheme(root.dataset.theme === 'light' ? 'dark' : 'light'));
  el.dockPower.addEventListener('click', powerOff);

  document.addEventListener('click', (e) => {
    if (!e.target.closest('#sys-menu') && !e.target.closest('#mb-logo')) {
      el.sysMenu.hidden = true;
      el.mbLogo.classList.remove('open');
    }
    if (!e.target.closest('#ctx-menu')) el.ctxMenu.hidden = true;
  });

  el.desktop.addEventListener('contextmenu', (e) => {
    if (e.target.closest('.window, .dock, .menubar')) return;
    e.preventDefault();
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
  });

  /* -------------------------------------------------------- */
  /*  启动                                                      */
  /* -------------------------------------------------------- */
  buildDock();
  buildDeskIcons();

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
    redrawWallpaper: wall.redraw
  };
})();
