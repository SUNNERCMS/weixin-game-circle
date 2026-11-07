/**
 * 结算链路 × 云端结论 的集成测试（game.js，P3）
 *
 * js/cloud.js 的单测只证明"上报模块本身"对；
 * 这里证明**接进游戏之后**对：云端结论到底有没有正确落到
 * 「显示的分数 / 新纪录徽章 / 本地最佳分」这三件事上。
 *
 * 关键点：Node 下 DEV = false（正式包行为），
 * 所以这里测的是**线上真实语义**，不是开发豁免后的宽松行为。
 *
 * 运行：node unit/gamesettle.test.js
 */
const G = require('../../who-is-circle/game.js');

let pass = 0, fail = 0;
function ok(cond, name, extra) {
  if (cond) { pass++; console.log('  ✅ ' + name + (extra ? '  ' + extra : '')); }
  else { fail++; console.log('  ❌ ' + name + (extra ? '  ' + extra : '')); }
}

// 造一个"刚结算完、正在等云端结论"的结果对象
function mkRes(over) {
  return Object.assign({
    score: 97.3,
    localScore: 97.3,
    isNew: true,
    cloudPending: true,
    pts: [{ x: 1, y: 2, t: 30 }],
    comment: '圆得离谱',
    fit: { cx: 375, cy: 500, r: 240 },
    t0: 0,
    layout: null
  }, over || {});
}

// 重置游戏状态，避免用例之间互相污染
function reset(best) {
  G.state.best = best;
  G.state.bestPending = null;
  G.state.result = null;
}

console.log('\n========== 一、云端确认（ok） ==========');

{
  reset(90);
  const res = mkRes();
  G.state.result = res;
  G.state.bestPending = { score: 97.3, pts: res.pts, cloudPending: true };

  G.onCloudSettled(res, { status: 'ok', cloudScore: 96.5, verdict: 'ok', level: 3, best: 96.5 });

  ok(res.score === 96.5, '显示的分数换成**云端分**（榜上的分是云端算的）', 'score=' + res.score);
  ok(res.cloudPending === false, '云端确认 → cloudPending 解除（徽章可以弹了）');
  ok(G.state.bestPending && G.state.bestPending.score === 96.5,
    '本地最佳分也用**云端分**（本地不能比榜上虚高）',
    G.state.bestPending ? 'best=' + G.state.bestPending.score : 'null');
  ok(G.state.bestPending.cloudPending === false, '最佳分不再等云端（可以落定了）');
}

{
  // 云端分与本地分一致 → 不该重排版（避免评论/版式无谓跳动）
  reset(90);
  const res = mkRes();
  const layoutBefore = res.layout;
  G.state.result = res;
  G.state.bestPending = { score: 97.3, pts: res.pts, cloudPending: true };
  G.onCloudSettled(res, { status: 'ok', cloudScore: 97.3, verdict: 'ok', level: 3 });
  ok(res.score === 97.3, '云端分与本地分相同 → 分数不变', 'score=' + res.score);
  ok(res.layout === layoutBefore, '云端分相同 → 不重排版');
}

console.log('\n========== 二、云端判无效（shadow / reject） ==========');

for (const st of ['shadow', 'reject']) {
  reset(90);
  const res = mkRes();
  G.state.result = res;
  G.state.bestPending = { score: 97.3, pts: res.pts, cloudPending: true };

  G.onCloudSettled(res, { status: st, score: 97.3, reason: '云端说不算' });

  ok(res.isNew === false, `云端判 ${st} → **撤掉新纪录徽章**（res.isNew=false）`);
  ok(res.cloudPending === false, `云端判 ${st} → cloudPending 解除`);
  ok(G.state.bestPending === null, `云端判 ${st} → **本地最佳分不动**（bestPending 清空）`);
  ok(res.score === 97.3, `云端判 ${st} → 分数照常显示（玩家不能因为被判无效就看不到成绩）`,
    'score=' + res.score);
}

console.log('\n========== 三、云端不可达（unavailable） ==========');

{
  reset(90);
  const res = mkRes();
  G.state.result = res;
  G.state.bestPending = { score: 97.3, pts: res.pts, cloudPending: true };

  G.onCloudSettled(res, { status: 'unavailable', reason: '网络错误' });

  ok(res.isNew === true, '云端不可达 → 新纪录徽章照常（服务不可达 ≠ 作弊证据）');
  ok(res.cloudPending === false, '云端不可达 → cloudPending 解除（不再干等）');
  ok(G.state.bestPending !== null && G.state.bestPending.cloudPending === false,
    '云端不可达 → 最佳分照常落定（只是不上榜）');
  ok(G.state.bestPending.score === 97.3, '云端不可达 → 最佳分还是本地分');
}

