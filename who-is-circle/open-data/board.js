/**
 * 开放数据域 —— 榜面纯逻辑（解析 / 归一化 / 排序 / 名次 / 截断 / 绘制）
 *
 * 为什么要单独成文件：
 *   开放数据域是**独立沙盒**，主域 require 不到它、它也 require 不到主域
 *   （平台限制：主域 ↔ 开放域不能互相 require，但**同目录内可以**）。
 *   如果把解析 / 排序 / 截断 / 绘制全塞在 index.js 里，这些逻辑就只能靠真机验 ——
 *   回归套件护不住，改一次就可能悄悄弄坏排序。
 *   所以纯逻辑拆到这里（UMD），Node 里用假 ctx 直接断言绘制调用。
 *
 * 本文件**不碰任何 wx API**：只吃数据、只画到传进来的 ctx。
 * wx 的活（拉数据、创建图片、拿共享画布）在 index.js。
 *
 * 托管数据格式（P3.5 定案）：
 *   { wxgame: { score: 真实分×10, update_time: Unix秒 }, level: 段位索引, v: 'ok'|'unverified' }
 */
(function (root, factory) {
  var api = factory();
  if (typeof module === 'object' && module && module.exports) module.exports = api;
  if (root) root.Board = api;
})(typeof GameGlobal !== 'undefined' ? GameGlobal
   : (typeof globalThis !== 'undefined' ? globalThis
   : (typeof window !== 'undefined' ? window : null)), function () {
  'use strict';

  // ---- 常量 ----

  // 样式默认值与取值区间（主域传错 → 钳到这里，别让整张榜歪掉）
  var DEFAULT_STYLE = {
    rowH: 96,
    avatarR: 26,
    showAvatar: true,
    nameSize: 28,
    scoreSize: 34,
    rankSize: 26,
    colorText: '#2C2C2A',
    colorDim: '#8C8A82',
    colorSelf: '#B4643C',
    colorPanel: '#F7F5F0',
    colorLine: '#E3E0D8',
    colorBadge: '#D95F28',   // 前三名的名次徽章（沿用主按钮的橙）
    colorSelfBg: '#F6E7DA',  // 自己的那行淡底
    colorPillBg: '#EDE9E0'   // 段位名胶囊的底
  };

  var STYLE_RANGE = {
    rowH: [60, 140],
    avatarR: [16, 48],
    nameSize: [16, 48],
    scoreSize: [16, 48],
    rankSize: [16, 48]
  };

  var COLOR_KEYS = ['colorText', 'colorDim', 'colorSelf', 'colorPanel', 'colorLine',
    'colorBadge', 'colorSelfBg', 'colorPillBg'];
  var COLOR_RE = /^#[0-9a-fA-F]{6}([0-9a-fA-F]{2})?$/;

  // 榜面几何（卡内局部坐标，设计px）
  //
  // 布局线框（卡 700×1180）：
  //   ┌──────────────────────────────────────────┐
  //   │ 好友排行                    9 位好友在玩 │ ← 标题区（卡内自洽，不飘在遮罩上）
  //   ├──────────────────────────────────────────┤
  //   │ ① 头像 昵称                     98.6     │ ← 名次徽章 / 头像 / 昵称 / 分数
  //   │        [精密仪器]                         │ ← 段位名胶囊（第二行，不与分数抢位）
  //   ├──────────────────────────────────────────┤
  //   │ 我的历史最高 79.2 · 第 10 名   还有 2 位 │ ← 底部
  //   └──────────────────────────────────────────┘
  var CARD_R = 32;         // 卡片圆角
  var TITLE_H = 104;       // 卡内标题区高度
  var ROW_TOP = TITLE_H;   // 行区顶部
  var MAX_ROWS = 10;       // 最多画几行
  var BOTTOM_H = 88;       // 底部「我的成绩」区高度
  var PAD = 28;            // 左右内边距
  var BADGE_X = 50;        // 名次徽章圆心
  var AVATAR_X = 108;      // 头像圆心
  var NAME_X = 150;        // 昵称 / 段位名左边距
  var SCORE_X = 672;       // 分数右对齐位置（700 - PAD）
  var SCORE_W = 104;       // 分数列预留宽度
  var PILL_H = 28;         // 胶囊高度
  var EMPTY_H = 520;       // 空态时的卡片高度（够放下空心圆 + 两行文案）

  // ---- 「整屏页」布局 ----
  //
  // 为什么要有这一套：共享画布**就是屏幕**（真机实测 402×874 逻辑px = 屏幕逻辑尺寸）。
  // 在屏幕里再放一张「卡片」，卡片只占位图的 1/3 宽度 → 剩下的必须放大回去 → 糊。
  // 所以整屏都画上：每个像素都用上，文字按屏幕原生分辨率画 → 清晰。
  //
  // 也顺手解决「到底是弹窗还是页面」：去掉暗遮罩与浮空卡片，它就是一个**页面**。
  var PAGE = {
    pad: 40,             // 左右留白
    titleY: 200,         // 标题基线（避开右上角微信胶囊）
    titleSize: 40,
    subSize: 24,
    ruleY: 252,          // 标题下的分隔线
    rowTop: 290,         // 行区顶部
    rowH: 108,           // 行高（**上限**；实际按页面高度自适应，见 pageLayout）
    badgeX: 66,          // 名次徽章圆心
    avatarX: 136,        // 头像圆心
    nameX: 186,          // 昵称 / 段位名左边距
    scoreX: 710,         // 分数右对齐
    bottomGap: 90,       // 「我的成绩」那行 + 分隔线
    buttonGap: 140       // 底部「返回」按钮预留（主域画，榜面要给它留位）
  };

  /**
   * 整屏页的布局（按**实际页面高度**算，不写死）。
   *
   * 为什么不能写死：榜面页的高度 = 屏幕比例换算出来的设计px，
   * 16:9 的手机（iPhone SE / 老安卓）只有 **1334** 设计px，
   * 而 10 行 × 108 + 标题 + 底部要 1450+ ⇒ **最后几行会被切掉**。
   *
   * 所以行高按可用高度自适应（108 是上限，不够就压缩），
   * 底部还要给主域画的「返回」按钮留位（按钮不是榜面的一部分）。
   */
  function pageLayout(pageH) {
    var avail = pageH - PAGE.rowTop - PAGE.bottomGap - PAGE.buttonGap;
    var rowH = Math.max(72, Math.min(PAGE.rowH, Math.floor(avail / MAX_ROWS)));
    var rowsBottom = PAGE.rowTop + MAX_ROWS * rowH;
    return {
      rowTop: PAGE.rowTop,
      rowH: rowH,
      rowsBottom: rowsBottom,
      bottomY: rowsBottom + 30          // 「我的成绩」那行的基线
    };
  }
  var SELF_NAME = '我';    // 开放域拿不到自己的昵称 —— 我们知道那是我，就画「我」

  // ---- 托管数据解析 ----

  /**
   * 解析托管数据的 value 字符串。
   * @param {string} value  wx.setUserCloudStorage 写进去的 JSON 字符串
   * @returns {{score:number, level:number, verdict:string}|null}
   */
  function parseHostingValue(value) {
    if (typeof value !== 'string' || !value) return null;
    var obj;
    try { obj = JSON.parse(value); } catch (e) { return null; }
    if (!obj || typeof obj !== 'object') return null;
    var g = obj.wxgame;
    if (!g || typeof g !== 'object') return null;
    var raw = g.score;
    if (typeof raw !== 'number' || !isFinite(raw) || raw < 0) return null;
    var level = (typeof obj.level === 'number' && isFinite(obj.level)) ? obj.level : 0;
    // v 缺失 = P3.5 之前写的旧数据 → 当有效成绩，别当「未完全验证」
    var verdict = (obj.v === 'unverified') ? 'unverified' : 'ok';
    return { score: raw / 10, level: level, verdict: verdict };
  }

  // 从 wx.getFriendCloudStorage / wx.getUserCloudStorage 的一个元素里找到托管数据
  function findKv(entry, key) {
    if (!entry || typeof entry !== 'object') return null;
    var list = entry.KVDataList;
    if (!list || !list.length) return null;
    for (var i = 0; i < list.length; i++) {
      var kv = list[i];
      if (kv && kv.key === key) return kv;
    }
    return null;
  }

  function makeRow(entry, key, isSelf) {
    var kv = findKv(entry, key);
    if (!kv) return null;
    var parsed = parseHostingValue(kv.value);
    if (!parsed) return null;          // 解析失败 → 跳过这一行（不占名次）
    return {
      openid: (!isSelf && typeof entry.openid === 'string') ? entry.openid : '',
      nickname: (typeof entry.nickname === 'string') ? entry.nickname : '',
      avatarUrl: (typeof entry.avatarUrl === 'string') ? entry.avatarUrl : '',
      score: parsed.score,
      level: parsed.level,
      verdict: parsed.verdict,
      isSelf: !!isSelf,
      raw: kv.value                  // 原文：用来判「这是不是同一个人」（见 mergeRows）
    };
  }

  function normalizeFriendEntry(entry, key) { return makeRow(entry, key, false); }
  function normalizeSelfEntry(entry, key) { return makeRow(entry, key, true); }

  function copyRow(r) {
    var out = {};
    for (var k in r) { if (Object.prototype.hasOwnProperty.call(r, k)) out[k] = r[k]; }
    return out;
  }

  /**
   * 合并好友与自己 → 排序 → 给每行名次。
   *
   * 去重两层：
   *   1. 同一个 openid 出现多次 → 只留分高的那条（同一个好友多条托管数据）
   *   2. 某行与自己的托管数据**原文完全相同** → 视为同一人，丢掉好友那行
   *      （平台保证好友列表不含自己；但万一混进来，榜上出现两个自己是很难看的 bug。
   *       判据用原文而不是分数 —— 两个人的分完全相同很正常，但
   *       「同样的分 + 同样的段位 + 同样的 update_time（秒级）」几乎只可能是同一次写入）
   */
  function mergeRows(friendRows, selfRow) {
    var src = friendRows || [];
    var byOpenid = {};      // openid → 在 list 里的下标
    var list = [];
    for (var i = 0; i < src.length; i++) {
      var r = src[i];
      if (!r) continue;
      if (r.openid) {
        var idx = byOpenid[r.openid];
        if (idx !== undefined) {
          // 同一个 openid 又来一条 → 只留分高的（位置不动，保持输入顺序稳定）
          if (r.score > list[idx].score) list[idx] = r;
          continue;
        }
        byOpenid[r.openid] = list.length;
      }
      list.push(r);
    }
    if (selfRow) {
      var kept = [];
      for (var j = 0; j < list.length; j++) {
        if (selfRow.raw && list[j].raw === selfRow.raw) continue;   // 同一个人
        kept.push(list[j]);
      }
      list = kept;
      list.push(selfRow);
    }
    // 排序：分降序；同分按输入顺序（稳定）
    var indexed = [];
    for (var m = 0; m < list.length; m++) indexed.push({ r: list[m], i: m });
    indexed.sort(function (a, b) {
      if (b.r.score !== a.r.score) return b.r.score - a.r.score;
      return a.i - b.i;
    });
    var out = [];
    for (var k = 0; k < indexed.length; k++) {
      var row = copyRow(indexed[k].r);
      row.rank = k + 1;
      out.push(row);
    }
    return out;
  }

  // ---- 文本 / 段位名 / 样式 ----

  /** 按测量宽度截断（不是按字数 —— emoji 和汉字宽度差 2 倍） */
  function truncateText(ctx, text, maxWidth) {
    var s = (text === undefined || text === null) ? '' : String(text);
    if (!s) return '';
    if (!(maxWidth > 0)) return '';
    if (!ctx || typeof ctx.measureText !== 'function') return s;
    if (ctx.measureText(s).width <= maxWidth) return s;
    var ell = '…';
    var budget = maxWidth - ctx.measureText(ell).width;
    if (budget <= 0) return ell;
    var out = '';
    for (var i = 0; i < s.length; i++) {
      var next = out + s.charAt(i);
      if (ctx.measureText(next).width > budget) break;
      out = next;
    }
    return out + ell;
  }

  /** 段位索引 → 段位名（越界/没表 → 兜底，别把 undefined 画到榜上） */
  function rankNameOf(level, rankNames) {
    if (!rankNames || !rankNames.length) return '段位 ?';
    var i = (typeof level === 'number' && isFinite(level)) ? Math.floor(level) : -1;
    if (i < 0 || i >= rankNames.length) return '段位 ?';
    return rankNames[i] || '段位 ?';
  }

  /** 样式参数钳制：缺失/越界 → 默认值（主域传错不能把整张榜弄歪） */
  function clampStyle(style) {
    var s = (style && typeof style === 'object') ? style : {};
    var out = {};
    for (var k in STYLE_RANGE) {
      if (!Object.prototype.hasOwnProperty.call(STYLE_RANGE, k)) continue;
      var v = s[k];
      if (typeof v !== 'number' || !isFinite(v) || v <= 0) {
        out[k] = DEFAULT_STYLE[k];                       // 没给 / 不是数 / 非正 → 默认
      } else {
        var rng = STYLE_RANGE[k];
        v = Math.round(v);
        if (v < rng[0]) v = rng[0];
        if (v > rng[1]) v = rng[1];
        out[k] = v;
      }
    }
    out.showAvatar = (typeof s.showAvatar === 'boolean') ? s.showAvatar : DEFAULT_STYLE.showAvatar;
    for (var c = 0; c < COLOR_KEYS.length; c++) {
      var ck = COLOR_KEYS[c];
      var cv = s[ck];
      out[ck] = (typeof cv === 'string' && COLOR_RE.test(cv)) ? cv : DEFAULT_STYLE[ck];
    }
    return out;
  }

  // ---- 绘制 ----

  function avatarFallback(ctx, x, y, r, ch, color) {
    ctx.fillStyle = DEFAULT_STYLE.colorLine;
    ctx.beginPath();
    ctx.arc(x, y, r, 0, Math.PI * 2);
    ctx.fill();
    ctx.fillStyle = color;
    ctx.font = 'bold ' + Math.round(r * 0.9) + 'px sans-serif';
    ctx.textAlign = 'center';
    ctx.textBaseline = 'middle';
    ctx.fillText(ch, x, y);
  }

  // ---- 绘制小工具 ----

  /** 圆角矩形（用 arc 拼，避免依赖 arcTo 的实现差异） */
  function roundRect(ctx, x, y, w, h, r) {
    var rr = Math.min(r, w / 2, h / 2);
    ctx.beginPath();
    ctx.moveTo(x + rr, y);
    ctx.lineTo(x + w - rr, y);
    ctx.arc(x + w - rr, y + rr, rr, -Math.PI / 2, 0);
    ctx.lineTo(x + w, y + h - rr);
    ctx.arc(x + w - rr, y + h - rr, rr, 0, Math.PI / 2);
    ctx.lineTo(x + rr, y + h);
    ctx.arc(x + rr, y + h - rr, rr, Math.PI / 2, Math.PI);
    ctx.lineTo(x, y + rr);
    ctx.arc(x + rr, y + rr, rr, Math.PI, Math.PI * 1.5);
    ctx.closePath();
  }

  /**
   * 胶囊标签（段位名 / 未完全验证）。
   * 用胶囊而不是裸文字 —— 裸文字和昵称、分数混在一起会分不清主次。
   * @returns {number} 实际占的宽度（便于排下一个标签）
   */
  function drawPill(ctx, x, y, text, opts) {
    var o = opts || {};
    var h = o.h || PILL_H;
    var font = o.font || '22px sans-serif';
    ctx.font = font;
    var maxW = o.maxW || 0;
    var w = ctx.measureText(text).width + h * 0.8;
    if (maxW && w > maxW) {
      text = truncateText(ctx, text, maxW - h * 0.8);
      w = ctx.measureText(text).width + h * 0.8;
    }
    ctx.fillStyle = o.bg || DEFAULT_STYLE.colorPillBg;
    roundRect(ctx, x, y, w, h, h / 2);
    ctx.fill();
    ctx.fillStyle = o.fg || DEFAULT_STYLE.colorText;
    ctx.textAlign = 'center';
    ctx.textBaseline = 'middle';
    ctx.fillText(text, x + w / 2, y + h / 2);
    return w;
  }

  /* ---- 颜色 ---- */

  /** #rrggbb → [r,g,b]（认不出来就返回 null） */
  function hexToRgb(h) {
    if (typeof h !== 'string') return null;
    var m = /^#?([0-9a-f]{6})$/i.exec(h.trim());
    if (!m) return null;
    var n = parseInt(m[1], 16);
    return [(n >> 16) & 255, (n >> 8) & 255, n & 255];
  }

  /**
   * 两个颜色之间线性插值（t: 0=a, 1=b）。
   * 返回 #rrggbb —— 与输入同形，t=0 时**原样返回**（不换格式，免得样式表看着花）。
   */
  function mixHex(a, b, t) {
    var ca = hexToRgb(a), cb = hexToRgb(b);
    if (!ca || !cb) return a;
    var k = (typeof t === 'number' && isFinite(t)) ? Math.max(0, Math.min(1, t)) : 0;
    var r = Math.round(ca[0] + (cb[0] - ca[0]) * k);
    var g = Math.round(ca[1] + (cb[1] - ca[1]) * k);
    var bl = Math.round(ca[2] + (cb[2] - ca[2]) * k);
    return '#' + ((1 << 24) + (r << 16) + (g << 8) + bl).toString(16).slice(1).toUpperCase();
  }

  /**
   * 段位胶囊的底色：**随段位变深**。
   *
   * 为什么：13 个段位如果全用同一个底色，玩家看不出「满月」比「轮胎」高一档 ——
   * 榜上高低差一档却长得一模一样，等于没有段位。
   * 用**同一色相**（暖橙）由浅到深 ⇒ 一眼看出高低，又不引入新的颜色体系。
   *
   * 上限 0.55：再深就压不住深色文字了（#2C2C2A 在最深处仍有 6:1 以上的对比度）。
   */
  function rankPillBg(level, rankNames, st) {
    var n = (rankNames && rankNames.length) ? rankNames.length : 13;
    var lv = (typeof level === 'number' && isFinite(level) && level >= 0) ? level : 0;
    var t = Math.max(0, Math.min(1, lv / (n - 1)));
    return mixHex(st.colorPillBg, st.colorBadge, t * 0.55);
  }

  /**
   * 不在榜上时，说明「本地最高分为什么没上榜」。
   *
   * 主域把最近一局的云端结论带过来（lastVerdict / lastReason，设计文档 §6.4）。
   * 没有结论就说「暂未上榜」—— 不编原因。
   */
  function offBoardReason(ctx, o) {
    var v = o.lastVerdict || '';
    var r = String(o.lastReason || '').trim();
    if (v === 'shadow') return '成绩未获认可';
    if (v === 'reject') {
      // 云端的 reason 形如「提交过于频繁，请稍后再试」→ 只取第一个分句
      var head = r.split(/[，,;；]/)[0];
      return head ? truncateText(ctx, head, 200) : '成绩未获认可';
    }
    if (v === 'unavailable' || v === 'off') return '云端未达，暂未上榜';
    return '暂未上榜';
  }

  /**
   * 名次徽章：前三名实心圆徽章（暖橙，沿用主按钮的色），其余弱化成数字。
   * 只换数字颜色不够 —— 前三名要有个能被一眼扫到的形状。
   */
  function drawRankBadge(ctx, n, cx, cy, st, showRank) {
    if (!showRank) return;
    if (n <= 3) {
      ctx.fillStyle = st.colorBadge;
      ctx.beginPath();
      ctx.arc(cx, cy, 20, 0, Math.PI * 2);
      ctx.fill();
      ctx.fillStyle = '#FFFFFF';
      ctx.font = 'bold 24px sans-serif';
      ctx.textAlign = 'center';
      ctx.textBaseline = 'middle';
      ctx.fillText(String(n), cx, cy);
    } else {
      ctx.fillStyle = st.colorDim;
      ctx.font = st.rankSize + 'px sans-serif';
      ctx.textAlign = 'right';
      ctx.textBaseline = 'middle';
      ctx.fillText(String(n), cx + 20, cy);
    }
  }

  /**
   * 行数与卡高的一次性计算（纯函数）。
   *
   * 为什么要单独抽出来：**共享画布的尺寸必须在画之前定** ——
   * 改 canvas.width/height 会把画布清空，所以顺序只能是
   * 「先算高度 → 建画布 → 画」。而卡高要跟着行数走（1 个人的榜不该是张空卡），
   * 于是这个"算高度"的逻辑必须能被主域（index.js）先拿到。
   *
   * @returns {{rowH:number, maxRows:number, shown:number, H:number}}
   */
  function rowPlan(list, opts) {
    var o = (opts && typeof opts === 'object') ? opts : {};
    var maxH = (typeof o.height === 'number' && o.height > 0) ? o.height : 1180;
    var st = clampStyle(o.style);
    var arr = list || [];
    var rowH = st.rowH;
    if (!arr.length) return { rowH: rowH, maxRows: 0, shown: 0, H: EMPTY_H };
    var maxRows = Math.min(MAX_ROWS, Math.max(1, Math.floor((maxH - TITLE_H - BOTTOM_H) / rowH)));
    var shown = Math.min(arr.length, maxRows);
    return { rowH: rowH, maxRows: maxRows, shown: shown, H: TITLE_H + shown * rowH + BOTTOM_H };
  }

  /** 卡面高度（主域建画布前先问它） */
  function boardHeight(list, opts) {
    return rowPlan(list, opts).H;
  }

  /**
   * 画整张榜。
   * @param {object} ctx   画布上下文（共享画布的 2d context）
   * @param {Array}  rows  已排序、已带 rank 的行
   * @param {object} opts  {width,height,style,rankNames,avatarImages,selfScore,emptyText}
   */
  function drawBoard(ctx, rows, opts) {
    if (!ctx) return;
    var o = (opts && typeof opts === 'object') ? opts : {};
    var W = (typeof o.width === 'number' && o.width > 0) ? o.width : 700;
    var st = clampStyle(o.style);
    var rankNames = o.rankNames || [];
    var avatars = o.avatarImages || {};
    var list = rows || [];
    var isPage = !!o.page;      // 整屏页 vs 卡片

    var selfRow = null;
    for (var s = 0; s < list.length; s++) { if (list[s].isSelf) { selfRow = list[s]; break; } }

    // ---- 高度 ----
    // 整屏页：高度 = 屏幕的设计高度（开放域给的 pageH）
    // 卡片：高度跟着行数走（1 个人的榜不该是张空卡）
    var plan = rowPlan(list, o);
    var pageH = (typeof o.pageH === 'number' && o.pageH > 0) ? o.pageH : 1624;
    var pl = isPage ? pageLayout(pageH) : null;
    var rowH = isPage ? pl.rowH : plan.rowH;
    var maxRows = isPage ? MAX_ROWS : plan.maxRows;
    var shown = Math.min(list.length, maxRows);
    var H = isPage ? pageH
                   : ((typeof o.boardH === 'number' && o.boardH > 0) ? o.boardH : plan.H);

    // ---- 布局参数（两套布局共用同一套绘制代码）----
    var L = isPage ? {
      pad: PAGE.pad, titleY: PAGE.titleY, titleSize: PAGE.titleSize,
      subSize: PAGE.subSize, ruleY: PAGE.ruleY,
      rowTop: pl.rowTop, rowH: pl.rowH, badgeX: PAGE.badgeX, avatarX: PAGE.avatarX,
      nameX: PAGE.nameX, scoreX: PAGE.scoreX, bottomY: pl.bottomY
    } : {
      pad: PAD, titleY: TITLE_H / 2, titleSize: 34, subSize: 24, ruleY: TITLE_H - 1,
      rowTop: ROW_TOP, rowH: rowH, badgeX: BADGE_X, avatarX: AVATAR_X,
      nameX: NAME_X, scoreX: SCORE_X, bottomY: H - BOTTOM_H / 2
    };

    ctx.save();

    // ---- 背景 ----
    if (isPage) {
      // 整屏页：满屏纸底，不要遮罩、不要圆角卡片 —— 它就是一个页面
      ctx.fillStyle = st.colorPanel;
      ctx.fillRect(0, 0, W, H);
    } else {
      // 卡片：圆角 + 极轻的投影 + 一圈描边
      // 一块直角矩形贴在暗幕上会像贴纸；圆角 + 投影才有"一张纸"的实体感。
      ctx.save();
      ctx.shadowColor = 'rgba(44,44,42,0.16)';
      ctx.shadowBlur = 24;
      ctx.shadowOffsetY = 8;
      ctx.fillStyle = st.colorPanel;
      roundRect(ctx, 0, 0, W, H, CARD_R);
      ctx.fill();
      ctx.restore();
      ctx.strokeStyle = st.colorLine;
      ctx.lineWidth = 1;
      roundRect(ctx, 0.5, 0.5, W - 1, H - 1, CARD_R);
      ctx.stroke();
    }

    // ---- 标题区 ----
    ctx.fillStyle = st.colorText;
    ctx.font = 'bold ' + L.titleSize + 'px sans-serif';
    ctx.textAlign = 'left';
    ctx.textBaseline = 'middle';
    ctx.fillText('好友排行', L.pad, L.titleY);

    var friends = list.length - (selfRow ? 1 : 0);
    ctx.fillStyle = st.colorDim;
    ctx.font = L.subSize + 'px sans-serif';
    ctx.textAlign = 'right';
    ctx.fillText(friends > 0 ? (friends + ' 位好友在玩') : '暂无好友', L.scoreX, L.titleY);

    ctx.fillStyle = st.colorLine;
    ctx.fillRect(L.pad, L.ruleY, W - L.pad * 2, 1);

    // ---- 空态：画一个空心圆（呼应"画圆"这件事），不是一行灰字 ----
    if (!list.length) {
      // 空态：画一个空心圆（呼应"画圆"这件事），不是一行灰字
      var ecx = W / 2;
      var ecy = isPage ? (L.rowTop + L.bottomY) / 2 - 50 : H / 2 - 60;
      ctx.strokeStyle = st.colorLine;
      ctx.lineWidth = 3;
      ctx.beginPath();
      ctx.arc(ecx, ecy, 54, 0, Math.PI * 2);
      ctx.stroke();
      ctx.fillStyle = st.colorText;
      ctx.font = '32px sans-serif';
      ctx.textAlign = 'center';
      ctx.textBaseline = 'middle';
      ctx.fillText(o.emptyText || '还没有好友在玩', ecx, ecy + 106);
      ctx.fillStyle = st.colorDim;
      ctx.font = '24px sans-serif';
      ctx.fillText('叫上朋友，一起画圆吧', ecx, ecy + 152);
      ctx.restore();
      return;
    }

    // ---- 行区 ----
    var showRank = list.length > 1;      // 只有 1 个人时不画名次列（没对比就不占地方）
    var nameMaxW = L.scoreX - SCORE_W - L.nameX - 12;

    for (var i = 0; i < shown; i++) {
      var r = list[i];
      var y = L.rowTop + i * rowH;
      var cy = y + rowH / 2;
      var isSelf = !!r.isSelf;
      var color = isSelf ? st.colorSelf : st.colorText;
      var name = isSelf ? SELF_NAME : (r.nickname || '微信用户');

      // 自己的行：淡底 + 左侧竖条（只换字色，扫一眼找不着自己）
      if (isSelf) {
        ctx.fillStyle = st.colorSelfBg;
        ctx.fillRect(L.pad - 12, y, W - L.pad + 12, rowH);
        ctx.fillStyle = st.colorSelf;
        ctx.fillRect(L.pad - 12, y + 6, 4, rowH - 12);
      }

      // 行分隔线（自己的行有底色，不用再画线）
      if (i > 0 && !isSelf) {
        ctx.fillStyle = st.colorLine;
        ctx.fillRect(L.pad, y, W - L.pad * 2, 1);
      }

      // 名次徽章
      drawRankBadge(ctx, r.rank || (i + 1), L.badgeX, cy, st, showRank);

      // 头像（加载失败 / 没加载完 → 色块 + 首字兜底）
      if (st.showAvatar) {
        var img = r.openid ? avatars[r.openid] : null;
        var drawn = false;
        if (img) {
          try {
            ctx.save();
            ctx.beginPath();
            ctx.arc(L.avatarX, cy, st.avatarR, 0, Math.PI * 2);
            ctx.clip();
            ctx.drawImage(img, L.avatarX - st.avatarR, cy - st.avatarR, st.avatarR * 2, st.avatarR * 2);
            ctx.restore();
            drawn = true;
          } catch (e) { drawn = false; }
        }
        if (!drawn) avatarFallback(ctx, L.avatarX, cy, st.avatarR, name.charAt(0), color);
        drawAvatarRing(ctx, L.avatarX, cy, st.avatarR);
      }

      // 昵称（第一行；按测量宽度截断，绝不撞到分数列）
      ctx.fillStyle = color;
      ctx.font = st.nameSize + 'px sans-serif';
      ctx.textAlign = 'left';
      ctx.textBaseline = 'middle';
      ctx.fillText(truncateText(ctx, name, nameMaxW), L.nameX, cy - 14);

      // 段位名胶囊 + 未完全验证胶囊（放第二行 —— 跟昵称挤在一行会压到分数上）
      var rname = rankNameOf(r.level, rankNames);
      var px = L.nameX;
      var py = cy + 6;
      if (rname) {
        px += drawPill(ctx, px, py, rname, {
          h: PILL_H, bg: rankPillBg(r.level, rankNames, st), fg: st.colorText,
          font: '22px sans-serif', maxW: 240
        }) + 8;
      }
      if (r.verdict === 'unverified') {
        drawPill(ctx, px, py, '未完全验证', {
          h: PILL_H, bg: st.colorSelfBg, fg: st.colorSelf,
          font: '20px sans-serif', maxW: 150
        });
      }

      // 分数（右对齐，与昵称同一水平线 —— 它是这行的主角）
      var scoreText = (typeof r.score === 'number' && isFinite(r.score)) ? r.score.toFixed(1) : '0.0';
      ctx.fillStyle = color;
      ctx.font = 'bold ' + st.scoreSize + 'px sans-serif';
      ctx.textAlign = 'right';
      ctx.textBaseline = 'middle';
      ctx.fillText(scoreText, L.scoreX, cy - 14);
    }

    // ---- 底部：我的成绩（名次算好了也传不回主域，只能画在这里）----
    // 整屏页：分隔线画在**名单的底部**（不是固定位置，否则会压到最后一行）
    var by = isPage ? (L.rowTop + shown * rowH) : (H - BOTTOM_H);
    ctx.fillStyle = st.colorLine;
    ctx.fillRect(L.pad, by, W - L.pad * 2, 1);
    var left;
    if (selfRow) {
      left = '我的历史最高 ' + selfRow.score.toFixed(1) + ' · 第 ' + selfRow.rank + ' 名';
    } else if (typeof o.selfScore === 'number' && isFinite(o.selfScore) && o.selfScore > 0) {
      // 不在榜上但有本地最高分 → **说清楚为什么**，别让人以为功能坏了
      // （真机现象：本地 76.3 却显示「未上榜」，而榜上第一名才 67.1 —— 看不出所以然）
      left = '本地最高 ' + o.selfScore.toFixed(1) + ' · ' + offBoardReason(ctx, o);
    } else {
      left = '你还没有上榜';
    }
    ctx.fillStyle = selfRow ? st.colorSelf : st.colorDim;
    ctx.font = '26px sans-serif';
    ctx.textAlign = 'left';
    ctx.textBaseline = 'middle';
    ctx.fillText(truncateText(ctx, left, W * 0.56), L.pad, by + BOTTOM_H / 2);

    // 诊断行（开发期用）：没有真机调试时，截图就能看出「为什么没认出我」
    if (o.debugLine) {
      ctx.fillStyle = st.colorDim;
      ctx.font = '20px monospace';
      ctx.textAlign = 'left';
      ctx.textBaseline = 'middle';
      ctx.fillText(o.debugLine, L.pad, by + BOTTOM_H / 2 + 30);
    }

    // 放不下时说明还剩多少人
    if (list.length > maxRows) {
      ctx.fillStyle = st.colorDim;
      ctx.font = '24px sans-serif';
      ctx.textAlign = 'right';
      ctx.fillText('还有 ' + (list.length - maxRows) + ' 位好友在玩', L.scoreX, by + BOTTOM_H / 2);
    }

    ctx.restore();
  }

  /** 头像外圈白边（把头像和纸底分开） */
  function drawAvatarRing(ctx, x, y, r) {
    ctx.strokeStyle = '#FFFFFF';
    ctx.lineWidth = 3;
    ctx.beginPath();
    ctx.arc(x, y, r + 1, 0, Math.PI * 2);
    ctx.stroke();
  }

  return {
    parseHostingValue: parseHostingValue,
    normalizeFriendEntry: normalizeFriendEntry,
    normalizeSelfEntry: normalizeSelfEntry,
    mergeRows: mergeRows,
    truncateText: truncateText,
    rankNameOf: rankNameOf,
    clampStyle: clampStyle,
    drawBoard: drawBoard,
    rowPlan: rowPlan,
    boardHeight: boardHeight,
    pageLayout: pageLayout,
    // 段位胶囊的配色（导出是为了能直接断言 —— 画到画布上的底色不好从假 ctx 里读）
    rankPillBg: rankPillBg,
    mixHex: mixHex,
    DEFAULT_STYLE: DEFAULT_STYLE,
    MAX_ROWS: MAX_ROWS
  };
});
