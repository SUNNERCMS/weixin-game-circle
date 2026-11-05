/**
 * 云函数 `score` —— 入口（薄壳）
 *
 * 只做四件事：
 *   1. 初始化 SDK
 *   2. 确保集合存在（自愈：控制台里没建也能跑）
 *   3. 把 wx-server-sdk 的 collection API 适配成 core.js 需要的扁平 db 接口
 *   4. 调 core.handle
 *
 * 真正的逻辑在 core.js —— 那里不碰 wx-server-sdk，因此能被单元测试直接跑。
 * 评分开分逻辑在 ./scoring.js（由 npm run sync:cloud 从 shared/scoring.js 同步）。
 *
 * 环境：DYNAMIC_CURRENT_ENV —— 同一份代码可以跑在不同环境，不写死环境 ID。
 */
const cloud = require('wx-server-sdk');
const core = require('./core.js');

cloud.init({ env: cloud.DYNAMIC_CURRENT_ENV });

const db = cloud.database();
const _ = db.command;
const scores = db.collection('scores');
const submissions = db.collection('submissions');

// 集合自愈：控制台里没手工建集合时，第一次调用自动建。
// 已存在会报错，忽略即可（这正是"已存在"的正常表现）。
let collectionsReady = null;
function ensureCollections() {
  if (!collectionsReady) {
    collectionsReady = (async () => {
      for (const name of ['scores', 'submissions']) {
        try {
          await db.createCollection(name);
          console.log('[score] 已创建集合 ' + name);
        } catch (e) {
          // 已存在 / 无权限 —— 后者会在真正读写时报更具体的错，不在这里猜
        }
      }
    })();
  }
  return collectionsReady;
}

exports.main = async (event) => {
  const ctx = cloud.getWXContext();
  try {
    await ensureCollections();
    return await core.handle(event, ctx, {
      getScore: async (openid) => {
        try {
          const res = await scores.doc(openid).get();
          return res.data || null;
        } catch (e) {
          // 文档不存在 / 集合不存在 → 当作没有记录
          return null;
        }
      },
      setScore: async (openid, data) => {
        await scores.doc(openid).set({ data: data });
      },
      addSubmission: async (data) => {
        await submissions.add({ data: data });
      },
      // 取 sinceTs 之后的提交记录，按 ts 倒序取前 limit 条。
      //
      // 刻意不用 orderBy('ts','desc')：云数据库的 orderBy 强制要求字段有索引，
      // 而 wx-server-sdk 没有建索引的接口（索引只能在控制台手工建）——
      // 用 orderBy 会让"控制台没建索引"的首次部署直接报错。
      // where 不要求索引，只是全表扫描，所以这里用 ts 范围过滤 + 内存排序。
      // 单次上限 1000 条：7 天内提交量超过 1000 时会漏历史，那时该给 ts 建索引了。
      recentSubmissions: async (sinceTs, limit) => {
        const res = await submissions
          .where({ ts: _.gte(sinceTs) })
          .field({ sig: true, sigHash: true, ts: true })
          .limit(1000)
          .get();
        const rows = (res.data || []).slice();
        rows.sort((a, b) => (b.ts || 0) - (a.ts || 0));
        return rows.slice(0, limit);
      }
    });
  } catch (e) {
    console.error('[score] 处理失败：', e);
    // 云端异常一律 reject：宁可这局不上榜，也不能让异常分进榜
    return {
      ok: false, verdict: 'reject', score: 0, level: 0, newBest: false, best: 0,
      reason: '云端处理异常', cloudGuard: null, clientGuard: null, scoreDelta: null, replay: false
    };
  }
};
