# 回归测试

《谁最圆》的长期回归套件。分两层：**单元测试**（无依赖，每次改动都跑）与
**端到端像素验收**（需要微信开发者工具预览服务）。

> ⚠️ 为什么放在小游戏项目外面？
> 微信小游戏的包 = 项目目录下的全部文件，预览壳会把目录里每个 `.js` / `.mjs`
> 都当作小游戏源码加载。把测试脚本放进 `who-is-circle/` 会直接让游戏加载失败：
> `[Game load] SyntaxError: Cannot use 'import.meta' outside a module`
> （`drive.mjs` 用了 ESM），黑屏且控制台报错。
> 所以套件与项目**同级**存放，本目录不参与小游戏打包。

## 目录

```
who-is-circle-tests/
├── package.json           # npm scripts 入口
├── unit/scorer.test.js    # 单元测试：评分引擎 / 防作弊 / 段位文案（Node，无依赖）
├── unit/shared.test.js    # 共享评分引擎守卫 + 编码往返精度（Node，无依赖）
├── unit/opendata.test.js  # 开放数据域守卫（Node，无依赖）
├── unit/cloudfn.test.js   # 云函数契约守卫（sha256 一致性等，Node，无依赖）
├── unit/cloudcore.test.js # 云函数行为（内存 db 跑全流程，Node，无依赖）
├── tools/sync-scoring.mjs # 把 shared/scoring.js 同步进云函数
├── tools/verify-cloud.mjs # 端到端云端对拍（要 tcb CLI + 已部署的云函数）
├── e2e/drive.mjs          # 端到端驱动（agent-browser + CDP 鼠标轨迹）
├── e2e/analyze.py         # 像素级断言（Pillow）
└── shots/                 # 截图输出（每次跑覆盖）
```

## 1. 单元测试（评分引擎 / 防作弊 / 段位文案 / 不完整笔迹口径）

```bash
cd who-is-circle-tests
node unit/scorer.test.js
# 或
npm test
```

- 直接 `require('../../who-is-circle/game.js')`：文件末尾导出了全部纯函数，
  Node 下无需画布、无需任何平台 API。
- 退出码非 0 = 有用例失败，可直接接 CI。
- 覆盖：圆度锚点表与扣分明细恒等式、采样密度无关性、闭合/方向因子、
  无效判定（直线 / 太小 / 太短 / 一小段弧 / 乱涂）、13 档段位与升级提示、
  防作弊命中与不误伤真人、重放检测、存档往返一致性与改分检测。
- `npm test` 会依次跑 5 个文件（scorer / shared / opendata / cloudcore / cloudfn），
  任何一段失败即中断并返回非 0。

## 2. 端到端像素验收

真机行为靠截图断言（颜色即状态），不改代码只验界面。

前置条件：

1. 微信开发者工具打开 `who-is-circle/` 并启动预览（默认地址 `http://localhost:55724`）。
2. 安装 `agent-browser` CLI（用于合成鼠标轨迹）与 `pillow`（`pip3 install pillow`）。

```bash
cd who-is-circle-tests
node e2e/drive.mjs && python3 e2e/analyze.py
# 或
npm run test:e2e
```

- `drive.mjs` 用 CDP 鼠标轨迹画一个带手抖的圆，抓 5 张截图到 `shots/`：
  `live`（画到一半）/ `result`（完整圆结算）/ `gap`（残缺圆结算）/ `redraw`（落笔重画）/ `home`（返回首页）。
- `analyze.py` 统计截图里的关键颜色并断言（**任一断言失败即以退出码 1 结束**，可直接接 CI）：
  笔迹为单色墨线（无彩色分段）、结算按钮存在、新纪录徽章存在、
  **结算卡片已无诊断红字**、重画后结算已清除、首页按钮存在。
- 环境变量：`E2E_URL`（预览地址）、`E2E_SHOTS`（截图目录）、`AB`（agent-browser 命令名）。

> 分类器注意：主按钮橙 `#D95F28=(217,95,40)` 与诊断红 `#C0392B=(192,57,43)` 的 g 值区间重叠，
> 判定橙必须加 `g>=70` 下限，否则诊断红字会被误判成橙色（曾据此误报「红字缺失」）。

## 3. 云函数（契约 / 行为 / 端到端对拍）

```bash
cd who-is-circle-tests
npm run sync:cloud          # shared/scoring.js → cloudfunctions/score/scoring.js
npm run test:cloudfn        # 契约：sha256 一致、不内联算法、打包边界
node unit/cloudcore.test.js # 行为：内存 db 跑全流程（不连真云端）
npm run verify:cloud        # 端到端对拍：真调云函数（要 tcb CLI + 已部署）
```

- `cloudfn.test.js` 钉住"两份算法不许漂移"：云函数里的 `scoring.js` 与
  `shared/scoring.js` 必须 **sha256 相同**。改了 `shared/scoring.js` 忘了同步，这里立刻红。
- `cloudcore.test.js` 用内存 db 跑完整流程：云端分 = 客户端分、云端**重算**而非采信上报分、
  重放检测、速率限制、最高分只升不降、客户端 `guard` 不参与判定、干跑不落库。
- `verify:cloud` 把 4 档笔迹送到**真实云函数**（走干跑通道，不落库），
  与客户端分对拍，验收线 `|Δ| ≤ 0.1`。云函数没部署会直接报错，不会静默跳过。

## 排查小抄

| 现象 | 原因 |
|---|---|
| 预览页全黑 + 控制台 `Cannot use 'import.meta' outside a module` | 项目目录里混进了 `.js`/`.mjs` 测试脚本，被当作小游戏源码加载 |
| 诊断红字断言失败但画面明明有红字 | 像素分类器把红字判成了橙色（见上方说明） |
| 端到端跑不通 | 预览服务未启动 / `agent-browser` 不在 PATH / 未装 Pillow |
