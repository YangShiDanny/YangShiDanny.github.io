#!/usr/bin/env node
/* ============================================================
   把官方 pyodide-core-*.tar.bz2 解成 public/LumeOS/vendor/pyodide/ 目录
   ============================================================
   本地开发时 LumeOS 会优先吃这个目录里的文件（见 js/lume-py.js 的
   tryVendor），好处是 localhost 上 `py run` 既不下载 6.4MB、也不用
   每次解 3.6 秒的 bz2 —— Python 直接从磁盘起来。

   用法：
     node scripts/pyodide-vendor.cjs <pyodide-core-*.tar.bz2>

   bz2 解码器直接复用浏览器端那份（public/LumeOS/js/lib/bunzip.js），
   免得为了一个脚本再往 package.json 里塞依赖。

   产物目录在 .gitignore 里（13MB 的二进制不该进仓库），所以 CI 里
   根本不会生成它，线上照旧走 IndexedDB（py setup）或者 CDN。
   ============================================================ */
'use strict';

const fs = require('fs');
const path = require('path');
const vm = require('vm');

const ROOT = path.join(__dirname, '..');
/* 必须落在 public/LumeOS/vendor/pyodide —— lume-py.js 探测的是
   <LumeOS 基路径>vendor/pyodide/pyodide.js，只有 public 下的东西会被
   dev server 和构建当静态资源端出来。放在仓库根的 vendor/ 是够不着的
   （之前就栽在这：文件在、探不到、每次都退回 CDN）。 */
const OUT = path.join(ROOT, 'public', 'LumeOS', 'vendor', 'pyodide');
const BUNZIP = path.join(ROOT, 'public', 'LumeOS', 'js', 'lib', 'bunzip.js');

function die(msg) {
  console.error('[pyodide-vendor] ' + msg);
  process.exit(1);
}

const src = process.argv[2];
if (!src) die('usage: node scripts/pyodide-vendor.cjs <pyodide-core-*.tar.bz2>');
if (!fs.existsSync(src)) die('no such file: ' + src);
if (!fs.existsSync(BUNZIP)) die('missing decoder: ' + BUNZIP);

/* bunzip.js 是浏览器 IIFE，挂到 window 上；这里给个假的 window 当宿主 */
const sandbox = { window: {}, console };
vm.createContext(sandbox);
vm.runInContext(fs.readFileSync(BUNZIP, 'utf8'), sandbox, { filename: 'bunzip.js' });
const Bunzip = sandbox.window.Bunzip;
if (!Bunzip || typeof Bunzip.decode !== 'function') die('bunzip.js did not expose Bunzip.decode');

console.log('[pyodide-vendor] decoding ' + path.basename(src) + ' (' + (fs.statSync(src).size / 1048576).toFixed(1) + ' MB)…');
const t0 = Date.now();
let u8;
try {
  const raw = Bunzip.decode(new Uint8Array(fs.readFileSync(src)));
  u8 = raw instanceof Uint8Array ? raw : new Uint8Array(raw);
} catch (e) {
  die('bzip2 decode failed: ' + (e && e.message ? e.message : e));
}
console.log('[pyodide-vendor] bz2 → ' + (u8.length / 1048576).toFixed(1) + ' MB in ' + (Date.now() - t0) + ' ms');

/* ---------- tar 解析（跟 lume-py.js 里那份逐行对齐） ---------- */
function parseTar(u8) {
  const files = {};
  let off = 0;
  let longName = null;
  while (off + 512 <= u8.length) {
    const hdr = u8.subarray(off, off + 512);
    let allZero = true;
    for (let z = 0; z < 512; z++) if (hdr[z]) { allZero = false; break; }
    if (allZero) break;

    let name = '';
    for (let i = 0; i < 100 && hdr[i]; i++) name += String.fromCharCode(hdr[i]);
    let prefix = '';
    for (let j = 345; j < 500 && hdr[j]; j++) prefix += String.fromCharCode(hdr[j]);
    if (prefix) name = prefix + '/' + name;

    let sizeOct = '';
    for (let k = 124; k < 136; k++) {
      const c = hdr[k];
      if (c >= 48 && c <= 55) sizeOct += String.fromCharCode(c);
    }
    const size = parseInt(sizeOct, 8) || 0;
    const type = String.fromCharCode(hdr[156] || 48);
    const data = u8.subarray(off + 512, off + 512 + size);
    off += 512 + Math.ceil(size / 512) * 512;

    if (type === 'L') {
      longName = '';
      for (let n = 0; n < size && data[n]; n++) longName += String.fromCharCode(data[n]);
      continue;
    }
    if (longName) { name = longName; longName = null; }
    if (type === '0' || type === '\0') files[name.replace(/^pyodide\//, '')] = data;
  }
  return files;
}

const files = parseTar(u8);
const names = Object.keys(files);
if (!names.length) die('tar contained no files (not a pyodide-core archive?)');
if (!files['pyodide.js']) die('archive has no pyodide.js — wrong package?');

fs.mkdirSync(OUT, { recursive: true });
let total = 0;
for (const name of names) {
  /* 只收平铺文件；带路径的（以及任何想往上爬的名字）一律丢 */
  if (name.includes('/') || name.includes('..') || name.startsWith('.')) {
    console.log('[pyodide-vendor] skip ' + name);
    continue;
  }
  const dest = path.join(OUT, name);
  fs.writeFileSync(dest, files[name]);
  total += files[name].length;
  console.log('  ' + String((files[name].length / 1048576).toFixed(2)).padStart(6) + ' MB  ' + name);
}

/* 版本号：先看包内的 package.json / pyodide-lock.json（最准），
   文件名只是个兜底 —— 有的人手上是 pyodide-core.tar.bz2 这种不带号的。 */
function versionOf() {
  const read = (name) => {
    if (!files[name]) return null;
    try {
      return JSON.parse(Buffer.from(files[name]).toString('utf8'));
    } catch (e) {
      return null;
    }
  };
  const pkg = read('package.json');
  if (pkg && pkg.version) return String(pkg.version);
  const lock = read('pyodide-lock.json');
  if (lock && lock.info && lock.info.version) return String(lock.info.version);
  const m = path.basename(src).match(/pyodide-core-([0-9A-Za-z.\-]+)\.tar\.bz2$/);
  return m ? m[1] : 'unknown';
}

const meta = {
  version: versionOf(),
  files: names.length,
  bytes: total,
  at: new Date().toISOString()
};
fs.writeFileSync(path.join(OUT, '.lume-vendor.json'), JSON.stringify(meta, null, 2) + '\n');

console.log('[pyodide-vendor] wrote ' + names.length + ' files, ' + (total / 1048576).toFixed(1) + ' MB → ' + path.relative(ROOT, OUT));
console.log('[pyodide-vendor] version ' + meta.version + ' · localhost 上 `py run` 现在不需要 py setup');
