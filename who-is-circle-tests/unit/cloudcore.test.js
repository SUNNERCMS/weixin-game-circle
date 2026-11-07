/**
 * 云函数 `score` 核心逻辑单元测试（cloudfunctions/score/core.js）
 *
 * 作用：在**不连云端**的前提下，把云端算分这条路的每条分支都跑一遍。
 *      core.js 刻意不依赖 wx-server-sdk（db 接口是注入的），
 *      所以这里用内存 Map 当数据库，能覆盖真云端跑起来又贵又慢的路径。
 *
 * 覆盖的关键不变式：
 *   - 云端算的分 = 客户端算的分（误差 ≤ 0.1）—— P2 的验收指标
 *   - 云端**重算**而非采信上报分（传假分不影响结果）
 *   - 重放检测拦得住同一份笔迹
 *   - 速率限制拦得住刷分
 *   - 客户端上报的 guard 不参与判定（云端独立判）
 *   - clock_drift 的取舍在**出参里**看得见（不默默失效）
 *
 * 运行：node unit/cloudcore.test.js   （退出码非 0 = 有用例失败）
 */
const S = require('../../who-is-circle/shared/scoring.js');
const core = require('../../who-is-circle/cloudfunctions/score/core.js');
const G = require('../../who-is-circle/game.js');

let pass = 0, fail = 0;
function ok(cond, name, extra) {
  if (cond) { pass++; console.log('  ✅ ' + name + (extra ? '  ' + extra : '')); }
  else { fail++; console.log('  ❌ ' + name + (extra ? '  ' + extra : '')); }
}

// ---------- 造一笔"像真人画的圆" ----------
function circlePoints(opts) {
  opts = opts || {};
  const r = opts.r || 180, cx = opts.cx || 375, cy = opts.cy || 800;
  const n = opts.n || 240, noise = opts.noise === undefined ? 1.6 : opts.noise;
  const dur = opts.dur || 1200, jitter = opts.jitter === undefined ? 4 : opts.jitter;
  const pts = [];
  for (let i = 0; i <= n; i++) {
    const a = (i / n) * Math.PI * 2;
    const rr = r + (Math.random() - 0.5) * 2 * noise;
    const t = dur * i / n + (Math.random() - 0.5) * jitter;
    pts.push({ x: cx + rr * Math.cos(a), y: cy + rr * Math.sin(a), t: t });
  }
  return pts;
}

// ---------- 内存数据库 ----------
function makeDb() {
  const scoreRows = new Map();
  const subs = [];
  return {
    scoreRows: scoreRows,
    subs: subs,
    async getScore(openid) { return scoreRows.get(openid) || null; },
    async setScore(openid, data) { scoreRows.set(openid, Object.assign({}, data)); },
    async addSubmission(data) { subs.push(Object.assign({}, data)); },
    // 与真云端同签名：取 sinceTs 之后的记录，按 ts 倒序取前 limit 条
    async recentSubmissions(sinceTs, limit) {
      return subs
        .filter(s => (s.ts || 0) >= sinceTs)
        .sort((a, b) => (b.ts || 0) - (a.ts || 0))
        .slice(0, limit);
    }
  };
}

// 客户端视角的"上报包"
function makeEvent(pts, extra) {
  const r = S.evaluate(pts);
  const sig = S.shapeSig(pts, r.fit);
  const ev = {
    pts: S.encodePts(pts),
    clientScore: r.valid ? r.score : null,
    clientBest: null,
    sig: sig,
    guard: { hard: [], risk: 0, hits: [] }
  };
  if (extra) Object.assign(ev, extra);
  return { ev: ev, clientScore: r.score };
}

