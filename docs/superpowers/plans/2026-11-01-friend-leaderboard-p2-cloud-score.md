# P2：云函数 `score` + 同步脚本 + 云数据库集合

> 承接 `2026-11-01-friend-leaderboard-p1-opendata-skeleton.md`（P1 代码已提交 `cc2e1bd`，
> **视觉验证待用户扫码确认**）。
> 设计文档：`2026-11-01-friend-leaderboard-design.md` §6.1 / §6.2 / §7.2 / §十 P2 行。
> 云环境 ID：`cloud1-d6grvs82r581230b2`（用户 2026-11-05 提供）

## 目标

把评分引擎搬到云端跑一遍，让**榜上的分是云端算出来的**。

P2 只做服务端与契约，**不动客户端上报链路**（那是 P3）、**不做榜面**（P4/P5）。

## 完成标志

| # | 标志 | 验证方式 |
|---|---|---|
| 1 | 云函数能返回权威分，与客户端分一致（误差 ≤ 0.1） | 真实调用云函数 vs 客户端 `evaluate` 对拍 |
| 2 | 云函数里的评分引擎与 `shared/scoring.js` **字节级一致** | 守卫测试（hash 比对） |
| 3 | `cloudfunctions/` **不进小程序包** | 守卫测试（`packOptions.ignore` 显式声明 + 打包产物核对） |
| 4 | 集合 `scores` / `submissions` 与索引就位 | 云端查询核对 |
| 5 | `clock_drift` 的取舍**落在协议里**，不是只写在文档 | 出参 `cloudGuard.note` + 云函数 README + 项目 README |

## 平台机制（已核实）

- 云函数用 `wx-server-sdk`，`cloud.getWXContext().OPENID` 取用户标识（**不信任客户端传的**）。
- `cloud.DYNAMIC_CURRENT_ENV` 让同一份代码能跑在不同环境。
- 云数据库是 MongoDB 风格：`collection.where(...).get()` / `collection.doc(id).update()`。
- **数组字段不能高效做近似查询** —— 重放检测必须"拉出来在内存里比对"，
  不能指望 `where({sig: ...})` 命中近似值。

## 契约修正（本次要改设计文档）

| 位置 | 问题 | 修正 |
|---|---|---|
| §6.1 出参 `verdict` | 写的是 3 档 `'ok' \| 'shadow' \| 'reject'` | **实际 `judge()` 返回 4 档**，多一个 `'unverified'`（`risk ≥ UNVERIFIED_RISK` 但未达 shadow 门槛）。契约改为 4 档 |
| §6.1 入参 | 没有 `SIG` 环境标记 | 客户端 `SIG = {untrusted, webdriver}` 只经 `guardCheck` 进入 `guard.hard`；**云端不独立信任它**，仅作辅助信号 |
| §7.2 `clock_drift` | "P2 必须二选一" | **选 ②**：云端不独立复核 `clock_drift`。理由见下 |

### `clock_drift` 为什么选 ②（并在协议里显式暴露）

`guardCheck(raw, fit, score, sig)` 里 `clock_drift` 依赖 `raw[i].h`（回调执行时刻）。
上传协议只有 `pts`（`encodePts` 不编码 `h`），云端若以 `h := t` 构造 raw，
`evDur === hDur` 恒成立 → 该信号恒不命中。

- 选 ①（上传 `h`）要新增 `encodeRaw`/`decodeRaw`，载荷 +33%，且 `h` 是**客户端自报**的回调时刻 ——
  攻击者连 `h` 一起伪造即可，收益有限。
- 选 ② 的代价是云端少一道防线。**为防止"默默失效"**，出参显式带上：
  ```js
  cloudGuard: { risk, hits, hard, note: 'clock_drift 未独立复核（上传协议不含 h）' }
  ```
  调用方（未来的主域/开放数据域）能直接看到云端到底复核了哪些信号。

## Task 1：云函数骨架 + 同步脚本 + 守卫

### Step 1：写失败测试（RED）

