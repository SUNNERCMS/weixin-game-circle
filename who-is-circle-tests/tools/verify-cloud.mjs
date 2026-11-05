/**
 * 端到端验证：云端算的分 == 客户端算的分
 *
 * 这是 P2 的核心验收指标。做法：
 *   1. 造几笔"像真人画的圆"（不同噪声档位，覆盖各个分数段）
 *   2. 客户端用 shared/scoring.js 算出分，encodePts + shapeSig 后打包
 *   3. 调云函数（__selftest 自检通道：只算不落库，不污染真实榜单）
 *   4. 对拍：云端分 vs 客户端分，误差必须 ≤ 0.1
 *
 * 依赖：tcb CLI（CloudBase CLI）+ 云环境里已部署 score 云函数
 * 用法：
 *   CLOUD_ENV=cloud1-xxxx npm run verify:cloud
 */
import { execFileSync } from 'node:child_process';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { createRequire } from 'node:module';

const require = createRequire(import.meta.url);
const here = path.dirname(fileURLToPath(import.meta.url));
const S = require(path.join(here, '../../who-is-circle/shared/scoring.js'));

const ENV_ID = process.env.CLOUD_ENV || 'cloud1-d6grvs82r581230b2';
const TOLERANCE = 0.1;   // 验收线：云端分与客户端分之差

// 造一笔"像真人画的圆"
function circlePoints(noise, r) {
  const pts = [];
  const n = 240;
  for (let i = 0; i <= n; i++) {
    const a = (i / n) * Math.PI * 2;
    const rr = r + (Math.random() - 0.5) * 2 * noise;
    pts.push({
      x: 375 + rr * Math.cos(a),
      y: 800 + rr * Math.sin(a),
      t: 1200 * i / n + (Math.random() - 0.5) * 4
    });
  }
  return pts;
}

function invoke(payload) {
  const out = execFileSync('tcb', [
    'fn', 'invoke', 'score',
    '-e', ENV_ID,
    '-d', JSON.stringify(payload),
    '--json'
  ], { encoding: 'utf8', maxBuffer: 16 * 1024 * 1024 });
  const j = JSON.parse(out);
  const ret = j && j.data && j.data.RetMsg;
  if (!ret) throw new Error('云函数没有返回 RetMsg：' + out.slice(0, 500));
  return JSON.parse(ret);
}

const CASES = [
  { name: '满分档(轻噪)', noise: 0.35 },
  { name: '高分档', noise: 0.8 },
  { name: '中分档', noise: 1.6 },
  { name: '普通档', noise: 3.0 }
];

console.log(`\n云环境：${ENV_ID}`);
console.log(`验收线：|云端分 − 客户端分| ≤ ${TOLERANCE}\n`);

let pass = 0, fail = 0;
for (const c of CASES) {
  const pts = circlePoints(c.noise, 180);
  const r = S.evaluate(pts);
  if (!r.valid) {
    console.log(`  ⚠️  ${c.name} 本地判定无效（${r.reason}），跳过`);
    continue;
  }
  const payload = {
    __selftest: true,
    pts: S.encodePts(pts),
    clientScore: r.score,
    sig: S.shapeSig(pts, r.fit),
    guard: { hard: [], risk: 0, hits: [] }
  };
  let out;
  try {
    out = invoke(payload);
  } catch (e) {
    console.log(`  ❌ ${c.name} 调用云函数失败：${e.message}`);
    fail++;
    continue;
  }
  const delta = out.scoreDelta;
  const ok = delta !== null && Math.abs(delta) <= TOLERANCE;
  if (ok) pass++; else fail++;
  console.log(
    `  ${ok ? '✅' : '❌'} ${c.name.padEnd(14)} 客户端=${r.score}  云端=${out.score}` +
    `  Δ=${delta}  verdict=${out.verdict}${out.dryRun ? '  (dryRun)' : ''}`
  );
}

console.log(`\n结果：${pass} 通过 / ${fail} 失败\n`);
process.exit(fail ? 1 : 0);
