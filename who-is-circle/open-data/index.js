/**
 * 开放数据域 —— 入口（拉好友数据 + 画到共享画布）
 *
 * 开放数据域是一个**独立的 JS 沙盒**：
 *   - 只有它能调 wx.getFriendCloudStorage / wx.getUserCloudStorage / wx.getGroupCloudStorage
 *     （好友昵称、头像、分数这些关系链数据，主域一律读不到）
 *   - 它画出来的东西，主域只能通过 sharedCanvas 看到 —— 不能把对象传回去
 *
 * 沙盒限制（踩过就记住）：
 *   - 不能 require **主域**模块（主域 ↔ 开放域互相 require 是平台禁止的；
 *     但**同目录内**可以 require，所以纯逻辑拆到了 ./board.js）
 *   - 不能发网络请求（无 wx.request）
 *   - 远程图片只能加载**微信 CDN** 的（好友头像是的 ✓），失败必须有兜底
 *
 * 与主域的通信是**单向**的：主域 postMessage 过来，这边 wx.onMessage 收。
 * 所以「我的名次」算好了也传不回主域 —— 底部那行只能画在这里。
 *
 * 本文件只碰 wx API 与画布；纯逻辑在 ./board.js。
 */
(function (root, factory) {
  var api = factory(function () {
    // 同目录 require（平台允许）；失败就退到全局（万一加载方式变了还能活）
    try {
      if (typeof module === 'object' && module && module.exports && typeof require === 'function') {
        return require('./board.js');
      }
    } catch (e) { /* 落到 root.Board */ }
    return (root && root.Board) || null;
  });
  if (typeof module === 'object' && module && module.exports) module.exports = api;
  if (root) root.OpenData = api;
  // 开放数据域一加载就注册消息通道（主域随时可能 postMessage）
  if (api && typeof api.bootstrap === 'function') api.bootstrap();
})(typeof GameGlobal !== 'undefined' ? GameGlobal
   : (typeof globalThis !== 'undefined' ? globalThis
   : (typeof window !== 'undefined' ? window : null)), function (loadBoard) {
  'use strict';

  var Board = loadBoard();

  // 运行时状态（模块级：消息驱动它）
  var state = {
    msg: null,        // 收到的 showLeaderboard 消息
    rows: [],         // 拉到的行（已排序、已带名次）
    error: '',        // 拉取失败的原因（空 = 没失败）
    loading: false,   // 正在拉
    avatars: {}       // openid → 已加载的头像图片
  };

  function getWx() {
    return (typeof wx !== 'undefined' && wx) ? wx : null;
  }

  // 开放数据域的诊断日志（真机调试时看得到）
  function odLog(m) {
    try { if (typeof console !== 'undefined' && console.log) console.log('[open-data] ' + m); } catch (e) { /* ignore */ }
  }

  function getDpr(w) {
    try {
      if (w && typeof w.getSystemInfoSync === 'function') {
        var info = w.getSystemInfoSync();
        if (info && info.pixelRatio) return info.pixelRatio;
      }
    } catch (e) { /* 拿不到就用 1 */ }
    return 1;
  }

  /** 注册主域 → 开放域的消息通道 */
  function bootstrap() {
    var w = getWx();
    if (!w || typeof w.onMessage !== 'function') return false;
    w.onMessage(handleMessage);
    return true;
  }

  /**
   * 处理主域消息。
   * showLeaderboard → 记下参数 → 画「加载中」→ 拉数据 → 画榜
   * hideLeaderboard → 停止（不再拉、不再画）
   */
  function handleMessage(msg) {
    if (!msg || typeof msg !== 'object') return;
    if (msg.type === 'showLeaderboard') {
      state.msg = msg;
      state.rows = [];
      state.error = '';
      state.loading = true;
      state.avatars = {};
      renderNow();
      pull(getWx(), msg.key || 'circle').then(function (res) {
        state.rows = res.rows || [];
        state.error = res.error || '';
        state.loading = false;
        renderNow();
        loadAvatars(getWx(), state.rows);
      }, function () {
        state.rows = [];
        state.error = '读不到好友数据';
        state.loading = false;
        renderNow();
      });
    } else if (msg.type === 'hideLeaderboard') {
      state.msg = null;
      state.rows = [];
      state.error = '';
      state.loading = false;
    }
  }

  /**
   * 拉好友数据 + 自己的数据 → 归一化 → 排序。
   * 好友失败不牵连自己，自己失败不牵连好友（各自独立兜底）。
   * @returns {Promise<{rows: Array, error: string}>}
   */
  function pull(wxApi, key) {
    var w = wxApi || getWx();
    var k = key || 'circle';
    if (!w) return Promise.resolve({ rows: [], error: '没有微信环境' });

    var friendsP = new Promise(function (resolve) {
      if (typeof w.getFriendCloudStorage !== 'function') { resolve([]); return; }
      try {
        w.getFriendCloudStorage({
          keyList: [k],
          success: function (res) { resolve((res && res.data) || []); },
          fail: function () { resolve(null); }        // null = 失败（与「空列表」区分开）
        });
      } catch (e) { resolve(null); }
    });

    var selfP = new Promise(function (resolve) {
      if (typeof w.getUserCloudStorage !== 'function') { resolve([]); return; }
      try {
        w.getUserCloudStorage({
          keyList: [k],
          success: function (res) { resolve((res && res.data) || []); },
          fail: function () { resolve(null); }
        });
      } catch (e) { resolve(null); }
    });

    return Promise.all([friendsP, selfP]).then(function (pair) {
      var friendData = pair[0];
      var selfData = pair[1];
      var error = (friendData === null) ? '读不到好友数据' : '';

      var rows = [];
      var list = friendData || [];
      for (var i = 0; i < list.length; i++) {
        var row = Board ? Board.normalizeFriendEntry(list[i], k) : null;
        if (row) rows.push(row);      // 解析不出来 → 跳过，不占名次
      }
      var selfRow = null;
      var sList = selfData || [];
      for (var j = 0; j < sList.length; j++) {
        var sr = Board ? Board.normalizeSelfEntry(sList[j], k) : null;
        if (sr) { selfRow = sr; break; }
      }
      var merged = Board ? Board.mergeRows(rows, selfRow) : [];
      return { rows: merged, error: error };
    });
  }

  /** 加载好友头像（失败就不画图，走兜底色块 + 首字） */
  function loadAvatars(w, rows) {
    if (!w || typeof w.createImage !== 'function') return;
    var list = rows || [];
    for (var i = 0; i < list.length; i++) loadAvatar(w, list[i]);
  }

  function loadAvatar(w, r) {
    if (!r || !r.openid || !r.avatarUrl) return;
    if (state.avatars[r.openid]) return;
    var img = null;
    try { img = w.createImage(); } catch (e) { return; }
    if (!img) return;
    img.onload = function () {
      state.avatars[r.openid] = img;
      renderNow();               // 头像好了重画一次
    };
    img.onerror = function () {
      // 加载失败 → 不重画、不崩，drawBoard 会走兜底（色块 + 昵称首字）
    };
    try { img.src = r.avatarUrl; } catch (e) { /* 忽略 */ }
  }

  /**
   * 画到共享画布。
   * @param {object} wxApi  wx API（测试里注入假实现）
   * @param {object} s      {msg, rows, error, loading}
   */
  function render(wxApi, s) {
    var w = wxApi || getWx();
    var st = s || state;
    if (!w || typeof w.getSharedCanvas !== 'function') return;

    var canvas = null;
    try { canvas = w.getSharedCanvas(); } catch (e) { return; }
    if (!canvas) return;
    var ctx = null;
    try { ctx = canvas.getContext('2d'); } catch (e) { return; }
    if (!ctx) return;

    var msg = st.msg || {};
    var width = (typeof msg.width === 'number' && msg.width > 0) ? msg.width : 0;
    var height = (typeof msg.height === 'number' && msg.height > 0) ? msg.height : 0;
    if (!width || !height) return;       // 还没收到消息 → 画布先空着

    var dpr = (typeof msg.scale === 'number' && msg.scale > 0) ? msg.scale : getDpr(w);
    // 画布尺寸必须在画之前定好 —— 改 canvas.width/height 会把画布清空。
    // 而卡高要跟着行数走（1 个人的榜不该是张空卡），所以先问 board 要高度。
    var boardH = height;
    try {
      if (Board && typeof Board.boardHeight === 'function') {
        boardH = Board.boardHeight(st.rows || [], {
          width: width, height: height, style: msg.style
        });
      }
    } catch (e) { /* 算不出来就用传进来的高度 */ }

    // 平台可能对共享画布的尺寸做上限（真机上见过被裁的：内容被放大三倍、卡片右边被切掉）。
    // 所以设完尺寸**读回实际值**，不一致就按比例把内容缩回去 ——
    // 宁可内容小一点（略糊），也不能让内容被裁掉或错位。
    var wantW = Math.round(width * dpr);
    var wantH = Math.round(boardH * dpr);
    var k = 1;
    try {
      canvas.width = wantW;
      canvas.height = wantH;
      var realW = canvas.width, realH = canvas.height;
      if (realW > 0 && wantW > 0 && realW !== wantW) k = realW / wantW;
      if (realH > 0 && wantH > 0 && Math.abs(realH - wantH) > 1) k = Math.min(k, realH / wantH);
      ctx.setTransform(dpr * k, 0, 0, dpr * k, 0, 0);
      if (realW !== wantW || realH !== wantH) {
        odLog('画布被平台裁剪：期望 ' + wantW + '×' + wantH + ' 实际 ' + realW + '×' + realH +
              ' → 内容按 ' + k.toFixed(3) + ' 缩放补偿');
      }
    } catch (e) { /* 画布不可写就到此为止 */ }

    // board.js 没加载上（require 失败）→ 画一句人话，别留一片空白
    if (!Board) {
      try {
        ctx.fillStyle = '#F7F5F0';
        ctx.fillRect(0, 0, width, height);
        ctx.fillStyle = '#8C8A82';
        ctx.font = '30px sans-serif';
        ctx.textAlign = 'center';
        ctx.textBaseline = 'middle';
        ctx.fillText('榜面模块加载失败', width / 2, height / 2);
      } catch (e) { /* ignore */ }
      return;
    }

    var opts = {
      width: width,
      height: height,
      style: msg.style,
      rankNames: msg.rankNames || [],
      avatarImages: state.avatars,
      selfScore: msg.selfScore,
      emptyText: '还没有好友在玩'
    };

    if (st.error) {
      opts.emptyText = '暂时读不到好友数据';   // 不空白
      Board.drawBoard(ctx, [], opts);
      return;
    }
    if (st.loading) {
      opts.emptyText = '正在读取好友榜…';
      Board.drawBoard(ctx, [], opts);
      return;
    }
    Board.drawBoard(ctx, st.rows || [], opts);
  }

  function renderNow() {
    render(getWx(), state);
  }

  return {
    bootstrap: bootstrap,
    handleMessage: handleMessage,
    pull: pull,
    render: render,
    state: state
  };
});
