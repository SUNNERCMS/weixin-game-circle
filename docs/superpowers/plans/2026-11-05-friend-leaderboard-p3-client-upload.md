# P3：主域上报链路（触发策略 + 分级同步/异步 + pending 队列 + 托管数据）

> 承接 `2026-11-01-friend-leaderboard-p2-cloud-score.md`（P2 代码已提交 `97c9102`）。
> 设计文档：`2026-11-01-friend-leaderboard-design.md` §四 / §6.1 / §6.3 / §7.1 / §7.4 / §十 P3 行。
> 云环境 ID：`cloud1-d6grvs82r581230b2`（P2 已用）。

## 目标

让**榜上的分真的存在**：客户端在破纪录时把笔迹交给云函数重算，云端确认后由主域写进
`wx.setUserCloudStorage` 的托管数据，开放数据域（P4）才有东西可读。

P3 只做**上报链路**，不做榜面（P4 开放域渲染 / P5 入口与 UI）。

## 完成标志

| # | 标志 | 验证方式 |
|---|---|---|
| 1 | 破纪录才调云函数；未破纪录**一次都不调** | 单测断言 `callFunction` 调用次数 |
| 2 | ≥95 分同步等云端结论，结算页显示**云端分** | 单测 + 预览观察 |
| 3 | <95 分异步上报，不阻塞结算 | 单测断言结算先返回、调用后到 |
| 4 | 云端判 `shadow`/`reject` → **不弹新纪录徽章**、本地 `H` 不变、**不上榜** | 单测 |
| 5 | 云端不可用 → 游戏照常可玩、**不弹错误** | 单测（callFunction 抛错） |
| 6 | 异步上传失败 → 进 pending 队列；重启后自动补传、传完删除 | 单测（重建 client 模拟重启） |
| 7 | 托管数据格式符合微信标准（`wxgame.score` 为整数 = 真实分×10） | 单测断言写出的 KVDataList |
| 8 | 回归套件全绿 | `npm test` + `npm run lint` |

## 契约（与 P2 云函数对齐）

**上报入参**（`wx.cloud.callFunction({name:'score', data})`）：

```js
{
  pts: encodePts(points),   // 增量编码，与 P2 core.js 的 decodePts 对称
  clientScore: r.score,
  clientBest: state.best,
  sig: shapeSig(...),       // 64 个数字的数组（非哈希）
  guard: { hard, risk, hits }
}
```

**托管数据**（`wx.setUserCloudStorage`）：

```js
{ KVDataList: [{ key: 'circle', value: JSON.stringify({
    wxgame: { score: Math.round(score * 10), update_time: unixSec },  // Int32 要求
    level: levelIndex
}) }] }
```

> `wxgame.score` 是 **Int32**，分数一位小数 → 上报 ×10，显示 ÷10。
> `level` 放在 `wxgame` 同级（`wxgame` 下不可自定义字段）。
> key `circle`：≤8 字符且全英文。

## 触发策略（D4 + D5）

```
本地算出 S，本地历史最高 H
  ├─ S ≤ H ──→ 不上传，直接结算（这一局无论真假都上不了榜）
  └─ S > H ──→ 上传
       ├─ S ≥ 95 ──→ 同步：结算页等云端结论（GUARD_CFG.HIGH_SCORE）
       └─ S < 95 ──→ 异步：不阻塞 UI，失败进 pending 队列
```

## 明确取舍（本阶段要写进 README，不能默默做）

| # | 取舍 | 结论与理由 |
|---|---|---|
| C1 | 云端**不可用**（网络错/函数未部署/超时）时，本地 `H` 更不更新 | **更新**（保持单机行为，徽章照常）。设计文档 §7.4 写的是「不更新」，但那条只针对「云端明确判无效」；服务不可达 ≠ 作弊证据。若按 §7.4 严格执行，开发者工具预览（云函数可能没部署）会永远看不到新纪录徽章，e2e 的 `amber > 100` 断言直接红。**云端不可用 → 本局不上榜、不弹错误，其余与单机版一致。** |
| C2 | 云端明确判 `shadow`/`reject` 时 | **严格按 §7.4**：不弹新纪录徽章、`H` 不变、不上报托管数据。分数照常显示。 |
| C3 | 同步路径（≥95）结算页要不要等 | **不等**。结算卡片立刻出现（显示本地分），云端结论回来后再把分数换成**云端分**并重播一次分数滚动。玩家不用盯着一张空白画布等 300ms。 |
| C4 | 异步路径（<95）的 `H` 与徽章 | **乐观更新**（与 D6「本地 = 乐观值」一致）：结算不等云端，`H` 立即更新、徽章照常。云端若回 `shadow`/`reject` → 徽章撤掉、`H` 回滚到云端给的 `best`。回滚只在「云端明确判无效」时发生。 |
| C5 | pending 队列存什么 | 分数 + 压缩笔迹（`encodePts`），单条 2–10 KB。上限 5 条，超出丢最旧。 |
| C6 | `wx.setUserCloudStorage` 在主域调 | 已核实：**主域可直接调用**（`https://developers.weixin.qq.com/minigame/dev/api/open-api/data/wx.setUserCloudStorage.html`）。不需要开放数据域参与。 |

## Task 1：主域云端上报模块 `who-is-circle/js/cloud.js`

新建独立模块（UMD，Node 可 require，浏览器可 `<script>` 引入）：

- `createClient(deps)` —— 依赖全部注入，**不碰任何平台全局**：
  `callFunction` / `setUserCloudStorage` / `storage.get` / `storage.set` / `now`。
  注入是为了能在 Node 单测里用假实现跑完全部分支。
