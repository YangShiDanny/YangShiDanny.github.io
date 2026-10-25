/* ============================================================
   LumeHighlight — .lume 语法高亮
   关键字表直接对齐 LANGUAGE/lume/src/lexer.rs 的 keyword()，
   额外支持字符串插值 {expr}（可嵌套字符串）、符文、十六进制、
   装饰器、管道 |>、范围 ..、..=。

   不依赖第三方库，纯字符串扫描，输出带 tok-* 类的 HTML。
   ============================================================ */

const LumeHighlight = (function () {
  /* 控制关键字（含 lexer.rs 里的 app/par/async/await/spawn/it/scope） */
  const KEYWORDS = new Set([
    'fn', 'struct', 'trait', 'impl', 'if', 'else', 'while', 'for', 'in',
    'return', 'break', 'continue', 'match', 'scope', 'enum', 'import', 'use',
    'pub', 'const', 'extern', 'as', 'and', 'or', 'not', 'app', 'par',
    'async', 'await', 'spawn', 'it'
  ]);

  /* 内建类型 */
  const TYPES = new Set([
    'int', 'i8', 'i16', 'i32', 'i64', 'i128',
    'u1', 'u2', 'u4', 'u8', 'u16', 'u32', 'u64', 'u128',
    'f32', 'f64', 'float', 'bool', 'str', 'rune'
  ]);

  /* 字面量常量 */
  const CONSTS = new Set(['true', 'false', 'nothing']);

  /* 声明关键字 → 其后第一个标识符该着什么色 */
  const DECL = { fn: 'tok-fn', struct: 'tok-type', enum: 'tok-type', trait: 'tok-type' };

  /* 多字符运算符，按长度降序，保证 |> 不会被拆成 | 和 > */
  const OPS = [
    '..=', '|>', '->', '=>', ':=', '==', '!=', '<=', '>=',
    '+=', '-=', '*=', '/=', '%=', '&&', '||', '<<', '>>', '::', '..',
    '+', '-', '*', '/', '%', '<', '>', '=', '!', '&', '|', '^', '~', '?'
  ];

  const PUNCT = '(){}[],;:.';

  const esc = (s) => s.replace(/[&<>]/g, (c) => (c === '&' ? '&amp;' : c === '<' ? '&lt;' : '&gt;'));
  const isIdentStart = (c) => (c >= 'a' && c <= 'z') || (c >= 'A' && c <= 'Z') || c === '_';
  const isIdent = (c) => isIdentStart(c) || (c >= '0' && c <= '9');
  const isDigit = (c) => c >= '0' && c <= '9';

  function span(cls, text) {
    return '<span class="' + cls + '">' + esc(text) + '</span>';
  }

  /* 扫描代码，stop 为 '}' 时表示这是插值内部，遇到 } 结束 */
  function scan(src, start, stop) {
    const n = src.length;
    let i = start;
    let out = '';
    let expectName = null; /* 'fn' 之后的下一个标识符 */

    while (i < n) {
      const c = src[i];

      if (stop && c === stop) return { html: out, i, closed: true };

      /* ---- 注释 ---- */
      if (c === '/' && src[i + 1] === '/') {
        let j = src.indexOf('\n', i);
        if (j < 0) j = n;
        out += span('tok-comment', src.slice(i, j));
        i = j;
        continue;
      }
      if (c === '/' && src[i + 1] === '*') {
        let j = src.indexOf('*/', i + 2);
        j = j < 0 ? n : j + 2;
        out += span('tok-comment', src.slice(i, j));
        i = j;
        continue;
      }

      /* ---- 字符串（含插值） ---- */
      if (c === '"') {
        const r = readString(src, i);
        out += r.html;
        i = r.i;
        expectName = null;
        continue;
      }

      /* ---- 符文 'a' / '\n' ---- */
      if (c === "'") {
        const ch = src[i + 1];
        if (ch === '\\' && src[i + 3] === "'") {
          out += span('tok-str', src.slice(i, i + 4));
          i += 4;
          continue;
        }
        if (ch && ch !== '\n' && src[i + 2] === "'") {
          out += span('tok-str', src.slice(i, i + 3));
          i += 3;
          continue;
        }
        out += span('tok-punct', "'");
        i += 1;
        continue;
      }

      /* ---- #rrggbb 颜色字面量 ---- */
      if (c === '#' && /^[0-9a-fA-F]{6}$/.test(src.slice(i + 1, i + 7)) && !isIdent(src[i + 7] || '')) {
        out += span('tok-color', src.slice(i, i + 7));
        i += 7;
        continue;
      }

      /* ---- 装饰器 @name ---- */
      if (c === '@' && isIdentStart(src[i + 1] || '')) {
        let j = i + 1;
        while (j < n && isIdent(src[j])) j++;
        out += span('tok-deco', src.slice(i, j));
        i = j;
        continue;
      }

      /* ---- 数字 ---- */
      if (isDigit(c) || (c === '.' && isDigit(src[i + 1] || ''))) {
        let j = i;
        if (c === '0' && /[xXbBoO]/.test(src[i + 1] || '')) {
          j = i + 2;
          while (j < n && (isIdent(src[j]) || src[j] === '_')) j++;
        } else {
          while (j < n && (isDigit(src[j]) || src[j] === '_')) j++;
          if (src[j] === '.' && isDigit(src[j + 1] || '')) {
            j++;
            while (j < n && (isDigit(src[j]) || src[j] === '_')) j++;
          }
          if (/[eE]/.test(src[j] || '') && /[0-9+-]/.test(src[j + 1] || '')) {
            j += 2;
            while (j < n && (isDigit(src[j]) || src[j] === '_')) j++;
          }
        }
        out += span('tok-num', src.slice(i, j));
        i = j;
        expectName = null;
        continue;
      }

      /* ---- 标识符 / 关键字 ---- */
      if (isIdentStart(c)) {
        let j = i;
        while (j < n && isIdent(src[j])) j++;
        const word = src.slice(i, j);
        let cls = null;

        if (expectName) {
          cls = expectName;
          expectName = null;
        } else if (DECL[word]) {
          cls = 'tok-kw';
          expectName = DECL[word];
        } else if (word === 'self') {
          cls = 'tok-self';
        } else if (KEYWORDS.has(word)) {
          cls = 'tok-kw';
        } else if (TYPES.has(word)) {
          cls = 'tok-type';
        } else if (CONSTS.has(word)) {
          cls = 'tok-const';
        } else {
          /* 大写开头视作用户类型（Tag / ArrBox）；后面紧跟 ( 视作调用 */
          let k = j;
          while (k < n && (src[k] === ' ' || src[k] === '\t')) k++;
          if (src[k] === '(') cls = 'tok-call';
          else if (word[0] >= 'A' && word[0] <= 'Z') cls = 'tok-type';
        }

        out += cls ? span(cls, word) : esc(word);
        i = j;
        continue;
      }

      /* ---- 运算符 ---- */
      let matched = null;
      for (let k = 0; k < OPS.length; k++) {
        if (src.startsWith(OPS[k], i)) {
          matched = OPS[k];
          break;
        }
      }
      if (matched) {
        out += span('tok-op', matched);
        i += matched.length;
        expectName = null;
        continue;
      }

      /* ---- 标点与空白 ---- */
      if (PUNCT.indexOf(c) >= 0) {
        out += span('tok-punct', c);
        i++;
        expectName = null;
        continue;
      }

      out += esc(c);
      i++;
    }

    return { html: out, i, closed: false };
  }

  /* 字符串：把 {expr} 拆成「字符串 - 大括号 - 表达式 - 大括号 - 字符串」 */
  function readString(src, start) {
    const n = src.length;
    let i = start + 1;
    let text = '"';
    let out = '';

    while (i < n) {
      const c = src[i];

      if (c === '\\') {
        if (i + 1 < n) {
          text += src.slice(i, i + 2);
          i += 2;
        } else {
          text += c;
          i++;
        }
        continue;
      }
      if (c === '"') {
        text += '"';
        i++;
        out += span('tok-str', text);
        text = '';
        break;
      }
      if (c === '\n') {
        /* 未闭合，收尾继续往下扫 */
        out += span('tok-str', text);
        text = '';
        break;
      }
      if (c === '{') {
        out += span('tok-str', text);
        text = '';
        out += span('tok-punct tok-brace', '{');
        const r = scan(src, i + 1, '}');
        out += r.html;
        if (r.closed) {
          out += span('tok-punct tok-brace', '}');
          i = r.i + 1;
        } else {
          i = r.i;
        }
        continue;
      }

      text += c;
      i++;
    }

    if (text) out += span('tok-str', text);
    return { html: out, i };
  }

  /* 对外：把源码渲染成高亮 HTML */
  function render(src) {
    return scan(src, 0, null).html + '\n';
  }

  function isLume(path) {
    return /\.lume$/i.test(path || '');
  }

  return { render, isLume };
})();

if (typeof window !== 'undefined') window.LumeHighlight = LumeHighlight;
