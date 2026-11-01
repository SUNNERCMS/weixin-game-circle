# 好友排行榜 P0：抽出共享评分引擎 实施计划

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** 把《谁最圆》的评分引擎从 `game.js` 抽到 `shared/scoring.js`，使主域与未来的云函数跑**同一份代码**，且本次改动**零行为变化**。

**Architecture:** `shared/scoring.js` 用 UMD 包装，同时支持 CommonJS（Node 单测 / 小游戏 `require`）与浏览器全局（`index.html` 的 `<script>`）。`game.js` 删除本地副本，改为引用共享模块并**保持 `module.exports` 对外签名完全不变**——现有 32 项单测一行都不用改。

**Tech Stack:** 微信小游戏（原生 ES5 JS，无框架）、Node 单测、Python 像素断言 e2e、微信开发者工具预览

**Spec:** `docs/superpowers/specs/2026-11-01-friend-leaderboard-design.md`

**为何只做 P0:** P2（云函数）依赖云环境 ID（需用户在腾讯云控制台创建），P1 依赖 P0。P0 是整条链路上唯一**当前即可执行且零外部依赖**的阶段，且它是后续所有阶段的地基——若"抽共享模块"这条路会破坏现有回归套件，整个方案要重新评估。P1–P6 各自单独出计划。

---

## Global Constraints

- **零行为变化**：P0 结束后，主域的分数、段位、防作弊判定、结算画面必须与改动前**逐位一致**。e2e 的 8 条像素断言是最后一道闸。
- **`module.exports` 对外签名不变**：`who-is-circle-tests/unit/scorer.test.js` 通过 `require('../../who-is-circle/game.js')` 使用 `G.evaluate` / `G.guardCheck` / `G.judge` / `G.shapeSig` / `G.isReplay` / `G.encodePts` / `G.decodePts` / `G.fnv` / `G.getRank` / `G.diagnose` / `G.upgradeTip` / `G.roundScore` / `G.closeFactor` / `G.kasaFit` / `G.refineFit` / `G.winding` / `G.resample` / `G.RANKS` / `G.SCORE_CFG` / `G.GUARD_CFG` / `G.CFG`。**该文件不允许修改。**
- **`shared/scoring.js` 必须是纯函数模块**：不得出现 `wx.` / `env.` / `document.` / `window.` / `location.` / `navigator.` / `GameGlobal.` / 存储读写，不得有非确定性来源（`Math.random()` 也应避免）。共享模块**内部**不得 `require` 别的文件（自包含）。
- **`judge` 的开发豁免必须保留**：当前 `judge` 首行是 `if (DEV) return 'ok';`，DEV 为真时（浏览器 localhost 预览 / 小游戏 develop 版）跳过全部风险判定。抽取后不得把该判断硬编码进共享模块。
- **代码风格**：纯 ES5（`var` / `function`），无箭头函数、无 `const/let`、无模板字符串——与现有 `game.js` 一致。
- **不得修改**：`game.json`、`project.config.json`、`.eslintrc.js`、任何 `assets/` 资源、现有 `unit/scorer.test.js`。
- **提交粒度**：每个 Task 结束提交一次，commit message 用中文描述意图。

---

## Review Focus

以下五类状况是规格暗示但没有测试覆盖、最可能真正咬人的地方。每个 Task 会补上对应测试。

1. **`judge` 的开发豁免（DEV）** —— 现在首行 `if (DEV) return 'ok'`。抽进共享模块若把 DEV 判断丢掉，**正式版会开始误伤真人**（真人高分被判 shadow、不能计入最佳）；若把 DEV 硬编码进共享模块，**开发预览的测试能力就没了**。两种错误都不会让现有 32 项单测变红（Node 下 `DEV` 本就是 `false`）。→ 必须变成显式的第 4 参数，缺省值为"不豁免"。
2. **浏览器预览端（`index.html`）没有任何自动化测试覆盖** —— e2e 跑的是**微信开发者工具预览服务**（`http://localhost:55724`）驱动的小游戏 iframe，**不是** `index.html`。`index.html` 少一行 `<script>` 就是静默白屏，没有任何测试会红。→ 需要静态断言加载顺序的测试。
3. **`shapeSig` 返回的是 64 个浮点数的数组，不是字符串** —— 设计文档 §6.1 把它写成了 `sig: 'a1b2c3...'`。云端跨玩家查重是对**数组**做平均绝对偏差比较（`isReplay` 的算法），不是字符串哈希。用错类型会让云端重放检测完全失效。→ 共享模块导出时必须保持返回数组。
4. **`clock_drift` 信号在云端会静默失效** —— `guardCheck(raw, fit, score, sig)` 的入参 `raw` 是 `[{t, h, x, y}]`（`h` = 回调执行时刻），而计划上传的 `pts` 是 `[{x, y, t}]`（`encodePts` 只编码 x/y/t）。云端若拿 `pts` 直接调 `guardCheck`，`h` 缺失 → `evDur === hDur` 恒成立 → **`clock_drift` 永不命中**，少一道防线且无人察觉。→ P0 就要把"pts → raw"这条构造路径固定下来。
5. **`evaluate` 与 `guardCheck` 的入参不是同一个东西** —— `evaluate(points)` 收 `[{x,y,t}]`，`guardCheck(raw,...)` 收 `[{t,h,x,y}]`，`shapeSig(points, fit)` 又收 `[{x,y,t}]`。混用会静默算出错误结果而不是报错。→ 三个函数的入参约定必须写进测试。

