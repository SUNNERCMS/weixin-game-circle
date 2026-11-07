/**
 * 《谁最圆》v0.5 — 游戏主逻辑（渲染 / 输入 / 状态 / 存储）
 * 评分引擎已抽到 shared/scoring.js —— 主域与云函数共用同一份，保证两端算出的分一致
 * 双环境：微信小游戏（wx.*）+ 浏览器（DOM/Pointer Events）
 * 逻辑坐标：750×1624 设计稿，缩放交给渲染层
 * v0.5：结算卡片去掉诊断行与升级提示行，只留分数 / 段位 / 评语
 * v0.4：去掉实时反馈（边画边给分 + 笔迹三色着色），笔迹全程单色墨线
 * v0.3：移除全部音频（BGM / 音效 / 静音开关），反馈只走视觉 + 新纪录轻震动
 */
(function () {
  'use strict';

  // 评分引擎的唯一实现在 shared/scoring.js（主域与云函数共用，保证两端算出的分一致）
  // 三种运行形态：Node 单测 / 小游戏 → CommonJS；浏览器预览 → UMD 全局
  var Scoring = (typeof module === 'object' && module && module.exports && typeof require === 'function')
    ? require('./shared/scoring.js')
    : ((typeof GameGlobal !== 'undefined' && GameGlobal.Scoring) ||
       (typeof window !== 'undefined' && window.Scoring) || null);
  if (!Scoring) throw new Error('shared/scoring.js 未加载：浏览器端需在 game.js 之前引入 <script src="shared/scoring.js">');

  // 云端上报模块（P3）：**可选依赖** —— 加载不到就退化成单机模式，玩法完全不受影响
  // （排行榜是增值能力，不能因为它拖垮主玩法）
  var CloudClient = (typeof module === 'object' && module && module.exports && typeof require === 'function')
    ? (function () { try { return require('./js/cloud.js'); } catch (e) { return null; } })()
    : ((typeof GameGlobal !== 'undefined' && GameGlobal.CloudClient) ||
       (typeof window !== 'undefined' && window.CloudClient) || null);

  // 榜单桥接（P4）：**可选依赖** —— 加载不到就当"没有好友榜"，玩法完全不受影响
  var LeaderboardBridge = (typeof module === 'object' && module && module.exports && typeof require === 'function')
    ? (function () { try { return require('./js/leaderboard.js'); } catch (e) { return null; } })()
    : ((typeof GameGlobal !== 'undefined' && GameGlobal.Leaderboard) ||
       (typeof window !== 'undefined' && window.Leaderboard) || null);

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

  /* ============================================================
   * 一、常量表（评分阈值 / 动效时长 / 布局，全部集中在此，便于调参）
   * ============================================================ */
  var CFG = {
    DESIGN_W: 750,
    DESIGN_H: 1624,
    SAFE_TOP: 60,          // 顶部安全区（设计px，wx 环境会按状态栏实际高度覆盖）
    SAFE_BOTTOM: 100,      // 底部安全区
    LETTERBOX_BG: '#EFECE4',

    // ---- 评分引擎参数（v0.2：完整参数见下方 SCORE_CFG，可单段调参）----
    RANK_HIGH_LINE: 87,    // ≥87 高段位：结算页细环庆祝加强

    // ---- 画布 ----
    STROKE_W: 12,
    STROKE_COLOR: '#2C2C2A',
    INK_BG: '#F7F5F0',
    FIT_DASH: [10, 10],    // 结算标准圆虚线（线宽 3、色 #B4B2A9）

    // ---- 动效（v0.1.3：结算节奏压缩到 ~1s，可点击跳过）----
    TRANSITION_MS: 250,    // 页面水平滑入+淡入
    PRESS_MS: 120,         // 按钮按下 0.95 缩放
    PRESS_RELEASE_MS: 170, // 松手回弹（含轻微过冲）
    ROLL_MS: 500,          // 分数滚动
    POP_MS: 320,           // 段位徽章弹出
    POP_DELAY_MS: 520,     // 段位在分数滚完后开始
    FADE_MS: 240,          // 评语淡入
    FADE_DELAY_MS: 700,    // 评语在段位弹出后开始
    BUTTON_AT: 820,        // 「再来一局」出现时刻（此前不可点）
    RESULT_END: 1060,      // 结算动画完整结束时刻（点击跳过即跳到这里）
    BADGE_MS: 600,         // 新纪录徽章摇摆
    TOAST_MS: 1200,        // toast 展示时长
    PULSE_MS: 620,         // 高分细环扩散
    HINT_PULSE_MS: 1600,   // 首次引导呼吸

    // ---- 布局 ----
    LOGO_W: 560,
    LOGO_Y: 420,
    START_BTN: { x: 375, y: 980, w: 340, h: 112 },  // 中心点+尺寸（设计px）
    BTN_HIT_PAD: 24,     // 按钮热区外扩，保证 ≥88×88
    ICON_BTN_R: 48,      // 顶栏图标热区半径（96×96 设计px，满足触摸标准）
    ICON_SIZE: 40,       // 图标视觉直径
    // P1：开放数据域占位内容在首页的贴图矩形（左上角 + 尺寸，设计px）
    // P4 起首页这块位置改成「好友排行」入口按钮（见 RANK_BTN）
    OD_PLACEHOLDER: { x: 125, y: 800, w: 500, h: 96 },
    // ---- P4：好友榜 ----
    // 首页入口（次级按钮）：logo 与「开画」之间。
    // 设计文档 §8.1 写的是 y=772 —— 那个坐标没算上「最佳 XX · 段位」那一行
    // （它在 y=740），按钮会压到字上，所以往下挪到 830。
    RANK_BTN: { x: 375, y: 830, w: 280, h: 88 },
    RANK_PANEL: {
      mask: { x: 0, y: 0, w: 750, h: 1624 },
      title: { x: 375, y: 150 },
      content: { x: 25, y: 210, w: 700, h: 1180 },   // 开放数据域画的榜面贴在这里
      backBtn: { x: 375, y: 1500, w: 340, h: 96 }
    },
    MAX_POINTS: 900,     // 笔迹点上限：超出后均匀抽稀，避免长笔迹被硬截断而画面冻结

    // ---- 云端（P3）----
    CLOUD_ENV: 'cloud1-d6grvs82r581230b2',   // 云环境 ID
    CLOUD_TIMEOUT_MS: 5000,                 // 云调用超时：超了按「服务不可达」降级，不卡住玩法
    CLOUD_KEY: 'circle'                      // 托管数据 key（≤8 字符全英文，后台排行榜配置对应）
  };

  var COL = {
    ink: '#2C2C2A',
    accent: '#D95F28',       // 原 #FF7A45：白字对比度 2.59:1 → 3.74:1
    accentDark: '#C9501D',   // 原 #F2662F：白字对比度 3.13:1 → 4.52:1
    grayText: '#6E685E',     // 原 #8A857A：对比度 3.4:1 → 5.1:1
    icon: '#4A4740',         // 顶栏图标线条色
    commentText: '#57534A',       // 评语（加深，对比度 ≈7.7:1，原 #8A857A 仅 3.2:1）
    warnText: '#C0392B',          // 未闭合提示（加深，≈5.4:1）
    cardBg: 'rgba(255,255,255,0.94)',   // 结算文本块衬底：压在笔迹上也清晰
    cardLine: 'rgba(44,44,42,0.10)',
    fitCircle: '#B4B2A9',  // 结算标准圆虚线
    cardWhite: '#FFFFFF',
    btnSecondary: '#F1EDE4'
  };

  /* ============================================================
   * 二、环境适配层（约 60 行，上层逻辑只调 env）
   * ============================================================ */
  var hasWx = typeof wx !== 'undefined' && typeof wx.createCanvas === 'function';
  // 好友榜（P4）：入口按钮**两个环境都显示** —— 浏览器端没有好友关系链，
  // 点了会提示「要在微信里看」，但界面长得一样才敢信（也才敢用 e2e 断言它存在）
  var rankEnabled = !!LeaderboardBridge;

  // 最小画布桩：仅用于 Node 下跑评分引擎单测（浏览器/小游戏走真实 canvas）
  var stubCtx = {
    font: '', fillStyle: '', strokeStyle: '', globalAlpha: 1, lineWidth: 1,
    lineCap: '', lineJoin: '', textAlign: '', textBaseline: '',
    setTransform: function () {}, save: function () {}, restore: function () {},
    translate: function () {}, scale: function () {}, beginPath: function () {},
    moveTo: function () {}, lineTo: function () {}, arc: function () {}, arcTo: function () {},
    closePath: function () {}, stroke: function () {}, fill: function () {},
    fillRect: function () {}, clearRect: function () {}, drawImage: function () {},
    setLineDash: function () {}, fillText: function () {},
    measureText: function (t) { return { width: (t || '').length * 16 }; },
    createLinearGradient: function () { return { addColorStop: function () {} }; }
  };

  // 取开放数据域的离屏画布（sharedCanvas）
  //
  // 好友的昵称/头像/分数属于关系链数据，只在开放数据域里读得到。主域拿不到数据本身，
  // 只能把开放数据域画到 sharedCanvas 上的内容贴出来。
  //
  // 不可用时（非微信环境 / 老基础库没有这个 API / 调用抛错）一律返回 null ——
  // 静默降级，绝不抛错：开放数据域是可选能力，不能因为它拖垮主玩法。
  // 做成"注入 wxApi 的纯函数"是为了能直接单测这条降级矩阵。
  function resolveSharedCanvas(wxApi) {
    if (!wxApi || typeof wxApi.getOpenDataContext !== 'function') return null;
    try {
      var odc = wxApi.getOpenDataContext();
      return (odc && odc.canvas) || null;
    } catch (e) {
      return null;
    }
  }

  var env = {
    isWx: hasWx,
    canvas: null,
    width: 0,          // 画布物理像素宽
    height: 0,
    dpr: 1,
    statusBarH: 0,     // 设计px 下的顶部安全区

    createCanvas: function () {
      if (hasWx) return wx.createCanvas();
      if (typeof document !== 'undefined') return document.createElement('canvas');
      // Node（跑评分引擎单测）下没有 DOM：给一个最小画布桩
      return {
        width: 750, height: 1624, style: {},
        getContext: function () { return stubCtx; },
        addEventListener: function () {}
      };
    },

    // 开放数据域的离屏画布（sharedCanvas）
    getSharedCanvas: function () {
      if (!hasWx) return null;
      return resolveSharedCanvas(wx);
    },

    getScreenSize: function () {
      if (hasWx) {
        // 小游戏环境无 window 对象，屏幕信息只能取自 wx API
        // getWindowInfo 为新版接口（基础库 2.20.1+），低版本回退 getSystemInfoSync
        var s = (wx.getWindowInfo ? wx.getWindowInfo() : wx.getSystemInfoSync());
        return { w: s.windowWidth, h: s.windowHeight, dpr: s.pixelRatio || 2, statusBarH: s.statusBarHeight || 0 };
      }
      if (typeof window === 'undefined') {
        return { w: 750, h: 1624, dpr: 1, statusBarH: 0 };   // Node 单测环境
      }
      return {
        w: window.innerWidth,
        h: window.innerHeight,
        dpr: Math.min(window.devicePixelRatio || 1, 3),
        statusBarH: 0
      };
    },

    now: function () {
      return (typeof performance !== 'undefined' && performance.now) ? performance.now() : Date.now();
    },

    // 墙钟时间（Unix 毫秒）：env.now() 是**相对时间**（performance.now），
    // 不能直接当时间戳用 —— 托管数据的 update_time 要的是 Unix 秒。
    wallNow: function () {
      return Date.now();
    },

    loadImage: function (src, cb) {
      // 小游戏环境没有全局 Image 构造器，必须走 wx.createImage()
      if (!hasWx && typeof Image === 'undefined') { cb(null); return; }   // Node 单测环境
      var img = hasWx ? wx.createImage() : new Image();
      img.onload = function () { cb(img); };
      img.onerror = function () { cb(null); };
      img.src = src;
    },

    getStorage: function (key) {
      try {
        if (hasWx) { var v = wx.getStorageSync(key); return v === '' ? null : v; }
        var s = localStorage.getItem(key);
        return s === null ? null : Number(s);
      } catch (e) { return null; }
    },

    setStorage: function (key, val) {
      try {
        if (hasWx) { wx.setStorageSync(key, val); }
        else { localStorage.setItem(key, String(val)); }
      } catch (e) { /* 存储失败不影响本局 */ }
    },

    // 原始字符串存取：存档（JSON）不能走 getStorage 的 Number() 转换
    getStorageRaw: function (key) {
      try {
        if (hasWx) { var v = wx.getStorageSync(key); return v === '' ? null : v; }
        return localStorage.getItem(key);
      } catch (e) { return null; }
    },

    setStorageRaw: function (key, val) {
      try {
        if (hasWx) { wx.setStorageSync(key, val); }
        else { localStorage.setItem(key, val); }
      } catch (e) { /* 存储失败不影响本局 */ }
    },

    // 统一触摸/指针输入：cb(type, x物理px, y物理px, isTrusted, evtTime)
    // evtTime 为事件自带时间戳，供防作弊的时钟一致性检查使用
    bindInput: function (canvas, onEvent) {
      if (hasWx) {
        // wx 触摸事件 clientX 是逻辑px，canvas 是物理px（windowWidth×pixelRatio），
        // 必须先乘 dpr 换算成物理px，否则 dpr≠1 真机上坐标整体缩水（与浏览器分支同根因）
        // 系数每次实时计算：窗口尺寸变化（旋转/分屏）后触点坐标才不会错位
        function kNow() { return canvas.width / env.cssWidth; }
        function toPhys(t) { var kk = kNow(); return { x: t.clientX * kk, y: t.clientY * kk }; }
        var activeTouch = null;   // 只认第一个触点：第二根手指落下不会清空正在画的笔迹
        function pickTouch(list) {
          if (!list || !list.length) return null;
          for (var i = 0; i < list.length; i++) {
            if (activeTouch === null || list[i].identifier === activeTouch) return list[i];
          }
          return null;
        }
        wx.onTouchStart(function (e) {
          if (activeTouch !== null) return;
          var t = (e.changedTouches && e.changedTouches[0]) || (e.touches && e.touches[0]);
          if (!t) return;
          activeTouch = t.identifier;
          var p = toPhys(t);
          onEvent('down', p.x, p.y, true, e.timeStamp);
        });
        wx.onTouchMove(function (e) {
          var t = pickTouch(e.touches);
          if (t) { var p = toPhys(t); onEvent('move', p.x, p.y, true, e.timeStamp); }
        });
        wx.onTouchEnd(function (e) {
          var t = pickTouch(e.changedTouches) || (e.touches && e.touches[0]);
          if (t) { var p = toPhys(t); onEvent('up', p.x, p.y, true, e.timeStamp); }
          activeTouch = null;
        });
        // 触摸被系统打断（来电 / 手势 / 切后台）：按 cancel 处理，绝不结算成绩
        wx.onTouchCancel(function (e) {
          activeTouch = null;
          onEvent('cancel', 0, 0, true, e.timeStamp);
        });
        return;
      }
      // 浏览器：Pointer Events 同时覆盖鼠标与触摸
      if (typeof window === 'undefined') return;   // Node 单测环境：无 DOM 可绑
      var activeId = null;
      function toDesign(e) {
        var r = canvas.getBoundingClientRect();
        var k = canvas.width / r.width;   // CSS px → 物理 px（dpr>1 时 clientX 是 CSS px，需先放大再进统一换算）
        return { x: (e.clientX - r.left) * k, y: (e.clientY - r.top) * k };
      }
      canvas.addEventListener('pointerdown', function (e) {
        e.preventDefault();
        if (activeId !== null) return;   // 多点触控只取第一个触点
        activeId = e.pointerId;
        var p = toDesign(e);
        onEvent('down', p.x, p.y, e.isTrusted !== false, e.timeStamp);
      });
      window.addEventListener('pointermove', function (e) {
        if (activeId === null || e.pointerId !== activeId) return;
        var p = toDesign(e);
        onEvent('move', p.x, p.y, true, e.timeStamp);
      });
      window.addEventListener('pointerup', function (e) {
        if (activeId === null || e.pointerId !== activeId) return;
        activeId = null;
        var p = toDesign(e);
        onEvent('up', p.x, p.y, true, e.timeStamp);
      });
      window.addEventListener('pointercancel', function (e) {
        if (activeId === null || e.pointerId !== activeId) return;
        activeId = null;
        var p = toDesign(e);
        onEvent('cancel', p.x, p.y, true, e.timeStamp);   // 打断手势：取消当前笔迹，不评分
      });
      // 阻止页面滚动 / 下拉回弹 / 双击缩放 / 长按菜单
      canvas.style.touchAction = 'none';
      canvas.addEventListener('touchstart', function (e) { e.preventDefault(); }, { passive: false });
      canvas.addEventListener('touchmove', function (e) { e.preventDefault(); }, { passive: false });
      canvas.addEventListener('contextmenu', function (e) { e.preventDefault(); });
      document.body.style.overscrollBehavior = 'none';
    }
  };

  /* ============================================================
   * 二·补、云端上报客户端（P3）
   *
   * 只有**有云**时才建客户端：浏览器预览、没有 wx.cloud 的环境一律退化成单机模式，
   * 行为与 P3 之前完全一致（不调云函数、不影响本地最佳分与新纪录徽章）。
   *
   * 依赖全部注入到 js/cloud.js —— 那边不碰任何平台全局，所以 Node 里能用假实现测全部分支。
   * ============================================================ */
  var cloud = null;

  function createCloudClient() {
    if (!CloudClient) return null;
    if (!hasWx || typeof wx.cloud === 'undefined' || typeof wx.cloud.callFunction !== 'function') return null;
    try {
      wx.cloud.init({ env: CFG.CLOUD_ENV, traceUser: true });
    } catch (e) {
      return null;   // 云环境没配 / 初始化失败 → 单机模式，不影响玩法
    }
    return CloudClient.createClient({
      callFunction: function (name, data) {
        return wx.cloud.callFunction({ name: name, data: data });
      },
      setUserCloudStorage: function (payload) {
        return new Promise(function (resolve, reject) {
          if (typeof wx.setUserCloudStorage !== 'function') {
            reject(new Error('setUserCloudStorage 不可用'));
            return;
          }
          wx.setUserCloudStorage({
            KVDataList: payload.KVDataList,
            success: function () { resolve(true); },
            fail: function (err) { reject(err); }
          });
        });
      },
      storage: {
        get: function (k) { return env.getStorageRaw(k); },
        set: function (k, v) { env.setStorageRaw(k, v); }
      },
      now: function () { return env.wallNow(); },   // 墙钟：托管数据的 update_time 要 Unix 秒
      // 诊断日志出口：真机（预览模式）看不到别的日志，链路断在哪只能靠这几行判断
      log: function (msg) {
        try { if (typeof console !== 'undefined' && console.log) console.log(msg); } catch (e) { /* ignore */ }
      },
      key: CFG.CLOUD_KEY,
      highScore: GUARD_CFG.HIGH_SCORE,   // 95：复用已有的「高分从严」阈值，不另造一个
      timeoutMs: CFG.CLOUD_TIMEOUT_MS
    });
  }

  // 段位索引（托管数据里的 level 字段）
  function rankIndexOf(score) {
    var rk = getRank(score);
    var idx = RANKS.indexOf(rk.rank);
    return idx < 0 ? 0 : idx;
  }

  /* ============================================================
   * 三、画布初始化（逻辑坐标 750×1624，等比缩放居中，留边填底色）
   * ============================================================ */
  var canvas = env.createCanvas();
  var ctx = canvas.getContext('2d');

  var view = { scale: 1, offsetX: 0, offsetY: 0 };  // 物理像素 → 设计坐标

  // 「再来一局」按钮：y 随底部安全区动态调整（resize 里更新）
  var AGAIN_BTN = {
    x: 375,
    y: CFG.DESIGN_H - CFG.SAFE_BOTTOM - 72,
    w: 340, h: 104
  };

  function resize() {
    var s = env.getScreenSize();
    env.dpr = s.dpr;
    env.cssWidth = s.w;   // 逻辑/CSS 宽度，供 wx 输入换算（逻辑px→物理px）
    env.width = Math.round(s.w * s.dpr);
    env.height = Math.round(s.h * s.dpr);
    canvas.width = env.width;
    canvas.height = env.height;
    if (!hasWx) {
      canvas.style.width = s.w + 'px';
      canvas.style.height = s.h + 'px';
    }
    view.scale = Math.min(env.width / CFG.DESIGN_W, env.height / CFG.DESIGN_H);
    view.offsetX = (env.width - CFG.DESIGN_W * view.scale) / 2;
    view.offsetY = (env.height - CFG.DESIGN_H * view.scale) / 2;
    // 顶部安全区：wx 按状态栏换算成设计px，浏览器给固定余量
    env.statusBarH = hasWx
      ? (s.statusBarH * s.dpr) / view.scale
      : CFG.SAFE_TOP;
    // 底部安全区：iPhone 底部手势条（safeArea）——避免「再来一局」被盖住
    env.safeBottom = CFG.SAFE_BOTTOM;
    if (hasWx) {
      try {
        var wi = wx.getWindowInfo ? wx.getWindowInfo() : wx.getSystemInfoSync();
        if (wi.safeArea && wi.safeArea.bottom) {
          var inset = ((s.h - wi.safeArea.bottom) * s.dpr) / view.scale;
          if (inset > 0) env.safeBottom = Math.max(CFG.SAFE_BOTTOM, inset);
        }
      } catch (e) { /* 拿不到 safeArea 就用默认值 */ }
    }
    AGAIN_BTN.y = CFG.DESIGN_H - env.safeBottom - 72;
  }
  resize();
  if (hasWx && wx.onWindowResize) {
    wx.onWindowResize(resize);
  } else if (typeof window !== 'undefined') {
    window.addEventListener('resize', resize);
  }

  // 从后台切回来：补发一次 showLeaderboard。
  // 原因有二（设计文档 §十二 风险表）：
  //   1. sharedCanvas 在页面切换 / onShow 后内容会丢 → 开放域要重画
  //   2. 玩家可能刚在设置页开了「向朋友公开」→ 门禁要重新走一遍
  if (hasWx && wx.onShow) {
    wx.onShow(function () {
      try { resendShowOnShow(); } catch (e) { /* ignore */ }
    });
  }

  if (!hasWx && typeof document !== 'undefined') {
    // 浏览器：注入全屏样式，禁止滚动
    var style = document.createElement('style');
    style.textContent =
      'html,body{margin:0;padding:0;width:100%;height:100%;overflow:hidden;position:fixed;' +
      'background:' + CFG.LETTERBOX_BG + ';overscroll-behavior:none;}' +
      'canvas{display:block;position:fixed;left:0;top:0;}';
    document.head.appendChild(style);
    document.body.appendChild(canvas);
  }

  // 物理px → 设计坐标
  function toDesign(px, py) {
    return { x: (px - view.offsetX) / view.scale, y: (py - view.offsetY) / view.scale };
  }

  /* ============================================================
   * 四、缓动与工具
   * ============================================================ */
  function clamp(v, lo, hi) { return v < lo ? lo : (v > hi ? hi : v); }
  function easeOutCubic(t) { return 1 - Math.pow(1 - t, 3); }
  function easeOutQuad(t) { return 1 - (1 - t) * (1 - t); }

  // CSS cubic-bezier 求解器（用于段位弹出 cubic-bezier(0.34,1.56,0.64,1)）
  function cubicBezier(x1, y1, x2, y2) {
    function A(a, b) { return 1 - 3 * b + 3 * a; }
    function B(a, b) { return 3 * b - 6 * a; }
    function C(a) { return 3 * a; }
    function calc(t, a, b) { return ((A(a, b) * t + B(a, b)) * t + C(a)) * t; }
    function slope(t, a, b) { return 3 * A(a, b) * t * t + 2 * B(a, b) * t + C(a); }
    return function (x) {
      var t = x;
      for (var i = 0; i < 6; i++) {
        var s = slope(t, x1, x2);
        if (Math.abs(s) < 1e-5) break;
        t -= (calc(t, x1, x2) - x) / s;
      }
      return clamp(calc(t, y1, y2), 0, 2);  // 允许超过1（回弹）
    };
  }
  var popEase = cubicBezier(0.34, 1.56, 0.64, 1);

  function roundRect(c, x, y, w, h, r) {
    c.beginPath();
    c.moveTo(x + r, y);
    c.arcTo(x + w, y, x + w, y + h, r);
    c.arcTo(x + w, y + h, x, y + h, r);
    c.arcTo(x, y + h, x, y, r);
    c.arcTo(x, y, x + w, y, r);
    c.closePath();
  }

  function hitBtn(x, y, btn) {
    var p = CFG.BTN_HIT_PAD;
    return x >= btn.x - btn.w / 2 - p && x <= btn.x + btn.w / 2 + p &&
           y >= btn.y - btn.h / 2 - p && y <= btn.y + btn.h / 2 + p;
  }

  /* ============================================================
   * 四·补、顶栏控件（返回）与线性图标
   * 一律放在左上角：微信右上角是胶囊按钮，不能占用
   * ============================================================ */
  function iconButtons() {
    var y = Math.max(env.statusBarH, CFG.SAFE_TOP) + 40;
    if (state.page === 'home') return [];
    return [{ id: 'back', x: 64, y: y }];
  }

  function hitIcon(x, y) {
    var list = iconButtons();
    for (var i = 0; i < list.length; i++) {
      var b = list[i];
      if (Math.abs(x - b.x) <= CFG.ICON_BTN_R && Math.abs(y - b.y) <= CFG.ICON_BTN_R) return b.id;
    }
    return null;
  }

  // 顶栏图标：返回箭头
  function drawIcon(c, id, x, y, size) {
    var s = size / 2;
    c.save();
    c.translate(x, y);
    c.strokeStyle = COL.icon;
    c.fillStyle = COL.icon;
    c.lineWidth = 4;
    c.lineCap = 'round';
    c.lineJoin = 'round';
    if (id === 'back') {
      c.beginPath();
      c.moveTo(s * 0.45, -s * 0.7);
      c.lineTo(-s * 0.45, 0);
      c.lineTo(s * 0.45, s * 0.7);
      c.stroke();
    }
    c.restore();
  }

  // 五角星（新纪录徽章用，替代 emoji）
  function drawStar(c, cx, cy, r) {
    c.save();
    c.translate(cx, cy);
    c.fillStyle = '#F0C64A';
    c.strokeStyle = '#B8860B';
    c.lineWidth = 2;
    c.lineJoin = 'round';
    c.beginPath();
    for (var i = 0; i < 10; i++) {
      var rr = i % 2 === 0 ? r : r * 0.45;
      var a = -Math.PI / 2 + i * Math.PI / 5;
      var x = Math.cos(a) * rr, y = Math.sin(a) * rr;
      if (i === 0) c.moveTo(x, y); else c.lineTo(x, y);
    }
    c.closePath();
    c.fill();
    c.stroke();
    c.restore();
  }

  // 段位徽章：统一线性手绘风，替代系统 emoji（跨平台样式不一致）
  function drawRankIcon(c, key, cx, cy, size) {
    var r = size / 2;
    c.save();
    c.translate(cx, cy);
    c.strokeStyle = COL.ink;
    c.fillStyle = COL.ink;
    c.lineWidth = 4;
    c.lineCap = 'round';
    c.lineJoin = 'round';
    if (key === 'potato') {          // 土豆：歪椭圆 + 两点
      c.save();
      c.rotate(-0.32);
      c.scale(1, 0.72);
      c.lineWidth = 5.5;
      c.beginPath();
      c.arc(0, 0, r * 0.86, 0, Math.PI * 2);
      c.stroke();
      c.restore();
      c.beginPath(); c.arc(-r * 0.26, -r * 0.1, r * 0.08, 0, Math.PI * 2); c.fill();
      c.beginPath(); c.arc(r * 0.22, -r * 0.22, r * 0.08, 0, Math.PI * 2); c.fill();
    } else if (key === 'egg') {      // 鸡蛋：竖椭圆 + 高光
      c.save();
      c.scale(0.66, 1);
      c.beginPath();
      c.arc(0, 0, r * 0.82, 0, Math.PI * 2);
      c.stroke();
      c.restore();
      c.beginPath();
      c.arc(-r * 0.2, -r * 0.32, r * 0.16, Math.PI * 0.9, Math.PI * 1.7);
      c.stroke();
    } else if (key === 'tire') {     // 轮胎：双圆 + 胎纹
      c.beginPath();
      c.arc(0, 0, r * 0.92, 0, Math.PI * 2);
      c.stroke();
      c.beginPath();
      c.arc(0, 0, r * 0.46, 0, Math.PI * 2);
      c.stroke();
      for (var i = 0; i < 6; i++) {
        var a = (i / 6) * Math.PI * 2;
        c.beginPath();
        c.moveTo(Math.cos(a) * r * 0.58, Math.sin(a) * r * 0.58);
        c.lineTo(Math.cos(a) * r * 0.8, Math.sin(a) * r * 0.8);
        c.stroke();
      }
    } else if (key === 'moon') {     // 满月：圆 + 环形山
      c.beginPath();
      c.arc(0, 0, r * 0.9, 0, Math.PI * 2);
      c.stroke();
      c.lineWidth = 3;
      c.beginPath(); c.arc(-r * 0.3, -r * 0.24, r * 0.16, 0, Math.PI * 2); c.stroke();
      c.beginPath(); c.arc(r * 0.24, r * 0.1, r * 0.22, 0, Math.PI * 2); c.stroke();
      c.beginPath(); c.arc(r * 0.1, -r * 0.42, r * 0.1, 0, Math.PI * 2); c.stroke();
    } else if (key === 'compass') {  // 圆规：圆 + 十字准星 + 指针
      c.beginPath();
      c.arc(0, 0, r * 0.9, 0, Math.PI * 2);
      c.stroke();
      c.lineWidth = 3;
      c.beginPath();
      c.moveTo(-r * 0.9, 0); c.lineTo(r * 0.9, 0);
      c.moveTo(0, -r * 0.9); c.lineTo(0, r * 0.9);
      c.stroke();
      c.fillStyle = COL.accent;
      c.beginPath();
      c.moveTo(0, -r * 0.5);
      c.lineTo(r * 0.2, 0);
      c.lineTo(0, r * 0.5);
      c.lineTo(-r * 0.2, 0);
      c.closePath();
      c.fill();
    } else if (key === 'chaos') {    // 灾难现场：乱线
      c.beginPath();
      c.moveTo(-r * 0.8, -r * 0.45);
      c.bezierCurveTo(r * 0.25, -r * 0.95, -r * 0.3, r * 0.2, r * 0.8, -r * 0.1);
      c.stroke();
      c.beginPath();
      c.moveTo(-r * 0.75, r * 0.5);
      c.bezierCurveTo(r * 0.3, r * 0.05, -r * 0.2, -r * 0.45, r * 0.7, r * 0.55);
      c.stroke();
      c.beginPath();
      c.moveTo(-r * 0.5, -r * 0.8);
      c.lineTo(r * 0.55, r * 0.8);
      c.stroke();
    } else if (key === 'noodle') {   // 一团面条：波浪
      c.beginPath();
      var nFirst = true;
      for (var nx = -0.85; nx <= 0.85; nx += 0.085) {
        var ny = Math.sin(nx * 7.2) * 0.4;
        if (nFirst) { c.moveTo(r * nx, r * ny); nFirst = false; } else c.lineTo(r * nx, r * ny);
      }
      c.stroke();
      c.beginPath();
      c.moveTo(-r * 0.7, r * 0.72);
      c.bezierCurveTo(-r * 0.1, r * 0.5, r * 0.3, r * 0.85, r * 0.72, r * 0.6);
      c.stroke();
    } else if (key === 'dumpling') { // 饺子：半圆 + 褶子
      c.beginPath();
      c.arc(0, r * 0.28, r * 0.72, Math.PI, 0);
      c.stroke();
      c.beginPath();
      c.moveTo(-r * 0.72, r * 0.28);
      c.lineTo(r * 0.72, r * 0.28);
      c.stroke();
      c.lineWidth = 3;
      for (var dp = -0.45; dp <= 0.46; dp += 0.3) {
        c.beginPath();
        c.moveTo(r * dp, r * 0.2);
        c.lineTo(r * dp * 0.78, -r * 0.3);
        c.stroke();
      }
    } else if (key === 'donut') {    // 甜甜圈：双圆 + 糖粒
      c.beginPath(); c.arc(0, 0, r * 0.88, 0, Math.PI * 2); c.stroke();
      c.beginPath(); c.arc(0, 0, r * 0.3, 0, Math.PI * 2); c.stroke();
      c.fillStyle = COL.accent;
      c.beginPath(); c.arc(-r * 0.55, -r * 0.3, r * 0.09, 0, Math.PI * 2); c.fill();
      c.beginPath(); c.arc(r * 0.52, -r * 0.45, r * 0.09, 0, Math.PI * 2); c.fill();
      c.beginPath(); c.arc(r * 0.35, r * 0.45, r * 0.09, 0, Math.PI * 2); c.fill();
    } else if (key === 'cookie') {   // 饼干：圆 + 巧克力豆
      c.beginPath(); c.arc(0, 0, r * 0.85, 0, Math.PI * 2); c.stroke();
      c.fillStyle = COL.ink;
      c.beginPath(); c.arc(-r * 0.3, -r * 0.25, r * 0.13, 0, Math.PI * 2); c.fill();
      c.beginPath(); c.arc(r * 0.28, -r * 0.1, r * 0.11, 0, Math.PI * 2); c.fill();
      c.beginPath(); c.arc(-r * 0.05, r * 0.38, r * 0.12, 0, Math.PI * 2); c.fill();
    } else if (key === 'book') {     // 教科书：摊开的书
      c.beginPath();
      c.moveTo(0, -r * 0.28);
      c.quadraticCurveTo(-r * 0.45, -r * 0.62, -r * 0.86, -r * 0.4);
      c.lineTo(-r * 0.86, r * 0.42);
      c.quadraticCurveTo(-r * 0.45, r * 0.16, 0, r * 0.42);
      c.quadraticCurveTo(r * 0.45, r * 0.16, r * 0.86, r * 0.42);
      c.lineTo(r * 0.86, -r * 0.4);
      c.quadraticCurveTo(r * 0.45, -r * 0.62, 0, -r * 0.28);
      c.closePath();
      c.stroke();
      c.beginPath();
      c.moveTo(0, -r * 0.28);
      c.lineTo(0, r * 0.42);
      c.stroke();
    } else if (key === 'scope') {    // 精密仪器：显微镜
      c.beginPath();
      c.moveTo(-r * 0.14, -r * 0.82);
      c.lineTo(r * 0.3, -r * 0.5);
      c.stroke();
      c.beginPath();
      c.arc(r * 0.16, -r * 0.28, r * 0.19, 0, Math.PI * 2);
      c.stroke();
      c.beginPath();
      c.moveTo(r * 0.16, -r * 0.09);
      c.lineTo(r * 0.16, r * 0.44);
      c.stroke();
      c.beginPath();
      c.moveTo(-r * 0.46, r * 0.44);
      c.lineTo(r * 0.74, r * 0.44);
      c.stroke();
      c.beginPath();
      c.moveTo(-r * 0.46, r * 0.44);
      c.lineTo(-r * 0.46, r * 0.7);
      c.stroke();
    } else if (key === 'crown') {    // 神之圆：皇冠
      c.lineWidth = 4;
      c.beginPath();
      c.moveTo(-r * 0.72, r * 0.42);
      c.lineTo(-r * 0.58, -r * 0.5);
      c.lineTo(-r * 0.24, r * 0.04);
      c.lineTo(0, -r * 0.62);
      c.lineTo(r * 0.24, r * 0.04);
      c.lineTo(r * 0.58, -r * 0.5);
      c.lineTo(r * 0.72, r * 0.42);
      c.closePath();
      c.stroke();
      c.beginPath();
      c.moveTo(-r * 0.72, r * 0.42);
      c.lineTo(r * 0.72, r * 0.42);
      c.stroke();
      c.fillStyle = COL.accent;
      c.beginPath(); c.arc(0, -r * 0.66, r * 0.12, 0, Math.PI * 2); c.fill();
    }
    c.restore();
  }

  // 段位评语：UI 侧有状态（不与上次重复）且用随机数 —— 故留在主域，不进共享模块
  var lastCommentIdx = {};   // 各段位上次用过的评语下标，避免连着两次撞同一句
  function pickComment(rank) {
    var pool = rank.comments;
    var idx = Math.floor(Math.random() * pool.length);
    if (pool.length > 1 && lastCommentIdx[rank.name] === idx) {
      idx = (idx + 1) % pool.length;
    }
    lastCommentIdx[rank.name] = idx;
    return pool[idx];
  }

  /* ============================================================
   * 六·补、防作弊（v0.2，纯前端第一阶段）
   * 注：判定逻辑（guardCheck / judge）已移入 shared/scoring.js，本节只剩采集侧信号
   * 目标：挡住低成本作弊（改存储 / 控制台伪造 / 脚本灌入 / 匀速自动画圆），
   *       且不误伤真人：可疑成绩照常显示，只是不计入最佳、不出分享卡。
   * 局限：解包改代码挡不住，只能拖慢 —— 真正的高分榜还需要服务端重算。
   * ============================================================ */
  // 开发豁免：正式包可注入 __DEV__ = false 强制关闭；否则按环境判定
  // （wx 看 envVersion，浏览器预览看 localhost —— 线上部署的 hostname 不会是 localhost）
  var DEV = (function () {
    if (typeof __DEV__ !== 'undefined' && __DEV__ === false) return false;
    if (hasWx) {
      try { return wx.getAccountInfoSync().miniProgram.envVersion === 'develop'; }
      catch (e) { return false; }
    }
    return typeof location !== 'undefined' && /^(localhost|127\.0\.0\.1)$/.test(location.hostname);
  })();

  // 环境信号：整局共享
  var SIG = { untrusted: false, webdriver: false };
  if (!hasWx && typeof navigator !== 'undefined' && navigator.webdriver) SIG.webdriver = true;

  // 原始采样：{t: 事件时间戳, h: 回调执行时刻, x, y: 设计px}
  function pushRaw(list, evtTime, x, y) {
    var h = env.now();
    var t = (typeof evtTime === 'number' && evtTime > 0) ? evtTime : h;
    list.push({ t: t, h: h, x: x, y: y });
  }

  // 最高分存档自校验：连最佳那局的原始笔迹一起存，启动时用当前引擎重算
  // 想改出一个 99 分的最高分，就得伪造出一条能拿 99 分、又能通过行为检查的笔迹
  function saveBestRecord(score, pts) {
    var rec = { v: GUARD_CFG.BEST_VERSION, score: score, pts: encodePts(pts) };
    rec.sum = fnv(BEST_SALT + JSON.stringify([rec.v, rec.score, rec.pts]));
    env.setStorageRaw('best_rec', JSON.stringify(rec));
  }

  function loadBestRecord() {
    try {
      var s = env.getStorageRaw('best_rec');
      if (!s) return null;
      var rec = JSON.parse(s);
      if (!rec || rec.v !== GUARD_CFG.BEST_VERSION) return null;      // 版本不符 → 作废
      if (rec.sum !== fnv(BEST_SALT + JSON.stringify([rec.v, rec.score, rec.pts]))) return null;
      var r = evaluate(decodePts(rec.pts));
      if (!r.valid || Math.abs(r.score - rec.score) > 0.15) return null;  // 重算对不上 → 作废
      return rec.score;
    } catch (e) { return null; }
  }

  function loadHistory() {
    try {
      var s = env.getStorageRaw('stroke_hist');
      if (!s) return [];
      var a = JSON.parse(s);
      return (a && a.length) ? a : [];
    } catch (e) { return []; }
  }

  function pushHistory(sig) {
    if (!sig) return;
    var h = loadHistory();
    h.push(sig);
    while (h.length > GUARD_CFG.KEEP_HISTORY) h.shift();
    env.setStorageRaw('stroke_hist', JSON.stringify(h));
  }

  /* ============================================================
   * 七、游戏状态
   * ============================================================ */
  var state = {
    page: 'home',            // 'home' | 'draw'
    drawing: false,          // 画圆页是否正在绘制
    discardGesture: false,   // 非真实输入 → 丢弃当前手势
    points: [],              // 笔迹点 [{x,y,t}]（设计坐标）
    raw: [],                 // 原始采样 [{t,h,x,y}]：事件时间戳 + 回调时刻，供防作弊检查
    best: loadBestRecord(),  // 最高分：启动时用当前引擎重算校验，对不上就作废
    bestPending: null,       // 待落定的最高分：新纪录徽章播完才更新显示，避免剧透
    hintSeen: env.getStorage('hintSeen') ? 1 : 0, // 首局引导是否已看过
    toast: null,             // {text, t0}
    trans: null,             // {from,to,t0,dir}
    pressedBtn: null,        // {id, t0}（按住中）
    btnRelease: null,        // {id, t0}（松手回弹动画中）
    rankPending: false,      // 好友榜：等玩家在设置页开完「向朋友公开」再回来
    result: null             // 结算数据（直接画在画布上，无浮层）
  };

  var imgs = { home_bg: null, logo_title: null };

  // 「再来一局」底部固定按钮已在画布初始化处定义（y 随底部安全区动态更新）

  /* ============================================================
   * 八、业务动作
   * ============================================================ */
  function startTransition(to, dir) {
    state.trans = { from: state.page, to: to, t0: env.now(), dir: dir || 1 };
  }

  function goDraw() {
    state.points.length = 0;
    state.drawing = false;
    state.result = null;
    startTransition('draw', 1);
  }

  function goHome() {
    state.points.length = 0;
    state.drawing = false;
    state.result = null;
    startTransition('home', -1);
  }

  /* ---------- 好友榜（P4）---------- */

  function rankPanelLayout() {
    return CFG.RANK_PANEL;
  }

  // 门禁诊断日志 —— 真机调试时全靠它判断卡在哪一环
  function rankLog(m) {
    try { if (typeof console !== 'undefined' && console.log) console.log('[rank] ' + m); } catch (e) { /* ignore */ }
  }

  // 错误对象 → 一行可读文本（errMsg 通常是 'authorize:fail auth deny' 这种）
  function msg(e) {
    if (!e) return '(无)';
    if (typeof e === 'string') return e;
    return e.errMsg || e.message || JSON.stringify(e);
  }

  function getWxApi(wxApi) {
    if (wxApi) return wxApi;
    return hasWx ? wx : null;
  }

  // 主域 → 开放域（单向）。老基础库没有这个 API → 静默降级。
  function postToOpenData(msg, wxApi) {
    var w = getWxApi(wxApi);
    if (!w || typeof w.getOpenDataContext !== 'function') return false;
    try {
      var odc = w.getOpenDataContext();
      if (!odc || typeof odc.postMessage !== 'function') return false;
      odc.postMessage(msg);
      return true;
    } catch (e) {
      return false;
    }
  }

  function buildShowMessage(wxApi) {
    if (!LeaderboardBridge) return null;
    var best = (typeof state.best === 'number') ? state.best : null;
    var level = null;
    if (best !== null) {
      var rk = getRank(best);
      level = RANKS.indexOf(rk.rank);
      if (level < 0) level = null;
    }
    return LeaderboardBridge.buildShowMessage({
      key: CFG.CLOUD_KEY,
      selfScore: best,
      selfLevel: level,
      width: CFG.RANK_PANEL.content.w,
      height: CFG.RANK_PANEL.content.h,
      // ⚠️ 这里传的是**主域的物理像素/设计像素**比例（view.scale ≈ 1.56），
      // **不是设备像素比 env.dpr（≈3）**。
      //
      // 原因：开放域的共享画布是**物理像素**的，主域又把它画进设计坐标矩形里。
      // 要让内容在屏幕上和主域一样大，共享画布的密度就得等于主域的 view.scale；
      // 传 dpr 会让内容被放大/裁切（真机上出现过文字被放大三倍、卡片被切掉右边）。
      scale: view.scale,
      rankNames: LeaderboardBridge.resolveRankNames(RANKS),
      style: LeaderboardBridge.buildStyleParams()
    });
  }

  /**
   * 打开好友榜。
   *
   * 先过**隐私门禁**（设计文档 §8.3）：`scope.friendCloudStorage` 是隐私设置，
   * 不是普通授权，处理用三态：
   *   已授权 → 直接开
   *   曾拒绝 → 只能引导去设置页手动打开
   *   没决定 → 先 authorize，失败再引导去设置页
   *
   * 门禁放在"玩家主动点开排行榜"这一刻（不是一进游戏就弹 —— 首屏要授权转化率很难看）。
   *
   * @returns {Promise<{status:string}>} status: opened / denied / unavailable / error
   */
  function openLeaderboard(wxApi) {
    var w = getWxApi(wxApi);
    if (!w || !LeaderboardBridge) {
      // 浏览器端：没有微信环境，好友关系链读不到 —— 说清楚，别让人以为按钮坏了
      showToast('好友榜要在微信里看哦');
      return Promise.resolve({ status: 'unavailable' });
    }
    // 关系链数据的授权 scope —— **名字必须是这个**（官方 SCOPE 列表里只有它）。
    // 写成 scope.friendCloudStorage 会**静默失效**：authorize 必然失败 →
    // 玩家被引导去设置页 → 而设置页里根本没有「向朋友公开」这一项
    // （因为从没成功请求过）→ 死循环，玩家永远开不了。
    var FRIEND_SCOPE = 'scope.WxFriendInteraction';
    return new Promise(function (resolve) {
      var settled = false;
      function done(status) {
        if (settled) return;
        settled = true;
        resolve({ status: status });
      }
      function goRank() {
        state.rankPending = false;
        startTransition('rank', 1);
        postToOpenData(buildShowMessage(w), w);
        rankLog('已授权 → 打开榜面');
        done('opened');
      }
      function guideToSetting(reason) {
        // 玩家可能去设置页开了再回来 —— 回来时（onShow）要重新试一次
        state.rankPending = true;
        rankLog('未授权（' + reason + '）→ 引导去设置页开「向朋友公开」');
        showToast('请在设置里开启「向朋友公开」');
        try { if (typeof w.openSetting === 'function') w.openSetting({}); } catch (e) { /* ignore */ }
        done('denied');
      }
      function askAuthorize() {
        if (typeof w.authorize !== 'function') { guideToSetting('无 authorize 接口'); return; }
        rankLog('未决定 → 请求授权 ' + FRIEND_SCOPE);
        try {
          w.authorize({
            scope: FRIEND_SCOPE,
            success: function () { goRank(); },
            fail: function (e) { guideToSetting('授权被拒 ' + msg(e)); }
          });
        } catch (e) { guideToSetting('authorize 抛错 ' + msg(e)); }
      }
      try {
        if (typeof w.getSetting !== 'function') { guideToSetting('无 getSetting 接口'); return; }
        w.getSetting({
          success: function (res) {
            var auth = (res && res.authSetting) ? res.authSetting[FRIEND_SCOPE] : undefined;
            var st = LeaderboardBridge.classifyPrivacy(auth);
            rankLog('authSetting[' + FRIEND_SCOPE + '] = ' + String(auth) + ' → ' + st);
            if (st === 'granted') goRank();
            else if (st === 'denied') guideToSetting('曾拒绝');
            else askAuthorize();
          },
          fail: function (e) { rankLog('getSetting 失败 → 试 authorize ' + msg(e)); askAuthorize(); }
        });
      } catch (e) {
        rankLog('getSetting 抛错 ' + msg(e));
        done('error');
      }
    });
  }

  function closeLeaderboard(wxApi) {
    var w = getWxApi(wxApi);
    state.rankPending = false;
    if (LeaderboardBridge) postToOpenData(LeaderboardBridge.buildHideMessage(), w);
    startTransition('home', -1);
  }

  /**
   * 从后台切回来时补发。
   *
   * 两个原因要补：
   *   1. `sharedCanvas` 在页面切换 / onShow 后内容会丢 → 开放域要重画
   *   2. 玩家刚在设置页开了「向朋友公开」→ 门禁要重新走一遍
   */
  function resendShowOnShow(wxApi) {
    var w = getWxApi(wxApi);
    if (state.rankPending) {
      state.rankPending = false;
      openLeaderboard(w);
      return true;
    }
    var inRank = (state.page === 'rank') || (state.trans && state.trans.to === 'rank');
    if (!inRank) return false;
    if (!LeaderboardBridge) return false;
    return postToOpenData(buildShowMessage(w), w);
  }

  // 点击跳过结算动画：把时间轴直接推到终点
  function skipResult() {
    var r = state.result;
    if (!r) return;
    if (env.now() - r.t0 >= CFG.RESULT_END) return;
    r.t0 = env.now() - CFG.RESULT_END;
  }

  function showToast(text) {
    state.toast = { text: text, t0: env.now() };
  }

  function finishStroke() {
    state.drawing = false;
    var r = evaluate(state.points);
    if (!r.valid) {
      // 无效：给出具体原因（线 / 弧段 / 太小 / 太短），不结算
      state.points.length = 0;
      state.raw.length = 0;
      showToast(INVALID_TIPS[r.reason] || '这也太敷衍了');
      return;
    }
    // 防作弊：行为特征 + 重放检测 → 决定这次成绩能否计入最佳
    var g = guardCheck(state.raw, r.fit, r.score, SIG);
    var sig = shapeSig(state.points, r.fit);
    var replay = isReplay(sig, loadHistory());
    var verdict = judge(r, g, replay, DEV);
    if (verdict === 'reject') {
      state.points.length = 0;
      state.raw.length = 0;
      showToast('检测到非真实输入');
      return;
    }
    pushHistory(sig);
    var rk = getRank(r.score);
    var comment = pickComment(rk.rank);
    var res = {
      score: r.score,
      rank: rk.rank,
      next: rk.next,
      comment: comment,
      deg: r.deg,                                     // 累计有向角（°）
      gap: largestGap(state.points, r.fit.cx, r.fit.cy),  // 未闭合的那段弧（橙色虚线标注）
      isNew: verdict !== 'shadow' && (state.best === null || r.score > state.best),
      verdict: verdict,
      risk: g.risk,
      fit: r.fit,                                     // 拟合圆，用于叠加标准圆虚线
      t0: env.now(),
      vibrated: false                                // 新纪录震动只触发一次
    };
    res.layout = layoutResult(res);   // 排版算一次存起来，不再每帧重算
    res.pts = state.points.slice();   // 存一份笔迹：最高分存档要靠它自校验
    res.localScore = r.score;         // 云端分回来之前，本地算的分
    state.result = res;
    // 最高分不立即改显示：新纪录徽章播完再落定（否则顶部数字先变、徽章后出现＝剧透）
    if (res.isNew) state.bestPending = { score: r.score, pts: res.pts, cloudPending: false };
    // P3：破纪录才上报云端（D4）。高分（≥95）同步等云端结论，低分异步不阻塞结算。
    // 开发版（DEV）：云端结论只作提示，不改本地行为 —— 与本地 judge 的开发豁免同一个道理
    //   （服务端没有开发豁免，开发者自己的合成笔迹会被云端判成 shadow，不豁免就没法调试）
    if (res.isNew && cloud && cloud.enabled) {
      res.cloudPending = !DEV && (r.score >= GUARD_CFG.HIGH_SCORE);
      // 最佳分的落定也要等云端 —— 结算页被关掉了也不能让本地最佳分比榜上虚高
      if (state.bestPending) state.bestPending.cloudPending = res.cloudPending;
      cloud.submitIfRecord({
        score: r.score,
        level: rankIndexOf(r.score),
        pts: encodePts(state.points),
        sig: sig,
        guard: g,
        clientBest: (typeof state.best === 'number') ? state.best : 0,
        onSettled: function (final) { onCloudSettled(res, final); }
      });
    }
  }

  // 云端结论落地
  //
  // · 同步路径（≥95）：分数换成**云端分**（榜上的分永远是云端算出来的）
  // · 云端判无效（shadow / reject）：分数照常显示，但**不弹新纪录徽章**、
  //   本地最佳分不变、也不上报托管数据（不上榜）
  // · 云端不可达（unavailable）：**服务不可达 ≠ 作弊证据** —— 保持单机行为，
  //   本地最佳分照常更新、徽章照常弹，只是不上榜、不弹错误提示
  function onCloudSettled(res, final) {
    if (!res || !final) return;
    if (final.status === 'ok') {
      var cs = final.cloudScore;
      if (typeof cs === 'number' && Math.abs(cs - res.score) > 0.001) {
        res.score = cs;
        var rk = getRank(cs);
        res.rank = rk.rank;
        res.next = rk.next;
        res.comment = pickComment(rk.rank);
        res.layout = layoutResult(res);
      }
      res.cloudPending = false;
      // 本地最佳分用**云端分** —— 本地不能比榜上虚高
      if (state.bestPending && state.bestPending.pts === res.pts) {
        state.bestPending.score = cs;
        state.bestPending.cloudPending = false;
      }
      return;
    }
    if (final.status === 'shadow' || final.status === 'reject') {
      if (!DEV) {
        res.isNew = false;
        res.cloudPending = false;
        if (state.bestPending && state.bestPending.pts === res.pts) {
          state.bestPending = null;   // 云端判无效 → 本地最佳分不动
        }
        return;
      }
      // 开发版：云端判无效只作提示，不改本地行为（与本地 judge 的开发豁免一致）
      res.cloudPending = false;
      if (state.bestPending && state.bestPending.pts === res.pts) {
        state.bestPending.cloudPending = false;
      }
      return;
    }
    res.cloudPending = false;   // unavailable / off：保持单机行为
    // 服务不可达 → 不等云端了，按单机行为落定最佳分（只不上榜而已）
    if (state.bestPending && state.bestPending.pts === res.pts) {
      state.bestPending.cloudPending = false;
    }
  }

  /* ============================================================
   * 九、输入路由
   * ============================================================ */
  function onInput(type, px, py, isTrusted, evtTime) {
    var p = toDesign(px, py);
    var x = p.x, y = p.y;

    // 手势被系统打断（来电 / 系统手势 / 切后台）：取消当前笔迹，不评分不弹窗
    if (type === 'cancel') {
      state.pressedBtn = null;
      state.discardGesture = false;
      if (state.drawing) { state.drawing = false; state.points.length = 0; state.raw.length = 0; }
      return;
    }

    if (type === 'down') {
      if (!isTrusted) {
        // 反作弊闸门：合成事件整局丢弃
        state.discardGesture = true;
        state.drawing = false;
        state.points.length = 0;
        state.raw.length = 0;
        SIG.untrusted = true;
        showToast('检测到非真实输入');
        return;
      }
      state.discardGesture = false;
      state.btnRelease = null;

      // 顶栏图标（返回 / 声音）：优先级最高，命中后不落笔
      var icon = hitIcon(x, y);
      if (icon) {
        state.pressedBtn = { id: icon, t0: env.now() };
        return;
      }

      // 结算中：底部「再来一局」按钮（动画结束前不响应点击，避免隐形热区）
      if (state.page === 'draw' && state.result) {
        var el = env.now() - state.result.t0;
        if (el >= CFG.BUTTON_AT && hitBtn(x, y, AGAIN_BTN)) {
          state.pressedBtn = { id: 'again', t0: env.now() };
        } else if (el >= CFG.RESULT_END) {
          // 结算播完：在画面任意处落笔 = 直接开新的一笔（「再来一局」只作备用入口）
          state.result = null;
          state.points.length = 0;
          state.raw.length = 0;
          state.points.push({ x: x, y: y, t: env.now() });
          state.raw.length = 0;
          pushRaw(state.raw, evtTime, x, y);
          state.drawing = true;
        } else {
          skipResult();   // 动画中点画面 → 跳过动画，直接露出重开按钮
        }
        return;
      }
      // 主页「开画」
      if (state.page === 'home' && !state.trans && hitBtn(x, y, CFG.START_BTN)) {
        state.pressedBtn = { id: 'start', t0: env.now() };
        return;
      }
      // 主页「好友排行」
      if (state.page === 'home' && !state.trans && rankEnabled && hitBtn(x, y, CFG.RANK_BTN)) {
        state.pressedBtn = { id: 'rank', t0: env.now() };
        return;
      }
      // 好友榜页底部「返回」
      if (state.page === 'rank' && !state.trans && hitBtn(x, y, CFG.RANK_PANEL.backBtn)) {
        state.pressedBtn = { id: 'rankBack', t0: env.now() };
        return;
      }
      // 画圆页起笔
      if (state.page === 'draw' && !state.trans && !state.result) {
        state.points.length = 0;   // 只在起笔时清空
        state.raw.length = 0;
        state.points.push({ x: x, y: y, t: env.now() });
        pushRaw(state.raw, evtTime, x, y);
        state.drawing = true;
        if (!state.hintSeen) { state.hintSeen = 1; env.setStorage('hintSeen', 1); }
      }
      return;
    }

    if (type === 'move') {
      if (state.discardGesture) return;
      if (state.drawing) {
        var last = state.points[state.points.length - 1];
        // 抖动过滤：距离太近的点跳过，减少无用点
        var dx = x - last.x, dy = y - last.y;
        if (dx * dx + dy * dy < 1) return;
        state.points.push({ x: x, y: y, t: env.now() });
        pushRaw(state.raw, evtTime, x, y);
        // 超过上限则均匀抽稀（保留首尾）：视觉无损，且不像硬截断那样让长笔迹中途冻结
        if (state.points.length > CFG.MAX_POINTS) {
          var pts = state.points, keep = [pts[0]];
          for (var i = 1; i < pts.length - 1; i += 2) keep.push(pts[i]);
          keep.push(pts[pts.length - 1]);
          state.points = keep;
        }
      }
      return;
    }

    if (type === 'up') {
      // 按钮释放：按下时在同一热区内才触发
      if (state.pressedBtn) {
        var id = state.pressedBtn.id;
        state.pressedBtn = null;
        state.btnRelease = { id: id, t0: env.now() };   // 触发回弹动画
        var activated =
          (id === 'start' && hitBtn(x, y, CFG.START_BTN)) ||
          (id === 'again' && hitBtn(x, y, AGAIN_BTN)) ||
          (id === 'rank' && hitBtn(x, y, CFG.RANK_BTN)) ||
          (id === 'rankBack' && hitBtn(x, y, CFG.RANK_PANEL.backBtn)) ||
          (id === 'back' && hitIcon(x, y) === 'back');
        if (activated && id === 'start') goDraw();
        else if (activated && id === 'again') { state.result = null; state.points.length = 0; state.raw.length = 0; state.drawing = false; }
        else if (activated && id === 'rank') openLeaderboard();
        else if (activated && id === 'rankBack') closeLeaderboard();
        else if (activated && id === 'back') {
          // 好友榜页的返回箭头 = 关榜面；画圆页的返回箭头 = 回首页
          if (state.page === 'rank') closeLeaderboard();
          else goHome();
        }
        return;
      }
      if (state.discardGesture) { state.discardGesture = false; return; }
      if (state.drawing) finishStroke();
    }
  }

  env.bindInput(canvas, onInput);

  /* ============================================================
   * 十、渲染
   * ============================================================ */
  function fillText(c, text, x, y, font, color, align) {
    c.font = font;
    c.fillStyle = color;
    c.textAlign = align || 'center';
    c.textBaseline = 'middle';
    c.fillText(text, x, y);
  }

  function drawButton(c, btn, label, pressedRatio, primary) {
    var s = 1 - 0.05 * pressedRatio;  // 按下 scale 0.95
    c.save();
    c.translate(btn.x, btn.y);
    c.scale(s, s);
    var w = btn.w, h = btn.h;
    roundRect(c, -w / 2, -h / 2, w, h, h / 2);
    if (primary) {
      var g = c.createLinearGradient(0, -h / 2, 0, h / 2);
      g.addColorStop(0, COL.accent);
      g.addColorStop(1, COL.accentDark);
      c.fillStyle = g;
    } else {
      c.fillStyle = COL.btnSecondary;
    }
    c.fill();
    if (!primary) {
      c.strokeStyle = '#D8D2C4';
      c.lineWidth = 2;
      c.stroke();
    }
    fillText(c, label, 0, 2, 'bold 44px sans-serif', primary ? '#FFFFFF' : COL.ink);
    c.restore();
  }

  // 按压比例：按住 120ms 压到 1（scale 0.95），松手 170ms 回弹（末端轻微过冲 scale 1.02）
  function pressedRatio(id) {
    var now = env.now();
    if (state.pressedBtn && state.pressedBtn.id === id) {
      return clamp((now - state.pressedBtn.t0) / CFG.PRESS_MS, 0, 1);
    }
    if (state.btnRelease && state.btnRelease.id === id) {
      var t = clamp((now - state.btnRelease.t0) / CFG.PRESS_RELEASE_MS, 0, 1);
      if (t >= 1) { state.btnRelease = null; return 0; }
      return (1 - easeOutCubic(t)) - 0.4 * Math.sin(Math.PI * t) * (1 - t);
    }
    return 0;
  }

  // ---- 主页 ----
  // 开放数据域的离屏画布：懒取一次并缓存（getOpenDataContext 不便宜，且结果不变）
  var odCanvas = null;
  var odCanvasTried = 0;
  // 开放数据域是**异步**起来的：主域第一帧时它可能还没初始化完，
  // 这时 wx.getOpenDataContext().canvas 还是 null —— 早一次就永久放弃了。
  // 所以这里失败要重试（拿到 canvas 对象后就不用再取，只要等它有宽高）。
  var OD_GET_RETRY = 180;   // 最多重试 180 帧（约 3 秒），之后不再取
  var odLogState = 0;       // 0=还没结论 1=已连通 2=已放弃
  function odLog(msg) {
    try { if (typeof console !== 'undefined' && console.log) console.log('[open-data] ' + msg); } catch (e) { /* ignore */ }
  }
  function getOdCanvas() {
    if (!odCanvas && odCanvasTried < OD_GET_RETRY) {
      odCanvasTried++;
      odCanvas = env.getSharedCanvas();
    }
    return odCanvas;
  }

  // 开放数据域贴不上时画一块**明确不同**的兜底块。
  //
  // 为什么要可见："什么都没画"同时对应三种原因（通路没通 / 尺寸为 0 / 画到屏幕外）
  // ——没法判定。画出来就是二值判定：贴上了 = 通了，灰块 = 没通。
  function drawOdFallback(c, rect, title, sub) {
    var r = rect || CFG.OD_PLACEHOLDER;
    c.save();
    c.fillStyle = 'rgba(110,104,94,0.10)';
    c.fillRect(r.x, r.y, r.w, r.h);
    c.strokeStyle = 'rgba(110,104,94,0.35)';
    c.lineWidth = 2;
    c.strokeRect(r.x + 1, r.y + 1, r.w - 2, r.h - 2);
    fillText(c, title || '开放数据域未连通', r.x + r.w / 2, r.y + r.h / 2 - 12, 'bold 30px sans-serif', COL.grayText);
    if (sub) fillText(c, sub, r.x + r.w / 2, r.y + r.h / 2 + 22, '24px sans-serif', COL.grayText);
    c.restore();
  }

  // 把开放数据域画好的内容贴到主域画布的某个矩形里。
  // 按 sharedCanvas 的实际宽高比等比居中 —— 开放数据域改了尺寸也不会拉伸变形，
  // 主域也不必和它约定死尺寸（少一份会漂移的常量）。
  // @returns {boolean} 贴上了没有（false = 主域可以自己画兜底）
  function drawSharedCanvas(c, rect) {
    var sc = getOdCanvas();
    if (!sc || !sc.width || !sc.height) {
      // 没通 → 日志里留一句，断在哪一目了然
      if (odLogState === 0 && odCanvasTried >= OD_GET_RETRY) {
        odLogState = 2;
        odLog('放弃：重试 ' + odCanvasTried + ' 次仍未拿到可用的 sharedCanvas');
      }
      return false;
    }
    if (odLogState !== 1) {
      odLogState = 1;
    }
    // 共享画布是**物理像素**的，而这里的矩形是**设计坐标**（ctx 上有 view.scale 的缩放）。
    // 所以贴图尺寸（设计px）= 位图物理尺寸 / view.scale。
    //
    // ⚠️ **不要把位图缩放到位图尺寸里** —— 位图比目标小就会被放大 = 糊。
    // 真机实测过（2026-11-07）：内容发虚、卡片只有 77% 宽。
    // 现在按 1:1 物理像素贴：位图多大就画多大（清晰），再居中放进内容矩形。
    var w = sc.width / view.scale;
    var h = sc.height / view.scale;
    if (w > rect.w) { h = h * rect.w / w; w = rect.w; }   // 比内容矩形宽 → 等比缩进去（不变形）
    if (h > rect.h) { w = w * rect.h / h; h = rect.h; }
    if (odLogState === 1) {
      odLogState = 2;
      // 这几个数对不上 → 内容会被放大/裁切/错位（真机上踩过），所以记一笔
      odLog('共享画布 ' + sc.width + '×' + sc.height + '（物理px）→ 贴成设计 ' +
            Math.round(w) + '×' + Math.round(h) + '，view.scale=' + view.scale.toFixed(3) +
            '（画布=' + env.width + '×' + env.height + '）');
    }
    var x = rect.x + (rect.w - w) / 2;
    var y = rect.y + (rect.h - h) / 2;
    try {
      c.drawImage(sc, x, y, w, h);
      return true;
    } catch (e) {
      // 贴不上就当没有这一块 —— 开放数据域是可选能力，不能因此影响主玩法
      return false;
    }
  }

  function renderHome(c, alpha, dx) {
    c.save();
    c.globalAlpha = alpha;
    c.translate(dx, 0);
    // 底图
    if (imgs.home_bg) {
      c.drawImage(imgs.home_bg, 0, 0, CFG.DESIGN_W, CFG.DESIGN_H);
    } else {
      c.fillStyle = '#FDFBF6';
      c.fillRect(0, 0, CFG.DESIGN_W, CFG.DESIGN_H);
    }
    // LOGO
    if (imgs.logo_title) {
      var lw = CFG.LOGO_W, lh = lw / 2;   // 600×300 → 2:1
      c.drawImage(imgs.logo_title, (CFG.DESIGN_W - lw) / 2, CFG.LOGO_Y, lw, lh);
    } else {
      fillText(c, '谁最圆', 375, CFG.LOGO_Y + 140, 'bold 120px sans-serif', COL.ink);
    }
    // 最佳成绩
    var bestY = CFG.LOGO_Y + 320;
    if (state.best !== null) {
      var rank = getRank(state.best).rank;
      fillText(c, '最佳 ' + state.best.toFixed(1) + ' · ' + rank.name, 375, bestY, '34px sans-serif', COL.grayText);
    } else {
      fillText(c, '还没有成绩，画一个试试', 375, bestY, '34px sans-serif', COL.grayText);
    }
    // 好友榜入口（P4）：次级按钮，在「最佳成绩」与「开画」之间
    if (rankEnabled) {
      drawButton(c, CFG.RANK_BTN, '好友排行', pressedRatio('rank'), false);
    }
    // 开画按钮
    drawButton(c, CFG.START_BTN, '开 画', pressedRatio('start'), true);
    // 底部说明
    fillText(c, '画一个圆，越圆分越高', 375, CFG.DESIGN_H - CFG.SAFE_BOTTOM - 46, '32px sans-serif', COL.grayText);
    // 顶栏：声音开关
    var hIcons = iconButtons();
    for (var hi = 0; hi < hIcons.length; hi++) {
      drawIcon(c, hIcons[hi].id, hIcons[hi].x, hIcons[hi].y, CFG.ICON_SIZE);
    }
    c.restore();
  }

  // ---- 好友榜页（P4）----
  //
  // 榜面**内容**是开放数据域画的（它才读得到好友昵称/头像/分数），
  // 主域只负责：遮罩、标题、把它贴出来、关闭按钮。
  // 底部那行「我的历史最高 · 第 N 名」也在开放域里 —— 开放域 → 主域是单向的，
  // 名次算好了也传不回来。
  function renderRank(c, alpha, dx) {
    c.save();
    c.globalAlpha = alpha;
    c.translate(dx, 0);
    var L = CFG.RANK_PANEL;
    // 遮罩：上深下浅。
    // 死黑 55% 会把暖白纸底压成脏灰；渐变让卡片像"浮在暗幕上"而不是"贴在暗幕上"。
    var grad = c.createLinearGradient(0, 0, 0, CFG.DESIGN_H);
    grad.addColorStop(0, 'rgba(38,36,32,0.78)');
    grad.addColorStop(1, 'rgba(38,36,32,0.52)');
    c.fillStyle = grad;
    c.fillRect(L.mask.x, L.mask.y, L.mask.w, L.mask.h);
    // 榜面内容（标题也在卡里 —— 开放数据域画的，卡才自洽）
    if (!drawSharedCanvas(c, L.content)) {
      // 兜底：开放数据域没连上 → 标题由主域补上，别让用户对着空白发呆
      fillText(c, '好友排行', L.title.x, L.title.y, 'bold 44px sans-serif', '#FFFFFF');
      drawOdFallback(c, L.content, '还没准备好', '（开放数据域未连通）');
    }
    // 底部返回
    drawButton(c, L.backBtn, '返回', pressedRatio('rankBack'), false);
    c.restore();
  }

  // ---- 画圆页（v0.1.1：空白纸 + 笔迹，画前无引导圆；结算直接画在画布上）----
  function renderDraw(c, alpha, dx) {
    c.save();
    c.globalAlpha = alpha;
    c.translate(dx, 0);
    c.fillStyle = COL.INK_BG;
    c.fillRect(0, 0, CFG.DESIGN_W, CFG.DESIGN_H);
    // 顶部最佳
    var topY = Math.max(env.statusBarH, CFG.SAFE_TOP) + 46;
    if (state.best !== null) {
      fillText(c, '最佳 ' + state.best.toFixed(1), 375, topY, '30px sans-serif', COL.grayText);
    }
    // 笔迹：12px 圆头描边（结算后保留不消失）
    if (state.points.length > 1) {
      c.save();
      c.lineWidth = CFG.STROKE_W;
      c.lineCap = 'round';
      c.lineJoin = 'round';
      c.strokeStyle = COL.STROKE_COLOR;
      c.beginPath();
      c.moveTo(state.points[0].x, state.points[0].y);
      for (var j = 1; j < state.points.length; j++) {
        c.lineTo(state.points[j].x, state.points[j].y);
      }
      c.stroke();
      c.restore();
    } else if (state.points.length === 1) {
      c.fillStyle = COL.STROKE_COLOR;
      c.beginPath();
      c.arc(state.points[0].x, state.points[0].y, CFG.STROKE_W / 2, 0, Math.PI * 2);
      c.fill();
    }
    // 结算内容直接画在画布上（无浮层）
    if (state.result) renderResult(c);
    // 底部提示（结算后消失，位置让给「再来一局」按钮）
    else {
      var hintY = CFG.DESIGN_H - CFG.SAFE_BOTTOM - 46;
      var hintText = '一笔画个圆，松手自动评分';
      c.save();
      c.font = '32px sans-serif';
      var hw = c.measureText(hintText).width + 72;
      if (!state.hintSeen) {
        // 首次进入：白色胶囊 + 呼吸感，告诉玩家「怎么玩」
        var pulse = 0.5 + 0.5 * Math.sin((env.now() % CFG.HINT_PULSE_MS) / CFG.HINT_PULSE_MS * Math.PI * 2);
        c.globalAlpha = alpha * (0.72 + 0.28 * pulse);
        roundRect(c, 375 - hw / 2, hintY - 36, hw, 72, 36);
        c.fillStyle = 'rgba(255,255,255,0.88)';
        c.fill();
        c.globalAlpha = alpha;
      }
      fillText(c, hintText, 375, hintY, '32px sans-serif', state.hintSeen ? COL.grayText : COL.commentText);
      c.restore();
    }
    // 顶栏：返回 / 声音
    var dIcons = iconButtons();
    for (var di = 0; di < dIcons.length; di++) {
      drawIcon(c, dIcons[di].id, dIcons[di].x, dIcons[di].y, CFG.ICON_SIZE);
    }
    c.restore();
  }

  // ---- 结算（画布直绘）：标准圆虚线 + 分数/段位/评语/诊断 + 底部「再来一局」----
  var RESULT_BLOCK_H = 324;   // 结算文本块总高（分数+段位+评语）
  var CARD_TOP_OFF = -110;    // 衬底卡片相对 anchorY 的上沿
  var CARD_BOT_OFF = 214;     // 衬底卡片相对 anchorY 的下沿

  // 笔迹包围盒（结算排版避让用）
  function strokeBBox() {
    var pts = state.points;
    if (!pts || !pts.length) return null;
    var x0 = pts[0].x, y0 = pts[0].y, x1 = x0, y1 = y0;
    for (var i = 1; i < pts.length; i++) {
      var p = pts[i];
      if (p.x < x0) x0 = p.x;
      if (p.x > x1) x1 = p.x;
      if (p.y < y0) y0 = p.y;
      if (p.y > y1) y1 = p.y;
    }
    var m = CFG.STROKE_W;   // 含笔迹半宽
    return { x0: x0 - m, y0: y0 - m, x1: x1 + m, y1: y1 + m };
  }

  // 文本块与笔迹包围盒的重叠面积（px²）
  function overlapArea(bb, top, bottom) {
    if (!bb) return 0;
    var ov = Math.min(bottom, bb.y1) - Math.max(top, bb.y0);
    return ov > 0 ? ov * 600 : 0;   // 宽度按文本块固定宽度近似计
  }

  // 结算排版：在「圆下方 / 圆上方 / 底部贴边」三个候选中，选与笔迹重叠最小的，
  // 并按最长一行文本算出卡片宽度。只在结算那一刻算一次并缓存，不再每帧重算。
  function layoutResult(r) {
    var topLimit = Math.max(env.statusBarH, CFG.SAFE_TOP) + 20;   // 卡片顶边安全线
    var bottomLimit = AGAIN_BTN.y - AGAIN_BTN.h / 2 - 30;         // 卡片底边安全线
    var minY = topLimit - CARD_TOP_OFF;
    var maxY = bottomLimit - CARD_BOT_OFF;
    if (maxY < minY) maxY = minY;
    var bb = strokeBBox();
    var cands = [
      r.fit.cy + r.fit.r + 60 - CARD_TOP_OFF,  // ① 圆下方（首选）：卡片上沿距圆底 60px
      r.fit.cy - r.fit.r - 60 - CARD_BOT_OFF,  // ② 圆上方：卡片下沿距圆顶 60px
      maxY                                    // ③ 底部贴边
    ];
    var best = cands[0], bestCost = Infinity;
    for (var i = 0; i < cands.length; i++) {
      var y = clamp(cands[i], minY, maxY);
      // 代价 = 与笔迹的重叠面积；重叠完全相同时优先靠前（圆下方更符合阅读顺序）
      var cost = overlapArea(bb, y + CARD_TOP_OFF, y + CARD_BOT_OFF) + i * 0.5;
      if (cost < bestCost) { bestCost = cost; best = y; }
    }
    // 卡片宽度：取评语那一行的宽度
    ctx.font = '30px sans-serif';
    var w1 = ctx.measureText('「' + r.comment + '」').width;
    var cardW = clamp(Math.max(w1, 320) + 56, 320, 700);
    return { anchorY: best, cardW: cardW };
  }

  function renderResult(c) {
    var r = state.result;
    var el = env.now() - r.t0;
    var cxm = CFG.DESIGN_W / 2;

    // 1. 标准圆虚线（Kasa 拟合圆）：淡入 250ms，让用户直观看自己差在哪
    var fitA = clamp(el / CFG.FADE_MS, 0, 1);
    c.save();
    c.globalAlpha = fitA;
    c.strokeStyle = COL.fitCircle;
    c.lineWidth = 3;
    c.setLineDash(CFG.FIT_DASH);
    c.beginPath();
    c.arc(r.fit.cx, r.fit.cy, r.fit.r, 0, Math.PI * 2);
    c.stroke();
    c.restore();

    // 1b. 缺口可视化：没画到的那段弧用橙色虚线标出（起点实心点 / 终点空心圈）
    if (r.gap && r.gap.deg > 12) {
      c.save();
      c.globalAlpha = fitA;
      c.strokeStyle = COL.accent;
      c.lineWidth = 6;
      c.setLineDash([16, 12]);
      c.beginPath();
      c.arc(r.fit.cx, r.fit.cy, r.fit.r, r.gap.a0, r.gap.a1);
      c.stroke();
      c.restore();
    }
    if (state.points.length > 1) {
      var pStart = state.points[0];
      var pEnd = state.points[state.points.length - 1];
      c.save();
      c.globalAlpha = fitA;
      c.fillStyle = COL.ink;
      c.beginPath();
      c.arc(pStart.x, pStart.y, 9, 0, Math.PI * 2);
      c.fill();
      c.strokeStyle = COL.accent;
      c.lineWidth = 5;
      c.beginPath();
      c.arc(pEnd.x, pEnd.y, 12, 0, Math.PI * 2);
      c.stroke();
      c.restore();
    }

    // 1c. 高分细环扩散（克制版庆祝，仅 85 分以上）
    if (r.score >= CFG.RANK_HIGH_LINE && el >= CFG.ROLL_MS) {
      var pt = clamp((el - CFG.ROLL_MS) / CFG.PULSE_MS, 0, 1);
      c.save();
      c.globalAlpha = (1 - pt) * 0.32;
      c.strokeStyle = COL.accent;
      c.lineWidth = 3;
      c.beginPath();
      c.arc(r.fit.cx, r.fit.cy, r.fit.r + 14 + easeOutCubic(pt) * 48, 0, Math.PI * 2);
      c.stroke();
      c.restore();
    }

    // 2. 文本块锚点 + 衬底卡片（排版已在结算那一刻算好并缓存，不再每帧重算）
    var lay = r.layout || (r.layout = layoutResult(r));
    var anchorY = lay.anchorY;
    var cardW = lay.cardW;
    var commentText = '「' + r.comment + '」';
    c.save();
    c.globalAlpha = clamp(el / CFG.ROLL_MS, 0, 1);   // 卡片随分数滚动淡入
    c.fillStyle = COL.cardBg;
    c.strokeStyle = COL.cardLine;
    c.lineWidth = 2;
    roundRect(c, cxm - cardW / 2, anchorY + CARD_TOP_OFF, cardW, RESULT_BLOCK_H, 28);
    c.fill();
    c.stroke();
    c.restore();

    // 3. 分数大字：80px，显示一位小数（差 0.3 分就能再来一把）
    var rollP = easeOutCubic(clamp(el / CFG.ROLL_MS, 0, 1));
    fillText(c, (r.score * rollP).toFixed(1), cxm, anchorY + 10, 'bold 80px sans-serif', COL.ink);

    // 4. 段位 emoji + 名称：800ms 后弹出 350ms
    var popP = (el >= CFG.POP_DELAY_MS) ? clamp((el - CFG.POP_DELAY_MS) / CFG.POP_MS, 0, 1) : 0;
    if (popP > 0) {
      var s = 0.4 + 0.6 * popEase(popP);   // 0.4 → ~1.12 → 1
      c.save();
      c.translate(cxm, anchorY + 104);
      c.scale(s, s);
      // 自绘段位徽章 + 名称（统一手绘线条风，替代系统 emoji）
      c.font = 'bold 48px sans-serif';
      var nameW = c.measureText(r.rank.name).width;
      var startX = -(48 + 18 + nameW) / 2;
      drawRankIcon(c, r.rank.icon, startX + 24, 0, 48);
      fillText(c, r.rank.name, startX + 66, 0, 'bold 48px sans-serif', COL.ink, 'left');
      c.restore();
    }

    // 5. 评语：段位弹出后淡入上移（加深色 + 衬底，穿过笔迹也看得清）
    var fadeP = (el >= CFG.FADE_DELAY_MS) ? clamp((el - CFG.FADE_DELAY_MS) / CFG.FADE_MS, 0, 1) : 0;
    if (fadeP > 0) {
      var fy = (1 - fadeP) * 12;
      c.save();
      c.globalAlpha = fadeP;
      fillText(c, commentText, cxm, anchorY + 164 + fy, '30px sans-serif', COL.commentText);
      c.restore();
    }

    // 6. 新纪录徽章：分数上方，600ms 左右摇摆 ±6°（星星自绘，不用 emoji）
    //    cloudPending：高分路径还在等云端结论 —— 云端判无效就不该弹"新纪录"徽章
    var badgeEl = el - CFG.FADE_DELAY_MS - CFG.FADE_MS;
    if (r.isNew && !r.cloudPending && badgeEl > 0) {
      var wob = badgeEl < CFG.BADGE_MS
        ? 6 * Math.sin((badgeEl / CFG.BADGE_MS) * Math.PI * 4) * (1 - badgeEl / CFG.BADGE_MS)
        : 0;
      c.save();
      c.translate(cxm, anchorY - 80);
      c.rotate((wob * Math.PI) / 180);
      roundRect(c, -130, -28, 260, 56, 28);
      c.fillStyle = '#FFF3D6';
      c.fill();
      c.strokeStyle = '#F0C64A';
      c.lineWidth = 3;
      c.stroke();
      drawStar(c, -74, 0, 14);
      fillText(c, '新纪录！', 14, 1, 'bold 30px sans-serif', '#B8860B');
      c.restore();
    }

    // 7. 「再来一局」：820ms 出现，1060ms 完全可见（RESULT_END）
    var btnEl = CFG.BUTTON_AT;
    if (el >= btnEl) {
      var btnA = clamp((el - btnEl) / CFG.FADE_MS, 0, 1);
      c.save();
      c.globalAlpha = btnA;
      drawButton(c, AGAIN_BTN, '再来一局', pressedRatio('again'), true);
      c.restore();
    }
  }

  // ---- toast ----
  function renderToast(c) {
    if (!state.toast) return;
    var el = env.now() - state.toast.t0;
    if (el >= CFG.TOAST_MS) { state.toast = null; return; }
    var a = el < CFG.TOAST_MS * 0.75 ? 1 : 1 - (el - CFG.TOAST_MS * 0.75) / (CFG.TOAST_MS * 0.25);
    c.save();
    c.globalAlpha = a;
    c.font = '34px sans-serif';
    var w = c.measureText(state.toast.text).width + 72;
    // 画圆页：屏幕上 1/3 处（y≈541），避开顶部「最佳」与底部按钮
    // 首页：logo 占着 420..700，落在 1/3 处会盖住标题 → 挪到「开画」按钮下方
    var ty = (state.page === 'home') ? 1120 : Math.round(CFG.DESIGN_H / 3);
    roundRect(c, 375 - w / 2, ty - 46, w, 92, 46);
    c.fillStyle = 'rgba(44,44,42,0.92)';
    c.fill();
    fillText(c, state.toast.text, 375, ty, '34px sans-serif', '#FFFFFF');
    c.restore();
  }

  /* ============================================================
   * 十一、更新与主循环
   * ============================================================ */
  function update() {
    var now = env.now();
    // 页面转场
    if (state.trans) {
      if (now - state.trans.t0 >= CFG.TRANSITION_MS) {
        state.page = state.trans.to;
        state.trans = null;
      }
    }
    // 结算时间点
    if (state.result) {
      var el = now - state.result.t0;
      // 新纪录：轻微震动，给一点“破纪录”的实感（v0.3 去掉音效，只保留触觉反馈）
      // 高分路径要等云端结论（cloudPending）—— 云端判无效就不该有"破纪录"的错觉
      if (state.result.isNew && !state.result.cloudPending && !state.result.vibrated &&
          el >= 0 && hasWx && wx.vibrateShort) {
        state.result.vibrated = true;
        try { wx.vibrateShort({ type: 'light' }); } catch (e) { /* ignore */ }
      }
    }
    // 最高分落定：等"新纪录"徽章播完再改显示并写入存档（否则顶部数字先变＝剧透）
    //   · 同步路径还要等云端结论 —— 榜上的分必须是云端认可的
    //   · 结算页已经关掉（玩家直接落笔重画）时**立刻落定**，别把最佳分丢了
    if (state.bestPending !== null) {
      // cloudPending：高分路径还在等云端结论 —— **结算页被关掉了也要等**，
      //   否则本地最佳分会比榜上虚高（榜上的分必须是云端认可的）
      var canSettle = !state.bestPending.cloudPending;
      if (canSettle && state.result) {
        canSettle = (now - state.result.t0) >= CFG.FADE_DELAY_MS + CFG.FADE_MS;
      }
      if (canSettle) {
        state.best = state.bestPending.score;
        var bestPts = state.bestPending.pts || state.points || [];
        state.bestPending = null;
        try { saveBestRecord(state.best, bestPts); } catch (e) { /* ignore */ }
      }
    }
  }

  function renderPage(name, alpha, dx) {
    if (name === 'home') renderHome(ctx, alpha, dx);
    else if (name === 'rank') renderRank(ctx, alpha, dx);
    else renderDraw(ctx, alpha, dx);
  }

  function render() {
    // 留边底色
    ctx.setTransform(1, 0, 0, 1, 0, 0);
    ctx.fillStyle = CFG.LETTERBOX_BG;
    ctx.fillRect(0, 0, env.width, env.height);
    // 设计坐标系
    ctx.setTransform(view.scale, 0, 0, view.scale, view.offsetX, view.offsetY);

    var t = state.trans;
    if (t) {
      var p = easeOutCubic(clamp((env.now() - t.t0) / CFG.TRANSITION_MS, 0, 1));
      // 水平滑入 + 淡入：旧页反向滑出淡出，新页从 dir 方向滑入
      renderPage(t.from, 1 - p, -t.dir * CFG.DESIGN_W * p * 0.35);
      renderPage(t.to, p, t.dir * CFG.DESIGN_W * (1 - p));
    } else {
      renderPage(state.page, 1, 0);
    }
    // toast 画在最上层
    ctx.setTransform(view.scale, 0, 0, view.scale, view.offsetX, view.offsetY);
    renderToast(ctx);
  }

  function loop() {
    update();
    render();
    requestAnimationFrame(loop);
  }

  /* ============================================================
   * 十二、启动
   * ============================================================ */
  // 云端（P3）：建客户端 + 补传上次没传上去的 pending 队列
  //   补传放在启动时 —— 玩家刚打开游戏就把上次断网时攒下的成绩补齐，榜上才不会出现"断更"
  cloud = createCloudClient();
  if (cloud && cloud.enabled) {
    try {
      var flushP = cloud.flushPending();
      if (flushP && typeof flushP.catch === 'function') flushP.catch(function () { /* ignore */ });
    } catch (e) { /* ignore */ }
  }

  var pending = 2;
  var started = false;   // 主循环只允许启动一次（老实现图片超时后可能同时跑出两个 rAF 循环，白耗一倍算力）
  function canLoop() { return typeof requestAnimationFrame === 'function'; }
  function onLoad() {
    pending--;
    if (pending <= 0 && !started && canLoop()) { started = true; loop(); }
  }
  env.loadImage('assets/home_bg.png', function (img) { imgs.home_bg = img; onLoad(); });
  env.loadImage('assets/logo_title.png', function (img) { imgs.logo_title = img; onLoad(); });
  // 图片加载失败也能玩（代码绘制兜底），3 秒后强制启动
  setTimeout(function () {
    if (!started && canLoop()) { pending = 0; started = true; loop(); }
  }, 3000);

  // 导出纯函数：Node 下可 require 本文件，对评分引擎与防作弊模块做单元测试
  if (typeof module !== 'undefined' && module.exports) {
    module.exports = {
      evaluate: evaluate, resample: resample, kasaFit: kasaFit, refineFit: refineFit,
      winding: winding, roundScore: roundScore, closeFactor: closeFactor,
      getRank: getRank, diagnose: diagnose, upgradeTip: upgradeTip,
      guardCheck: guardCheck, shapeSig: shapeSig, isReplay: isReplay, judge: judge,
      encodePts: encodePts, decodePts: decodePts, fnv: fnv,
      largestGap: largestGap, INVALID_TIPS: INVALID_TIPS, BEST_SALT: BEST_SALT,
      resolveSharedCanvas: resolveSharedCanvas,
      createCloudClient: createCloudClient,
      // 好友榜（P4）：主域这一侧的接线（单测钩子）
      openLeaderboard: openLeaderboard,
      closeLeaderboard: closeLeaderboard,
      resendShowOnShow: resendShowOnShow,
      rankPanelLayout: rankPanelLayout,
      // 结算链路（P3）的集成测试钩子：state 是运行时状态，onCloudSettled 是云端结论落地的入口
      state: state, onCloudSettled: onCloudSettled,
      RANKS: RANKS, SCORE_CFG: SCORE_CFG, GUARD_CFG: GUARD_CFG, CFG: CFG
    };
  }

})();
