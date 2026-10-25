/* ============================================================
   LumeVM — 浏览器里的一台小编译器
   
   真的做四件事：词法 → 语法 → 类型推断 → 生成 C；
   run 时再用一棵 AST 走一遍求值（浏览器里没有 clang）。
   
   覆盖的子集（对齐 LANGUAGE/lume 的真实语法）：
     fn / 参数 / 返回类型、:= 与带类型声明、赋值与复合赋值
     if / else if / else、while、for i in a..b、break、continue、return
     int float bool str nothing、算术/比较/and or not
     数组字面量与 a[i]、a.len()、字符串插值 {expr}
     say / write / sqrt / abs / len / str_len / int_to_str
   
   明确不支持并会报清楚的错：struct / enum / impl / trait / match /
   |> 管道 / par for / @装饰器 / 泛型。真编译器用 cargo，见 README。
   ============================================================ */

const LumeVM = (function () {
  'use strict';

  class LumeError extends Error {
    constructor(msg, line, col, phase) {
      super(msg);
      this.line = line || 0;
      this.col = col || 0;
      this.phase = phase || 'error';
    }
  }

  /* ============================================================
     词法
     ============================================================ */
  const KEYWORDS = new Set([
    'fn', 'struct', 'trait', 'impl', 'if', 'else', 'while', 'for', 'in',
    'return', 'break', 'continue', 'match', 'scope', 'enum', 'import', 'use',
    'pub', 'const', 'extern', 'as', 'and', 'or', 'not', 'app', 'par',
    'async', 'await', 'spawn', 'it'
  ]);

  const TYPES = new Set([
    'int', 'i8', 'i16', 'i32', 'i64', 'i128',
    'u1', 'u2', 'u4', 'u8', 'u16', 'u32', 'u64', 'u128',
    'f32', 'f64', 'float', 'bool', 'str', 'rune'
  ]);

  const OPS = [
    '..=', '|>', '->', '=>', ':=', '==', '!=', '<=', '>=',
    '+=', '-=', '*=', '/=', '%=', '&&', '||', '<<', '>>', '::', '..',
    '+', '-', '*', '/', '%', '<', '>', '=', '!', '&', '|', '^', '~', '?'
  ];

  const PUNCT = '(){}[],;:.';

  const isIdentStart = (c) => /[A-Za-z_]/.test(c || '');
  const isIdent = (c) => /[A-Za-z0-9_]/.test(c || '');
  const isDigit = (c) => c >= '0' && c <= '9';

  function lex(src) {
    const toks = [];
    let i = 0;
    let line = 1;
    let col = 1;
    const n = src.length;

    const advance = (k) => {
      for (let s = 0; s < k; s++) {
        if (src[i] === '\n') {
          line++;
          col = 1;
        } else {
          col++;
        }
        i++;
      }
    };

    while (i < n) {
      const c = src[i];

      if (c === '\n' || c === ' ' || c === '\t' || c === '\r') {
        advance(1);
        continue;
      }

      if (c === '/' && src[i + 1] === '/') {
        while (i < n && src[i] !== '\n') advance(1);
        continue;
      }
      if (c === '/' && src[i + 1] === '*') {
        advance(2);
        while (i < n && !(src[i] === '*' && src[i + 1] === '/')) advance(1);
        advance(Math.min(2, n - i));
        continue;
      }

      const startLine = line;
      const startCol = col;

      if (c === '"') {
        let j = i + 1;
        let raw = '"';
        while (j < n) {
          if (src[j] === '\\') {
            raw += src.slice(j, j + 2);
            j += 2;
            continue;
          }
          if (src[j] === '"') {
            raw += '"';
            j++;
            break;
          }
          if (src[j] === '\n') break;
          raw += src[j];
          j++;
        }
        const len = j - i;
        toks.push({ t: 'str', raw, v: raw, line: startLine, col: startCol });
        advance(len);
        continue;
      }

      if (c === "'") {
        let j = i + 1;
        let raw = "'";
        while (j < n && src[j] !== "'" && src[j] !== '\n') {
          if (src[j] === '\\') {
            raw += src.slice(j, j + 2);
            j += 2;
            continue;
          }
          raw += src[j];
          j++;
        }
        if (src[j] !== "'") throw new LumeError('未终止的符文', startLine, startCol, 'lex');
        raw += "'";
        j++;
        const len = j - i;
        toks.push({ t: 'rune', raw, v: decodeEscape(raw.slice(1, -1)), line: startLine, col: startCol });
        advance(len);
        continue;
      }

      if (isDigit(c)) {
        let j = i;
        let text = '';
        if (c === '0' && /[xXbBoO]/.test(src[i + 1] || '')) {
          j = i + 2;
          while (j < n && /[0-9a-fA-F_]/.test(src[j])) j++;
          text = src.slice(i, j);
          toks.push({ t: 'num', v: Math.trunc(Number(text.replace(/_/g, ''))), isFloat: false, line: startLine, col: startCol });
        } else {
          while (j < n && /[0-9_]/.test(src[j])) j++;
          let isFloat = false;
          if (src[j] === '.' && isDigit(src[j + 1] || '')) {
            isFloat = true;
            j++;
            while (j < n && /[0-9_]/.test(src[j])) j++;
          }
          if (/[eE]/.test(src[j] || '') && /[0-9+-]/.test(src[j + 1] || '')) {
            isFloat = true;
            j += 2;
            while (j < n && /[0-9_]/.test(src[j])) j++;
          }
          text = src.slice(i, j);
          toks.push({ t: 'num', v: Number(text.replace(/_/g, '')), isFloat, line: startLine, col: startCol });
        }
        advance(j - i);
        continue;
      }

      if (isIdentStart(c)) {
        let j = i;
        while (j < n && isIdent(src[j])) j++;
        const word = src.slice(i, j);
        let t = 'id';
        if (KEYWORDS.has(word)) t = 'kw';
        else if (TYPES.has(word)) t = 'type';
        else if (word === 'true' || word === 'false' || word === 'nothing') t = 'lit';
        toks.push({ t, v: word, line: startLine, col: startCol });
        advance(j - i);
        continue;
      }

      if (c === '@') {
        throw new LumeError(
          '装饰器（@cache / @fastmath …）不在浏览器 VM 的子集里，用 cargo 跑真编译器',
          startLine,
          startCol,
          'lex'
        );
      }

      let op = null;
      for (let k = 0; k < OPS.length; k++) {
        if (src.startsWith(OPS[k], i)) {
          op = OPS[k];
          break;
        }
      }
      if (op) {
        toks.push({ t: 'op', v: op, line: startLine, col: startCol });
        advance(op.length);
        continue;
      }
      if (PUNCT.indexOf(c) >= 0) {
        toks.push({ t: 'punct', v: c, line: startLine, col: startCol });
        advance(1);
        continue;
      }

      throw new LumeError(`无法识别的字符 '${c}'`, startLine, startCol, 'lex');
    }

    toks.push({ t: 'eof', v: '', line, col });
    return toks;
  }

  function decodeEscape(s) {
    return s.replace(/\\([\\"nrt{}'])|\\(.)/g, (m, known, other) => {
      if (known) {
        return { '\\': '\\', '"': '"', n: '\n', r: '\r', t: '\t', '{': '{', '}': '}', "'": "'" }[known];
      }
      return other;
    });
  }

  /* ============================================================
     语法
     ============================================================ */
  const UNSUPPORTED_ITEMS = {
    struct: 'struct',
    enum: 'enum',
    impl: 'impl',
    trait: 'trait',
    import: 'import',
    use: 'use',
    const: 'const'
  };

  class Parser {
    constructor(tokens) {
      this.toks = tokens;
      this.i = 0;
    }

    peek(k) {
      return this.toks[this.i + (k || 0)] || this.toks[this.toks.length - 1];
    }
    get cur() {
      return this.peek(0);
    }
    next() {
      const t = this.cur;
      if (t.t !== 'eof') this.i++;
      return t;
    }
    is(t, v) {
      const c = this.cur;
      return c.t === t && (v === undefined || c.v === v);
    }
    eat(t, v) {
      if (this.is(t, v)) return this.next();
      return null;
    }
    expect(t, v, what) {
      if (this.is(t, v)) return this.next();
      const c = this.cur;
      throw new LumeError(
        `期望 ${what || v || t}，实际是 '${c.v || c.t}'`,
        c.line,
        c.col,
        'parse'
      );
    }

    parseProgram() {
      const fns = [];
      while (!this.is('eof')) {
        const c = this.cur;
        if (c.t === 'kw' && c.v === 'fn') {
          fns.push(this.parseFn());
          continue;
        }
        if (c.t === 'kw' && c.v === 'par' && this.peek(1).v === 'for') {
          throw new LumeError('par for 需要真编译器（cargo run -- run），浏览器里的 VM 不支持', c.line, c.col, 'parse');
        }
        if (c.t === 'kw' && UNSUPPORTED_ITEMS[c.v]) {
          throw new LumeError(
            `${c.v} 不在浏览器 VM 的子集里（用 cargo 跑真编译器）`,
            c.line,
            c.col,
            'parse'
          );
        }
        throw new LumeError(`顶层只允许 fn，实际是 '${c.v || c.t}'`, c.line, c.col, 'parse');
      }
      return fns;
    }

    parseType() {
      const c = this.cur;
      if (c.t === 'type') {
        this.next();
        return { base: c.v, array: false };
      }
      if (this.is('punct', '[')) {
        this.next();
        const inner = this.parseType();
        if (this.eat('punct', ';')) this.next();
        this.expect('punct', ']', ']');
        return { base: inner.base, array: true };
      }
      throw new LumeError(`看不懂的类型 '${c.v || c.t}'`, c.line, c.col, 'parse');
    }

    parseFn() {
      const kw = this.expect('kw', 'fn', 'fn');
      const nameTok = this.expect('id', undefined, '函数名');
      this.expect('punct', '(', '(');
      const params = [];
      while (!this.is('punct', ')')) {
        const p = this.expect('id', undefined, '参数名');
        this.expect('punct', ':', ':');
        const ty = this.parseType();
        params.push({ name: p.v, type: ty });
        if (!this.eat('punct', ',')) break;
      }
      this.expect('punct', ')', ')');
      let ret = { base: 'void', array: false };
      if (this.eat('op', '->')) ret = this.parseType();
      const body = this.parseBlock();
      return { k: 'fn', name: nameTok.v, params, ret, body, line: kw.line };
    }

    parseBlock() {
      this.expect('punct', '{', '{');
      const stmts = [];
      while (!this.is('punct', '}')) {
        if (this.is('eof')) {
          const c = this.cur;
          throw new LumeError('代码块没有闭合', c.line, c.col, 'parse');
        }
        stmts.push(this.parseStmt());
      }
      this.expect('punct', '}', '}');
      return stmts;
    }

    parseStmt() {
      const c = this.cur;

      if (c.t === 'kw') {
        if (c.v === 'if') return this.parseIf();
        if (c.v === 'while') {
          this.next();
          const cond = this.parseExpr();
          const body = this.parseBlock();
          return { k: 'while', cond, body, line: c.line };
        }
        if (c.v === 'for') return this.parseFor();
        if (c.v === 'return') {
          this.next();
          const hasValue = !this.is('punct', '}') && !this.is('kw', 'else');
          return { k: 'return', expr: hasValue ? this.parseExpr() : null, line: c.line };
        }
        if (c.v === 'break') {
          this.next();
          return { k: 'break', line: c.line };
        }
        if (c.v === 'continue') {
          this.next();
          return { k: 'continue', line: c.line };
        }
        if (c.v === 'par') {
          throw new LumeError('par for 需要真编译器支持，浏览器 VM 里请用普通 for', c.line, c.col, 'parse');
        }
        if (c.v === 'match') {
          throw new LumeError('match 不在浏览器 VM 的子集里（用 cargo 跑真编译器）', c.line, c.col, 'parse');
        }
      }

      /* 声明：name := expr  /  name: type = expr */
      if (c.t === 'id' && this.peek(1).t === 'op' && this.peek(1).v === ':=') {
        this.next();
        this.next();
        const expr = this.parseExpr();
        return { k: 'let', name: c.v, declType: null, expr, line: c.line };
      }
      if (c.t === 'id' && this.peek(1).t === 'punct' && this.peek(1).v === ':') {
        this.next();
        this.next();
        const declType = this.parseType();
        this.expect('op', '=', '=');
        const expr = this.parseExpr();
        return { k: 'let', name: c.v, declType, expr, line: c.line };
      }

      const expr = this.parseExpr();
      const opTok = this.cur;
      if (opTok.t === 'op' && ['=', '+=', '-=', '*=', '/=', '%='].includes(opTok.v)) {
        this.next();
        const value = this.parseExpr();
        return { k: 'assign', target: expr, op: opTok.v, expr: value, line: c.line };
      }
      return { k: 'expr', expr, line: c.line };
    }

    parseIf() {
      const kw = this.expect('kw', 'if', 'if');
      const cond = this.parseExpr();
      const then = this.parseBlock();
      let otherwise = null;
      if (this.eat('kw', 'else')) {
        if (this.is('kw', 'if')) otherwise = [this.parseIf()];
        else otherwise = this.parseBlock();
      }
      return { k: 'if', cond, then, otherwise, line: kw.line };
    }

    parseFor() {
      const kw = this.expect('kw', 'for', 'for');
      const name = this.expect('id', undefined, '循环变量');
      this.expect('kw', 'in', 'in');
      const from = this.parseExpr();
      let incl = false;
      if (this.eat('op', '..')) incl = false;
      else if (this.eat('op', '..=')) incl = true;
      else {
        const c = this.cur;
        throw new LumeError(`for 只支持范围（0..n / 0..=n），实际是 '${c.v || c.t}'`, c.line, c.col, 'parse');
      }
      const to = this.parseExpr();
      const body = this.parseBlock();
      return { k: 'for', name: name.v, from, to, incl, body, line: kw.line };
    }

    /* ---------- 表达式（优先级由低到高） ---------- */
    parseExpr() {
      return this.parseOr();
    }

    parseOr() {
      let left = this.parseAnd();
      while (this.is('kw', 'or') || this.is('op', '||')) {
        const op = this.next().v === 'or' ? 'or' : 'or';
        left = { k: 'bin', op, l: left, r: this.parseAnd() };
      }
      return left;
    }

    parseAnd() {
      let left = this.parseEquality();
      while (this.is('kw', 'and') || this.is('op', '&&')) {
        this.next();
        left = { k: 'bin', op: 'and', l: left, r: this.parseEquality() };
      }
      return left;
    }

    parseEquality() {
      let left = this.parseCompare();
      while (this.is('op', '==') || this.is('op', '!=')) {
        const op = this.next().v;
        left = { k: 'bin', op, l: left, r: this.parseCompare() };
      }
      return left;
    }

    parseCompare() {
      let left = this.parseAdd();
      while (['<', '<=', '>', '>='].some((o) => this.is('op', o))) {
        const op = this.next().v;
        left = { k: 'bin', op, l: left, r: this.parseAdd() };
      }
      return left;
    }

    parseAdd() {
      let left = this.parseMul();
      while (this.is('op', '+') || this.is('op', '-')) {
        const op = this.next().v;
        left = { k: 'bin', op, l: left, r: this.parseMul() };
      }
      return left;
    }

    parseMul() {
      let left = this.parseUnary();
      while (['*', '/', '%'].some((o) => this.is('op', o))) {
        const op = this.next().v;
        left = { k: 'bin', op, l: left, r: this.parseUnary() };
      }
      return left;
    }

    parseUnary() {
      if (this.is('op', '-')) {
        const t = this.next();
        return { k: 'un', op: '-', e: this.parseUnary(), line: t.line };
      }
      if (this.is('kw', 'not') || this.is('op', '!')) {
        const t = this.next();
        return { k: 'un', op: 'not', e: this.parseUnary(), line: t.line };
      }
      return this.parsePostfix();
    }

    parsePostfix() {
      let node = this.parsePrimary();
      for (;;) {
        if (this.is('punct', '(')) {
          if (node.k !== 'id') {
            const c = this.cur;
            throw new LumeError('只有函数名可以被调用', c.line, c.col, 'parse');
          }
          this.next();
          const args = [];
          while (!this.is('punct', ')')) {
            args.push(this.parseExpr());
            if (!this.eat('punct', ',')) break;
          }
          this.expect('punct', ')', ')');
          node = { k: 'call', name: node.name, args, line: node.line };
          continue;
        }
        if (this.is('punct', '[')) {
          this.next();
          const idx = this.parseExpr();
          this.expect('punct', ']', ']');
          node = { k: 'index', obj: node, idx };
          continue;
        }
        if (this.is('punct', '.')) {
          this.next();
          const name = this.expect('id', undefined, '字段名');
          if (this.is('punct', '(')) {
            this.next();
            const args = [];
            while (!this.is('punct', ')')) {
              args.push(this.parseExpr());
              if (!this.eat('punct', ',')) break;
            }
            this.expect('punct', ')', ')');
            node = { k: 'method', obj: node, name: name.v, args };
          } else {
            node = { k: 'field', obj: node, name: name.v };
          }
          continue;
        }
        return node;
      }
    }

    parsePrimary() {
      const c = this.cur;

      if (c.t === 'num') {
        this.next();
        return { k: 'num', v: c.v, isFloat: !!c.isFloat, line: c.line };
      }
      if (c.t === 'str') {
        this.next();
        return { k: 'str', parts: parseStringParts(c), line: c.line };
      }
      if (c.t === 'rune') {
        this.next();
        return { k: 'rune', v: c.v.codePointAt(0), line: c.line };
      }
      if (c.t === 'lit') {
        this.next();
        if (c.v === 'true') return { k: 'bool', v: true, line: c.line };
        if (c.v === 'false') return { k: 'bool', v: false, line: c.line };
        return { k: 'nothing', line: c.line };
      }
      if (c.t === 'id') {
        this.next();
        return { k: 'id', name: c.v, line: c.line };
      }
      if (this.is('punct', '(')) {
        this.next();
        const e = this.parseExpr();
        this.expect('punct', ')', ')');
        return e;
      }
      if (this.is('punct', '[')) {
        this.next();
        const items = [];
        while (!this.is('punct', ']')) {
          items.push(this.parseExpr());
          if (!this.eat('punct', ',')) break;
        }
        this.expect('punct', ']', ']');
        return { k: 'arr', items, line: c.line };
      }
      if (this.is('op', '|>')) {
        throw new LumeError('|> 管道不在浏览器 VM 的子集里（真编译器的融合代码见 codegen/pipe.rs）', c.line, c.col, 'parse');
      }

      throw new LumeError(`这里需要一个表达式，实际是 '${c.v || c.t}'`, c.line, c.col, 'parse');
    }
  }

  /* 字符串 -> 字面量与 {表达式} 交替的片段 */
  function parseStringParts(tok) {
    const raw = tok.raw;
    const body = raw.slice(1, raw.length - 1);
    const parts = [];
    let lit = '';
    let i = 0;

    while (i < body.length) {
      const c = body[i];
      if (c === '\\') {
        lit += decodeEscape(body.slice(i, i + 2));
        i += 2;
        continue;
      }
      if (c === '{') {
        let depth = 0;
        let j = i;
        let inStr = false;
        for (; j < body.length; j++) {
          const ch = body[j];
          if (inStr) {
            if (ch === '\\') {
              j++;
              continue;
            }
            if (ch === '"') inStr = false;
            continue;
          }
          if (ch === '"') {
            inStr = true;
            continue;
          }
          if (ch === '{') depth++;
          else if (ch === '}') {
            depth--;
            if (depth === 0) break;
          }
        }
        if (j >= body.length) {
          throw new LumeError('插值 { 没有闭合', tok.line, tok.col, 'parse');
        }
        const inner = body.slice(i + 1, j);
        if (lit) {
          parts.push({ lit });
          lit = '';
        }
        const sub = new Parser(lex(inner));
        const expr = sub.parseExpr();
        if (!sub.is('eof')) {
          throw new LumeError('插值里有多余内容', tok.line, tok.col, 'parse');
        }
        parts.push({ expr });
        i = j + 1;
        continue;
      }
      lit += c;
      i++;
    }
    if (lit) parts.push({ lit });
    return parts;
  }

  /* ============================================================
     类型推断（同时给代码生成和 %f 格式化用）
     ============================================================ */
  const ARR = (t) => 'arr:' + t;
  const isArr = (t) => typeof t === 'string' && t.startsWith('arr:');
  const elemOf = (t) => t.slice(4);

  const BUILTIN_RET = {
    say: 'nothing',
    write: 'nothing',
    sqrt: 'float',
    abs: 'float',
    len: 'int',
    str_len: 'int',
    int_to_str: 'str',
    float_to_str: 'str',
    floor: 'float',
    ceil: 'float',
    pow: 'float'
  };

  function inferProgram(fns) {
    const sig = new Map();
    for (const fn of fns) {
      sig.set(fn.name, {
        params: fn.params.map((p) => tyName(p.type)),
        ret: tyName(fn.ret)
      });
    }
    for (const fn of fns) {
      const scope = new Map();
      for (const p of fn.params) scope.set(p.name, tyName(p.type));
      inferBlock(fn.body, scope, sig);
    }
    return sig;
  }

  function tyName(t) {
    if (!t) return 'void';
    if (t.array) return ARR(t.base === 'float' ? 'float' : t.base === 'str' ? 'str' : t.base === 'bool' ? 'bool' : 'int');
    if (t.base === 'float' || t.base === 'f32' || t.base === 'f64') return 'float';
    if (t.base === 'str') return 'str';
    if (t.base === 'bool') return 'bool';
    if (t.base === 'void') return 'void';
    if (t.base === 'rune') return 'int';
    return 'int';
  }

  function inferBlock(stmts, scope, sig) {
    for (const s of stmts) inferStmt(s, scope, sig);
  }

  function inferStmt(s, scope, sig) {
    if (s.k === 'let') {
      const t = inferExpr(s.expr, scope, sig);
      const declared = s.declType ? tyName(s.declType) : null;
      s.type = declared && declared !== 'void' ? declared : t;
      scope.set(s.name, s.type);
      return;
    }
    if (s.k === 'assign') {
      inferExpr(s.expr, scope, sig);
      inferExpr(s.target, scope, sig);
      return;
    }
    if (s.k === 'if') {
      inferExpr(s.cond, scope, sig);
      inferBlock(s.then, new Map(scope), sig);
      if (s.otherwise) inferBlock(s.otherwise, new Map(scope), sig);
      return;
    }
    if (s.k === 'while') {
      inferExpr(s.cond, scope, sig);
      inferBlock(s.body, new Map(scope), sig);
      return;
    }
    if (s.k === 'for') {
      inferExpr(s.from, scope, sig);
      inferExpr(s.to, scope, sig);
      const inner = new Map(scope);
      inner.set(s.name, 'int');
      inferBlock(s.body, inner, sig);
      return;
    }
    if (s.k === 'return') {
      if (s.expr) inferExpr(s.expr, scope, sig);
      return;
    }
    if (s.k === 'expr') {
      inferExpr(s.expr, scope, sig);
    }
  }

  function inferExpr(e, scope, sig) {
    let t = 'unknown';

    switch (e.k) {
      case 'num':
        t = e.isFloat ? 'float' : 'int';
        break;
      case 'str':
        for (const p of e.parts) if (p.expr) inferExpr(p.expr, scope, sig);
        t = 'str';
        break;
      case 'rune':
        t = 'int';
        break;
      case 'bool':
        t = 'bool';
        break;
      case 'nothing':
        t = 'nothing';
        break;
      case 'id':
        t = scope.get(e.name) || 'unknown';
        break;
      case 'arr': {
        let el = 'int';
        e.items.forEach((it, i) => {
          const it2 = inferExpr(it, scope, sig);
          if (i === 0) el = it2;
          else if (it2 === 'float') el = 'float';
          else if (it2 === 'str') el = 'str';
        });
        t = ARR(el);
        break;
      }
      case 'index': {
        const ot = inferExpr(e.obj, scope, sig);
        inferExpr(e.idx, scope, sig);
        t = isArr(ot) ? elemOf(ot) : 'unknown';
        break;
      }
      case 'method': {
        inferExpr(e.obj, scope, sig);
        e.args.forEach((a) => inferExpr(a, scope, sig));
        t = e.name === 'len' ? 'int' : 'unknown';
        break;
      }
      case 'field': {
        inferExpr(e.obj, scope, sig);
        t = 'unknown';
        break;
      }
      case 'call': {
        e.args.forEach((a) => inferExpr(a, scope, sig));
        const s = sig.get(e.name);
        t = s ? s.ret : BUILTIN_RET[e.name] || 'unknown';
        break;
      }
      case 'un':
        inferExpr(e.e, scope, sig);
        t = e.op === 'not' ? 'bool' : e.e.t === 'float' ? 'float' : 'int';
        break;
      case 'bin': {
        const lt = inferExpr(e.l, scope, sig);
        const rt = inferExpr(e.r, scope, sig);
        if (['==', '!=', '<', '<=', '>', '>=', 'and', 'or'].includes(e.op)) t = 'bool';
        else if (e.op === '+') t = lt === 'str' || rt === 'str' ? 'str' : lt === 'float' || rt === 'float' ? 'float' : 'int';
        else t = lt === 'float' || rt === 'float' ? 'float' : 'int';
        break;
      }
      default:
        t = 'unknown';
    }

    e.t = t;
    return t;
  }

  /* ============================================================
     求值
     ============================================================ */
  const RETURN = Symbol('return');
  const BREAK = Symbol('break');
  const CONTINUE = Symbol('continue');

  class Env {
    constructor(vars) {
      this.vars = vars || new Map();
    }
    get(name) {
      if (!this.vars.has(name)) throw new LumeError(`未定义的变量 '${name}'`, 0, 0, 'runtime');
      return this.vars.get(name);
    }
    set(name, v) {
      if (!this.vars.has(name)) {
        throw new LumeError(`未定义的变量 '${name}'`, 0, 0, 'runtime');
      }
      this.vars.set(name, v);
    }
    declare(name, v) {
      this.vars.set(name, v);
    }
    has(name) {
      return this.vars.has(name);
    }
  }

  function format(value, type) {
    if (value === null || value === undefined) return 'nothing';
    if (type === 'float' || (typeof value === 'number' && !Number.isInteger(value))) {
      return Number(value).toFixed(6);
    }
    if (typeof value === 'boolean') return value ? '1' : '0';
    return String(value);
  }

  function runProgram(fns, io, opts) {
    const sig = inferProgram(fns);
    const fnsByName = new Map(fns.map((f) => [f.name, f]));
    const limit = (opts && opts.steps) || 4000000;
    let steps = 0;

    const builtins = {
      say(args) {
        io.write(args.map((a, i) => format(a.value, a.type)).join('') + '\n');
        return null;
      },
      write(args) {
        io.write(args.map((a, i) => format(a.value, a.type)).join(''));
        return null;
      },
      sqrt(args) {
        return Math.sqrt(args[0].value);
      },
      abs(args) {
        return Math.abs(args[0].value);
      },
      floor(args) {
        return Math.floor(args[0].value);
      },
      ceil(args) {
        return Math.ceil(args[0].value);
      },
      pow(args) {
        return Math.pow(args[0].value, args[1].value);
      },
      len(args) {
        const v = args[0].value;
        return Array.isArray(v) ? v.length : String(v).length;
      },
      str_len(args) {
        return String(args[0].value).length;
      },
      int_to_str(args) {
        return String(Math.trunc(args[0].value));
      },
      float_to_str(args) {
        return Number(args[0].value).toFixed(6);
      }
    };

    function callFunction(name, argNodes, env) {
      const fn = fnsByName.get(name);
      if (!fn) throw new LumeError(`未定义的函数 '${name}'`, 0, 0, 'runtime');
      if (argNodes.length !== fn.params.length) {
        throw new LumeError(
          `${name} 需要 ${fn.params.length} 个参数，给了 ${argNodes.length}`,
          0,
          0,
          'runtime'
        );
      }
      const values = argNodes.map((a) => evalExpr(a, env));
      const scope = new Env();
      fn.params.forEach((p, i) => scope.declare(p.name, values[i]));
      try {
        execBlock(fn.body, scope);
      } catch (e) {
        if (e && e[RETURN] !== undefined) return e.value;
        if (e === RETURN) return null;
        throw e;
      }
      return null;
    }

    function evalExpr(e, env) {
      if (++steps > limit) {
        throw new LumeError('执行步数超限（可能是死循环）', e.line || 0, 0, 'runtime');
      }

      switch (e.k) {
        case 'num':
          return e.v;
        case 'str': {
          let s = '';
          for (const p of e.parts) {
            if (p.lit !== undefined) s += p.lit;
            else s += format(evalExpr(p.expr, env), p.expr.t);
          }
          return s;
        }
        case 'rune':
          return e.v;
        case 'bool':
          return e.v;
        case 'nothing':
          return null;
        case 'id':
          return env.get(e.name);
        case 'arr':
          return e.items.map((it) => evalExpr(it, env));
        case 'index': {
          const obj = evalExpr(e.obj, env);
          const idx = evalExpr(e.idx, env);
          if (!Array.isArray(obj)) throw new LumeError('只能对数组取下标', e.line, 0, 'runtime');
          if (idx < 0 || idx >= obj.length) {
            throw new LumeError(`下标越界：${idx}（长度 ${obj.length}）`, e.line, 0, 'runtime');
          }
          return obj[idx];
        }
        case 'method': {
          const obj = evalExpr(e.obj, env);
          if (e.name === 'len') {
            if (Array.isArray(obj)) return obj.length;
            return String(obj).length;
          }
          throw new LumeError(`数组没有方法 '${e.name}'`, e.line, 0, 'runtime');
        }
        case 'field':
          throw new LumeError('结构体字段不在浏览器 VM 的子集里', e.line, 0, 'runtime');
        case 'call': {
          if (fnsByName.has(e.name)) return callFunction(e.name, e.args, env);
          if (builtins[e.name]) {
            const args = e.args.map((a) => ({ value: evalExpr(a, env), type: a.t }));
            return builtins[e.name](args);
          }
          throw new LumeError(`未定义的函数 '${e.name}'`, e.line, 0, 'runtime');
        }
        case 'un': {
          if (e.op === 'not') return !truthy(evalExpr(e.e, env));
          return -evalExpr(e.e, env);
        }
        case 'bin':
          return evalBin(e, env);
        default:
          throw new LumeError(`不支持的表达式 '${e.k}'`, e.line || 0, 0, 'runtime');
      }
    }

    function evalBin(e, env) {
      if (e.op === 'and') return truthy(evalExpr(e.l, env)) && truthy(evalExpr(e.r, env));
      if (e.op === 'or') return truthy(evalExpr(e.l, env)) || truthy(evalExpr(e.r, env));

      const a = evalExpr(e.l, env);
      const b = evalExpr(e.r, env);

      switch (e.op) {
        case '+':
          if (typeof a === 'string' || typeof b === 'string') return String(a) + String(b);
          return a + b;
        case '-':
          return a - b;
        case '*':
          return a * b;
        case '/':
          /* 整数除法向零截断，跟 C 一致 */
          if (e.t === 'int' || (Number.isInteger(a) && Number.isInteger(b) && e.t !== 'float')) {
            if (b === 0) throw new LumeError('除以零', e.line, 0, 'runtime');
            return Math.trunc(a / b);
          }
          if (b === 0) return Infinity;
          return a / b;
        case '%':
          if (b === 0) throw new LumeError('对零取模', e.line, 0, 'runtime');
          return a % b;
        case '==':
          return a === b;
        case '!=':
          return a !== b;
        case '<':
          return a < b;
        case '<=':
          return a <= b;
        case '>':
          return a > b;
        case '>=':
          return a >= b;
        default:
          throw new LumeError(`不支持的运算符 '${e.op}'`, e.line || 0, 0, 'runtime');
      }
    }

    function truthy(v) {
      if (typeof v === 'boolean') return v;
      if (typeof v === 'number') return v !== 0;
      return !!v;
    }

    function execBlock(stmts, env) {
      for (const s of stmts) execStmt(s, env);
    }

    function execStmt(s, env) {
      if (++steps > limit) throw new LumeError('执行步数超限（可能是死循环）', s.line || 0, 0, 'runtime');

      switch (s.k) {
        case 'let':
          env.declare(s.name, evalExpr(s.expr, env));
          return;
        case 'assign': {
          const v = evalExpr(s.expr, env);
          if (s.op === '=') {
            assignTo(s.target, v, env);
            return;
          }
          const cur = evalExpr(s.target, env);
          const op = s.op[0];
          const next = evalBin({ k: 'bin', op, l: { k: 'num', v: cur, t: s.target.t }, r: { k: 'num', v, t: s.expr.t }, t: s.target.t, line: s.line }, env);
          assignTo(s.target, next, env);
          return;
        }
        case 'if':
          if (truthy(evalExpr(s.cond, env))) execBlock(s.then, env);
          else if (s.otherwise) execBlock(s.otherwise, env);
          return;
        case 'while': {
          let guard = 0;
          while (truthy(evalExpr(s.cond, env))) {
            if (++guard > limit) throw new LumeError('while 循环次数超限', s.line, 0, 'runtime');
            try {
              execBlock(s.body, env);
            } catch (e) {
              if (e === BREAK) break;
              if (e === CONTINUE) continue;
              throw e;
            }
          }
          return;
        }
        case 'for': {
          const from = evalExpr(s.from, env);
          const to = evalExpr(s.to, env);
          for (let i = from; s.incl ? i <= to : i < to; i++) {
            if (++steps > limit) throw new LumeError('执行步数超限（可能是死循环）', s.line, 0, 'runtime');
            env.declare(s.name, i);
            try {
              execBlock(s.body, env);
            } catch (e) {
              if (e === BREAK) break;
              if (e === CONTINUE) continue;
              throw e;
            }
          }
          return;
        }
        case 'return': {
          const value = s.expr ? evalExpr(s.expr, env) : null;
          throw { [RETURN]: true, value };
        }
        case 'break':
          throw BREAK;
        case 'continue':
          throw CONTINUE;
        case 'expr':
          evalExpr(s.expr, env);
          return;
        default:
          throw new LumeError(`不支持的语句 '${s.k}'`, s.line || 0, 0, 'runtime');
      }
    }

    function assignTo(target, value, env) {
      if (target.k === 'id') {
        env.set(target.name, value);
        return;
      }
      if (target.k === 'index') {
        const obj = evalExpr(target.obj, env);
        const idx = evalExpr(target.idx, env);
        if (!Array.isArray(obj)) throw new LumeError('只能给数组元素赋值', target.line, 0, 'runtime');
        if (idx < 0 || idx >= obj.length) {
          throw new LumeError(`下标越界：${idx}（长度 ${obj.length}）`, target.line, 0, 'runtime');
        }
        obj[idx] = value;
        return;
      }
      throw new LumeError('赋值目标必须是变量或数组元素', target.line || 0, 0, 'runtime');
    }

    /* 入口 */
    let main = fnsByName.get('main');
    if (!main) throw new LumeError('没有 main 函数', 0, 0, 'link');
    const entryScope = new Env();
    try {
      execBlock(main.body, entryScope);
    } catch (e) {
      if (!(e && e[RETURN] !== undefined)) throw e;
    }

    return sig;
  }

  /* ============================================================
     生成 C
     ============================================================ */
  const C_TYPES = {
    int: 'long long',
    float: 'double',
    bool: 'int',
    str: 'const char*',
    nothing: 'void',
    void: 'void'
  };

  function cType(t) {
    if (isArr(t)) return C_TYPES[elemOf(t)] || 'long long';
    return C_TYPES[t] || 'long long';
  }

  function cQuote(s) {    return String(s)
      .replace(/\\/g, '\\\\')
      .replace(/"/g, '\\"')
      .replace(/\n/g, '\\n')
      .replace(/\t/g, '\\t')
      .replace(/%/g, '%%');
  }

  let GEN_IN_MAIN = false;

  function genC(fns, opts) {
    const sig = inferProgram(fns);
    const out = [];
    const push = (indent, text) => out.push('  '.repeat(indent) + text);

    push(0, '/* generated by lume ' + (opts && opts.version ? opts.version : '0.2.0') + ' (in-browser vm) */');
    push(0, '#include <stdio.h>');
    push(0, '#include <stdlib.h>');
    push(0, '#include <string.h>');
    push(0, '#include <math.h>');
    push(0, '');
    push(0, 'static const char* lume_concat(const char* a, const char* b) {');
    push(1, 'size_t la = strlen(a), lb = strlen(b);');
    push(1, 'char* r = (char*)malloc(la + lb + 1);');
    push(1, 'memcpy(r, a, la); memcpy(r + la, b, lb + 1);');
    push(1, 'return r;');
    push(0, '}');
    push(0, 'static const char* lume_int_str(long long v) {');
    push(1, 'char* b = (char*)malloc(24);');
    push(1, 'snprintf(b, 24, "%lld", v);');
    push(1, 'return b;');
    push(0, '}');
    push(0, 'static const char* lume_float_str(double v) {');
    push(1, 'char* b = (char*)malloc(40);');
    push(1, 'snprintf(b, 40, "%f", v);');
    push(1, 'return b;');
    push(0, '}');
    push(0, '');

    for (const fn of fns) {
      const isMain = fn.name === 'main';
      const params = isMain
        ? 'void'
        : fn.params.map((p) => `${cType(tyName(p.type))} ${p.name}`).join(', ') || 'void';
      const ret = isMain ? 'int' : cType(tyName(fn.ret));
      GEN_IN_MAIN = isMain;
      push(0, `${isMain ? '' : 'static '}${ret} ${fn.name}(${params}) {`);
      genBlock(fn.body, 1, push, sig);
      if (isMain) push(1, 'return 0;');
      push(0, '}');
      push(0, '');
    }
    GEN_IN_MAIN = false;

    return out.join('\n') + '\n';
  }

  function genBlock(stmts, indent, push, sig) {
    for (const s of stmts) genStmt(s, indent, push, sig);
  }

  function genStmt(s, indent, push, sig) {
    if (s.k === 'let') {
      const t = s.type || 'int';
      if (isArr(t)) {
        const items = s.expr.k === 'arr' ? s.expr.items.map(genExpr) : null;
        if (!items) throw new LumeError('后端只支持用字面量初始化的数组', s.line, 0, 'codegen');
        push(indent, `${cType(t)} ${s.name}[${items.length}] = { ${items.join(', ')} };`);
        return;
      }
      push(indent, `${cType(t)} ${s.name} = ${genExpr(s.expr, sig)};`);
      return;
    }
    if (s.k === 'assign') {
      if (s.target.k === 'id') {
        push(indent, `${s.target.name} ${s.op} ${genExpr(s.expr, sig)};`);
        return;
      }
      if (s.target.k === 'index') {
        push(indent, `${genExpr(s.target.obj, sig)}[${genExpr(s.target.idx, sig)}] ${s.op} ${genExpr(s.expr, sig)};`);
        return;
      }
      throw new LumeError('无法赋值的左值', s.line, 0, 'codegen');
    }
    if (s.k === 'if') {
      push(indent, `if (${genExpr(s.cond, sig)}) {`);
      genBlock(s.then, indent + 1, push, sig);
      if (s.otherwise) {
        push(indent, '} else {');
        genBlock(s.otherwise, indent + 1, push, sig);
      }
      push(indent, '}');
      return;
    }
    if (s.k === 'while') {
      push(indent, `while (${genExpr(s.cond, sig)}) {`);
      genBlock(s.body, indent + 1, push, sig);
      push(indent, '}');
      return;
    }
    if (s.k === 'for') {
      const cmp = s.incl ? '<=' : '<';
      const v = s.name;
      push(indent, `for (long long ${v} = ${genExpr(s.from, sig)}; ${v} ${cmp} ${genExpr(s.to, sig)}; ${v}++) {`);
      genBlock(s.body, indent + 1, push, sig);
      push(indent, '}');
      return;
    }
    if (s.k === 'return') {
      if (s.expr) push(indent, `return ${genExpr(s.expr, sig)};`);
      else push(indent, GEN_IN_MAIN ? 'return 0;' : 'return;');
      return;
    }
    if (s.k === 'break') {
      push(indent, 'break;');
      return;
    }
    if (s.k === 'continue') {
      push(indent, 'continue;');
      return;
    }
    if (s.k === 'expr') {
      const e = s.expr;
      if (e.k === 'call' && (e.name === 'say' || e.name === 'write')) {
        push(indent, genPrint(e, e.name === 'say', sig));
        return;
      }
      push(indent, `${genExpr(e, sig)};`);
      return;
    }
    throw new LumeError(`无法生成 ${s.k} 语句`, s.line || 0, 0, 'codegen');
  }

  function genPrint(call, newline, sig) {
    const arg = call.args[0];
    if (!arg) return 'printf("\\n");';
    if (arg.k !== 'str') {
      const t = arg.t;
      const spec = t === 'float' ? '%f' : t === 'str' ? '%s' : t === 'bool' ? '%d' : '%lld';
      return `printf("${spec}${newline ? '\\n' : ''}", ${genExpr(arg, sig)});`;
    }
    let fmt = '';
    const args = [];
    for (const p of arg.parts) {
      if (p.lit !== undefined) {
        fmt += cQuote(p.lit);
      } else {
        const t = p.expr.t;
        if (t === 'float') fmt += '%f';
        else if (t === 'str') fmt += '%s';
        else if (t === 'bool') fmt += '%d';
        else if (t === 'nothing') fmt += '%s';
        else fmt += '%lld';
        let code = genExpr(p.expr, sig);
        if (t === 'nothing') code = '(const char*)"nothing"';
        args.push(code);
      }
    }
    if (newline) fmt += '\\n';
    return `printf("${fmt}"${args.length ? ', ' + args.join(', ') : ''});`;
  }

  function genExpr(e, sig) {
    switch (e.k) {
      case 'num':
        return e.isFloat ? String(e.v) : String(Math.trunc(e.v));
      case 'rune':
        return String(e.v);
      case 'bool':
        return e.v ? '1' : '0';
      case 'nothing':
        return '(const char*)"nothing"';
      case 'str': {
        const parts = e.parts.map((p) => {
          if (p.lit !== undefined) return `"${cQuote(p.lit)}"`;
          return genExpr(p.expr, sig);
        });
        if (!parts.length) return '""';
        return parts.reduce((a, b) => `lume_concat(${a}, ${b})`);
      }
      case 'id':
        return e.name;
      case 'arr':
        throw new LumeError('数组字面量只能出现在声明里', e.line || 0, 0, 'codegen');
      case 'index':
        return `${genExpr(e.obj, sig)}[${genExpr(e.idx, sig)}]`;
      case 'method': {
        if (e.name === 'len') {
          const ot = e.obj.t;
          if (isArr(ot) && e.obj.k === 'id') {
            return `(long long)(sizeof(${e.obj.name}) / sizeof(${e.obj.name}[0]))`;
          }
          return `(long long)strlen(${genExpr(e.obj, sig)})`;
        }
        throw new LumeError(`后端没有方法 '${e.name}'`, e.line || 0, 0, 'codegen');
      }
      case 'call': {
        if (e.name === 'len' || e.name === 'str_len') {
          return `(long long)strlen(${genExpr(e.args[0], sig)})`;
        }
        if (e.name === 'abs') return `fabs(${genExpr(e.args[0], sig)})`;
        if (e.name === 'sqrt' || e.name === 'floor' || e.name === 'ceil' || e.name === 'pow') {
          return `${e.name}(${e.args.map((a) => genExpr(a, sig)).join(', ')})`;
        }
        if (e.name === 'int_to_str') return `lume_int_str(${genExpr(e.args[0], sig)})`;
        if (e.name === 'float_to_str') return `lume_float_str(${genExpr(e.args[0], sig)})`;
        if (e.name === 'say' || e.name === 'write') return `printf("")`;
        if (!sig.has(e.name)) {
          throw new LumeError(`后端没有内建函数 '${e.name}'`, e.line || 0, 0, 'codegen');
        }
        return `${e.name}(${e.args.map((a) => genExpr(a, sig)).join(', ')})`;
      }
      case 'un':
        return e.op === 'not' ? `(!${genExpr(e.e, sig)})` : `(-${genExpr(e.e, sig)})`;
      case 'bin': {
        const op = { and: '&&', or: '||' }[e.op] || e.op;
        if (e.op === '+' && (e.l.t === 'str' || e.r.t === 'str')) {
          return `lume_concat(${genExpr(e.l, sig)}, ${genExpr(e.r, sig)})`;
        }
        return `(${genExpr(e.l, sig)} ${op} ${genExpr(e.r, sig)})`;
      }
      case 'field':
        throw new LumeError('结构体不在浏览器 VM 的子集里', e.line || 0, 0, 'codegen');
      default:
        throw new LumeError(`无法生成表达式 '${e.k}'`, e.line || 0, 0, 'codegen');
    }
  }

  /* ============================================================
     对外
     ============================================================ */
  function parse(src) {
    const toks = lex(src);
    const p = new Parser(toks);
    const fns = p.parseProgram();
    return { fns, tokens: toks.length - 1 };
  }

  function fmtError(err, name) {
    const line = err.line || 0;
    const col = err.col || 0;
    const where = line ? `${name}:${line}:${col}: ` : `${name}: `;
    return `${where}${err.phase || 'error'}: ${err.message}`;
  }

  function run(src, opts) {
    const name = (opts && opts.name) || 'main.lume';
    const lines = [];
    const io = {
      write(text) {
        const parts = String(text).split('\n');
        for (let i = 0; i < parts.length; i++) {
          if (i < parts.length - 1) lines.push(parts[i]);
          else if (parts[i]) lines.push(parts[i]);
        }
      }
    };

    try {
      const { fns, tokens } = parse(src);
      runProgram(fns, io, opts);
      return { ok: true, output: lines, tokens, fns: fns.length };
    } catch (err) {
      if (err instanceof LumeError) {
        return { ok: false, error: err, message: fmtError(err, name), output: lines };
      }
      throw err;
    }
  }

  function build(src, opts) {
    const name = (opts && opts.name) || 'main.lume';
    try {
      const { fns, tokens } = parse(src);
      const c = genC(fns, opts);
      return { ok: true, c, tokens, fns: fns.length, lines: c.split('\n').length - 1 };
    } catch (err) {
      if (err instanceof LumeError) {
        return { ok: false, error: err, message: fmtError(err, name) };
      }
      throw err;
    }
  }

  return { run, build, parse, LumeError, fmtError, version: '0.2.0' };
})();

if (typeof window !== 'undefined') window.LumeVM = LumeVM;