---

## File Structure

| 文件 | 职责 | 状态 |
|---|---|---|
| `who-is-circle/shared/scoring.js` | 评分引擎 + 防作弊的**唯一实现**，UMD 包装，24 个导出符号 | 新建 |
| `who-is-circle/game.js` | 渲染、输入、状态、存储；改为引用共享模块 | 修改 |
| `who-is-circle/index.html` | 浏览器预览入口；补 `shared/scoring.js` 加载顺序 | 修改 |
| `who-is-circle-tests/unit/shared.test.js` | 共享模块的行为、纯度、防漂移守卫 | 新建 |
| `who-is-circle-tests/unit/scorer.test.js` | 现有 32 项单测 | **不改** |
| `who-is-circle-tests/package.json` | `test` 脚本串上新增测试 | 修改 |

---

### Task 1: 抽出 `shared/scoring.js`

**Files:**
- Create: `who-is-circle/shared/scoring.js`
- Create: `who-is-circle-tests/unit/shared.test.js`

**Interfaces:**
- Consumes: 无（首个任务）
- Produces: `who-is-circle/shared/scoring.js` 导出 **24 个符号**（CommonJS `module.exports` 与浏览器全局 `Scoring` 同时可得）：

  | 类别 | 符号 |
  |---|---|
  | 配置 | `SCORE_CFG`、`GUARD_CFG`、`RANKS`、`INVALID_TIPS` |
  | 几何与评分 | `resample(pts, step)`、`kasaFit(p)`、`refineFit(p, cx, cy, iters)`、`winding(p, cx, cy)`、`roundScore(e)`、`closeFactor(deg)`、`largestGap(pts, cx, cy)`、`evaluate(points)`、`getRank(score)`、`diagnose(r)`、`upgradeTip(score, next)` |
  | 防作弊与编码 | `stat(a)`、`guardCheck(raw, fit, score, sig)`、`shapeSig(points, fit)`、`isReplay(sig, history)`、`fnv(str)`、`encodePts(pts)`、`decodePts(arr)`、`judge(r, g, replay, dev)`、`BEST_SALT` |

  **`judge` 签名变更（本计划唯一一处行为面变更）**：由 `judge(r, g, replay)` 改为 `judge(r, g, replay, dev)`。第 4 参数为"是否豁免风险判定"，**缺省（`undefined`）= 不豁免**。映射：`dev` 真值 → 返回 `'ok'`；否则走原有判定链。调用方 `game.js` 传 `DEV`；云函数将来不传。

