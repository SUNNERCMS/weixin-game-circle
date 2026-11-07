/**
 * 云函数 `cleanup` —— 清掉过期的审计记录
 *
 * 干什么：把 `submissions` 里超过保留期（30 天）的记录删掉。
 *
 * 为什么必须有：隐私保护指引里声明了「审计记录保留 30 天」，
 * 声明与实际必须一致 —— 不删就是骗用户。
 *
 * 触发方式：
 *   - 定时触发器（cron，每天凌晨 3 点）—— 常规路径
 *   - 手动调用（控制台「云端测试」/ tcb fn invoke）—— 验证用
 *
 * 环境：DYNAMIC_CURRENT_ENV —— 同一份代码可以跑在不同环境，不写死环境 ID。
 */
const cloud = require('wx-server-sdk');
const core = require('./core.js');

cloud.init({ env: cloud.DYNAMIC_CURRENT_ENV });

const db = cloud.database();
const _ = db.command;
const submissions = db.collection('submissions');

// 保留期：默认 30 天（与隐私保护指引一致）。
// 环境变量可以临时覆盖 —— 但那只是演练用，覆盖时会在日志里喊一声，
// 因为改了天数就得同步改后台的隐私声明，不然又是一处对不上。
function resolveRetentionDays() {
  const raw = process.env.CLEANUP_RETENTION_DAYS;
  if (!raw) return core.RETENTION_DAYS;
  const n = Number(raw);
  if (!(n > 0)) {
    console.warn('[cleanup] CLEANUP_RETENTION_DAYS 不是正数，忽略：' + raw);
    return core.RETENTION_DAYS;
  }
  console.warn('[cleanup] ⚠️ 保留期被环境变量改成 ' + n + ' 天（默认 ' + core.RETENTION_DAYS +
    '）—— 隐私保护指引里写的天数也要跟着改，否则声明与实际对不上');
  return n;
}

exports.main = async (event) => {
  const nowSec = Math.floor(Date.now() / 1000);
  const days = resolveRetentionDays();
  const cutoff = core.computeCutoff(nowSec, days);
  const trigger = (event && event.Type) ? event.Type : 'Manual';
  console.log('[cleanup] 触发方式=' + trigger + ' 保留期=' + days + ' 天 截止=' + cutoff);

  let deleted = 0;
  let batches = 0;
  let truncated = false;

  try {
    // 分批删：单批上限 100 条（in 查询的元素数上限），
    // 一次触发最多 20 批 —— 剩下的下次触发继续删（避免函数超时）。
    for (let i = 0; i < core.MAX_BATCHES; i++) {
      // 刻意不用 orderBy('ts','desc')：云数据库的 orderBy 强制要求字段有索引，
      // 而 wx-server-sdk 没有建索引的接口（索引只能在控制台手工建）——
      // 用 orderBy 会让「控制台没建索引」的首次部署直接报错。
      // where 不要求索引，只是全表扫描 —— submissions 保留期只有 30 天，量很小。
      const res = await submissions
        .where({ ts: _.lt(cutoff) })
        .limit(core.BATCH_SIZE)
        .get();

      const docs = res.data || [];
      if (!docs.length) break;

      // 双保险：查询条件已经是 ts < cutoff，这里再按同一口径过一遍，
      // 免得哪条数据 ts 是字符串之类的情况被误删。
      const expired = core.pickExpired(docs, cutoff);
      if (!expired.length) break;

      const ids = expired.map((d) => d._id);
      const rm = await submissions.where({ _id: _.in(ids) }).remove();
      const n = (rm.stats && typeof rm.stats.removed === 'number') ? rm.stats.removed : 0;
      deleted += n;
      batches++;
      console.log('[cleanup] 第 ' + batches + ' 批删了 ' + n + ' 条');

      const full = ids.length >= core.BATCH_SIZE;
      if (!full) break;                    // 删干净了
      if (batches >= core.MAX_BATCHES) {   // 到上限，剩下的下次继续
        truncated = true;
        break;
      }
    }
  } catch (e) {
    const em = String((e && (e.errMsg || e.message)) || e);
    // 集合压根不存在 → 没什么可清的，这不是失败
    if (/not exist|not found|COLLECTION_NOT_EXIST/i.test(em)) {
      console.log('[cleanup] submissions 集合不存在，没什么可清的');
      return { ok: true, skipped: true, cutoff: cutoff, retentionDays: days, deleted: 0, batches: 0 };
    }
    console.error('[cleanup] 清理失败：', e);
    return { ok: false, error: em, cutoff: cutoff, retentionDays: days, deleted: deleted, batches: batches };
  }

  console.log('[cleanup] 完成：共删 ' + deleted + ' 条（' + batches + ' 批）');
  return {
    ok: true,
    cutoff: cutoff,
    retentionDays: days,
    deleted: deleted,
    batches: batches,
    truncated: truncated
  };
};
