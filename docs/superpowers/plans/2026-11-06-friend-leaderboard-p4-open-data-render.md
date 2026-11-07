# P4：开放数据域渲染（拉取 + 排序 + 画榜 + 样式参数 + 头像兜底）

> 承接 `2026-11-05-friend-leaderboard-p3-client-upload.md`（P3）+ P3.5（`52482dc`：`scores` 口径定案，托管数据改写权威最高分并带 `v`）。
> 设计文档：`2026-11-01-friend-leaderboard-design.md` §6.3 / §6.4 / §8.1 / §8.2 / §8.3 / §十 P4 行。
> 云环境：`cloud1-d6grvs82r581230b2`。**本阶段不改云函数，不需要重新部署。**

## 目标

让**首页能看见好友榜**，并且榜上每个分都是云端确认过的权威分。

P4 把「读」这一侧做完：开放数据域拉好友托管数据 → 归一化 → 排序 → 画到 sharedCanvas，主域把它贴出来。

## 完成标志

| # | 标志 | 验证方式 |
|---|---|---|
| 1 | 开放数据域能拉到好友托管数据并解析出分 / 段位 / verdict | 单测（注入假 wx） |
| 2 | 排序后名次连续（1,2,3…），同分有稳定次序 | 单测 |
| 3 | 自己也在榜上（`wx.getUserCloudStorage`）且高亮 | 单测 |
| 4 | 托管数据是权威最高分 → 榜上显示最高分，不是本局分 | 单测（构造 best > 本局分） |
| 5 | `v === 'unverified'` 的行带「未完全验证」角标 | 单测（绘制调用断言） |
| 6 | 头像加载失败 → 兜底色块 + 昵称首字，不崩、不空白 | 单测 |
| 7 | 样式参数缺失 / 越界 → 用默认值，榜不歪 | 单测 |
| 8 | 昵称与段位名按**测量宽度**截断（不是按字数） | 单测 |
| 9 | 未授权 → 不空白、不报错，引导可走通 | 单测 + 真机 |
| 10 | 回归套件全绿 | `npm test` + `npm run lint` |

## 平台约束（2026-11-06 查证官方文档，不是凭记忆）

| 约束 | 结论 | 对实现的影响 |
|---|---|---|
| 开放数据域能 `require` 同目录文件 | ✅ 能（但**主域 ↔ 开放域不能互相 require**） | 纯逻辑可以拆到 `open-data/board.js`，Node 可直接测 |
| 开放数据域能 `wx.request` | ❌ 不能 | 好友数据只能现拉现画，不能「主域拉→传云端→回传」 |
| 开放数据域能加载远程图片 | ⚠️ 只能本地图或**微信 CDN** 图 | `avatarUrl` 是微信 CDN → `wx.createImage()` 可用；**失败必须兜底** |
| 开放数据域能 `wx.getUserCloudStorage` | ✅ 能 | 自己的分也由开放域读（主域读不到托管数据） |
| 主域 → 开放域 | 单向 `postMessage` / `wx.onMessage` | **开放域算出的名次回不到主域** → 底部「我的排名」只能画在开放域里 |

> 最后一条推翻了设计文档 §8.2 的一句「名次由开放域算好，**主域只画文案**」——
> 名次算好了也传不回主域。以 §6.4 的单向约束为准：**底部那行画在开放域里**。本阶段同步改设计文档。

## 数据契约

### 托管数据（P3.5 已定，本阶段**只读**）

```js
{ wxgame: { score: 权威最高分×10, update_time: unixSec }, level: 段位索引, v: 'ok'|'unverified' }
```

读取规则：

- `wxgame.score ÷ 10` = 真实分（保留一位小数）
- `level` = `RANKS` 下标 → 段位名取主域发来的 `rankNames[level]`
- `v` 缺失（P3.5 之前写的旧数据）→ 当 `'ok'`
- `value` 解析失败 → **跳过该行**（不崩、也不画 0 分行）

### 主域 → 开放域消息

```js
{
  type: 'showLeaderboard',
  key: 'circle',
  selfScore: 92.4,        // 本地最新分（**兜底**：托管数据读不到时用）
  selfLevel: 4,
  width: 700, height: 1180, pixelRatio: 2,
  rankNames: ['灾难现场', '一团面条', ..., '神之圆'],   // 段位名表（主域算好 → 开放域不复制）
  style: {
    rowH: 96, avatarR: 32, showAvatar: true,
    nameSize: 28, scoreSize: 34, rankSize: 26,
    colorText: '#2C2C2A', colorDim: '#8C8A82', colorSelf: '#B4643C',
    colorPanel: '#F7F5F0', colorLine: '#E3E0D8'
  }
}
{ type: 'hideLeaderboard' }
```

## 文件结构

```
who-is-circle/
├── open-data/
│   ├── index.js       ← 改造：wx 拉数据 + 头像加载 + 消息驱动 + 重画
│   └── board.js       ← 新增：纯逻辑（解析/归一化/排序/名次/截断/绘制），UMD，Node 可测
├── js/
│   └── leaderboard.js ← 新增：主域桥接（消息组装 + 样式参数 + 段位名表），UMD
├── game.js            ← 改造：榜面 overlay 页 + 首页入口按钮 + 隐私门禁
└── index.html         ← 改造：加 <script src="js/leaderboard.js">

who-is-circle-tests/
├── unit/board.test.js        ← 新增：board.js 纯逻辑 + 绘制
├── unit/leaderboard.test.js  ← 新增：js/leaderboard.js + game.js 榜面接线
└── unit/opendata.test.js     ← 改造：P1 契约断言更新 + index.js 拉取 / 降级
```