- [ ] **Step 1: 写失败测试 `who-is-circle-tests/unit/shared.test.js`**

  文件头注释：

  ```
  /**
   * 共享评分引擎单元测试（shared/scoring.js）
   * 作用：锁住"主域与云函数跑同一份代码"这件事 —— 一旦有人在共享模块里偷改算法，
   *       或在 game.js 里又留了一份副本，这里立刻红。
   * 运行：node unit/shared.test.js
   */
  ```

  开头三行：

  ```js
  const fs = require('fs');
  const path = require('path');
  const S = require('../../who-is-circle/shared/scoring.js');
  ```

  `ok(cond, name, extra)` 辅助函数**逐字复制** `scorer.test.js` 的实现（`pass`/`fail` 计数 + ✅/❌ 输出）。`circle(cx, cy, r, opts)` 造笔画工具也**逐字复制** `scorer.test.js` 的实现（它生成 `[{x,y,t}]`）。

  断言清单（每条一个 `ok(...)`）：

  | 小节 | 断言 |
  |---|---|
  | 一、导出完整性 | 下列 24 个符号全部 `!== undefined`（少一个就红，并把缺失名单写进 `extra`）：`SCORE_CFG` `GUARD_CFG` `RANKS` `INVALID_TIPS` `resample` `kasaFit` `refineFit` `winding` `roundScore` `closeFactor` `largestGap` `evaluate` `getRank` `diagnose` `upgradeTip` `stat` `guardCheck` `shapeSig` `isReplay` `fnv` `encodePts` `decodePts` `judge` |
  | 二、纯度 | 源码文本不含以下任一子串：`wx.` `env.` `document.` `window.` `location.` `navigator.` `GameGlobal.` `getStorage` `setStorage`；且不含 `require(` |
  | 三、评分行为 | `S.evaluate(circle(375,700,250))` 的 `valid === true` 且 `score >= 97`；`loss.round + loss.close + loss.dir` 与 `100 - score` 之差 `< 0.15` |
  | 四、judge 的 dev 参数 | `S.judge({score:50,valid:true}, {hard:[],risk:0,hits:[]}, false) === 'ok'`（三参缺省 → 走真实判定）；`S.judge(rr, {hard:[],risk:0,hits:[]}, false, true) === 'ok'`；`S.judge(rr, {hard:[],risk:99,hits:['a','b']}, false, true) === 'ok'`（dev=true 时高风险也被豁免）；`S.judge(rr, {hard:[],risk:99,hits:['a','b']}, false) !== 'ok'`（缺省时不豁免） |
  | 五、shapeSig 的类型 | `Array.isArray(sig) === true` 且 `sig.length === 64`；每个元素 `typeof v === 'number'`；`S.isReplay(sig, [sig.map(v => v + 0.05)]) === false` |
  | 六、pts 与 raw 的入参约定 | `S.decodePts(S.encodePts(pts)).length === pts.length` 且首元素含数值型 `x`/`t`；`S.guardCheck(pts.map(p => ({t:p.t,h:p.t,x:p.x,y:p.y})), fit, score, {})` 返回对象的 `risk` 是 number、`hits` 是数组 |

  文件末尾：

  ```js
  console.log(`\n结果：${pass} 通过 / ${fail} 失败\n`);
  process.exit(fail ? 1 : 0);
  ```

- [ ] **Step 2: 运行测试确认失败**

  Run: `cd who-is-circle-tests && node unit/shared.test.js`
  Expected: FAIL —— `Cannot find module '../../who-is-circle/shared/scoring.js'`，退出码非 0。

