/**
 * 云函数 `score` 的核心逻辑 —— **纯逻辑，不依赖 wx-server-sdk**
 *
 * 为什么把逻辑和 SDK 拆开：
 *   wx-server-sdk 只在云端环境存在，Node 里 require 会直接崩。
 *   拆开后 core.js 可以被单元测试直接 require，用内存 db 跑完整流程，
 *   不必真连云端 —— 云端调用只是最后 20 行的事（index.js 里）。
 *
 * 这里 require 的 './scoring.js' 是**从 shared/scoring.js 同步过来的副本**
 * （npm run sync:cloud），与主域跑的是同一份算法字节。有守卫测试比对两者的 sha256。
 *
 * 依赖注入的两个对象：
 *   ctx = { OPENID, APPID, ENV }          —— 身份（只信云端 getWXContext，不信客户端传的）
 *   db  = { getScore, setScore, addSubmission, findSubmissionByHash, recentSubmissions }
 */
var S = require('./scoring.js');

// 点数上限，与主域 game.js 的 CFG.MAX_POINTS 一致（守卫测试比对两处）
var MAX_POINTS = 900;

// 近似重放比对只拉最近 N 条 submissions
var REPLAY_SCAN_LIMIT = 200;

// submissions 只保留最近 7 天（云端没有定时清理，靠量级撑；过期数据由查询的 ts 范围自然排除）
var SUBMISSION_KEEP_SEC = 7 * 86400;

// 速率限制：窗口 60 秒内最多 5 次
var RATE_WINDOW_SEC = 60;
var RATE_MAX = 5;

/**
 * 处理一次算分请求。
 * @param {object} event 客户端上报：{ pts, clientScore, clientBest, sig, guard }
 * @param {object} ctx   { OPENID, APPID, ENV }
 * @param {object} db    存储接口（见文件头）
 * @param {object} opts  可覆盖的时间/阈值（测试用）
 * @returns {Promise<object>} 出参（见 cloudfunctions/score/README.md）
 */
