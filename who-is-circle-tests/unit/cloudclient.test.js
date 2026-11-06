/**
 * 主域云端上报模块单元测试（js/cloud.js，P3）
 *
 * 锁住四件事：
 *   1. **触发策略**：只有破纪录才调云函数（D4/D5）
 *   2. **分级**：≥95 同步等结论，<95 异步不阻塞结算
 *   3. **降级**：云端判无效 → 不上榜；云端不可用 → 玩法不受影响
 *   4. **pending 队列**：失败入队、重启补传、传完删除、超上限丢最旧
 *
 * 之所以能在 Node 里跑全部分支：js/cloud.js 的平台依赖全部注入，
 * 不碰任何全局（wx / wx.cloud 都不认）。这正是把它拆出来的原因。
 *
 * 运行：node unit/cloudclient.test.js   （退出码非 0 = 有用例失败）
 */
const Cloud = require('../../who-is-circle/js/cloud.js');

let pass = 0, fail = 0;
function ok(cond, name, extra) {
  if (cond) { pass++; console.log('  ✅ ' + name + (extra ? '  ' + extra : '')); }
  else { fail++; console.log('  ❌ ' + name + (extra ? '  ' + extra : '')); }
}
const tick = () => new Promise(r => setTimeout(r, 0));

/**
 * 造一个可控的客户端环境。
 * over.callResult  云函数返回（对象，或 'reject' 表示抛错）
 * over.deferred    传 true 则返回一个手工 resolve 的 promise（用来验证"不等云端"）
 */
function makeDeps(over = {}) {
  const calls = [];
  const hosted = [];
  const store = {};
  const logs = [];
  let deferred = null;

  const deps = {
    log: function (msg) { logs.push(String(msg)); },
    callFunction: function (name, data) {
      calls.push({ name, data });
      if (over.deferred) {
        if (!deferred) {
          deferred = {};
          deferred.promise = new Promise((res, rej) => { deferred.resolve = res; deferred.reject = rej; });
        }
        return deferred.promise;
      }
      if (typeof over.callResult === 'function') return over.callResult(name, data);
      if (over.callResult === 'reject') return Promise.reject(new Error('云函数未部署'));
      return Promise.resolve({ result: Object.assign({ ok: true, verdict: 'ok' }, over.callResult || {}) });
    },
    setUserCloudStorage: function (payload) {
      hosted.push(payload);
      if (over.hostFail) return Promise.reject(new Error('setUserCloudStorage 失败'));
      return Promise.resolve(true);
    },
    storage: {
      get: k => (Object.prototype.hasOwnProperty.call(store, k) ? store[k] : null),
      set: (k, v) => { store[k] = v; }
    },
    now: () => 1700000000000,
    key: 'circle',
    highScore: 95,
    maxPending: 5,
    timeoutMs: 200
  };

  return {
    deps, calls, hosted, store, logs,
    resolveDeferred: (v) => deferred && deferred.resolve(v),
    rejectDeferred: (e) => deferred && deferred.reject(e),
    pending: () => { const s = store[Cloud.PENDING_KEY]; return s ? JSON.parse(s) : []; }
  };
}

const payloadOf = (score, over = {}) => Object.assign({
  score, level: 2, pts: [[1, 2, 30]], sig: [1, 2, 3], guard: { hard: 0, risk: 0, hits: [] },
  clientBest: 0
}, over);

