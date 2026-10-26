/* ============================================================
   LumeStore — 浏览器本地的大对象存档（IndexedDB）

   为什么不用 localStorage：
     · 容量上限通常只有 5MB，而且存的是 UTF-16 字符串，
       一个 6.4MB 的 wasm 包塞进去能撑爆配额；
     · 二进制要先 base64 一道（体积 ×1.37），纯属浪费。

   IndexedDB 天生能存 Blob / ArrayBuffer，配额按磁盘剩余算（通常几百 MB 起），
   正好用来放 Python 运行时这种"下过一次就长期用"的东西。

   这一层只管存取，不认识 Python——以后再有别的 WASM 运行时要缓存，
   换一个 store 名就能复用。
   ============================================================ */
const LumeStore = (function () {
  'use strict';

  const DB_NAME = 'lumeos';
  const DB_VERSION = 1;
  const STORE = 'blobs';

  let dbPromise = null;

  function open() {
    if (dbPromise) return dbPromise;
    dbPromise = new Promise((resolve, reject) => {
      if (!window.indexedDB) {
        reject(new Error('this browser has no IndexedDB'));
        return;
      }
      const req = indexedDB.open(DB_NAME, DB_VERSION);
      req.onupgradeneeded = () => {
        const db = req.result;
        if (!db.objectStoreNames.contains(STORE)) db.createObjectStore(STORE);
      };
      req.onsuccess = () => resolve(req.result);
      req.onerror = () => reject(req.error || new Error('indexedDB open failed'));
      req.onblocked = () => reject(new Error('indexedDB blocked by another tab'));
    });
    return dbPromise;
  }

  function tx(mode, fn) {
    return open().then(
      (db) =>
        new Promise((resolve, reject) => {
          const t = db.transaction(STORE, mode);
          const store = t.objectStore(STORE);
          let out;
          try {
            out = fn(store);
          } catch (e) {
            reject(e);
            return;
          }
          t.oncomplete = () => resolve(out);
          t.onerror = () => reject(t.error || new Error('indexedDB tx failed'));
          t.onabort = () => reject(t.error || new Error('indexedDB tx aborted'));
        })
    );
  }

  /* 存一个对象：{ data: Blob|ArrayBuffer|string, meta: {...} }
     meta 里放版本、大小、时间戳这些"不用解包就能看"的信息。 */
  function put(key, data, meta) {
    return tx('readwrite', (store) => {
      store.put({ data: data, meta: meta || {}, at: Date.now() }, key);
    });
  }

  /* 取出来；没有就返回 null（不抛错，调用方好写） */
  function get(key) {
    return open()
      .then(
        (db) =>
          new Promise((resolve, reject) => {
            const t = db.transaction(STORE, 'readonly');
            const req = t.objectStore(STORE).get(key);
            req.onsuccess = () => resolve(req.result || null);
            req.onerror = () => reject(req.error);
          })
      )
      .catch(() => null);
  }

  function del(key) {
    return tx('readwrite', (store) => {
      store.delete(key);
    });
  }

  function keys() {
    return open()
      .then(
        (db) =>
          new Promise((resolve, reject) => {
            const t = db.transaction(STORE, 'readonly');
            const req = t.objectStore(STORE).getAllKeys();
            req.onsuccess = () => resolve(req.result || []);
            req.onerror = () => reject(req.error);
          })
      )
      .catch(() => []);
  }

  /* 用了多少空间。浏览器不一定给，拿不到就返回 null。 */
  function estimate() {
    if (!navigator.storage || !navigator.storage.estimate) return Promise.resolve(null);
    return navigator.storage.estimate().catch(() => null);
  }

  return { put, get, del, keys, estimate, open };
})();

if (typeof window !== 'undefined') window.LumeStore = LumeStore;
