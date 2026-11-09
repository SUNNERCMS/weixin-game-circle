/**
 * 清理逻辑（纯函数，不碰 wx-server-sdk —— 所以能被单元测试直接跑）
 *
 * 干什么：把 `submissions`（审计记录）里超过保留期的老记录删掉。
 *
 * 为什么必须有：隐私保护指引里声明了「审计记录保留 30 天」。
 * 声明与实际必须一致 —— 不删就是骗用户，审核也可能因此被打回。
 *
 * ⚠️ 保留期改成别的天数，**必须同步改隐私保护指引**（后台「服务内容声明」）。
 * 环境变量 CLEANUP_RETENTION_DAYS 可以临时覆盖（用于演练），
 * 但覆盖时会在日志里喊一声，别悄悄跑偏。
 */

var RETENTION_DAYS = 30;      // 保留天数（与隐私保护指引一致）
var DAY_SEC = 86400;
var BATCH_SIZE = 100;         // 单批删多少条：in 查询的元素数上限是 100
var MAX_BATCHES = 20;         // 单次触发最多删几批（20×100 = 2000 条，防函数超时）

/**
 * 过期时间点：早于它的记录该删。
 * @param {number} nowSec       当前 Unix 秒
 * @param {number} [retentionDays] 保留天数，非法值 → 用默认
 */
function computeCutoff(nowSec, retentionDays) {
  var days = (typeof retentionDays === 'number' && retentionDays > 0) ? retentionDays : RETENTION_DAYS;
  return Math.floor(nowSec) - days * DAY_SEC;
}

/**
 * 这条记录过期了吗？
 * 只有 ts 是数字且早于 cutoff 才算 —— 缺 ts / ts 不是数字的一律**不删**：
 * 宁可留着，也别误删（审计数据误删比不删严重）。
 */
function isExpired(doc, cutoff) {
  return !!(doc && typeof doc.ts === 'number' && doc.ts < cutoff);
}

/** 从一批文档里挑出该删的 */
function pickExpired(docs, cutoff) {
  var out = [];
  var list = docs || [];
  for (var i = 0; i < list.length; i++) {
    if (isExpired(list[i], cutoff)) out.push(list[i]);
  }
  return out;
}

/**
 * 把文档切成批，每批的 _id 数量不超过 size。
 * @returns {Array<Array<string>>}
 */
function chunkIds(docs, size) {
  var n = (typeof size === 'number' && size > 0) ? size : BATCH_SIZE;
  var list = docs || [];
  var out = [];
  for (var i = 0; i < list.length; i += n) {
    var batch = [];
    for (var j = i; j < i + n && j < list.length; j++) batch.push(list[j]._id);
    out.push(batch);
  }
  return out;
}

/**
 * 算一次触发的完整计划（纯计算，不做 IO）。
 * @param {Array} docs          候选文档
 * @param {number} nowSec       当前 Unix 秒
 * @param {object} [opts]       {retentionDays, batchSize, maxBatches}
 */
function plan(docs, nowSec, opts) {
  var o = opts || {};
  var cutoff = computeCutoff(nowSec, o.retentionDays);
  var expired = pickExpired(docs, cutoff);
  var batches = chunkIds(expired, o.batchSize);
  var maxBatches = (typeof o.maxBatches === 'number' && o.maxBatches > 0) ? o.maxBatches : MAX_BATCHES;
  var capped = batches.slice(0, maxBatches);
  return {
    cutoff: cutoff,
    expiredCount: expired.length,
    batchCount: capped.length,
    batches: capped,
    truncated: capped.length < batches.length
  };
}

module.exports = {
  RETENTION_DAYS: RETENTION_DAYS,
  DAY_SEC: DAY_SEC,
  BATCH_SIZE: BATCH_SIZE,
  MAX_BATCHES: MAX_BATCHES,
  computeCutoff: computeCutoff,
  isExpired: isExpired,
  pickExpired: pickExpired,
  chunkIds: chunkIds,
  plan: plan
};
