/**
 * 最高分存档的「晚到结论修正」路径（game.js）
 *
 * 这一组测的是**会丢用户数据**的三条路径 —— 上一轮 code review 查出来的：
 *
 *   C1  晚到的「有效」结论修正最佳分时，存档写的是**当前那一局**的笔迹
 *       （不是这一局的）⇒ 下次启动自校验对不上 ⇒ 最高分静默消失
 *   C2  晚到的「无效」结论把**上一条有效最高分**一起清零
 *       （业务规则写的是「本地最佳分不动」）
 *   I6  cloudScore 没做类型校验 ⇒ state.best 变成 undefined ⇒ 渲染时抛异常卡死
 *
 * 运行：node unit/bestrollback.test.js
 */

// Node 里没有 localStorage —— 必须在 require game.js **之前**装一个，
// 否则 env.setStorageRaw 会被 try/catch 吞掉，存档根本落不了盘。
const mem = {};
global.localStorage = {
  getItem: (k) => (k in mem ? mem[k] : null),
  setItem: (k, v) => { mem[k] = String(v); },
  removeItem: (k) => { delete mem[k]; }
};

const G = require('../../who-is-circle/game.js');

let pass = 0, fail = 0;
function ok(cond, name, extra) {
  if (cond) { pass++; console.log('  ✅ ' + name + (extra ? '  ' + extra : '')); }
  else { fail++; console.log('  ❌ ' + name + (extra ? '  ' + extra : '')); }
}
function section(t) { console.log('\n========== ' + t + ' =========='); }

function readRec(key) {
  const s = mem[key];
  if (!s) return null;
  try { return JSON.parse(s); } catch (e) { return null; }
}

// 合成一个「真圆」的笔迹 —— 它的分数由当前引擎算出来，用来做断言的基准
function circlePts(cx, cy, r, n) {
  const pts = [];
  for (let i = 0; i <= n; i++) {
    const a = -Math.PI / 2 + (i / n) * Math.PI * 2;
    pts.push({ x: cx + r * Math.cos(a), y: cy + r * Math.sin(a), t: i * 30 });
  }
  return pts;
}
const GOOD = circlePts(375, 700, 250, 90);
const GOOD_R = G.evaluate(GOOD);
const GOOD_S = GOOD_R.score;

function reset(best) {
  G.state.best = best;
  G.state.bestPending = null;
  G.state.result = null;
  mem['best_rec'] = '';
  mem['best_rec_prev'] = '';
}

section('一、前置：合成的圆能算出分（后面断言都拿它当基准）');
ok(GOOD_R.valid, '合成的圆是有效的', 'score=' + GOOD_S);
ok(GOOD_S > 0, '分数为正', String(GOOD_S));

section('二、C1：晚到的「有效」结论修正最佳分时，写的是**这一局**的笔迹');

{
  reset(GOOD_S);
  // 先存一条有效存档（分数 GOOD_S，笔迹 GOOD）
  G.saveBestRecord(GOOD_S, GOOD);
  const before = readRec('best_rec');
  ok(before && before.score === GOOD_S, '前置：存档里有一条有效记录', String(before && before.score));

  // 玩家又画了新的一局 —— state.result 已经被顶掉
  const res = {
    score: GOOD_S, localScore: GOOD_S, isNew: true, cloudPending: true,
    pts: circlePts(375, 700, 240, 90),           // ← **这一局**的笔迹
    comment: 'x', fit: { cx: 375, cy: 700, r: 240 }, t0: 0, layout: null
  };
  const NEW_ROUND_PTS = circlePts(375, 700, 120, 60);
  G.state.result = { pts: NEW_ROUND_PTS };       // ← 当前那一局（不同的笔迹）
  G.state.bestPending = null;                    // 已乐观落定
  G.state.best = GOOD_S;

  // 云端结论晚到，分数几乎一样（≤0.15）
  G.onCloudSettled(res, { status: 'ok', verdict: 'ok', score: GOOD_S,
                          cloudScore: GOOD_S, best: GOOD_S, level: 9 });

  const after = readRec('best_rec');
  ok(!!after, '存档写成功了');
  // ⚠️ 存档里的 pts 是**数组**（saveBestRecord 把 encodePts 的返回值直接塞进 rec），
  //    所以比的时候要 JSON.stringify 之后比。
  //    也不能比「第一个点的 x」—— 两个合成圆都在正上方起笔，x 一样 ⇒ 分不出来。
  ok(after && JSON.stringify(after.pts) === JSON.stringify(G.encodePts(res.pts)),
    '**存档写的是这一局的笔迹**（不是 state.result 那一局的）');
  ok(after && JSON.stringify(after.pts) !== JSON.stringify(G.encodePts(NEW_ROUND_PTS)),
    '**没有**写成新一局的笔迹');
  // 最关键：这条存档必须能通过自校验（否则下次启动会作废 → 最高分消失）
  const loaded = G.loadBestRecord();
  ok(loaded !== null && Math.abs(loaded - after.score) < 0.001,
    '**这条存档能通过自校验**（下次启动不会作废 ⇒ 最高分不会消失）',
    'loaded=' + loaded);
}