**为什么 `board.js` 要独立成文件**：开放数据域的 `require` 只在**同目录内**合法（已查证）。
把纯逻辑（解析 / 排序 / 截断 / 绘制）拆出去，才能在 Node 里用假 ctx 直接断言绘制调用；
留在 `index.js` 里就只能真机验，回归套件护不住。

**为什么 `js/leaderboard.js` 要独立**：它是**主域**代码，和 `js/cloud.js` 同一个模式（UMD + 可选依赖）。
游戏主逻辑 `game.js` 已经 1600 行，桥接逻辑（消息组装 / 样式参数 / 段位名表）单独成文件才能单测。

## 明确取舍（本阶段要写进 README，不能默默做）

| # | 取舍 | 结论与理由 |
|---|---|---|
| Q1 | P4 要不要做入口按钮与 overlay？ | **做**。P4 的完成标志是「预览里能看到好友榜」—— 没有显示位置就无法验收。而且设计文档 §8.1 的入口位置（中心 375,772，280×88）**正好就是 P1 占位块的位置**（`CFG.OD_PLACEHOLDER` 中心 375,848），顺手接上。P5 剩下：隐私门禁的空态打磨、0/1 人的空态文案、视觉调参。 |
| Q2 | 隐私门禁放 P4 还是 P5？ | **放 P4**。设计文档 §十把 §8.3 列在 P5，但门禁缺了会出事：玩家点了按钮 → `wx.getFriendCloudStorage` 失败 → 榜空白 → **玩家没有路径去授权**，功能对他永久不可用。合规上也不该先发一版会拉好友数据却不管授权的。P4 做**最小闭环**（三态检查 → authorize → 不行就 `wx.openSetting`），P5 做视觉打磨。 |
| Q3 | 段位名从哪来？ | **主域发 `rankNames`（13 个名字）**。开放数据域不能 `require` 主域的 `shared/scoring.js`，自己复制一份段位表必然漂移（云函数那份已经有 sha256 断言了，主域这份不能再分叉）。 |
| Q4 | 「我的历史最高 92.4 · 第 3 名」画在哪？ | **画在开放域的 sharedCanvas 底部**。开放域 → 主域是单向的，名次回不去（见上）。设计文档 §8.2 那句「主域只画文案」要改。 |
| Q5 | 自己怎么进榜、怎么认出来？ | `wx.getUserCloudStorage` 单独拉 → **按来源**标记 `isSelf`（不是按 openid 比对：`getUserCloudStorage` 的返回里没有 openid，云函数出参也没有 openid，没法拿它做键）。**自己的名字直接画「我」** —— 开放域拿不到自己的昵称（`getUserCloudStorage` 不返回），我们知道那行是我们就够了。好友列表内部按 openid 去重（保留分高的那条）。若某行与自己的**托管数据原文完全相同** → 视为同一人，丢掉好友那行（平台保证好友列表不含自己；用原文而不是分数做判据 —— 两个人同分很常见，但「同样的分 + 段位 + update_time（秒级）」几乎只可能是同一次写入）。 |
| Q6 | 托管数据读不到自己的怎么办？ | 三态：**读到了且有数据** → 正常入榜、正常名次；**读到了但没有托管数据**（从没上榜）→ 不入榜，底部显示「你还没有上榜」；**API 失败** → 用消息里的 `selfScore` 兜底画一行，**不参与排序、不给名次**，底部显示「本地最高 X（未上榜）」。绝不用本地分冒充榜上的分。 |
| Q7 | 榜上放不下怎么办？ | 内容区 700×1180，行高 96 → 最多画 **10 行**。底部那行分两段：**左**＝自己的信息（名次或未上榜），**右**＝「还有 N 位好友在玩」（仅当超出 10 行时才画）。哪怕自己不在前 10 行里，底部也显示**真名次**。 |
| Q8 | 好友数为 0 / 只有 1 人？ | 0 人 → 画「还没有好友在玩」+ 一句引导；≤1 人 → **不画名次列**（设计文档 §十二 风险表的要求，没对比就不占地方）。 |

## 榜面几何（设计px，750×1624 稿）

主域（`game.js`）：

| 元素 | 位置 / 尺寸 |
|---|---|
| 全屏遮罩 | `(0,0,750,1624)`，`rgba(44,44,42,0.55)` |
| 标题「好友排行」 | 中心 `(375,150)`，`bold 44px` |
| sharedCanvas 内容矩形 | `(25,210,700,1180)` |
| 底部「返回」按钮 | 中心 `(375,1500)`，`340×96`，`drawButton` 的 secondary 样式 |
| 关闭方式 | **左上角返回箭头**（沿用 `iconButtons()` 既有约定，热区 96×96）+ 底部「返回」 |

> **没有右上角「×」**：右上角是微信胶囊按钮（设计文档 §8.1 明确「不放顶栏」），
> 放上去会打架；左上角返回箭头本来就是这个游戏关页面的方式。
>
> **首页入口按钮 y = 830**（设计文档 §8.1 写的是 772）：那个坐标没算上
> 「最佳 XX · 段位」那一行（它在 y=740），按钮会压到字上。

开放域（`open-data/board.js`）内容区 700×1180：