(async function main() {
  console.log('\n========== 一、触发策略：只有破纪录才调云函数 ==========');

  {
    const h = makeDeps();
    const c = Cloud.createClient(h.deps);
    const r = await c.submitIfRecord(payloadOf(90, { clientBest: 100 }));
    ok(r.status === 'skip', '没破纪录 → skip');
    ok(h.calls.length === 0, '没破纪录 → **一次云函数都不调**', 'calls=' + h.calls.length);
    ok(h.hosted.length === 0, '没破纪录 → 不写托管数据');
  }

  {
    const h = makeDeps();
    const c = Cloud.createClient(h.deps);
    const r = await c.submitIfRecord(payloadOf(90, { clientBest: 90 }));
    ok(r.status === 'skip', '分数等于历史最高 → 也不算破纪录');
    ok(h.calls.length === 0, '分数等于历史最高 → 不调云函数');
  }

  {
    const h = makeDeps({ callResult: { verdict: 'ok', score: 97.4, level: 3 } });
    const c = Cloud.createClient(h.deps);
    const r = await c.submitIfRecord(payloadOf(97, { clientBest: 90 }));
    ok(h.calls.length === 1, '破纪录 → 调一次云函数');
    ok(h.calls[0].name === 'score', '调的是 score 云函数');
    ok(h.calls[0].data.pts && h.calls[0].data.pts.length === 1, '笔迹随上报一起送上去');
    ok(h.calls[0].data.clientScore === 97 && h.calls[0].data.clientBest === 90,
      '带上本地分与历史最高（云端要用来判"是不是真破纪录"）',
      `clientScore=${h.calls[0].data.clientScore} clientBest=${h.calls[0].data.clientBest}`);
  }

  console.log('\n========== 二、分级：≥95 同步 / <95 异步 ==========');

  {
    const h = makeDeps({ callResult: { verdict: 'ok', score: 96.2, level: 3 } });
    const c = Cloud.createClient(h.deps);
    const r = await c.submitIfRecord(payloadOf(96, { clientBest: 90 }));
    ok(r.status === 'ok', '高分（≥95）→ 同步等云端结论', 'status=' + r.status);
    ok(r.cloudScore === 96.2, '同步路径返回**云端分**（不是本地分）', 'cloudScore=' + r.cloudScore);
  }

  {
    const h = makeDeps({ deferred: true });
    const c = Cloud.createClient(h.deps);
    let settled = null;
    const r = await c.submitIfRecord(payloadOf(80, { clientBest: 70, onSettled: f => { settled = f; } }));
    ok(r.status === 'pending', '低分（<95）→ 立刻返回 pending，**不等云端**', 'status=' + r.status);
    ok(settled === null, '低分路径：返回时云端结论还没到（确实没阻塞）');
    h.resolveDeferred({ result: { verdict: 'ok', score: 80.1, level: 1 } });
    await tick(); await tick();
    ok(settled && settled.status === 'ok', '低分路径：最终结论通过 onSettled 回调送达',
      settled ? settled.status : 'null');
  }

  console.log('\n========== 三、云端结论的三个分支 ==========');

  for (const v of ['shadow', 'reject']) {
    const h = makeDeps({ callResult: { verdict: v, score: 97, level: 3, reason: '云端说不行' } });
    const c = Cloud.createClient(h.deps);
    const r = await c.submitIfRecord(payloadOf(97, { clientBest: 90 }));
    ok(r.status === v, `云端判 ${v} → 结论原样传回（调用方据此撤徽章、不落定最佳分）`,
      'status=' + r.status);
    ok(h.hosted.length === 0, `云端判 ${v} → **不写托管数据**（不上榜）`, 'hosted=' + h.hosted.length);
  }

  {
    const h = makeDeps({ callResult: 'reject' });
    const c = Cloud.createClient(h.deps);
    let threw = false;
    let r = null;
    try { r = await c.submitIfRecord(payloadOf(97, { clientBest: 90 })); }
    catch (e) { threw = true; }
    ok(!threw, '云函数报错 → **不把异常抛给玩法层**（游戏照常可玩）');
    ok(r && r.status === 'unavailable', '云函数报错 → status=unavailable（降级，不是失败）',
      r ? r.status : 'null');
    ok(h.hosted.length === 0, '云函数报错 → 不写托管数据');
  }

  {
    const h = makeDeps({ callResult: { verdict: 'weird_verdict' } });
    const c = Cloud.createClient(h.deps);
    const r = await c.submitIfRecord(payloadOf(97, { clientBest: 90 }));
    ok(r.status === 'unavailable', '云端返回未知 verdict → 当作不可达（不猜、不乱上报）',
      'status=' + r.status);
    ok(h.hosted.length === 0, '未知 verdict → 不写托管数据');
  }

  console.log('\n========== 四、托管数据格式（微信标准，别写错） ==========');

  {
    const h = makeDeps({ callResult: { verdict: 'ok', score: 97.83, level: 3 } });
    const c = Cloud.createClient(h.deps);
    await c.submitIfRecord(payloadOf(97, { clientBest: 90 }));
    ok(h.hosted.length === 1, '云端确认 → 写一次托管数据', 'hosted=' + h.hosted.length);
    const kv = h.hosted[0].KVDataList;
    ok(Array.isArray(kv) && kv.length === 1, '托管数据是 KVDataList 数组');
    ok(kv[0].key === 'circle', 'key 是 circle（≤8 字符全英文，后台排行榜配置对应）', 'key=' + kv[0].key);
    const v = JSON.parse(kv[0].value);
    ok(Number.isInteger(v.wxgame.score), 'wxgame.score 是**整数**（Int32 要求）', 'v=' + v.wxgame.score);
    ok(v.wxgame.score === 978, 'wxgame.score = 真实分 ×10（97.83 → 978）', 'v=' + v.wxgame.score);
    ok(v.level === 3, 'level 段位索引写在 wxgame **同级**', 'level=' + v.level);
    ok(v.wxgame.update_time === 1700000000, 'update_time 是 Unix 秒', 't=' + v.wxgame.update_time);
    ok(Object.keys(v.wxgame).length === 2, 'wxgame 下只有 score / update_time（微信不允许自定义字段）',
      Object.keys(v.wxgame).join(','));
  }

  {
    const h = makeDeps({ callResult: { verdict: 'ok', score: 97.83, level: 3 }, hostFail: true });
    const c = Cloud.createClient(h.deps);
    const r = await c.submitIfRecord(payloadOf(97, { clientBest: 90 }));
    ok(r.status === 'ok', '托管数据写失败 → 云端结论照样有效（分还是那个分）', 'status=' + r.status);
    ok(r.hosted === false, '托管数据写失败 → hosted=false（知道自己没上榜）');
  }

  console.log('\n========== 五、pending 队列 ==========');

  {
    // 低分异步 + 云端不可达 → 入队
    const h = makeDeps({ callResult: 'reject' });
    const c = Cloud.createClient(h.deps);
    await c.submitIfRecord(payloadOf(80, { clientBest: 70 }));
    await tick(); await tick();
    ok(h.pending().length === 1, '异步上传失败 → 进 pending 队列', 'pending=' + h.pending().length);
    ok(h.pending()[0].score === 80, '队列里存了分数');
    ok(h.pending()[0].pts.length === 1, '队列里存了压缩笔迹（补传要靠它重算）');
  }

  {
    // 模拟重启：新 client 复用同一份 storage，启动时补传
    const h = makeDeps({ callResult: 'reject' });
    const c1 = Cloud.createClient(h.deps);
    await c1.submitIfRecord(payloadOf(80, { clientBest: 70 }));
    await tick(); await tick();
    ok(h.pending().length === 1, '（前置）重启前队列里有 1 条');

    const h2 = makeDeps({ callResult: { verdict: 'ok', score: 80.2, level: 1 } });
    h2.deps.storage = h.deps.storage;            // 同一份本地存储
    const c2 = Cloud.createClient(h2.deps);
    const flushed = await c2.flushPending();
    ok(flushed === 1, '重启后 flushPending 补传成功 1 条', 'flushed=' + flushed);
    ok(h2.calls.length === 1, '补传真的调了云函数');
    ok(h2.hosted.length === 1, '补传确认后写上托管数据（这局终于上榜了）');
    ok(h.pending().length === 0, '传完的条目**从队列里删除**（不重复上传）',
      'pending=' + h.pending().length);
  }

  {
    // 补传时云端仍不可达 → 条目留在队列里等下次
    const h = makeDeps({ callResult: 'reject' });
    const c1 = Cloud.createClient(h.deps);
    await c1.submitIfRecord(payloadOf(80, { clientBest: 70 }));
    await tick(); await tick();
    const h2 = makeDeps({ callResult: 'reject' });
    h2.deps.storage = h.deps.storage;
    const c2 = Cloud.createClient(h2.deps);
    const flushed = await c2.flushPending();
    ok(flushed === 0, '补传时云端仍不可达 → 传成 0 条');
    ok(h.pending().length === 1, '补传失败 → 条目留在队列里等下次',
      'pending=' + h.pending().length);
  }

  {
    // 队列上限：超出丢最旧
    const h = makeDeps({ callResult: 'reject' });
    const c = Cloud.createClient(h.deps);
    for (let i = 1; i <= 7; i++) {
      await c.submitIfRecord(payloadOf(50 + i, { clientBest: 0 }));
      await tick();
    }
    const q = h.pending();
    ok(q.length === 5, 'pending 队列上限 5 条', 'len=' + q.length);
    ok(q[0].score === 53, '超出上限丢**最旧**的（最新那局最可能是玩家还在意的）',
      '最旧=' + q[0].score + ' 最新=' + q[q.length - 1].score);
  }

  {
    // 同步路径失败也要入队（高分那一局更不该丢）
    const h = makeDeps({ callResult: 'reject' });
    const c = Cloud.createClient(h.deps);
    await c.submitIfRecord(payloadOf(97, { clientBest: 90 }));
    await tick(); await tick();
    ok(h.pending().length === 1, '同步路径失败也进 pending（高分那局更不该丢）',
      'pending=' + h.pending().length);
  }

  console.log('\n========== 六、没开云的环境（浏览器预览 / 未配云环境） ==========');

  {
    const h = makeDeps();
    const c = Cloud.createClient(Object.assign({}, h.deps, { callFunction: null, enabled: false }));
    const r = await c.submitIfRecord(payloadOf(97, { clientBest: 90 }));
    ok(r.status === 'off', '没开云 → status=off', 'status=' + r.status);
    ok(h.calls.length === 0, '没开云 → 不调云函数');
    ok(c.enabled === false, 'client.enabled=false（调用方可据此走单机行为）');
    const flushed = await c.flushPending();
    ok(flushed === 0, '没开云 → 不补传');
  }

  console.log('\n========== 七、超时降级 ==========');

  {
    // 云函数永远不返回 → 超时后按不可达处理，不能把结算卡死
    const h = makeDeps({ deferred: true });
    const c = Cloud.createClient(Object.assign({}, h.deps, { timeoutMs: 60 }));
    const t0 = Date.now();
    const r = await c.submitIfRecord(payloadOf(97, { clientBest: 90 }));
    const dt = Date.now() - t0;
    ok(r.status === 'unavailable', '云函数不返回 → 超时后降级为 unavailable', 'status=' + r.status);
    ok(dt < 2000, '超时在预算内（不会把结算卡死）', '耗时=' + dt + 'ms');
  }

  console.log('\n========== 八、诊断日志（真机排查全靠它） ==========');

  {
    // 真机（预览模式）里除了这几行什么都看不到 —— 链路断在哪只能靠它，
    // 所以「每个关键节点都留下一行」本身就是要锁住的行为。
    const h = makeDeps({ callResult: { verdict: 'ok', score: 96.5, level: 2 } });
    const c = Cloud.createClient(h.deps);
    await c.submitIfRecord(payloadOf(97, { clientBest: 90 }));
    await tick();

    const all = h.logs.join('\n');
    ok(h.logs.length >= 3, '破纪录后至少留下 3 行日志（请求 / 结论 / 托管数据）',
      '共 ' + h.logs.length + ' 行');
    ok(all.indexOf('[cloud] → 请求云端算分') >= 0, '有「请求发出」这一行');
    ok(/模式=同步/.test(all), '同步路径在日志里标得出来（真机上分不清同步异步）');
    ok(all.indexOf('[cloud] ← 云端结论') >= 0, '有「云端结论」这一行');
    ok(/status=ok/.test(all), '结论里带 status');
    ok(all.indexOf('[cloud] 托管数据写入成功') >= 0, '有「托管数据写入结果」这一行');
    ok(all.indexOf('pts=') >= 0, '请求日志带点数（能对上发了多少笔迹）');
    ok(all.indexOf('pts=') >= 0 && all.indexOf('clientBest') < 0,
      '日志里不带 clientBest 之类无关字段');
  }

  {
    // 云端不可达也要留日志 —— 「什么都没发生」是最难查的一种情况
    const h = makeDeps({ callResult: 'reject' });
    const c = Cloud.createClient(h.deps);
    await c.submitIfRecord(payloadOf(97, { clientBest: 90 }));
    await tick(); await tick();
    const all = h.logs.join('\n');
    ok(/status=unavailable/.test(all), '云端不可达 → 日志里写明 unavailable');
    ok(all.indexOf('pending 入队') >= 0, '进 pending 队列也留日志');
  }

  {
    // 异步路径同样要留日志（分数低走异步，界面上看不出区别，只能靠日志）
    const h = makeDeps({ callResult: { verdict: 'ok', score: 70.2, level: 1 } });
    const c = Cloud.createClient(h.deps);
    await c.submitIfRecord(payloadOf(70, { clientBest: 60 }));
    await tick();
    const all = h.logs.join('\n');
    ok(/模式=异步/.test(all), '异步路径在日志里标得出来');
  }

  console.log(`\n结果：${pass} 通过 / ${fail} 失败\n`);
  process.exit(fail ? 1 : 0);
})().catch(e => {
  console.error('\n💥 用例执行异常：', e);
  process.exit(1);
});
