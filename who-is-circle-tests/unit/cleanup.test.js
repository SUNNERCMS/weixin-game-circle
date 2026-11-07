/**
 * 清理云函数（cloudfunctions/cleanup）的纯逻辑单测
 *
 * 这个函数干什么：把 `submissions`（审计记录）里超过保留期的老记录删掉。
 * 为什么需要它：隐私保护指引里声明了「审计记录保留 30 天」，
 * 声明与实际必须一致 —— 不删就等于骗用户。
 *
 * 逻辑全在 core.js（不碰 wx-server-sdk），所以能直接 require 测。
 *
 * 运行：node unit/cleanup.test.js
 */
const core = require('../../who-is-circle/cloudfunctions/cleanup/core.js');

let pass = 0, fail = 0;
function ok(cond, name, extra) {
  if (cond) { pass++; console.log('  ✅ ' + name + (extra ? '  ' + extra : '')); }
  else { fail++; console.log('  ❌ ' + name + (extra ? '  ' + extra : '')); }
}
function section(title) { console.log('\n========== ' + title + ' =========='); }

const NOW = 1780000000;
const DAY = 86400;

section('一、保留期常量');

ok(core.RETENTION_DAYS === 30, '默认保留 30 天（与隐私保护指引一致）', String(core.RETENTION_DAYS));
ok(core.DAY_SEC === 86400, '一天 = 86400 秒');
ok(core.BATCH_SIZE > 0 && core.BATCH_SIZE <= 100, '单批删除不超过 100 条（in 查询的元素数上限）',
  String(core.BATCH_SIZE));
ok(core.MAX_BATCHES > 0, '单次触发有批次上限（防跑超时）', String(core.MAX_BATCHES));

section('二、computeCutoff —— 过期时间点');

{
  ok(core.computeCutoff(NOW, 30) === NOW - 30 * DAY, '30 天前 = now - 30×86400',
    String(core.computeCutoff(NOW, 30)));
  ok(core.computeCutoff(NOW) === NOW - 30 * DAY, '不传保留期 → 用默认 30 天');
  ok(core.computeCutoff(NOW, 0) === NOW - 30 * DAY, '保留期 0 是非法值 → 回落默认');
  ok(core.computeCutoff(NOW, -5) === NOW - 30 * DAY, '负数 → 回落默认');
  ok(core.computeCutoff(NOW, 7) === NOW - 7 * DAY, '自定义保留期生效');
  ok(core.computeCutoff(NOW + 0.9, 30) === NOW - 30 * DAY, 'now 带小数 → 向下取整',
    String(core.computeCutoff(NOW + 0.9, 30)));
}

section('三、isExpired —— 过期判定');

{
  const cutoff = core.computeCutoff(NOW, 30);
  ok(core.isExpired({ ts: cutoff - 1 }, cutoff) === true, '比 cutoff 早 → 过期');
  ok(core.isExpired({ ts: cutoff }, cutoff) === false, '正好等于 cutoff → **不删**（保留满 30 天）');
  ok(core.isExpired({ ts: cutoff + 1 }, cutoff) === false, '比 cutoff 新 → 不删');
  ok(core.isExpired({ ts: NOW }, cutoff) === false, '刚提交的 → 不删');
  ok(core.isExpired({ ts: '1780000000' }, cutoff) === false, 'ts 是字符串 → 不删（不猜）');
  ok(core.isExpired({}, cutoff) === false, '没有 ts 字段 → 不删（保守，不误删）');
  ok(core.isExpired(null, cutoff) === false, 'null → 不删');
}

section('四、pickExpired —— 挑出该删的');

{
  const cutoff = core.computeCutoff(NOW, 30);
  const docs = [
    { _id: 'a', ts: NOW },                 // 新
    { _id: 'b', ts: cutoff - 100 },        // 旧
    { _id: 'c' },                          // 没 ts
    { _id: 'd', ts: cutoff - 1 },          // 旧
    { _id: 'e', ts: cutoff + 5 }           // 新
  ];
  const out = core.pickExpired(docs, cutoff);
  ok(out.length === 2, '只有两条过期', 'len=' + out.length);
  ok(out[0]._id === 'b' && out[1]._id === 'd', '挑出来的是过期的那两条',
    out.map(d => d._id).join(','));
  ok(core.pickExpired([], cutoff).length === 0, '空数组 → 空');
  ok(core.pickExpired(null, cutoff).length === 0, 'null → 空（不抛）');
}

section('五、chunkIds —— 切批');

{
  const docs = [];
  for (let i = 0; i < 250; i++) docs.push({ _id: 'id' + i });
  const batches = core.chunkIds(docs, 100);
  ok(batches.length === 3, '250 条 → 3 批', 'len=' + batches.length);
  ok(batches[0].length === 100 && batches[1].length === 100 && batches[2].length === 50,
    '每批不超过 100（100/100/50）', batches.map(b => b.length).join('/'));
  ok(batches[2][0] === 'id200', '第二批之后不丢不重', batches[2][0]);
  ok(core.chunkIds([], 100).length === 0, '空 → 0 批');
  ok(core.chunkIds(docs, 0).length === 3, 'size 非法 → 用默认 100');
}

section('六、plan —— 一次触发的完整计划');

{
  const docs = [];
  for (let i = 0; i < 250; i++) docs.push({ _id: 'id' + i, ts: NOW - 40 * DAY });  // 全过期
  docs.push({ _id: 'fresh', ts: NOW });                                             // 一条新的

  const p = core.plan(docs, NOW, { retentionDays: 30, batchSize: 100 });
  ok(p.cutoff === NOW - 30 * DAY, 'cutoff 算对了', String(p.cutoff));
  ok(p.expiredCount === 250, '过期 250 条', String(p.expiredCount));
  ok(p.batchCount === 3, '切成 3 批', String(p.batchCount));
  ok(p.truncated === false, '没到上限 → 没截断');
  ok(p.batches.length === 3 && p.batches[0].length === 100, '批次内容可用');

  const capped = core.plan(docs, NOW, { retentionDays: 30, batchSize: 100, maxBatches: 2 });
  ok(capped.batchCount === 2, 'maxBatches 截断生效', String(capped.batchCount));
  ok(capped.truncated === true, '截断了要标记（下次继续删）');
  ok(capped.expiredCount === 250, 'truncated 不影响过期总数的统计');

  const none = core.plan([{ _id: 'x', ts: NOW }], NOW, { retentionDays: 30 });
  ok(none.expiredCount === 0 && none.batchCount === 0, '没有过期的 → 0 批');
  ok(none.truncated === false, '没有过期的 → 没截断');
}

console.log(`\n结果：${pass} 通过 / ${fail} 失败\n`);
process.exit(fail ? 1 : 0);