| 元素 | 位置 |
|---|---|
| 行区 | 顶部留白 20，行高 96，**最多 10 行** |
| 底部自己那行 | y = 1180 − 96（高 96），上边框线 `colorLine` |
| 空态文案 | 内容区正中 |

单行（行高 96）内部，从左到右：

| 元素 | 位置（内容区局部坐标） |
|---|---|
| 名次 | 右对齐到 x=56，`rankSize` |
| 头像 | 圆心 (108, 48)，直径 64（`avatarR` 决定半径） |
| 昵称 | 左边距 x=150，`nameSize` |
| 段位名 | 左边距 x=430，`nameSize`（段位名都是 4 个字） |
| 分数 | 右对齐到 x=700，`scoreSize`，`toFixed(1)` |

- 昵称按测量宽度截断到 `430 − 150 − 段位名宽 − 分数宽 − 间距`
- 自己的行：**名字画成「我」**（开放域拿不到自己的昵称），整行文字用 `colorSelf`
- `v === 'unverified'` 的行：段位名后面画一个小角标「未完全验证」（`colorDim`，24px）

## 任务

### Task 1：`open-data/board.js` —— 纯逻辑 + 绘制

**Files:**
- Create: `who-is-circle/open-data/board.js`
- Test: `who-is-circle-tests/unit/board.test.js`

**Interfaces（后续任务只依赖这些名字与签名）：**

```js
// UMD 包装（同 shared/scoring.js 的写法：module.exports + 全局 root.Board）
parseHostingValue(value)            // → {score, level, verdict} | null
normalizeFriendEntry(entry, key)    // → row | null
normalizeSelfEntry(entry, key)      // → row | null
mergeRows(friendRows, selfRow)      // → rows（去重 + 排序 + 每行带 .rank）
truncateText(ctx, text, maxWidth)   // → string（按测量宽度，超出加 …）
rankNameOf(level, rankNames)        // → string（越界 → '段位 ?'）
clampStyle(style)                   // → style（每项钳制；缺失/越界 → 默认值）
drawBoard(ctx, rows, opts)          // → 画到画布；opts: {width,height,style,rankNames,avatarImages,selfScore,emptyText}
```

row 结构：`{ openid, nickname, avatarUrl, score, level, verdict, isSelf, raw }`
（`raw` = 托管数据原文，用来判「是不是同一个人」；`rank` 在 `mergeRows` 之后附加）

- [ ] **Step 1：写失败用例**（`unit/board.test.js`）

  必须覆盖：

  - `parseHostingValue('{"wxgame":{"score":978},"level":11}')` → `{score:97.8, level:11, verdict:'ok'}`
  - `parseHostingValue` 遇到 `v:'unverified'` → `verdict:'unverified'`
  - `parseHostingValue` 遇到非法 JSON → `null`
  - `parseHostingValue` 遇到 `wxgame` 缺失 → `null`
  - `mergeRows` 三行（97.8 / 92.4 / 97.8）→ 名次 1,2,3（**同分要有稳定次序**，用输入顺序做 tiebreak）
  - `mergeRows` 传入自己那行 → 该行 `isSelf === true` 且 `rank` 正确
  - `mergeRows` 好友列表里同一个 openid 出现两次 → 只留一条（保留分高的）
  - `mergeRows` 某行与自己的**托管数据原文相同** → 好友行被丢掉（自己不会在榜上出现两次）
  - `mergeRows` 某行与自己**同分但原文不同** → 两个人都留（不能只凭分数去重）
  - `truncateText(ctx, '很长很长很长', 100)` → 宽度 ≤ 100 且以 `…` 结尾
  - `truncateText` 文本本身就短 → 原样返回
  - `rankNameOf(99, rankNames)` → 越界 → `'段位 ?'`
  - `clampStyle({rowH:0, nameSize:999, colorText:'red'})` → `rowH` 回到默认、`nameSize` 被钳到上限、`colorText` 保持合法颜色
  - `clampStyle(undefined)` → 全部默认值
  - `drawBoard` 用假 ctx 断言：行数 = rows.length、`fillText` 调用里出现了「1」「2」「3」名次、自己的行名字是「我」且用了 `colorSelf`、`unverified` 出现了「未完全验证」

  假 ctx 至少要有：`fillText`、`measureText`（返回 `{width: 文本长度 × 字号 / 2}`）、`fillRect`、`fill`、`stroke`、`arc`、`save`、`restore`、`translate`、`beginPath`、`closePath`、`setTransform`、`measureText`。

- [ ] **Step 2：跑测试确认失败**

  Run: `node unit/board.test.js`
  Expected: FAIL —— `Cannot find module '../../who-is-circle/open-data/board.js'`

- [ ] **Step 3a：实现 `parseHostingValue` / `normalizeFriendEntry` / `normalizeSelfEntry` / `mergeRows`**

  - UMD 包装照抄 `shared/scoring.js` 的头（`module.exports` + `root.Board`），根取 `GameGlobal` → `globalThis` → `window`
  - `parseHostingValue`：`JSON.parse` 包 try/catch；取 `wxgame.score / 10`、`level`、`v`（缺省 `'ok'`）；`score` 非有限数或为负 → `null`
  - `normalizeFriendEntry(entry, key)`：从 `entry.KVDataList` 里找 `key` 匹配的那条 → 解析它的 `value`；解析不出 → `null`（**该好友直接跳过，不占名次**）
  - `normalizeSelfEntry(entry, key)`：同上，但 `isSelf = true`
  - `mergeRows(friendRows, selfRow)`：好友按 openid 去重（保留 score 大的，位置不动）→ 若某行的 `raw` 与自己那行的 `raw` 完全相同 → 丢掉它（自己不会在榜上出现两次）→ 拼上自己那行 → 按 score 降序排（**同分按输入顺序稳定**）→ 附加 `rank = index + 1`

  跑 `node unit/board.test.js` → 前半段断言应转绿。

