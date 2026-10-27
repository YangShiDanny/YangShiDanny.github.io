/* ============================================================
   LumeOS 内核
   开机序列 / 壁纸 / 光标 / 窗口管理 / Dock / 菜单 / Spotlight
   ============================================================ */

(function () {
  'use strict';

  const root = document.documentElement;
  const startedAt = Date.now();
  /* 版本号来自构建期生成的 version.json（scripts/build-version.cjs），
     形如 0.0.20-0f363ef。注意不能在解析时就取值——version.json 是异步
     fetch 回来的，此处 LumeBuild 还是 'dev'。所以用 getter，等
     systemInfo() 真被调用（用户敲 `neofetch` / `about`）时才是准的。 */
  const buildVersion = () => (window.LumeBuild && window.LumeBuild.version) || 'dev';

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
    if (window.matchMedia('(pointer: coarse)').matches) return;

    /* 光标节点自己造、自己挂到 body 最后一位。
       挂在 HTML 里时它排在 .desktop / .menubar / .dock / .veil 前面，
       一旦任何一层冒出更高的 z-index（比如输入法候选栏 99999、
       屏幕键盘 99990），光标就被压到下面看不见了。
       排到最后 + 极高的 z-index，两层保险。 */
    function mount(id) {
      let node = document.getElementById(id);
      if (!node) {
        node = document.createElement('div');
        node.id = id;
        node.setAttribute('aria-hidden', 'true');
      }
      document.body.appendChild(node);
      return node;
    }
    const dot = mount('cursor');
    const ring = mount('cursor-ring');

    let mx = innerWidth / 2;
    let my = innerHeight / 2;
    let rx = mx;
    let ry = my;
    let mode = 'idle';

    /* 唯一的坐标写入点。mousemove / pointermove / 窗口拖拽 / 缩放
       全都走这里，避免几个来源互相覆盖出"跳一下又回去"的抖动。 */
    function syncCursor(ev) {
      if (!ev || ev.clientX == null) return;
      mx = ev.clientX;
      my = ev.clientY;
      dot.style.left = mx + 'px';
      dot.style.top = my + 'px';
      dot.classList.remove('is-hidden');
      ring.classList.remove('is-hidden');
    }
    /* 挂到 window 上供窗口拖拽 / 缩放调用（见下方 dragWin / resizeWin） */
    window.__lumeCursorSync = syncCursor;

    /* 既听 mousemove 也听 pointermove，看似重复，其实是必要的：
       拖窗口 / 拖右下角缩放走的是 pointermove（pointerdown + setPointerCapture
       那套），而在拖拽期间浏览器不保证同步派发 mousemove——
       结果就是窗口跟着走了、光标却钉在原地。
       两个事件都喂给同一个处理函数，位置写的是同一个值，重复触发无副作用。 */

    /* ---------- 拖滚动条滑块：隐藏光标 ----------
       Chromium 在拖原生滚动条滑块时把 pointer/mouse 事件全部吃掉
       （Scrollbar::HandlePointerEvent 对 thumb 的 down/move/up 一律
       return true），页面一个事件都收不到，光标就钉在原地不动。
       试过按滑块几何反推坐标，但估算位置和真实指针总差半拍，
       按需求改为：判定出「正在拖滑块」就隐藏光标，收到第一个真实
       指针事件（松手后随便动一下）立即恢复。检测手段不变 ——
       「光标就在滑块上 + scroll 在走 + 近期没有 pointerdown」
       只可能是拖滑块。 */
    let sbMode = null;
    const lastSeen = { x: 0, y: 0, t: 0 };
    let lastDown = 0;

    function sbHide(on) {
      dot.classList.toggle('is-hidden', on);
      ring.classList.toggle('is-hidden', on);
    }
    function sbEnd() {
      if (sbMode) {
        sbMode = null;
        sbHide(false);
      }
    }

    function thumbMetrics(t) {
      const r = t.getBoundingClientRect();
      const bw = t.offsetWidth - t.clientWidth; /* 竖滚动条宽度（含边框） */
      if (!(t.scrollHeight > t.clientHeight + 1) || bw <= 0) return null;
      const trackH = t.clientHeight;
      const travel = t.scrollHeight - t.clientHeight;
      const th = Math.max(24, Math.round((trackH * trackH) / t.scrollHeight));
      const tt = travel > 0 ? (t.scrollTop / travel) * (trackH - th) : 0;
      return {
        x0: r.left + t.clientLeft + t.clientWidth,
        x1: r.right,
        top: r.top + t.clientTop + tt,
        bottom: r.top + t.clientTop + tt + th
      };
    }

    function onMove(e) {
      sbEnd(); /* 真实事件回来了，隐藏态解除 */
      lastSeen.x = e.clientX;
      lastSeen.y = e.clientY;
      lastSeen.t = performance.now();
      syncCursor(e);
    }
    window.addEventListener('mousemove', onMove, { passive: true });
    window.addEventListener('pointermove', onMove, { passive: true });

    window.addEventListener(
      'pointerdown',
      () => {
        lastDown = performance.now();
        sbEnd();
      },
      { passive: true, capture: true }
    );

    /* scroll 不冒泡但会走捕获阶段 —— 挂在 document 上一个就能看住所有元素 */
    document.addEventListener(
      'scroll',
      (e) => {
        const t = e.target;
        if (!(t instanceof Element)) return;
        const now = performance.now();

        if (sbMode) {
          if (sbMode.el !== t || now > sbMode.until || !thumbMetrics(t)) {
            sbEnd();
            return;
          }
          sbMode.until = now + 3000; /* 还在拖：维持隐藏 */
          return;
        }
        if (now - lastDown < 400) return; /* 刚点过内容 —— 是普通点击/拖拽 */
        if (now - lastSeen.t > 1500) return; /* 光标坐标太旧，不可信 */
        const tr = thumbMetrics(t);
        if (!tr) return;
        if (lastSeen.x < tr.x0 - 4 || lastSeen.x > tr.x1 + 4) return;
        if (lastSeen.y < tr.top - 6 || lastSeen.y > tr.bottom + 6) return;
        /* 光标就在滑块上、scroll 在走、又没收到 pointerdown —— 只能是拖滑块 */
        sbMode = { el: t, until: now + 3000 };
        sbHide(true);
      },
      { capture: true, passive: true }
    );

    /* 拖拽期间给光标挂个 is-dragging：圆点略收一点，表示"抓住了"。
       不做拉伸 —— 白点被拉长会变成一颗花生。 */
    function setDragging(on) {
      dot.classList.toggle('is-dragging', on);
      ring.classList.toggle('is-dragging', on);
    }
    window.addEventListener('pointerdown', () => setDragging(true), { passive: true });
    window.addEventListener('pointerup', () => setDragging(false), { passive: true });
    window.addEventListener('pointercancel', () => setDragging(false), { passive: true });

    document.addEventListener('mouseleave', () => {
      dot.classList.add('is-hidden');
      ring.classList.add('is-hidden');
    });

    /* 白点直接钉在鼠标坐标上，不做插值 —— 指针本体必须零延迟。
       外环跟手带一点滞后（弹簧），移动越快沿运动方向拉得越长。 */
    let ringX = mx;
    let ringY = my;
    let vx = 0;
    let vy = 0;
    let lastT = performance.now();

    (function followRing(now) {
      const t = now || performance.now();
      /* 按真实帧间隔积分，掉帧时不会突然变慢 */
      const dt = Math.min((t - lastT) / 16.667, 3);
      lastT = t;

      /* 弹簧：0.24 的刚度、0.72 的阻尼。指数逼近太"粘"，
         带速度的弹簧松手后还会轻轻回弹一下。 */
      const stiffness = 0.24;
      const damping = 0.72;
      vx = (vx + (mx - ringX) * stiffness) * damping;
      vy = (vy + (my - ringY) * stiffness) * damping;
      ringX += vx * dt;
      ringY += vy * dt;

      ring.style.left = ringX + 'px';
      ring.style.top = ringY + 'px';

      /* 速度映射成拉伸，两个节点各自用：
           dot  —— 只在 idle / text 态可见时拉长（链接态 dot 是透明的，
                   写了也看不见，但省掉一次 setProperty）
           ring —— 链接态那圈光晕拉长，让"可点"的反馈也跟着跟手 */
      const speed = Math.min(Math.hypot(vx, vy) / 26, 1);
      const stretch = 1 + speed * 0.32;
      const shrink = 1 - speed * 0.12;
      const angle = (Math.atan2(vy, vx) * 180) / Math.PI;
      const st = stretch.toFixed(3);
      const sh = shrink.toFixed(3);
      const ang = angle.toFixed(1) + 'deg';

      if (mode === 'link') {
        ring.style.setProperty('--stretch', st);
        ring.style.setProperty('--shrink', sh);
        ring.style.setProperty('--angle', ang);
      } else {
        dot.style.setProperty('--stretch', st);
        dot.style.setProperty('--shrink', sh);
        dot.style.setProperty('--angle', ang);
      }

      requestAnimationFrame(followRing);
    })();

    /* 文本态竖线的高度跟着光标底下的字号走。
       在 12px 正文上竖线和写法一样高，在 32px 标题上就该长一截；
       写死一个高度永远有一边不对。 */
    let barH = 24;

    function measureBar(node) {
      if (!node || node.nodeType !== 1) return 0;
      let base = 0;
      try {
        const cs = getComputedStyle(node);
        base = parseFloat(cs.fontSize) || 0;
      } catch (e) {
        base = 0;
      }
      /* 拿到字号就按 1.35 倍做竖线（行高的手感），
         拿不到就退回一个跟 20px 圆点相称的默认值 */
      if (!base) return 0;
      return Math.round(Math.min(Math.max(base * 1.35, 18), 56));
    }

    function setBarFor(node) {
      const next = measureBar(node) || 26;
      if (next === barH) return;
      barH = next;
      dot.style.setProperty('--bar-h', barH + 'px');
    }

    function setMode(next, node) {
      /* 进了文本态就把 cursor 底下那个元素量一下字号，
         竖线该多长跟着字走 —— 标题里和正文里不该一样长。 */
      if (next === 'text') setBarFor(node);
      if (next === mode) return;
      mode = next;
      dot.classList.toggle('is-text', next === 'text');
      dot.classList.toggle('is-link', next === 'link');
      ring.classList.toggle('is-link', next === 'link');
      /* 环只在链接态出现，文本态/idle 态保持透明（见 CSS #cursor-ring） */
      ring.classList.toggle('is-text', next === 'text');
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
      (e) => setMode(modeFor(e.target), e.target),
      { passive: true }
    );
    window.addEventListener(
      'pointermove',
      (e) => setMode(modeFor(e.target), e.target),
      { passive: true }
    );
    document.addEventListener('mouseover', (e) => setMode(modeFor(e.target), e.target));
    /* 拖拽/滚动/内容变化后指针不动也要刷新状态 */
    window.addEventListener(
      'scroll',
      () => {
        const t = document.elementFromPoint(mx, my);
        setMode(modeFor(t), t);
      },
      { passive: true }
    );
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

  /* -------------------------------------------------------- */
  /*  光标坐标桥                                                */
  /*  光标模块（上层 IIFE）把 syncCursor 挂到 window 上，          */
  /*  拖拽 / 缩放才能主动喂坐标。模块加载顺序无关，用可选调用。  */
  /* -------------------------------------------------------- */

  function dragWin(win, event) {
    if (win.max || event.button !== 0) return;
    const node = win.el;
    const rect = node.getBoundingClientRect();
    const area = el.windows.getBoundingClientRect();
    const offX = event.clientX - rect.left;
    const offY = event.clientY - rect.top;

    node.classList.add('dragging');
    /* 捕获指针：鼠标快速甩出窗口也不会丢事件，
       拖动大窗口时指针常常跑到标题栏外面 */
    if (node.setPointerCapture && event.pointerId != null) {
      try {
        node.setPointerCapture(event.pointerId);
      } catch (err) {
        /* 某些浏览器对非活动指针会抛错，忽略即可 */
      }
    }

    function move(ev) {
      /* 光标先跟着走，再算窗口位置：万一后面的钳制逻辑抛错，
         至少指针不会脱手 */
      if (window.__lumeCursorSync) window.__lumeCursorSync(ev);
      let x = ev.clientX - area.left - offX;
      let y = ev.clientY - area.top - offY;
      x = Math.min(Math.max(x, -rect.width + 140), area.width - 140);
      y = Math.min(Math.max(y, 0), area.height - 46);
      node.style.left = x + 'px';
      node.style.top = y + 'px';
      /* 窗口带着选区移动时，自绘选区框是按屏幕坐标画的，
         必须跟着重算，否则框留在原地（表现为"选区偏移"） */
      if (window.LumeSel) window.LumeSel.refresh();
    }
    function up() {
      node.classList.remove('dragging');
      window.removeEventListener('pointermove', move);
      window.removeEventListener('pointerup', up);
      window.removeEventListener('pointercancel', up);
    }
    window.addEventListener('pointermove', move);
    window.addEventListener('pointerup', up);
    window.addEventListener('pointercancel', up);
  }

  function resizeWin(win, event) {
    event.preventDefault();
    const node = win.el;
    const rect = node.getBoundingClientRect();

    function move(ev) {
      if (window.__lumeCursorSync) window.__lumeCursorSync(ev);
      node.style.width = Math.max(340, ev.clientX - rect.left) + 'px';
      node.style.height = Math.max(220, ev.clientY - rect.top) + 'px';
      if (window.LumeSel) window.LumeSel.refresh();
    }
    function up() {
      window.removeEventListener('pointermove', move);
      window.removeEventListener('pointerup', up);
      window.removeEventListener('pointercancel', up);
    }
    window.addEventListener('pointermove', move);
    window.addEventListener('pointerup', up);
    window.addEventListener('pointercancel', up);
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
      /* 复用已有窗口时也要把新的目标喂进去，否则「在新标签打开」
         会静默失败 —— 窗口亮起来了，但还停在上一页 */
      if (opts.url && win.navigate) win.navigate(opts.url);
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
        if (opts.url && w.navigate) w.navigate(opts.url);
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
      /* transient 应用不进 Dock（只在别处给入口，比如 About 里开子窗口）。
         目前没有 App 用到，留着这个开关给以后的临时窗口。 */
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
        { ico: 'browser', label: 'Browser', dot: running.has('browser'), run: launch('browser') },
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
    /* 万一从关机态直接切到锁屏（菜单/快捷键都可能），
       先把 .is-poweroff 和 system-halted 摘掉，
       否则锁屏会继承关机的暗色底和 pointer 光标 */
    clearHalt();
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
    clearHalt();
  }

  /* 关机。
     和锁屏不一样：锁屏是临时盖一层，点一下就回来；关机是真的下线。
     所以这里给两个出口，而不是一个：

       1. Quit        —— 关标签页。window.close() 只在脚本自己开的窗口里
                        生效，用户手输网址进来的会被拦，这时退化成回首页
                        （站点根目录），等于"离开这个页面"。
       2. Reboot      —— 清掉 booted 标记再刷新，重走一遍开机动画。

     以前整块 veil 都是 onclick=reload，手机端点哪儿都重启，
     想退出反而没路走。 */
  function powerOff() {
    el.veil.hidden = false;
    el.veil.classList.add('is-poweroff');
    el.veil.innerHTML =
      '<div class="veil-inner">' +
      '<div class="veil-time po-word">goodbye.</div>' +
      '<div class="veil-date po-sub">system halted · it is now safe to close this tab</div>' +
      '<div class="po-actions">' +
      '<button class="veil-btn po-quit" type="button" id="po-quit">Quit</button>' +
      '<button class="veil-btn po-reboot" type="button" id="po-reboot">Reboot</button>' +
      '</div>' +
      '<div class="po-hint" id="po-hint" hidden></div>' +
      '</div>';

    /* 关机态下不要再有光标尾随，桌面已经下线了 */
    document.documentElement.classList.add('system-halted');

    const hint = $('#po-hint');
    const say = (text) => {
      if (!hint) return;
      hint.textContent = text;
      hint.hidden = false;
    };

    const quit = (e) => {
      if (e) e.stopPropagation();
      /* about:blank 是个安全的空页；若被拦则退到站点首页 */
      try {
        window.close();
      } catch (err) {
        /* 忽略：下面的兜底会处理 */
      }
      /* window.close() 成功的话页面已经没了，走到这行说明被拦 */
      setTimeout(() => {
        try {
          location.href = '/';
        } catch (err) {
          say('Your browser blocked this. Close the tab manually.');
        }
      }, 80);
    };

    const reboot = (e) => {
      if (e) e.stopPropagation();
      try {
        sessionStorage.removeItem('lume.booted');
      } catch (err) {}
      location.reload();
    };

    const quitBtn = $('#po-quit');
    const rebootBtn = $('#po-reboot');
    if (quitBtn) quitBtn.addEventListener('click', quit);
    if (rebootBtn) rebootBtn.addEventListener('click', reboot);

    /* 点空白处 = 退出（最常用的动作，给最大的热区）。
       按钮自己 stopPropagation，不会误触。 */
    el.veil.onclick = quit;
  }

  /* 回到"活着"的状态：解锁 / 重启前都要清掉关机残渣 */
  function clearHalt() {
    document.documentElement.classList.remove('system-halted');
    if (el.veil) el.veil.classList.remove('is-poweroff');
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
      /* 光加 .done 只是 opacity:0 + visibility:hidden，元素还留在 DOM 里。
         而 .boot-log / .boot-version 是 position: fixed —— 它们会脱离
         父层的层叠上下文，在某些渲染路径下漏出来，开机日志和右下角版本号
         就变成一层半透明的残影糊在桌面上。
         等淡出过渡（0.7s）走完直接删掉，彻底断根。 */
      setTimeout(() => el.boot.remove(), 800);
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
    const B = window.LumeBuild;
    return {
      os: 'LumeOS 1.0 "Nebula"',
      kernel: '1.0.0-nebula',
      uptime: uptimeText(),
      apps: Object.keys(APPS).filter((id) => !APPS[id].transient).length,
      theme: root.dataset.theme === 'light' ? 'light' : 'dark',
      engine: engineName(),
      memory: (navigator.deviceMemory || 16) + ' GB',
      build: buildVersion(),
      /* 这一次打开是「本地命中」还是「刚从网络下的」，一眼能看出来。
         三态分开：local 开场就命中；fetched 这次下了并且存好了；
         partial 这次下了但没存成（无痕模式/配额满）。 */
      cache: !B || !B.known ? 'off' : B.cached ? 'local' : B.stored ? 'fetched' : 'partial',
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

  /* Tips / Licence 原先在菜单栏左侧有独立标签，现已并入 About，
     菜单栏不再挂入口。两个 App 本身保留：About 里的
     「打开完整的 Licence 窗口 →」还会调 openApp('licence')。 */

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
     所以到这里的只剩桌面、标题栏、Dock、菜单栏和纯文字区。

     抽成 openCtxAt 是为了让手机长按也能走同一套分支 ——
     长按本来就该等价于右键，两套逻辑分家迟早会走歪。 */
  function openCtxAt(t, x, y) {
    /* 已经弹出来的菜单上再点右键：不重复弹，也不穿越到底下的桌面 */
    if (t.closest('.menu, #spotlight, #veil')) return;

    const winEl = t.closest('.window');

    if (winEl) {
      const key = Array.from(wins.keys()).find((k) => wins.get(k).el === winEl);
      const win = key && wins.get(key);

      if (t.closest('.win-titlebar')) {
        closeMenus();
        if (win) openWinMenu(x, y, win);
        return;
      }
      /* 正文里的输入框 / 文本区给编辑菜单 */
      const field = t.closest('input:not([type="hidden"]), textarea');
      if (field && !field.readOnly && !field.disabled) {
        closeMenus();
        openEditMenu(x, y, field);
        return;
      }
      /* 其余正文还没自带菜单——给一个通用的窗口菜单，总比原生菜单好 */
      closeMenus();
      if (win) openWinMenu(x, y, win);
      return;
    }

    const deskIcon = t.closest('.desk-icon');
    if (deskIcon) {
      closeMenus();
      openDeskIconMenu(x, y, deskIcon);
      return;
    }

    const dockItem = t.closest('.dock-item[data-app]');
    if (dockItem) {
      closeMenus();
      openDockMenu(x, y, dockItem);
      return;
    }

    if (t.closest('.menubar')) {
      openSysMenu(x, y);
      return;
    }
    if (t.closest('.dock')) return;

    closeMenus();
    openCtxMenu(x, y);
  }

  document.addEventListener('contextmenu', (e) => {
    if (e.defaultPrevented) return;
    e.preventDefault();
    openCtxAt(e.target, e.clientX, e.clientY);
  });

  /* Edge 独有的「mini menu」：拖选文字后自动弹出 copy/search 那一小条，
     它不触发 contextmenu 事件，上面的拦不住。网页端唯一有效的抑制手段
     是在有非空选区的 mouseup 上 preventDefault。输入框不拦 —— 拦了可能
     吃掉 textarea 拖选的落点。
     关键：只拦「拖选结束」的那次 mouseup。原地单击时 mouseup 一刻选区
     还没塌缩，无脑 preventDefault 会把浏览器收起选区/放光标的默认行为
     一并吃掉 —— 表现为「点一下选区不消失」。用按下→松开的位移区分：
     拖选位移大，单击几乎为零。 */
  if (/Edg\//.test(navigator.userAgent)) {
    let mdX = 0;
    let mdY = 0;
    window.addEventListener(
      'mousedown',
      (e) => {
        mdX = e.clientX;
        mdY = e.clientY;
      },
      { capture: true, passive: true }
    );
    window.addEventListener('mouseup', (e) => {
      if (e.target.closest('input, textarea, [contenteditable]')) return;
      if (Math.hypot(e.clientX - mdX, e.clientY - mdY) < 6) return;
      const s = window.getSelection();
      if (s && !s.isCollapsed) e.preventDefault();
    });
  }

  /* -------------------------------------------------------- */
  /*  文本选择：自绘选区 + 选中菜单 + 手柄                        */
  /* -------------------------------------------------------- */
  /* 浏览器的原生 ::selection 有两个办不到的地方：
     ① 颜色和形状由浏览器画，跟主题对不上（而且 iOS 上是固定的蓝）；
     ② 手机里那两个蓝色水滴手柄，样式完全不可控。
     所以这里把原生高亮改成透明，自己按 Range 的 client rects 画一层，
     再在首尾放两个能拖的手柄。复制仍然用 Clipboard API，
     剪贴板这块不自己实现 —— 那是系统的事。 */
  const SEL = (function selection() {
    const layer = document.createElement('div');
    layer.className = 'sel-layer';
    layer.setAttribute('aria-hidden', 'true');
    layer.hidden = true;

    const menu = document.createElement('div');
    menu.className = 'sel-menu';
    menu.hidden = true;
    menu.setAttribute('role', 'menu');
    menu.innerHTML = `
      <button class="sel-btn" type="button" data-sel="copy">${ICON.copy}Copy</button>
      <button class="sel-btn" type="button" data-sel="all">${ICON.selectall}Select all</button>
      <span class="sel-sep"></span>
      <button class="sel-btn danger" type="button" data-sel="clear">${ICON.close}Clear</button>`;

    document.body.appendChild(layer);
    document.body.appendChild(menu);

    const coarse = window.matchMedia('(pointer: coarse)');

    /* 手柄只在触摸设备上出现：鼠标用户的指针本身就是"手柄"，
       再画两个点反而挡视线。 */
    const gripA = document.createElement('div');
    const gripB = document.createElement('div');
    gripA.className = 'sel-grip is-start';
    gripB.className = 'sel-grip is-end';
    gripA.hidden = gripB.hidden = true;
    layer.appendChild(gripA);
    layer.appendChild(gripB);

    let boxes = [];   /* .sel-box 节点池，复用避免每次拖选都建一堆 DOM */
    let range = null; /* 当前选区的 Range 快照 */
    let field = null; /* 选区在 input/textarea 里时，记下那个元素 */
    let open = false;

    function box(i) {
      while (boxes.length <= i) {
        const b = document.createElement('div');
        b.className = 'sel-box';
        layer.insertBefore(b, gripA);
        boxes.push(b);
      }
      return boxes[i];
    }

    function hideBoxes(from) {
      for (let i = from; i < boxes.length; i++) boxes[i].hidden = true;
    }

    /* ---------- textarea / input 里的坐标 ---------- */
    /* textarea 不暴露任何 layout API，拿不到字符坐标。
       唯一的办法是造一个同款式的隐藏 div（.editor-mirror 已经有了），
       把"光标前的文本 + 一个零宽 span"塞进去，量那个 span 的位置。 */
    function mirrorOf(f) {
      const host = f.closest('.editor-wrap') || f.parentNode;
      if (!host) return null;
      let m = host.querySelector('.editor-mirror');
      if (!m) {
        m = document.createElement('div');
        m.className = 'editor-mirror';
        host.appendChild(m);
      }
      const cs = getComputedStyle(f);
      ['font-family', 'font-size', 'font-weight', 'line-height', 'letter-spacing',
       'padding-top', 'padding-left', 'padding-right', 'padding-bottom',
       'border-top-width', 'border-left-width', 'white-space', 'tab-size'].forEach((p) => {
        m.style[p] = cs[p];
      });
      m.style.width = f.clientWidth + 'px';
      return m;
    }

    /* [pos] 这个字符在 textarea 内容区里的坐标 */
    function caretRect(f, pos) {
      const m = mirrorOf(f);
      if (!m) return null;
      m.textContent = '';
      m.appendChild(document.createTextNode(f.value.slice(0, pos)));
      const marker = document.createElement('span');
      marker.textContent = '\u200b';
      marker.style.cssText = 'display:inline-block;width:0;overflow:hidden';
      m.appendChild(marker);
      const r = marker.getBoundingClientRect();
      const b = m.getBoundingClientRect();
      return {
        left: r.left - b.left,
        top: r.top - b.top,
        height: r.height || parseFloat(getComputedStyle(f).lineHeight) || 18
      };
    }

    /* 把 [start,end) 切成逐行的矩形。行数多时只取前 200 段，
       再多的选区也没人看得清，没必要量到卡顿。 */
    function measureField(f) {
      const v = f.value;
      const s = f.selectionStart;
      const e = f.selectionEnd;
      if (s === e) return [];

      const rect = f.getBoundingClientRect();
      const cs = getComputedStyle(f);
      const lineH = parseFloat(cs.lineHeight) || 18;
      /* caretRect 量的是「marker 相对镜子 border-box」的偏移，而镜子带着和
         textarea 同款的 padding —— 结果里已经含 padL/padT，这里只补边框
         (clientLeft/Top) 和滚动量。再叠一次 padding 会让选区框整体下移
         一个 padT、右移一个 padL（编辑器里就是「掉到下一行」）。 */
      const ox = rect.left + f.clientLeft - f.scrollLeft;
      const oy = rect.top + f.clientTop - f.scrollTop;

      const out = [];
      const lines = v.split('\n');
      let pos = 0;
      for (let li = 0; li < lines.length && out.length < 200; li++) {
        const lineStart = pos;
        const lineEnd = pos + lines[li].length;
        pos = lineEnd + 1;

        const a = Math.max(s, lineStart);
        const b = Math.min(e, lineEnd);
        if (a > b) continue;
        /* 选区跨过了这一行的换行符：到行尾后再补一点，视觉上才连得上 */
        const coversBreak = e > lineEnd && s <= lineEnd;

        const ra = caretRect(f, a);
        if (!ra) continue;
        let x1 = ra.left;
        let x2;
        if (b === lineEnd && coversBreak && a === b) {
          x2 = x1 + 6; /* 只选了换行符本身 */
        } else {
          const rb = caretRect(f, b);
          x2 = rb ? rb.left : x1 + 6;
          if (x2 <= x1) x2 = x1 + 6;
        }

        out.push({
          left: ox + x1,
          top: oy + ra.top,
          width: Math.max(1, x2 - x1),
          height: lineH
        });
      }
      return out;
    }

    /* 当前选区的矩形列表 */
    function rects() {
      if (field) return measureField(field);
      if (!range) return [];
      return Array.from(range.getClientRects())
        .filter((r) => r.width > 0.5 && r.height > 0.5)
        .map((r) => ({ left: r.left, top: r.top, width: r.width, height: r.height }));
    }

    /* 两块选区矩形是不是"贴着"的（下面那块顶着上面那块，且横向有交集）。
       容差 1.5px：行盒之间常因四舍五入/行高取整漏出 1px 的缝，
       按 0 判会把本该连成一片的段落判成一行一块。 */
    const JOIN_TOL = 1.5;
    function joined(a, b) {
      if (!a || !b) return false;
      /* 只认"b 在 a 下方且贴住"：缝隙超过容差算两块；
         重叠（负数）说明行盒本来就互相咬合，算连着。 */
      if (b.top - (a.top + a.height) > JOIN_TOL) return false;
      const overlapX = Math.min(a.left + a.width, b.left + b.width) - Math.max(a.left, b.left);
      return overlapX > 0.5;
    }

    /* 给每块矩形标上"上方/下方是不是贴着另一块"，圆角靠它决定。
       必须在裁剪之前用原始几何算：裁过的块贴在裁剪边界上，
       拿裁剪后的坐标去比会把连着的段落判成一块一块。 */
    function markJoins(list) {
      for (let i = 0; i < list.length; i++) {
        list[i].up = joined(list[i - 1], list[i]);
        list[i].down = joined(list[i], list[i + 1]);
      }
      return list;
    }

    /* 矩形是按文档坐标算的，而 .sel-layer 只会按视口裁剪（overflow: hidden）。
       窗口内容区、textarea 自己的滚动框这些「容器裁剪」它管不了 ——
       于是选区滚出窗口后，框还会继续画在窗口外面（桌面上）。
       这里沿祖先链收集裁剪框，把每块矩形夹进去，夹没了就不画。

       视口本身也当成一个裁剪框，顺便省掉"整块滚出屏幕还在画"的情况。 */
    function clipToBoxes(list) {
      const boxes = [{ x0: 0, y0: 0, x1: innerWidth, y1: innerHeight }];

      const push = (el, ox, oy) => {
        /* clientWidth/Height 已经扣掉边框和滚动条，正好是内容可见区 */
        if (el.clientWidth <= 0 || el.clientHeight <= 0) return; /* 还没排版 / 已隐藏 */
        const b = el.getBoundingClientRect();
        boxes.push({
          x0: ox === 'visible' ? -Infinity : b.left + el.clientLeft,
          x1: ox === 'visible' ? Infinity : b.left + el.clientLeft + el.clientWidth,
          y0: oy === 'visible' ? -Infinity : b.top + el.clientTop,
          y1: oy === 'visible' ? Infinity : b.top + el.clientTop + el.clientHeight
        });
      };

      /* textarea / input：它自己的内容区就是裁剪框（文字会滚出去） */
      if (field) push(field, 'auto', 'auto');

      /* 再往上找所有 overflow != visible 的祖先（窗口外壳就是这种） */
      let el = field || (range && range.startContainer);
      if (el && el.nodeType !== 1) el = el.parentElement;
      while (el && el !== document.body && el !== document.documentElement) {
        const cs = getComputedStyle(el);
        /* overflowX/Y 和简写 overflow 都要看：有的环境（jsdom）只忠实反映
           简写，不拆到两个轴上；拿不到计算值时按 visible 处理，别误裁。 */
        const parts = (cs.overflow || '').trim().split(/\s+/).filter(Boolean);
        const shX = parts[0] || '';
        const shY = parts[1] || shX;
        const axis = (raw, sh) =>
          raw && raw !== 'visible' ? raw : sh && sh !== 'visible' ? sh : 'visible';
        const cx = axis(cs.overflowX, shX);
        const cy = axis(cs.overflowY, shY);
        if (cx !== 'visible' || cy !== 'visible') push(el, cx, cy);
        el = el.parentElement;
      }

      const out = [];
      for (const r of list) {
        let x0 = r.left;
        let y0 = r.top;
        let x1 = r.left + r.width;
        let y1 = r.top + r.height;
        for (const b of boxes) {
          if (x0 < b.x0) x0 = b.x0;
          if (x1 > b.x1) x1 = b.x1;
          if (y0 < b.y0) y0 = b.y0;
          if (y1 > b.y1) y1 = b.y1;
        }
        if (x1 - x0 < 0.6 || y1 - y0 < 0.6) continue; /* 完全被裁掉 */
        out.push({ left: x0, top: y0, width: x1 - x0, height: y1 - y0, up: r.up, down: r.down });
      }
      return out;
    }

    function paint(list) {
      const n = Math.min(list.length, 400);
      for (let i = 0; i < n; i++) {
        const r = list[i];
        const b = box(i);
        b.hidden = false;
        /* 圆角按几何关系判：贴着的那一边保持方角，悬空的那一边才圆。
           —— 贴合的行（正文、终端）连成一片，只有整段外轮廓是圆的，
              中间不会在接缝处咬出一排小凹口；
           —— 行与行之间真有边距时（行距大、每行独立成块），两块各自四角
              全圆，中间的圆角就不会"断开"了。 */
        b.className = 'sel-box' + (r.up ? '' : ' is-top') + (r.down ? '' : ' is-bottom');
        b.style.left = Math.round(r.left) + 'px';
        b.style.top = Math.round(r.top) + 'px';
        b.style.width = Math.max(1, Math.round(r.width)) + 'px';
        b.style.height = Math.round(r.height) + 'px';
      }
      hideBoxes(n);
    }

    function placeGrips(list) {
      const show = coarse.matches && open && list.length > 0;
      gripA.hidden = gripB.hidden = !show;
      if (!show) return;
      const first = list[0];
      const last = list[list.length - 1];
      gripA.style.left = Math.round(first.left) + 'px';
      gripA.style.top = Math.round(first.top + first.height) + 'px';
      gripB.style.left = Math.round(last.left + last.width) + 'px';
      gripB.style.top = Math.round(last.top + last.height) + 'px';
    }

    /* 菜单贴在选区上方居中；上方放不下就翻到下方 */
    function placeMenu(list) {
      if (!open || !list.length) {
        menu.hidden = true;
        return;
      }
      menu.hidden = false;
      const mb = menu.getBoundingClientRect();
      const top0 = Math.min.apply(null, list.map((r) => r.top));
      const bot0 = Math.max.apply(null, list.map((r) => r.top + r.height));
      const left0 = Math.min.apply(null, list.map((r) => r.left));
      const right0 = Math.max.apply(null, list.map((r) => r.left + r.width));

      const GAP = 10;
      let top = top0 - mb.height - GAP;
      let flip = false;
      if (top < 8) {
        top = bot0 + GAP;
        flip = true;
      }
      let left = (left0 + right0) / 2 - mb.width / 2;
      left = Math.max(8, Math.min(left, innerWidth - mb.width - 8));
      top = Math.max(8, Math.min(top, innerHeight - mb.height - 8));

      menu.style.left = Math.round(left) + 'px';
      menu.style.top = Math.round(top) + 'px';
      menu.style.transformOrigin = flip ? '50% 0%' : '50% 100%';
    }

    function refresh() {
      const list = range || field ? rects() : [];

      if (!list.length) {
        open = false;
        layer.hidden = true;
        menu.hidden = true;
        gripA.hidden = gripB.hidden = true;
        return;
      }

      /* 先标连接关系（用原始几何），再裁剪出真正能看见的部分。
         裁完一块不剩 = 选区整体滚出了可视区（或所在窗口被收起）：
         隐藏图层但不清 selection 状态，滚回来 schedule() 会重新画。 */
      const draw = clipToBoxes(markJoins(list));
      if (!draw.length) {
        layer.hidden = true;
        menu.hidden = true;
        gripA.hidden = gripB.hidden = true;
        return;
      }

      /* 两端都画自绘选区框：原生 ::selection 的形状由浏览器决定，
         圆角加不上，所以高亮统一归我们管（触摸设备额外多两个拖拽手柄：
         鼠标用户的指针本身就是手柄，再画两个点反而挡视线）。 */
      layer.hidden = false;
      layer.classList.toggle('is-editor', !!field);
      paint(draw);
      placeGrips(draw);
      if (open) placeMenu(draw);
    }

    /* 读一次当前选区状态。activeElement 是 textarea 时，
       getSelection() 拿不到它的内部选区，必须分开处理。 */
    function sync() {
      const ae = document.activeElement;
      const isField = ae && (ae.tagName === 'TEXTAREA' ||
        (ae.tagName === 'INPUT' && /^(text|search|url|email|tel)$/i.test(ae.type || 'text')));
      if (isField && ae.selectionStart !== ae.selectionEnd) {
        field = ae;
        range = null;
      } else {
        field = null;
        const s = getSelection();
        range = s && !s.isCollapsed && s.rangeCount ? s.getRangeAt(0).cloneRange() : null;
      }
    }

    /* selectionchange 在拖选时高频触发，用 rAF 合帧 */
    let pending = 0;
    function schedule() {
      if (pending) return;
      pending = requestAnimationFrame(() => {
        pending = 0;
        sync();
        refresh();
      });
    }

    function selectedText() {
      if (field) return field.value.slice(field.selectionStart, field.selectionEnd);
      return range ? range.toString() : '';
    }

    async function copy(text) {
      if (!text) return false;
      try {
        await navigator.clipboard.writeText(text);
        return true;
      } catch (err) {
        /* 非安全上下文 / 权限被拒：退回已经废弃但还能用的 execCommand */
        try {
          const ta = document.createElement('textarea');
          ta.value = text;
          ta.style.cssText = 'position:fixed;left:-9999px;top:0;opacity:0';
          document.body.appendChild(ta);
          ta.select();
          const ok = document.execCommand('copy');
          ta.remove();
          return ok;
        } catch (e2) {
          return false;
        }
      }
    }

    function clear() {
      /* 两条路都要走：field 可能是上一帧的快照，而用户此刻
         可能已经把焦点搬到别的文本框了。收选区这种事宁滥勿缺。 */
      if (field) field.setSelectionRange(field.selectionStart, field.selectionStart);
      const ae = document.activeElement;
      if (ae && (ae.tagName === 'TEXTAREA' || ae.tagName === 'INPUT') &&
          typeof ae.selectionStart === 'number') {
        ae.setSelectionRange(ae.selectionStart, ae.selectionStart);
      }
      if (getSelection) getSelection().removeAllRanges();
      open = false;
      range = null;
      field = null;
      layer.hidden = true;
      menu.hidden = true;
      gripA.hidden = gripB.hidden = true;
    }

    /* 弹出菜单。必须先 sync() 再判断 —— rects() 依赖 range / field，
       而这两个是上一次 schedule() 的结果。外部（双击、touchend）调进来时
       中间可能刚换过选区，不先同步会拿到旧数据、甚至直接判成空。 */
    function showMenu() {
      sync();
      if (!rects().length) return;
      open = true;
      refresh();
    }

    function hideMenu() {
      open = false;
      menu.hidden = true;
      gripA.hidden = gripB.hidden = true;
    }

    /* ---------- 菜单 ---------- */
    /* 点菜单不能把选区弄丢：pointerdown 上就拦住默认行为 */
    menu.addEventListener('pointerdown', (e) => {
      e.preventDefault();
      e.stopPropagation();
    });
    menu.addEventListener('click', async (e) => {
      const btn = e.target.closest('[data-sel]');
      if (!btn) return;
      e.preventDefault();
      e.stopPropagation();
      const act = btn.dataset.sel;

      if (act === 'copy') {
        const ok = await copy(selectedText());
        toast(ok ? 'Copied' : 'Copy blocked by the browser');
      } else if (act === 'all') {
        if (field) {
          field.focus();
          field.select();
        } else if (range) {
          const c = range.commonAncestorContainer;
          const host = c.nodeType === 1 ? c : c.parentElement;
          if (host) {
            const r = document.createRange();
            r.selectNodeContents(host);
            const s = getSelection();
            s.removeAllRanges();
            s.addRange(r);
          }
        }
        schedule();
        return;
      } else if (act === 'clear') {
        clear();
        return;
      }
      hideMenu();
    });

    /* ---------- 事件 ---------- */
    document.addEventListener('selectionchange', () => {
      if (field) return;
      schedule();
    });

    document.addEventListener('keyup', (e) => {
      if (e.shiftKey || e.key === 'a' || e.key === 'A') schedule();
    });

    document.addEventListener('keydown', (e) => {
      if (e.key === 'Escape') clear();
    });

    /* 鼠标：拖选过程中只画框，松手才弹菜单（边拖边弹太分神） */
    document.addEventListener('mouseup', (e) => {
      if (e.button !== 0) return;
      if (e.target.closest('.sel-menu, .sel-grip')) return;
      setTimeout(() => {
        sync();
        if (selectedText().trim()) showMenu();
        else hideMenu();
      }, 0);
    });

    /* 鼠标双击选词也接管一下，颜色统一 */
    document.addEventListener('dblclick', (e) => {
      if (coarse.matches) return;
      setTimeout(() => {
        sync();
        if (selectedText().trim()) showMenu();
      }, 0);
    });

    /* 点空白收起。注意不能在"正要开始新的一划"时收，
       否则一按下菜单就没了，感觉像点不中。
       触摸端还有个毛病：点一下别处浏览器经常不收起选区，
       自绘框就赖在原地 —— 所以左键按下时干脆主动清掉整个选区
       （右键除外，右键菜单的复制还要用；输入框让浏览器自己管）。 */
    document.addEventListener('pointerdown', (e) => {
      if (menu.contains(e.target) || layer.contains(e.target)) return;
      if (e.button === 0 && !e.target.closest('input, textarea, [contenteditable]')) {
        const s = getSelection();
        if (s && !s.isCollapsed) {
          clear();
          return;
        }
      }
      if (!open) return;
      hideMenu();
    });

    /* 图层可见（选区框在画）或菜单开着，滚动/缩放都得重算 ——
       菜单收起后 open=false 但框还挂着，只判 open 会漏掉这种情况。 */
    window.addEventListener('scroll', () => { if (!layer.hidden || open) schedule(); }, true);
    window.addEventListener('resize', () => { if (!layer.hidden || open) schedule(); });

    /* ---------- 手柄拖拽 ---------- */
    /* 拖手柄时不去改浏览器的选区（会跟它抢），
       而是记住另一端作为锚点，用手指下的位置重设选区。
       这样拖到窗口外也能连续扩展。 */
    let drag = null;

    function caretAt(x, y) {
      if (document.caretRangeFromPoint) return document.caretRangeFromPoint(x, y);
      if (document.caretPositionFromPoint) {
        const p = document.caretPositionFromPoint(x, y);
        if (!p) return null;
        const r = document.createRange();
        r.setStart(p.offsetNode, p.offset);
        r.collapse(true);
        return r;
      }
      return null;
    }

    function startGrip(which) {
      return (e) => {
        e.preventDefault();
        e.stopPropagation();
        const s = getSelection();
        if (!s.rangeCount) return;
        const r = s.getRangeAt(0);
        drag = which === 'start'
          ? { which, node: r.endContainer, offset: r.endOffset }
          : { which, node: r.startContainer, offset: r.startOffset };
        e.currentTarget.setPointerCapture?.(e.pointerId);
      };
    }

    function moveGrip(which) {
      return (e) => {
        if (!drag || drag.which !== which) return;
        e.preventDefault();
        const p = caretAt(e.clientX, e.clientY);
        if (!p) return;
        const s = getSelection();
        const nr = document.createRange();
        try {
          if (which === 'start') {
            nr.setStart(p.startContainer, p.startOffset);
            nr.setEnd(drag.node, drag.offset);
          } else {
            nr.setStart(drag.node, drag.offset);
            nr.setEnd(p.startContainer, p.startOffset);
          }
          if (nr.collapsed) return;
          s.removeAllRanges();
          s.addRange(nr);
        } catch (err) {
          /* 跨了不可选区域会抛，跳过这一帧 */
          return;
        }
        range = nr.cloneRange();
        const list = rects();
        paint(list);
        placeGrips(list);
        placeMenu(list);
        window.__lumeCursorSync?.(e);
      };
    }

    function endGrip() {
      drag = null;
    }

    gripA.addEventListener('pointerdown', startGrip('start'));
    gripB.addEventListener('pointerdown', startGrip('end'));
    gripA.addEventListener('pointermove', moveGrip('start'));
    gripB.addEventListener('pointermove', moveGrip('end'));
    window.addEventListener('pointerup', endGrip);
    window.addEventListener('pointercancel', endGrip);

    /* 触摸双击：某些浏览器双击后触发 selectionchange 的时机很晚，
       而且 dblclick 在触摸设备上根本不来。这里自己判双击 ——
       两次 touchend 间隔 < 320ms 且位移 < 24px 就算。
       选中一个词交给浏览器（它能按语言分词），我们只负责接管后续：
       等它落定后弹菜单、放出手柄。 */
    let lastTap = 0;
    let lastPt = null;
    window.addEventListener('touchend', (e) => {
      if (!coarse.matches) return;
      const t = e.changedTouches && e.changedTouches[0];
      if (!t) return;
      const now = Date.now();
      const near = lastPt && Math.hypot(t.clientX - lastPt.x, t.clientY - lastPt.y) < 24;
      const dbl = now - lastTap < 320 && near;
      lastTap = now;
      lastPt = { x: t.clientX, y: t.clientY };

      /* 等浏览器把词选好。双击选词不是同步完成的 ——
         它在 touchend 之后才由系统拼出选区范围。 */
      setTimeout(() => {
        sync();
        if (!selectedText().trim()) return;
        /* 第一次点也要能弹菜单（有些浏览器长按不选词），
           双击则一定会选，两者都走同一条路 */
        showMenu();
      }, dbl ? 60 : 0);
    }, { passive: true });

    /* 给 app 用：换文件 / 切预览时清掉残留选区 */
    window.LumeSel = {
      clear,
      refresh: schedule,
      toastless: true,
      get text() { return selectedText(); },
      get active() { return open; }
    };

    return { showMenu, hideMenu, clear, refresh: schedule };
  })();

  /* -------------------------------------------------------- */
  /*  长按 = 右键（触摸设备）                                    */
  /* -------------------------------------------------------- */
  (function longPress() {
    const coarse = window.matchMedia('(pointer: coarse)');

    /* 长按阈值。450ms 是 Android / iOS 的原生长按手感区间
       （系统在 500ms 左右触发菜单），压到 420 会误触，
       拉到 600 用户会以为没反应。 */
    const HOLD = 460;
    /* 手指抖动容忍半径。超过这个距离就判定成"想滑动"，取消长按 ——
       否则想滚页面的人会不停弹菜单。 */
    const SLOP = 10;

    let timer = 0;
    let origin = null;
    let target = null;
    let halo = null;
    let fired = false;

    /* 这个元素上按下去，是不是"想选文字"？
       判据是它自己（或直接子节点）有实在的文字，并且它不是一个按钮式的控件。
       窗口标题栏、Dock、桌面图标、工具栏按钮都算控件，走右键菜单；
       终端输出、文档正文、关于页这类大片文字走选区。 */
    function looksLikeText(node) {
      if (!node || node.nodeType !== 1) return false;
      if (node.closest('button, a, [role="button"], .win-titlebar, .dock, .menubar, .desk-icon, .editor-bar, .brw-bar')) {
        return false;
      }
      const txt = (node.textContent || '').trim();
      if (txt.length < 2) return false;
      /* 只有文字、没有交互子元素（除了裸的 span/b/i/em 这类内联标记） */
      const interactive = node.querySelector('button, a, input, textarea, select, [role="button"]');
      return !interactive;
    }

    function ensureHalo() {
      if (halo && halo.isConnected) return halo;
      halo = document.createElement('div');
      halo.className = 'touch-halo';
      halo.setAttribute('aria-hidden', 'true');
      document.body.appendChild(halo);
      return halo;
    }

    /* 反馈：指尖下方涨开一颗白点，再撒一圈小点。
       小光点用 8 个方向 + 随机半径，比正圆扩散更像"溅开"。 */
    function showHalo(x, y) {
      const h = ensureHalo();
      h.style.left = x + 'px';
      h.style.top = y + 'px';
      h.classList.remove('release');
      /* 强制回流，保证同一次连按也能重放过渡 */
      void h.offsetWidth;
      h.classList.add('show');

      for (let i = 0; i < 8; i++) {
        const dot = document.createElement('div');
        dot.className = 'touch-ripple';
        const a = (Math.PI * 2 * i) / 8 + Math.random() * 0.4;
        const r = 22 + Math.random() * 14;
        dot.style.left = x + 'px';
        dot.style.top = y + 'px';
        dot.style.setProperty('--dx', Math.cos(a) * r + 'px');
        dot.style.setProperty('--dy', Math.sin(a) * r + 'px');
        document.body.appendChild(dot);
        setTimeout(() => dot.remove(), 680);
      }

      if (navigator.vibrate) {
        try {
          navigator.vibrate(12);
        } catch (e) {}
      }
    }

    function releaseHalo() {
      if (!halo) return;
      halo.classList.add('release');
      halo.classList.remove('show');
      setTimeout(() => {
        if (halo) halo.classList.remove('release');
      }, 460);
    }

    function cancel() {
      clearTimeout(timer);
      timer = 0;
      origin = null;
      target = null;
      /* 灰圈是"按压反馈"，松手（或手势被打断）就该收掉，
         不管这次长按到底有没有弹出菜单。
         旧实现只在未触发时才收，触发了菜单的那次长按松手后
         灰圈就会一直挂着，直到下次长按才被复用——这就是触屏上
         "右键松开后光圈不消失"的来源。这里改成无论是否触发都收。 */
      releaseHalo();
      fired = false;
    }

    function fire() {
      fired = true;
      const t = target;
      const x = origin.x;
      const y = origin.y;
      showHalo(x, y);

      /* 菜单要在光晕之后一点点出来：先看到白点，
         再看到菜单，顺序对了才像"系统响应了长按" */
      setTimeout(() => {
        if (t) openCtxAt(t, x, y);
      }, 90);

      /* 长按已经处理完这次触摸，后续的 click 要吞掉，
         否则松手会顺带触发按钮 / 桌面图标的单击 */
      window.__lumeSuppressClick = Date.now() + 700;
    }

    window.addEventListener(
      'touchstart',
      (e) => {
        if (!coarse.matches) return;
        if (e.touches.length !== 1) return cancel();

        const touch = e.touches[0];
        const el0 = document.elementFromPoint(touch.clientX, touch.clientY);
        if (!el0) return;
        /* 输入框里长按要留给系统去放插入点 —— 我们只要它选中的结果，
           不要在它还活着的时候抢走手势 */
        if (el0.closest('input, textarea, [contenteditable="true"]')) return;
        /* 浮层自己不参与 */
        if (el0.closest('.ime-kb, .menu, #spotlight, #veil, .boot, .sel-menu, .sel-grip')) return;

        /* 按在成片的文字上（终端输出、文档正文、关于页……）时，
           用户想要的是「选中这段」，不是「桌面右键菜单」。
           这里先让浏览器自己完成选词，松手后由 SEL 接管弹菜单 ——
           所以整段长按直接放给系统，不弹自己的右键菜单。 */
        if (looksLikeText(el0)) return;

        origin = { x: touch.clientX, y: touch.clientY };
        target = el0;
        fired = false;
        clearTimeout(timer);
        timer = setTimeout(fire, HOLD);
      },
      { passive: true }
    );

    window.addEventListener(
      'touchmove',
      (e) => {
        if (!origin) return;
        const touch = e.touches[0];
        if (!touch) return cancel();
        const dx = touch.clientX - origin.x;
        const dy = touch.clientY - origin.y;
        /* 抖动过一次就不再判长按；松手前不会再重新计时，
           避免"慢慢滑"被误当成长按 */
        if (Math.hypot(dx, dy) > SLOP) cancel();
      },
      { passive: true }
    );

    window.addEventListener('touchend', () => cancel(), { passive: true });
    window.addEventListener('touchcancel', () => cancel(), { passive: true });

    /* 长按已经消费掉的触摸，别再触发一次点击 */
    window.addEventListener(
      'click',
      (e) => {
        if (window.__lumeSuppressClick && Date.now() < window.__lumeSuppressClick) {
          e.stopPropagation();
          e.preventDefault();
        }
      },
      true
    );
  })();

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
    /* 关机：Terminal 的 `shutdown` 和 Dock 电源键共用同一入口 */
    shutdown: powerOff,
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
