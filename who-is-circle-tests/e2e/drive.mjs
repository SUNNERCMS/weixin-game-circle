/**
 * 端到端验证：画到一半（笔迹单色）→ 完整圆结算 → 残缺圆结算（诊断+升级提示）→ 落笔重画 → 返回首页
 *
 * 依赖：微信开发者工具预览服务（默认 http://localhost:55724）+ agent-browser CLI
 * 环境变量：E2E_URL=...  E2E_SHOTS=...  AB=agent-browser
 * 运行：node test/e2e/drive.mjs && python3 test/e2e/analyze.py
 */
import { execSync } from 'child_process';

import path from 'path';
import { fileURLToPath } from 'url';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const AB = process.env.AB || 'agent-browser';

// 预览服务地址：E2E_URL 优先；没给就自动探测。
// （预览服务每次启动的端口不固定，硬编码 55724 迟早连不上 —— 连不上时
//   点击会全部落空，而 e2e 的表现是"界面停在原地"，很难一眼看出是环境问题。）
let URL_BASE = process.env.E2E_URL || '';

// 探测某个地址是不是预览服务
// 判据有两条，缺一不可：
//   1. 能取到游戏源码 /game.js（廉价过滤）
//   2. 渲染后页面里有游戏 iframe
// 只判 1 是不够的：CodeBuddy IDE 的 workbuddy 面板也会把工作区当静态目录暴露，
// 同样能取到 /game.js，但它根本不是预览服务 —— 拿它当预览，点击全落空，
// e2e 的表现是"界面停在原地"，极难联想到是环境问题。
// 判据 2 必须用渲染后的 DOM：预览页是客户端渲染的，curl 拿到的初始 HTML 里没有 iframe。
async function probePreview(u) {
  try {
    const out = execSync(
      `curl -s -o /dev/null -w '%{http_code} %{size_download}' --max-time 2 '${u}/game.js' 2>/dev/null || true`,
      { encoding: 'utf8', shell: '/bin/bash' }
    ).trim();
    const m = out.match(/^200\s+(\d+)$/);
    if (!m || Number(m[1]) <= 1000) return false;
  } catch (e) { return false; }

  try {
    run(`${AB} open ${u}`);
    await sleep(2500);
    const geo = run(`${AB} eval "(()=>{const f=document.querySelector('iframe');if(!f)return 'nof';const r=f.getBoundingClientRect();return JSON.stringify({w:r.width,h:r.height});})()"`)
      .replace(/\\/g, '');
    const gm = geo.match(/"w":\s*([\d.]+)\s*,\s*"h":\s*([\d.]+)/);
    return !!gm && Number(gm[1]) > 100 && Number(gm[2]) > 200;
  } catch (e) { return false; }
}

async function findPreviewUrl() {
  if (URL_BASE) return URL_BASE;
  const candidates = ['http://localhost:55724'];
  try {
    const ports = run("lsof -nP -iTCP -sTCP:LISTEN 2>/dev/null | awk '{print $9}' | sed 's/.*://' | sort -un")
      .split('\n').map(s => s.trim()).filter(p => /^\d+$/.test(p) && Number(p) > 1024);
    for (const p of ports) candidates.push('http://localhost:' + p);
  } catch (e) { /* 扫不到就只试默认端口 */ }
  for (const u of candidates) {
    if (await probePreview(u)) return u;
  }
  return null;
}
const SHOTS = process.env.E2E_SHOTS || path.resolve(HERE, '../shots');
const run = (cmd) => execSync(cmd, { encoding: 'utf8', shell: '/bin/bash' });
const sleep = (ms) => new Promise(r => setTimeout(r, ms));
// 设计坐标(750×1624) → 页面坐标：缩放与偏移从预览 iframe 的实际几何算出，
// 不写死数值，换窗口尺寸 / 换设备也能对上
let S = 0.41459, L = 39.52, T = 31.0;
const toPage = (dx, dy) => [Math.round(L + dx * S), Math.round(T + dy * S - 0.16)];
const mouse = (x, y) => run(`${AB} mouse move ${x} ${y}`);
// 预览壳是 React 应用，**布局会在运行中变**（面板折叠/重排）⇒
// 之前算好的映射会失效 ⇒ 后面每次点击都落在旧位置 ⇒ 表现为「界面完全没反应」。
// 所以每次交互前都重新读一次几何（读不到就沿用上次的）。
function refreshGeo() {
  const gg = readGeo();
  if (gg) applyGeo(gg);
  return gg;
}
const click = async (dx, dy) => {
  refreshGeo();
  const [x, y] = toPage(dx, dy);
  mouse(x, y); run(`${AB} mouse down`); await sleep(60); run(`${AB} mouse up`);
};
const shot = async (name) => { run(`${AB} screenshot ${path.join(SHOTS, name + '.png')}`); };

// 画一段弧（press=true 时按下；松手由调用方决定）
async function drawArc(cx, cy, rad, a0deg, a1deg, N, press = true) {
  refreshGeo();
  let first = true;
  for (let i = 0; i <= N; i++) {
    const a = (a0deg + (a1deg - a0deg) * i / N) * Math.PI / 180;
    const wob = 1 + 0.005 * Math.sin(2 * a) + (Math.random() - 0.5) * 0.007;
    const [px, py] = toPage(cx + rad * wob * Math.cos(a), cy + rad * wob * Math.sin(a));
    if (first) { mouse(px, py); if (press) run(`${AB} mouse down`); first = false; } else mouse(px, py);
    await sleep(9 + Math.random() * 12);
  }
}

