/* ============================================================
   LumeBuild — 子版本号 + 本地缓存判定

   要解决的问题：站点每次 push 都重新部署，但浏览器不知道"东西变了"。
   于是每次打开都在纠结要不要重下：下吧，明明没变，浪费时间；
   不下吧，万一变了就还是旧的。

   解法：构建时（scripts/build-version.cjs）把当前 commit 打成
   version.json，前端启动先取它，跟本地 DB 里存的版本比一比：

     · 版本一样 → 词库等大资源直接从 IndexedDB 读 Blob，零网络请求
     · 版本变了 → 照常走网络，下完连版本号一起写回本地

   比的是「版本号 + 资源内容指纹」，不是文件大小——
   大小一样内容不同的情况太常见了。

   依赖加载顺序：必须在 store.js 之后、lume-ime.js 之前。
   ============================================================ */
const LumeBuild = (function () {
  'use strict';

  const URL = 'version.json';
  const DB_KEY = 'build';           // IndexedDB 里存版本记录的那一格
  const LS_SEEN = 'lume.build.seen'; // localStorage 里记"上次见到的版本"，纯做统计

  /* 拿不到 version.json 时的兜底：不缓存、每次都拉，宁可慢别出错 */
  const FALLBACK = {
    version: 'dev',
    commit: 'dev',
    assets: {},
    known: false
  };

  let info = FALLBACK;
  let ready = false;
  let inflight = null;

  /* 真正的判定结果：本地 DB 里的版本是否与当前构建一致 */
  let cached = false;
  /* 本次会话里是否已经把当前版本写进了本地（下完之后才算） */
  let stored = false;
  let prevVersion = '';

  function load() {
    if (inflight) return inflight;
    inflight = fetch(URL, { cache: 'no-cache' })
      .then((r) => (r.ok ? r.json() : null))
      .then((j) => {
        if (j && j.version) {
          info = {
            version: j.version,
            commit: j.commit || '',
            commitAt: j.commitAt || '',
            builtAt: j.builtAt || '',
            assets: j.assets || {},
            known: true
          };
        }
        return compare();
      })
      .catch(() => {
        info = FALLBACK;
        return compare();
      })
      .then(() => {
        ready = true;
        return info;
      });
    return inflight;
  }

  /* 比对本地记录。这里只读不写——写入由 markStored() 在资源落地后做，
     否则会出现"版本记上了但资源没存成"的假缓存。 */
  function compare() {
    if (!info.known || !window.LumeStore) {
      cached = false;
      return Promise.resolve();
    }
    return window.LumeStore.get(DB_KEY)
      .then((rec) => {
        if (!rec || !rec.meta) {
          cached = false;
          return;
        }
        prevVersion = rec.meta.version || '';
        const same = prevVersion === info.version;
        /* 版本号一致还要核指纹：同一 commit 下重新构建（改了别处又发一次）
           也可能让资源变了，指纹对不上就不算命中。
           指纹任一侧缺失时按「不命中」处理——宁可多下一次，不能用错版本。 */
        const pr = rec.meta.fingerprints || {};
        const cu = info.assets || {};
        const fpOk = !!cu.dict && !!pr.dict && pr.dict === cu.dict;
        cached = same && fpOk;
      })
      .catch(() => {
        cached = false;
      });
  }

  /* 资源落地后调用，把当前版本记下来。
     fingerprints 传当前构建的指纹，保证下次比对口径一致。

     注意：这里**不能**把 cached 改成 true。
     cached 的语义是「本次打开时，本地是否已有同版本」，是开场那一刻的快照；
     而 markStored 是在资源下完之后才发生的——那是「现在本地有了」，
     属于 stored，而不是 cached。
     混在一起会出两种错：首次访问写盘后 cached 变 true，
     第三次会话换了版本、下完新词库后也变 true，
     于是 describe()/neofetch 报「命中」——可这一次明明下载了。 */
  function markStored(extra) {
    if (!info.known || !window.LumeStore) return Promise.resolve(false);
    const meta = Object.assign(
      {
        version: info.version,
        commit: info.commit,
        fingerprints: info.assets || {}
      },
      extra || {}
    );
    return window.LumeStore.put(DB_KEY, { version: info.version }, meta)
      .then(() => {
        stored = true;
        try {
          localStorage.setItem(LS_SEEN, info.version);
        } catch (e) { /* 存不下无所谓 */ }
        return true;
      })
      .catch(() => false);
  }

  /* 版本变了就把旧的大资源清掉，别让 DB 无限长胖。
     只清我们自己的键，不碰用户文件。 */
  function gc(keepKeys) {
    if (!window.LumeStore) return Promise.resolve(0);
    const keep = ['build'].concat(keepKeys || []);
    return window.LumeStore.keys()
      .then((keys) => {
        const drop = keys.filter((k) => keep.indexOf(k) < 0);
        return Promise.all(drop.map((k) => window.LumeStore.del(k).catch(() => null))).then(
          () => drop.length
        );
      })
      .catch(() => 0);
  }

  /* 给设置页 / system info 用的一句话描述。
     优先说「本次开幕时怎么回事」，再说事后有没有写盘。 */
  function describe() {
    if (!info.known) return 'build unknown (version.json missing)';
    if (cached) return info.version + '  ·  cached, no download';
    if (prevVersion) return info.version + '  ·  updated from ' + prevVersion;
    if (stored) return info.version + '  ·  fetched, now stored';
    return info.version + '  ·  first load';
  }

  const api = {
    /* 同步拿版本号，未加载完时是 'dev' */
    get version() {
      return info.version;
    },
    get commit() {
      return info.commit;
    },
    get known() {
      return info.known;
    },
    /* 本次打开时本地是否已有同版本资源。
       这是开场快照，load() 完成后再也不会变。
       想知道「现在本地到底有没有」，看 stored。 */
    get cached() {
      return cached;
    },
    /* 本次会话是否已把当前版本写进本地 */
    get stored() {
      return stored;
    },
    get previous() {
      return prevVersion;
    },
    get ready() {
      return ready;
    },
    load,
    markStored,
    gc,
    describe,
    /* 便捷判断：要不要为了这份资源走网络 */
    needs(key) {
      return !(cached && key);
    }
  };

  if (typeof window !== 'undefined') window.LumeBuild = api;

  /* 尽快开跑，不阻塞启动脚本。词库模块会等这个 Promise。 */
  if (typeof window !== 'undefined' && typeof fetch === 'function') {
    api.start = load();
  }

  return api;
})();
