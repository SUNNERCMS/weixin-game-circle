/**
 * 《谁最圆》v0.5 — 单文件游戏逻辑
 * 双环境：微信小游戏（wx.*）+ 浏览器（DOM/Pointer Events）
 * 逻辑坐标：750×1624 设计稿，缩放交给渲染层
 * v0.5：结算卡片去掉诊断行与升级提示行，只留分数 / 段位 / 评语
 * v0.4：去掉实时反馈（边画边给分 + 笔迹三色着色），笔迹全程单色墨线
 * v0.3：移除全部音频（BGM / 音效 / 静音开关），反馈只走视觉 + 新纪录轻震动
 */
(function () {
  'use strict';

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
    MAX_POINTS: 900      // 笔迹点上限：超出后均匀抽稀，避免长笔迹被硬截断而画面冻结
  };

  /* ===== 评分配置（v0.2）=====
   * 分数 S = 圆度 R(ε) × 闭合 C(θ) × 方向 D(b)
   * 圆度用锚点表 + log 插值：想调某个分数段，只改锚点不动公式
   */
  var SCORE_CFG = {
    // 圆度锚点 [误差 ε, 分数]
    CURVE: [[0.001, 100], [0.002, 99.5], [0.003, 99], [0.005, 97], [0.01, 92], [0.02, 84],
            [0.03, 77], [0.05, 65], [0.08, 50], [0.12, 35], [0.18, 20], [0.25, 10], [0.35, 3], [0.5, 0]],
    RESAMPLE_PX: 4,        // 等弧长重采样步长：消除手速造成的加权偏差
    MIN_SAMPLES: 20,       // 重采样后最少点数
    MIN_DURATION: 200,     // 笔画最短时长 ms
    MIN_R: 60,             // 拟合半径下限（设计px）：太小判「画大一点」
    MIN_DEG: 120,          // 累计有向角下限：小于此角度判「这不是圆」
    ARC_TRAVEL_MAX: 1.2,   // 路径长度 / 拟合周长 的上限：超过说明是「乱涂」而非「一小段弧」，判低分而不是无效
    CLOSE_TOL: 5,          // 缺口 ≤5° 不扣分
    CLOSE_SPAN: 270,       // 缺口扣分的归一化跨度
    CLOSE_POW: 0.8,        // 闭合曲线幂次（<1：越接近闭合扣分越陡）
    BACK_K: 2,             // 反向转动比例 → 方向扣分系数
    DIAG_MIN_LOSS: 3       // 单项扣分 ≥3 分才显示诊断
  };

  /* ===== 防作弊阈值（v0.2）=====
   * 取值偏保守：只在风险分 ≥8 时才收紧成绩出口，不误伤真人
   */
  var GUARD_CFG = {
    DT_CV_MIN: 0.02,       // 采样间隔变异系数下限：定时器生成的间隔完全一样
    DUP_MAX: 0.2,          // 重复时间戳占比上限
    SPEED_CV_MIN: 0.06,    // 中段速度变异系数下限：匀速画圆可疑
    START_RAMP_MAX: 0.9,   // 起笔段平均速度 / 中段速度 上限（真人起笔更慢）
    END_RAMP_MAX: 0.95,
    LOWFREQ_MIN: 0.3,      // 径向残差低频能量占比下限：程序圆的误差是高频的
    ROUGH_MIN: 0.05,       // 残差二阶差分粗糙度下限：人手必有微颤
    CLOCK_DRIFT_MS: 120,   // 事件时间戳与回调真实时长的最大偏差
    HIGH_SCORE: 95,        // 高分从严：风险分 ×1.5
    REPLAY_TOL: 0.003,     // 轨迹指纹平均偏差 < 0.3%r 判为重放
    SHADOW_RISK: 10,       // ≥10 判高风险（不计入最佳）；且需 ≥2 条命中，单条弱信号不定罪
    UNVERIFIED_RISK: 5,    // ≥5 判中风险（不出分享卡）
    KEEP_HISTORY: 50,      // 本地保留最近 N 局轨迹指纹
    BEST_VERSION: 3        // 最高分存档版本号：评分算法变更即作废旧档
  };

  // 段位表（v0.2：13 档，覆盖 0～100 全区间，每档 3 条毒舌评语，随机取且不与上次重复）
  var RANKS = [
    { min: 0,  icon: 'chaos',    name: '灾难现场', comments: ['这……是圆的远房亲戚吗', '建议裱起来警示后人', '笔迹已报警'] },
    { min: 10, icon: 'noodle',   name: '一团面条', comments: ['这是意面不是圆', '线条很自由，灵魂很狂野', '圆看了想连夜改姓'] },
    { min: 20, icon: 'potato',   name: '土豆',     comments: ['土豆成精了', '地球看了都摇头', '毕加索都说看不懂'] },
    { min: 30, icon: 'dumpling', name: '饺子',     comments: ['褶子都捏出来了', '能吃，但不能滚', '离圆还隔着一锅水'] },
    { min: 40, icon: 'egg',      name: '鸡蛋',     comments: ['鸡蛋本蛋看了想报警', '在圆和椭圆之间反复横跳', '再努把力能立起来'] },
    { min: 50, icon: 'donut',    name: '甜甜圈',   comments: ['有点圆的意思了，但不多', '甜甜圈店勉强收货', '及格线在向你招手'] },
    { min: 60, icon: 'cookie',   name: '饼干',     comments: ['烤得有点歪，但能吃', '这是圆的草稿，还没定稿', '饼干模具松了'] },
    { min: 70, icon: 'tire',     name: '轮胎',     comments: ['能滚，但会颠', '跑高速没问题，过减速带悬', '轮胎店老板默默点头'] },
    { min: 80, icon: 'moon',     name: '满月',     comments: ['十五的月亮想认亲', '挂夜空里毫无违和感', '差一点点就功德圆满'] },
    { min: 87, icon: 'compass',  name: '圆规',     comments: ['你是用圆规画的吧？！', '几何老师想给你转账', '圆规本规甘拜下风'] },
    { min: 93, icon: 'book',     name: '教科书',   comments: ['可以直接进教材', '数学课本插图级', '强迫症看了都舒服'] },
    { min: 97, icon: 'scope',    name: '精密仪器', comments: ['误差肉眼不可见', '工厂质检员想挖你', '这手是数控的吧'] },
    { min: 99, icon: 'crown',    name: '神之圆',   comments: ['人类已无法企及', '公证员正在调查你', '上帝画圆也就这水平'] }
  ];

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

  /* ============================================================
   * 六、评分引擎（v0.2：等弧长重采样 → 稳定圆拟合 → 三维打分）
   * 流程：原始触点 → 等弧长重采样(4px) → 中心化 Kasa 初值 + 几何迭代修正
   *       → 累计有向角截取第一圈 → 圆度 R × 闭合 C × 方向 D
   * 纯函数、不依赖平台，可在 Node 里跑单元测试与真人数据标定。
   * ============================================================ */

  // ① 等弧长重采样：消除手速造成的加权偏差（慢的地方点密，权重被放大）
  //    注意：rx/ry 必须同步扣减已走过的部分，否则采样点会沿原向量重复推进（会往回跳）
  function resample(pts, step) {
    if (!pts || pts.length < 2) return [];
    var out = [{ x: pts[0].x, y: pts[0].y, t: pts[0].t }];
    var px = pts[0].x, py = pts[0].y, pt = pts[0].t, need = step;
    for (var i = 1; i < pts.length; i++) {
      var qx = pts[i].x, qy = pts[i].y, qt = pts[i].t;
      var rx = qx - px, ry = qy - py;          // 剩余向量
      var d = Math.sqrt(rx * rx + ry * ry);
      var segT = qt - pt;
      while (d >= need && need > 0) {
        var k = need / d;
        px += rx * k; py += ry * k;
        var nt = pt + segT * k;
        out.push({ x: px, y: py, t: nt });
        segT -= segT * k;
        rx -= rx * k; ry -= ry * k;            // 同步扣减
        d -= need;
        need = step;
        pt = nt;
      }
      need -= d;
      px = qx; py = qy; pt = qt;
    }
    return out;
  }

  // ② 中心化 Kasa 拟合：先减均值，数值稳定；共线/退化返回 null
  //    老实现用绝对阈值 1e-9 判退化，而行列式量级可达 1e15 → 阈值形同虚设，
  //    一条直线也能拟合出巨大圆、拿到比乱涂还高的分。
  function kasaFit(p) {
    var n = p.length, mx = 0, my = 0, i;
    for (i = 0; i < n; i++) { mx += p[i].x; my += p[i].y; }
    mx /= n; my /= n;
    var Suu = 0, Svv = 0, Suv = 0, Suuu = 0, Svvv = 0, Suvv = 0, Svuu = 0;
    for (i = 0; i < n; i++) {
      var u = p[i].x - mx, v = p[i].y - my;
      Suu += u * u; Svv += v * v; Suv += u * v;
      Suuu += u * u * u; Svvv += v * v * v; Suvv += u * v * v; Svuu += v * u * u;
    }
    var D = Suu * Svv - Suv * Suv;
    if (Math.abs(D) < 1e-6 * (Suu + Svv) * (Suu + Svv)) return null;
    var b1 = (Suuu + Suvv) / 2, b2 = (Svvv + Svuu) / 2;
    var uc = (b1 * Svv - b2 * Suv) / D, vc = (Suu * b2 - Suv * b1) / D;
    var r2 = uc * uc + vc * vc + (Suu + Svv) / n;
    if (r2 <= 0) return null;
    return { cx: uc + mx, cy: vc + my, r: Math.sqrt(r2) };
  }

  // ③ 几何拟合修正（Landau 迭代）：以 Kasa 为初值，最小化 Σ(d_i − r)²
  function refineFit(p, cx, cy, iters) {
    var n = p.length, mx = 0, my = 0, i, r = 0;
    for (i = 0; i < n; i++) { mx += p[i].x; my += p[i].y; }
    mx /= n; my /= n;
    for (var it = 0; it < iters; it++) {
      var sr = 0, ux = 0, uy = 0;
      for (i = 0; i < n; i++) {
        var dx = cx - p[i].x, dy = cy - p[i].y;
        var d = Math.sqrt(dx * dx + dy * dy) || 1e-6;
        sr += d; ux += dx / d; uy += dy / d;
      }
      r = sr / n;
      cx = mx + r * ux / n;
      cy = my + r * uy / n;
    }
    return { cx: cx, cy: cy, r: r };
  }

  // ④ 累计有向角：真实转过的角度、反向比例、第一圈截断位置
  //    比「方位角覆盖率」多给出方向信息：来回涂抹会被反向比例直接识别
  function winding(p, cx, cy) {
    var tot = 0, prev = Math.atan2(p[0].y - cy, p[0].x - cx);
    var ds = [], i;
    for (i = 1; i < p.length; i++) {
      var a = Math.atan2(p[i].y - cy, p[i].x - cx), d = a - prev;
      if (d > Math.PI) d -= 2 * Math.PI;
      else if (d < -Math.PI) d += 2 * Math.PI;
      ds.push(d); tot += d; prev = a;
    }
    // 反向比例用「半径向量 × 弦向量」的叉积符号判定：
    // 角度差在拟合圆心有 1px 误差时，会把 24% 的正常步长误判成反向（实测干净圆白扣 27 分）；
    // 叉积的量级是 r×弦长（≈1000），1px 圆心误差只带来 0.4% 扰动，稳健得多。
    var sg = tot >= 0 ? 1 : -1, fwd = 0, bwd = 0;
    for (i = 1; i < p.length; i++) {
      var rx = p[i].x - cx, ry = p[i].y - cy;
      var dx = p[i].x - p[i - 1].x, dy = p[i].y - p[i - 1].y;
      var cr = rx * dy - ry * dx;            // >0 → 逆时针切向
      if (cr * sg >= 0) fwd += Math.abs(cr); else bwd += Math.abs(cr);
    }
    var cum = 0, cut = p.length;
    for (i = 0; i < ds.length; i++) {
      cum += ds[i] * sg;
      if (cum >= 2 * Math.PI && cut === p.length) cut = i + 2;   // 第一圈结束
    }
    return {
      deg: Math.min(Math.abs(tot), 2 * Math.PI) * 180 / Math.PI,
      back: (fwd + bwd) > 0 ? bwd / (fwd + bwd) : 0,
      cut: cut
    };
  }

  // 圆度分：锚点表 + log 插值（误差每翻一倍，体感均匀变差 → 扣分也大致均匀）
  function roundScore(e) {
    var C = SCORE_CFG.CURVE;
    if (e <= C[0][0]) return C[0][1];
    for (var i = 1; i < C.length; i++) {
      if (e <= C[i][0]) {
        var t = Math.log(e / C[i - 1][0]) / Math.log(C[i][0] / C[i - 1][0]);
        return C[i - 1][1] + (C[i][1] - C[i - 1][1]) * t;
      }
    }
    return 0;
  }

  // 闭合因子：缺口 ≤5° 不扣分，越缺扣得越多，中间没有跳变
  function closeFactor(deg) {
    var g = Math.max(0, 360 - deg - SCORE_CFG.CLOSE_TOL);
    return Math.max(0, 1 - Math.pow(g / SCORE_CFG.CLOSE_SPAN, SCORE_CFG.CLOSE_POW));
  }

  // 覆盖缺口：相邻方位角之间的最大空隙 = 没画到的那段弧（结算页用橙色虚线标出）
  function largestGap(pts, cx, cy) {
    var n = pts.length;
    if (n < 2) return null;
    var angs = new Array(n);
    for (var i = 0; i < n; i++) angs[i] = Math.atan2(pts[i].y - cy, pts[i].x - cx);
    var srt = angs.slice(0).sort(function (p, q) { return p - q; });
    var maxGap = srt[0] + Math.PI * 2 - srt[n - 1];
    var a0 = srt[n - 1], a1 = srt[0] + Math.PI * 2;
    for (var j = 1; j < n; j++) {
      var g = srt[j] - srt[j - 1];
      if (g > maxGap) { maxGap = g; a0 = srt[j - 1]; a1 = srt[j]; }
    }
    return { a0: a0, a1: a1, deg: maxGap * 180 / Math.PI };
  }

  // ⑤ 评分主流程：返回 {valid:false, reason} 或 {valid:true, score, eps, deg, fit, loss}
  //    loss 三项加起来正好等于 100 − score，结算页可以直接写「圆度 −26.4 · 缺口 −4.2」
  var INVALID_TIPS = {
    short: '这也太敷衍了，多画一点',
    line: '这是一条线，不是圆',
    arc: '才画了一小段，画完整一圈',
    small: '画大一点，圆太小看不清'
  };

  function evaluate(points) {
    var n = points.length;
    if (n < 2) return { valid: false, reason: 'short' };
    var duration = points[n - 1].t - points[0].t;
    if (duration < SCORE_CFG.MIN_DURATION) return { valid: false, reason: 'short' };
    var p = resample(points, SCORE_CFG.RESAMPLE_PX);
    if (p.length < SCORE_CFG.MIN_SAMPLES) return { valid: false, reason: 'short' };
    var f = kasaFit(p);
    if (!f) return { valid: false, reason: 'line' };
    f = refineFit(p, f.cx, f.cy, 15);
    var w = winding(p, f.cx, f.cy);
    if (w.cut < p.length) {            // 画超一圈：只评第一圈，多画不扣分
      p = p.slice(0, w.cut);
      f = refineFit(p, f.cx, f.cy, 15);
      w = winding(p, f.cx, f.cy);
    }
    if (w.deg < SCORE_CFG.MIN_DEG) {
      // 区分两种「画得太少」：
      //  · 干净的一小段弧（路径长度 ≈ 周长）→ 判无效，让玩家重画
      //  · 画得稀烂（路径长度远超周长）→ 判有效但极低分，进「灾难现场」档，别浪费一次吐槽
      var plen = 0;
      for (var j = 1; j < p.length; j++) {
        var ex = p[j].x - p[j - 1].x, ey = p[j].y - p[j - 1].y;
        plen += Math.sqrt(ex * ex + ey * ey);
      }
      var travel = plen / (2 * Math.PI * Math.max(f.r, 1));
      if (travel < SCORE_CFG.ARC_TRAVEL_MAX) return { valid: false, reason: 'arc' };
    }
    if (f.r < SCORE_CFG.MIN_R) return { valid: false, reason: 'small' };
    var s2 = 0;
    for (var i = 0; i < p.length; i++) {
      var dx = p[i].x - f.cx, dy = p[i].y - f.cy;
      var d = Math.sqrt(dx * dx + dy * dy) - f.r;
      s2 += d * d;
    }
    var eps = Math.sqrt(s2 / p.length) / f.r;
    var R = roundScore(eps);
    var C = closeFactor(w.deg);
    var D = Math.max(0, 1 - SCORE_CFG.BACK_K * w.back);
    var S = R * C * D;
    return {
      valid: true,
      score: Math.floor(S * 10) / 10,      // 向下取整：99.96 不会显示成 100.0
      eps: eps,
      deg: w.deg,
      back: w.back,
      fit: f,
      loss: { round: 100 - R, close: R * (1 - C), dir: R * C * (1 - D) }
    };
  }

  function getRank(score) {
    var idx = 0;
    for (var i = 0; i < RANKS.length; i++) {
      if (score >= RANKS[i].min) idx = i;
    }
    return { rank: RANKS[idx], next: RANKS[idx + 1] || null };
  }

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

  // 诊断：只说扣分最多的那一项，让玩家知道下次该改什么
  function diagnose(r) {
    if (!r || !r.loss) return '';
    var L = r.loss, top = 'round';
    if (L.close > L[top]) top = 'close';
    if (L.dir > L[top]) top = 'dir';
    if (L[top] < SCORE_CFG.DIAG_MIN_LOSS) return '';
    var v = L[top].toFixed(1);
    if (top === 'close') return '缺口 ' + Math.round(360 - r.deg) + '°，扣了 ' + v + ' 分';
    if (top === 'dir') return '别来回涂，扣了 ' + v + ' 分';
    return '形状偏了，圆度扣了 ' + v + ' 分';
  }

  // 升级提示：差多少分能升一档——最能让人想再来一局
  function upgradeTip(score, next) {
    if (!next) return '';
    var g = Math.max(0, next.min - score);
    if (g <= 0) return '';
    return '距 ' + next.name + ' 还差 ' + g.toFixed(1) + ' 分';
  }

  /* ============================================================
   * 六·补、防作弊（v0.2，纯前端第一阶段）
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

  // 统计：均值 + 变异系数
  function stat(a) {
    var n = a.length, m = 0, s = 0, i;
    if (!n) return { m: 0, cv: 0 };
    for (i = 0; i < n; i++) m += a[i];
    m /= n;
    for (i = 0; i < n; i++) s += (a[i] - m) * (a[i] - m);
    return { m: m, cv: m ? Math.sqrt(s / n) / m : 0 };
  }

  // 行为特征检查：每条命中只加风险分，单条不处罚；高分从严
  function guardCheck(raw, fit, score, sig) {
    var hits = [], hard = [], n = raw.length, i, k, dts = [], sp = [], dup = 0;
    sig = sig || {};
    if (sig.untrusted) hard.push('untrusted');
    if (sig.webdriver) hard.push('webdriver');
    if (n < 6) return { hard: hard, risk: 0, hits: [] };
    for (i = 1; i < n; i++) {
      var dt = raw[i].t - raw[i - 1].t;
      if (dt < 0) { hard.push('time_reverse'); break; }
      if (dt === 0) dup++;
      else {
        dts.push(dt);
        sp.push(Math.sqrt(Math.pow(raw[i].x - raw[i - 1].x, 2) +
                          Math.pow(raw[i].y - raw[i - 1].y, 2)) / dt);
      }
    }
    // 时钟一致性：事件时间戳算出的时长 vs 回调真实经过的时长（脚本瞬间灌入骗不过）
    var evDur = raw[n - 1].t - raw[0].t, hDur = raw[n - 1].h - raw[0].h;
    if (Math.abs(evDur - hDur) > GUARD_CFG.CLOCK_DRIFT_MS) hits.push(['clock_drift', 3]);
    if (stat(dts).cv < GUARD_CFG.DT_CV_MIN) hits.push(['dt_regular', 3]);
    if (dup / (n - 1) > GUARD_CFG.DUP_MAX) hits.push(['dt_dup', 2]);
    // 速度：7 点滑动平均后看中段波动与起止段（真人起笔慢、收笔慢）
    var sm = [];
    for (i = 0; i < sp.length; i++) {
      var sv = 0, cn = 0;
      for (k = -3; k <= 3; k++) {
        var j = i + k;
        if (j >= 0 && j < sp.length) { sv += sp[j]; cn++; }
      }
      sm.push(sv / cn);
    }
    if (sm.length > 6) {
      var a = Math.floor(sm.length * 0.1), b = Math.ceil(sm.length * 0.9);
      var mid = stat(sm.slice(a, b)), w = Math.max(2, Math.floor(sm.length * 0.05));
      if (mid.cv < GUARD_CFG.SPEED_CV_MIN) hits.push(['speed_const', 3]);
      if (mid.m && stat(sm.slice(0, w)).m / mid.m > GUARD_CFG.START_RAMP_MAX) hits.push(['no_start_ramp', 1]);
      if (mid.m && stat(sm.slice(-w)).m / mid.m > GUARD_CFG.END_RAMP_MAX) hits.push(['no_end_ramp', 1]);
    }
    // 径向残差：1~4 次谐波能量占比（真人误差以低频形变为主）+ 二阶差分粗糙度（人手微颤）
    if (fit && fit.r > 0 && n >= 12) {
      var res = [], ang = [], tot = 0, low = 0, rough = 0;
      for (i = 0; i < n; i++) {
        var dx = raw[i].x - fit.cx, dy = raw[i].y - fit.cy;
        res.push(Math.sqrt(dx * dx + dy * dy) - fit.r);
        ang.push(Math.atan2(dy, dx));
        tot += res[i] * res[i];
      }
      for (k = 1; k <= 4; k++) {
        var cc = 0, ss = 0;
        for (i = 0; i < n; i++) {
          cc += res[i] * Math.cos(k * ang[i]);
          ss += res[i] * Math.sin(k * ang[i]);
        }
        low += 2 * (cc * cc + ss * ss) / n;
      }
      for (i = 1; i < n - 1; i++) {
        var d2 = res[i + 1] - 2 * res[i] + res[i - 1];
        rough += d2 * d2;
      }
      rough = Math.sqrt(rough / Math.max(1, n - 2));
      if (tot && low / tot < GUARD_CFG.LOWFREQ_MIN) hits.push(['white_noise', 1]);
      if (rough < GUARD_CFG.ROUGH_MIN) hits.push(['too_clean', 3]);
    }
    var risk = 0, names = [];
    for (i = 0; i < hits.length; i++) { risk += hits[i][1]; names.push(hits[i][0]); }
    if (score >= GUARD_CFG.HIGH_SCORE) risk *= 1.5;
    return { hard: hard, risk: risk, hits: names };
  }

  // 轨迹指纹：64 点归一化径向残差（形状签名，防重放）
  function shapeSig(points, fit) {
    if (!points || points.length < 12 || !fit || !fit.r) return null;
    var p = resample(points, 1);
    if (p.length < 8) return null;
    var out = [], step = p.length / 64;
    for (var i = 0; i < 64; i++) {
      var q = p[Math.min(p.length - 1, Math.floor(i * step))];
      var d = Math.sqrt(Math.pow(q.x - fit.cx, 2) + Math.pow(q.y - fit.cy, 2)) / fit.r - 1;
      out.push(+d.toFixed(4));
    }
    return out;
  }

  // 防重放：真人不可能两次画得几乎一样
  function isReplay(sig, history) {
    if (!sig || !history || !history.length) return false;
    for (var h = 0; h < history.length; h++) {
      var s = 0;
      for (var i = 0; i < 64; i++) s += Math.abs(sig[i] - history[h][i]);
      if (s / 64 < GUARD_CFG.REPLAY_TOL) return true;
    }
    return false;
  }

  // 最高分存档自校验：连最佳那局的原始笔迹一起存，启动时用当前引擎重算
  // 想改出一个 99 分的最高分，就得伪造出一条能拿 99 分、又能通过行为检查的笔迹
  function fnv(str) {
    var h = 0x811c9dc5;
    for (var i = 0; i < str.length; i++) {
      h ^= str.charCodeAt(i);
      h = (h * 16777619) >>> 0;
    }
    return h;
  }
  var BEST_SALT = 'yz#750#v3';

  function encodePts(pts) {
    var out = [], px = 0, py = 0, pt = 0;
    for (var i = 0; i < pts.length; i++) {
      var p = pts[i];
      out.push([Math.round((p.x - px) * 10), Math.round((p.y - py) * 10), Math.round(p.t - pt)]);
      px = p.x; py = p.y; pt = p.t;
    }
    return out;
  }

  function decodePts(arr) {
    var out = [], px = 0, py = 0, pt = 0;
    for (var i = 0; i < arr.length; i++) {
      var a = arr[i];
      px += a[0] / 10; py += a[1] / 10; pt += a[2];
      out.push({ x: px, y: py, t: pt });
    }
    return out;
  }

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

  // 处置策略：明确作弊丢弃 / 高风险不计入最佳 / 中风险仅不出分享 / 正常全开放
  // 注意：shadow 需要 ≥2 条命中同时成立 —— 单条弱信号（如"过于干净"）不足以定罪，
  // 否则正常玩家的高分会被误判为不可入榜。
  function judge(r, g, replay) {
    if (DEV) return 'ok';
    if (g.hard && g.hard.length) return 'reject';
    if (replay || (g.hits.length >= 2 && g.risk >= GUARD_CFG.SHADOW_RISK) ||
        (r.score >= 99 && g.risk > 0)) return 'shadow';
    if (g.risk >= GUARD_CFG.UNVERIFIED_RISK) return 'unverified';
    return 'ok';
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
    var verdict = judge(r, g, replay);
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
    state.result = res;
    // 最高分不立即改显示：新纪录徽章播完再落定（否则顶部数字先变、徽章后出现＝剧透）
    if (res.isNew) state.bestPending = r.score;
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
          (id === 'back' && hitIcon(x, y) === 'back');
        if (activated && id === 'start') goDraw();
        else if (activated && id === 'again') { state.result = null; state.points.length = 0; state.raw.length = 0; state.drawing = false; }
        else if (activated && id === 'back') goHome();
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
    var badgeEl = el - CFG.FADE_DELAY_MS - CFG.FADE_MS;
    if (r.isNew && badgeEl > 0) {
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
    // 屏幕上 1/3 处（y≈541），避开顶部「最佳」与底部按钮
    var ty = Math.round(CFG.DESIGN_H / 3);
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
      if (state.result.isNew && !state.result.vibrated && el >= 0 && hasWx && wx.vibrateShort) {
        state.result.vibrated = true;
        try { wx.vibrateShort({ type: 'light' }); } catch (e) { /* ignore */ }
      }
      // 最高分落定：等"新纪录"徽章播完再改显示并写入存档（否则顶部数字先变＝剧透）
      if (state.bestPending !== null && el >= CFG.FADE_DELAY_MS + CFG.FADE_MS) {
        state.best = state.bestPending;
        state.bestPending = null;
        try { saveBestRecord(state.best, state.points); } catch (e) { /* ignore */ }
      }
    }
  }

  function renderPage(name, alpha, dx) {
    if (name === 'home') renderHome(ctx, alpha, dx);
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
      RANKS: RANKS, SCORE_CFG: SCORE_CFG, GUARD_CFG: GUARD_CFG, CFG: CFG
    };
  }

})();