- [ ] **Step 3b：实现 `truncateText` / `rankNameOf` / `clampStyle`**

  - `truncateText(ctx, text, maxWidth)`：先量宽，超了就逐字裁到 `maxWidth - 省略号宽`，再补 `…`
  - `rankNameOf(level, rankNames)`：`rankNames` 是数组且下标在范围内 → 取值；否则 `'段位 ?'`
  - `clampStyle(style)`：每项都有区间（行高 60–140、头像半径 16–48、字号 16–48、`rowH` 整数、`showAvatar` 布尔），越界/缺失 → 默认值；颜色只接受 `#RRGGBB`/`#RRGGBBAA`，否则用默认

  跑 `node unit/board.test.js` → 应全绿。

- [ ] **Step 3c：实现 `drawBoard`**

  - 按「榜面几何」表画：行区顶部留白 20、行高 96、**最多 10 行**，行内容为
    `名次(右对齐) | 头像 | 昵称 | 段位名 | 分数(右对齐)`
  - `opts.avatarImages` 是 `openid → image 对象` 的映射；缺失或未加载完 → 画兜底圆 + 昵称首字（**不崩、不留白**）
  - 昵称按测量宽度截断（`truncateText`），空昵称用「微信用户」
  - 自己的行：**名字画成「我」**（开放域拿不到自己的昵称），整行文字用 `colorSelf`
  - `verdict === 'unverified'` 的行：段位名后画「未完全验证」角标（`colorDim`，24px）
  - **底部固定一行**（y = 1180 − 96，上边框线 `colorLine`）：
    - 左半：自己有行 → 「我的历史最高 {score.toFixed(1)} · 第 {rank} 名」
      ／自己没行但 `opts.selfScore` 有值 → 「本地最高 {X}（未上榜）」（**不给名次**）
      ／都没有 → 「你还没有上榜」
    - 右半：行数超过 10 时 → 「还有 N 位好友在玩」（右对齐，`colorDim`）
  - `rows` 为空 → 在内容区正中画 `opts.emptyText`

- [ ] **Step 4：跑测试确认通过**

  Run: `node unit/board.test.js`
  Expected: PASS（本文件全绿）

- [ ] **Step 5：提交**

  ```bash
  git add who-is-circle/open-data/board.js who-is-circle-tests/unit/board.test.js
  git commit -m "feat(P4): 开放数据域纯逻辑（解析/排序/名次/截断/绘制）"
  ```

### Task 2：`open-data/index.js` —— 拉数据 + 消息 + 头像 + 重画

**Files:**
- Modify: `who-is-circle/open-data/index.js`（P1 的占位实现整体替换）
- Test: `who-is-circle-tests/unit/opendata.test.js`（扩写）

**Interfaces:**
- Consumes: Task 1 的 `board.js` 全部导出
- Produces: `module.exports = { bootstrap, handleMessage, pull, render }`
  - `handleMessage(msg)` —— 处理 `showLeaderboard` / `hideLeaderboard`
  - `pull(wxApi, key)` —— 拉好友 + 自己 → 返回 `{rows, error}`
    （`rows` 已经过 `mergeRows`：**已排序、已带 `rank`、自己那行 `isSelf === true`**；
    自己那行读不到时 `rows` 里就只有好友，`error` 带上原因）
  - `render(wxApi, state)` —— 按 `state` 画到 sharedCanvas

- [ ] **Step 1：写失败用例**（扩 `unit/opendata.test.js`）

  **先把 P1 阶段的断言改掉**（它们在 P4 已经不成立）：

  - 原来「P1 阶段不得调好友/用户云存储 API」→ 改成「**P4 必须调** `wx.getFriendCloudStorage` 与 `wx.getUserCloudStorage`」
  - 原来「index.js 不 require 主域模块（沙盒内无主域 require）」→ 改成「**只允许 require 同目录**（`./` 开头），不得出现 `../`」
  - 原来「index.js 不引用远程 URL（开放数据域禁远程图片）」→ 改成「**不得出现 `wx.request`**；`avatarUrl` 是平台给的数据不算违规远程地址」

  **新增断言**（测试前先 `global.wx = fakeWxApi` 再 `require` index.js ——
  index.js 见到 `wx` 就会自动 bootstrap；`pull` / `render` 也可直接传假 wx）：

  - `open-data/board.js` 存在且 Node 可 require
  - `index.js` 里 `require` 的目标全部以 `./` 开头
  - `index.js` 不含 `wx.request`
  - `pull(fakeWxApi, 'circle')`：假 wx 的 `getFriendCloudStorage` 返回 2 个好友
    （托管数据分别 97.8 / 92.4）、`getUserCloudStorage` 返回自己 88.0
    → 得到 3 行，且自己那行 `isSelf === true`、`rank` 正确
  - `getFriendCloudStorage` 失败（`fail` 回调）→ `pull()` 返回 `error`，**不抛异常**
  - `getUserCloudStorage` 失败 → `pull()` 仍然返回好友行（`rows` 里没有 `isSelf` 的行）
  - `handleMessage({type:'showLeaderboard', key:'circle', ...})` → 触发一次 pull + 一次 render
  - `handleMessage({type:'hideLeaderboard'})` → 不再 pull
  - `handleMessage({})`（未知类型）→ 什么都不做、不抛
  - `render(fakeWxApi, state)` 用假 ctx 时不抛异常（画布尺寸为 0 也要安全）