- [ ] **Step 3: 创建 `who-is-circle/shared/scoring.js`**

  **函数体从 `game.js` 逐字搬运**（数值、注释、判据一字不改），只做三处结构性改动：

  1. UMD 包装
  2. `judge` 首行 `if (DEV) return 'ok';` → `if (dev) return 'ok';`
  3. 末尾 `module.exports`

  文件骨架（`...` 处填入从 `game.js` 逐字搬来的函数体）：

  ```js
  /**
   * 《谁最圆》评分引擎 —— 主域与云函数共用的唯一实现
   *
   * 纯函数模块：不引用 wx./env./document./window./location./navigator，不读写存储。
   * 这条约束是硬性的 —— 云函数与小游戏主域没有共同的平台 API，
   * 一旦混入平台调用，共享就会失效（见 docs/superpowers/specs/2026-11-01-friend-leaderboard-design.md）。
   *
   * 导出（CommonJS + 浏览器全局 Scoring）：
   *   配置   SCORE_CFG GUARD_CFG RANKS INVALID_TIPS
   *   评分   resample kasaFit refineFit winding roundScore closeFactor largestGap
   *          evaluate getRank diagnose upgradeTip
   *   防作弊 stat guardCheck shapeSig isReplay fnv encodePts decodePts judge
   */
  (function (root, factory) {
    var api = factory();
    if (typeof module === 'object' && module && module.exports) module.exports = api;
    if (root) root.Scoring = api;
  })(typeof GameGlobal !== 'undefined' ? GameGlobal
     : (typeof globalThis !== 'undefined' ? globalThis
     : (typeof window !== 'undefined' ? window : null)), function () {
    'use strict';

    // ↓↓↓ 从 game.js 逐字搬入，顺序如下 ↓↓↓
    var SCORE_CFG = {...};      // game.js 61-76（14 个锚点、全部阈值）
    var GUARD_CFG = {...};      // game.js 81-96（全部阈值，含 HIGH_SCORE:95）
    var RANKS = [...];          // game.js 99-113（13 档与评语文案）
    var INVALID_TIPS = {...};   // game.js 809-814
    function resample(pts, step) {...}        // game.js 672-696
    function kasaFit(p) {...}                  // game.js 701-718
    function refineFit(p, cx, cy, iters) {...}// game.js 721-737
    function winding(p, cx, cy) {...}         // game.js 741-770
    function roundScore(e) {...}              // game.js 773-783
    function closeFactor(deg) {...}           // game.js 786-789
    function largestGap(pts, cx, cy) {...}    // game.js 792-805
    function evaluate(points) {...}           // game.js 816-865
    function getRank(score) {...}             // game.js 867-873
    function diagnose(r) {...}                // game.js 887-897
    function upgradeTip(score, next) {...}    // game.js 900-905
    function stat(a) {...}                    // game.js 936-943
    function guardCheck(raw, fit, score, sig) {...}  // game.js 946-1013
    function shapeSig(points, fit) {...}      // game.js 1016-1027
    function isReplay(sig, history) {...}     // game.js 1030-1038
    function fnv(str) {...}                   // game.js 1042-1049
    function encodePts(pts) {...}             // game.js 1052-1060
    function decodePts(arr) {...}             // game.js 1062-1070
    function judge(r, g, replay, dev) {       // game.js 1111-1118，首行改为 if (dev)
      if (dev) return 'ok';
      if (g.hard && g.hard.length) return 'reject';
      if (replay || (g.hits.length >= 2 && g.risk >= GUARD_CFG.SHADOW_RISK) ||
          (r.score >= 99 && g.risk > 0)) return 'shadow';
      if (g.risk >= GUARD_CFG.UNVERIFIED_RISK) return 'unverified';
      return 'ok';
    }
    // ↑↑↑ 搬运结束 ↑↑↑

    return {
      SCORE_CFG: SCORE_CFG, GUARD_CFG: GUARD_CFG, RANKS: RANKS, INVALID_TIPS: INVALID_TIPS,
      resample: resample, kasaFit: kasaFit, refineFit: refineFit, winding: winding,
      roundScore: roundScore, closeFactor: closeFactor, largestGap: largestGap,
      evaluate: evaluate, getRank: getRank, diagnose: diagnose, upgradeTip: upgradeTip,
      stat: stat, guardCheck: guardCheck, shapeSig: shapeSig, isReplay: isReplay,
      fnv: fnv, encodePts: encodePts, decodePts: decodePts, judge: judge,
      BEST_SALT: BEST_SALT
    };
  });
  ```

- [ ] **Step 4: 运行测试确认通过**

  Run: `cd who-is-circle-tests && node unit/shared.test.js`
  Expected: PASS —— 输出「结果：N 通过 / 0 失败」，退出码 0。

- [ ] **Step 5: 确认现有单测未被波及（基线）**

  Run: `cd who-is-circle-tests && node unit/scorer.test.js`
  Expected: PASS —— 32 项全绿（`game.js` 此刻尚未改动，理应完全不受影响）。

- [ ] **Step 6: 提交**

  ```bash
  cd /Users/sunnercms/WeChatProjects
  git add who-is-circle/shared/scoring.js who-is-circle-tests/unit/shared.test.js
  git commit -m "抽出共享评分引擎 shared/scoring.js（纯搬迁，judge 增加 dev 参数）"
  ```

---

### Task 2: `game.js` 切换到共享模块

**Files:**
- Modify: `who-is-circle/game.js`
- Modify: `who-is-circle/index.html`
- Modify: `who-is-circle-tests/unit/shared.test.js`（追加断言）
- Modify: `who-is-circle-tests/package.json`

**Interfaces:**
- Consumes: Task 1 的 `shared/scoring.js`（24 个符号）
- Produces: `game.js` 的 `module.exports` 签名**不变**（原 20 个评分符号 + `CFG`），额外导出 `largestGap` 与 `INVALID_TIPS`

