/* ============================================================
   LumePy —— 把 pyodide-core 引导成可用的 Python 运行时
   ============================================================
   `py setup`（apps.js）把官方 pyodide-core-*.tar.bz2 原样存进
   IndexedDB。本模块负责在 `py run` 时把它变成真的 Python：

     1. 离线路径（首选）：Bunzip 解 bz2 → 解 tar → 每个文件转 Blob URL
        → 动态注入 pyodide.js（UMD）→ fetch shim 把 indexURL 下的
        文件请求映射到 blob → loadPyodide()。
     2. CDN 路径（兜底）：直接 import jsDelivr 的 pyodide.mjs。

   加载顺序：本文件依赖 LumeStore（store.js）；apps.js 依赖本文件。
   ============================================================ */
(function () {
  'use strict';

  var VERSION = '314.0.7';
  var KEY = 'pyodide-core';
  /* 假的 indexURL：pyodide 用 indexURL 拼文件名再 fetch，
     fetch shim 按「这个前缀 + 已知文件名」把请求重定向到 blob。 */
  var FAKE_PREFIX = location.origin + '/LumeOS/__py_blobs__/';
  var CDN = 'https://cdn.jsdelivr.net/pyodide/v' + VERSION + '/full/';

  var instance = null;   /* 已引导好的 pyodide */
  var booting = null;    /* 进行中的引导 Promise，防并发 */

  /* ---------- bz2 解压 + tar 解析 ---------- */
  function decodeArchive(blob) {
    return blob.arrayBuffer().then(function (buf) {
      if (!window.Bunzip) throw new Error('bzip2 decoder not loaded');
      var raw = window.Bunzip.decode(new Uint8Array(buf));
      var u8 = raw instanceof Uint8Array ? raw : new Uint8Array(raw);

      /* ustar/gnu tar：512 字节头。名字优先 GNU LongName（typeflag 'L'），
         其次 ustar prefix + name。 */
      var files = {};
      var off = 0;
      var longName = null;
      while (off + 512 <= u8.length) {
        var hdr = u8.subarray(off, off + 512);
        var allZero = true;
        for (var z = 0; z < 512; z++) if (hdr[z]) { allZero = false; break; }
        if (allZero) break;

        var name = '';
        for (var i = 0; i < 100 && hdr[i]; i++) name += String.fromCharCode(hdr[i]);
        var prefix = '';
        for (var j = 345; j < 500 && hdr[j]; j++) prefix += String.fromCharCode(hdr[j]);
        if (prefix) name = prefix + '/' + name;

        var sizeOct = '';
        for (var k = 124; k < 136; k++) {
          var c = hdr[k];
          if (c >= 48 && c <= 55) sizeOct += String.fromCharCode(c);
        }
        var size = parseInt(sizeOct, 8) || 0;
        var type = String.fromCharCode(hdr[156] || 48);
        var data = u8.subarray(off + 512, off + 512 + size);
        off += 512 + Math.ceil(size / 512) * 512;

        if (type === 'L') {          /* GNU LongName：数据就是下一个条目的真名 */
          longName = '';
          for (var n = 0; n < size && data[n]; n++) longName += String.fromCharCode(data[n]);
          continue;
        }
        if (longName) { name = longName; longName = null; }
        if (type === '0' || type === '\0') files[name.replace(/^pyodide\//, '')] = data;
      }
      return files;
    });
  }

  /* ---------- 从解出的文件引导 pyodide（离线） ---------- */
  function bootOffline(log) {
    if (!window.LumeStore) return Promise.reject(new Error('storage not loaded'));
    return window.LumeStore.get(KEY).then(function (rec) {
      if (!rec || !rec.data) throw new Error('runtime not installed');
      log('unpacking runtime… (pure-js bzip2, takes a few seconds)');
      var text = typeof rec.data.text === 'function' ? rec.data.text() : null;
      var blob = text ? new Blob([text]) : rec.data;
      return decodeArchive(blob).then(function (files) {
        if (!files['pyodide.js']) throw new Error('pyodide.js missing from archive');

        /* 每个文件 -> Blob URL；wasm 要带对 Content-Type，
           instantiateStreaming 才肯吃。 */
        var urls = {};
        Object.keys(files).forEach(function (name) {
          var type = /\.wasm$/.test(name) ? 'application/wasm'
            : /\.mjs$/.test(name) ? 'text/javascript'
            : /\.json$/.test(name) ? 'application/json'
            : '';
          urls[name] = URL.createObjectURL(new Blob([files[name]], type ? { type: type } : {}));
        });

        /* fetch shim：把 FAKE_PREFIX 下的请求重定向到 blob URL。
           只在引导期间生效，loadPyodide resolve 后立刻还原 ——
           运行中的 Python 代码再 fetch 别的地址不该被我们碰。 */
        var origFetch = window.fetch;
        window.fetch = function (input, init) {
          try {
            var u = typeof input === 'string' ? input : (input && input.url) || '';
            if (u.indexOf(FAKE_PREFIX) === 0) {
              var name = u.slice(FAKE_PREFIX.length).split('?')[0];
              if (urls[name]) return origFetch(urls[name], init);
            }
          } catch (e) { /* fallthrough */ }
          return origFetch.apply(window, arguments);
        };

        var restore = function () { window.fetch = origFetch; };
        log('booting CPython (wasm)…');
        return new Promise(function (resolve, reject) {
          var s = document.createElement('script');
          s.src = urls['pyodide.js'];
          s.onload = function () {
            if (!window.loadPyodide) { reject(new Error('loadPyodide missing')); return; }
            window.loadPyodide({ indexURL: FAKE_PREFIX })
              .then(function (py) { restore(); resolve(py); })
              .catch(function (e) { restore(); reject(e); });
          };
          s.onerror = function () { restore(); reject(new Error('failed to load pyodide.js')); };
          document.head.appendChild(s);
        });
      });
    });
  }

  /* ---------- CDN 兜底 ---------- */
  function bootCdn(log) {
    log('offline boot unavailable — trying CDN (' + CDN + ')');
    return import(CDN + 'pyodide.mjs').then(function (mod) {
      return mod.loadPyodide({ indexURL: CDN });
    });
  }

  /* ---------- 对外 ---------- */
  function boot(log) {
    var say = log || function () {};
    if (instance) return Promise.resolve(instance);
    if (booting) return booting;
    booting = bootOffline(say)
      .catch(function (e) {
        say('(offline boot: ' + (e && e.message ? e.message : e) + ')');
        return bootCdn(say);
      })
      .then(function (py) {
        instance = py;
        return py;
      })
      .catch(function (e) {
        booting = null;
        throw e;
      });
    return booting;
  }

  window.LumePy = {
    version: VERSION,
    boot: boot,
    get ready() { return !!instance; }
  };
})();