- [ ] **Step 2：跑测试确认失败**

  Run: `node unit/opendata.test.js`
  Expected: FAIL —— 旧断言（不得调好友 API）与新断言（必须调）冲突

- [ ] **Step 3a：实现 `pull(wxApi, key)`**

  - 结构：`UMD 包装 → factory(require('./board.js')) → 返回 API`
  - `wxApi.getFriendCloudStorage({keyList:[key], success, fail})` 与
    `wxApi.getUserCloudStorage({keyList:[key], success, fail})`
  - 两个都包成 Promise，**好友失败不牵连自己，自己失败不牵连好友**
  - 好友返回的元素逐个过 `normalizeFriendEntry`（解析不出的**直接跳过**），
    自己的过 `normalizeSelfEntry`，最后交给 `mergeRows` → 返回 `{rows, error}`

  跑 `node unit/opendata.test.js` → 「拉取」那几条断言应转绿。

- [ ] **Step 3b：实现 `handleMessage` 与消息状态**

  - 模块内维护一份 `msgState`：`{key, style, rankNames, width, height, pixelRatio, selfScore, selfLevel}`
  - `handleMessage(msg)`：
    - `type === 'showLeaderboard'` → 存下 `msgState` → 画「加载中」→ `pull` → `render`
    - `type === 'hideLeaderboard'` → 停（不再 pull、不再画）
    - 其他类型 / 空消息 → 什么都不做、**不抛**
  - `bootstrap()`：`wx.onMessage(handleMessage)` + 首次 `render`（还没收到消息 → 画布尺寸为 0 → 直接 return）

- [ ] **Step 3c：实现 `render(wxApi, state)` 与头像加载**

  - 画布：`canvas.width = round(width × dpr)`、`canvas.height = round(height × dpr)`、`ctx.setTransform(dpr,0,0,dpr,0,0)`
  - **尺寸为 0 时**（还没收到消息）→ 直接 return，不画
  - 头像：`wx.createImage()`，`src = avatarUrl`；`onload` → 记进 `avatarImages` 并重画；`onerror` → 记为失败（**不重画、不崩**）
  - 没有 `avatarImages[openid]` 的行 → `drawBoard` 走兜底（色块 + 昵称首字）
  - 拉取失败 → 画「暂时读不到好友数据」（**不空白**）

  跑 `node unit/opendata.test.js` → 全部转绿。

- [ ] **Step 4：跑测试确认通过**

  Run: `node unit/opendata.test.js` && `node unit/board.test.js`
  Expected: 两个文件全绿

- [ ] **Step 5：提交**

  ```bash
  git add who-is-circle/open-data/index.js who-is-circle-tests/unit/opendata.test.js
  git commit -m "feat(P4): 开放数据域拉好友数据并画榜（含头像兜底与降级）"
  ```

### Task 3：`js/leaderboard.js` —— 主域桥接

**Files:**
- Create: `who-is-circle/js/leaderboard.js`
- Test: `who-is-circle-tests/unit/leaderboard.test.js`

**Interfaces:**
- Consumes: `Scoring.RANKS`（段位表，来自 `shared/scoring.js`）
- Produces:

```js
buildStyleParams()                       // → style 对象（值与设计文档 §6.4 一致）
buildShowMessage(opts)                   // → {type:'showLeaderboard', ...}
buildHideMessage()                       // → {type:'hideLeaderboard'}
resolveRankNames(ranks)                  // → string[]（ranks.map(r => r.name)）
classifyPrivacy(authValue)               // → 'granted' | 'denied' | 'unset'
```

- [ ] **Step 1：写失败用例**（`unit/leaderboard.test.js`）

  - `buildStyleParams()` 的每一项与设计文档 §6.4 的值**逐项相等**（这是「样式单一来源在主域」的契约）
  - `buildShowMessage({key:'circle', selfScore:92.4, selfLevel:4, width:700, height:1180, pixelRatio:2, rankNames:[...]})` → 消息里字段齐全，`type === 'showLeaderboard'`
  - `buildShowMessage` 缺 `rankNames` → 仍然是合法消息（`rankNames` 为空数组），**不抛**
  - `buildHideMessage()` → `{type:'hideLeaderboard'}`
  - `resolveRankNames(Scoring.RANKS)` → 长度 13，首项 `'灾难现场'`，末项 `'神之圆'`
  - `classifyPrivacy(true)` → `'granted'`；`false` → `'denied'`；`undefined` → `'unset'`

- [ ] **Step 2：跑测试确认失败**

  Run: `node unit/leaderboard.test.js`
  Expected: FAIL —— `Cannot find module '../../who-is-circle/js/leaderboard.js'`

- [ ] **Step 3：实现 `js/leaderboard.js`**

  - UMD 包装照抄 `js/cloud.js` 的头（`root.Leaderboard`）
  - `buildStyleParams()`：值**硬编码在函数里**（单一来源），与设计文档 §6.4 完全一致
  - `buildShowMessage(opts)`：把 `opts` 里的字段组装进去，缺字段用默认值（`key:'circle'`、`width:700`、`height:1180`、`pixelRatio:2`）
  - `classifyPrivacy(authValue)`：三态映射

