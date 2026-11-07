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
    avatarR: 32,
    showAvatar: true,
    nameSize: 28,
    scoreSize: 34,
    rankSize: 26,
    colorText: '#2C2C2A',
    colorDim: '#8C8A82',
    colorSelf: '#B4643C',
    colorPanel: '#F7F5F0',
    colorLine: '#E3E0D8'
  };

  var STYLE_RANGE = {
    rowH: [60, 140],
    avatarR: [16, 48],
    nameSize: [16, 48],
    scoreSize: [16, 48],
    rankSize: [16, 48]
  };

  var COLOR_KEYS = ['colorText', 'colorDim', 'colorSelf', 'colorPanel', 'colorLine'];
  var COLOR_RE = /^#[0-9a-fA-F]{6}([0-9a-fA-F]{2})?$/;

  // 榜面几何（内容区局部坐标，设计px）
  var ROW_TOP = 20;        // 行区顶部留白
  var MAX_ROWS = 10;       // 最多画几行
  var BOTTOM_H = 96;       // 底部「我的成绩」那行的高度
  var RANK_X = 56;         // 名次右边界
  var AVATAR_X = 108;      // 头像圆心
  var NAME_X = 150;        // 昵称左边距
  var RANKNAME_X = 430;    // 段位名左边距
  var NAME_MAX_W = RANKNAME_X - NAME_X - 12;   // 昵称可用宽度
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
    var H = (typeof o.height === 'number' && o.height > 0) ? o.height : 1180;
    var st = clampStyle(o.style);
    var rankNames = o.rankNames || [];
    var avatars = o.avatarImages || {};
    var list = rows || [];
    var shown = Math.min(list.length, MAX_ROWS);
    var showRank = list.length > 1;      // 只有 1 个人时不画名次列（没对比就不占地方）

    ctx.save();
    ctx.fillStyle = st.colorPanel;
    ctx.fillRect(0, 0, W, H);

    if (!list.length) {
      ctx.fillStyle = st.colorDim;
      ctx.font = '30px sans-serif';
      ctx.textAlign = 'center';
      ctx.textBaseline = 'middle';
      ctx.fillText(o.emptyText || '还没有好友在玩', W / 2, H / 2);
      ctx.restore();
      return;
    }

    for (var i = 0; i < shown; i++) {
      var r = list[i];
      var y = ROW_TOP + i * st.rowH;
      var cy = y + st.rowH / 2;
      var isSelf = !!r.isSelf;
      var color = isSelf ? st.colorSelf : st.colorText;
      var name = isSelf ? SELF_NAME : (r.nickname || '微信用户');

      // 行分隔线
      if (i > 0) {
        ctx.fillStyle = st.colorLine;
        ctx.fillRect(24, y, W - 48, 1);
      }

      // 名次（前 1/2/3 用强调色，其余弱化）
      if (showRank) {
        ctx.fillStyle = (i < 3) ? st.colorSelf : st.colorDim;
        ctx.font = 'bold ' + st.rankSize + 'px sans-serif';
        ctx.textAlign = 'right';
        ctx.textBaseline = 'middle';
        ctx.fillText(String(r.rank || (i + 1)), RANK_X, cy);
      }

      // 头像（加载失败 / 没加载完 → 色块 + 首字兜底）
      if (st.showAvatar) {
        var img = r.openid ? avatars[r.openid] : null;
        var drawn = false;
        if (img) {
          try {
            ctx.drawImage(img, AVATAR_X - st.avatarR, cy - st.avatarR, st.avatarR * 2, st.avatarR * 2);
            drawn = true;
          } catch (e) { drawn = false; }
        }
        if (!drawn) avatarFallback(ctx, AVATAR_X, cy, st.avatarR, name.charAt(0), color);
      }

      // 昵称（按测量宽度截断）
      ctx.fillStyle = color;
      ctx.font = st.nameSize + 'px sans-serif';
      ctx.textAlign = 'left';
      ctx.textBaseline = 'middle';
      ctx.fillText(truncateText(ctx, name, NAME_MAX_W), NAME_X, cy);

      // 段位名 + 未完全验证角标
      var rname = rankNameOf(r.level, rankNames);
      ctx.fillStyle = color;
      ctx.font = st.nameSize + 'px sans-serif';
      ctx.textAlign = 'left';
      ctx.fillText(rname, RANKNAME_X, cy);
      if (r.verdict === 'unverified') {
        ctx.fillStyle = st.colorDim;
        ctx.font = '24px sans-serif';
        ctx.fillText('未完全验证', RANKNAME_X + ctx.measureText(rname).width + 8, cy);
      }

      // 分数（右对齐）
      var scoreText = (typeof r.score === 'number' && isFinite(r.score)) ? r.score.toFixed(1) : '0.0';
      ctx.fillStyle = color;
      ctx.font = 'bold ' + st.scoreSize + 'px sans-serif';
      ctx.textAlign = 'right';
      ctx.fillText(scoreText, W, cy);
    }

    // 底部一行：我的成绩（名次算好了也传不回主域，只能画在这里）
    var by = H - BOTTOM_H;
    ctx.fillStyle = st.colorLine;
    ctx.fillRect(0, by, W, 1);
    var self = null;
    for (var s = 0; s < list.length; s++) { if (list[s].isSelf) { self = list[s]; break; } }
    var left;
    if (self) {
      left = '我的历史最高 ' + self.score.toFixed(1) + ' · 第 ' + self.rank + ' 名';
    } else if (typeof o.selfScore === 'number' && isFinite(o.selfScore)) {
      left = '本地最高 ' + o.selfScore.toFixed(1) + '（未上榜）';
    } else {
      left = '你还没有上榜';
    }
    ctx.fillStyle = self ? st.colorSelf : st.colorDim;
    ctx.font = st.nameSize + 'px sans-serif';
    ctx.textAlign = 'left';
    ctx.textBaseline = 'middle';
    ctx.fillText(truncateText(ctx, left, W / 2 - 12), 24, by + BOTTOM_H / 2);

    // 放不下时说明还剩多少人
    if (list.length > MAX_ROWS) {
      ctx.fillStyle = st.colorDim;
      ctx.font = '24px sans-serif';
      ctx.textAlign = 'right';
      ctx.fillText('还有 ' + (list.length - MAX_ROWS) + ' 位好友在玩', W - 24, by + BOTTOM_H / 2);
    }

    ctx.restore();
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
    DEFAULT_STYLE: DEFAULT_STYLE,
    MAX_ROWS: MAX_ROWS
  };
});