- [ ] **Step 1: 追加"同一引用"防漂移断言**

  在 `unit/shared.test.js` 追加小节：

  ```js
  console.log('\n========== 三·b、防漂移：game.js 必须用同一份代码 ==========');
  const G = require('../../who-is-circle/game.js');
  ok(G.evaluate === S.evaluate, 'game.js 的 evaluate 就是 shared 的 evaluate（同一函数引用）');
  ok(G.guardCheck === S.guardCheck, 'game.js 的 guardCheck === shared 的 guardCheck');
  ok(G.judge === S.judge, 'game.js 的 judge === shared 的 judge');
  ok(G.RANKS === S.RANKS, 'game.js 的 RANKS === shared 的 RANKS');
  ok(G.SCORE_CFG === S.SCORE_CFG, 'game.js 的 SCORE_CFG === shared 的 SCORE_CFG');
  ```

  `require` 缓存保证两次 require 拿到同一个模块实例，故 `===` 成立。

- [ ] **Step 2: 运行测试确认失败**

  Run: `cd who-is-circle-tests && node unit/shared.test.js`
  Expected: FAIL —— 「game.js 的 evaluate 就是 shared 的 evaluate」❌（game.js 仍持有自己的副本）。

- [ ] **Step 3: `game.js` 删除本地副本，改为引用共享模块**

  **3a.** 在 `game.js` 的 IIFE 开头（`var CFG = {` 之前）插入：

  ```js
    // 评分引擎的唯一实现在 shared/scoring.js（主域与云函数共用，保证两端算出的分一致）
    // 三种运行形态：Node 单测 / 小游戏 → CommonJS；浏览器预览 → UMD 全局
    var Scoring = (typeof module === 'object' && module && module.exports && typeof require === 'function')
      ? require('./shared/scoring.js')
      : ((typeof GameGlobal !== 'undefined' && GameGlobal.Scoring) ||
         (typeof window !== 'undefined' && window.Scoring) || null);
    if (!Scoring) throw new Error('shared/scoring.js 未加载：浏览器端需在 game.js 之前引入 <script src="shared/scoring.js">');

    var SCORE_CFG = Scoring.SCORE_CFG;
    var GUARD_CFG = Scoring.GUARD_CFG;
    var RANKS = Scoring.RANKS;
    var INVALID_TIPS = Scoring.INVALID_TIPS;
    var resample = Scoring.resample;
    var kasaFit = Scoring.kasaFit;
    var refineFit = Scoring.refineFit;
    var winding = Scoring.winding;
    var roundScore = Scoring.roundScore;
    var closeFactor = Scoring.closeFactor;
    var largestGap = Scoring.largestGap;
    var evaluate = Scoring.evaluate;
    var getRank = Scoring.getRank;
    var diagnose = Scoring.diagnose;
    var upgradeTip = Scoring.upgradeTip;
    var guardCheck = Scoring.guardCheck;
    var shapeSig = Scoring.shapeSig;
    var isReplay = Scoring.isReplay;
    var fnv = Scoring.fnv;
    var encodePts = Scoring.encodePts;
    var decodePts = Scoring.decodePts;
    var judge = Scoring.judge;
    var BEST_SALT = Scoring.BEST_SALT;
  ```

  **3b.** 删除 `game.js` 中已被搬走的定义（逐段删除，含其上方注释块）：

  | 改动前行号 | 内容 |
  |---|---|
  | 57 | `/* ===== 评分配置（v0.2）===== */` + `var SCORE_CFG` |
  | 78 | `/* ===== 防作弊阈值（v0.2）===== */` + `var GUARD_CFG` |
  | 98 | `// 段位表（v0.2：13 档 ...）` + `var RANKS` |
  | 663 | `/* ==== 六、评分引擎 ==== */` 注释块，及 `resample` `kasaFit` `refineFit` `winding` `roundScore` `closeFactor` `largestGap` `INVALID_TIPS` `evaluate` `getRank` `diagnose` `upgradeTip` 各定义 |
  | 935 | `function stat` |
  | 945 | `function guardCheck` |
  | 1015 | `function shapeSig` |
  | 1029 | `function isReplay` |
  | 1040 | `function fnv` |
  | 1050 | `var BEST_SALT = 'yz#750#v3';` |
