/* ============================================================
   LumeGit — 在浏览器里跑真的 git

   底下是 isomorphic-git（vendored 到 js/lib/isomorphic-git.min.js，
   306KB，用到才加载）。我们只负责把一个「文件系统」喂给它。

   为什么 git 的元数据不放在 LumeFS 里：
     · LumeFS 存的是 localStorage 里的 UTF-16 字符串，git 的 object
       是 zlib 压过的二进制，硬塞进去得先 base64（体积 ×1.37），
       而且每次写都要把整棵文件树重新序列化一遍；
     · .git/objects 对用户没有任何意义，塞进文件管理器只是噪音。

   所以：工作区照旧是 LumeFS（Files / Editor / Terminal 都能看见、
   都能改），.git 目录单独放 IndexedDB，按路径原样保存 Uint8Array。
   两边用同一个 path 命名空间（/home/lume/work/.git/...），
   isomorphic-git 完全感知不到区别。
   ============================================================ */

const LumeGit = (function () {
  'use strict';

  const VERSION = '1.27.2';
  const IDB_KEY = 'gitfs';
  const DEFAULT_AUTHOR = { name: 'lume', email: 'lume@lumeos.local' };
  /* 浏览器里 clone/push 要过 CORS，isomorphic-git 官方跑了个公共代理。
     自建仓库时换成自己的。 */
  const CORS_PROXY = 'https://cors.isomorphic-git.org';

  /* lib 目录按当前脚本位置算出来，不依赖站点挂在哪个子路径下
     （dev 是 /LumeOS/，线上可能是 /lume-os/） */
  const BASE = (function () {
    const s = document.currentScript;
    const src = s && s.src ? s.src : location.href;
    return src.replace(/js\/lume-git\.js.*$/, '');
  })();

  /* ---------------- 懒加载 isomorphic-git ---------------- */
  let libPromise = null;
  function libs() {
    if (libPromise) return libPromise;
    /* 页面上已经有（或者测试里预置了）就直接用，别重复注入 */
    if (window.git && window.GitHttp) {
      libPromise = Promise.resolve({ git: window.git, http: window.GitHttp });
      return libPromise;
    }

    const load = (src) =>
      new Promise((resolve, reject) => {
        const el = document.createElement('script');
        el.src = src;
        el.onload = () => resolve();
        el.onerror = () => reject(new Error('cannot load ' + src));
        document.head.appendChild(el);
      });

    libPromise = load(BASE + 'js/lib/isomorphic-git.min.js')
      .then(() => load(BASE + 'js/lib/isomorphic-git-http.min.js'))
      .then(() => {
        if (!window.git) throw new Error('isomorphic-git did not register');
        return { git: window.git, http: window.GitHttp || null };
      })
      .catch((e) => {
        libPromise = null; /* 允许下一次重试 */
        throw e;
      });
    return libPromise;
  }

  /* ---------------- .git 目录的存储 ---------------- */

  /* files: { path: Uint8Array }   dirs: { path: 1 } —— 目录要显式记，
     因为 git 会建空的 refs/heads、info 这类目录，靠子节点推不出来 */
  let tree = null;
  let treePromise = null;
  let dirty = false;
  let flushTimer = null;
  let flushing = Promise.resolve();

  function blankTree() {
    return { files: Object.create(null), dirs: Object.create(null) };
  }

  function ensureTree() {
    if (tree) return Promise.resolve(tree);
    if (treePromise) return treePromise;
    if (!window.LumeStore) {
      tree = blankTree();
      return Promise.resolve(tree);
    }
    treePromise = window.LumeStore.get(IDB_KEY)
      .then((rec) => {
        const d = rec && rec.data;
        tree = d && d.files ? { files: d.files, dirs: d.dirs || Object.create(null) } : blankTree();
        return tree;
      })
      .catch(() => {
        tree = blankTree();
        return tree;
      });
    return treePromise;
  }

  function scheduleFlush() {
    dirty = true;
    if (flushTimer) return;
    /* 一次 commit 会连着写十几个 object，逐次落盘纯属浪费；
       攒到下一轮事件循环再写一次。 */
    flushTimer = setTimeout(() => {
      flushTimer = null;
      flushNow();
    }, 60);
  }

  function flushNow() {
    if (!tree || !dirty || !window.LumeStore) return flushing;
    dirty = false;
    const snapshot = { files: tree.files, dirs: tree.dirs };
    flushing = flushing
      .then(() => window.LumeStore.put(IDB_KEY, snapshot, { kind: 'git' }))
      .catch(() => {
        dirty = true; /* 没写成就留着下次再试 */
      });
    return flushing;
  }

  function flush() {
    if (flushTimer) {
      clearTimeout(flushTimer);
      flushTimer = null;
    }
    return Promise.resolve(flushNow());
  }

  /* 仓库被删掉 / 想重来 */
  function wipe() {
    tree = blankTree();
    treePromise = Promise.resolve(tree);
    dirty = true;
    return flush();
  }

  /* ---------------- FS 适配层 ---------------- */

  const S_IFREG = 0o100000;
  const S_IFDIR = 0o040000;
  const MODE_FILE = S_IFREG | 0o644; /* 33188 */
  const MODE_DIR = S_IFDIR | 0o755; /* 16877 */

  function normPath(p) {
    let s = String(p == null ? '' : p).replace(/\\/g, '/').replace(/\/{2,}/g, '/');
    if (!s.startsWith('/')) s = '/' + s;
    /* isomorphic-git 会把根目录写成 `${dir}/.`，还有些路径带 `..`。
       逐段折叠，不然 lstat('/home/lume/work/.') 会查不到。 */
    const out = [];
    s.split('/').forEach((seg) => {
      if (!seg || seg === '.') return;
      if (seg === '..') {
        out.pop();
        return;
      }
      out.push(seg);
    });
    return '/' + out.join('/');
  }

  /* 只认路径里带 .git 段的走 IndexedDB；工作区文件留给 LumeFS */
  function isGitPath(p) {
    return /(^|\/)\.git(\/|$)/.test(p);
  }

  function enoent(p) {
    const e = new Error('ENOENT: no such file or directory, ' + p);
    e.code = 'ENOENT';
    e.errno = -2;
    e.path = p;
    return e;
  }

  function enotdir(p) {
    const e = new Error('ENOTDIR: not a directory, ' + p);
    e.code = 'ENOTDIR';
    e.path = p;
    return e;
  }

  function statOf(size, kind) {
    const now = Date.now();
    return {
      mode: kind === 'dir' ? MODE_DIR : MODE_FILE,
      mtimeMs: now,
      ctimeMs: now,
      mtime: new Date(now),
      ctime: new Date(now),
      uid: 1,
      gid: 1,
      ino: 1,
      size: size,
      isFile: () => kind !== 'dir',
      isDirectory: () => kind === 'dir',
      isSymbolicLink: () => false
    };
  }

  function childrenOf(files, dirs, path) {
    const prefix = path === '/' ? '/' : path + '/';
    const out = Object.create(null);
    Object.keys(files).forEach((k) => {
      if (!k.startsWith(prefix)) return;
      const rest = k.slice(prefix.length);
      if (!rest || rest.indexOf('/') >= 0) return;
      out[rest] = 1;
    });
    Object.keys(dirs).forEach((k) => {
      if (k === path || !k.startsWith(prefix)) return;
      const rest = k.slice(prefix.length);
      if (!rest || rest.indexOf('/') >= 0) return;
      out[rest] = 1;
    });
    return Object.keys(out);
  }

  /* async: 让 isomorphic-git 的 pify 包装照常工作；
     工作区那边其实是同步的 LumeFS，但统一返回 Promise 更省事 */
  const fs = {
    /* options.encoding 是有意义的：isomorphic-git 读 refs/HEAD 这类小文本时
       传 {encoding:'utf8'} 然后直接 .trim()，必须给字符串；给 Uint8Array
       会在 sha.trim 那里炸掉。不传就按二进制给。 */
    async readFile(path, options) {
      const p = normPath(path);
      const enc = options && options.encoding;
      const wantText = !!enc && enc !== 'binary' && enc !== 'buffer';
      if (isGitPath(p)) {
        const t = await ensureTree();
        const buf = t.files[p];
        if (!buf) throw enoent(p);
        if (wantText) return new TextDecoder('utf-8').decode(buf);
        /* 给一份副本：isomorphic-git 有时候会把拿到的 buffer 直接改掉 */
        return new Uint8Array(buf);
      }
      const text = LumeFS.read(p);
      if (text == null) throw enoent(p);
      return wantText ? text : new TextEncoder().encode(text);
    },

    async writeFile(path, data) {
      const p = normPath(path);
      let bytes = data;
      if (typeof bytes === 'string') bytes = new TextEncoder().encode(bytes);
      if (bytes instanceof ArrayBuffer) bytes = new Uint8Array(bytes);
      if (!isGitPath(p)) {
        /* 工作区只有一个文本层：解码回字符串再写进 LumeFS。
           checkout 出来的源码都是文本，这条路够用；真正的二进制
           工作区文件（图片之类）我们不支持 git 检出，会变成乱码。 */
        const text = new TextDecoder().decode(bytes);
        const segs = p.split('/').filter(Boolean);
        let walk = '';
        for (let i = 0; i < segs.length - 1; i++) {
          walk += '/' + segs[i];
          if (!LumeFS.isDir(walk)) LumeFS.mkdir(walk);
        }
        if (!LumeFS.write(p, text)) throw enoent(p);
        return;
      }
      const t = await ensureTree();
      const buf = new Uint8Array(bytes);
      t.files[p] = buf;
      /* 写文件时把它所有祖先目录补出来，省得 git 忘了 mkdir */
      const segs = p.split('/').filter(Boolean);
      let walk = '';
      for (let i = 0; i < segs.length - 1; i++) {
        walk += '/' + segs[i];
        t.dirs[walk] = 1;
      }
      scheduleFlush();
    },

    async unlink(path) {
      const p = normPath(path);
      if (!isGitPath(p)) {
        if (!LumeFS.remove(p)) throw enoent(p);
        return;
      }
      const t = await ensureTree();
      if (!t.files[p]) throw enoent(p);
      delete t.files[p];
      scheduleFlush();
    },

    async readdir(path) {
      const p = normPath(path);
      if (!isGitPath(p)) {
        if (!LumeFS.isDir(p)) throw enotdir(p);
        return LumeFS.list(p).map((i) => i.name);
      }
      const t = await ensureTree();
      if (!t.dirs[p] && !t.files[p]) throw enoent(p);
      return childrenOf(t.files, t.dirs, p);
    },

    async mkdir(path) {
      const p = normPath(path);
      if (!isGitPath(p)) {
        if (!LumeFS.isDir(p)) LumeFS.mkdir(p);
        return;
      }
      const t = await ensureTree();
      if (t.files[p]) {
        const e = new Error('EEXIST: file already exists, ' + p);
        e.code = 'EEXIST';
        throw e;
      }
      const segs = p.split('/').filter(Boolean);
      let walk = '';
      for (let i = 0; i < segs.length; i++) {
        walk += '/' + segs[i];
        t.dirs[walk] = 1;
      }
      scheduleFlush();
    },

    async rmdir(path) {
      const p = normPath(path);
      if (!isGitPath(p)) {
        LumeFS.remove(p);
        return;
      }
      const t = await ensureTree();
      const prefix = p + '/';
      Object.keys(t.files).forEach((k) => {
        if (k.startsWith(prefix)) delete t.files[k];
      });
      Object.keys(t.dirs).forEach((k) => {
        if (k === p || k.startsWith(prefix)) delete t.dirs[k];
      });
      scheduleFlush();
    },

    async stat(path) {
      const p = normPath(path);
      if (!isGitPath(p)) {
        if (LumeFS.isDir(p)) return statOf(0, 'dir');
        const text = LumeFS.read(p);
        if (text == null) throw enoent(p);
        return statOf(text.length, 'file');
      }
      const t = await ensureTree();
      const buf = t.files[p];
      if (buf) return statOf(buf.byteLength || buf.length || 0, 'file');
      if (t.dirs[p]) return statOf(0, 'dir');
      throw enoent(p);
    },

    async lstat(path) {
      return fs.stat(path);
    },

    async readlink(path) {
      const e = new Error('EINVAL: invalid argument, readlink ' + path);
      e.code = 'EINVAL';
      throw e;
    },

    async symlink() {
      const e = new Error('ENOSYS: symlink not supported');
      e.code = 'ENOSYS';
      throw e;
    },

    async chmod() {
      /* 权限位在浏览器里没有意义，静默成功 */
    },

    async rename(from, to) {
      const a = normPath(from);
      const b = normPath(to);
      if (isGitPath(a) !== isGitPath(b)) {
        const e = new Error('EXDEV: cross-device link not permitted');
        e.code = 'EXDEV';
        throw e;
      }
      if (isGitPath(a)) {
        const t = await ensureTree();
        if (t.files[a]) {
          t.files[b] = t.files[a];
          delete t.files[a];
        } else if (t.dirs[a]) {
          t.dirs[b] = 1;
          delete t.dirs[a];
        } else {
          throw enoent(a);
        }
        scheduleFlush();
        return;
      }
      const text = LumeFS.read(a);
      if (text == null) throw enoent(a);
      LumeFS.write(b, text);
      LumeFS.remove(a);
    }
  };

  /* ---------------- 状态矩阵翻译 ---------------- */

  /* statusMatrix 一行是 [filepath, head, workdir, stage]，官方语义（v1.27）：
       head   0=不在 HEAD  1=和 HEAD 一样  2=和 HEAD 不同
       work   0=工作区没有  1=和 HEAD 一样  2=和 HEAD 不同
       stage  0=暂存区没有  1=和 HEAD 一样  2=和工作区一样  3=和工作区不同
     注意 stage 的 2/3 是「相对工作区」而不是相对 HEAD —— 这点很容易搞错：
     暂存之后 stage=2 表示索引已经吃下当前内容（干净的 "M "），
     而不是「还有没暂存的改动」。 */
  function classify(row) {
    const head = row[1];
    const work = row[2];
    const stage = row[3];
    if (head === 0 && work === 0 && stage === 0) return null;

    /* 新文件 */
    if (head === 0) {
      if (work === 0) {
        if (stage === 0) return null;
        return { x: 'A', y: 'D' }; /* 加过又删了 */
      }
      if (stage === 0) return { x: '?', y: '?' }; /* 未跟踪 */
      if (stage === 2) return { x: 'A', y: ' ' }; /* 已暂存 */
      return { x: 'A', y: 'M' }; /* 暂存后又改 */
    }

    /* HEAD 里有，但工作区没了 */
    if (work === 0) {
      return stage === 0 ? { x: 'D', y: ' ' } : { x: ' ', y: 'D' };
    }

    /* HEAD 里有，工作区也有 */
    if (stage === 0) return { x: 'D', y: 'M' }; /* 从索引里拿掉了，工作区还留着 */
    if (stage === 2) return { x: 'M', y: ' ' }; /* 内容已在索引里 */
    if (stage === 3) return { x: 'M', y: 'M' }; /* 暂存之后又动了 */
    return work === 2 ? { x: ' ', y: 'M' } : null; /* stage=1，看工作区 */
  }

  async function statusMatrix(dir) {
    const { git } = await libs();
    return git.statusMatrix({ fs, dir: normPath(dir) });
  }

  async function status(dir) {
    const d = normPath(dir);
    await needRepo(d);
    const rows = await statusMatrix(d);
    const out = [];
    rows.forEach((row) => {
      const c = classify(row);
      if (!c) return;
      out.push({ path: row[0], x: c.x, y: c.y, staged: c.x !== ' ' && c.x !== '?', untracked: c.x === '?' });
    });
    return out;
  }

  /* ---------------- 常用操作 ---------------- */

  async function init(dir, opts) {
    const { git } = await libs();
    await git.init(Object.assign({ fs, dir: normPath(dir), defaultBranch: 'main' }, opts || {}));
    return flush();
  }

  async function isRepo(dir) {
    const d = normPath(dir);
    try {
      const st = await fs.stat(d + '/.git/HEAD');
      return !!st;
    } catch (e) {
      return false;
    }
  }

  /* 没有 .git/HEAD 就说明还没 init —— 大多数命令前先确认一下，
     报错比「isomorphic-git 内部抛了个看不懂的 ENOENT」友好得多 */
  async function needRepo(dir) {
    if (!(await isRepo(dir))) {
      const e = new Error('not a git repository: ' + normPath(dir));
      e.code = 'ENOREPO';
      throw e;
    }
  }

  async function add(dir, paths) {
    const d = normPath(dir);
    await needRepo(d);
    const { git } = await libs();
    let list = paths;
    if (!list || !list.length) {
      const rows = await statusMatrix(d);
      list = rows.filter((r) => classify(r)).map((r) => r[0]);
    }
    for (const f of list) {
      const full = normPath(d + '/' + f.replace(/^\/+/, ''));
      const exists = LumeFS.exists(full);
      if (exists) await git.add({ fs, dir: d, filepath: f });
      else await git.remove({ fs, dir: d, filepath: f });
    }
    return flush();
  }

  async function commit(dir, message, author) {
    const d = normPath(dir);
    await needRepo(d);
    const { git } = await libs();
    const sha = await git.commit({
      fs,
      dir: d,
      message: message || 'update',
      author: author || DEFAULT_AUTHOR
    });
    await flush();
    return sha;
  }

  async function log(dir, depth) {
    const d = normPath(dir);
    await needRepo(d);
    const { git } = await libs();
    return git.log({ fs, dir: d, depth: depth || 20 });
  }

  async function currentBranch(dir) {
    const d = normPath(dir);
    await needRepo(d);
    const { git } = await libs();
    try {
      return await git.currentBranch({ fs, dir: d, fullname: false });
    } catch (e) {
      return null;
    }
  }

  async function branches(dir) {
    const { git } = await libs();
    return git.listBranches({ fs, dir: normPath(dir) });
  }

  async function createBranch(dir, name, checkout) {
    const d = normPath(dir);
    await needRepo(d);
    const { git } = await libs();
    await git.branch({ fs, dir: d, ref: name, checkout: !!checkout });
    return flush();
  }

  async function checkout(dir, ref) {
    const d = normPath(dir);
    await needRepo(d);
    const { git } = await libs();
    await git.checkout({ fs, dir: d, ref });
    return flush();
  }

  async function clone(dir, url, opts) {
    const d = normPath(dir);
    const { git, http } = await libs();
    if (!http) throw new Error('git http client not loaded');
    const p = Object.assign(
      {
        fs,
        http,
        dir: d,
        url: url,
        corsProxy: CORS_PROXY,
        singleBranch: false,
        depth: 1
      },
      opts || {}
    );
    await git.clone(p);
    await flush();
  }

  async function fetchRemote(dir, opts) {
    const d = normPath(dir);
    await needRepo(d);
    const { git, http } = await libs();
    await git.fetch(Object.assign({ fs, http, dir: d, corsProxy: CORS_PROXY, singleBranch: false }, opts || {}));
    return flush();
  }

  async function pull(dir, opts) {
    const d = normPath(dir);
    await needRepo(d);
    const { git, http } = await libs();
    await git.pull(
      Object.assign({ fs, http, dir: d, corsProxy: CORS_PROXY, author: DEFAULT_AUTHOR }, opts || {})
    );
    return flush();
  }

  async function push(dir, opts) {
    const d = normPath(dir);
    await needRepo(d);
    const { git, http } = await libs();
    await git.push(Object.assign({ fs, http, dir: d, corsProxy: CORS_PROXY }, opts || {}));
    return flush();
  }

  async function remotes(dir) {
    const { git } = await libs();
    return git.listRemotes({ fs, dir: normPath(dir) });
  }

  return {
    version: VERSION,
    libs,
    fs,
    status,
    statusMatrix,
    classify,
    init,
    isRepo,
    add,
    commit,
    log,
    currentBranch,
    branches,
    createBranch,
    checkout,
    clone,
    fetch: fetchRemote,
    pull,
    push,
    remotes,
    flush,
    wipe,
    DEFAULT_AUTHOR,
    CORS_PROXY
  };
})();

if (typeof window !== 'undefined') window.LumeGit = LumeGit;
