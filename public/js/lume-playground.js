/* LumeOS landing-page Playground — drives the editor + C/run panes.
   Depends on window.LumeVM (loaded from /LumeOS/js/lume-vm.js). No backend. */
(function () {
  'use strict';

  var DEFAULT = `fn sq(x: int) -> int {
    return x * x
}

fn main() {
    name := "lume"
    say("hello, {name} — 3^2 = {sq(3)}")

    total: int = 0
    for i in 0..10 {
        if i % 2 == 0 {
            total += sq(i)
        }
    }
    say("sum of squares of evens under 10 = {total}")

    xs := [3, 1, 4, 1, 5, 9, 2, 6]
    best := xs[0]
    for i in 1..xs.len() {
        if xs[i] > best { best = xs[i] }
    }
    say("{xs.len()} numbers, max = {best}")
}`;

  var KW = new Set(['fn', 'if', 'else', 'while', 'for', 'in', 'return', 'break',
    'continue', 'match', 'struct', 'trait', 'impl', 'enum', 'scope', 'import',
    'use', 'pub', 'const', 'extern', 'app', 'par', 'async', 'await', 'spawn',
    'it', 'and', 'or', 'not', 'as']);
  var TYPES = new Set(['int', 'i8', 'i16', 'i32', 'i64', 'i128', 'u1', 'u2', 'u4',
    'u8', 'u16', 'u32', 'u64', 'u128', 'f32', 'f64', 'float', 'bool', 'str',
    'rune', 'void']);
  var BUILTINS = new Set(['say', 'write', 'sqrt', 'abs', 'len', 'str_len',
    'int_to_str', 'float', 'floor', 'ceil', 'pow']);
  var CKW = new Set(['int', 'long', 'short', 'char', 'void', 'static', 'const',
    'return', 'if', 'else', 'for', 'while', 'do', 'switch', 'case', 'break',
    'continue', 'struct', 'sizeof', 'unsigned', 'signed', 'double', 'float',
    'typedef', 'enum', 'goto']);
  var CPRE = new Set(['include', 'define', 'ifdef', 'ifndef', 'endif', 'if',
    'else', 'pragma', 'ifndef']);

  function esc(s) {
    return s.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');
  }
  function isIdentStart(c) { return /[A-Za-z_]/.test(c || ''); }
  function isIdent(c) { return /[A-Za-z0-9_]/.test(c || ''); }
  function isDigit(c) { return c >= '0' && c <= '9'; }

  function highlight(code, lang) {
    var isC = lang === 'c';
    var out = '';
    var buf = '';
    var i = 0, n = code.length;
    var state = 'code';
    var lineStart = true;

    function flushPlain() { if (buf) { out += esc(buf); buf = ''; } }
    function wrap(cls, text) { out += '<span class="' + cls + '">' + esc(text) + '</span>'; }

    while (i < n) {
      var c = code[i], c2 = code[i + 1];

      if (state === 'line') {
        if (c === '\n') { out += '\n'; state = 'code'; lineStart = true; }
        else buf += c;
        i++; continue;
      }
      if (state === 'block') {
        if (c === '*' && c2 === '/') { flushPlain(); wrap('cmt', '*/'); i += 2; state = 'code'; }
        else buf += c;
        i++; continue;
      }
      if (state === 'str') {
        if (c === '\\') {
          buf += c;
          if (i + 1 < n) { buf += code[i + 1]; i += 2; } else i++;
          continue;
        }
        if (c === '"') { buf += '"'; flushPlain(); state = 'code'; }
        else buf += c;
        i++; continue;
      }

      // code state
      if (lineStart && isC && c === '#') {
        var p = i; while (p < n && code[p] !== '\n') p++;
        flushPlain(); wrap('pre', code.slice(i, p)); i = p; lineStart = false; continue;
      }
      if (c === '/' && c2 === '/') {
        flushPlain(); var e = i; while (e < n && code[e] !== '\n') e++;
        wrap('cmt', code.slice(i, e)); i = e; continue;
      }
      if (c === '/' && c2 === '*') { flushPlain(); wrap('cmt', '/*'); i += 2; state = 'block'; continue; }
      if (c === '"') { flushPlain(); buf = '"'; i++; state = 'str'; lineStart = false; continue; }
      if (isIdentStart(c)) {
        flushPlain(); var j = i; while (j < n && isIdent(code[j])) j++;
        var w = code.slice(i, j);
        var cls = KW.has(w) ? 'kw' : (TYPES.has(w) ? 'ty' : (BUILTINS.has(w) ? 'fn' : (isC && CKW.has(w) ? 'kw' : '')));
        if (cls) wrap(cls, w); else out += esc(w);
        i = j; lineStart = false; continue;
      }
      if (isDigit(c)) {
        flushPlain(); var k = i; while (k < n && /[0-9.xXa-fA-F_]/.test(code[k])) k++;
        wrap('num', code.slice(i, k)); i = k; lineStart = false; continue;
      }
      if (isC && /[+\-*/%=<>!&|^~?:]/.test(c)) {
        flushPlain(); var m = i; while (m < n && /[+\-*/%=<>!&|^~?:]/.test(code[m])) m++;
        wrap('op', code.slice(i, m)); i = m; lineStart = false; continue;
      }
      buf += c; lineStart = (c === '\n'); i++;
    }
    flushPlain();
    return out;
  }

  function init() {
    if (!window.LumeVM) { setTimeout(init, 60); return; }
    var ta = document.getElementById('pg-code');
    var hl = document.getElementById('pg-hl');
    var runBtn = document.getElementById('pg-run');
    var resetBtn = document.getElementById('pg-reset');
    var cPre = document.getElementById('pg-c');
    var runPre = document.getElementById('pg-run-out');
    var statusEl = document.getElementById('pg-status');
    var tabC = document.getElementById('pg-tab-c');
    var tabR = document.getElementById('pg-tab-run');
    if (!ta) return;
    if (!ta.value.trim()) ta.value = DEFAULT;

    function paint() { hl.innerHTML = highlight(ta.value + '\n', 'lume'); }
    function showTab(which) {
      var cOn = which === 'c';
      if (cPre) cPre.hidden = !cOn;
      if (runPre) runPre.hidden = cOn;
      if (tabC) tabC.classList.toggle('active', cOn);
      if (tabR) tabR.classList.toggle('active', !cOn);
    }

    ta.addEventListener('input', paint);
    ta.addEventListener('scroll', function () {
      hl.scrollTop = ta.scrollTop; hl.scrollLeft = ta.scrollLeft;
    });
    if (tabC) tabC.addEventListener('click', function () { showTab('c'); });
    if (tabR) tabR.addEventListener('click', function () { showTab('run'); });

    function run() {
      var src = ta.value;
      var build = LumeVM.build(src, { name: 'play.lume' });
      if (!build.ok) {
        showTab('c');
        cPre.innerHTML = '<span class="err">' + esc(build.message) + '</span>';
        if (statusEl) statusEl.textContent = 'build error';
        return;
      }
      cPre.innerHTML = highlight(build.c, 'c');
      var t0 = (window.performance ? performance.now() : Date.now());
      var res = LumeVM.run(src, { name: 'play.lume' });
      var ms = Math.max(1, Math.round((window.performance ? performance.now() : Date.now()) - t0));
      if (!res.ok) {
        runPre.innerHTML = '<span class="err">' + esc(res.message) + '</span>';
        if (statusEl) statusEl.textContent = 'runtime error · ' + ms + ' ms';
        showTab('run'); return;
      }
      runPre.innerHTML = res.output.length
        ? res.output.map(function (l) { return '<span class="ln">' + esc(l) + '</span>'; }).join('\n')
        : '<span class="dim">ran clean, printed nothing</span>';
      if (statusEl) statusEl.textContent = build.tokens + ' tokens · ' + build.fns + ' fn · ' + ms + ' ms';
      showTab('c');
    }

    if (runBtn) runBtn.addEventListener('click', run);
    if (resetBtn) resetBtn.addEventListener('click', function () {
      ta.value = DEFAULT; paint(); ta.focus();
    });

    paint();
    showTab('c');
    run();
  }

  if (document.readyState === 'loading') document.addEventListener('DOMContentLoaded', init);
  else init();
})();