- [ ] **Step 4：跑测试确认通过**

  Run: `node unit/leaderboard.test.js`
  Expected: PASS

- [ ] **Step 5：提交**

  ```bash
  git add who-is-circle/js/leaderboard.js who-is-circle-tests/unit/leaderboard.test.js
  git commit -m "feat(P4): 主域榜单桥接（消息组装 + 样式参数 + 段位名表）"
  ```

### Task 4：`game.js` —— overlay 页 + 首页入口 + 隐私门禁

**Files:**
- Modify: `who-is-circle/game.js`
- Modify: `who-is-circle/index.html`（加 `<script src="js/leaderboard.js">`）
- Test: `who-is-circle-tests/unit/leaderboard.test.js`（加第二节）

**Interfaces:**
- Consumes: Task 3 的 `buildShowMessage` / `buildHideMessage` / `buildStyleParams` / `resolveRankNames` / `classifyPrivacy`
- Produces（`module.exports` 新增，便于单测）：

```js
openLeaderboard()      // 走隐私门禁 → 成功后进 'rank' 页并 postMessage
closeLeaderboard()     // 回 'home' 并 postMessage hide
rankPanelLayout()      // → {mask, title, closeBtn, content, backBtn}（几何，单测用）
resendShowOnShow()     // wx.onShow 时若在 'rank' 页 → 补发一次 showLeaderboard
```

- [ ] **Step 1：写失败用例**（`unit/leaderboard.test.js` 第二节）

  - `rankPanelLayout()` 的几何与本计划「榜面几何」表一致（内容矩形 `(25,210,700,1180)`、关闭按钮热区 ≥88×88、底部按钮不与内容矩形重叠）
  - `openLeaderboard` 在**已授权**时：切到 `state.page === 'rank'`，且向开放域发了 `showLeaderboard` 消息
  - `openLeaderboard` 在**未授权（denied）**时：不切页，弹出引导，并调用 `wx.openSetting`
  - `openLeaderboard` 在**未决定（unset）**时：先调 `wx.authorize({scope:'scope.friendCloudStorage'})`；授权成功 → 切页；失败 → 调 `wx.openSetting`
  - 任何 wx 调用抛异常 → 不崩，`state.page` 不变
  - 非微信环境（`hasWx === false`）→ `openLeaderboard()` 不切页（浏览器端没有好友榜），且不抛
  - `resendShowOnShow()`：在 `'rank'` 页 → 再发一次 `showLeaderboard`；不在 → 不发

- [ ] **Step 2：跑测试确认失败**

  Run: `node unit/leaderboard.test.js`
  Expected: FAIL —— `openLeaderboard` 未定义

- [ ] **Step 3a：加几何常量与 `rankPanelLayout()`**

  - `CFG` 新增：
    - `RANK_BTN: {x:375, y:772, w:280, h:88}`（**就是 P1 占位块的位置**）
    - `RANK_PANEL: {mask:{x:0,y:0,w:750,h:1624}, title:{x:375,y:150}, closeBtn:{x:660,y:132}, content:{x:25,y:210,w:700,h:1180}, backBtn:{x:375,y:1500,w:340,h:96}}`
  - `rankPanelLayout()` 返回 `CFG.RANK_PANEL`（单测直接比几何）
  - `state.page` 增加 `'rank'`；`renderPage` 增加 `renderRank` 分支

  跑 `node unit/leaderboard.test.js` → 几何那几条转绿。

- [ ] **Step 3b：画榜面（`renderRank` + 入口按钮 + 贴图）**

  - `renderHome`：把 `drawOpenData(c)`（P1 占位块）**换成**
    `drawButton(c, CFG.RANK_BTN, '好友排行', pressedRatio('rank'), false)`（secondary 样式）
  - `renderRank`：遮罩 + 标题「好友排行」+ 关闭按钮「×」+ 贴 sharedCanvas（内容矩形）+ 底部「返回」按钮
  - 贴图逻辑：把现有 `drawOpenData` 的「等比居中」抽成 `drawSharedCanvas(c, rect)`，`renderHome` 与 `renderRank` 共用
  - 触摸：首页点 `RANK_BTN` → `openLeaderboard()`；`rank` 页点关闭/返回 → `closeLeaderboard()`

- [ ] **Step 3c：隐私门禁 + postMessage（`openLeaderboard` / `closeLeaderboard`）**

  - `openLeaderboard()` 的门禁流程（Q2）：
    ```
    wx.getSetting() → authSetting['scope.friendCloudStorage']
      granted → 进页 + postMessage(showLeaderboard)
      denied  → toast「已关闭向朋友公开」+ wx.openSetting()
      unset   → wx.authorize({scope:'scope.friendCloudStorage'})
                   success → 进页 + postMessage
                   fail    → wx.openSetting()
    ```
  - 三态判定用 Task 3 的 `classifyPrivacy`
  - `postMessage`：`wx.getOpenDataContext().postMessage(msg)`，**包 try/catch**
    （老基础库没有这个 API → 静默降级，页面照常显示，只是榜是空的）
  - 消息用 Task 3 的 `buildShowMessage`，段位名用 `resolveRankNames(RANKS)`，
    `selfScore` 用 `state.best`（本地最高分，作兜底）
  - `closeLeaderboard()`：回 `'home'` 页 + `postMessage(buildHideMessage())`
  - **补发机制**（设计文档 §十二 风险表：「主域在 `onShow` 后补发一次 `showLeaderboard`」）：
    `wx.onShow` 里如果当前在 `'rank'` 页 → **重新 postMessage 一次 `showLeaderboard`**
    （`sharedCanvas` 在页面切换 / `onShow` 后内容会丢，重发让开放域重画）
  - 任何 wx 调用抛异常 → 不崩、`state.page` 不变

