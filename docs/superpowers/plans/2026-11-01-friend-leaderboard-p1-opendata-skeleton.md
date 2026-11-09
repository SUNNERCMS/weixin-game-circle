# P1：开放数据域骨架

> 承接 `2026-11-01-friend-leaderboard-p0-scoring-extraction.md`（P0 已合入 `main`）。
> 设计文档：`2026-11-01-friend-leaderboard-design.md` §十 P1 行。

## 目标

把 `openDataContext` 接进项目，让**主域能拿到 `sharedCanvas` 并贴出一块占位内容**。

P1 **不碰**好友数据、不碰云函数、不碰榜面 UI——只验证一件事：**"开放数据域这条路通不通"**。
如果这条路走不通（预览器不支持、贴图姿势不对、开放数据域加载失败），后面 P2–P5 全部要重新评估，
所以这一步单独隔离、单独验证。

## 完成标志

| # | 标志 | 验证方式 |
|---|---|---|
| 1 | 开发者工具预览里能看到占位内容 | 截图 + 像素断言 |
| 2 | `open-data/index.js` 语法正确 | `node --check` |
| 3 | 现有 60 项单测 + 8 条 e2e 像素断言**不回归** | `npm test` / `npm run test:e2e` |
| 4 | 打包配置自洽：`openDataContext` 指向的目录真实存在 | 守卫测试 |
| 5 | 打包产物不含云函数源码 | 守卫测试（当前无 `cloudfunctions/`，加测试守护） |

## 平台机制（已核实）

- `game.json` 写 `"openDataContext": "open-data"` —— 值是**子目录名**，不是路径。
- 开放数据域是**独立的 JS 沙盒**：只有它能调 `wx.getFriendCloudStorage` / `wx.getUserCloudStorage`；
  `wx.setUserCloudStorage` 主域和开放数据域都能调。
- 开放数据域里用 `wx.getSharedCanvas()` 拿到离屏画布，自行绘制。
- 主域用 `wx.getOpenDataContext().canvas` 拿到同一块离屏画布，
  用 `ctx.drawImage(sharedCanvas, x, y, w, h)` 贴到上屏画布（官方原文：
  "sharedCanvas can be drawn on the on-screen canvas using the drawImage() method"）。
- 离屏画布**只能画到上屏画布上**；上屏画布不能 `toDataURL`、其 context 不能 `getImageData`。
- 开放数据域**不能加载远程 http/https 图片**，只能用本地相对路径资源。

## Task 1：开放数据域骨架

### Step 1：写失败测试（RED）

新建 `who-is-circle-tests/unit/opendata.test.js`，断言：

1. `game.json` 存在 `openDataContext` 字段
2. 该字段指向的目录真实存在
3. `open-data/index.js` 存在
4. `open-data/index.js` 里**不出现** `wx.getFriendCloudStorage`（P1 不碰好友数据）
5. `open-data/index.js` 里**不引用**主域任何符号（`require`、`getApp` 之类）
6. 项目里不存在 `cloudfunctions/` 目录（P6 的"打包产物不含云函数源码"提前守护）

### Step 2：跑测试 → 确认失败（RED）

### Step 3：`game.json` 加 `openDataContext`

### Step 4：新建 `open-data/index.js`

在离屏画布上画一块占位：一个醒目的色块 + "好友榜 P1 占位"文字。

### Step 5：主域 `game.js` 接上

- `env` 增加 `getSharedCanvas()`：仅 `hasWx` 时返回 `wx.getOpenDataContext().canvas`，
  失败（老基础库 / 非微信环境）返回 `null`，**绝不抛错**。
- `render()` 末尾：若有 sharedCanvas 且当前页是首页，把它贴到首页的占位矩形。

### Step 6：跑测试 → 全绿（GREEN）

### Step 7：开发者工具预览目检 + e2e 不回归

## Task 2：守卫测试与文档

### Step 1：把"占位矩形"等常量收敛到 `CFG`

### Step 2：README 补开放数据域说明

### Step 3：提交

## 风险与预案

| 风险 | 预案 |
|---|---|
| 预览器（`localhost:55724`）不运行开放数据域 → 占位图看不到 | 改用开发者工具**模拟器**截图；P1 仍以"模拟器可见"为准 |
| 主域直接 `drawImage(sharedCanvas)` 在真机不生效 | 退路：`wx.createImage()` + `img.src = sharedCanvas` |
| 开放数据域加载失败拖垮预览 → e2e 挂 | 开放数据域代码全程 try/catch；主域对缺 sharedCanvas 静默降级 |
| 占位图污染首页像素 → e2e 断言挂 | e2e 是**语义断言**（找橙色按钮等），不是像素基线对比；且浏览器端不贴图 |