| 1052 | `function encodePts` |
  | 1062 | `function decodePts` |
  | 1108 | `// 处置策略 ...` 注释 + `function judge(r, g, replay)` |

  **保留在 `game.js` 不动**（删错会出事）：
  - `var CFG = {...}`（布局常量，含 `RANK_HIGH_LINE`）、`var COL = {...}`
  - `function pickComment(rank)` 与 `var lastCommentIdx = {}` —— **有状态 + `Math.random()`，违反纯函数约束**
  - `var DEV = (function () {...})(...)` —— 平台相关
  - `var SIG`、`function pushRaw(...)` —— 平台相关（用 `env.now()`）
  - `saveBestRecord` / `loadBestRecord` / `loadHistory` / `pushHistory` —— 存储相关
  - 第 1183 行对 `INVALID_TIPS[r.reason]` 的**引用**（由 3a 的别名提供）

  **3c.** 改 `judge` 调用点（改动前第 1190 行）：

  ```js
      var verdict = judge(r, g, replay, DEV);
  ```

  **3d.** `game.js` 尾部 `module.exports` 补两个符号，其余保持不变：

  ```js
      guardCheck: guardCheck, shapeSig: shapeSig, isReplay: isReplay, judge: judge,
      encodePts: encodePts, decodePts: decodePts, fnv: fnv,
      largestGap: largestGap, INVALID_TIPS: INVALID_TIPS,
      RANKS: RANKS, SCORE_CFG: SCORE_CFG, GUARD_CFG: GUARD_CFG, CFG: CFG
  ```

- [ ] **Step 4: `index.html` 补加载顺序**

  `<body>` 内把 `<script src="game.js"></script>` 改为两行：

  ```html
  <script src="shared/scoring.js"></script>
  <script src="game.js"></script>
  ```

  顺序不可颠倒：`game.js` 顶层立即 require/读全局，晚了就抛「shared/scoring.js 未加载」。

- [ ] **Step 5: 合并测试脚本**

  `who-is-circle-tests/package.json` 的 `scripts` 改为：

  ```json
  "scripts": {
    "test": "node unit/scorer.test.js && node unit/shared.test.js",
    "test:unit": "node unit/scorer.test.js",
    "test:shared": "node unit/shared.test.js",
    "test:e2e": "node e2e/drive.mjs && python3 e2e/analyze.py",
    "lint": "node --check ../who-is-circle/game.js && node --check ../who-is-circle/shared/scoring.js"
  }
  ```

- [ ] **Step 6: 运行测试确认通过**

  Run: `cd who-is-circle-tests && npm test`
  Expected: PASS —— `scorer.test.js` 32 项全绿 + `shared.test.js` 全绿，退出码 0。

  Run: `cd who-is-circle-tests && npm run lint`
  Expected: 无输出，退出码 0。

- [ ] **Step 7: 提交**

  ```bash
  cd /Users/sunnercms/WeChatProjects
  git add who-is-circle/game.js who-is-circle/index.html who-is-circle-tests/unit/shared.test.js who-is-circle-tests/package.json
  git commit -m "game.js 改用 shared/scoring.js，删除本地评分引擎副本（行为不变）"
  ```

---

### Task 3: 补齐静态守卫与已知限制的显式化

**Files:**
- Modify: `who-is-circle-tests/unit/shared.test.js`（追加小节）
- Modify: `docs/superpowers/specs/2026-11-01-friend-leaderboard-design.md`（修正两处契约错误）

**Interfaces:**
- Consumes: Task 2 的 `game.js` / `index.html` 现状
- Produces: 对"加载顺序"和"pts→raw 缺口"的自动化断言；修正后的设计文档契约

- [ ] **Step 1: 写静态断言测试**

  在 `unit/shared.test.js` 追加（需要新增 `const gameSrc = fs.readFileSync(...)` 与 `const htmlSrc = fs.readFileSync(...)` 两个读取）：

  ```js
  console.log('\n========== 七、加载顺序守卫 ==========');
  const root = path.join(__dirname, '../../who-is-circle');
  const htmlSrc = fs.readFileSync(path.join(root, 'index.html'), 'utf8');
  const gameSrc = fs.readFileSync(path.join(root, 'game.js'), 'utf8');

  const iShared = htmlSrc.indexOf('shared/scoring.js');
  const iGame = htmlSrc.indexOf('src="game.js"');
  ok(iShared !== -1, 'index.html 引入了 shared/scoring.js');
  ok(iGame !== -1, 'index.html 引入了 game.js');
  ok(iShared !== -1 && iGame !== -1 && iShared < iGame,
     'index.html 中 shared/scoring.js 排在 game.js 之前', `shared@${iShared} game@${iGame}`);

  ok(gameSrc.includes("require('./shared/scoring.js')"), 'game.js 通过 CommonJS 引用共享模块');
  const iReq = gameSrc.indexOf("require('./shared/scoring.js')");
  const iCfg = gameSrc.indexOf('var CFG = {');
  ok(iReq !== -1 && iCfg !== -1 && iReq < iCfg, '引用块在 var CFG 之前（早于任何使用点）');
  ok(gameSrc.includes('judge(r, g, replay, DEV)'), 'judge 调用点传入了 DEV');
  ok(!/function judge\(r, g, replay\)/.test(gameSrc), 'game.js 内不再有旧签名的 judge 定义');
  ```

  最后两条的用意：挡住"有人为了图省事，把 DEV 判断直接写回 game.js 的 judge 里"。

