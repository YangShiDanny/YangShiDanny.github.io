// QEMU 冒烟测试：启动 lumeos.img，抓串口 + 截屏，可选注入按键。
// 用法：node kernel/tools/qemu-probe.cjs [秒数] [按键串]
//   按键串里 \n 表示回车，\\t 表示 Tab —— QEMU sendkey 用 ret / tab 名字。
const { spawn } = require('child_process');
const fs = require('fs');
const path = require('path');
const net = require('net');

const ROOT = path.resolve(__dirname, '..');
const IMG = path.join(ROOT, 'target/images/lumeos.img');
const OUT = path.join(ROOT, 'target/probe');
fs.mkdirSync(OUT, { recursive: true });

const secs = Number(process.argv[2] || 10);
// 把字面转义 \n / \t 还原成真正的回车 / Tab —— 这样 shell 里传 'help\nvga\n'
// （单引号不会解释反斜杠）也能正确注入回车。
const keys = (process.argv[3] || '').replace(/\\n/g, '\n').replace(/\\t/g, '\t');
// 第 4 个参数：逗号分隔的「整键」qcode（如 esc / ret / tab），不经过逐字符映射，
// 适合发 Escape 这种没有字面字符的键。
const specials = (process.argv[4] || '').split(',').map(s => s.trim()).filter(Boolean);
const sock = path.join(OUT, 'qmp.sock');
const serialLog = path.join(OUT, 'serial.log');
const shot = path.join(OUT, 'screen.ppm');
for (const f of [sock, serialLog, shot]) { try { fs.unlinkSync(f); } catch {} }

const qemu = spawn('qemu-system-x86_64', [
  '-drive', `format=raw,file=${IMG}`,
  '-m', '128M',
  '-display', 'none',
  '-no-reboot',
  // -vga std 让显卡走标准 VGA 兼容模式，0xB8000 才是真正的 80×25 文字缓冲。
  // 默认的 Cirrus/QXL 只有 framebuffer，文字模式的显存轮不到它。
  '-vga', 'std',
  '-serial', `file:${serialLog}`,
  '-qmp', `unix:${sock},server,nowait`,
], { stdio: 'ignore', detached: true });

// QEMU 的键名表：只覆盖测试里用得到的
const KEYMAP = {
  ' ': 'spc', '\n': 'ret', '\t': 'tab', '-': 'minus', '.': 'dot', '/': 'slash',
};

function keyName(ch) {
  if (KEYMAP[ch]) return KEYMAP[ch];
  if (/[a-z0-9]/.test(ch)) return ch;
  if (/[A-Z]/.test(ch)) return 'shift-' + ch.toLowerCase();
  return null;
}

function connect() {
  return new Promise((res, rej) => {
    const s = net.createConnection(sock);
    s.once('connect', () => res(s));
    s.once('error', rej);
  });
}

let buf = '';
function send(s, obj) { s.write(JSON.stringify(obj) + '\r\n'); }

(async () => {
  let s;
  for (let i = 0; i < 40; i++) {
    try { s = await connect(); break; } catch { await new Promise(r => setTimeout(r, 250)); }
  }
  if (!s) { console.log('QMP 连不上'); process.exit(1); }
  s.on('data', d => { buf += d.toString(); });
  const waitFor = (needle, ms = 8000) => new Promise(r => {
    const t0 = Date.now();
    const iv = setInterval(() => {
      if (buf.includes(needle) || Date.now() - t0 > ms) { clearInterval(iv); r(buf.includes(needle)); }
    }, 80);
  });

  await waitFor('"QMP"');
  send(s, { execute: 'qmp_capabilities' });
  await new Promise(r => setTimeout(r, 300));

  await new Promise(r => setTimeout(r, secs * 1000));

  // 注入按键
  for (const ch of keys) {
    const k = keyName(ch);
    if (!k) continue;
    send(s, { execute: 'send-key', arguments: { keys: [{ type: 'qcode', data: k }] } });
    await new Promise(r => setTimeout(r, 250));
  }
  if (keys) await new Promise(r => setTimeout(r, 900));

  // 注入整键（如 esc）：一个 qcode 一次 send-key
  for (const sp of specials) {
    send(s, { execute: 'send-key', arguments: { keys: [{ type: 'qcode', data: sp }] } });
    await new Promise(r => setTimeout(r, 250));
  }
  if (specials.length) await new Promise(r => setTimeout(r, 900));

  // 鼠标：第 5 个参数。
  //   "X,Y"      —— 移到 (X,Y) 再点一下左键（点击）
  //   "move:X,Y" —— 只移到 (X,Y)，不点击（用来隔离「移动」和「点击」哪个出问题）
  // PS/2 鼠标只收「相对位移」并累加到驱动坐标；驱动坐标开机就被设在屏幕中心
  // (640,360)，且每次 QEMU 都是全新启动，所以发相对位移 (X-640, Y-360) 就能
  // 精确落到 (X,Y)。千万别发超大位移当「归零」——那会让 QEMU 吐出畸形包把渲染搞花。
  const mouseArg = process.argv[5] || '';
  const m = /^move:(\d+),(\d+)$/.exec(mouseArg) || /^(\d+),(\d+)$/.exec(mouseArg);
  if (m) {
    const cx = +m[1], cy = +m[2];
    const MX = 640, MY = 360; // 屏幕中心 = 驱动鼠标初始位置（1280×720）
    // 把整段位移拆成每步 ≤32px 的小步发送。PS/2 鼠标单包位移只有 9 位有符号
    // （±255，常拆成 ≤127），一步发太大 QEMU 会拆成多包、还容易因符号位/时序丢包，
    // 光标落点会偏。小步发送最稳。
    const dx = cx - MX, dy = cy - MY;
    const steps = Math.max(1, Math.ceil(Math.max(Math.abs(dx), Math.abs(dy)) / 32));
    for (let i = 1; i <= steps; i++) {
      send(s, { execute: 'input-send-event', arguments: { events: [
        { type: 'rel', data: { axis: 'x', value: Math.round(dx * i / steps) - Math.round(dx * (i - 1) / steps) } },
        { type: 'rel', data: { axis: 'y', value: Math.round(dy * i / steps) - Math.round(dy * (i - 1) / steps) } },
      ] } });
      await new Promise(r => setTimeout(r, 20));
    }
    await new Promise(r => setTimeout(r, 150));
    if (!/^move:/.test(mouseArg)) {
      send(s, { execute: 'input-send-event', arguments: { events: [
        { type: 'btn', data: { down: true, button: 'left' } },
      ] } });
      await new Promise(r => setTimeout(r, 80));
      send(s, { execute: 'input-send-event', arguments: { events: [
        { type: 'btn', data: { down: false, button: 'left' } },
      ] } });
    }
    await new Promise(r => setTimeout(r, 900));
  }

  send(s, { execute: 'screendump', arguments: { filename: shot } });
  await new Promise(r => setTimeout(r, 1500));

  send(s, { execute: 'quit' });
  await new Promise(r => setTimeout(r, 500));
  s.destroy();
  try { process.kill(-qemu.pid, 'SIGKILL'); } catch {}

  console.log('=== 串口 ===');
  console.log(fs.existsSync(serialLog) ? fs.readFileSync(serialLog, 'utf8').slice(-1500) : '(无)');
  console.log('=== 截屏 ===', fs.existsSync(shot) ? fs.statSync(shot).size + ' B' : '失败');
  process.exit(0);
})();