- `submitIfRecord(payload)` → Promise，结果分类：
  `skip`（没破纪录）/ `ok`（云端确认）/ `shadow` / `reject` / `unavailable`（服务不可达）/ `off`（未开云）
- `flushPending()` → Promise<number>，启动时补传 pending 队列。
- `pendingCount()`

**为什么单独一个文件**：D8 说「不拆 `js/` 目录」，指的是**不要把 game.js 拆成一堆小模块**；
设计文档 §五 的文件清单里明确列了 `js/cloud.js`。上传链路有 6 个分支，
塞回 game.js 就只能靠 e2e 覆盖 —— 而 e2e 跑不到「云函数没部署」「超时」这些路径。

## Task 2：接进 `game.js`

- 启动时 `wx.cloud.init({ env, traceUser: true })`（有 `wx.cloud` 才 init），并 `flushPending()`。
- `finishStroke()` 里，破纪录时调 `submitIfRecord`：
  - 同步路径回来后：分数换成云端分、`H` 用云端分、徽章按云端 verdict 决定。
  - 异步路径回来后：命中 `shadow`/`reject` → 撤徽章 + 回滚 `H`。
- 新纪录徽章与 `H` 落定的时机跟着云端结论走（`res.badgeDelay`）。

## Task 3：单测 `who-is-circle-tests/unit/cloudclient.test.js`

覆盖：

1. 没破纪录 → 一次都不调云函数
2. ≥95 → 同步，返回云端分
3. <95 → 异步，结算先返回
4. 云端 `shadow` → 不上报托管数据、`H` 不变
5. 云端 `reject` → 同上
6. 云端不可用（抛错）→ 不抛到玩法层、不弹错误、`H` 仍更新（按 C1）
7. 异步失败 → 进 pending；重建 client 后 `flushPending` 补传并删除
8. pending 超过 5 条 → 丢最旧
9. 托管数据格式：`wxgame.score` 是整数、`×10`、`level` 在 `wxgame` 同级、key 是 `circle`
10. 未开云（没有 callFunction）→ `off`，玩法不受影响

## Task 4：回归与文档

- `npm test`（含新增单测）、`npm run lint`、`npm run test:opendata`、`npm run test:cloudfn`
- 更新 `who-is-circle/README.md`：上报链路、降级路径、两项取舍（C1/C4）
- 更新 `docs/superpowers/specs/...design.md` 的 P3 进度标注

## 风险与预案

| 风险 | 预案 |
|---|---|
| 云函数未部署 → 同步路径一直失败 | 超时 5s 视为不可用，走 C1 降级（不影响玩法） |
| 云端把合法高分判 `shadow` | 本地 `judge()` 已先过一道；云端结论**只影响榜与徽章**，不推翻分数显示 |
| 托管数据写失败 | 不重试到死循环；记一笔，榜上暂无自己（下次破纪录再写） |
| 预览环境（develop）云调用慢 | 同步路径有 5s 超时；超时即降级，不会卡住结算 |

---

## 实施结果（完成后回填）

**产出**

| 文件 | 作用 |
|---|---|
| `who-is-circle/js/cloud.js` | 主域云端上报模块（UMD，依赖全注入，不碰平台全局） |
| `who-is-circle-tests/unit/cloudclient.test.js` | 上报模块单测（52 项断言） |
| `who-is-circle-tests/unit/gamesettle.test.js` | 结算链路 × 云端结论的集成测试（22 项断言） |

**决策与原计划的偏差**

| # | 原计划 | 实作 | 为什么 |
|---|---|---|---|
| C1 | 云端不可用 → `H` 不更新（§7.4） | **保持单机行为**：`H` 更新、徽章照常，只是不上榜 | 服务不可达 ≠ 作弊证据；开发者工具预览里云函数常未部署，照抄会让玩家永远看不到新纪录徽章，e2e 的 `amber > 100` 断言直接红 |
| C3 | 同步路径结算页等云端结论 | 结算卡片**立刻出**，云端结论回来后再把分数换成云端分 | 玩家不用盯着一张空白画布等 300ms；分数与徽章都等云端确认后才最终落定 |
| C4 | 异步路径乐观更新 | 同左，但**最佳分的落定**要等云端结论（最多 5s 超时） | 「本地 = 乐观值」只适用于显示；本地最佳分不能比榜上虚高。结算页被关掉也照样等 —— 否则一局高分就可能造成本地最佳分虚高 |
| **C7（新增）** | — | **开发版（`DEV`）里云端结论只作提示，不改本地行为** | 服务端 `judge(r, g, replay, false)` **没有开发豁免**，开发者自己的合成笔迹会被判 `shadow`，e2e 必然红。沿用本地 `judge()` 的豁免思路：开发版云端照调、数据照上，结论不改本地表现 |

**顺带修掉的既有缺陷**（改动 `state.bestPending` 时撞出来的）

原逻辑：最佳分只在 `state.result` 还在、且结算动画播完时才落定，且落定时存的是**当前笔迹**。

- 玩家在结算动画播完前直接落笔重画 → `state.result` 被清空 → `bestPending` 永远不落定 → **最佳分丢失、存档也不写**。
- 落定用的是 `state.points` 而不是那一局的笔迹 → 存档自校验可能对不上。

改成：最佳分与它对应的笔迹一起存进 `state.bestPending`，落定与结算页解耦；
结算页已关掉也立刻落定。

**未做（留给 P4/P5）**

- 开放数据域的榜面渲染（P4）
- 首页入口、overlay、隐私门禁引导（P5）
- 好友榜的真实读取（`wx.getFriendCloudStorage`）—— 本阶段只写托管数据，还没读
