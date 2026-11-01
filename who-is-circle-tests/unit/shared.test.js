/**
 * 共享评分引擎单元测试（shared/scoring.js）
 *
 * 作用：锁住「主域与云函数跑同一份代码」这件事 —— 一旦有人在共享模块里偷改算法，
 *      或在 game.js 里又留了一份副本，这里立刻红。
 *
 * 纯度约束（见 docs/superpowers/specs/2026-11-01-friend-leaderboard-design.md）：
 *      共享模块不得引用任何平台 API —— 云函数与小游戏主域没有共同的平台 API，
 *      一旦混入平台调用，"共享"就失效了。
 *
 * 运行：node unit/shared.test.js   （退出码非 0 = 有用例失败）
 */
const fs = require('fs');
const path = require('path');
const S = require('../../who-is-circle/shared/scoring.js');

let pass = 0, fail = 0;
function ok(cond, name, extra) {
  if (cond) { pass++; console.log('  ✅ ' + name + (extra ? '  ' + extra : '')); }
  else { fail++; console.log('  ❌ ' + name + (extra ? '  ' + extra : '')); }
}

// ---------- 造笔画工具（与 scorer.test.js 相同的圆）----------
function circle(cx, cy, r, { n = 240, noise = 0, dur = 1200, jitter = 0, start = 0, sweep = 360 } = {}) {
  const pts = [];
  for (let i = 0; i <= n; i++) {
    const a = (start + sweep * i / n) * Math.PI / 180;
    const rr = r * (1 + (Math.random() - 0.5) * 2 * noise);
    const t = dur * i / n + (jitter ? (Math.random() - 0.5) * jitter : 0);
    pts.push({ x: cx + rr * Math.cos(a), y: cy + rr * Math.sin(a), t });
  }
  return pts;
}

console.log('\n========== 一、导出完整性 ==========');

const EXPORTS = ['SCORE_CFG', 'GUARD_CFG', 'RANKS', 'INVALID_TIPS',
  'resample', 'kasaFit', 'refineFit', 'winding', 'roundScore', 'closeFactor', 'largestGap',
  'evaluate', 'getRank', 'diagnose', 'upgradeTip',
  'stat', 'guardCheck', 'shapeSig', 'isReplay', 'fnv', 'encodePts', 'decodePts', 'judge',
  'BEST_SALT'];
const missing = EXPORTS.filter(k => S[k] === undefined);
ok(missing.length === 0, '24 个导出符号齐全',
  missing.length ? '缺: ' + missing.join(',') : EXPORTS.length + ' 个');
ok(S.BEST_SALT === 'yz#750#v3', 'BEST_SALT 是钉死的字面量（主域与云端必须一致）',
  `实际=${JSON.stringify(S.BEST_SALT)}`);

console.log('\n========== 二、纯度（不许混进平台代码）==========');
const SHARED_PATH = path.join(__dirname, '../../who-is-circle/shared/scoring.js');
const src = fs.readFileSync(SHARED_PATH, 'utf8');
const FORBIDDEN = ['wx.', 'env.', 'document.', 'window.', 'location.', 'navigator.', 'GameGlobal.',
  'getStorage', 'setStorage'];
const hit = FORBIDDEN.filter(k => src.includes(k));
ok(hit.length === 0, '共享模块不含任何平台 API 引用',
  hit.length ? '命中: ' + hit.join(',') : '已扫描 ' + FORBIDDEN.length + ' 个禁用词');
ok(!/\brequire\s*\(/.test(src), '共享模块内部不 require 别的文件', '自包含');

console.log('\n========== 三·b、防漂移：game.js 必须用同一份代码 ==========');
const G = require('../../who-is-circle/game.js');
ok(G.evaluate === S.evaluate, 'game.js 的 evaluate 就是 shared 的 evaluate（同一函数引用）');
ok(G.guardCheck === S.guardCheck, 'game.js 的 guardCheck === shared 的 guardCheck');
ok(G.judge === S.judge, 'game.js 的 judge === shared 的 judge');
ok(G.RANKS === S.RANKS, 'game.js 的 RANKS === shared 的 RANKS');
ok(G.SCORE_CFG === S.SCORE_CFG, 'game.js 的 SCORE_CFG === shared 的 SCORE_CFG');
ok(G.BEST_SALT === S.BEST_SALT, 'game.js 的 BEST_SALT === shared 的 BEST_SALT');

console.log('\n========== 三、评分行为（与 game.js 口径一致）==========');
const c = circle(375, 700, 250);
const r = S.evaluate(c);
ok(r.valid && r.score >= 97, '完美圆 → 高分', `score=${r.score}`);
ok(r.loss && Math.abs((r.loss.round + r.loss.close + r.loss.dir) - (100 - r.score)) < 0.15,
  '扣分明细三项之和 = 100 − 总分',
  `Σloss=${(r.loss.round + r.loss.close + r.loss.dir).toFixed(2)} vs ${(100 - r.score).toFixed(2)}`);

console.log('\n========== 四、judge 的 dev 参数 ==========');
const rr = { score: 50, valid: true };
const clean = { hard: [], risk: 0, hits: [] };
const risky = { hard: [], risk: 99, hits: ['a', 'b'] };
ok(S.judge(rr, clean, false) === 'ok', 'judge 三参（dev 缺省）→ 走真实判定，不豁免');
ok(S.judge(rr, clean, false, true) === 'ok', 'judge 四参 dev=true → 豁免返回 ok');
ok(S.judge(rr, risky, false, true) === 'ok', 'dev=true 时高风险也被豁免');
ok(S.judge(rr, risky, false) !== 'ok', 'dev 缺省时高风险不被豁免');

console.log('\n========== 五、shapeSig 是 64 个数字的数组（不是字符串）==========');
const sig = S.shapeSig(c, r.fit);
ok(Array.isArray(sig) && sig.length === 64, 'shapeSig 返回 64 元素数组',
  `type=${Array.isArray(sig) ? 'array' : typeof sig}`);
ok(sig.every(v => typeof v === 'number'), '数组元素全是 number',
  `样例 ${JSON.stringify(sig.slice(0, 3))}`);
ok(S.isReplay(sig, [sig.map(v => v + 0.05)]) === false, '数组指纹参与重放比较');

console.log('\n========== 六、pts 与 raw 的入参约定 ==========');
const pts = circle(375, 700, 250, { noise: 0.02 });
const dec = S.decodePts(S.encodePts(pts));
ok(dec.length === pts.length && typeof dec[0].x === 'number' && typeof dec[0].t === 'number',
  'decodePts → [{x,y,t}]', `第0点 t=${dec[0].t}`);
const raw = pts.map(p => ({ t: p.t, h: p.t, x: p.x, y: p.y }));
const gg = S.guardCheck(raw, S.evaluate(pts).fit, S.evaluate(pts).score, {});
ok(gg && typeof gg.risk === 'number' && Array.isArray(gg.hits),
  'guardCheck 收 [{t,h,x,y}] → {hard,risk,hits}', `risk=${gg.risk}`);

console.log(`\n结果：${pass} 通过 / ${fail} 失败\n`);
process.exit(fail ? 1 : 0);
