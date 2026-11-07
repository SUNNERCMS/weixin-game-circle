/**
 * 主域榜单桥接（P4）
 *
 * 开放数据域是独立沙盒：它读得到好友数据，但**读不到主域的任何东西**，
 * 而且主域 → 开放域是单向的（postMessage 过去，回不来）。
 * 所以「主域要给开放域什么」必须在这里集中组装 —— 开放域那边只管画。
 *
 * 这一层刻意只做纯函数（不碰 wx）：
 *   - buildStyleParams()  样式参数（D9：样式单一来源在主域）
 *   - resolveRankNames()  段位名表（开放域不能 require 主域的 scoring.js，
 *                          自己复制一份必然漂移 → 主域算好发过去）
 *   - buildShowMessage()  组装 showLeaderboard 消息
 *   - buildHideMessage()  组装 hideLeaderboard 消息
 *   - classifyPrivacy()   隐私设置取值 → 三态
 *
 * 没有 wx 依赖 → 单测不需要微信环境。
 */
(function (root, factory) {
  var api = factory();
  if (typeof module === 'object' && module && module.exports) module.exports = api;
  if (root) root.Leaderboard = api;
})(typeof GameGlobal !== 'undefined' ? GameGlobal
   : (typeof globalThis !== 'undefined' ? globalThis
   : (typeof window !== 'undefined' ? window : null)), function () {
  'use strict';

  // 托管数据的 key（≤8 字符全英文，与云开发后台排行榜配置一致）
  var DEFAULT_KEY = 'circle';
  // 内容矩形（设计px）与缺省像素比
  var DEFAULT_WIDTH = 700;
  var DEFAULT_HEIGHT = 1180;
  var DEFAULT_SCALE = 1;   // 兜底：没有主域上下文时按 1:1 画

  // 样式参数 —— 设计文档 §6.4 钉死的值。
  // 为什么放在主域：开放域是独立沙盒，改样式要改一处（D9）。
  var STYLE_TEMPLATE = {
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
    colorBadge: '#D95F28',   // 前三名名次徽章（沿用主按钮的橙）
    colorSelfBg: '#F6E7DA',  // 自己的那行淡底
    colorPillBg: '#EDE9E0'   // 段位名胶囊底
  };

  /**
   * 样式参数（每次返回新对象 —— 免得主域改了返回值污染后面的消息）。
   */
  function buildStyleParams() {
    var out = {};
    for (var k in STYLE_TEMPLATE) {
      if (Object.prototype.hasOwnProperty.call(STYLE_TEMPLATE, k)) out[k] = STYLE_TEMPLATE[k];
    }
    return out;
  }

  /**
   * 段位表 → 段位名数组（开放域靠 level 索引取名）。
   * @param {Array} ranks  Scoring.RANKS
   */
  function resolveRankNames(ranks) {
    if (!ranks || !ranks.length) return [];
    var out = [];
    for (var i = 0; i < ranks.length; i++) {
      var r = ranks[i];
      out.push(r && typeof r.name === 'string' ? r.name : '');
    }
    return out;
  }

  /**
   * 组装 showLeaderboard 消息。
   * 缺参数一律用默认值 —— 主域漏传一个字段不该让整个榜面挂掉。
   */
  function buildShowMessage(opts) {
    var o = (opts && typeof opts === 'object') ? opts : {};
    var names = o.rankNames;
    if (!names || !names.length) names = [];
    var style = (o.style && typeof o.style === 'object') ? buildStyleParamsFrom(o.style) : buildStyleParams();
    return {
      type: 'showLeaderboard',
      key: (typeof o.key === 'string' && o.key) ? o.key : DEFAULT_KEY,
      selfScore: (typeof o.selfScore === 'number' && isFinite(o.selfScore)) ? o.selfScore : null,
      selfLevel: (typeof o.selfLevel === 'number' && isFinite(o.selfLevel)) ? o.selfLevel : null,
      width: (typeof o.width === 'number' && o.width > 0) ? o.width : DEFAULT_WIDTH,
      height: (typeof o.height === 'number' && o.height > 0) ? o.height : DEFAULT_HEIGHT,
      // scale = 主域的「物理像素 / 设计像素」比例（view.scale）
      // ⚠️ 不是设备像素比 —— 共享画布是物理像素的，密度必须跟主域的缩放一致，
      // 否则内容会被放大/裁切（真机上踩过：文字放大三倍、卡片右边被切掉）
      scale: (typeof o.scale === 'number' && o.scale > 0) ? o.scale : DEFAULT_SCALE,
      rankNames: names.slice(),
      style: style
    };
  }

  // 主域给过来的样式 → 以模板为准的副本（开放域还会再钳一次，两道防线）
  function buildStyleParamsFrom(style) {
    var out = buildStyleParams();
    for (var k in out) {
      if (Object.prototype.hasOwnProperty.call(style, k) && style[k] !== undefined) {
        out[k] = style[k];
      }
    }
    return out;
  }

  function buildHideMessage() {
    return { type: 'hideLeaderboard' };
  }

  /**
   * 隐私设置取值 → 三态。
   *   true      已授权 → 直接拉数据
   *   false     曾拒绝 → 只能引导去设置页手动打开（wx.openSetting）
   *   undefined 还没决定 → 先 wx.authorize，失败再 wx.openSetting
   * 非布尔值一律当「还没决定」（不猜）。
   */
  function classifyPrivacy(authValue) {
    if (authValue === true) return 'granted';
    if (authValue === false) return 'denied';
    return 'unset';
  }

  return {
    buildStyleParams: buildStyleParams,
    resolveRankNames: resolveRankNames,
    buildShowMessage: buildShowMessage,
    buildHideMessage: buildHideMessage,
    classifyPrivacy: classifyPrivacy,
    DEFAULT_KEY: DEFAULT_KEY,
    DEFAULT_WIDTH: DEFAULT_WIDTH,
    DEFAULT_HEIGHT: DEFAULT_HEIGHT,
    DEFAULT_SCALE: DEFAULT_SCALE
  };
});
