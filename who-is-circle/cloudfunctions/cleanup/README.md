# 云函数 `cleanup` —— 清理过期审计记录

## 干什么

把 `submissions` 集合里**超过 30 天**的记录删掉。

**为什么必须有**：隐私保护指引里声明了「审计记录保留 30 天」。
声明与实际必须一致 —— 不删就是骗用户，审核也可能因此被打回。

> 保留期改了天数，**必须同步改后台的「服务内容声明」**
> （微信公众平台 → 设置 → 基本设置 → 服务内容声明 → 用户隐私保护指引）。
> 环境变量 `CLEANUP_RETENTION_DAYS` 只是临时覆盖（演练用），
> 覆盖时会在日志里喊一声提醒你。

## 部署

```bash
CLI=/Applications/wechatwebdevtools.app/Contents/MacOS/cli
cd who-is-circle
$CLI cloud functions deploy --env cloud1-d6grvs82r581230b2 --names cleanup --remote-npm-install --project "$PWD"
```

> ⚠️ **`--remote-npm-install` 不能省**：`wx-server-sdk` 是装在**云端**的，
> 本地 `cloudfunctions/cleanup/` 里没有 `node_modules`。
> 不带这个参数部署 = 只上传代码不装依赖 → 云函数直接报
> `Cannot find module 'wx-server-sdk'`，定时任务**静默不干活**。

## 定时触发器

**云开发控制台** → 云函数 → `cleanup` → 触发器 → 创建：

| 项 | 值 |
|---|---|
| 触发器类型 | 定时触发器 |
| 执行周期 | 自定义周期 |
| Cron 表达式 | `0 0 3 * * * *`（每天凌晨 3 点，7 位：秒 分 时 日 月 周 年） |
| 超时时间 | **20 秒**（默认 3 秒偏紧 —— 分批删 20 批可能跑不完） |

也可以用命令行建：

```bash
tcb fn trigger create cleanup --trigger-name daily --cron "0 0 3 * * * *"
```

**时区**：定时触发器按**东八区**（北京时间）算，`0 0 3 * * * *` = 北京时间凌晨 3 点。

## 手动验证

控制台 → 云函数 `cleanup` → 「云端测试」→ 直接调用（参数留空）。

预期返回：

```json
{
  "ok": true,
  "cutoff": 1777408000,     // 保留期 30 天的截止点（Unix 秒）
  "retentionDays": 30,
  "deleted": 0,             // 没过期记录时是 0
  "batches": 0,
  "truncated": false
}
```

日志：

```
[cleanup] 触发方式=Manual 保留期=30 天 截止=1777408000
[cleanup] 完成：共删 0 条（0 批）
```

**手动跑一次是安全的**：没有过期记录就什么都不删。

## 行为要点

| 情况 | 行为 |
|---|---|
| 记录 `ts` 早于截止点 | 删 |
| 记录 `ts` 正好等于截止点 | **不删**（保留满 30 天） |
| 记录没有 `ts` / `ts` 不是数字 | **不删**（宁可留着，别误删审计数据） |
| 单次触发超过 2000 条（20 批 × 100） | 删到上限就停，`truncated: true`，下次触发继续 |
| `submissions` 集合不存在 | 视为成功（`skipped: true`） |

**为什么分批**：云数据库 `in` 查询的元素数上限是 100，所以一批最多 100 条；
一次触发最多 20 批 = 2000 条，够用且不会把函数跑超时。

**为什么不用 `orderBy('ts')`**：云数据库的 `orderBy` 强制要求字段有索引，
而 `wx-server-sdk` 没有建索引的接口（索引只能在控制台手工建）——
用了就会让「控制台没建索引」的首次部署直接报错。`where` 不要求索引，
只是全表扫描；`submissions` 只保留 30 天，量很小。

## 测试

```bash
cd ../../who-is-circle-tests && node unit/cleanup.test.js
```

36 项断言：保留期常量、过期判定（含边界与异常字段）、挑过期、切批、整次触发的计划。
