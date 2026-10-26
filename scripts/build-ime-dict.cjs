#!/usr/bin/env node
/* ============================================================
   ime-dict.json  →  ime-dict.txt（紧凑制表文本）

   为什么要换：原来 1.32MB JSON 一加载就要 JSON.parse ~50ms，
   加载完还要扫全库建简拼索引 ~143ms，近 200ms 全堵在启动上。

   新格式把「按拼音聚合 + 词频排序 + 截断」都挪到构建期，运行时：
     · 一次 split('\n') 拿到全部行（约 27ms，只做一次）
     · 真正用到的只是"某个前缀命中的几行"，按需解析（0.05–8ms）
     · 简拼索引不再需要：文件里已按拼音字典序排好，
       简拼直接拿首字母串去逐行比对前缀即可

   格式：每行  <拼音>\t<词>:<频>,<词>:<频>,...
         · 拼音字典序排列，二分查找靠它
         · 词按词频降序，第一位就是首选
         · 每个拼音最多留 TRUNC 个词（够翻几页了）
         · 词频已开方压缩（省位数，排序不变），运行时用不到精确值
   ============================================================ */
const fs = require('fs');
const path = require('path');

const ROOT = path.join(__dirname, '..');
/* 源数据放在 scripts/data/ 而不是 public/ —— 它只是构建输入，
   犯不着跟着站点一起发出去（1.35MB 的迁移成本不值当）。 */
const SRC = path.join(ROOT, 'scripts/data/ime-dict.json');
const OUT = path.join(ROOT, 'public/LumeOS/assets/ime-dict.txt');

const TRUNC = 12;        // 每个拼音最多保留多少词（一页 9 个，够翻页）
const MAX_SYLLABLE = 6;
/* 桶的最低词频门槛：词库里 3.5 万个拼音里 3.1 万个只有 1 个极冷僻词
   （比如 zhuangzhuangzhuang 这种），只保留"这个拼音下最好的词够常用"的桶。

   门槛定在 1 万是有实测依据的（.workbuddy/tmp/ime-threshold.cjs）：
     门槛    拼音桶   体积
     50000   19126    0.44MB   ← 拽/虐/撇/揣/戳/剖/谬 全部打不出
     30000   29384    0.67MB   拽/虐/撇 回来了，揣/戳/剖/谬 仍缺
     10000   35069    0.80MB   七个全回           ← 选这里
     1       35084    0.80MB   再降几乎无变化
   1 万往下就撞到"所有含单字词的拼音"这个天花板（35069/35084），
   意味着剩下 15 个桶连一个单字都没有，纯粹是长尾词组，不要也罢。
   一个常用字打不出来比多 0.35MB 难受得多。 */
const MIN_BEST_FREQ = 10000;

const rows = JSON.parse(fs.readFileSync(SRC, 'utf8'));
if (!Array.isArray(rows) || !rows.length) throw new Error('词库为空或格式不对');

/* 1. 按拼音聚合，同一个词只留最高频那次 */
const buckets = new Map();
for (const [key, word, freq] of rows) {
  let arr = buckets.get(key);
  if (!arr) { arr = new Map(); buckets.set(key, arr); }
  const prev = arr.get(word);
  if (prev === undefined || prev < freq) arr.set(word, freq);
}

/* 1b. 丢掉长尾桶：这个拼音下最好的词都不够常用，就整桶不要 */
let dropped = 0;
for (const [key, arr] of buckets) {
  let best = 0;
  for (const f of arr.values()) if (f > best) best = f;
  if (best < MIN_BEST_FREQ) { buckets.delete(key); dropped++; }
}

/* 2. 音节表：单字条目的 key 必然是完整音节。
   注意要用**截断前**的原始数据，否则冷僻单字被裁掉后音节表会缺项，
   整句切分就可能切不出正确的音节边界。 */
const syl = new Set();
for (const r of rows) if (r[1].length === 1) syl.add(r[0]);

