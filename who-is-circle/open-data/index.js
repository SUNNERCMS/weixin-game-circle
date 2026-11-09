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
    avatars: {},      // openid → 已加载的头像图片
    diag: ''          // 开发期诊断信息（画在榜面上，截图就能看）
  };

  function getWx() {
    return (typeof wx !== 'undefined' && wx) ? wx : null;
  }

  // ---- 自己的 openid ----
  //
  // 为什么需要（真机现象 2026-11-07）：榜上**能看到自己**（78.3 ✓ 托管数据是对的），
  // 但底部写「本地最高 78.3（未上榜）」——
  // 说明开放域**没认出哪一行是自己** ⇒ 那一行没有 isSelf ⇒ 底部只能退回本地分。
  //
  // 根因：`wx.getUserCloudStorage`（读自己的托管数据）没返回数据，
  // 而**平台的好友列表里把自己也列进去了** ⇒ 那行被当成了普通好友。
  //
  // 解法：开放数据域里 `wx.getUserInfo` 能拿到自己的 openId ⇒
  // 好友列表里凡是它，就是我 ⇒ 标上 isSelf ✓
  // （比现在「按托管数据原文比对」稳得多 —— 原文比对在自读失败时完全失效）
  var myOpenid = '';
  function fetchMyOpenid(w) {
    if (myOpenid) return Promise.resolve(myOpenid);
    return new Promise(function (resolve) {
      if (!w || typeof w.getUserInfo !== 'function') { resolve(''); return; }
      try {
        w.getUserInfo({
          success: function (res) {
            myOpenid = (res && (res.openId || res.openid)) || '';
            if (myOpenid) odLog('自己的 openid 已取到');
            resolve(myOpenid);
          },
          fail: function (e) {
            odLog('getUserInfo 失败：' + ((e && e.errMsg) || '未知'));
            resolve('');
          }
        });
      } catch (e) { resolve(''); }
    });
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
  // ---- 关系链数据的缓存 ----
  //
  // 真机现象（2026-11-07）：第一次打开好友榜能读到数据，**返回后再打开就提示
  // 「暂时读不到好友数据」** —— 第二次 wx.getFriendCloudStorage 调用失败了
  // （关系链接口有调用频率/配额限制）。
  //
  // 所以：缓存最近一次成功的结果。
  //   · TTL 内再打开 → 直接用缓存，**不重复调接口**（省配额，也就不会再失败）
  //   · 拉取失败但有缓存 → **回退到缓存**（有旧数据总比"读不到"好）
  //
  // 缓存 20 秒：足够覆盖"返回→再打开"，又短到不会让自己的分数显得过时。
  var cache = { rows: [], at: 0, selfScore: null, diag: '' };
  var CACHE_TTL = 20000;

  function handleMessage(msg) {
    if (!msg || typeof msg !== 'object') return;
    if (msg.type === 'showLeaderboard') {
      state.msg = msg;
      state.error = '';
      var now = Date.now();
      var selfScore = (typeof msg.selfScore === 'number') ? msg.selfScore : null;
      // 缓存失效的两个条件：
      //   ① 超过 TTL（好友数据会变，比如对方刚破纪录）
      //   ② **自己的分数变了**（刚打完一局 → 必须显示新分，不能拿缓存里的旧分）
      var cacheFresh = cache.rows.length &&
        now - cache.at < CACHE_TTL &&
        cache.selfScore === selfScore;
      if (cacheFresh) {
        // 缓存还新鲜 → 直接用，**不重复调关系链接口**（它有调用频率限制）
        state.rows = cache.rows;
        state.loading = false;
        // ⚠️ 诊断也要跟着换 —— 否则会留着上一次的诊断，
        //    出现「榜上 2 行、诊断写好友0」这种自相矛盾（真机截图里出现过）。
        state.diag = (cache.diag || '') + ' 缓存';
        renderNow();
        return;
      }
      state.rows = [];
      state.loading = true;
      // 头像不清：avatarUrl 是稳定的，复用已加载的图，省一次网络请求
      renderNow();
      pull(getWx(), msg.key || 'circle', msg).then(function (res) {
        var rows = res.rows || [];
        var err = res.error || '';
        var diag = res.diag || '';
        if (err && cache.rows.length) {
          // 拉取失败但有缓存 → 回退到缓存（比"读不到"好得多）
          odLog('拉取失败，回退到缓存：' + err);
          rows = cache.rows;
          err = '';
          // 诊断换成缓存那份 —— 诊断必须描述**最终画出来的那份数据**
          diag = (cache.diag || '') + ' 回退缓存';
        }
        state.rows = rows;
        state.error = err;
        // ⚠️ 数据定稿之后才写诊断（见 buildDiag 的注释）
        state.diag = diag;
        state.loading = false;
        if (!err && rows.length) {
          cache.rows = rows;
          cache.at = now;
          cache.selfScore = selfScore;
          cache.diag = diag;
        }
        renderNow();
        loadAvatars(getWx(), state.rows);
      }, function () {
        state.rows = cache.rows || [];
        state.error = state.rows.length ? '' : '读不到好友数据';
        state.diag = (cache.diag || '') + ' 回退缓存';
        state.loading = false;
        renderNow();
      });
    } else if (msg.type === 'hideLeaderboard') {
      state.msg = null;
      state.rows = [];
      state.error = '';
      state.loading = false;
      // ⚠️ **缓存不清** —— 关榜不该让下次打开读不到数据
    }
  }

  /**
   * 拉好友数据 + 自己的数据 → 归一化 → 排序。
   * 好友失败不牵连自己，自己失败不牵连好友（各自独立兜底）。
   *
   * @param {object} wxApi  wx API
   * @param {string} key    托管数据的 key
   * @param {object} opts   主域发来的 showLeaderboard 消息（认「我」的判据都在里面）
   * @returns {Promise<{rows: Array, error: string, diag: string}>}
   */
  function pull(wxApi, key, opts) {
    var w = wxApi || getWx();
    var k = key || 'circle';
    var o = (opts && typeof opts === 'object') ? opts : {};
    var myRaw = (typeof o.selfRaw === 'string') ? o.selfRaw : '';
    // 主域确认过的「托管数据里我的分与段位」（= 我在榜上那一行的内容）
    var hostedOk = !!o.selfHosted;
    var hostedScore = (typeof o.selfHostedScore === 'number' && isFinite(o.selfHostedScore)) ? o.selfHostedScore : null;
    var hostedLevel = (typeof o.selfHostedLevel === 'number' && isFinite(o.selfHostedLevel)) ? o.selfHostedLevel : null;
    if (!w) return Promise.resolve({ rows: [], error: '没有微信环境', diag: '无微信环境' });

    var friendsP = new Promise(function (resolve) {
      if (typeof w.getFriendCloudStorage !== 'function') { resolve([]); return; }
      try {
        w.getFriendCloudStorage({
          keyList: [k],
          success: function (res) { resolve((res && res.data) || []); },
          fail: function (e) {                          // null = 失败（与「空列表」区分开）
            odLog('getFriendCloudStorage 失败：' + ((e && e.errMsg) || '未知'));
            resolve(null);
          }
        });
      } catch (e) { resolve(null); }
    });

    var selfP = new Promise(function (resolve) {
      if (typeof w.getUserCloudStorage !== 'function') { resolve([]); return; }
      try {
        w.getUserCloudStorage({
          keyList: [k],
          success: function (res) { resolve((res && res.data) || []); },
          fail: function (e) {
            odLog('getUserCloudStorage 失败：' + ((e && e.errMsg) || '未知'));
            resolve(null);
          }
        });
      } catch (e) { resolve(null); }
    });

    // 先拿自己的 openid —— 好友列表里**平台会把自己也列进去**，
    // 认出它才能标上 isSelf（否则底部会误判「未上榜」）
    return fetchMyOpenid(w).then(function () {
      return Promise.all([friendsP, selfP]);
    }).then(function (pair) {
      var friendData = pair[0];
      var selfData = pair[1];
      var error = (friendData === null) ? '读不到好友数据' : '';

      // ---- 认「我」：四条路，前三条断了还有第四条 ----
      //
      //   ① openid 相等       （getUserInfo 拿 openId —— 可能失败）
      //   ② 托管数据原文相等  （主域知道自己写出去的那串 JSON）
      //   ③ 自读              （getUserCloudStorage —— 可能返回空）
      //   ④ 分数+段位**唯一匹配**（主域确认托管数据写成功过 ⇒ 我的行一定在列表里）
      //
      // 真机上 ① 和 ③ **同时失败**过（截图：榜上有我的 78.3，底部却说「未上榜」），
      // ② 又依赖本地存过原文（老设备没有）⇒ ④ 是最后一道防线。
      var rows = [];
      var list = friendData || [];
      var selfFound = null;      // 在好友列表里认出的「我」那一行
      var claimedBy = '';
      for (var i = 0; i < list.length; i++) {
        var row = Board ? Board.normalizeFriendEntry(list[i], k) : null;
        if (!row) continue;           // 解析不出来 → 跳过，不占名次
        // ① 好友列表里遇到自己（openid 相等）→ 摘出去，下面统一当 selfRow 处理
        if (!selfFound && myOpenid && row.openid === myOpenid) {
          row.isSelf = true;
          selfFound = row;
          claimedBy = 'openid';
          continue;
        }
        rows.push(row);
      }
      // ② 兜底：openid 认不出时，用**托管数据原文**认
      //    （主域写出去的那串 JSON 与好友列表里我那一行的原文完全相同）
      if (!selfFound && myRaw) {
        for (var m = 0; m < rows.length; m++) {
          if (rows[m].raw && rows[m].raw === myRaw) {
            rows[m].isSelf = true;
            selfFound = rows[m];
            rows.splice(m, 1);
            claimedBy = '原文';
            break;
          }
        }
      }
      // ④ 再兜底：openid 与原文都拿不到时，用**分数 + 段位唯一匹配**认
      //
      //    判据为什么可靠：主域确认「托管数据写成功过」⇒ 我的那一行**一定在**好友列表里
      //    ⇒ 列表中「分数与段位都等于我」的行**恰好只有一行**时，那行必然是我。
      //    若真有第二个同分同段位的好友 ⇒ 匹配数是 2 ⇒ **认不出**（宁可认不出，也不认错人）。
      //
      //    分数要留容差：托管数据里存的是「分×10」的整数，榜上读到的是它 ÷10，
      //    与本地记的全精度分可能有 1e-9 级的差。
      if (!selfFound && hostedOk && hostedScore !== null && hostedLevel !== null) {
        var hits = [];
        for (var q = 0; q < rows.length; q++) {
          if (Math.abs(rows[q].score - hostedScore) < 0.05 && rows[q].level === hostedLevel) {
            hits.push(rows[q]);
          }
        }
        if (hits.length === 1) {
          hits[0].isSelf = true;
          selfFound = hits[0];
          rows.splice(rows.indexOf(hits[0]), 1);
          claimedBy = '唯一';
        } else if (hits.length > 1) {
          odLog('分数+段位匹配到 ' + hits.length + ' 行 → 认不出（不乱认人）');
        }
      }

      // ③ 自读自己的那一行
      var selfRow = null;
      var sList = selfData || [];
      for (var j = 0; j < sList.length; j++) {
        var sr = Board ? Board.normalizeSelfEntry(sList[j], k) : null;
        if (sr) { selfRow = sr; break; }
      }
      if (!selfRow) {
        // 自读失败 → 用好友列表里认出的那一行（自读失败时，它就是「我」的唯一证据）
        if (selfFound) { selfRow = selfFound; }
        else { claimedBy = claimedBy || '不出'; }
      }
      if (selfRow && !claimedBy) claimedBy = '自读';

      var inFriends = !!selfFound;
      odLog('好友 ' + rows.length + ' 行（自己' + (inFriends ? '在列表里' : '不在列表里') +
            '），自读 ' + ((selfData && selfData.length) ? selfData.length + ' 行' : '空') +
            '，认领方式 ' + claimedBy);

      var merged = Board ? Board.mergeRows(rows, selfRow) : [];
      // 诊断信息**画在榜面上**（不是只进日志）——
      // 没有真机调试时日志看不到，但截图能看（2026-11-07 的教训：每次都靠日志才能定案太慢）。
      //
      // ⚠️ 它必须描述**最终画出来的那份数据**，所以由调用方在数据定稿后再写进 state.diag
      //    （缓存回退路径会换掉 rows —— 之前就是在这里写死的，
      //      结果出现「榜上 2 行、诊断写好友0」的自相矛盾）。
      var diag = buildDiag(selfData, rows.length, inFriends, claimedBy, myOpenid);
      return { rows: merged, error: error, diag: diag };
    });
  }

  /**
   * 拼一行诊断信息。
   *
   * 字段：
   *   自读✗/0/1  读自己的托管数据：✗=失败，0=空，1=有
   *   好友N      好友数（不含我）
   *   我是✓/✗   在好友列表里认出自己了没有
   *   认openid/原文/唯一/自读/不出  靠哪条路认出的
   *   id有/无    拿到自己的 openId 没有
   */
  function buildDiag(selfData, friendCount, inFriends, claimedBy, hasOpenid) {
    var selfTxt = (selfData === null) ? '✗'
                : ((selfData && selfData.length) ? String(selfData.length) : '0');
    return '自读' + selfTxt +
           ' 好友' + friendCount +
           ' 我是' + (inFriends ? '✓' : '✗') +
           ' 认' + (claimedBy || '不出') +
           ' id' + (hasOpenid ? '有' : '无');
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

    // ---- 共享画布 = 屏幕大小（逻辑px）----
    //
    // 真机实测（2026-11-07）：我请求 700×scale = 1126×1897，平台给的是 **402×874**
    // —— 正是屏幕的**逻辑像素**（1206×2622 ÷ dpr 3）。**平台不接受别的尺寸。**
    //
    // 所以别跟平台抢尺寸：画布就按屏幕逻辑尺寸建，
    // 内容用「设计px → 逻辑px」的比例画（designScale = 屏幕逻辑宽 / 750），
    // 主域再把位图 **1:1 贴到整屏**（位图后备缓冲 = 主域画布的物理尺寸）→ 必然清晰。
    var cw = (typeof msg.canvasW === 'number' && msg.canvasW > 0) ? msg.canvasW : width;
    var ch = (typeof msg.canvasH === 'number' && msg.canvasH > 0) ? msg.canvasH : height;

    var wantW = Math.round(cw), wantH = Math.round(ch);
    var realW = 0, realH = 0;
    try {
      canvas.width = wantW;
      canvas.height = wantH;
      realW = canvas.width;
      realH = canvas.height;
      if (realW !== wantW || realH !== wantH) {
        odLog('画布被平台钳制：请求 ' + wantW + '×' + wantH + ' 实际 ' + realW + '×' + realH);
      }
    } catch (e) { /* 画布不可写就到此为止 */ }

    // ⭐ 密度 = **实际画布宽 / 设计宽**。
    //
    // 共享画布的位图有多大，就用多大去画 —— 文字按位图的原生分辨率渲染，
    // 主域再 1:1 贴上去就是清晰的。
    //
    // 两种可能：
    //   画布 = 1206×2622（主域设的物理尺寸）→ 密度 1.608 → 按物理分辨率画 ✅ 清晰
    //   画布 = 402×874（平台钳制成屏幕逻辑尺寸）→ 密度 0.536 → 自动降级（布局不变，只是不够锐）
    var scale = (realW > 0) ? (realW / width) : 1;

    // 卡片高度自适应（1 个人的榜不该是张空卡）
    var boardH = height;
    try {
      if (Board && typeof Board.boardHeight === 'function') {
        boardH = Board.boardHeight(st.rows || [], {
          width: width, height: height, style: msg.style
        });
      }
    } catch (e) { /* 算不出来就用传过来的高度 */ }

    // 卡片画在主域指定的内容矩形里，垂直居中。
    // ⚠️ setTransform(a,b,c,d,e,f)：**e = X 平移，f = Y 平移**，且平移量用**逻辑px**。
    // 整屏页：卡片就是整页（原点 0,0）—— 共享画布 = 屏幕，原点就是屏幕左上角。
    var cardX = 0;
    var cardY = 0;
    function useCardTransform() {
      try {
        ctx.setTransform(scale, 0, 0, scale, cardX * scale, cardY * scale);
      } catch (e3) { /* ignore */ }
    }
    function useCanvasTransform() {
      try { ctx.setTransform(scale, 0, 0, scale, 0, 0); } catch (e3) { /* ignore */ }
    }

    // 先清空整张画布（**在物理/画布坐标里清** —— 在变换后的坐标里清只会清掉一部分，
    // 真机实测：上一帧的卡片残留成第二块白卡）。
    try {
      ctx.setTransform(1, 0, 0, 1, 0, 0);
      ctx.clearRect(0, 0, realW, realH);
    } catch (e2) { /* ignore */ }

    // board.js 没加载上（require 失败）→ 画一句人话，别留一片空白
    if (!Board) {
      try {
        useCardTransform();
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
      boardH: boardH,
      page: true,          // 整屏页（共享画布就是屏幕 → 整屏都画上，每个像素都用上）
      pageH: Math.round(realH / scale),   // 屏幕的设计高度
      style: msg.style,
      rankNames: msg.rankNames || [],
      avatarImages: state.avatars,
      selfScore: msg.selfScore,
      // 诊断行**由主域的总开关控制**（CFG.DEBUG）——
      // 开放数据域是独立沙盒，读不到主域的配置，只能靠消息里这个布尔值。
      // 正式版 ⇒ 一行调试字都不画。
      debugLine: (msg.debug && state.diag) ? state.diag : '',
      emptyText: '还没有好友在玩'
    };

    useCardTransform();

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
    if (DEBUG_OVERLAY) drawOdDebug(ctx, scale, realW, realH, wantW, wantH);
  }

  // 开发期诊断：把画布的**实际尺寸**画进位图顶部。
  // 开放数据域的日志在真机调试里要切 Contexts 才看得到，
  // 而这两行数字是判断「平台裁不裁剪共享画布」的唯一依据 —— 画出来，截图就能看。
  var DEBUG_OVERLAY = false;   // 排查共享画布分辨率时用过，查完已关
  function drawOdDebug(ctx, sc, realW, realH, wantW, wantH) {
    try {
      ctx.setTransform(sc, 0, 0, sc, 0, 0);   // 画布坐标（去掉卡片的居中偏移）
      ctx.fillStyle = 'rgba(0,0,0,0.72)';
      ctx.fillRect(0, 0, 700, 40);
      ctx.fillStyle = '#7CFFB2';
      ctx.font = '22px monospace';
      ctx.textAlign = 'left';
      ctx.textBaseline = 'middle';
      ctx.fillText('画布 ' + realW + 'x' + realH + '  请求 ' + wantW + 'x' + wantH +
                   '  密度=' + (typeof sc === 'number' ? sc.toFixed(3) : '-'), 8, 20);
    } catch (e) { /* ignore */ }
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
