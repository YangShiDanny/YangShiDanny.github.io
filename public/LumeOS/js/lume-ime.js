/* ============================================================
   LumeIME — LumeOS 内置输入法
   全拼 · 词频排序 · 用户词自学习 · 独立 Shift 切换中/英
   词库：rime-ice（雾凇拼音）预编译为 assets/ime-dict.json，
   按拼音前缀二分查找，首次进入中文模式时懒加载。
   ============================================================ */
(function () {
  'use strict';

  var PAGE = 9;            // 候选栏一次显示 9 个（数字键直选）
  var MAX_SCAN = 6000;     // 前缀扫描上限，防止极端缓冲卡顿
  var DICT_URL = 'assets/ime-dict.json';
  var LS_MODE = 'lume.ime.mode';
  var LS_ON = 'lume.ime.on';
  var LS_USER = 'lume.ime.user';

  var state = {
    on: true,          // 总开关（Settings 里可关）
    mode: 'cn',        // 'cn' | 'en'
    buf: '',           // 原始小写按键缓冲
    cands: [],         // 候选词数组
    page: 0,
    sel: 0,            // 页内选中下标
    field: null,       // 正在输入的目标元素
    loading: false,
    ready: false
  };

  var dictRows = null;   // [pinyinKey, word, freq]，按 key 字典序
  var bar = null;        // 候选栏 DOM
  var chip = null;       // 菜单栏 中/EN 指示
  var shiftSolo = false; // 独立按下 Shift（中间没碰别的键）

  /* ---------- 用户词频 ---------- */
  function loadUser() {
    try {
      return JSON.parse(localStorage.getItem(LS_USER) || '{}') || {};
    } catch (e) {
      return {};
    }
  }
  var userFreq = loadUser();
  function saveUser() {
    try {
      var keys = Object.keys(userFreq);
      if (keys.length > 800) {
        keys.sort(function (a, b) { return userFreq[a] - userFreq[b]; });
        keys.slice(0, keys.length - 500).forEach(function (k) { delete userFreq[k]; });
      }
      localStorage.setItem(LS_USER, JSON.stringify(userFreq));
    } catch (e) { /* 存不下就算了 */ }
  }
  function bump(word) {
    userFreq[word] = (userFreq[word] || 0) + 1;
    saveUser();
  }

  /* ---------- 词库 ---------- */
  function loadDict() {
    if (dictRows || state.loading) return;
    state.loading = true;
    fetch(DICT_URL)
      .then(function (r) { return r.json(); })
      .then(function (rows) {
        dictRows = rows;
        state.ready = true;
        state.loading = false;
        if (state.buf) refresh();
      })
      .catch(function () {
        state.loading = false;
        if (bar) bar.querySelector('.ime-status').textContent = 'dict failed to load';
      });
  }

  function lookup(buf) {
    if (!dictRows) return [];
    /* 二分找第一个 >= buf 的位置，然后线性收集同前缀 */
    var lo = 0, hi = dictRows.length;
    while (lo < hi) {
      var m = (lo + hi) >> 1;
      if (dictRows[m][0] < buf) lo = m + 1;
      else hi = m;
    }
    var seen = Object.create(null);
    var out = [];
    for (var i = lo; i < dictRows.length; i++) {
      var row = dictRows[i];
      if (row[0].slice(0, buf.length) !== buf) break;
      var w = row[1];
      if (seen[w] !== undefined) {
        if (row[2] > seen[w].fr) seen[w].fr = row[2];
        continue;
      }
      seen[w] = { w: w, fr: row[2], u: userFreq[w] || 0 };
      out.push(seen[w]);
      if (out.length >= MAX_SCAN) break;
    }
    out.sort(function (a, b) {
      /* 用户打过的词优先，其次按语料频度 */
      return (b.u - a.u) || (b.fr - a.fr);
    });
    return out.slice(0, 90);
  }

  /* ---------- 可编辑区域判定 ---------- */
  function editable(el) {
    if (!el) return false;
    var tag = el.tagName;
    if (el.isContentEditable) return true;
    if (tag === 'TEXTAREA') return true;
    if (tag === 'INPUT') {
      var t = (el.type || 'text').toLowerCase();
      return !(t === 'button' || t === 'checkbox' || t === 'radio' || t === 'range' ||
        t === 'file' || t === 'submit' || t === 'reset' || t === 'image' || t === 'color');
    }
    return false;
  }

  /* ---------- 上屏 ---------- */
  function insertText(text) {
    var el = state.field;
    if (!el) return false;
    if (el.focus) el.focus();
    try {
      if (document.execCommand('insertText', false, text)) return true;
    } catch (e) { /* 老路走不通就走 setRangeText */ }
    if (el.setRangeText) {
      var s = el.selectionStart, e2 = el.selectionEnd;
      el.setRangeText(text, s, e2, 'end');
      el.dispatchEvent(new Event('input', { bubbles: true }));
      return true;
    }
    return false;
  }

  function rawBuffer() {
    return state.buf;
  }

  function commit(text, word) {
    if (word) bump(word);
    insertText(text);
    clearBuf();
  }

  function clearBuf() {
    state.buf = '';
    state.cands = [];
    state.page = 0;
    state.sel = 0;
    hideBar();
  }

  /* ---------- 候选栏 ---------- */
  function ensureBar() {
    if (bar) return bar;
    bar = document.createElement('div');
    bar.className = 'ime-bar';
    bar.setAttribute('aria-live', 'polite');
    bar.innerHTML =
      '<div class="ime-line"><span class="ime-py"></span><span class="ime-status" hidden></span></div>' +
      '<div class="ime-cands"></div>';
    bar.addEventListener('mousedown', function (e) {
      /* 点候选词上屏，但不抢走输入框焦点 */
      e.preventDefault();
      var c = e.target.closest('.ime-cand');
      if (c) {
        var idx = parseInt(c.dataset.i, 10);
        if (!isNaN(idx)) pick(state.page * PAGE + idx);
      }
    });
    document.body.appendChild(bar);
    return bar;
  }

  function showBar() {
    var b = ensureBar();
    b.hidden = false;
    b.querySelector('.ime-py').textContent = state.buf;
    var status = b.querySelector('.ime-status');
    var candsBox = b.querySelector('.ime-cands');

    if (!state.ready) {
      status.hidden = false;
      status.textContent = state.loading ? 'loading dictionary…' : 'dictionary unavailable';
      candsBox.innerHTML = '';
      positionBar();
      return;
    }
    status.hidden = true;

    var start = state.page * PAGE;
    var pageItems = state.cands.slice(start, start + PAGE);
    if (!pageItems.length) {
      candsBox.innerHTML = '<span class="ime-none">no match · space to type raw</span>';
    } else {
      candsBox.innerHTML = '';
      pageItems.forEach(function (c, i) {
        var el = document.createElement('span');
        el.className = 'ime-cand' + (i === state.sel ? ' sel' : '');
        el.dataset.i = i;
        el.innerHTML = '<b>' + ((i + 1) % 10) + '</b>';
        el.appendChild(document.createTextNode(c.w));
        candsBox.appendChild(el);
      });
    }
    positionBar();
  }

  function hideBar() {
    if (bar) bar.hidden = true;
  }

  function caretXY(el) {
    /* textarea/input：镜像 div 量光标；contenteditable：直接取 range 矩形 */
    if (el.selectionStart !== undefined && el.selectionStart !== null && !el.isContentEditable) {
      var cs = getComputedStyle(el);
      var mir = document.createElement('div');
      mir.style.position = 'absolute';
      mir.style.top = '-9999px';
      mir.style.left = '-9999px';
      mir.style.whiteSpace = 'pre';
      mir.style.visibility = 'hidden';
      ['fontFamily', 'fontSize', 'fontWeight', 'fontStyle', 'letterSpacing',
        'lineHeight', 'textTransform', 'padding', 'border', 'boxSizing'].forEach(function (p) {
        mir.style[p] = cs[p];
      });
      mir.style.width = el.clientWidth + 'px';
      var v = el.value.slice(0, el.selectionStart);
      mir.textContent = v;
      var mark = document.createElement('span');
      mark.textContent = '\u200b';
      mir.appendChild(mark);
      document.body.appendChild(mir);
      var mx = mark.offsetLeft, my = mark.offsetTop;
      document.body.removeChild(mir);

      var rect = el.getBoundingClientRect();
      var x = rect.left + mx - el.scrollLeft;
      var y = rect.top + my - el.scrollTop;
      return { x: x, y: y, h: parseFloat(cs.fontSize) * 1.4 };
    }
    var sel = window.getSelection();
    if (sel && sel.rangeCount) {
      var r = sel.getRangeAt(0).getBoundingClientRect();
      if (r && (r.width || r.height)) return { x: r.left, y: r.top, h: r.height };
    }
    var fr = el.getBoundingClientRect();
    return { x: fr.left, y: fr.top, h: fr.height };
  }

  function positionBar() {
    if (!bar || bar.hidden || !state.field) return;
    var pos = caretXY(state.field);
    var bw = bar.offsetWidth, bh = bar.offsetHeight;
    var x = pos.x - 6;
    var y = pos.y - bh - 8;
    if (y < 40) y = pos.y + pos.h + 8;
    x = Math.max(8, Math.min(x, window.innerWidth - bw - 8));
    y = Math.max(8, Math.min(y, window.innerHeight - bh - 60));
    bar.style.left = Math.round(x) + 'px';
    bar.style.top = Math.round(y) + 'px';
  }

  /* ---------- 选词 ---------- */
  function refresh() {
    if (!state.buf) { clearBuf(); return; }
    state.cands = state.ready ? lookup(state.buf) : [];
    state.page = 0;
    state.sel = 0;
    showBar();
  }

  function pick(globalIdx) {
    var c = state.cands[globalIdx];
    if (!c) return;
    commit(c.w, c.w);
  }

  function commitRaw() {
    commit(rawBuffer(), null);
  }

  /* ---------- 模式 ---------- */
  function setChip() {
    if (chip) {
      chip.textContent = state.mode === 'cn' ? '中' : 'EN';
      chip.classList.toggle('en', state.mode !== 'cn');
      chip.title = 'Input method: ' + (state.mode === 'cn' ? 'Chinese (Shift to switch)' : 'English (Shift to switch)');
    }
  }

  function setMode(m, quiet) {
    state.mode = m === 'en' ? 'en' : 'cn';
    try { localStorage.setItem(LS_MODE, state.mode); } catch (e) { /* noop */ }
    setChip();
    if (state.mode === 'cn') loadDict();
    if (!quiet && window.LumeOS && window.LumeOS.toast) {
      window.LumeOS.toast(state.mode === 'cn' ? 'IME · Chinese · Shift to switch' : 'IME · English · Shift to switch');
    }
    document.dispatchEvent(new CustomEvent('lume:ime'));
  }

  function toggleMode(quiet) {
    /* 切走时把没上屏的缓冲原样打出去，不吞字 */
    if (state.buf) commitRaw();
    setMode(state.mode === 'cn' ? 'en' : 'cn', quiet);
  }

  function setOn(v, quiet) {
    state.on = !!v;
    try { localStorage.setItem(LS_ON, state.on ? '1' : '0'); } catch (e) { /* noop */ }
    if (!state.on) clearBuf();
    setChip();
    if (!quiet) document.dispatchEvent(new CustomEvent('lume:ime'));
  }

  /* ---------- 键盘 ---------- */
  function onKey(e) {
    if (e.type === 'keydown') {
      if (e.key === 'Shift') {
        if (!e.repeat) shiftSolo = true;
        return;
      }
      shiftSolo = false;
    } else if (e.type === 'keyup') {
      if (e.key === 'Shift') {
        if (shiftSolo) toggleMode();
        shiftSolo = false;
      }
      return;
    } else {
      return;
    }

    /* 总开关关着，或者英文模式：完全不插手（Shift 切换已处理） */
    if (!state.on || state.mode !== 'cn') return;
    if (e.ctrlKey || e.metaKey || e.altKey) return;

    var t = e.target;
    if (!editable(t)) { /* 焦点不在可输入区时只允许 Shift 切换 */ return; }
    state.field = t;

    var k = e.key;

    /* 字母：进缓冲 */
    if (/^[a-zA-Z]$/.test(k)) {
      state.buf += k.toLowerCase();
      refresh();
      e.preventDefault();
      e.stopImmediatePropagation();
      return;
    }

    if (!state.buf) return; /* 缓冲为空：其余按键全部放行 */

    if (k === "'") {
      state.buf += k;
      refresh();
      e.preventDefault();
      e.stopImmediatePropagation();
      return;
    }

    if (k === 'Backspace') {
      state.buf = state.buf.slice(0, -1);
      refresh();
      e.preventDefault();
      e.stopImmediatePropagation();
      return;
    }

    if (k === ' ' || k === 'Spacebar') {
      if (state.cands.length) pick(state.page * PAGE + state.sel);
      else commitRaw();
      e.preventDefault();
      e.stopImmediatePropagation();
      return;
    }

    if (/^[1-9]$/.test(k)) {
      var gi = state.page * PAGE + (parseInt(k, 10) - 1);
      if (state.cands[gi]) { pick(gi); e.preventDefault(); e.stopImmediatePropagation(); }
      return;
    }

    if (k === 'Enter') {
      commitRaw();
      e.preventDefault();
      e.stopImmediatePropagation();
      return;
    }

    if (k === 'Escape') {
      clearBuf();
      e.preventDefault();
      e.stopImmediatePropagation();
      return;
    }

    if (k === 'ArrowLeft' || k === 'ArrowUp') {
      state.sel = Math.max(0, state.sel - 1);
      showBar();
      e.preventDefault();
      e.stopImmediatePropagation();
      return;
    }

    if (k === 'ArrowRight' || k === 'ArrowDown') {
      state.sel = Math.min(Math.min(state.cands.length, PAGE) - 1, state.sel + 1);
      showBar();
      e.preventDefault();
      e.stopImmediatePropagation();
      return;
    }

    if (k === 'PageDown' || k === '=') {
      if ((state.page + 1) * PAGE < state.cands.length) { state.page++; state.sel = 0; showBar(); }
      e.preventDefault();
      e.stopImmediatePropagation();
      return;
    }

    if (k === 'PageUp' || k === '-') {
      if (state.page > 0) { state.page--; state.sel = 0; showBar(); }
      e.preventDefault();
      e.stopImmediatePropagation();
      return;
    }

    /* 其他标点：先把候选上屏，再把标点原样打出去 */
    if (k.length === 1) {
      if (state.cands.length) pick(state.page * PAGE + state.sel);
      else commitRaw();
      insertText(k);
      e.preventDefault();
      e.stopImmediatePropagation();
      return;
    }
  }

  /* ---------- 菜单栏指示 ---------- */
  function buildChip() {
    var right = document.querySelector('.menubar-right');
    if (!right) return;
    chip = document.createElement('button');
    chip.className = 'mb-btn mb-ime';
    chip.type = 'button';
    chip.addEventListener('click', function () {
      if (!state.on) setOn(true);
      else toggleMode();
    });
    right.insertBefore(chip, right.firstChild);
    setChip();
  }

  /* ---------- 全局事件 ---------- */
  window.addEventListener('keydown', onKey, true);
  window.addEventListener('keyup', onKey, true);

  window.addEventListener('pointerdown', function (e) {
    if (bar && !bar.hidden && !bar.contains(e.target) && e.target !== state.field) clearBuf();
  }, true);

  window.addEventListener('blur', clearBuf);
  window.addEventListener('scroll', positionBar, true);
  window.addEventListener('resize', positionBar);
  document.addEventListener('selectionchange', function () {
    if (!state.buf && state.field && !document.contains(state.field)) state.field = null;
  });

  /* ---------- 启动 ---------- */
  try {
    state.on = localStorage.getItem(LS_ON) !== '0';
    var savedMode = localStorage.getItem(LS_MODE);
    state.mode = savedMode === 'en' ? 'en' : 'cn';
  } catch (e) { /* 默认中文 */ }

  function boot() {
    buildChip();
    setChip();
    if (state.mode === 'cn') loadDict();
  }

  if (document.readyState === 'loading') document.addEventListener('DOMContentLoaded', boot);
  else boot();

  /* 空闲时把词库也热好，首键零等待 */
  var idle = window.requestIdleCallback || function (fn) { return setTimeout(fn, 1200); };
  idle(function () { if (state.on) loadDict(); });

  window.LumeIME = {
    get mode() { return state.mode; },
    get on() { return state.on; },
    get ready() { return state.ready; },
    get buffering() { return !!state.buf; },
    setMode: setMode,
    toggle: function () { toggleMode(); },
    setOn: setOn
  };
})();
