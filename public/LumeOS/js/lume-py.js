/* ============================================================
   LumePy —— 把 pyodide-core 引导成可用的 Python 运行时
   ============================================================
   `py setup`（apps.js）把官方 pyodide-core-*.tar.bz2 原样存进
   IndexedDB。本模块负责在 `py run` 时把它变成真的 Python。

   Python 一律跑在 Worker 里（js/lume-py-worker.js）：
   Pyodide 的 CPython 是同步执行的，占住主线程时连 keydown 都进不来，
   所以「Ctrl+C 打断」只能靠 terminate worker —— 主线程留在外面等，
   这一点决定了架构，不是可有可无的优化。

   引导顺序（能跑起来就算赢，逐条往下试）：
     1. localhost 优先用本地 vendor 目录（/LumeOS/vendor/pyodide/）：
        dev 时不下载、不解压，直接吃磁盘上的文件。
     2. IndexedDB 里存的 tar.bz2：Bunzip 解 bz2 → 解 tar →
        字节丢给 worker → worker 建 blob URL + fetch shim → loadPyodide。
     3. CDN：jsDelivr 的 pyodide.js，最后一条路。

   依赖：store.js（LumeStore）、js/lib/bunzip.js（Bunzip）。
   ============================================================ */
(function () {
  'use strict';

  var VERSION = '314.0.7';
  var KEY = 'pyodide-core';
  var BASE = new URL('./', document.baseURI);
  var WORKER_URL = new URL('js/lume-py-worker.js', BASE).href;
  /* 假的 indexURL：worker 里用 fetch 拦截把这个前缀下的请求导到 blob */
  var FAKE_PREFIX = location.origin + BASE.pathname + '__py_blobs__/';
  var CDN = 'https://cdn.jsdelivr.net/pyodide/v' + VERSION + '/full/';
  var VENDOR = new URL('vendor/pyodide/', BASE).href;
  /* 只有真·本机才算 dev：GitHub Pages 之类的线上域名一律不走 vendor */
  var IS_LOCAL = /^(localhost|127(\.\d+){3}|\[::1\]|0\.0\.0\.0)$/.test(location.hostname);

  var worker = null;
  var ready = false;
  var booting = null;      /* 进行中的引导 Promise，防并发 */
  var bootResolve = null;
  var bootReject = null;
  var active = null;       /* 正在跑的那次 {id, out, err, resolve, reject} */
  var seq = 0;
  var filesCache = null;   /* 解过一次的 tar 内容（ArrayBuffer），重启复用 */
  var source = '';         /* 'vendor' | 'archive' | 'cdn' */
  var log = function () {};
  var vendorMeta;          /* undefined=没探过, null=没有, object=探到了 */

  /* ---------- bz2 解压 + tar 解析（主线程做，只做一次） ---------- */
  function decodeArchive(blob) {
    return blob.arrayBuffer().then(function (buf) {
      if (!window.Bunzip) throw new Error('bzip2 decoder not loaded');
      var raw = window.Bunzip.decode(new Uint8Array(buf));
      var u8 = raw instanceof Uint8Array ? raw : new Uint8Array(raw);

      /* ustar/gnu tar：512 字节头。名字优先 GNU LongName（typeflag 'L'），
         其次 ustar prefix（偏移 345）+ name。 */
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

        if (type === 'L') {          /* GNU LongName：数据是下一条的真名 */
          longName = '';
          for (var n = 0; n < size && data[n]; n++) longName += String.fromCharCode(data[n]);
          continue;
        }
        if (longName) { name = longName; longName = null; }
        /* 存成独立 ArrayBuffer：subarray 是共享底层大 buffer 的，
           直接 transfer 出去会把整包一起搬走 */
        if (type === '0' || type === '\0') files[name.replace(/^pyodide\//, '')] = data.slice().buffer;
      }
      return files;
    });
  }

  /* ---------- worker 生命周期 ---------- */
  function kill(reason) {
    if (worker) {
      try { worker.terminate(); } catch (e) { /* 已经死了 */ }
    }
    worker = null;
    ready = false;
    var rj = bootReject;
    bootResolve = bootReject = null;
    if (rj && reason) rj(reason);
  }

  function handleMsg(ev) {
    var m = ev.data || {};
    switch (m.t) {
      case 'ready':
        if (bootResolve) { var rs = bootResolve; bootResolve = bootReject = null; rs(); }
        break;
      case 'bootfail':
        if (bootReject) {
          var rj = bootReject;
          bootResolve = bootReject = null;
          rj(new Error(m.message || 'boot failed'));
        }
        break;
      case 'log':
        log(m.s);
        break;
      case 'out':
        if (active && active.id === m.id) active.out(m.s);
        break;
      case 'err':
        if (active && active.id === m.id) active.err(m.s);
        break;
      case 'done':
        finish(m, null);
        break;
      case 'error':
        finish(m, new Error(m.message || 'python error'));
        break;
    }
  }

  function finish(m, err) {
    if (!active || active.id !== m.id) return;
    var a = active;
    active = null;
    if (err) a.reject(err);
    else a.resolve({ value: m.value || '', ms: m.ms });
  }

  function withWorker(msg, transfer) {
    kill(new Error('restarting runtime'));
    var w;
    try {
      w = new Worker(WORKER_URL);
    } catch (e) {
      return Promise.reject(e);
    }
    worker = w;
    w.onmessage = handleMsg;
    w.onerror = function (ev) {
      /* 脚本本身加载失败（404 / 语法错）走这里，不 reject 就永远卡住 */
      if (bootReject) {
        var rj = bootReject;
        bootResolve = bootReject = null;
        rj(new Error((ev && (ev.message || ev.filename)) || 'worker failed to start'));
      }
    };
    return new Promise(function (resolve, reject) {
      bootResolve = resolve;
      bootReject = reject;
      try {
        w.postMessage(msg, transfer || []);
      } catch (e) {
        bootResolve = bootReject = null;
        reject(e);
      }
    });
  }

  /* ---------- 三条引导路径 ---------- */
  function tryVendor() {
    log('looking for a local runtime → ' + VENDOR);
    return fetch(VENDOR + 'pyodide.js', { method: 'HEAD', cache: 'no-store' }).then(function (r) {
      if (!r.ok) throw new Error('HTTP ' + r.status);
      log('booting CPython from the local vendor dir…');
      return withWorker({ t: 'boot', mode: 'local', base: VENDOR });
    });
  }

  function tryArchive() {
    if (!window.LumeStore) return Promise.reject(new Error('storage module not loaded'));
    if (filesCache) return bootFiles(filesCache);
    return window.LumeStore.get(KEY).then(function (rec) {
      if (!rec || !rec.data) throw new Error('runtime not installed — run `py setup`');
      log('unpacking runtime… (pure-js bzip2, takes a few seconds)');
      var blob = rec.data instanceof Blob ? rec.data : new Blob([rec.data]);
      return decodeArchive(blob).then(function (files) {
        filesCache = files;
        return bootFiles(files);
      });
    });
  }

  function bootFiles(files) {
    var payload = {};
    var transfer = [];
    Object.keys(files).forEach(function (name) {
      /* 必须复制一份再 transfer：原件留在 filesCache 里，
         这样打断之后重启不用重新解 3.6 秒的 bz2 */
      var copy = files[name].slice(0);
      payload[name] = copy;
      transfer.push(copy);
    });
    log('starting the python worker…');
    return withWorker({ t: 'boot', mode: 'files', prefix: FAKE_PREFIX, files: payload }, transfer);
  }

  function tryCdn() {
    log('falling back to the CDN — ' + CDN);
    return withWorker({ t: 'boot', mode: 'cdn', base: CDN });
  }

  /* ---------- 引导 ---------- */
  function boot(say) {
    if (say) log = say;
    if (ready && worker) return Promise.resolve(api);
    if (booting) return booting;

    /* localhost 先试磁盘上的 vendor 目录：dev 时零下载、零解压 */
    var route = IS_LOCAL
      ? [['vendor', tryVendor], ['archive', tryArchive], ['cdn', tryCdn]]
      : [['archive', tryArchive], ['cdn', tryCdn]];

    var i = 0;
    var fail = [];
    function step() {
      if (i >= route.length) {
        /* 每条路都试过：把原因攒起来一起报，别只丢一句
           「no runtime available」——那对排查没有任何帮助 */
        throw new Error(fail.length ? fail.join(' / ') : 'no python runtime available');
      }
      var item = route[i++];
      return item[1]().then(function () {
        source = item[0];
        return null;
      }, function (e) {
        kill(new Error('restarting runtime'));
        /* Ctrl+C 打断的失败要原样抛上去，不能当成「这条路不通」继续试 */
        if (e && e.interrupted) throw e;
        var why = (e && e.message) || String(e);
        fail.push(item[0] + ': ' + why);
        log('(' + item[0] + ' unavailable: ' + why + ')');
        return step();
      });
    }

    booting = step().then(function () {
      booting = null;
      ready = true;
      return api;
    }, function (e) {
      booting = null;
      ready = false;
      throw e;
    });
    return booting;
  }

  /* ---------- 跑代码 ---------- */
  function run(code, hooks) {
    var h = hooks || {};
    if (active) return Promise.reject(new Error('python is already running'));
    return boot(h.log).then(function () {
      return new Promise(function (resolve, reject) {
        var id = ++seq;
        active = {
          id: id,
          out: h.out || function () {},
          err: h.err || function () {},
          resolve: resolve,
          reject: reject
        };
        try {
          worker.postMessage({ t: 'run', id: id, code: String(code) });
        } catch (e) {
          active = null;
          reject(e);
        }
      });
    });
  }

  /* Ctrl+C：唯一的真打断手段是杀掉 worker。
     主线程从头到尾没被阻塞，所以这一步永远收得到。 */
  function interrupt() {
    if (!active && !booting) return false;
    var e = new Error('KeyboardInterrupt');
    e.interrupted = true;
    var a = active;
    active = null;
    kill(e);                       /* 顺手把还在引导的 promise 一起 reject */
    if (a) a.reject(e);
    /* 后台悄悄重起一个：下次 py run 就不用干等引导了。
       日志先静音 —— 用户按完 ^C 不该再看到一串「unpacking…」。
       下次 run 会把 log 换成自己的，那时才出声。 */
    log = function () {};
    setTimeout(function () {
      if (!active && !ready) boot().catch(function () {});
    }, 200);
    return true;
  }

  /* vendor 目录的版本信息（只用于 py status 显示，缺了不影响运行） */
  function probeVendor() {
    if (!IS_LOCAL) return Promise.resolve(null);
    if (vendorMeta !== undefined) return Promise.resolve(vendorMeta);
    return fetch(VENDOR + '.lume-vendor.json', { cache: 'no-store' })
      .then(function (r) {
        if (!r.ok) throw new Error('HTTP ' + r.status);
        return r.json();
      })
      .then(function (j) { vendorMeta = j || null; return vendorMeta; })
      .catch(function () { vendorMeta = null; return null; });
  }

  var api = {
    version: VERSION,
    boot: boot,
    run: run,
    interrupt: interrupt,
    probeVendor: probeVendor,
    get ready() { return ready && !!worker; },
    get busy() { return !!active || !!booting; },
    get local() { return IS_LOCAL; },
    get source() { return source; },
    get workerUrl() { return WORKER_URL; }
  };

  window.LumePy = api;
})();