section('三、C2：晚到的「无效」结论 ⇒ 回退到上一条有效最高分，而不是清零');

{
  reset(GOOD_S);
  // 历史：一条有效最佳分
  G.saveBestRecord(GOOD_S, GOOD);

  // 玩家画了更高的一局 → 乐观落定 → 存档被覆盖，**上一条被挪到 best_rec_prev**
  const HIGHER = GOOD_S + 5;
  G.saveBestRecord(HIGHER, circlePts(375, 700, 260, 90));
  ok(readRec('best_rec').score === HIGHER, '前置：新纪录已写进存档', String(readRec('best_rec').score));
  ok(readRec('best_rec_prev') && readRec('best_rec_prev').score === GOOD_S,
    '**上一条被保留下来了**（best_rec_prev）', String(readRec('best_rec_prev') && readRec('best_rec_prev').score));

  // 云端结论晚到：这一局被判无效
  const res = {
    score: HIGHER, localScore: HIGHER, isNew: true, cloudPending: true,
    pts: circlePts(375, 700, 260, 90), comment: 'x',
    fit: { cx: 375, cy: 700, r: 260 }, t0: 0, layout: null
  };
  G.state.result = res;
  G.state.bestPending = null;
  G.state.best = HIGHER;

  G.onCloudSettled(res, { status: 'shadow', verdict: 'shadow', score: HIGHER,
                          reason: '存在行为异常，成绩不计入最佳' });

  ok(G.state.best === GOOD_S,
    '**本地最佳分回退到上一条有效记录**（不是清零）',
    'best=' + G.state.best + ' 期望=' + GOOD_S);
  const rec = readRec('best_rec');
  ok(rec && rec.score === GOOD_S, '存档也回退了', String(rec && rec.score));
  ok(G.loadBestRecord() !== null, '回退后的存档仍然通过自校验');
}

{
  // **没有上一条**（第一次就破纪录，且这一局被判无效）⇒ 才该清零
  reset(null);
  const ONLY = circlePts(375, 700, 250, 90);
  const s = G.evaluate(ONLY).score;
  G.saveBestRecord(s, ONLY);
  ok(!readRec('best_rec_prev'), '前置：没有上一条');

  const res = {
    score: s, localScore: s, isNew: true, cloudPending: true,
    pts: ONLY, comment: 'x', fit: { cx: 375, cy: 700, r: 250 }, t0: 0, layout: null
  };
  G.state.result = res;
  G.state.bestPending = null;
  G.state.best = s;
  G.onCloudSettled(res, { status: 'reject', verdict: 'reject', score: s, reason: '提交过于频繁' });

  ok(G.state.best === null, '没有上一条 ⇒ 最佳分置 null', 'best=' + G.state.best);
  ok(!mem['best_rec'], '存档被清空');
}

section('四、I6：cloudScore 不是数字时不能把 state.best 变成 undefined');

{
  reset(GOOD_S);
  const res = {
    score: GOOD_S, localScore: GOOD_S, isNew: true, cloudPending: true,
    pts: circlePts(375, 700, 250, 90), comment: 'x',
    fit: { cx: 375, cy: 700, r: 250 }, t0: 0, layout: null
  };
  G.state.result = res;
  G.state.bestPending = { score: GOOD_S, pts: res.pts, cloudPending: true };

  // 云端说 ok，但没给 cloudScore（将来多一条这样的路径就会踩）
  G.onCloudSettled(res, { status: 'ok', verdict: 'ok', score: GOOD_S, best: GOOD_S });

  ok(typeof G.state.bestPending.score === 'number',
    'bestPending.score 仍然是数字（不会变成 undefined）',
    String(G.state.bestPending.score));
  ok(typeof G.state.best === 'number' || G.state.best === null,
    'state.best 仍是数字或 null（渲染时 .toFixed() 不会炸）', String(G.state.best));
}

console.log(`\n结果：${pass} 通过 / ${fail} 失败\n`);
process.exit(fail ? 1 : 0);