- [ ] **Step 3d：浏览器端降级 + `index.html`**

  - `js/leaderboard.js` 按 `js/cloud.js` 的模式做**可选依赖**
    （`require` 失败或全局缺失 → 榜相关功能全部关闭：首页不画「好友排行」按钮，e2e 像素断言不受影响）
  - `index.html`：在 `game.js` 之前加 `<script src="js/leaderboard.js"></script>`

- [ ] **Step 4：跑测试确认通过**

  Run: `node unit/leaderboard.test.js` && `npm test`
  Expected: 全绿（**e2e 不在 `npm test` 里，浏览器端首页少了一个按钮 —— 需要单独确认 e2e 是否受影响**）

- [ ] **Step 5：跑 e2e 并处理按钮消失的影响**

  Run: `cd who-is-circle-tests && npm run test:e2e`
  Expected: PASS。若首页像素断言因少了占位块而红，**改断言**（占位块本来就要被替换掉），不要为了保住旧断言把占位块留着。

- [ ] **Step 6：提交**

  ```bash
  git add who-is-circle/game.js who-is-circle/index.html who-is-circle-tests/unit/leaderboard.test.js
  git commit -m "feat(P4): 榜面 overlay + 首页入口 + 隐私门禁"
  ```

### Task 5：文档 + 真机验收清单

**Files:**
- Modify: `docs/superpowers/specs/2026-11-01-friend-leaderboard-design.md`
- Modify: `who-is-circle/README.md`

- [ ] **Step 1：改设计文档**

  - §6.4：消息协议补 `rankNames` 字段，并写明「主域发段位名表，开放域不复制段位表」
  - §8.2：把「名次由开放域算好，主域只画文案」改成「**底部那行由开放域画在 sharedCanvas 里**（开放域 → 主域单向，名次回不去）」
  - §十 P4 行：标 ✅ 已完成 + 写明 Q1–Q8 的结论
  - §十一：把「榜单含自己且高亮」「好友数据未授权时显示引导」两条标成待验（真机验完再勾）

- [ ] **Step 2：改 README**

  - 真机验证章节加「怎么验好友榜」：需要**两个都玩过这个游戏的微信号互加好友**（单向好友可能拉不到）
  - 写清「模拟器里看不到好友榜」（开放数据域与好友数据在模拟器里是空的）→ 只能真机
  - 写清「榜上是自己最高分，不是最后一局」（P3.5 的口径）

- [ ] **Step 3：提交**

  ```bash
  git add docs/superpowers/specs/2026-11-01-friend-leaderboard-design.md who-is-circle/README.md
  git commit -m "docs(P4): 设计文档与 README 同步榜面口径与真机验收步骤"
  ```

## Review Focus

下面五条是**规格隐含、但没有哪条验收清单点名的输入**。每条都对应本计划里某个任务的断言 —— 写实现时别把它们当边界情况随便处理过去。

| # | 输入 / 情形 | 合理的人会期望 | 归到哪个任务 |
|---|---|---|---|
| 1 | 托管数据里**没有 `v` 字段**（P3.5 之前写的旧数据） | 当普通有效成绩显示，**不能**当「未完全验证」，更不能崩 | Task 1（`parseHostingValue`） |
| 2 | `wxgame.score` 是 `0` / 不是 10 的倍数 / 负数 | 0 分的行**要能画出来**（别用 `!score` 判断空）；不是 10 的倍数 → 除出带小数的分；负数 → 跳过该行 | Task 1 |
| 3 | 好友列表里**同一个 openid 出现两次** | 只出现一行，且是分高的那条 | Task 1（`mergeRows`） |
| 4 | 昵称**超长 / 含 emoji / 为空** | 按测量宽度截断（不是按字数 —— emoji 宽度差 2 倍）；空昵称显示「微信用户」 | Task 1 |
| 5 | 主域把 `style` 传错（`rowH: 0`、`nameSize: 9999`、`colorText: 'red'`） | 榜不歪、不崩：用默认值或钳到区间 | Task 1（`clampStyle`） |

> 补充两条容易漏的：**没有好友在玩**（0 行 → 空态文案，不是空白页）；
> **自己没上榜**（底部显示「你还没有上榜」，不显示本地分冒充榜上的分 —— Q6）。

## 自检

**规格覆盖**

| 设计文档条目 | 落在哪 |
|---|---|
| §6.3 托管数据格式 | Task 1（`parseHostingValue`） |
| §6.4 消息协议 + 样式钳制 | Task 3（组装）+ Task 1（`clampStyle`） |
| §8.1 入口位置与样式 | Task 4（`CFG.RANK_BTN`） |
| §8.2 榜面行内容与截断 | Task 1（`drawBoard` / `truncateText`） |
| §8.3 隐私门禁三态 | Task 4（`openLeaderboard`） |
| §十 P4 行「预览里能看到好友榜，含自己并高亮」 | Task 2 + Task 4（Task 5 的真机验收） |
| §十一「未授权时显示引导，不空白、不报错」 | Task 2（拉取失败降级）+ Task 4（门禁） |
| §十一「名次连续正确」 | Task 1（`mergeRows`） |
| §十二「0/1 人优雅处理」 | Q8 + Task 1（空态） |
| §十二「`postMessage` 时序 → 主域在 `onShow` 后补发一次 `showLeaderboard`」 | Task 4（`resendShowOnShow`） |
| §十一「`sharedCanvas` 在 `onShow` / 页面切换后能重画（不空白）」 | Task 4（同上）+ Task 2（收到消息即重画） |