/* 把拼音串切成音节，供首字母提取和音节计数共用。
   返回 null 表示切不开（不是合法拼音串）。 */
function splitSyllables(key) {
  const out = [];
  let i = 0;
  while (i < key.length) {
    let hit = '';
    for (let n = Math.min(MAX_SYLLABLE, key.length - i); n >= 1; n--) {
      const seg = key.substr(i, n);
      if (syl.has(seg)) { hit = seg; break; }
    }
    if (!hit) return null;
    out.push(hit);
    i += hit.length;
  }
  return out;
}

function initialsOf(key) {
  const segs = splitSyllables(key);
  if (!segs) return '';
  return segs.map((s) => s[0]).join('');
}

function sylCountOf(key) {
  const segs = splitSyllables(key);
  return segs ? segs.length : 0;
}

/* 3. 生成正文行 */
const keys = [...buckets.keys()].sort();   // 字典序，二进制对应的二分靠它
const lines = [];
let keptWords = 0;

for (const key of keys) {
  const words = [...buckets.get(key).entries()]
    .sort((a, b) => b[1] - a[1])           // 词频降序
    .slice(0, TRUNC);
  keptWords += words.length;
  /* 词频只留对数档位（log10 后乘 10 取整）：几十万和几百亿压成 2 位数字，
     同档的词共用同一串字符，gzip 才有得压。排序不变，精确值本来也用不到。 */
  lines.push(key + '\t' + words.map(([w, f]) => w + ':' + packFreq(f)).join(','));
}

function packFreq(f) {
  return f <= 0 ? 0 : Math.max(1, Math.round(Math.log10(1 + f) * 10));
}

/* 4. 简拼表：另起一段，运行时只加载一次、按键时二分。
   每个拼音桶的 key 切出来的首字母串就是它的"简拼"，
   所以 nihao 桶 → nh，该桶里的词（你好 等）就挂到 nh 下。

   这里必须承认一件事：**简拼的首选无法由数据推导出来**。
   以 nh 为例，词库里有 21 个桶的首字母串都是 nh——
   nvhai/nihui/nanhai/ninhao/neihan/nihai/nihao/nianhou/nonghu/...
   "你好"的原始词频只有 33 万，排在"女孩"(50万)、"你会"(45万)、
   "男孩"(41万)、"您好"(37万) 之后，语料频次上它就进不了前三。
   这不是算法缺陷，而是"nh 到底该出什么"本身就是领域习惯问题，
   任何纯词频模型都给不出答案（真人输入法靠的是短语表）。

   所以下面分成两步：
     · 先按词频铺一层通用的简拼候选（覆盖绝大多数串）
     · 再对少数高频短语做人工置顶，把它们压到该串的第一位

   第二步的收益远大于成本：25 个词条就能覆盖日常最高频的简拼意图。 */
const iniBuckets = new Map();
function addIni(ini, word, freq) {
  if (!ini || ini.length < 2 || ini.length > 10) return;
  let b = iniBuckets.get(ini);
  if (!b) { b = new Map(); iniBuckets.set(ini, b); }
  const prev = b.get(word);
  if (prev === undefined || prev < freq) b.set(word, freq);
}

/* 通用层：每个桶取前几个词，按首字母串归并。
   散字组合（词长 != 音节数）降权，因为它们只是首字母撞串，不是用户本意。

   简拼这边要额外卡一道词频门槛：主词库放宽到 1 万是为了让"拽/虐/撇/剖/谬"
   这些字能直接打出来（全拼走的是 cached(key)，只读主词库）。
   但简拼不需要这么宽——它本来就服务于高频短语，把 4 万条长尾词全挂上去
   只会让简拼段从 0.33MB 里塞进 1.1 万个几乎没人会用的串。
   实测门槛 5 万时简拼段 5820 桶 / 0.11MB，不卡则 11583 桶 / 0.33MB。 */
