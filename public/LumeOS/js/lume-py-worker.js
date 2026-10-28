/* ============================================================
   LumePy worker —— Python 跑在独立线程里
   ============================================================
   为什么要单开线程：Pyodide 里的 CPython 是同步执行的，一旦跑进
   死循环就把主线程整个占住 —— keydown 都进不来，「Ctrl+C 打断」
   根本无从触发。放进 Worker 之后：

     · 主线程照常响应，Ctrl+C 能收到；
     · 收到就 worker.terminate()，真的把程序掐死（不是「标记一下
       等它自己检查」，死循环也停得掉）；
     · 代价是被杀掉的那次运行，全局变量全没了 —— 终端里会明说。

   消息协议
     主线程 → 这里
       { t:'boot', mode:'files', prefix, files:{name:ArrayBuffer} }
       { t:'boot', mode:'local'|'cdn', base }
       { t:'run', id, code }
     这里 → 主线程
       { t:'log', s }            引导过程的进度文字
       { t:'ready' }             运行时可用
       { t:'bootfail', message } 引导失败（主线程换下一条路）
       { t:'out'|'err', id, s }  stdout / stderr（批处理）
       { t:'done', id, value, ms }
       { t:'error', id, message }
   ============================================================ */
'use strict';

var py = null;          /* loadPyodide() 的返回值 */
var reprFn = null;      /* Python 侧算 repr 的小函数，缓存复用 */
var blobUrls = {};      /* 离线模式下 文件名 -> blob URL */

function post(msg) {
  self.postMessage(msg);
}

function say(text) {
  post({ t: 'log', s: String(text) });
}

self.onmessage = function (ev) {
  var m = ev.data || {};
  if (m.t === 'boot') boot(m);
  else if (m.t === 'run') run(m);
};

/* ---------- 引导 ---------- */
function boot(m) {
  try {
    if (m.mode === 'files') bootFromFiles(m);
    else bootFromUrl(m.base || '');
  } catch (e) {
    post({ t: 'bootfail', message: (e && e.message) || String(e) });
  }
}

function settle(p) {
  p.then(function (instance) {
    py = instance;
    post({ t: 'ready' });
  }, function (e) {
    post({ t: 'bootfail', message: (e && e.message) || String(e) });
  });
}

/* vendor 目录或 CDN：文件本来就是按 indexURL 拼出来的，直接 importScripts */
function bootFromUrl(base) {
  say('loading pyodide from ' + base);
  importScripts(base + 'pyodide.js');
  if (typeof self.loadPyodide !== 'function') {
    throw new Error('loadPyodide() missing at ' + base);
  }
  settle(self.loadPyodide({ indexURL: base }));
}

/* 离线：文件在 IndexedDB 里压着，主线程解完 bz2/tar 把字节丢过来，
   这里给每个文件建 blob URL，再用 fetch 拦截把 indexURL 的请求导过去。
   拦截只在引导期间挂 —— 用户代码自己 fetch 别的地址不该被我们碰。 */
function bootFromFiles(m) {
  var files = m.files || {};
  var prefix = m.prefix || '';

  Object.keys(files).forEach(function (name) {
    /* wasm 必须带对的 Content-Type，instantiateStreaming 才肯吃 */
    var type = /\.wasm$/.test(name) ? 'application/wasm'
      : /\.mjs$/.test(name) ? 'text/javascript'
      : /\.json$/.test(name) ? 'application/json'
      : '';
    blobUrls[name] = URL.createObjectURL(
      new Blob([files[name]], type ? { type: type } : {})
    );
  });
  if (!blobUrls['pyodide.js']) throw new Error('pyodide.js missing from archive');

  var origFetch = self.fetch;
  self.fetch = function (input, init) {
    try {
      var u = typeof input === 'string' ? input : (input && input.url) || '';
      if (u.indexOf(prefix) === 0) {
        var name = u.slice(prefix.length).split('?')[0];
        if (blobUrls[name]) return origFetch.call(self, blobUrls[name], init);
      }
    } catch (e) { /* 走上面那条兜底 */ }
    return origFetch.apply(self, arguments);
  };

  say('booting CPython (wasm)…');
  try {
    importScripts(blobUrls['pyodide.js']);
  } catch (e) {
    self.fetch = origFetch;
    throw e;
  }
  if (typeof self.loadPyodide !== 'function') {
    self.fetch = origFetch;
    throw new Error('loadPyodide() missing from archive');
  }
  self.loadPyodide({ indexURL: prefix }).then(function (instance) {
    self.fetch = origFetch;
    py = instance;
    post({ t: 'ready' });
  }, function (e) {
    self.fetch = origFetch;
    post({ t: 'bootfail', message: (e && e.message) || String(e) });
  });
}

/* ---------- 跑代码 ---------- */
function run(m) {
  var id = m.id;
  if (!py) {
    post({ t: 'error', id: id, message: 'python runtime is not ready' });
    return;
  }
  /* batched：pyodide 自己攒行，一次给一段，别一个字一个字跨线程 */
  py.setStdout({ batched: function (s) { post({ t: 'out', id: id, s: String(s) }); } });
  py.setStderr({ batched: function (s) { post({ t: 'err', id: id, s: String(s) }); } });

  var t0 = Date.now();
  py.runPythonAsync(m.code).then(function (v) {
    var shown = '';
    try { shown = repr(v); } catch (e) { shown = ''; }
    post({ t: 'done', id: id, value: shown, ms: Date.now() - t0 });
  }, function (e) {
    post({ t: 'error', id: id, message: (e && e.message) || String(e) });
  });
}

/* 最后一行表达式的值：数字/字符串 pyodide 直接转成 JS，其余是 PyProxy，
   交给 Python 自己的 repr() 算（还能顺手 destroy 掉代理）。 */
function repr(v) {
  if (v === undefined || v === null) return '';
  if (typeof v === 'string') return v;
  if (typeof v === 'number' || typeof v === 'boolean') return String(v);
  try {
    if (!reprFn) {
      reprFn = py.runPython([
        'def __lume_repr(v):',
        '    try:',
        '        return repr(v)',
        '    except Exception:',
        '        return str(v)',
        '__lume_repr'
      ].join('\n'));
    }
    return String(reprFn(v));
  } catch (e) {
    return '';
  } finally {
    if (v && typeof v.destroy === 'function') {
      try { v.destroy(); } catch (e) { /* 已经销毁过就算了 */ }
    }
  }
}