async function handle(event, ctx, db, opts) {
  opts = opts || {};
  var nowMs = typeof opts.now === 'number' ? opts.now : Date.now();
  var nowSec = Math.floor(nowMs / 1000);
  var scanLimit = opts.replayScanLimit || REPLAY_SCAN_LIMIT;
  var rateWindowSec = opts.rateWindowSec || RATE_WINDOW_SEC;
  var rateMax = opts.rateMax || RATE_MAX;
  // 干跑：只算分与判定，**不落库**。
  // 用于内部自检（云调用没有微信上下文，只能这样验证云端算分是否与客户端一致），
  // 也保证自检不会污染真实榜单。干跑时也不做重放检测 —— 读到的真实历史会让结果不确定。
  var dryRun = !!opts.dryRun;

  var OPENID = ctx && ctx.OPENID;
  if (!OPENID) {
    return result('reject', null, '未登录', null, null);
  }

  // ---- sync 模式：只回答「云端权威最高分是多少」----
  //
  // 为什么需要它（2026-11-07 审计）：云端账本（scores）是权威，托管数据是它的公开副本，
  // 而托管数据**是客户端写的** —— 写失败就没有重试（见 js/cloud.js 的修复）。
  // 于是会出现「云端有分、榜上没有」的永久不一致。
  //
  // 这个模式让客户端**随时能对账**：拿云端的 best 补写托管数据。
  // 幂等、免费（不判定、不写 submissions、不计速率）。
  if (event && event.action === 'sync') {
    var m = await db.getScore(OPENID);
    var b = (m && typeof m.score === 'number') ? m.score : 0;
    return {
      ok: true, sync: true, verdict: 'ok',
      score: b, best: b, level: levelIndex(b),
      reason: '', newBest: false, replay: false, dryRun: !!dryRun,
      bestVerdict: (m && typeof m.bestVerdict === 'string') ? m.bestVerdict : 'ok'
    };
  }

  var ev = event || {};

  // ---- 2. 解码笔迹 ----
  var pts;
  try {
    pts = S.decodePts(ev.pts || []);
  } catch (e) {
    return result('reject', null, '笔迹数据损坏', null, null);
  }
  if (!pts.length) return result('reject', null, '空笔迹', null, null);
  if (pts.length > MAX_POINTS) {
    return result('reject', null, '点数超限（' + pts.length + ' > ' + MAX_POINTS + '）', null, null);
  }

  // ---- 3. 云端重算 ----
  var r = S.evaluate(pts);
  if (!r.valid) {
    var tip = S.INVALID_TIPS[r.reason] || r.reason || '无效笔迹';
    return result('reject', null, tip, null, null);
  }

  // ---- 4. 云端独立跑防作弊 ----
  // raw 里的 h 用 t 顶替：上传协议只带 pts（encodePts 不编码 h），
  // 没有真实的"回调执行时刻"，clock_drift 因此在云端**恒不命中**。
  // 这不是 bug 也不是忘了 —— 是明确取舍，note 里对调用方讲清楚（见 README）。
  var raw = new Array(pts.length);
  for (var i = 0; i < pts.length; i++) {
    raw[i] = { t: pts[i].t, h: pts[i].t, x: pts[i].x, y: pts[i].y };
  }
  var sig = normalizeSig(ev.sig);
  // 第 4 个参数传 null：客户端的环境标记（untrusted/webdriver）云端不采信，
  // 云端只依据自己重算出来的数据判定。
  var g = S.guardCheck(raw, r.fit, r.score, null);

  var cloudGuard = {
    risk: g.risk,
    hits: g.hits,
    hard: g.hard,
    note: '判定完全基于云端重算；clock_drift 未独立复核（上传协议不含回调时刻 h）'
  };

  // ---- 7. 重放检测（judge 需要它，必须先做）----
  var replay = false;
  var sigHash = sig ? S.fnv(JSON.stringify(sig)) : '';
  if (sig && !dryRun) {
    // 一次查询 + 内存比对，**不依赖任何索引**：
    //   云数据库的 orderBy 强制要求字段有索引，而 wx-server-sdk 没有建索引的接口
    //   （索引只能在控制台手工建）。所以这里用 ts 范围过滤（where 不要求索引），
    //   拉回来后在内存里按 ts 倒序。
    //   代价：单次最多取 1000 条；7 天内提交量超过 1000 时会漏掉一部分历史。
    //   那个量级到来时，应在控制台给 ts 建索引，再把这里换成 orderBy('ts','desc')。
    var recent = await db.recentSubmissions(nowSec - SUBMISSION_KEEP_SEC, scanLimit);
    var hist = [];
    for (var j = 0; j < recent.length; j++) {
      var rec = recent[j];
      if (!rec) continue;
      if (rec.sigHash && rec.sigHash === sigHash) {   // 精确重放：同一份笔迹
        replay = true;
        break;
      }
      if (Array.isArray(rec.sig)) hist.push(rec.sig);
    }
    if (!replay) replay = S.isReplay(sig, hist);       // 近似重放：形状几乎一样
  }

  // ---- 5. 判定（三档语义之外还有 unverified；不传 dev：服务端没有开发豁免）----
  var verdict = S.judge(r, g, replay, false);

  // ---- 6. 速率限制 ----
  var mine = await db.getScore(OPENID);
  var recentSubmits = (mine && Array.isArray(mine.recentSubmits)) ? mine.recentSubmits.slice() : [];
  recentSubmits = recentSubmits.filter(function (t) {
    return typeof t === 'number' && (nowSec - t) < rateWindowSec;
  });
  if (recentSubmits.length >= rateMax) {
    if (!dryRun) {
      await db.addSubmission(submissionDoc(OPENID, sig, sigHash, r.score, 'reject', nowSec, ev, 'rate_limit'));
    }
    var out = result('reject', r.score, '提交过于频繁，请稍后再试', null, cloudGuard);
    out.best = mine && typeof mine.score === 'number' ? mine.score : 0;
    out.dryRun = dryRun;
    return out;
  }

  // ---- 8. 落库（干跑模式跳过，自检不污染真实榜单）----
  //
  // scores 集合的语义：**服务端权威「有效」最高分** + 防作弊状态（速率/时间戳）。
  // 被判无效的成绩不计入最佳 —— 否则一次作弊就把这个玩家的最高分永久顶住，
  // 而且客户端本地最佳分与云端 best 会永久对不上。
  // 口径细节见 buildScoreRow（那里也写了"为什么不能干脆不写"）。
  var built = buildScoreRow(mine, verdict, r.score, nowSec, recentSubmits);
  var newBest = built.newBest;
  var nextBest = built.nextBest;

  if (!dryRun) {
    // submissions：每次都写（含被拒的），用于重放检测与审计
    await db.addSubmission(submissionDoc(OPENID, sig, sigHash, r.score, verdict, nowSec, ev, null));

    // scores：分数字段只在成绩**有效**时更新；速率信息每次都要更新
    await db.setScore(OPENID, built.row);
  }

  var out = result(verdict, r.score, verdict === 'ok' ? '' : verdictText(verdict), nextBest, cloudGuard);
  out.newBest = newBest;
  out.best = nextBest;
  out.level = levelIndex(nextBest);
  out.replay = replay;
  out.dryRun = dryRun;
  // 客户端自报分与云端权威分的差 —— P2 的验收指标就是它 ≤ 0.1
  out.scoreDelta = (typeof ev.clientScore === 'number')
    ? Math.round((r.score - ev.clientScore) * 10000) / 10000
    : null;
  // 客户端的 guard 仅回显对比，不参与判定（判定已在上面独立完成）
  out.clientGuard = ev.guard || null;
  return out;
}

// ---------- 小工具 ----------

