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
    const hi = circlePoints({ r: 180, noise: 0.35 });
    const lo = circlePoints({ r: 120, noise: 4.5 });
    const a = makeEvent(hi), b = makeEvent(lo);
    const r1 = await core.handle(a.ev, { OPENID: 'o_8' }, db);
    const r2 = await core.handle(b.ev, { OPENID: 'o_8' }, db);
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

  console.log(`\n结果：${pass} 通过 / ${fail} 失败\n`);
  process.exit(fail ? 1 : 0);
})().catch(e => {
  console.error('\n💥 测试执行异常：', e);
  process.exit(1);
});