- [ ] **Step 2: 运行测试**

  Run: `cd who-is-circle-tests && npm test`
  Expected: PASS —— 全部绿（Task 2 已改好，静态断言应当直接通过；若某条红，说明 Task 2 漏改）。

- [ ] **Step 3: 修正设计文档的两处契约错误**

  改 `docs/superpowers/specs/2026-11-01-friend-leaderboard-design.md`：

  **(a) §6.1 入参的 `sig` 类型** —— 原文写 `sig: 'a1b2c3...'`，实际 `shapeSig` 返回 **`number[64]`**（64 个归一化径向残差，各保留 4 位小数）。改为：

  ```js
  sig: [0.0123, -0.0456, ...],   // shapeSig 输出：64 个数字的数组（非字符串）
  ```

  并在该节补一句：云端跨玩家查重沿用 `isReplay` 的**平均绝对偏差**算法（`Σ|sig[i] - other[i]| / 64 < REPLAY_TOL`），不是字符串哈希；`fnv` 只用于最高分存档自校验。

  **(b) §7.2 表格加一行"已知限制"** —— 在云端校验表后补：

  | 限制 | 说明 |
  |---|---|
  | `clock_drift` 在云端不生效 | `guardCheck` 需要 `raw[].h`（回调执行时刻），而上传协议只有 `pts`（x/y/t）。云端若直接以 `h := t` 构造 raw，该信号恒不命中。P2 必须二选一：上传 `h`（需新增 `encodeRaw`/`decodeRaw`），或接受云端少这一道防线并在文档中明说 |

- [ ] **Step 4: 提交**

  ```bash
  cd /Users/sunnercms/WeChatProjects
  git add who-is-circle-tests/unit/shared.test.js docs/superpowers/specs/2026-11-01-friend-leaderboard-design.md
  git commit -m "补加载顺序静态守卫；修正设计文档中 sig 类型与 clock_drift 限制"
  ```

---

### Task 4: 端到端与运行时验证

**Files:**
- Modify: `who-is-circle/README.md`（补一条"共享评分引擎"说明）

**Interfaces:**
- Consumes: Task 1–3 的全部改动
- Produces: 运行时验证证据 + README 说明

- [ ] **Step 1: 小游戏运行时验证（关键：验证 `require` 路径）**

  用 `weixin-minigame-helper` skill 启动预览（`run_game`），在开发者工具里确认：
  - 游戏能正常进入首页，不抛「shared/scoring.js 未加载」
  - 完整画一个圆 → 结算页出现分数与段位（说明 `evaluate` / `getRank` 经共享模块正常工作）
  - 开发者工具 Console **无报错**

  若 `require('./shared/scoring.js')` 在小游戏里不工作（`module` 未定义），退路是改用 `GameGlobal.Scoring` 全局路径 —— 但这会让浏览器端与 Node 端走两套加载逻辑，**必须同时改 `index.html` 与 `shared.test.js` 的静态断言**，并在提交信息里写明。

- [ ] **Step 2: e2e 像素断言**

  Run: `cd who-is-circle-tests && npm run test:e2e`
  Expected: PASS —— 8 条像素断言全绿（`drive.mjs` 驱动开发者工具预览服务 → `analyze.py` 比对 `shots/` 基准图）。

  这是**零行为变化的最终证据**：分数、段位、笔迹渲染、结算卡片排版全部与改动前逐像素一致。

  若像素断言失败：说明抽取引入了行为差异，**不要调基线图**——回查哪一段函数没逐字搬动。

- [ ] **Step 3: 浏览器预览端验证（无自动化覆盖，只能手测）**

  在浏览器打开 `who-is-circle/index.html`，确认：
  - 首页正常渲染（logo、背景、"开始"按钮）
  - Console 无 "shared/scoring.js 未加载" 错误
  - 画一个圆能出分数

