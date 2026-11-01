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
const URL_BASE = process.env.E2E_URL || 'http://localhost:55724';
const SHOTS = process.env.E2E_SHOTS || path.resolve(HERE, '../shots');
const run = (cmd) => execSync(cmd, { encoding: 'utf8', shell: '/bin/bash' });
const sleep = (ms) => new Promise(r => setTimeout(r, ms));
// 设计坐标(750×1624) → 页面坐标：缩放与偏移从预览 iframe 的实际几何算出，
// 不写死数值，换窗口尺寸 / 换设备也能对上
let S = 0.41459, L = 39.52, T = 31.0;
const toPage = (dx, dy) => [Math.round(L + dx * S), Math.round(T + dy * S - 0.16)];
const mouse = (x, y) => run(`${AB} mouse move ${x} ${y}`);
const click = async (dx, dy) => {
  const [x, y] = toPage(dx, dy);
  mouse(x, y); run(`${AB} mouse down`); await sleep(60); run(`${AB} mouse up`);
};
const shot = async (name) => { run(`${AB} screenshot ${path.join(SHOTS, name + '.png')}`); };

// 画一段弧（press=true 时按下；松手由调用方决定）
async function drawArc(cx, cy, rad, a0deg, a1deg, N, press = true) {
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

await run(`${AB} set viewport 390 844`);
await run(`${AB} open ${URL_BASE}`);
if (!await waitForPreview()) {
  console.error('❌ 预览页未就绪：' + URL_BASE + '（先在开发者工具里启动预览）');
  process.exit(1);
}
await sleep(6000);   // 游戏引擎启动 + 首帧

// 按预览 iframe 的实际几何反推设计坐标→页面坐标的缩放与偏移
const raw = run(`${AB} eval "(()=>{const f=document.querySelector('iframe');const r=f.getBoundingClientRect();return JSON.stringify({x:r.x,y:r.y,w:r.width,h:r.height});})()"`).replace(/\\/g, '');
const gm = raw.match(/"x":\s*([-\d.]+)\s*,\s*"y":\s*([-\d.]+)\s*,\s*"w":\s*([-\d.]+)\s*,\s*"h":\s*([-\d.]+)/);
if (!gm) {
  console.error('❌ 读不到预览 iframe 几何：' + raw.trim());
  process.exit(1);
}
const g = { x: +gm[1], y: +gm[2], w: +gm[3], h: +gm[4] };
S = Math.min(g.w / 750, g.h / 1624);
L = g.x + (g.w - 750 * S) / 2;
T = g.y + (g.h - 1624 * S) / 2;
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