**类型一致**：`row` 的字段名在 Task 1 定义（`openid/nickname/avatarUrl/score/level/verdict/isSelf/rank`），
Task 2 产出、Task 4 不直接碰 row（只发消息）✓；`opts.avatarImages` 只在 Task 1/2 之间流转 ✓。

**已知的遗留**：设计文档 §8.2 的「主域只画文案」与 §6.4 的单向约束冲突 → Task 5 改文档，不改实现。

## 真机验收清单（Task 5 交付后执行）

前置：**两个都玩过这个游戏的微信号互加好友**（单向好友可能拉不到数据），
且两人都写过托管数据（玩一局、破纪录、看到「托管数据写入成功」日志）。

| # | 步骤 | 期望 |
|---|---|---|
| 1 | A 打开游戏 → 点「好友排行」 | 弹出全屏榜面，不是空白 |
| 2 | 榜面里能看到 B | B 的分 = B 的**最高分** |
| 3 | 自己的行 | 高亮（`colorSelf`）+ 名前有「我 · 」 |
| 4 | 底部那行 | 「我的历史最高 X · 第 N 名」，N 与榜上的名次一致 |
| 5 | B 的分是 `unverified`（用开发版造） | 那行有「未完全验证」角标 |
| 6 | 点「×」/「返回」 | 回到首页，榜面消失 |
| 7 | A 拒绝「向朋友公开」后再点 | 弹出引导，不空白、不报错 |
| 8 | A 切后台再切回（`onShow`） | 榜面能重画，不空白（设计文档 §十一 的 `sharedCanvas` 丢内容那条） |
| 9 | 模拟器 | **看不到好友榜是正常的**（模拟器没有好友数据） |

## 实施记录（2026-11-07，5 个任务全部完成）

| 提交 | 内容 |
|---|---|
| `9e47d12` | Task 1：`open-data/board.js` 纯逻辑 + 绘制（79 项断言） |
| `c51e7be` | Task 2：`open-data/index.js` 拉数据 + 消息 + 头像 + 降级（43 项断言） |
| `9eeea41` | Task 3：`js/leaderboard.js` 主域桥接（46 项断言） |
| `b24a7b4` | Task 4：`game.js` overlay + 入口 + 隐私门禁（85 项断言） |
| `54d3e6b` | Task 5：设计文档 + README 同步 |

**实施时改了计划里的 5 处设计**（都在上面的任务里就地改了，这里汇总）：

1. **自己的名字画「我」，不加「我 · 」前缀** —— `wx.getUserCloudStorage` 的返回里**没有 nickname**，
   拿不到自己的昵称。我们知道那行是我们就够了。
2. **「好友列表混进自己」改用托管数据原文判重** —— 不能靠昵称（我们不知道自己的昵称），
   也不能只靠分数（两个人同分很常见 → 会错杀一个好友）。
   判据改成「托管数据原文完全相同」：同样的分 + 段位 + `update_time`（秒级）几乎只可能是同一次写入。
3. **首页入口 y = 830**（计划写的 772）—— 772 压到「最佳 XX · 段位」那行（它在 y=740）。
4. **不画右上角「×」** —— 右上角是微信胶囊按钮（§8.1 明确「不放顶栏」）；
   用左上角返回箭头关（`iconButtons()` 的既有约定，热区 96×96）。
5. **toast 按页分位置** —— toast 原来只在画圆页用（1/3 处，y=541）；
   这是它第一次出现在首页，会盖住 logo（420..700）→ 首页挪到 1120。

**e2e 跑通了**（8/8）：`npm run test:e2e` → **8 条通过 / 0 条失败**。

启动预览服务有两条路，之前只想到第一条（结果没起成）：

| 方式 | 命令 | 说明 |
|---|---|---|
| MCP（推荐） | MCP 的 `run_game` 工具（workspacePath = 项目目录） | 返回 `http://localhost:3847`，**绑在 IPv6 上**（`127.0.0.1:3847` 连不上，要用 `localhost`） |
| 开发者工具 GUI | 窗口开着 → 预览 | 端口随机，日志里能找到；我这次那条路返回 500（模拟器会话失效） |

> 踩坑：开发者工具 GUI 那条路，窗口虽然开着（标题「谁最圆」），
> 但预览服务的 `/game.js` 返回 **500**（模拟器会话已经失效）——
> e2e 的表现是「预览页未就绪」，看着像环境没起，其实是会话坏了。
> MCP 的 `run_game` 是幂等的，重新调一次就好。

e2e 截图确认：模拟器里首页「最佳 96.3 · 教科书」+「好友排行」按钮位置正确、不压字。
真机验证清单在 `who-is-circle/README.md` 的「P4：好友榜」一节。

---

## 与 P5 的边界

P4 做完之后 P5 只剩这些：**未授权引导的视觉打磨**、**0/1 人的空态文案**、
**段位名过长的实测调参**、**「我的排名」底部行的视觉微调**、以及可能需要的**入场动画**。

P4 已经做完的：入口按钮（位置按 §8.1）、overlay 面板、隐私门禁三态、榜面全部绘制逻辑。