`who-is-circle-tests/unit/cloudfn.test.js`：

1. `cloudfunctions/score/scoring.js` 与 `shared/scoring.js` **hash 相同**（同一份算法，不许漂移）
2. `cloudfunctions/score/package.json` 声明 `wx-server-sdk` 依赖
3. `cloudfunctions/score/index.js` 存在且语法正确
4. **`project.config.json` 的 `packOptions.ignore` 显式排除 `cloudfunctions`**
   （P1 时那条守卫写的是"项目里没有 cloudfunctions 目录" —— P2 要建了，
   必须改成正确的不变式：**目录在 ⇒ 必须在 ignore 列表里**）
5. 云函数**不得**引用小游戏主域符号（`wx.` 的小游戏 API、`getApp`）
6. 云函数**不得**内联一份评分引擎（必须 `require('./scoring.js')`）

### Step 2~6：实现

- `who-is-circle-tests/tools/sync-scoring.mjs` —— 从 `shared/scoring.js` 拷到 `cloudfunctions/score/scoring.js`
- `who-is-circle-tests/package.json` 加 `sync:cloud` script
- `cloudfunctions/score/package.json` —— `wx-server-sdk`
- `cloudfunctions/score/index.js` —— 见 Task 2
- `cloudfunctions/score/README.md` —— 云端契约说明（含 `clock_drift` 取舍）

### Step 7：跑测试 → 全绿

## Task 2：云函数逻辑

`exports.main` 流程（严格按设计文档 §6.1 的九步）：

1. `getWXContext()` 取 `OPENID`，缺 → reject
2. `decodePts(event.pts)` → 点集；`length > MAX_POINTS` → reject
3. `evaluate(points)` → 分与拟合
4. `guardCheck(raw, fit, score, sig)` → 风险与 flags（**`raw` 用 `h := t` 构造**，并在 note 里说明）
5. `judge(r, g, replay)` → verdict（**不传 `dev`**：服务端没有开发豁免）
6. 速率限制：读 `scores` 自己的 `lastSubmitAt` / `recentSubmits`，窗口内超阈值 → reject
7. 重放检测：`sigHash` 精确命中 → reject；再拉最近 N 条 `submissions` 做 `isReplay` 近似比对
8. 写 `scores`（仅当更高分）与 `submissions`（每次都写，含被拒的）
9. 返回出参

**本地可测性**：把核心逻辑拆成 `handle(event, ctx, db)`，`ctx`/`db` 注入 ——
这样能用 mock 跑完整流程的单测，不必真连云端。

## Task 3：集合与索引

| 集合 | 文档 | 索引 |
|---|---|---|
| `scores` | `{_id: openid, score, level, updatedAt, lastSubmitAt, recentSubmits}` | `_id` 主键（openid） |
| `submissions` | `{_id: auto, openid, sig, sigHash, score, verdict, ts}` | `sigHash`、`ts` |

## Task 4：部署与端到端验证

1. `npm run sync:cloud` 确认同步
2. 部署云函数（`tcb` CLI 或开发者工具 GUI）
3. 造一条**真笔迹**（客户端 `encodePts` 输出）→ 调云函数 → 与客户端 `evaluate` 对拍，误差 ≤ 0.1
4. 造一条**超限**笔迹 → 确认 reject
5. 同一条笔迹调两次 → 第二次应被重放检测拦下

## 风险与预案

| 风险 | 预案 |
|---|---|
| `tcb` CLI 登录需要用户扫码 | 开发者工具 GUI 上传作为备选（用户点右键菜单） |
| 云函数部署后 `require('./scoring.js')` 找不到 | 同步脚本的产物必须在部署前生成；部署顺序：先 sync 再 deploy |
| `submissions` 快速膨胀 | 保留最近 7 天（定时触发器清理，本期靠量级撑）；比对只拉最近 N 条 |
| 真实笔迹样本难造 | 用 `shared/scoring.js` 的 `evaluate` 反向造：随机生成带噪声的圆，客户端打分后原样上传 |