- [ ] **Step 4: README 补说明**

  在 `who-is-circle/README.md` 追加一节，说明 `shared/scoring.js` 的存在与约束：

  ```markdown
  ## shared/scoring.js（共享评分引擎）

  评分引擎与防作弊判定的**唯一实现**，主域（`game.js`）与云函数共用，
  以保证两端算出的分数逐位一致。

  - 纯函数模块：不得引用 `wx.` / `env.` / `document.` / `window.` / 存储 API
  - 导出 24 个符号，CommonJS 与浏览器全局 `Scoring` 同时可得
  - `judge(r, g, replay, dev)` 的第 4 参数控制"是否豁免风险判定"；
    开发预览传 `DEV`，服务端不传（即不豁免）
  - 改动后必须跑 `who-is-circle-tests` 的 `npm test` 与 `npm run test:e2e`
  ```

- [ ] **Step 5: 提交**

  ```bash
  cd /Users/sunnercms/WeChatProjects
  git add who-is-circle/README.md
  git commit -m "README 补充共享评分引擎说明；P0 端到端验证通过"
  ```

---

## Self-Review

**1. 规格覆盖**

| 设计文档章节 | 本计划覆盖 |
|---|---|
| §5 文件清单（`shared/scoring.js`） | Task 1 |
| §5 `game.js` 改造点 | Task 2 Step 3 |
| §5 浏览器端兼容（UMD / `index.html`） | Task 1 Step 3、Task 2 Step 4 |
| §5 验收清单「`npm test` 全绿」 | Task 2 Step 6 |
| §5 验收清单「`npm run test:e2e` 全绿」 | Task 4 Step 2 |
| §5 验收清单「`shared/scoring.js` 与云函数副本字节一致」 | **不在 P0**（P2 才建云函数副本，届时加 CI 断言） |
| §6.1 云函数接口 | **不在 P0**（P2）；Task 3 修正了 `sig` 类型错误 |
| §7.2 云端校验与已知限制 | Task 3 Step 3(b) 显式化 `clock_drift` 缺口 |
| §10 P0 阶段定义 | 全部四个 Task |
| §11 验收清单「工程」条 | Task 2 Step 6、Task 4 Step 2 |
| §11 验收清单「兼容与降级」条 | **不在 P0**（P4/P5 才涉及 `sharedCanvas`） |

设计文档 §10 的 P0 行要求"32 项单测不回归 + e2e 全绿"，本计划 Task 2 Step 6 与 Task 4 Step 2 覆盖。

**2. 步骤扫描**

每个 Step 都可由执行者写出唯一合理实现：搬运范围精确到行号区间，签名精确到参数名与默认值，测试精确到断言条件。**无 TBD、无"补充边界情况"、无"为上述写测试"。**

**3. 类型一致性**

- `judge(r, g, replay, dev)` —— Task 1 定义、Task 2 Step 3c 调用点传 `DEV`、Task 3 Step 1 静态断言校验调用点与旧签名消失。三处一致。
- `Scoring` 全局名 —— Task 1 UMD 写入 `root.Scoring`、Task 2 Step 3a 读取 `GameGlobal.Scoring` / `window.Scoring`、Task 3 Step 1 断言 `require` 路径。三处一致。
- `shapeSig` 返回 `number[64]` —— Task 1 搬运时保持原样、Task 3 Step 3(a) 修正文档、Task 1 Step 1 测试断言类型。三处一致。

**4. Review Focus 覆盖**

| # | Review Focus 项 | 覆盖它的测试 |
|---|---|---|
| 1 | `judge` 的 DEV 豁免 | Task 1「四、judge 的 dev 参数」4 条断言 + Task 3 静态断言（调用点传 DEV、旧签名消失） |
| 2 | 浏览器端无自动化覆盖 | Task 3「七、加载顺序守卫」6 条静态断言 |
| 3 | `shapeSig` 是数组不是字符串 | Task 1「五、shapeSig 的类型」3 条断言 + Task 3 Step 3(a) 修正文档 |
| 4 | `clock_drift` 云端静默失效 | Task 3 Step 3(b) 显式写入设计文档的"已知限制"表 |
| 5 | `evaluate` / `guardCheck` / `shapeSig` 入参不同 | Task 1「六、pts 与 raw 的入参约定」2 条断言 |

**5. 比例**

本计划 4 个 Task、约 30 个 Step，正文约 330 行；对应产物是 1 个新文件（~330 行）+ `game.js` 删改 + 2 个测试文件（约 150 行）。**代码体量大于计划体量**，符合"计划是决策集合而非代码转录"的要求。