/**
 * 算出要写进 scores 的那一行。
 *
 * 拆成纯函数是为了能**直接测各种 verdict 的落库口径** ——
 * shadow / unverified 这两档在真实笔迹里很难稳定复现
 * （judge() 里 `score >= 99 && risk > 0` 就判 shadow，干净笔迹试不出来），
 * 端到端跑是测不出来的。
 *
 * 口径（设计文档 §7.4）：
 *   - ok / unverified → 分数**计入**最佳（unverified 只是标出来，不是给零分）
 *   - shadow / reject → 分数**不计入**最佳
 *
 * ⚠️ 成绩无效时**不能干脆不写 scores**：recentSubmits 是速率限制的基准，
 * 不写等于限流失效（可以无限提交刷榜）。所以分数字段沿用原值，防作弊字段照常更新。
 *
 * ⚠️ setScore 用的是 set（**覆盖**语义），不传的字段会被清空 ——
 * 所以无效成绩那一路必须把原值原样带回来。
 *
 * @param {object|null} mine  现有的 scores 文档（没有则 null）
 * @param {string} verdict    本次判定
 * @param {number} score      本次云端重算出的分
 * @param {number} nowSec     当前 Unix 秒
 * @param {Array}  recentSubmits  速率窗口内的提交时间戳
 * @returns {{row: object, valid: boolean, newBest: boolean, nextBest: number}}
 */
function buildScoreRow(mine, verdict, score, nowSec, recentSubmits) {
  var valid = (verdict === 'ok' || verdict === 'unverified');
  var best = (mine && typeof mine.score === 'number') ? mine.score : 0;
  var newBest = valid && score > best;
  var nextBest = newBest ? score : best;
  // 当前最佳分那一局的结论（sync 模式要返回它 —— 免得把「未完全验证」标成「已验证」）
  var nextVerdict = newBest ? verdict
    : ((mine && typeof mine.bestVerdict === 'string') ? mine.bestVerdict : 'ok');
  var row = {
    score: nextBest,
    // 段位跟着最高分走；成绩无效时沿用原值（set 是覆盖语义，不带回去会被清空）
    level: valid ? levelIndex(nextBest)
                 : ((mine && typeof mine.level === 'number') ? mine.level : levelIndex(nextBest)),
    // updatedAt = 分数最后更新时间：成绩无效说明分数没变，时间也不该动
    updatedAt: valid ? nowSec
                      : ((mine && typeof mine.updatedAt === 'number') ? mine.updatedAt : 0),
    lastSubmitAt: nowSec,
    bestVerdict: nextVerdict,
    recentSubmits: recentSubmits.concat([nowSec])
  };
  return { row: row, valid: valid, newBest: newBest, nextBest: nextBest };
}

// sig 必须是 64 个数字的数组（shapeSig 的输出）。形状不对就当没有 ——
// 拿不到指纹只是少一道重放防线，不该让整次请求失败。
function normalizeSig(sig) {
  if (!Array.isArray(sig) || sig.length !== 64) return null;
  var out = new Array(64);
  for (var i = 0; i < 64; i++) {
    var v = Number(sig[i]);
    if (!isFinite(v)) return null;
    out[i] = v;
  }
  return out;
}

// 段位索引：复用 getRank 的结果对象在 RANKS 里的位置，
// 不自己重写一遍"找段位"的逻辑（避免与主域漂移）
function levelIndex(score) {
  var rk = S.getRank(score);
  var idx = S.RANKS.indexOf(rk.rank);
  return idx < 0 ? 0 : idx;
}

function verdictText(verdict) {
  if (verdict === 'shadow') return '存在行为异常，成绩不计入最佳';
  if (verdict === 'unverified') return '存在可疑特征，成绩未完全验证';
  return '';
}

function submissionDoc(openid, sig, sigHash, score, verdict, ts, ev, reason) {
  return {
    openid: openid,
    sig: sig || [],
    sigHash: sigHash || '',
    score: score,
    verdict: verdict,
    reason: reason || '',
    clientScore: (typeof ev.clientScore === 'number') ? ev.clientScore : null,
    clientGuard: ev.guard || null,
    ts: ts
  };
}

function result(verdict, score, reason, best, cloudGuard) {
  return {
    ok: verdict !== 'reject',
    verdict: verdict,
    score: (typeof score === 'number') ? score : 0,
    level: 0,
    newBest: false,
    best: (typeof best === 'number') ? best : 0,
    reason: reason || '',
    cloudGuard: cloudGuard || null,
    clientGuard: null,
    scoreDelta: null,
    replay: false,
    dryRun: false
  };
}

module.exports = {
  handle: handle,
  buildScoreRow: buildScoreRow,
  MAX_POINTS: MAX_POINTS,
  REPLAY_SCAN_LIMIT: REPLAY_SCAN_LIMIT,
  RATE_WINDOW_SEC: RATE_WINDOW_SEC,
  RATE_MAX: RATE_MAX
};