console.log('\n========== 四、不串台（别的局的结果不能被这次结论改掉） ==========');

{
  reset(90);
  const res = mkRes();
  const other = mkRes({ score: 60, pts: [{ x: 9, y: 9, t: 9 }] });
  G.state.result = res;
  G.state.bestPending = { score: 97.3, pts: res.pts, cloudPending: true };
  // 又来了一局，bestPending 已经指向新的一局
  G.state.bestPending = { score: 61.2, pts: other.pts, cloudPending: false };

  G.onCloudSettled(res, { status: 'shadow', score: 97.3 });

  ok(G.state.bestPending !== null, '旧结论**不能**清掉新一局的最佳分待落定状态');
  ok(G.state.bestPending.score === 61.2, '新一局的最佳分不受旧结论影响',
    'score=' + G.state.bestPending.score);
}

console.log('\n========== 五、云端客户端在 Node 下应当是"没开云" ==========');

{
  ok(typeof G.createCloudClient === 'function', '导出 createCloudClient（浏览器/Node 都不碰平台全局）');
  const c = G.createCloudClient();
  ok(c === null, 'Node 下没有 wx.cloud → 不建客户端（退化成单机模式）');
}

console.log('\n========== 五、云端结论被记下来（榜面文案要用） ==========');

{
  // 榜面底部那行要说明「本地最高分为什么没上榜」→ 主域得把结论记着
  reset(90);
  const res = mkRes();
  G.state.result = res;
  G.state.bestPending = { score: 97.3, pts: res.pts, cloudPending: true };
  G.onCloudSettled(res, { status: 'shadow', verdict: 'shadow', score: 97.3,
    reason: '存在行为异常，成绩不计入最佳' });
  ok(G.state.lastVerdict === 'shadow', '记下了 verdict', G.state.lastVerdict);
  ok(String(G.state.lastReason).indexOf('行为异常') >= 0,
    '记下了原因（榜面文案要用）', G.state.lastReason);

  reset(90);
  const res2 = mkRes();
  G.state.result = res2;
  G.state.bestPending = { score: 97.3, pts: res2.pts, cloudPending: true };
  G.onCloudSettled(res2, { status: 'reject', verdict: 'reject', score: 97.3,
    reason: '提交过于频繁，请稍后再试' });
  ok(G.state.lastVerdict === 'reject', '限流拒绝也记下了', G.state.lastVerdict);
  ok(String(G.state.lastReason).indexOf('过于频繁') >= 0,
    '限流原因也记下了', G.state.lastReason);
}

console.log('\n========== 六、低分也等云端结论（源码级守卫） ==========');

{
  // 真机现象（2026-11-07）：本地最高 76.3，但榜上第一名才 67.1，底部写「本地最高 76.3（未上榜）」。
  // 根因：低分（<95）走异步路径，**不等云端就把分存进本地存档**；
  // 云端后来判无效时 state.bestPending 早就 null 了，那个分数没人回收。
  //
  // 这条只能读源码 —— 「按分数分档」这种逻辑，行为测试覆盖不到（要跑完整结算 + 伪造云端时序）。
  const fs = require('fs');
  const path2 = require('path');
  const raw = fs.readFileSync(
    path2.join(__dirname, '../../who-is-circle/game.js'), 'utf8');
  const gameSrc = raw.replace(/\/\*[\s\S]*?\*\//g, ' ').replace(/(^|[^:'"\\])\/\/[^\n]*/g, '$1');

  ok(gameSrc.indexOf('res.cloudPending = !DEV;') >= 0,
    '**所有分数都等云端结论**（不再按 ≥95 分档）');
  ok(gameSrc.indexOf('res.cloudPending = !DEV && (r.score >= GUARD_CFG.HIGH_SCORE);') < 0,
    '**没有**「只有 ≥95 分才等云端」的旧逻辑');
  ok(gameSrc.indexOf('state.lastVerdict = ') >= 0,
    '云端结论被记进 state（榜面文案要用）');
}

console.log(`\n结果：${pass} 通过 / ${fail} 失败\n`);
process.exit(fail ? 1 : 0);
