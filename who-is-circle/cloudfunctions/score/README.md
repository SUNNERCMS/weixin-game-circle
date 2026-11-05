# 云函数 `score` —— 权威算分

好友榜上的分是**云端算出来的**。这个云函数负责：解笔迹 → 重算分 → 跑防作弊 →
判重放 → 判速率 → 落库。

## 目录里有什么

| 文件 | 角色 |
|---|---|
| `index.js` | 入口。初始化 SDK、确保集合存在、把 SDK 的 collection API 适配成 core.js 要的扁平接口 |
| `core.js` | 全部逻辑。**不依赖 wx-server-sdk**，所以能被单元测试直接 require（用内存 db 跑完整流程） |
| `scoring.js` | **构建产物**。由 `npm run sync:cloud` 从 `who-is-circle/shared/scoring.js` 拷贝而来 |
| `package.json` | 依赖 `wx-server-sdk` |

### `scoring.js` 是拷贝来的，不是手写的

云函数跑在服务端沙盒里，够不到小游戏项目根目录的 `shared/`，所以必须放一份副本。
但**两份算法必须永远是同一份** —— 客户端改了分、云端没跟着改，比分就对不上。

所以拷贝是机械的、不允许手改；一致性由 `who-is-circle-tests/unit/cloudfn.test.js`
比对两者的 sha256 盯着。**改了 `shared/scoring.js` 一定要跑 `npm run sync:cloud` 再部署。**

## 入参

```jsonc
{
  "pts": [[123, -456, 16], ...],   // encodePts 的增量编码，量化精度 0.001px
  "clientScore": 97.8,             // 客户端自报分（仅供对照，云端不采信）
  "clientBest": 99.2,              // 客户端自报最佳（仅参考）
  "sig": [ ...64 个数字... ],       // shapeSig 输出，形状指纹
  "guard": { "hard": [], "risk": 0, "hits": [] }   // 客户端的防作弊结果（仅作辅助信号）
}
```

**身份不来自入参** —— 用 `cloud.getWXContext().OPENID` 取，客户端传的标识一律不信。

## 出参

```jsonc
{
  "ok": true,
  "verdict": "ok",          // ok | shadow | unverified | reject
  "score": 97.8,            // 云端算出的权威分
  "level": 4,               // 段位索引
  "newBest": true,
  "best": 97.8,
  "reason": "",             // reject 时的说明
  "cloudGuard": {           // 云端自己的防作弊判定
    "risk": 0, "hits": [], "hard": [],
    "note": "判定完全基于云端重算；clock_drift 未独立复核（上传协议不含回调时刻 h）"
  },
  "clientGuard": { ... },   // 客户端上报的 guard，原样回显供审计对比
  "scoreDelta": 0,          // 云端分 − 客户端分，交叉校验用
  "replay": false
}
```

### `verdict` 是四档，不是三档

`ok` / `shadow` / `unverified` / `reject`。
`unverified` 是 `risk` 够高但没到 `shadow` 门槛时的中间态 —— 分数给，但标记为"未完全验证"。

## 判定逻辑：云端自己算，不采信上报

1. `decodePts` 解笔迹 → 点数 > 900 直接拒
2. `evaluate` 重算分与拟合（**这是唯一的分数来源**）
3. `guardCheck` 用**云端重算出来的** raw 跑防作弊
4. `judge` 出 verdict（服务端**不传 `dev`**，没有开发豁免）
5. 重放检测（见下）
6. 速率限制：同一 openid 60 秒内最多 5 次
7. 落库：`submissions` 每次都写（含被拒的），`scores` 只在更高分时更新分数字段

客户端上报的 `guard` **不参与判定**，只回显出来供审计对比。
理由：客户端代码在攻击者手里，任何"客户端说自己有问题"的判断都能被摘掉。
云端只能信自己重算出来的东西。

## `clock_drift`：明确的取舍，不是遗漏

`guardCheck` 里的 `clock_drift` 信号依赖 `raw[i].h`（回调执行时刻）。
**上传协议只带 `pts`，不带 `h`** —— 云端以 `h := t` 构造 raw，
于是 `evDur === hDur` 恒成立，该信号在云端**恒不命中**。

两种补法：

