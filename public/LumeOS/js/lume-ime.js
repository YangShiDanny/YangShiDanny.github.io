/* ============================================================
   LumeIME — LumeOS 内置输入法
   全拼 · 简拼 · 智能切分整句 · 词频排序 · 用户词自学习 · 独立 Shift 切换中/英

   词库：rime-ice（雾凇拼音）经 scripts/build-ime-dict.cjs 预编译成
   assets/ime-dict.txt —— 紧凑行文本，两段以空行分隔：

     #LUMEIME1
     <拼音>\t<词>:<频>,<词>:<频>,...
     …
     (空行)
     <简拼>\t<词>:<频>,...

   为什么不用 JSON：原来 1.32MB 的二维数组光是 JSON.parse 就要 ~50ms，
   加载完还得再扫 4.8 万条建简拼索引、又是 ~140ms，近 200ms 全堵在启动上。
   换成行文本后：一次 split('\n') 约 27ms，且**只做一次**；
   真正用到的只是"某个前缀命中的那几行"，按需 split 才 0.05–8ms。
   体积也从 1.32MB/gzip 499KB 降到 0.62MB/gzip 275KB。

   两级数组结构（body / iniBody）都是字典序，查询靠二分。
   ============================================================ */
(function () {
  'use strict';

  var PAGE = 9;            // 候选栏一次显示 9 个（数字键直选）
  var MAX_SCAN = 6000;     // 前缀扫描上限，防止极端缓冲卡顿
  var MAX_SYLLABLE = 6;    // 单个拼音音节的搜索上限
  var DICT_URL = 'assets/ime-dict.txt';
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
    kind: 'empty',     // 候选来源：full / initial / mixed / phrase
    field: null,       // 正在输入的目标元素
    loading: false,
    ready: false
  };

  var dictRows = null;   // 主词库行：每项是 "拼音\t词:频,词:频"，字典序
  var iniRows = null;    // 简拼行：每项是 "简拼\t词:频,..."，字典序
  var bar = null;        // 候选栏 DOM
  var chip = null;       // 菜单栏 中/EN 指示
  var kbBtn = null;      // 菜单栏键盘开关
  var vkbEl = null;      // 虚拟键盘
  var kbShift = false;   // 虚拟键盘的 Shift 状态
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
  var SYLLABLES = null;   // 合法完整拼音音节表（文件头部一行，空格分隔）
  var sylCache = Object.create(null);
  var cacheKeys = 0;

  function loadDict() {
    if (dictRows || state.loading) return;
    state.loading = true;
    fetch(DICT_URL)
      .then(function (r) { return r.text(); })
      .then(function (text) {
        /* 一次切分拿到全部行；两段之间用空行隔开。
           split 出来的量级是 2 万行，比 JSON.parse 快且不需要建对象。 */
        var parts = text.split('\n\n');
        var body = parts[0].split('\n');
        if (body[0].charAt(0) === '#') body.shift();   // 去掉 #LUMEIME1 魔数行

        /* 紧跟着的一行是完整音节表（空格分隔）。它来自裁词库**之前**的
           全量数据，所以含 weng/zhuai/pie 这些冷僻音节——
           整句切分必须靠它，缺一个音节就会有一串拼音切不开。 */
        SYLLABLES = Object.create(null);
        if (body.length) {
          var syls = body.shift().split(' ');
          for (var i = 0; i < syls.length; i++) if (syls[i]) SYLLABLES[syls[i]] = true;
        }

        if (body.length && body[body.length - 1] === '') body.pop();
        dictRows = body;
        iniRows = parts[1] ? parts[1].split('\n').filter(Boolean) : [];

        state.ready = true;
        state.loading = false;
        if (state.buf) refresh();
      })
      .catch(function () {
        state.loading = false;
        if (bar) bar.querySelector('.ime-status').textContent = 'dict failed to load';
      });
  }

  /* 取一行的拼音部分（\t 之前）。二分和前缀比较都靠它。
     行格式固定，用 indexOf 比 split 快得多，热路径上按需调用。 */
  function rowKey(line) {
    var t = line.indexOf('\t');
    return t < 0 ? line : line.slice(0, t);
  }

  /* 二分找第一个 >= key 的行下标 */
  function lowerBound(key) {
    var lo = 0, hi = dictRows.length;
    while (lo < hi) {
      var m = (lo + hi) >> 1;
      if (rowKey(dictRows[m]) < key) lo = m + 1;
      else hi = m;
    }
    return lo;
  }

  /* 把 "<词>:<频>,<词>:<频>" 解析成 {w, fr} 数组。
     每段的格式是「词 冒号 频次」，所以冒号前是词、冒号后是频次。
     频次是构建期做过对数压缩的档位值，排序只需要大小关系，不需要原值。 */
  function parseWords(tail) {
    var out = [];
    var segs = tail.split(',');
    for (var i = 0; i < segs.length; i++) {
      var s = segs[i];
      if (!s) continue;
      var c = s.lastIndexOf(':');
      if (c < 0) { out.push({ w: s, fr: 0 }); continue; }
      out.push({ w: s.slice(0, c), fr: +s.slice(c + 1) || 0 });
    }
    return out;
  }

  function cached(key) {
    if (sylCache[key] !== undefined) return sylCache[key];
    /* 缓存别无限长：连着打长句会撞出成百上千个前缀键 */
    if (++cacheKeys > 4000) {
      sylCache = Object.create(null);
      cacheKeys = 0;
    }
    if (!dictRows) return [];
    var lo = lowerBound(key);
    var seen = Object.create(null);
    var out = [];
    for (var i = lo; i < dictRows.length; i++) {
      var line = dictRows[i];
      var k = rowKey(line);
      if (k.slice(0, key.length) !== key) break;
      /* 命中行才解析：这正是"按需"的收益所在，
         一次前缀查询通常只碰 1–5 行。 */
      var words = parseWords(line.slice(k.length + 1));
      for (var j = 0; j < words.length; j++) {
        var w = words[j].w;
        var fr = words[j].fr;
        if (seen[w] !== undefined) {
          if (fr > seen[w].fr) seen[w].fr = fr;
          continue;
        }
        seen[w] = { w: w, fr: fr, u: userFreq[w] || 0, exact: k === key ? 1 : 0 };
        out.push(seen[w]);
      }
      if (out.length >= MAX_SCAN) break;
    }
    out.sort(function (a, b) {
      /* 用户打过的词优先；其次"完全匹配"优先于"只是前缀匹配"
         （否则打 ni 会被 nian/年 这种更高频的前缀词压住）；
         最后才按语料频度 */
      return (b.u - a.u) || (b.exact - a.exact) || (b.fr - a.fr);
    });
    var top = out.slice(0, 90);
    sylCache[key] = top;
    return top;
  }

  /* 全拼前缀查找（老行为，作为兜底） */
  function lookup(buf) {
    if (!dictRows) return [];
    return cached(buf);
  }

  /* 简拼：把 "nihao" 缩成首字母串 "nh"，再拿词库 key 的首字母去撞。
     只能撞"整词简拼"（nihao→nh），撞不了跨音节任意缩写。 */
  function initialsOf(key) {
    if (!SYLLABLES) return '';
    var out = [];
    var i = 0;
    while (i < key.length) {
      var hit = '';
      for (var n = Math.min(MAX_SYLLABLE, key.length - i); n >= 1; n--) {
        var seg = key.substr(i, n);
        if (SYLLABLES[seg]) { hit = seg; break; }
      }
      if (!hit) return '';            // 切不干净，这个 key 不算音节串
      out.push(hit.charAt(0));
      i += hit.length;
    }
    return out.join('');
  }

  /* 简拼：直接二分查文件第二段里预建好的简拼表。
     这里原先是"扫全库 4.8 万条 → 建 首字母串→词 的索引"，光这一步就 ~140ms，
     而且必须丢到空闲帧去做、没建好前简拼不可用。
     现在构建期已经算好并按字典序排进文件，运行时只差一次二分。 */
  function lookupInitials(buf) {
    if (!iniRows) return [];
    var lo = 0, hi = iniRows.length;
    while (lo < hi) {
      var m = (lo + hi) >> 1;
      if (rowKey(iniRows[m]) < buf) lo = m + 1;
      else hi = m;
    }
    if (lo >= iniRows.length) return [];
    var line = iniRows[lo];
    if (rowKey(line) !== buf) return [];      // 简拼必须整串精确命中

    var words = parseWords(line.slice(line.indexOf('\t') + 1));
    var out = [];
    for (var i = 0; i < words.length; i++) {
      var w = words[i].w;
      out.push({ w: w, fr: words[i].fr, u: userFreq[w] || 0, ini: true });
    }
    out.sort(function (a, b) { return (b.u - a.u) || (b.fr - a.fr); });
    return out.slice(0, 60);
  }

  /* 智能切分：把缓冲切成若干音节，一段一段取最短音的整词，
     拼成一句候选（"woaini" → 我爱 + 你）。用词频乘积打分，取最优路径。 */
  function segmentations(buf, limit) {
    var res = [];
    var budget = 4000;   /* 节点预算：比"命中数上限"靠谱，短缓冲不会被误截断 */
    function walk(i, acc) {
      if (budget-- <= 0) return;
      if (i >= buf.length) { res.push(acc.slice()); return; }
      for (var n = 1; n <= MAX_SYLLABLE && i + n <= buf.length; n++) {
        var seg = buf.substr(i, n);
        if (!SYLLABLES[seg]) continue;
        acc.push(seg);
        walk(i + n, acc);
        acc.pop();
        if (res.length >= limit) return;
      }
    }
    if (SYLLABLES) walk(0, []);
    return res;
  }

  /* 整句：先把缓冲切成音节序列，再在每一段上找"最长能覆盖多个音节的真词"。
     jintiantianqi 切到 jin|tian|tian|qi 后，还能把 tian+qi 合成 天气（键 tianqi）。
     注意：cached() 是按前缀给的，所以取词时一定要认 exact（键 === 词），
     否则 wordAt('jin') 会拿到 今天(键 jintian)，整句会串味还带出生僻字。 */
  function lookupPhrases(buf) {
    if (!SYLLABLES || buf.length < 4) return [];

    /* 性能闸门：音节数控制搜索宽度。
       短缓冲（woaini）切分极少，长缓冲（zhonghuarenmin）组合爆炸，
       所以拆得越长，采样越少，保证单次按键都在一帧预算内。 */
    var limit = buf.length <= 6 ? 16 : buf.length <= 10 ? 12 : buf.length <= 16 ? 8 : 5;
    var segs = segmentations(buf, limit);
    var out = [];
    var seen = Object.create(null);

    for (var s = 0; s < segs.length; s++) {
      var syls = segs[s];
      if (syls.length < 2) continue;

      /* 把音节序列重新聚成"词"：尽量用覆盖多个音节的真实词条 */
      var words = [];
      var ok = true;
      var score = 0;

      for (var p = 0; p < syls.length; ) {
        var got = null;
        var span = 0;
        /* 从最长开始试：几个连续音节拼起来的拼音串，在词库里就是整词 */
        for (var n = Math.min(4, syls.length - p); n >= 1; n--) {
          var key = syls.slice(p, p + n).join('');
          var rows = cached(key);
          var hit = null;
          for (var i = 0; i < rows.length; i++) {
            if (rows[i].exact && rows[i].w.length >= (n === 1 ? 1 : 2)) { hit = rows[i]; break; }
          }
          if (hit) { got = hit; span = n; break; }
        }
        if (!got) { ok = false; break; }
        words.push(got.w);
        score += (got.w.length > 1 ? 1 : 0.4) * Math.log(1 + got.fr);
        p += span;
      }
      if (!ok) continue;

      var text = words.join('');
      if (seen[text]) continue;
      seen[text] = true;

      var multi = words.filter(function (w) { return w.length > 1; }).length;
      out.push({
        w: text,
        fr: Math.round(score * 100),
        u: 0,
        phrase: true,
        parts: words.length,
        multi: multi,
        cover: multi / words.length
      });
    }

    out.sort(function (a, b) {
      return (b.cover - a.cover) || (a.parts - b.parts) || (b.fr - a.fr);
    });

    var ok2 = out.filter(function (c) { return c.multi > 0; });
    return ok2.slice(0, 6);
  }

  /* 总候选：全拼前缀 → 简拼 → 整句，三段去重合并 */
  function candidates(buf) {
    if (!dictRows) return { list: [], kind: 'loading' };
    if (!buf) return { list: [], kind: 'empty' };

    var full = lookup(buf);
    var list = full.slice(0, 40);
    var kind = 'full';

    /* 全拼结果稀薄时再补简拼，免得把真正的全拼结果挤下去 */
    if (buf.length >= 2 && list.length < 6) {
      var ini = lookupInitials(buf);
      if (ini.length) {
        kind = list.length ? 'mixed' : 'initial';
        var have = Object.create(null);
        list.forEach(function (c) { have[c.w] = true; });
        ini.forEach(function (c) { if (!have[c.w]) list.push(c); });
      }
    }

    /* 整句：缓冲能切成 2 段以上完整音节时插进去。
       但如果缓冲本身就命中了一个完整词（比如 nihao → 你好），
       整句只排到它后面，不要抢拼音直给的那个词。 */
    var ph = lookupPhrases(buf);
    if (ph.length) {
      kind = 'phrase';

      /* 去重：整句和前缀候选经常撞车（woaini 既是词也是句），
         用一张表统一收，先来的位置保留。 */
      var seenW = Object.create(null);
      var merged = [];
      var push = function (c) {
        if (seenW[c.w]) return;
        seenW[c.w] = true;
        merged.push(c);
      };

      var selfWord = list.some(function (c) { return c.exact; });
      if (selfWord) {
        /* 完全匹配词 > 整句 > 其余前缀候选 */
        list.filter(function (c) { return c.exact; }).forEach(push);
        ph.forEach(push);
        list.filter(function (c) { return !c.exact; }).forEach(push);
      } else {
        ph.forEach(push);
        list.forEach(push);
      }
      list = merged;
    } else {
      /* 没有整句也要去重（简拼合并时可能重复） */
      var seenW2 = Object.create(null);
      list = list.filter(function (c) {
        if (seenW2[c.w]) return false;
        seenW2[c.w] = true;
        return true;
      });
    }

    return { list: list, kind: kind };
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
      '<div class="ime-line">' +
      '<span class="ime-py"></span>' +
      '<span class="ime-kind" hidden></span>' +
      '<span class="ime-page" hidden></span>' +
      '<span class="ime-status" hidden></span>' +
      '</div>' +
      '<div class="ime-cands"></div>';
    bar.addEventListener('mousedown', function (e) {
      /* 点候选词上屏，但不抢走输入框焦点 */
      e.preventDefault();
      /* 点翻页箭头 */
      var nav = e.target.closest('.ime-nav');
      if (nav) {
        var dir = nav.dataset.dir;
        if (dir === 'next') nextPage();
        else prevPage();
        return;
      }
      var c = e.target.closest('.ime-cand');
      if (c) {
        var idx = parseInt(c.dataset.i, 10);
        if (!isNaN(idx)) pick(state.page * PAGE + idx);
      }
    });
    document.body.appendChild(bar);
    return bar;
  }

  var KIND_LABEL = {
    full: '全拼',
    initial: '简拼',
    mixed: '全拼·简拼',
    phrase: '整句',
    loading: '加载中',
    empty: '无匹配'
  };

  function showBar() {
    var b = ensureBar();
    b.hidden = false;
    b.querySelector('.ime-py').textContent = state.buf;

    var status = b.querySelector('.ime-status');
    var kindEl = b.querySelector('.ime-kind');
    var pageEl = b.querySelector('.ime-page');
    var candsBox = b.querySelector('.ime-cands');

    if (!state.ready) {
      if (status) {
        status.hidden = false;
        status.textContent = state.loading ? 'loading dictionary…' : 'dictionary unavailable';
      }
      if (kindEl) kindEl.hidden = true;
      if (pageEl) pageEl.hidden = true;
      if (candsBox) candsBox.innerHTML = '';
      positionBar();
      return;
    }
    if (status) status.hidden = true;

    var total = state.cands.length;

    /* 候选来源标签：简拼 / 整句时提示一下，让人知道发生了什么 */
    var kind = state.kind || 'empty';
    if (kindEl) {
      if (KIND_LABEL[kind]) {
        kindEl.hidden = false;
        kindEl.textContent = KIND_LABEL[kind];
        kindEl.className = 'ime-kind k-' + kind;
      } else {
        kindEl.hidden = true;
      }
    }

    var start = state.page * PAGE;
    var pageItems = state.cands.slice(start, start + PAGE);

    if (!pageItems.length) {
      if (candsBox) candsBox.innerHTML = '<span class="ime-none">no match · <b>space</b> to type raw · <b>esc</b> to clear</span>';
      if (pageEl) pageEl.hidden = true;
      positionBar();
      return;
    }

    /* 组装候选 + 翻页箭头（直接挂到 candsBox 上，不用 DocumentFragment） */
    if (candsBox) candsBox.innerHTML = '';
    var addNode = function (node) {
      if (candsBox) candsBox.appendChild(node);
    };

    if (state.page > 0) {
      var prev = document.createElement('span');
      prev.className = 'ime-nav';
      prev.dataset.dir = 'prev';
      prev.textContent = '‹';
      prev.title = 'Previous page (PageUp / -)';
      addNode(prev);
    }
    pageItems.forEach(function (c, i) {
      var el = document.createElement('span');
      el.className = 'ime-cand' + (i === state.sel ? ' sel' : '');
      if (c.phrase) el.className += ' phrase';
      if (c.ini) el.className += ' ini';
      el.dataset.i = i;
      el.title = c.phrase ? '整句候选 · 空格上屏' : c.ini ? '简拼候选' : '';
      var num = document.createElement('b');
      num.textContent = String((i + 1) % 10);
      el.appendChild(num);
      el.appendChild(document.createTextNode(c.w));
      addNode(el);
    });
    if (start + PAGE < total) {
      var next = document.createElement('span');
      next.className = 'ime-nav';
      next.dataset.dir = 'next';
      next.textContent = '›';
      next.title = 'More candidates (PageDown / =)';
      addNode(next);
    }

    /* 页码：够一页以上才显示 */
    var pages = Math.ceil(total / PAGE);
    if (pageEl) {
      if (pages > 1) {
        pageEl.hidden = false;
        pageEl.textContent = (state.page + 1) + '/' + pages;
      } else {
        pageEl.hidden = true;
      }
    }

    positionBar();
  }

  function nextPage() {
    if ((state.page + 1) * PAGE < state.cands.length) {
      state.page++;
      state.sel = 0;
      showBar();
    }
  }

  function prevPage() {
    if (state.page > 0) {
      state.page--;
      state.sel = 0;
      showBar();
    }
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
    var r = candidates(state.buf);
    state.cands = r.list;
    state.kind = r.kind;
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
      nextPage();
      e.preventDefault();
      e.stopImmediatePropagation();
      return;
    }

    if (k === 'PageUp' || k === '-') {
      prevPage();
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

  /* ---------- 菜单栏指示（托盘） ---------- */
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
    /* 右键托盘图标：自己的小菜单（切中英 / 开关） */
    chip.addEventListener('contextmenu', function (e) {
      e.preventDefault();
      e.stopPropagation();
      if (!window.LumeOS || !window.LumeOS.popMenu) return;
      window.LumeOS.popMenu(e.clientX, e.clientY, {
        title: 'LumeIME',
        sub: state.mode === 'cn' ? 'Chinese · pinyin' : 'English',
        items: [
          { ico: 'restart', label: state.mode === 'cn' ? 'Switch to English' : 'Switch to Chinese', run: function () { toggleMode(); } },
          '|',
          {
            ico: 'power',
            label: state.on ? 'Turn Off' : 'Turn On',
            danger: state.on,
            run: function () { setOn(!state.on); }
          }
        ]
      });
    });

    /* 键盘开关（弹出移动键盘） */
    kbBtn = document.createElement('button');
    kbBtn.className = 'mb-btn mb-kb';
    kbBtn.type = 'button';
    kbBtn.setAttribute('aria-label', 'Toggle on-screen keyboard');
    kbBtn.title = 'On-screen keyboard';
    kbBtn.innerHTML =
      '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.5" stroke-linecap="round" aria-hidden="true">' +
      '<rect x="2.5" y="6" width="19" height="12" rx="2.2"/>' +
      '<path d="M6 10h.01M9.5 10h.01M13 10h.01M16.5 10h.01M6 13h.01M9.5 13h.01M13 13h.01M16.5 13h.01M8 15.8h8"/>' +
      '</svg>';
    kbBtn.addEventListener('click', function () { toggleKeyboard(); });

    right.insertBefore(kbBtn, right.firstChild);
    right.insertBefore(chip, right.firstChild);
    setChip();
  }

  /* ---------- 虚拟键盘（移动键盘） ---------- */
  function buildVkb() {
    if (vkbEl) return vkbEl;
    vkbEl = document.createElement('div');
    vkbEl.className = 'ime-kb';
    vkbEl.hidden = true;

    var rows = [
      ['1', '2', '3', '4', '5', '6', '7', '8', '9', '0'],
      ['q', 'w', 'e', 'r', 't', 'y', 'u', 'i', 'o', 'p'],
      ['a', 's', 'd', 'f', 'g', 'h', 'j', 'k', 'l'],
      ['Shift', 'z', 'x', 'c', 'v', 'b', 'n', 'm', 'Bksp']
    ];
    var html = '';
    rows.forEach(function (row) {
      html += '<div class="ime-kb-row">';
      row.forEach(function (k) {
        var label = k === 'Shift' ? '⇧' : k === 'Bksp' ? '⌫' : k;
        var cls = 'kb-key' + (k === 'Shift' || k === 'Bksp' ? ' wide mod' : '');
        var alpha = /^[a-z]$/.test(k) ? ' data-alpha="1"' : '';
        html += '<button type="button" class="' + cls + '" data-k="' + k + '"' + alpha + '>' + label + '</button>';
      });
      html += '</div>';
    });
    html +=
      '<div class="ime-kb-row">' +
      '<button type="button" class="kb-key mod wide" data-k="Mode">中 / EN</button>' +
      '<button type="button" class="kb-key mod" data-k=",">,</button>' +
      '<button type="button" class="kb-key xwide" data-k=" ">space</button>' +
      '<button type="button" class="kb-key mod" data-k=".">.</button>' +
      '<button type="button" class="kb-key mod wide" data-k="Enter">↵ return</button>' +
      '</div>';
    vkbEl.innerHTML = html;

    vkbEl.addEventListener('pointerdown', function (e) {
      /* preventDefault：不抢输入框的焦点 */
      e.preventDefault();
      var b = e.target.closest('button[data-k]');
      if (!b) return;
      var k = b.dataset.k;
      if (k === 'Shift') {
        kbShift = !kbShift;
        vkbEl.classList.toggle('shift', kbShift);
        var sb = vkbEl.querySelector('[data-k="Shift"]');
        if (sb) sb.classList.toggle('on', kbShift);
        return;
      }
      if (k === 'Mode') { toggleMode(); return; }
      if (kbShift && /^[a-z]$/.test(k)) k = k.toUpperCase();
      feedKey(k);
      if (kbShift) {
        kbShift = false;
        vkbEl.classList.remove('shift');
        var sb2 = vkbEl.querySelector('[data-k="Shift"]');
        if (sb2) sb2.classList.remove('on');
      }
    });

    document.body.appendChild(vkbEl);
    return vkbEl;
  }

  function toggleKeyboard(force) {
    var el = buildVkb();
    var show = typeof force === 'boolean' ? force : el.hidden;
    el.hidden = !show;
    if (kbBtn) kbBtn.classList.toggle('on', show);
    if (show && !state.ready && state.on && state.mode === 'cn') loadDict();
  }

  /* ---------- 虚拟键盘的按键路由 ---------- */
  function mkEvt(key, target) {
    return {
      type: 'keydown',
      key: key,
      repeat: false,
      ctrlKey: false,
      metaKey: false,
      altKey: false,
      shiftKey: false,
      target: target,
      _handled: false,
      preventDefault: function () { this._handled = true; },
      stopImmediatePropagation: function () { /* 合成事件，无后续监听 */ }
    };
  }

  function feedKey(k) {
    var el = document.activeElement && editable(document.activeElement) ? document.activeElement : null;

    /* 中文模式：把按键喂给输入法状态机（走和物理键盘完全一样的逻辑） */
    if (state.on && state.mode === 'cn' && el) {
      state.field = el;
      var e = mkEvt(k, el);
      onKey(e);
      if (e._handled) return;
    }

    /* 英文模式 / IME 关闭 / IME 没接的键：直接对焦点元素操作 */
    if (!el) return;
    if (k.length === 1) {
      document.execCommand('insertText', false, k);
      return;
    }
    if (k === 'Backspace') {
      var ev = new KeyboardEvent('keydown', { key: 'Backspace', bubbles: true });
      el.dispatchEvent(ev);
      if (!ev.defaultPrevented) document.execCommand('delete');
      return;
    }
    if (k === 'Enter') {
      var ev2 = new KeyboardEvent('keydown', { key: 'Enter', bubbles: true });
      el.dispatchEvent(ev2);
      if (!ev2.defaultPrevented && (el.tagName === 'TEXTAREA' || el.isContentEditable)) {
        document.execCommand('insertText', false, '\n');
      }
      return;
    }
    if (/^Arrow/.test(k)) {
      el.dispatchEvent(new KeyboardEvent('keydown', { key: k, bubbles: true }));
    }
  }

  /* ---------- 全局事件 ---------- */
  window.addEventListener('keydown', onKey, true);
  window.addEventListener('keyup', onKey, true);

  window.addEventListener('pointerdown', function (e) {
    if (bar && !bar.hidden && !bar.contains(e.target) && e.target !== state.field &&
        !(vkbEl && vkbEl.contains(e.target))) clearBuf();
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
    setOn: setOn,
    feedKey: feedKey,
    toggleKeyboard: toggleKeyboard,
    /* 只给调试/单测用：读内部状态与候选，不对外承诺稳定 */
    debug: function () {
      return {
        buf: state.buf,
        kind: state.kind,
        page: state.page,
        sel: state.sel,
        cands: state.cands.map(function (c) { return c.w; })
      };
    },
    _onKey: onKey
  };
})();
