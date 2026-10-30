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
const keys = process.argv[3] || '';
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
    await new Promise(r => setTimeout(r, 90));
  }
  if (keys) await new Promise(r => setTimeout(r, 900));

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
