# 谁最圆（WeChat Game Circle）

微信小游戏《谁最圆》—— 画一个圆，越圆分越高。

同一份 `game.js` 双端运行：微信小游戏（`wx.*`）与浏览器（DOM / Pointer Events），
逻辑坐标统一按 750×1624 设计稿，缩放与安全区适配由渲染层处理。

## 仓库结构

```
.
├── .gitignore
├── README.md                        ← 本文件（仓库总览）
├── who-is-circle/                   ← 小游戏本体（微信开发者工具导入这个目录）
│   ├── assets/                      // 资源：主页底图、标题 LOGO
│   ├── game.js                      // 游戏主入口（单文件：逻辑 + 渲染 + 评分引擎）
│   ├── game.json                    // 游戏运行时配置
│   ├── index.html                   // 浏览器端调试入口（不参与小游戏包）
│   ├── project.config.json          // 项目配置（appid / 打包设置）
│   └── README.md                    // 小游戏本体文档（评分引擎、段位、视觉规范）
└── who-is-circle-tests/             // 回归套件（独立目录，不在小游戏包内）
    ├── unit/scorer.test.js          // 单元测试：评分引擎 / 防作弊 / 段位文案
    ├── e2e/drive.mjs                // 端到端驱动（合成鼠标轨迹 + 截图）
    ├── e2e/analyze.py               // 像素级断言（颜色即状态）
    └── README.md                    // 测试套件文档
```

> **为什么测试套件放在项目外**：微信小游戏的包 = 项目目录下的全部文件，
> 预览壳会把每个 `.js` / `.mjs` 都当作小游戏源码加载，测试脚本混进来会直接让游戏黑屏
> （`[Game load] SyntaxError: Cannot use 'import.meta' outside a module`）。

## 快速开始

**微信开发者工具**：导入 `who-is-circle/`（`compileType: game`），点击编译。

**浏览器预览**：`cd who-is-circle && python3 -m http.server`，打开 `index.html`。

**回归测试**：

```bash
cd who-is-circle-tests
npm test          # 单元测试（纯 Node，无依赖；退出码非 0 即失败，可直接接 CI）
npm run test:e2e  # 端到端像素验收（需开发者工具预览服务 + agent-browser + Pillow）
```

## 安全说明

`.weixin-minigame-helper.json` 内含**小游戏代码上传用的 RSA 私钥**，
已通过 `.gitignore` 排除，**严禁提交到仓库**。如需在多台机器上使用，
请各自在本地生成该文件，不要通过版本控制分发。

`project.private.config.json`（开发者工具个人配置）同样不入库。

## 版本

- **v0.5** — 结算卡片精简为「分数 + 段位 + 评语」三行
- **v0.4** — 去掉实时反馈（边画边给分 + 笔迹三色着色），笔迹全程单色墨线
- **v0.3** — 移除全部音频（BGM / 音效 / 静音开关），反馈只走视觉 + 新纪录轻震动
