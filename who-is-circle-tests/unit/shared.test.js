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
// 种子化 PRNG（mulberry32）：同一 seed 永远给出同一串随机数。
// 用途是让"往返精度"这类统计型用例可复现 —— 否则红了也复现不了，等于没有回归保护。
function mulberry32(seed) {
  let a = seed >>> 0;
  return function () {
    a = (a + 0x6D2B79F5) >>> 0;
    let t = Math.imul(a ^ (a >>> 15), 1 | a);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

// rng 可注入：默认 Math.random，要可复现的样本就传种子化 PRNG。
function circle(cx, cy, r, { n = 240, noise = 0, dur = 1200, jitter = 0, start = 0, sweep = 360, rng = Math.random } = {}) {
  const pts = [];
  for (let i = 0; i <= n; i++) {
    const a = (start + sweep * i / n) * Math.PI / 180;
    const rr = r * (1 + (rng() - 0.5) * 2 * noise);
    const t = dur * i / n + (jitter ? (rng() - 0.5) * jitter : 0);
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

console.log('\n========== 三、加载顺序守卫 ==========');
const root = path.join(__dirname, '../../who-is-circle');
const htmlSrc = fs.readFileSync(path.join(root, 'index.html'), 'utf8');
const gameSrc = fs.readFileSync(path.join(root, 'game.js'), 'utf8');

const iShared = htmlSrc.indexOf('shared/scoring.js');
const iGame = htmlSrc.indexOf('src="game.js"');
ok(iShared !== -1, 'index.html 引入了 shared/scoring.js');
ok(iGame !== -1, 'index.html 引入了 game.js');
ok(iShared !== -1 && iGame !== -1 && iShared < iGame,
  'index.html 中 shared/scoring.js 排在 game.js 之前', `shared@${iShared} game@${iGame}`);

ok(gameSrc.includes("require('./shared/scoring.js')"), 'game.js 通过 CommonJS 引用共享模块');
const iReq = gameSrc.indexOf("require('./shared/scoring.js')");
const iCfg = gameSrc.indexOf('var CFG = {');
ok(iReq !== -1 && iCfg !== -1 && iReq < iCfg, '引用块在 var CFG 之前（早于任何使用点）');
ok(gameSrc.includes('judge(r, g, replay, DEV)'), 'judge 调用点传入了 DEV');
ok(!/function judge\(r, g, replay\)/.test(gameSrc), 'game.js 内不再有旧签名的 judge 定义');

console.log('\n========== 四、防漂移：game.js 必须用同一份代码 ==========');
const G = require('../../who-is-circle/game.js');
ok(G.evaluate === S.evaluate, 'game.js 的 evaluate 就是 shared 的 evaluate（同一函数引用）');
ok(G.guardCheck === S.guardCheck, 'game.js 的 guardCheck === shared 的 guardCheck');
ok(G.judge === S.judge, 'game.js 的 judge === shared 的 judge');
ok(G.RANKS === S.RANKS, 'game.js 的 RANKS === shared 的 RANKS');
ok(G.SCORE_CFG === S.SCORE_CFG, 'game.js 的 SCORE_CFG === shared 的 SCORE_CFG');
ok(G.BEST_SALT === S.BEST_SALT, 'game.js 的 BEST_SALT === shared 的 BEST_SALT');

console.log('\n========== 五、评分行为（与 game.js 口径一致）==========');
const c = circle(375, 700, 250);
const r = S.evaluate(c);
ok(r.valid && r.score >= 97, '完美圆 → 高分', `score=${r.score}`);
ok(r.loss && Math.abs((r.loss.round + r.loss.close + r.loss.dir) - (100 - r.score)) < 0.15,
  '扣分明细三项之和 = 100 − 总分',
  `Σloss=${(r.loss.round + r.loss.close + r.loss.dir).toFixed(2)} vs ${(100 - r.score).toFixed(2)}`);

console.log('\n========== 六、judge 的 dev 参数 ==========');
const rr = { score: 50, valid: true };
const clean = { hard: [], risk: 0, hits: [] };
const risky = { hard: [], risk: 99, hits: ['a', 'b'] };
ok(S.judge(rr, clean, false) === 'ok', 'judge 三参（dev 缺省）→ 走真实判定，不豁免');
ok(S.judge(rr, clean, false, true) === 'ok', 'judge 四参 dev=true → 豁免返回 ok');
ok(S.judge(rr, risky, false, true) === 'ok', 'dev=true 时高风险也被豁免');
ok(S.judge(rr, risky, false) !== 'ok', 'dev 缺省时高风险不被豁免');

console.log('\n========== 七、shapeSig 是 64 个数字的数组（不是字符串）==========');
const sig = S.shapeSig(c, r.fit);
ok(Array.isArray(sig) && sig.length === 64, 'shapeSig 返回 64 元素数组',
  `type=${Array.isArray(sig) ? 'array' : typeof sig}`);
ok(sig.every(v => typeof v === 'number'), '数组元素全是 number',
  `样例 ${JSON.stringify(sig.slice(0, 3))}`);
ok(S.isReplay(sig, [sig.map(v => v + 0.05)]) === false, '数组指纹参与重放比较');

console.log('\n========== 八、pts 与 raw 的入参约定 ==========');
const pts = circle(375, 700, 250, { noise: 0.02 });
const dec = S.decodePts(S.encodePts(pts));
ok(dec.length === pts.length && typeof dec[0].x === 'number' && typeof dec[0].t === 'number',
  'decodePts → [{x,y,t}]', `第0点 t=${dec[0].t}`);
const raw = pts.map(p => ({ t: p.t, h: p.t, x: p.x, y: p.y }));
const gg = S.guardCheck(raw, S.evaluate(pts).fit, S.evaluate(pts).score, {});
ok(gg && typeof gg.risk === 'number' && Array.isArray(gg.hits),
  'guardCheck 收 [{t,h,x,y}] → {hard,risk,hits}', `risk=${gg.risk}`);

console.log('\n========== 九、编码往返精度（上传链路的生命线）==========');
// 客户端算分 → 编码上传 → 云端解码重算，两边必须对得上。
//
// 这里曾经有个真实的 bug：0.1px 的量化精度沿 240 帧累积，高分段往返误差可达 0.5 分，
// 连"最高分存档自校验"（容差 0.15）都会误杀 —— 100 分段 43.7% 的玩家丢最高分。
// 这类 bug 肉眼看不见、e2e 也测不出来（e2e 用的是未编码的原始点），
// 只能靠"编码→解码→重算"的往返测试钉住。
{
  // 档位按 CURVE 锚点定档：noise 是**相对半径**的径向偏差上限，约等于评分用的误差 ε。
  //   ε=0.001→100分、0.003→99分、0.01→92分、0.05→约 72 分
  //
  // 这里原来写的是 0.35 / 0.8 / 1.6 / 3.0 —— 那是相对半径的 35%~300% 抖动，
  // 画出来的根本不是圆（普通档里出现过 x=1088 的垃圾路径，圆心才 375、半径才 180）。
  // 后果不是"测试红了一次"，而是**这一段叫"满分档"，却从来没测过 100 分那档**：
  // 噪声大到把分数压到中分段，往返误差自然小于阈值，断言形同虚设。
  // 而"43.7% 的 100 分玩家丢最高分"那个 bug 恰恰活在这一档里。
  // 现在档位与 CURVE 锚点对齐，并用下面的断言把"档位名"钉成事实。
  const levels = [
    { name: '满分档(ε=0.001)', noise: 0.001, min: 99.5, max: 100 },   // CURVE: ε≤0.001 → 100
    { name: '高分档(ε=0.003)', noise: 0.003, min: 99, max: 100 },     // ε≈0.002 → 99.5~99.8
    { name: '中分档(ε=0.01)', noise: 0.01, min: 95, max: 99 },       // ε≈0.005 → 97
    { name: '普通档(ε=0.05)', noise: 0.05, min: 75, max: 90 }       // ε≈0.02 → 84
  ];
  const TRIALS = 120;
  const SEED = 20261105;
  let worstAll = 0, overTol = 0, overPointOne = 0, total = 0, payloadMax = 0;
  // 被判无效的样本：reason -> 次数。以前是 continue 静默跳过，
  // 结果"样本量够"这条断言随机变红，却看不出是被什么判无效的 —— 定位成本极高。
  // 现在显式收集，噪声圆被判无效本身就是产品缺陷（玩家画得歪不该被拒）。
  const invalid = {};
  const bandStats = [];   // 每档的分数统计，用于跨档分离断言

  for (const lv of levels) {
    let worst = 0, scoreMin = Infinity, scoreMax = -Infinity, scoreSum = 0, cnt = 0;
    for (let k = 0; k < TRIALS; k++) {
      // 种子化 PRNG：同一份样本每次都一样，红了能复现
      const rng = mulberry32(SEED + k * 7919 + Math.round(lv.noise * 100000));
      const p = circle(375, 700, 180, { noise: lv.noise, jitter: 4, rng });
      const r1 = S.evaluate(p);
      if (!r1.valid) {
        const key = '客户端:' + r1.reason;
        invalid[key] = (invalid[key] || 0) + 1;
        continue;
      }
      const enc = S.encodePts(p);
      const r2 = S.evaluate(S.decodePts(enc));
      if (!r2.valid) {
        const key = '云端:' + r2.reason;
        invalid[key] = (invalid[key] || 0) + 1;
        continue;
      }
      if (r1.score < scoreMin) scoreMin = r1.score;
      if (r1.score > scoreMax) scoreMax = r1.score;
      scoreSum += r1.score; cnt++;
      const d = Math.abs(r1.score - r2.score);
      // 分数只有 1 位小数，差值量化到 1e-4 再比 —— 否则 99.8-99.7=0.10000000000000853
      // 这种浮点噪声会把"恰好 0.1"判成"超过 0.1"
      const dq = Math.round(d * 1e4) / 1e4;
      if (dq > worst) worst = dq;
      if (dq > 0.15) overTol++;          // 存档自校验的容差
      if (dq > 0.1) overPointOne++;     // P2 云端对拍的验收线
      if (dq > worstAll) worstAll = dq;
      const len = JSON.stringify(enc).length;
      if (len > payloadMax) payloadMax = len;
      total++;
    }
    ok(worst <= 0.1, `${lv.name} 往返误差 ≤ 0.1`, `最大=${worst.toFixed(4)}`);
    // 档位名必须是事实而不是标签：样本真的落在该分数段，才说明这一档测到了东西
    ok(scoreMin >= lv.min && scoreMax <= lv.max,
      `${lv.name} 确实落在 ${lv.min}~${lv.max} 分段（档位名不是空标签）`,
      `实测 ${scoreMin.toFixed(1)}~${scoreMax.toFixed(1)} 分`);
    bandStats.push({ name: lv.name, mean: cnt ? scoreSum / cnt : 0, min: scoreMin, max: scoreMax });
  }

  // 跨档分离：四档必须是四个真的不同的分数段。
  // 这条专门防"噪声参数又被写错量纲"——那种错法会让四档挤在同一分段里，
  // 往返误差断言因为噪声太大而永远通过，等于把回归保护悄悄拆了。
  let separated = true, sepDetail = [];
  for (let i = 0; i + 1 < bandStats.length; i++) {
    const gap = bandStats[i].mean - bandStats[i + 1].mean;
    sepDetail.push(`${bandStats[i].name}→${bandStats[i + 1].name} 差 ${gap.toFixed(2)}`);
    if (gap < 0.1) separated = false;
  }
  ok(separated, '四个档位互相拉开（平均分严格递减，相邻差 ≥ 0.1）', sepDetail.join('；'));

  const invalidDesc = Object.keys(invalid).length
    ? Object.keys(invalid).map(k => k + '×' + invalid[k]).join(' ')
    : '无';
  ok(Object.keys(invalid).length === 0, '噪声圆不该被判无效（客户端与云端都不该拒）', invalidDesc);
  ok(total === levels.length * TRIALS, '样本量够（各档 '+TRIALS+' 笔）', '共 '+total+' 笔');
  ok(overTol === 0, '没有任何一笔会触发"最高分存档自校验"作废（容差 0.15）', '越界 '+overTol+' 笔');
  ok(overPointOne === 0, '没有任何一笔超过 P2 云端对拍验收线（0.1）', '越界 '+overPointOne+' 笔');
  ok(worstAll <= 0.1, '全局最大往返误差 ≤ 0.1', '最大=' + worstAll.toFixed(4));
  ok(payloadMax <= 8192, '单条笔迹载荷 ≤ 8KB（pending 队列每条 2–10KB 的预算内）',
    '最大=' + payloadMax + ' 字节');
}

console.log(`\n结果：${pass} 通过 / ${fail} 失败\n`);
process.exit(fail ? 1 : 0);