| 方案 | 代价 |
|---|---|
| ① 上传 `h` | 要新增 `encodeRaw`/`decodeRaw`，载荷 +33%；而且 `h` 是**客户端自报**的回调时刻，攻击者连它一起伪造即可，防的是君子不是小人 |
| ② 不上传，云端不独立复核 | 云端少一道防线 |

**本项目选 ②。** 但"少一道防线"不能只写在文档里让人自己记得 ——
所以出参里带了 `cloudGuard.note`，明确写着"clock_drift 未独立复核"。
调用方（主域 / 开放数据域）能直接看到云端到底复核了哪些信号，不存在默默失效。

## 重放检测：不依赖任何索引

云数据库的 `orderBy` **强制要求字段有索引**，而 `wx-server-sdk` 没有建索引的接口
（索引只能在控制台手工建）。用 `orderBy` 会让"控制台没建索引"的首次部署**直接报错**。

所以这里的做法是：

```
where({ ts: { $gte: 7天前 } })     // where 不要求索引，只是全表扫描
  → 拉回来（单次上限 1000 条）
  → 内存里按 ts 倒序
  → 同时做精确比对（sigHash 相同）与近似比对（isReplay：形状几乎一样）
```

**已知上限**：7 天内提交量超过 1000 条时会漏掉一部分历史。
到那个量级，应在控制台给 `ts` 建索引，再把这里换成 `orderBy('ts','desc')`。
代码里留了注释标出这个升级点。

## 集合

| 集合 | 文档 | 索引 |
|---|---|---|
| `scores` | `{_id: openid, score, level, updatedAt, lastSubmitAt, recentSubmits}` | `_id` 是主键（openid），天然有索引 |
| `submissions` | `{_id: auto, openid, sig, sigHash, score, verdict, reason, clientScore, clientGuard, ts}` | 无（当前实现不依赖索引） |

集合**不需要手工建**：入口的 `ensureCollections()` 会在首次调用时自动创建。
`submissions` 只查最近 7 天，过期数据不清理但也不进查询范围。

## 自检通道：干跑，不落库

云调用（`tcb fn invoke`、控制台「云端测试」）**没有微信上下文**，
`cloud.getWXContext().OPENID` 是空的 —— 这不是故障，是云调用的固有形态。
没有 `OPENID` 就没有身份，也就没法落库，所以另开一条**干跑**通道，
专门用来验证「云端算的分 == 客户端算的分」：

```jsonc
// 云调用 score，入参
{
  "__selftest": true,
  "pts": [[123, -456, 16], ...],
  "clientScore": 97.8
}
```

走这条通道时：

- 身份固定为 `__selftest__`（隔离身份，不污染真实榜单）
- `dryRun = true`：**不写 `scores` / `submissions`**，也不做重放检测
  （读到的真实历史会让判定结果不确定）
- 出参带 `dryRun: true`，调用方一眼能看出这是干跑结果

**安全边界**：这条通道只在**没有微信上下文**时可用，也就是只能从云端控制台 / CLI 触发。
从小游戏里调用时微信一定会注入 `OPENID`，`dryRun` 恒为 `false`；
攻击者在小游戏里没法让 `OPENID` 变空，所以它不是后门。
（没有 `OPENID` 又不带 `__selftest` 的调用会被直接拒掉并返回「未登录」。）

## 端到端对拍

`who-is-circle-tests/tools/verify-cloud.mjs`（`npm run verify:cloud`）：
造 4 档噪声的笔迹 → 客户端用 `shared/scoring.js` 算分并 `encodePts` → 调**已部署的云函数**
（走上面的干跑通道）→ 对拍云端分与客户端分，验收线 **|Δ| ≤ 0.1**。

```bash
cd who-is-circle-tests
CLOUD_ENV=cloud1-xxxx npm run verify:cloud
```

云函数没部署、环境 ID 不对、或云端算出的分对不上，脚本都会**报错并以非 0 退出码结束**，
不会静默跳过。

## 部署

```bash
cd who-is-circle-tests
npm run sync:cloud                                    # 先同步评分引擎
/Applications/wechatwebdevtools.app/Contents/MacOS/cli cloud functions deploy \
  --env cloud1-d6grvs82r581230b2 \
  --names score \
  --project /Users/sunnercms/WeChatProjects/who-is-circle \
  --remote-npm-install
```

刚创建函数时它处于 `Creating` 状态，直接部署会报
`FailedOperation.UpdateFunctionCode：当前函数处于Creating状态` —— 稍等十几秒重试即可。
