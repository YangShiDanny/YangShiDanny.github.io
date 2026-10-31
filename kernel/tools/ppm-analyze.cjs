// 解析 QEMU screendump 出来的 PPM(P6)，把屏幕降采样成 ASCII 网格，
// 并打印 LumeOS 各招牌颜色的命中像素数。这样无需肉眼看图就能判断
// 桌面 / 顶栏 / 图标 / Dock / 光标到底有没有渲染出来。
const fs = require('fs');
const path = require('path');

const f = process.argv[2] || path.join(__dirname, '..', 'target/probe/screen.ppm');
if (!fs.existsSync(f)) { console.log('NO PPM:', f); process.exit(1); }
const buf = fs.readFileSync(f);

// 解析 P6 头：P6\n<w> <h>\n<max>\n<binary...>
let off = 0;
function token() {
  while (off < buf.length && /\s/.test(String.fromCharCode(buf[off]))) off++;
  let s = '';
  while (off < buf.length && !/\s/.test(String.fromCharCode(buf[off]))) { s += String.fromCharCode(buf[off]); off++; }
  return s;
}
const magic = token();
const w = parseInt(token(), 10);
const h = parseInt(token(), 10);
const maxv = parseInt(token(), 10);
// 头后面有一个分隔空白（上面 token 吃掉的是 maxv 后的那个 0x0A）
// 某些实现 maxv 后直接跟二进制，token() 已经跳过前导空白，但数字 token 不会吃结尾的 \n，
// 所以 off 现在指向 maxv 之后的空白字节，需要再跳一格。
while (off < buf.length && /\s/.test(String.fromCharCode(buf[off]))) off++;
console.log(`magic=${magic} w=${w} h=${h} max=${maxv} dataOff=${off} bytes=${buf.length}`);

// 招牌色（和 desktop.rs / vga.rs 同源）
const COLORS = {
  BG:        [12, 12, 16],
  PANEL:     [22, 22, 28],
  TEXT:      [222, 222, 232],
  CYAN:      [70, 200, 200],
  BLUE:      [110, 150, 255],
  YELLOW:    [235, 225, 110],
  GREEN:     [110, 230, 130],
  RED:       [200, 80, 80],
  WHITE:     [245, 245, 250],
};
function near(c, t, tol) {
  return Math.abs(c[0]-t[0])<=tol && Math.abs(c[1]-t[1])<=tol && Math.abs(c[2]-t[2])<=tol;
}
const hits = {}; for (const k in COLORS) hits[k] = 0;

const COLS = 48, ROWS = 27;
const cw = w / COLS, ch = h / ROWS;
let grid = '';
let nonDark = 0;
for (let ry = 0; ry < ROWS; ry++) {
  let line = '';
  for (let cx = 0; cx < COLS; cx++) {
    let sr = 0, sg = 0, sb = 0, n = 0;
    const x0 = Math.floor(cx * cw), x1 = Math.floor((cx+1) * cw);
    const y0 = Math.floor(ry * ch), y1 = Math.floor((ry+1) * ch);
    for (let y = y0; y < y1; y += 2) {
      for (let x = x0; x < x1; x += 2) {
        const i = off + (y * w + x) * 3;
        const r = buf[i], g = buf[i+1], b = buf[i+2];
        sr += r; sg += g; sb += b; n++;
        const c = [r, g, b];
        for (const k in COLORS) if (near(c, COLORS[k], 24)) { hits[k]++; break; }
      }
    }
    const ar = sr/n, ag = sg/n, ab = sb/n;
    const lum = 0.299*ar + 0.587*ag + 0.114*ab;
    if (lum > 120) line += '#';
    else if (lum > 45) { line += '.'; nonDark++; }
    else line += ' ';
  }
  grid += line + '\n';
}
console.log('\n=== ASCII 网格（#=亮 . =中 空格=暗）===');
console.log(grid);
console.log('=== 招牌色命中像素（tol=24）===');
for (const k in hits) console.log(`  ${k.padEnd(7)} ${hits[k]}`);