(async function main() {
  console.log('\n========== 一、云端分 = 客户端分（P2 核心验收） ==========');

  {
    const pts = circlePoints();
    const { ev, clientScore } = makeEvent(pts);
    const db = makeDb();
    const out = await core.handle(ev, { OPENID: 'o_1' }, db);
    ok(out.scoreDelta !== null, '出参带 scoreDelta（云端分 − 客户端分）', 'Δ=' + out.scoreDelta);
    ok(Math.abs(out.scoreDelta) <= 0.1, '云端分与客户端分误差 ≤ 0.1',
      '云端=' + out.score + ' 客户端=' + clientScore);
    ok(out.ok === true, 'verdict 不是 reject', out.verdict);
  }

  console.log('\n========== 二、云端是"重算"而非"采信上报分" ==========');

  {
    const pts = circlePoints();
    const { ev, clientScore } = makeEvent(pts);
    ev.clientScore = 999.9;                 // 谎报高分
    const db = makeDb();
    const out = await core.handle(ev, { OPENID: 'o_2' }, db);
    ok(Math.abs(out.score - clientScore) <= 0.1,
      '客户端谎报 999.9 分，云端仍返回真实分', '云端=' + out.score);
    ok(Math.abs(out.scoreDelta) > 900, 'scoreDelta 如实反映差距', 'Δ=' + out.scoreDelta);
  }

  console.log('\n========== 三、无效与越界一律拒绝 ==========');

  {
    const db = makeDb();
    const out = await core.handle({ pts: [] }, { OPENID: 'o_3' }, db);
    ok(out.verdict === 'reject', '空笔迹 → reject', out.reason);
  }
  {
    const db = makeDb();
    const out = await core.handle({ pts: [[1, 1, 1]] }, {}, db);
    ok(out.verdict === 'reject', '没有 OPENID → reject', out.reason);
  }
  {
    // 一条直线：evaluate 判 line
    const pts = [];
    for (let i = 0; i < 40; i++) pts.push({ x: 100 + i * 5, y: 500, t: i * 10 });
    const { ev } = makeEvent(pts);
    const db = makeDb();
    const out = await core.handle(ev, { OPENID: 'o_4' }, db);
    ok(out.verdict === 'reject', '一条直线 → reject', out.reason);
  }
  {
    // 点数超限
    const N = core.MAX_POINTS + 10;
    const many = [];
    for (let i = 0; i <= N; i++) {
      const a = (i / N) * Math.PI * 2;
      many.push({ x: 375 + 180 * Math.cos(a), y: 800 + 180 * Math.sin(a), t: i * 3 });
    }
    const { ev } = makeEvent(many);
    const db = makeDb();
    const out = await core.handle(ev, { OPENID: 'o_5' }, db);
    ok(out.verdict === 'reject', '点数超限 → reject', out.reason);
  }

  console.log('\n========== 四、重放检测 ==========');

  {
    const pts = circlePoints();
    const { ev } = makeEvent(pts);
    const db = makeDb();
    const first = await core.handle(ev, { OPENID: 'o_6' }, db);
    const second = await core.handle(ev, { OPENID: 'o_other' }, db);
    ok(first.replay === false, '首次提交不是重放');
    ok(second.replay === true, '同一份笔迹再交 → 判定为重放');
    ok(db.subs.length === 2, '两次都写进 submissions（审计）', '条数=' + db.subs.length);
  }

  console.log('\n========== 五、速率限制 ==========');

  {
    const db = makeDb();
    let last = null;
    for (let i = 0; i < 6; i++) {
      const pts = circlePoints({ cx: 300 + i * 10 });   // 每次都不同，避免被重放拦下
      const { ev } = makeEvent(pts);
      last = await core.handle(ev, { OPENID: 'o_7' }, db);
    }
    ok(last.verdict === 'reject', '同一玩家 60 秒内第 6 次提交 → reject', last.reason);
    ok(/频繁/.test(last.reason || ''), '拒绝理由说明了原因', last.reason);
  }

  console.log('\n========== 六、最高分只升不降 ==========');

  {
    const db = makeDb();
    // 笔迹噪声不能太小：judge() 里 `score >= 99 && risk > 0` 会判 shadow
    //（"太完美 = 像机器人"）。这里要的是两局**都判 ok**、且一局明显更高的正常笔迹。
    const hi = circlePoints({ r: 180, noise: 2.2 });
    const lo = circlePoints({ r: 120, noise: 4.5 });
    const a = makeEvent(hi), b = makeEvent(lo);
    const r1 = await core.handle(a.ev, { OPENID: 'o_8' }, db);
    const r2 = await core.handle(b.ev, { OPENID: 'o_8' }, db);
    ok(r1.verdict === 'ok', '第一局判 ok（控制组：前提成立）', r1.verdict);
    ok(r1.newBest === true, '首次提交 → newBest=true', '分=' + r1.score);
    ok(r2.newBest === false, '更低分再交 → newBest=false', '分=' + r2.score);
    ok(r2.best >= r1.score, 'best 不因低分而下降', 'best=' + r2.best);
  }

  console.log('\n========== 七、云端独立判定，客户端上报不参与 ==========');

  {
    const pts = circlePoints();
    const { ev } = makeEvent(pts);
    ev.guard = { hard: ['untrusted'], risk: 99, hits: ['time_reverse'] };   // 客户端自称有硬作弊
    const db = makeDb();
    const out = await core.handle(ev, { OPENID: 'o_9' }, db);
    ok(out.verdict !== 'reject', '客户端自称 hard 不会让云端 reject（云端自己判）', out.verdict);
    ok(out.clientGuard && out.clientGuard.risk === 99, '客户端 guard 原样回显（供审计对比）');
    ok(out.cloudGuard && out.cloudGuard.note.indexOf('clock_drift') >= 0,
      'cloudGuard.note 明说 clock_drift 未独立复核（不默默失效）');
  }

  console.log('\n========== 八、与主域的常量一致 ==========');

  ok(core.MAX_POINTS === G.CFG.MAX_POINTS, '云端点数上限与主域 CFG.MAX_POINTS 一致',
    core.MAX_POINTS + ' vs ' + G.CFG.MAX_POINTS);

  console.log('\n========== 九、干跑模式（内部自检通道）不落库 ==========');
  // 云调用没有微信上下文，只能靠干跑模式验证"云端算的分 == 客户端算的分"。
  // 它必须只算不写 —— 否则自检会往真实榜单里塞垃圾分。

  {
    const pts = circlePoints();
    const { ev, clientScore } = makeEvent(pts);
    const db = makeDb();
    const out = await core.handle(ev, { OPENID: 'o_dry' }, db, { dryRun: true });
    ok(out.dryRun === true, '出参标记 dryRun=true');
    ok(db.subs.length === 0, '干跑不写 submissions（不污染审计记录）', '条数=' + db.subs.length);
    ok(db.scoreRows.size === 0, '干跑不写 scores（不污染榜单）', '条数=' + db.scoreRows.size);
    ok(out.scoreDelta !== null && Math.abs(out.scoreDelta) <= 0.1,
      '干跑仍然算出与客户端一致的权威分', 'Δ=' + out.scoreDelta);
    ok(out.score === clientScore, '干跑给出的分与客户端分相同', out.score + ' vs ' + clientScore);
  }
  {
    // 干跑模式下重放检测必须跳过 —— 读到的真实历史会让自检结果不确定
    const pts = circlePoints();
    const { ev } = makeEvent(pts);
    const db = makeDb();
    db.subs.push({ openid: 'someone', sig: ev.sig, sigHash: 'x', score: 1, verdict: 'ok', ts: Math.floor(Date.now() / 1000) });
    const out = await core.handle(ev, { OPENID: 'o_dry' }, db, { dryRun: true });
    ok(out.replay === false, '干跑不做重放检测（结果确定）');
  }

  console.log('\n========== 十、scores 的语义：无效成绩不计入最佳，限流字段照常更新 ==========');
  // scores 集合 = 服务端权威「有效」最高分 + 防作弊状态。
  // 被判无效（shadow / reject）的成绩不能抬高 scores.score —— 否则一次作弊就把
  // 这个玩家的最高分永久顶住，而且客户端本地最佳分与云端 best 会永久对不上。
  // 但 recentSubmits（速率限制的基准）**必须照常更新**，不写就等于限流失效。

  {
    const db = makeDb();
    // 注意：笔迹噪声别给太小 —— judge() 里 `score >= 99 && risk > 0` 会判 shadow
    //（"太完美 = 像机器人"）。这里要的是一局能判 ok 的正常笔迹。
    const pts = circlePoints();
    const { ev } = makeEvent(pts);
    const first = await core.handle(ev, { OPENID: 'o_10' }, db);
    ok(first.verdict === 'ok', '第一笔 → ok', first.verdict);
    const row1 = db.scoreRows.get('o_10');
    const best1 = row1.score;
    ok(best1 > 0, 'scores 记下了有效最高分', 'score=' + best1);

    // 同一份笔迹再交 → 重放 → shadow
    const again = await core.handle(ev, { OPENID: 'o_10' }, db);
    ok(again.verdict === 'shadow', '同一份笔迹再交 → shadow', again.verdict);
    ok(again.newBest === false, '被判无效 → 不算新纪录');
    ok(again.best === best1, '出参 best 也不被无效成绩抬高', 'best=' + again.best);

    const row2 = db.scoreRows.get('o_10');
    ok(row2.score === best1, '**scores.score 不被无效成绩抬高**', best1 + ' → ' + row2.score);
    ok(row2.level === row1.level, 'level 也不变（段位跟着最高分走）');
    ok(row2.updatedAt === row1.updatedAt, 'updatedAt（分数最后更新时间）不变');
    ok(row2.recentSubmits.length === 2, '**但 recentSubmits 照常更新**（速率限制的基准，不能不写）',
      'len=' + row2.recentSubmits.length);
    ok(typeof row2.lastSubmitAt === 'number', 'lastSubmitAt 照常更新');
    ok(db.subs.length === 2, 'submissions 两条都在（审计完整）', 'len=' + db.subs.length);
    ok(db.subs[1].verdict === 'shadow', '第二条审计记录 verdict=shadow');
  }

  {
    // 玩家的**第一笔**就是被判无效：行要建（限流字段得落），但分数必须是 0
    const db = makeDb();
    const pts = circlePoints();
    const { ev } = makeEvent(pts);
    const sigHash = S.fnv(JSON.stringify(ev.sig));
    db.subs.push({ openid: 'someone', sig: ev.sig, sigHash: sigHash, score: 1, verdict: 'ok', ts: Math.floor(Date.now() / 1000) });
    const out = await core.handle(ev, { OPENID: 'o_13' }, db);
    ok(out.verdict === 'shadow', '预置同一份笔迹 → 第一笔就判 shadow', out.verdict);
    const row = db.scoreRows.get('o_13');
    ok(!!row, '被判无效也要建 scores 行（限流字段要落）');
    ok(row.score === 0, '但分数是 0（无效成绩不进榜）', 'score=' + row.score);
    ok(row.recentSubmits.length === 1, '限流字段照常落库', 'len=' + row.recentSubmits.length);
  }

  {
    // unverified / ok：分数都要计入最佳（unverified 只是"标出来"，不是"不给分"）
    // 这两档在真实笔迹里很难稳定复现，所以直接测落库口径的纯函数
    const mine = { score: 90, level: 3, updatedAt: 111, recentSubmits: [] };
    const okRow = core.buildScoreRow(mine, 'ok', 95.5, 222, []);
    const unvRow = core.buildScoreRow(mine, 'unverified', 95.5, 222, []);
    ok(okRow.row.score === 95.5, 'ok → 分数计入最佳', 'score=' + okRow.row.score);
    ok(unvRow.row.score === 95.5, 'unverified → **分数也给**（只是标出来）', 'score=' + unvRow.row.score);
    ok(unvRow.row.level === okRow.row.level, 'unverified 的段位与最高分同口径');
    ok(unvRow.row.updatedAt === 222, 'unverified → updatedAt 更新（分数确实变了）');
    ok(unvRow.newBest === true, 'unverified → 算新纪录');

    const shadowRow = core.buildScoreRow(mine, 'shadow', 95.5, 222, []);
    ok(shadowRow.row.score === 90, 'shadow → **分数不计入最佳**', 'score=' + shadowRow.row.score);
    ok(shadowRow.row.level === 3, 'shadow → 段位不变');
    ok(shadowRow.row.updatedAt === 111, 'shadow → updatedAt 不动');
    ok(shadowRow.row.recentSubmits.length === 1, 'shadow → 限流字段照常更新', 'len=' + shadowRow.row.recentSubmits.length);
    ok(shadowRow.newBest === false, 'shadow → 不算新纪录');

    const rejectRow = core.buildScoreRow(mine, 'reject', 95.5, 222, []);
    ok(rejectRow.row.score === 90, 'reject → 分数不计入最佳', 'score=' + rejectRow.row.score);

    // 没有历史记录时的默认值
    const fresh = core.buildScoreRow(null, 'shadow', 95.5, 222, []);
    ok(fresh.row.score === 0, '没有历史 + 无效成绩 → 分数 0', 'score=' + fresh.row.score);
    ok(fresh.row.recentSubmits.length === 1, '没有历史也要落限流字段');
  }

  {
    // 「太完美 = 像机器人」：judge() 里 score >= 99 && risk > 0 → shadow
    // 这个行为直接决定玩家体验（画得越圆越可能不上榜），必须锁住
    const db = makeDb();
    const pts = circlePoints({ noise: 0.35 });   // ≈100 分
    const { ev } = makeEvent(pts);
    const out = await core.handle(ev, { OPENID: 'o_15' }, db);
    ok(out.verdict === 'shadow', '接近完美的圆（≈100 分）被判 shadow', out.verdict);
    ok(out.newBest === false, '→ 不算新纪录');
    ok(db.scoreRows.get('o_15').score === 0, '→ 不进榜（scores 记 0）', 'score=' + db.scoreRows.get('o_15').score);
  }

  console.log('\n========== 九、sync 模式（对账） ==========');

{
  // 云端账本是权威，托管数据是它的公开副本（副本由客户端写）。
  // sync 模式让客户端随时能问「我的最高分是多少」⇒ 托管数据落后时补写。
  // 它必须**便宜且无副作用**：不判定、不写 submissions、不计速率。
  const calls = { getScore: 0, setScore: 0, addSubmission: 0 };
  const db = {
    getScore: async () => { calls.getScore++; return { score: 76.3, level: 7, bestVerdict: 'ok' }; },
    setScore: async () => { calls.setScore++; },
    addSubmission: async () => { calls.addSubmission++; },
    recentSubmissions: async () => []
  };
  const out = await core.handle({ action: 'sync' }, { OPENID: 'o_1' }, db);
  ok(out && out.sync === true, 'sync 模式被识别', JSON.stringify(out && out.ok));
  ok(out && out.best === 76.3, '返回云端权威最高分', String(out && out.best));
  ok(out && out.level === 7, '返回对应段位（按 76.3 算出来的那一档）', String(out && out.level));
  ok(out && out.bestVerdict === 'ok', '返回最佳分那一局的结论', String(out && out.bestVerdict));
  ok(calls.setScore === 0, '**不写** scores', String(calls.setScore));
  ok(calls.addSubmission === 0, '**不写** submissions', String(calls.addSubmission));
}

{
  // 没有记录 → best = 0（客户端据此判断「没什么可补的」）
  const db = {
    getScore: async () => null,
    setScore: async () => {},
    addSubmission: async () => {},
    recentSubmissions: async () => []
  };
  const out = await core.handle({ action: 'sync' }, { OPENID: 'o_new' }, db);
  ok(out && out.best === 0, '没有记录 → best=0', String(out && out.best));
}

console.log(`\n结果：${pass} 通过 / ${fail} 失败\n`);
  process.exit(fail ? 1 : 0);
})().catch(e => {
  console.error('\n💥 测试执行异常：', e);
  process.exit(1);
});
