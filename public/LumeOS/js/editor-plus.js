/* editor-plus.js — 编辑器手感：自动缩进 / 括号配对 / 关键字补全 / 注释切换
 *
 * 设计原则：
 *   1. 只碰 keydown，能用 execCommand('insertText') 就走它，保持原生撤销栈；
 *      走不通（老浏览器）才退回直接改 value + 手动派发 input。
 *   2. 纯逻辑（缩进怎么算、候选怎么排）都放在 LumeEdit._core，可在 Node 里单测；
 *      DOM 接线集中在 attach()。
 *   3. 输入法合成中（isComposing / keyCode 229）一律不管，避免和中文输入打架。
 */
(function (global) {
  'use strict';

  /* --------------------------------------------------------- */
  /*  词表：跟 LANGUAGE/lume/src/lexer.rs 对齐                    */
  /* --------------------------------------------------------- */
  const KEYWORDS = [
    'fn', 'if', 'else', 'while', 'for', 'in', 'break', 'continue', 'return',
    'match', 'struct', 'enum', 'impl', 'trait', 'import', 'use', 'pub', 'const',
    'extern', 'as', 'and', 'or', 'not', 'true', 'false',
    'app', 'par', 'spawn', 'await', 'scope', 'it', 'let'
  ];
  const TYPES = [
    'int', 'i8', 'i16', 'i32', 'i64', 'i128', 'u8', 'u16', 'u32', 'u64', 'u128',
    'f32', 'f64', 'float', 'bool', 'str', 'rune', 'nothing'
  ];
  const BUILTINS = ['say', 'write', 'sqrt', 'abs', 'pow', 'len', 'int_to_str', 'range'];

  /* Python 的补全表：只挑人真会想起来的那批，
     把 dir(builtins) 全塞进去只会让候选框变成噪音。 */
  const PY_KEYWORDS = [
    'def', 'class', 'return', 'if', 'elif', 'else', 'for', 'while', 'in', 'not',
    'and', 'or', 'is', 'import', 'from', 'as', 'with', 'try', 'except', 'finally',
    'raise', 'lambda', 'yield', 'global', 'nonlocal', 'pass', 'break', 'continue',
    'del', 'assert', 'async', 'await', 'match', 'case', 'True', 'False', 'None'
  ];
  const PY_BUILTINS = [
    'print', 'len', 'range', 'int', 'str', 'float', 'bool', 'list', 'dict', 'set',
    'tuple', 'sum', 'min', 'max', 'abs', 'round', 'sorted', 'reversed', 'enumerate',
    'zip', 'map', 'filter', 'open', 'input', 'type', 'isinstance', 'repr', 'any', 'all'
  ];

  const PAIRS = { '(': ')', '[': ']', '{': '}', '"': '"', "'": "'" };
  const OPENERS = Object.keys(PAIRS);
  const CLOSERS = [')', ']', '}'];

  /* --------------------------------------------------------- */
  /*  纯逻辑                                                     */
  /* --------------------------------------------------------- */
  function lineStart(text, pos) {
    return text.lastIndexOf('\n', pos - 1) + 1;
  }

  function lineEnd(text, pos) {
    const i = text.indexOf('\n', pos);
    return i === -1 ? text.length : i;
  }

  function leadingOf(line) {
    const m = /^[ \t]*/.exec(line);
    return m ? m[0] : '';
  }

  /* 去掉行尾注释，用于判断 "这一行是不是以 { 或 : 结束" */
  function stripLineComment(s, py) {
    const i = s.indexOf(py ? '#' : '//');
    return i === -1 ? s : s.slice(0, i);
  }

  /* 从文件本身猜缩进宽度：有 4 空格缩进就用 4，有制表符就用 \t */
  function detectUnit(text) {
    const lines = text.split('\n');
    for (let i = 0; i < lines.length; i++) {
      const m = /^([ \t]+)(?=\S)/.exec(lines[i]);
      if (!m) continue;
      if (m[1][0] === '\t') return '\t';
      return m[1].length >= 4 ? '    ' : '  ';
    }
    return '  ';
  }

  /* Enter 之后该缩进多少；顺便处理 "光标夹在 {} 之间" 的展开。
     lang 传 'python' 时改看行尾冒号 —— Python 的块没有花括号，
     def / if / for / with / else / try 全靠一个 : 开头。 */
  function enterEdit(text, pos, unit, lang) {
    const py = lang === 'python';
    const ls = lineStart(text, pos);
    const le = lineEnd(text, pos);
    const base = leadingOf(text.slice(ls, pos));
    const before = stripLineComment(text.slice(ls, pos), py).replace(/\s+$/, '');
    const opens = py ? /:$/.test(before) : /\{$/.test(before);
    const inner = opens ? base + unit : base;

    /* 右边只有孤零零一个 } 时：补成三行，光标停在中间那行（只有花括号语言有这回事） */
    const rest = text.slice(pos, le);
    if (!py && /^\s*\}$/.test(rest)) {
      const body = '\n' + inner + '\n' + base;
      return { text: body, caret: 1 + inner.length };
    }

    return { text: '\n' + inner, caret: 1 + inner.length };
  }

  /* 在只有空格的一行打 } 时，退一级缩进 */
  function closeDedent(text, pos, unit) {
    const ls = lineStart(text, pos);
    const before = text.slice(ls, pos);
    if (!/^ +$/.test(before)) return null;
    if (before.length < unit.length) return null;
    return { from: ls, indent: before.slice(0, before.length - unit.length) };
  }

  /* 光标左边的标识符前缀 */
  function wordBefore(text, pos) {
    const m = /[A-Za-z_][A-Za-z0-9_]*$/.exec(text.slice(Math.max(0, pos - 64), pos));
    return m ? m[0] : '';
  }

  function matchScore(word, prefix) {
    const w = word.toLowerCase();
    const p = prefix.toLowerCase();
    if (!p) return 0;
    if (w === p) return 0;
    if (w.startsWith(p)) return 1;
    if (w.includes(p)) return 2;
    return -1;
  }

  function symbolsOf(text) {
    const out = new Set();
    const re = /\b[A-Za-z_][A-Za-z0-9_]*\b/g;
    let m;
    while ((m = re.exec(text))) out.add(m[0]);
    return out;
  }

  function fnNamesOf(text) {
    const out = new Set();
    const re = /\bfn\s+([A-Za-z_][A-Za-z0-9_]*)/g;
    let m;
    while ((m = re.exec(text))) out.add(m[1]);
    return out;
  }

  /* 候选：关键字 / 类型 / 内建 → 再补上缓冲区里出现过的标识符 */
  function complete(text, prefix, opts) {
    const max = (opts && opts.max) || 8;
    const py = !!(opts && opts.lang === 'python');
    const p = String(prefix || '');
    if (!p) return [];

    const seen = new Set();
    const rows = [];

    const add = (item, score) => {
      if (seen.has(item.label)) return;
      seen.add(item.label);
      rows.push({ label: item.label, kind: item.kind, call: !!item.call, score: score });
    };

    (py ? PY_KEYWORDS : KEYWORDS).forEach((w) => {
      const s = matchScore(w, p);
      if (s >= 0) add({ label: w, kind: 'keyword' }, s * 10);
    });
    (py ? [] : TYPES).forEach((w) => {
      const s = matchScore(w, p);
      if (s >= 0) add({ label: w, kind: 'type' }, s * 10 + 1);
    });
    (py ? PY_BUILTINS : BUILTINS).forEach((w) => {
      const s = matchScore(w, p);
      if (s >= 0) add({ label: w, kind: 'builtin', call: true }, s * 10 + 2);
    });

    /* 同一个文档里定义/用过的名字排在关键字之后 */
    if (opts && opts.symbols) {
      const fns = fnNamesOf(text);
      opts.symbols.forEach((sym) => {
        if (sym === p) return;
        const s = matchScore(sym, p);
        if (s >= 0) add({ label: sym, kind: 'symbol', call: fns.has(sym) }, s * 10 + 4);
      });
    }

    rows.sort((a, b) => a.score - b.score || a.label.length - b.label.length || (a.label < b.label ? -1 : 1));
    return rows.slice(0, max);
  }

  /* 行注释开关：整块都注释了就取消，否则全部加上。
     prefix 让 Python 用 #、Lume/JS 用 //。 */
  function toggleComment(text, start, end, prefix) {
    const mark = prefix || '//';
    const safe = mark.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
    const has = new RegExp('^(\\s*)' + safe + ' ?');

    let from = lineStart(text, start);
    let to = lineEnd(text, end);
    if (end > start && text[end - 1] === '\n') to = lineEnd(text, end - 1);

    const block = text.slice(from, to);
    const lines = block.split('\n');
    const filled = lines.filter((l) => l.trim());
    const commented = filled.length > 0 && filled.every((l) => has.test(l));

    const next = lines
      .map((l) => {
        if (!l.trim()) return l;
        return commented ? l.replace(has, '$1') : l.replace(/^(\s*)/, '$1' + mark + ' ');
      })
      .join('\n');

    return { from: from, to: to, text: next };
  }

  /* 这次打的是「后引号」吗？
     判据只看当前行：光标之前同种引号的个数。
     偶数 = 没有未闭合的开引号，这是开头那个；奇数 = 已有一个张着的，这是收尾那个。
     转义过的不计数（"a\"b" 里那个 \" 是内容，不是配对）*/
  function closingQuote(text, pos, ch) {
    const seg = text.slice(lineStart(text, pos), pos);
    let n = 0;
    for (let i = 0; i < seg.length; i++) {
      if (seg[i] !== ch) continue;
      let bs = 0;
      while (i - bs - 1 >= 0 && seg[i - bs - 1] === '\\') bs++;
      if (bs % 2 === 0) n++;
    }
    return n % 2 === 1;
  }

  const CORE = {
    lineStart: lineStart,
    lineEnd: lineEnd,
    leadingOf: leadingOf,
    detectUnit: detectUnit,
    enterEdit: enterEdit,
    closeDedent: closeDedent,
    wordBefore: wordBefore,
    symbolsOf: symbolsOf,
    complete: complete,
    toggleComment: toggleComment,
    closingQuote: closingQuote,
    PAIRS: PAIRS
  };

  /* --------------------------------------------------------- */
  /*  DOM 接线                                                   */
  /* --------------------------------------------------------- */
  function attach(opts) {
    const area = opts.area;
    const wrap = opts.wrap;
    const lang = opts.lang || 'text';
    const py = lang === 'python';
    /* 会有"代码行为"的语言：补全、注释开关、缩进 */
    const isCode = lang === 'lume' || py;
    /* 括号 / 引号配对不分语言：Markdown 和纯文本一样需要（写 md 时引号成对尤其常见），
       所以这条单独开一个开关，不跟着代码补全那个门槛走 */
    const pairOn = opts.pairs !== false && /^(lume|python|md|text|none)$/.test(lang);
    const unit = detectUnit(area.value);

    let pop = null;
    let items = [];
    let index = 0;
    let frame = 0;
    let suppress = false;

    /* --- 一次编辑落地：优先 execCommand，保住原生撤销 --- */
    function replaceRange(start, end, text, caret, caretEnd) {
      area.focus();
      area.setSelectionRange(start, end);
      let done = false;
      try {
        done = text ? document.execCommand('insertText', false, text) : document.execCommand('delete');
      } catch (err) {
        done = false;
      }
      if (!done) {
        const v = area.value;
        area.value = v.slice(0, start) + text + v.slice(end);
        area.dispatchEvent(new Event('input', { bubbles: true }));
      }
      const at = caret == null ? start + text.length : caret;
      const to = caretEnd == null ? at : caretEnd;
      area.setSelectionRange(at, to);
    }

    /* --- 补全浮层 --- */
    function ensurePop() {
      if (pop) return pop;
      pop = document.createElement('div');
      pop.className = 'editor-pop';
      pop.setAttribute('role', 'listbox');
      pop.hidden = true;
      wrap.appendChild(pop);
      pop.addEventListener('mousedown', (e) => {
        const row = e.target.closest('.pop-row');
        if (!row) return;
        e.preventDefault();
        index = Number(row.dataset.i);
        accept();
      });
      return pop;
    }

    /* 用一面"镜子"量出光标在文本里的像素位置 */
    let mirror = null;
    function caretPoint(pos) {
      if (!mirror) {
        mirror = document.createElement('div');
        mirror.className = 'editor-mirror';
        mirror.setAttribute('aria-hidden', 'true');
        wrap.appendChild(mirror);
      }
      mirror.style.width = area.clientWidth + 'px';
      mirror.textContent = area.value.slice(0, pos);
      const mark = document.createElement('span');
      mark.textContent = '\u200b';
      mirror.appendChild(mark);
      return { left: mark.offsetLeft, top: mark.offsetTop };
    }

    function hidePop() {
      items = [];
      index = 0;
      if (pop) pop.hidden = true;
    }

    function renderPop() {
      const box = ensurePop();
      box.innerHTML = items
        .map(
          (it, i) =>
            '<div class="pop-row' + (i === index ? ' active' : '') + '" role="option" data-i="' + i + '">' +
            '<span class="pop-label">' + it.label + '</span>' +
            '<span class="pop-kind">' + it.kind + '</span>' +
            '</div>'
        )
        .join('');
    }

    function placePop() {
      if (!pop || pop.hidden) return;
      const cs = getComputedStyle(area);
      const lh = parseFloat(cs.lineHeight) || parseFloat(cs.fontSize) * 1.75 || 20;
      const pt = caretPoint(area.selectionStart);

      let left = pt.left - area.scrollLeft;
      let top = pt.top - area.scrollTop + lh + 2;

      const w = wrap.clientWidth;
      const h = wrap.clientHeight;
      if (left + pop.offsetWidth > w - 6) left = Math.max(4, w - pop.offsetWidth - 6);
      if (top + pop.offsetHeight > h - 8) {
        top = pt.top - area.scrollTop - pop.offsetHeight - 2;
        if (top < 4) top = 4;
      }

      pop.style.left = Math.round(left) + 'px';
      pop.style.top = Math.round(top) + 'px';
    }

    function refresh() {
      if (!isCode) return;
      if (suppress) {
        suppress = false;
        return hidePop();
      }
      const pos = area.selectionStart;
      if (pos !== area.selectionEnd) return hidePop();

      const word = wordBefore(area.value, pos);
      if (!word || /^[0-9]/.test(word)) return hidePop();

      const rows = complete(area.value, word, { max: 8, symbols: symbolsOf(area.value), lang: lang });
      if (!rows.length) return hidePop();

      items = rows;
      index = Math.min(index, rows.length - 1);
      renderPop();
      ensurePop().hidden = false;
      placePop();
    }

    function schedule() {
      if (!isCode) return;
      cancelAnimationFrame(frame);
      frame = requestAnimationFrame(refresh);
    }

    function accept() {
      const it = items[index];
      if (!it) return;
      const pos = area.selectionStart;
      const word = wordBefore(area.value, pos);
      const startAt = pos - word.length;

      hidePop();
      suppress = true;
      /* 正常情况 execCommand 会同步抛出 input，下一帧就吃掉这个标记；
         这里再兜一层，避免标记卡住导致后面一次输入不出候选 */
      setTimeout(() => {
        suppress = false;
      }, 160);

      const text = it.call ? it.label + '()' : it.label;
      replaceRange(startAt, pos, text, startAt + it.label.length + (it.call ? 1 : 0));
    }

    /* --- 键盘 --- */
    area.addEventListener('keydown', (e) => {
      if (e.isComposing || e.keyCode === 229) return;
      const mod = e.metaKey || e.ctrlKey;
      const start = area.selectionStart;
      const end = area.selectionEnd;
      const value = area.value;

      /* 补全浮层打开时先接管方向键 / 回车 / Esc */
      if (pop && !pop.hidden) {
        if (e.key === 'ArrowDown' || e.key === 'ArrowUp') {
          e.preventDefault();
          index = (index + (e.key === 'ArrowDown' ? 1 : -1) + items.length) % items.length;
          renderPop();
          return;
        }
        if (e.key === 'Enter' || e.key === 'Tab') {
          e.preventDefault();
          accept();
          return;
        }
        if (e.key === 'Escape') {
          e.preventDefault();
          hidePop();
          return;
        }
      }

      /* Enter：自动缩进 + {} 展开（Python 看行尾冒号） */
      if (e.key === 'Enter' && !mod && !e.shiftKey && start === end) {
        const ed = enterEdit(value, start, unit, lang);
        e.preventDefault();
        replaceRange(start, start, ed.text, start + ed.caret);
        return;
      }

      /* Tab / Shift+Tab：整行缩进、退格；无选区时对齐到下一个制表位 */
      if (e.key === 'Tab') {
        e.preventDefault();
        if (start === end) {
          if (e.shiftKey) {
            const ls = lineStart(value, start);
            const before = value.slice(ls, start);
            const cut = /^ {1,}$/.test(before) ? Math.min(unit.length, before.length) : 0;
            if (cut) replaceRange(start - cut, start, '', start - cut);
            return;
          }
          const ls = lineStart(value, start);
          const col = start - ls;
          const pad = unit.length - (col % unit.length) || unit.length;
          replaceRange(start, start, ' '.repeat(pad), start + pad);
          return;
        }
        indentBlock(e.shiftKey);
        return;
      }

      /* Ctrl/Cmd + / 注释开关 */
      if (mod && e.key === '/' && isCode) {
        e.preventDefault();
        const r = toggleComment(value, start, end, py ? '#' : '//');
        replaceRange(r.from, r.to, r.text, r.from, r.from + r.text.length);
        return;
      }

      /* 退格：成对符号一起删；缩进里一次退一个制表位 */
      if (e.key === 'Backspace' && !mod && start === end && start > 0) {
        const prev = value[start - 1];
        const next = value[start];
        if (pairOn && PAIRS[prev] === next && (OPENERS.indexOf(prev) >= 0)) {
          e.preventDefault();
          replaceRange(start - 1, start + 1, '', start - 1);
          return;
        }

        /* 光标停在纯缩进里：删掉整级（4 空格就一次退 4 个），和 VSCode 一致 */
        const ls = lineStart(value, start);
        const before = value.slice(ls, start);
        if (before && /^[ \t]+$/.test(before)) {
          let cut = 1;
          if (unit !== '\t' && before.indexOf('\t') === -1) {
            cut = before.length % unit.length || Math.min(unit.length, before.length);
          }
          e.preventDefault();
          replaceRange(start - cut, start, '', start - cut);
          return;
        }
        return;
      }

      const isBracketKey = (mod || e.altKey || e.key.length !== 1) ? false : true;

      /* ---- 括号 / 引号：所有语言都生效，不要求 isCode ---- */
      if (pairOn && isBracketKey) {
        const bch = e.key;

        /* 选中一段后打括号/引号：把选区包起来 */
        if (start !== end && OPENERS.indexOf(bch) >= 0) {
          const inner = value.slice(start, end);
          if (inner.indexOf('\n') === -1) {
            e.preventDefault();
            replaceRange(start, end, bch + inner + PAIRS[bch], start + 1, end + 1);
            return;
          }
        }

        /* 后面已经是同一个闭合符：跳过去，别叠一层 */
        if (start === end && (CLOSERS.indexOf(bch) >= 0 || bch === '"' || bch === "'")) {
          if (value[start] === bch) {
            e.preventDefault();
            area.setSelectionRange(start + 1, start + 1);
            hidePop();
            return;
          }
        }

        /* 后引号（给字符串收尾的那个）只落一个字符，不再补右半边。
           Lume / Python 里字符串常连着写（say("a" + "b")），
           一味补对会出现 """" 这种叠着的引号。 */
        if (isCode && start === end && (bch === '"' || bch === "'") && closingQuote(value, start, bch)) {
          e.preventDefault();
          replaceRange(start, start, bch, start + 1);
          hidePop();
          return;
        }

        /* 自动配对：后面紧跟标识符时不插手，免得破坏已有文字。
           Markdown / 纯文本里"后面紧跟非空白"的概率很高（比如正在词中间插引号），
           所以只用最保守的判定：后面是空格、行尾、或闭合/分隔符才补右半边。 */
        if (OPENERS.indexOf(bch) >= 0 && start === end) {
          const next = value[start] || '';
          const blocked = isCode
            ? next && !/[\s)\]},;:]/.test(next)
            : next && !/[\s)\]},;:。，、！？]/.test(next);
          if (!blocked) {
            e.preventDefault();
            replaceRange(start, start, bch + PAIRS[bch], start + 1);
            return;
          }
        }
      }

      /* ---- 以下都是代码专属 ---- */
      if (mod || e.altKey || e.key.length !== 1 || !isCode) return;

      const ch = e.key;

      /* 打 } 顺手退一级 */
      if (ch === '}' && start === end) {
        const cd = closeDedent(value, start, unit);
        if (cd) {
          e.preventDefault();
          const text = cd.indent + '}';
          const at = cd.from + text.length;
          replaceRange(cd.from, start, text, at);
          return;
        }
      }
    });

    function indentBlock(dedent) {
      const value = area.value;
      const start = area.selectionStart;
      const end = area.selectionEnd;
      const from = lineStart(value, start);
      const to = lineEnd(value, end);
      const block = value.slice(from, to);
      const lines = block.split('\n');

      const strip = unit === '\t' ? /^\t/ : new RegExp('^ {1,' + unit.length + '}');
      const next = lines
        .map((l) => {
          if (!l.trim() && dedent) return l;
          if (dedent) return l.replace(strip, '');
          return unit + l;
        })
        .join('\n');

      const delta = next.length - block.length;
      replaceRange(from, to, next, start + (dedent ? Math.max(-unit.length, 0) : unit.length), end + delta);
    }

    area.addEventListener('input', schedule);
    area.addEventListener('blur', hidePop);
    area.addEventListener('scroll', () => {
      if (pop && !pop.hidden) placePop();
    });
    area.addEventListener('mousedown', hidePop);

    return { refresh: refresh, hide: hidePop, unit: unit };
  }

  global.LumeEdit = { attach: attach, _core: CORE };
})(typeof window !== 'undefined' ? window : globalThis);