// 预览壳页面就绪检测：壳页面 readyState=complete 且 DOM 已撑开，才说明外壳加载完
// （壳里的游戏引擎还要再起一会儿，所以之后仍要固定等待）
const waitForPreview = async (timeout = 30000) => {
  const t0 = Date.now();
  while (Date.now() - t0 < timeout) {
    const out = run(`${AB} eval "document.readyState + ':' + document.body.innerHTML.length"`).trim();
    const m = out.match(/([a-z]+):(\d+)/);
    if (m && m[1] === 'complete' && Number(m[2]) > 5000) return true;
    await sleep(500);
  }
  return false;
};

// 找到预览服务
if (!URL_BASE) {
  const found = await findPreviewUrl();
  if (!found) {
    console.error('❌ 找不到预览服务。请先启动预览（MCP run_game 或开发者工具），' +
      '或用 E2E_URL=http://localhost:<端口> 指定。');
    process.exit(1);
  }
  URL_BASE = found;
  console.log('   自动发现预览服务：' + URL_BASE);
}

await run(`${AB} open ${URL_BASE}`);
if (!await waitForPreview()) {
  console.error('❌ 预览页未就绪：' + URL_BASE + '（先起预览服务：MCP run_game 或开发者工具）');
  process.exit(1);
}
await sleep(6000);   // 游戏引擎启动 + 首帧

// 读预览 iframe 的实际几何
//
// ⚠️ 别改成读 iframe 内部 canvas 的矩形 —— 实测那样算出来的映射是偏的
// （scale 从 0.4957 变成 0.5197 ⇒ 点击全落空 ⇒ 表现是「游戏停在首页」）。
// iframe 的矩形就是对的。
function readGeo() {
  const raw = run(`${AB} eval "(()=>{const f=document.querySelector('iframe');if(!f)return 'nof';const r=f.getBoundingClientRect();return JSON.stringify({x:r.x,y:r.y,w:r.width,h:r.height});})()"`)
    .replace(/\\/g, '');
  const gm = raw.match(/"x":\s*([-\d.]+)\s*,\s*"y":\s*([-\d.]+)\s*,\s*"w":\s*([-\d.]+)\s*,\s*"h":\s*([-\d.]+)/);
  if (!gm) return null;
  return { x: +gm[1], y: +gm[2], w: +gm[3], h: +gm[4] };
}

// 预览壳把游戏放在右侧的手机预览面板里，iframe 未必填满视口。
// 视口装不下 iframe 时，点击坐标会算到视口外 —— 表现是"界面完全没反应"，
// 极难联想到是视口问题。所以这里按实际几何把视口放大到刚好能容纳它。
let VW = 1400, VH = 1000;
await run(`${AB} set viewport ${VW} ${VH}`);
await sleep(600);
let g = readGeo();
if (!g) {
  console.error('❌ 读不到预览 iframe 几何');
  process.exit(1);
}
const fits = (gg) => gg.x >= 0 && gg.y >= 0 && gg.x + gg.w <= VW && gg.y + gg.h <= VH;
if (!fits(g)) {
  VW = Math.ceil(g.x + g.w + 60);
  VH = Math.ceil(g.y + g.h + 60);
  await run(`${AB} set viewport ${VW} ${VH}`);
  await sleep(800);
  g = readGeo() || g;
  if (!fits(g)) {
    console.error(`❌ 预览 iframe 放不进视口：x=${g.x} y=${g.y} w=${g.w} h=${g.h} 视口=${VW}x${VH}`);
    process.exit(1);
  }
  console.log(`   已放大视口到 ${VW}x${VH} 以容纳预览面板`);
}

// 按预览 iframe 的实际几何反推设计坐标→页面坐标的缩放与偏移
function applyGeo(gg) {
  S = Math.min(gg.w / 750, gg.h / 1624);
  L = gg.x + (gg.w - 750 * S) / 2;
  T = gg.y + (gg.h - 1624 * S) / 2;
}
applyGeo(g);
console.log(`   映射 scale=${S.toFixed(5)} origin=(${L.toFixed(1)},${T.toFixed(1)})`);

await click(375, 980);
await sleep(1200);
console.log('① 进入画圆页');

// ② 画 250° → 中途状态（笔迹应始终单色）
await drawArc(375, 700, 250, -90, 160, 44);
await sleep(250);
await shot('live');
console.log('② 画到 250°（笔迹单色）');

// ③ 补完 → 结算
await drawArc(375, 700, 250, 160, 268, 40, false);
run(`${AB} mouse up`);
await sleep(1700);
await shot('result');
console.log('③ 完整圆结算');

// ④ 残缺圆（190°）→ 应出现诊断红字 + 升级提示
await sleep(200);
await click(375, 1450);
await sleep(500);
await drawArc(375, 700, 250, -90, 100, 34);
run(`${AB} mouse up`);                 // ← 松手结算
await sleep(1800);
await shot('gap');
console.log('④ 残缺圆结算');

// ⑤ 结算播完后落笔 → 直接开新一笔（结算卡片应消失）
await sleep(200);
await click(200, 1150);
await sleep(200);
await shot('redraw');
console.log('⑤ 落笔重画');

// ⑥ 返回首页（看最佳分是否已落定）
await sleep(200);
await click(64, 100);
await sleep(700);
await shot('home');
console.log('⑥ 返回首页');