const INI_MIN_WORD_FREQ = 50000;
const MISALIGN_DIV = 20;
let iniWords = 0;
for (const [key, arr] of buckets) {
  if (key.length < 2) continue;
  const ini = initialsOf(key);
  if (!ini || ini === key) continue;      // 单音节（ni → ni）不算简拼
  const n = sylCountOf(key);
  for (const [w, f] of arr) {
    if (f < INI_MIN_WORD_FREQ) continue;
    addIni(ini, w, w.length === n ? f : Math.round(f / MISALIGN_DIV));
    iniWords++;
  }
}

/* 人工置顶：简拼串 → 首选词（数组顺序即优先级，第 0 位是该串的首选）。
   收录标准：日常输入里高频、且纯词频算下来排不进该串首位的短语。
   像「我们」「这个」「时间」这类词频本来就够高的，不需要写在这里。 */
const INI_PIN = {
  nh: ['你好'],
  xx: ['谢谢', '信息', '学校'],
  zj: ['自己', '再见'],
  bz: ['帮助', '不知道'],
  sm: ['什么'],
  zm: ['怎么', '这么'],
  ws: ['为什么', '晚上'],
  my: ['没有', '明天'],
  hy: ['还有', '行业'],
  hh: ['哈哈', '呵呵'],
  mm: ['妈妈', '妹妹'],
  bb: ['爸爸'],
  gg: ['哥哥', '刚刚'],
  jj: ['姐姐', '经济'],
  yy: ['永远', '爷爷'],
  rz: ['然后'],
  zs: ['再说', '早上'],
  mb: ['明白', '目标'],
  kx: ['开心'],
  xy: ['需要', '喜欢'],
  bkc: ['不客气'],
  dbq: ['对不起'],
  zmy: ['怎么样'],
  shd: ['好的'],
  xd: ['谢谢', '兄弟'],
};

/* 人工置顶的权重必须显著高于任何自然词频（对数压缩后最高约 3 位数字），
   这里用一个远超自然值的大数 + 按列表位次递减，保证顺序稳定。 */
const PIN_BASE = 1e9;
for (const [ini, words] of Object.entries(INI_PIN)) {
  words.forEach((w, i) => addIni(ini, w, PIN_BASE - i));
}

const iniKeys = [...iniBuckets.keys()].sort();
const iniLines = iniKeys.map((ini) => {
  const ws = [...iniBuckets.get(ini).entries()].sort((a, b) => b[1] - a[1]).slice(0, 12);
  return ini + '\t' + ws.map(([w, f]) => w + ':' + packFreq(f)).join(',');
});

const body = lines.join('\n');
const iniBody = iniLines.join('\n');

/* 单文件两段，空行分隔：前半是主词库，后半是简拼表。
   一次 fetch 拿全，运行时按空行切一刀就分开了。

   魔数行后面再挂一行音节表：整句切分靠它，而它**不能跟着词库一起裁**。
   test/ime 里实测裁掉长尾桶会让 23 个音节消失（weng 翁 / zhuai 拽 /
   pie 撇 / nve 虐 / chuo 戳 …），这些字本身不算生僻，一旦切不出音节，
   "biequ" 这类整句候选就会直接断掉。所以音节表从裁前的原始数据取全，
   单列一行交给运行时，代价只有几百字节。 */
const sylList = [...syl].sort().join(' ');
const file = '#LUMEIME1\n' + sylList + '\n' + body + '\n\n' + iniBody;
fs.writeFileSync(OUT, file);

const zlib = require('zlib');
const gz = (s) => (zlib.gzipSync(Buffer.from(s), { level: 9 }).length / 1024).toFixed(0) + 'KB';

console.log('拼音桶     ', keys.length, '（裁掉长尾 ' + dropped + '）');
console.log('保留词数   ', keptWords, '/ 原', rows.length);
console.log('音节数     ', syl.size);
console.log('简拼桶     ', iniKeys.length);
console.log('');
console.log('ime-dict.txt  ', (Buffer.byteLength(file) / 1048576).toFixed(2) + 'MB', ' gzip', gz(file));
console.log('（原 ime-dict.json 1.32MB  gzip 499KB）');
