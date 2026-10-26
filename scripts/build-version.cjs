#!/usr/bin/env node
/* ============================================================
   build-version.cjs — 每次 commit 打一个子版本号

   为什么要有这个：
     站点每次 push 都会重新部署，但浏览器并不知道「东西变了」。
     结果就是要么用户永远看旧缓存，要么每次都全量重下。
     这里给每个 commit 生成一个确定的子版本号，前端拿它做比对，
     同版本就跳过下载，变了才拉新的。

   版本号格式    <major>.<minor>.<patch>-<shorthash>
      major.minor 来自 package.json 的 version（手工维护，代表大改动）
      patch       是「这个 minor 下的第几次 commit」，由 git 历史数出来
      shorthash   就是 commit 短哈希，肉眼能对上 git log

   例：package.json 是 1.0.0、git log 到这个 minor 的第 7 个 commit、
       commit 是 0f363ef，那就得到 1.0.7-0f363ef

   产物 public/LumeOS/version.json：
     {
       "version": "1.0.7-0f363ef",
       "commit": "0f363ef",
       "commitAt": "2026-10-26T11:52:03+08:00",
       "builtAt": "2026-10-26T12:04:11+08:00",
       "assets": { "dict": "<sha1 前12位>", "js": "<sha1 前12位>" }
     }

   assets 里放的是内容指纹而不是大小：大小相同的文件内容可能不同，
   指纹才能真判断「要不要重新下载」。

   用法：
     node scripts/build-version.cjs          # 生成
     node scripts/build-version.cjs --print  # 只打印，不写文件
     node scripts/build-version.cjs --check  # 校验现有文件是否与当前 commit 一致
   ============================================================ */
'use strict';

const fs = require('fs');
const path = require('path');
const crypto = require('crypto');
const { execFileSync } = require('child_process');

const ROOT = path.resolve(__dirname, '..');
const OUT = path.join(ROOT, 'public', 'LumeOS', 'version.json');
const LUME = path.join(ROOT, 'public', 'LumeOS');

/* git 在非仓库/CI 环境可能不可用，全部包一层，失败就当没有 */
function git(args) {
  try {
    return execFileSync('git', args, {
      cwd: ROOT,
      encoding: 'utf8',
      stdio: ['ignore', 'pipe', 'ignore']
    }).trim();
  } catch (e) {
    return '';
  }
}

function sha1of(file) {
  try {
    const buf = fs.readFileSync(file);
    return crypto.createHash('sha1').update(buf).digest('hex').slice(0, 12);
  } catch (e) {
    return '';
  }
}

/* 目录下所有文件的指纹：按相对路径排序后把内容串起来再 hash，
   这样「改了哪个文件」都会反映出来，且与读取顺序无关。 */
function dirFingerprint(dir, exts) {
  const files = [];
  (function walk(d) {
    let list;
    try {
      list = fs.readdirSync(d, { withFileTypes: true });
    } catch (e) {
      return;
    }
    list.forEach((it) => {
      const p = path.join(d, it.name);
      if (it.isDirectory()) return walk(p);
      if (exts && !exts.some((x) => it.name.endsWith(x))) return;
      files.push(p);
    });
  })(dir);
  files.sort();
  const h = crypto.createHash('sha1');
  files.forEach((f) => {
    h.update(path.relative(dir, f)).update('\0');
    try {
      h.update(fs.readFileSync(f));
    } catch (e) {
      h.update('?');
    }
    h.update('\0');
  });
  return h.digest('hex').slice(0, 12);
}

function readPkgVersion() {
  try {
    const pkg = JSON.parse(fs.readFileSync(path.join(ROOT, 'package.json'), 'utf8'));
    return String(pkg.version || '1.0.0');
  } catch (e) {
    return '1.0.0';
  }
}

/* 算「当前这个 major.minor 下第几次 commit」。
   用 git log 直接按路径过滤到 LumeOS，避免全站文档改动也顶版本号——
   改 README 不必让用户重下 1MB 词库。 */
function patchOf(majorMinor) {
  const log = git(['log', '--format=%h', '--', 'public/LumeOS']);
  if (!log) return { patch: 0, total: 0 };
  const commits = log.split('\n').filter(Boolean);
  /* git log 是新→旧，反转成旧→新，序号才和「第几次」对得上 */
  commits.reverse();
  return { patch: Math.max(0, commits.length - 1), total: commits.length };
}

function build(opts) {
  const pkgVer = readPkgVersion();
  const parts = pkgVer.split('.');
  const majorMinor = parts.slice(0, 2).join('.') || '1.0';
  const { patch, total } = patchOf(majorMinor);

  const commit = git(['rev-parse', '--short', 'HEAD']) || 'nogit';
  const commitAt = git(['log', '-1', '--format=%cI']) || '';

  const version = `${majorMinor}.${patch}-${commit}`;

  const out = {
    version,
    commit,
    commitAt,
    builtAt: new Date().toISOString(),
    assets: {
      dict: sha1of(path.join(LUME, 'assets', 'ime-dict.txt')),
      css: sha1of(path.join(LUME, 'css', 'styles.css')),
      js: dirFingerprint(path.join(LUME, 'js'), ['.js'])
    },
    /* 给前端看的元信息，systemInfo / settings 里能显示 */
    commits: total,
    majorMinor
  };

  return out;
}

function main() {
  const argv = process.argv.slice(2);
  const info = build();

  if (argv.includes('--check')) {
    let cur = null;
    try {
      cur = JSON.parse(fs.readFileSync(OUT, 'utf8'));
    } catch (e) {
      console.error('[version] missing version.json — run without --check to generate');
      process.exit(1);
    }
    const sameVer = cur.version === info.version;
    const sameAssets =
      cur.assets &&
      cur.assets.dict === info.assets.dict &&
      cur.assets.js === info.assets.js &&
      cur.assets.css === info.assets.css;
    if (!sameVer || !sameAssets) {
      console.error('[version] stale');
      console.error('  file   ' + cur.version + '  dict ' + (cur.assets || {}).dict);
      console.error('  actual ' + info.version + '  dict ' + info.assets.dict);
      process.exit(1);
    }
    console.log('[version] up to date  ' + cur.version);
    return;
  }

  if (argv.includes('--print')) {
    console.log(JSON.stringify(info, null, 2));
    return;
  }

  info.builtAt = new Date().toISOString();
  fs.mkdirSync(path.dirname(OUT), { recursive: true });
  fs.writeFileSync(OUT, JSON.stringify(info, null, 2) + '\n', 'utf8');
  console.log('[version] ' + info.version + '  →  public/LumeOS/version.json');
  console.log('          dict ' + info.assets.dict + '  js ' + info.assets.js + '  css ' + info.assets.css);
}

if (require.main === module) main();

module.exports = { build, OUT };
