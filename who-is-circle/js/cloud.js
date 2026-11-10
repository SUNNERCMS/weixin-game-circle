/**
 * 《谁最圆》主域云端上报模块（P3）
 *
 * 职责：**只管「把这一局交给云端重算，并把云端确认过的分写进托管数据」**。
 * 榜面渲染在 P4（开放数据域），入口与 UI 在 P5 —— 这里一行 UI 都不画。
 *
 * 为什么要单独一个文件：
 *   上报链路有 6 条分支（不破纪录 / 高分同步 / 低分异步 / 云端判无效 /
 *   云端不可用 / pending 补传）。塞回 game.js 就只能靠 e2e 覆盖，
 *   而 e2e 跑不到「云函数没部署」「超时」「队列溢出」这些路径。
 *   依赖全部注入（callFunction / setUserCloudStorage / storage / now），
 *   所以在 Node 里能用假实现跑完所有分支，不需要云环境。
 *
 * 平台硬约束（已核实，别凭印象改）：
 *   - `wx.setUserCloudStorage` **主域可直接调用**，开放数据域不必参与。
 *     参数 `{ KVDataList: [{ key, value }] }`，value 是 JSON 字符串。
 *   - `wxgame.score` 必须是 **Int32** —— 分数一位小数，所以上报 ×10、显示 ÷10。
 *   - key ≤8 字符且全英文（后台排行榜配置要对应），这里用 `circle`。
 *
 * 导出（CommonJS + 浏览器全局 CloudClient）：
 *   createClient(deps)  建客户端
 *   buildHostingValue   造托管数据的 value（单测直接断言格式）
 */
(function (root, factory) {
  var api = factory();
  if (typeof module === 'object' && module && module.exports) module.exports = api;
  if (root) root.CloudClient = api;
})(typeof GameGlobal !== 'undefined' ? GameGlobal
   : (typeof globalThis !== 'undefined' ? globalThis
   : (typeof window !== 'undefined' ? window : null)), function () {
  'use strict';

  /* ===== 常量 ===== */
  var DEFAULT_KEY = 'circle';          // 托管数据 key（≤8 字符全英文）
  var DEFAULT_HIGH = 95;              // 同步/异步分界：≥95 同步等云端结论
  var DEFAULT_MAX_PENDING = 5;        // pending 队列上限，超出丢最旧
  var DEFAULT_TIMEOUT_MS = 5000;      // 云调用超时：超了按「服务不可达」降级
  var PENDING_KEY = 'lb_pending';     // pending 队列的本地存储 key
  var HOSTING_KEY = 'lb_hosting';     // 本地记「托管数据写到多少分」—— 对账要用
  // 补传限速：云端 60 秒 5 次（core.js 的 RATE_WINDOW_SEC / RATE_MAX）。
  // 补传是顺序连发 ⇒ 不限速的话第 6 条起就会被限流拒绝，
  // 而「被限流」的那一条不会重新入队 ⇒ 队列丢项。
  // 14 秒一条 ⇒ 5 条落在 56 秒内（≤ 5 次/60 秒）⇒ 不会自伤。
  var FLUSH_GAP_MS = 14000;

  /* ===== 纯函数：托管数据格式 ===== */

  /**
   * 造托管数据的 value。
   * 微信标准格式（这样以后想上搜索 / 小游戏中心曝光不用改结构）：
   *   { wxgame: { score: 真实分×10, update_time: Unix 秒 }, level: 段位索引, v: verdict }
   * `level` 放在 wxgame 同级 —— wxgame 下不允许自定义字段。
   *
   * `score` 写的是**云端权威最高分**（res.best），不是本局分：
   *   - wxgame.score 是小游戏中心/排行榜的标准字段，语义就是"最好成绩"
   *   - 写本局分会让 score（按本局）与 level（按最高分）两个字段口径打架，
   *     榜面会出现"80 分 · 大师段位"这种自相矛盾
   *
   * `v` 是 verdict 标记：设计文档要求 unverified 的分要给但标出"未完全验证"，
   * 不带这个字段好友榜上就没地方显示那个角标。
   */
  function buildHostingValue(score, level, nowSec, verdict) {
    var s = (typeof score === 'number' && isFinite(score)) ? score : 0;
    var lv = (typeof level === 'number' && isFinite(level)) ? level : 0;
    return JSON.stringify({
      wxgame: {
        score: Math.round(s * 10),        // Int32：真实分 ×10
        update_time: Math.floor(nowSec)   // Unix 秒
      },
      level: lv,
      v: (verdict === 'unverified') ? 'unverified' : 'ok'
    });
  }

  function msg(e) {
    if (!e) return '未知错误';
    if (typeof e === 'string') return e;
    if (e.errMsg) return e.errMsg;
    if (e.message) return e.message;
    return String(e);
  }

  function wait(ms) {
    return new Promise(function (resolve) {
      try {
        if (typeof setTimeout === 'function') setTimeout(resolve, ms);
        else resolve();
      } catch (e) { resolve(); }
    });
  }

  // 给 promise 加超时。超时后 reject，调用方按「服务不可达」降级。
  function withTimeout(p, ms) {
    if (!ms || ms <= 0) return Promise.resolve(p);
    return new Promise(function (resolve, reject) {
      var settled = false;
      var timer = setTimeout(function () {
        if (settled) return;
        settled = true;
        reject(new Error('云端超时 ' + ms + 'ms'));
      }, ms);
      Promise.resolve(p).then(function (v) {
        if (settled) return;
        settled = true;
        clearTimeout(timer);
        resolve(v);
      }, function (e) {
        if (settled) return;
        settled = true;
        clearTimeout(timer);
        reject(e);
      });
    });
  }

  /**
   * 建客户端。
   *
   * deps:
   *   callFunction(name, data) → Promise   调云函数（注入 wx.cloud.callFunction 的适配）
   *   setUserCloudStorage(payload) → Promise  写托管数据（没有就传 null）
   *   storage { get(key)→string|null, set(key, str) }  pending 队列的存取
   *   now() → ms
   *   log(msg)  可选。诊断日志出口 —— 真机上看不到 console 时只能靠它判断链路断在哪，
   *             所以默认给一个空函数，由调用方决定往哪儿写
   *   key / highScore / maxPending / timeoutMs  可选，覆盖默认值
   *   enabled  布尔。false = 没开云（浏览器预览 / 未初始化云环境），
   *             此时 submitIfRecord 直接返回 off，玩法完全不受影响。
   */
  function createClient(deps) {
    deps = deps || {};
    var callFunction = deps.callFunction || null;
    var setUserCloudStorage = deps.setUserCloudStorage || null;
    var storage = deps.storage || { get: function () { return null; }, set: function () {} };
    var now = deps.now || function () { return Date.now(); };
    var log = deps.log || function () {};
    var key = deps.key || DEFAULT_KEY;
    var highScore = (typeof deps.highScore === 'number') ? deps.highScore : DEFAULT_HIGH;
    var maxPending = (typeof deps.maxPending === 'number') ? deps.maxPending : DEFAULT_MAX_PENDING;
    var timeoutMs = (typeof deps.timeoutMs === 'number') ? deps.timeoutMs : DEFAULT_TIMEOUT_MS;
    var enabled = deps.enabled !== false && typeof callFunction === 'function';
    var warnedNoBest = false;   // 云端没返回 best 时提醒一次就够（提醒太多会吵）

    // ---------- pending 队列 ----------

    function loadPending() {
      try {
        var s = storage.get(PENDING_KEY);
        if (!s) return [];
        var a = JSON.parse(s);
        return Array.isArray(a) ? a : [];
      } catch (e) { return []; }
    }

    function savePending(list) {
      try { storage.set(PENDING_KEY, JSON.stringify(list || [])); } catch (e) { /* 存不下就算了 */ }
    }

    // 入队：超出上限丢最旧的（老的记录价值最低，且最新那局最可能是玩家还在意的）
    function enqueuePending(entry) {
      var list = loadPending();
      list.push(entry);
      while (list.length > maxPending) list.shift();
      savePending(list);
      log('[cloud] pending 入队：当前 ' + list.length + ' 条（上限 ' + maxPending + '）');
      return list.length;
    }

    // ---------- 本地记「托管数据写到多少分」 ----------
    //
    // 为什么记：托管数据只能由客户端写（云端没有写它的接口），
    // 而主域**读不到**自己的托管数据（getUserCloudStorage 只能在开放数据域调），
    // 所以客户端只能靠自己记 —— 否则「云端有分、托管没有」这种情况无法发现、无法修复。
    function rememberHosting(score, level, verdict, raw) {
      try {
        storage.set(HOSTING_KEY, JSON.stringify({
          score: score, level: level, verdict: verdict || 'ok', at: now(),
          // **托管数据原文**（就是写进云存储的那串 JSON）。
          //
          // 为什么记它：开放数据域认「我」有三条路（openid / 托管数据原文 / 自读），
          // 其中 openid 与自读都可能同时拿不到（真机上都发生过）。
          // 主域知道自己写出去的那串原文 ⇒ 发给开放域当兜底，
          // 开放域靠**原文完全相同**认出好友列表里的自己。
          raw: (typeof raw === 'string') ? raw : ''
        }));
      } catch (e) { /* 记不住也不影响主流程 */ }
    }
    function recallHosting() {
      try {
        var s = storage.get(HOSTING_KEY);
        if (!s) return null;
        var o = JSON.parse(s);
        return (o && typeof o.score === 'number') ? o : null;
      } catch (e) { return null; }
    }

    // ---------- 托管数据 ----------

    // 写托管数据。失败不抛 —— 云端已经确认过分了，托管数据写失败只是「暂时没上榜」。
    function reportHosting(score, level, verdict) {
      if (!setUserCloudStorage) return Promise.resolve(false);
      var value = buildHostingValue(score, level, now() / 1000, verdict);
      var payload = { KVDataList: [{ key: key, value: value }] };
      return Promise.resolve(setUserCloudStorage(payload)).then(function () {
        log('[cloud] 托管数据写入成功 key=' + key + ' score=' + score +
            (verdict === 'unverified' ? '（未完全验证）' : ''));
        // 记住写到多少分 —— 对账时用来判断「托管数据落后没有」。
        // 放在这里而不是调用方：**任何**写入路径都会记（正常上报 / 补传 / 对账补写）。
        // 连原文一起记 —— 开放域认「我」时的兜底判据（见 rememberHosting）。
        rememberHosting(score, level, verdict, value);
        return true;
      }, function (e) {
        log('[cloud] 托管数据写入失败 key=' + key + ' err=' + msg(e));
        return false;
      });
    }

    // ---------- 云调用 ----------

    function callCloud(payload) {
      var data = {
        pts: payload.pts || [],
        clientScore: (typeof payload.score === 'number') ? payload.score : null,
        clientBest: (typeof payload.clientBest === 'number') ? payload.clientBest : null,
        sig: payload.sig || null,
        guard: payload.guard || null
      };
      var p;
      try {
        p = Promise.resolve(callFunction('score', data));
      } catch (e) {
        return Promise.reject(e);   // 同步抛错也算「服务不可达」，不能外泄到玩法层
      }
      return p.then(function (r) {
        // wx.cloud.callFunction 返回 { result: ... }，剥掉外壳
        if (r && typeof r === 'object' && Object.prototype.hasOwnProperty.call(r, 'result')) return r.result;
        return r;
      });
    }

    // 把云端出参翻译成统一的结果分类。
    //   ok / unverified → 云端认了这个分 → 写托管数据
    //   shadow / reject → 云端判无效 → 不写托管数据，H 不变，不弹新纪录徽章
    //   其它/异常      → 服务不可达 → 降级（玩法不受影响）
    function applyVerdict(res, payload) {
      if (!res || typeof res !== 'object') {
        return { status: 'unavailable', score: payload.score, reason: '云端无响应' };
      }
      var v = res.verdict;
      // 云端权威 best 一路带回来（三个分支都要）——
      // 客户端要靠它把本地分对齐到云端的口径（设计文档 §7.4）。
      var cbest = (typeof res.best === 'number') ? res.best : null;
      if (v === 'reject') {
        return {
          status: 'reject', score: payload.score, verdict: 'reject',
          reason: res.reason || '云端判定无效', best: cbest
        };
      }
      if (v === 'shadow') {
        return {
          status: 'shadow', score: payload.score, verdict: 'shadow',
          reason: res.reason || '云端判定行为异常', best: cbest
        };
      }
      if (v !== 'ok' && v !== 'unverified') {
        return { status: 'unavailable', score: payload.score, reason: '未知 verdict：' + String(v) };
      }
      var cs = (typeof res.score === 'number') ? res.score : payload.score;   // 本局分（结算页显示用）
      // 云端权威最高分 —— 好友榜读的是托管数据，所以榜上显示的是它，不是本局分
      var bs = (typeof res.best === 'number') ? res.best : cs;
      if (typeof res.best !== 'number' && !warnedNoBest) {
        warnedNoBest = true;
        log('[cloud] 云端未返回 best（云函数没更新？）→ 托管数据暂写本局分');
      }
      var lv = (typeof res.level === 'number') ? res.level : 0;
      return reportHosting(bs, lv, v).then(function (hosted) {
        return {
          status: 'ok',
          score: cs,
          cloudScore: cs,
          hostedScore: bs,      // 写进托管数据的分（= 云端权威最高分）
          level: lv,
          best: bs,
          verdict: v,
          hosted: hosted        // ← false = 托管数据没写进去（要重试）
        };
      });
    }

    // 一次完整的「问云端」。**永远 resolve，不 reject** —— 上报失败不该变成玩法异常。
    // sync 只影响日志措辞（同步=结算页等结论，异步=不阻塞 UI），分支逻辑在 submitIfRecord。
    function doCall(payload, sync) {
      if (!enabled) {
        return Promise.resolve({ status: 'off', score: payload.score, reason: '未开启云端' });
      }
      var ptsN = (payload.pts && payload.pts.length) ? payload.pts.length : 0;
      log('[cloud] → 请求云端算分 score=' + payload.score + ' pts=' + ptsN +
          ' 模式=' + (sync ? '同步' : '异步'));
      return withTimeout(callCloud(payload), timeoutMs).then(function (res) {
        return applyVerdict(res, payload);
      }, function (e) {
        return { status: 'unavailable', score: payload.score, reason: msg(e) };
      }).then(function (final) {
        log('[cloud] ← 云端结论 status=' + final.status + ' score=' + final.score +
            (final.verdict ? ' verdict=' + final.verdict : '') +
            (final.reason ? ' reason=' + final.reason : '') +
            (typeof final.hosted === 'boolean' ? ' 托管数据=' + (final.hosted ? '成功' : '失败') : ''));
        return final;
      });
    }

    // ---------- 对外 API ----------

    /**
     * 破纪录才上报。
     *
     * payload:
     *   score / level / pts / sig / guard / clientBest
     *   onSettled(final)  可选回调：**最终**结论（异步路径下晚于本 promise 到达）
     *
     * 返回 promise：
     *   高分（≥highScore，同步）：resolve 的就是最终结论
     *   低分（<highScore，异步）：**立刻** resolve {status:'pending'}，不阻塞结算
     *   没破纪录：resolve {status:'skip'}，**一次云函数都不调**
     */
    function submitIfRecord(payload) {
      payload = payload || {};
      if (!enabled) return Promise.resolve({ status: 'off', score: payload.score });
      var score = payload.score;
      if (typeof score !== 'number' || !isFinite(score)) {
        return Promise.resolve({ status: 'skip', score: score, reason: '没有分数' });
      }
      // 没破纪录就不上传：这一局无论真假都上不了榜，云端没必要知道
      var best = (typeof payload.clientBest === 'number' && isFinite(payload.clientBest)) ? payload.clientBest : 0;
      if (score <= best) {
        return Promise.resolve({ status: 'skip', score: score, reason: '没破纪录' });
      }

      var settled = function (final) {
        // ---- 这一局要不要补传？----
        // ① 服务不可达 → 补传（云端没结论）
        // ② **托管数据写失败** → 补传（云端已经认了这个分，但公开副本没写进去；
        //    不补传就出现「云端账本有分、榜上永远没有」，而且永远不会自愈）★缺陷 1
        // ③ **被限流拒绝** → 补传（这一局本来有效，不该因为限流白打）★缺陷 2
        //
        // 注意 ②③：云端已经给出确定结论（ok / reject），按老逻辑「传完了、不用重试」——
        // 但那两条路径真正缺的是**托管数据**，不是云端结论，所以要重传一次。
        var needRetry = false;
        var why = '';
        if (final.status === 'unavailable') {
          needRetry = true; why = '云端不可达';
        } else if (final.status === 'ok' && final.hosted === false) {
          needRetry = true; why = '托管数据写入失败';
        } else if (final.status === 'reject' && /频繁|rate/i.test(String(final.reason || ''))) {
          needRetry = true; why = '被限流拒绝';
        }
        if (needRetry) {
          enqueuePending({
            score: payload.score,
            level: (typeof payload.level === 'number') ? payload.level : 0,
            pts: payload.pts || [],
            sig: payload.sig || null,
            guard: payload.guard || null,
            clientBest: (typeof payload.clientBest === 'number') ? payload.clientBest : null,
            ts: now()
          });
          log('[cloud] 需要补传：' + why);
        }
        if (typeof payload.onSettled === 'function') {
          try { payload.onSettled(final); } catch (e) { /* 回调出错不影响上报本身 */ }
        }
        return final;
      };

      if (score >= highScore) {
        // 同步：结算页等这个结论（高分才有防作弊价值，值得等）
        return doCall(payload, true).then(settled, function (e) {
          return settled({ status: 'unavailable', score: payload.score, reason: msg(e) });
        });
      }

      // 异步：不阻塞 UI
      doCall(payload, false).then(settled, function (e) {
        return settled({ status: 'unavailable', score: payload.score, reason: msg(e) });
      });
      return Promise.resolve({ status: 'pending', score: score });
    }

    /**
     * 补传 pending 队列（启动时调）。
     * 只有「服务不可达」才留在队列里等下次；确定结论（ok/shadow/reject）都算传完。
     * 顺序传：云端有速率限制（60 秒 5 次），一次性全甩过去容易被限流。
     */
    function flushPending() {
      if (!enabled) return Promise.resolve(0);
      var list = loadPending();
      if (!list.length) return Promise.resolve(0);
      log('[cloud] 补传 pending：共 ' + list.length + ' 条');
      var flushed = 0;
      function step(i) {
        if (i >= list.length) {
          savePending([]);
          log('[cloud] 补传完成：成功 ' + flushed + ' 条');
          return Promise.resolve(flushed);
        }
        return doCall(list[i], false).then(function (final) {
          if (final.status === 'unavailable') {
            savePending(list.slice(i));    // 还没传成功，留着下次再来
            log('[cloud] 补传中断：已成功 ' + flushed + ' 条，剩 ' + (list.length - i) + ' 条下次再传');
            return flushed;
          }
          flushed++;
          // 限速：云端 60 秒 5 次。顺序连发不限速的话，第 6 条起会被限流拒绝，
          // 而「被限流」按新逻辑会重新入队 —— 于是队列反复打转、还互相踩。
          // 14 秒一条 ⇒ 5 条落在 56 秒内（≤5 次/60 秒）⇒ 不会自伤。
          if (i + 1 < list.length) {
            return wait(FLUSH_GAP_MS).then(function () { return step(i + 1); });
          }
          return step(i + 1);
        });
      }
      return step(0);
    }

    function pendingCount() {
      return loadPending().length;
    }

    /**
     * 对账：问云端「我的权威最高分是多少」，若托管数据落后就补写。
     *
     * 为什么需要（2026-11-07 审计）：
     *   云端账本（scores）是权威，托管数据是它的**公开副本**，而副本是**客户端写的**。
     *   主域**读不到**自己的托管数据（getUserCloudStorage 只能在开放数据域调），
     *   所以客户端只能靠自己记（HOSTING_KEY）——
     *   否则「云端有分、榜上没有」这件事既发现不了也修不了。
     *
     * 幂等：写进去的是云端权威 max，永远不会把托管数据写低 ✓
     * 免费：sync 模式不判定、不写 submissions、不计速率 ✓
     *
     * 返回值不变（补写成功给分数，否则 null）—— 但**过程状态**记在 lastSync 里，
     * 因为「不用补写」「云端没给分」「云端不可达」三件事都返回 null，
     * 光看返回值分不出来（真机截图上就只画了句没头没尾的「对账无」）。
     */
    var lastSync = { status: '', best: null };

    function syncBest() {
      if (!enabled) { lastSync = { status: 'off', best: null }; return Promise.resolve(null); }
      var p;
      try {
        // ⚠️ 必须带超时 —— 与 doCall 用的是同一个 withTimeout。
        //    不带的话：云函数挂住 ⇒ 这个 promise 永远不 resolve
        //    ⇒ 诊断行永远停在空状态，排查时看不出「对账根本没回来」。
        p = withTimeout(callFunction('score', { action: 'sync' }), timeoutMs);
      } catch (e) { lastSync = { status: 'unreachable', best: null }; return Promise.resolve(null); }
      return p.then(function (r) {
        var res = (r && typeof r === 'object' && Object.prototype.hasOwnProperty.call(r, 'result'))
          ? r.result : r;
        // ⚠️ 「云端回了**结构不对**的东西」与「云端确实没有分」是两回事 ——
        //    混成 noBest 会把一个故障说成事实，排查时被带偏。
        if (!res || typeof res !== 'object' || res.sync !== true) {
          lastSync = { status: 'badResponse', best: null };
          return null;
        }
        var best = res.best;
        if (typeof best !== 'number' || best <= 0) { lastSync = { status: 'noBest', best: null }; return null; }
        var level = (typeof res.level === 'number') ? res.level : 0;
        var verdict = res.bestVerdict || 'ok';
        var local = recallHosting();
        var localScore = (local && typeof local.score === 'number') ? local.score : -1;
        var hasRaw = !!(local && typeof local.raw === 'string' && local.raw);
        if (localScore >= best) {
          // 存量迁移：本地记的托管分已经是最新，但记录里**没有原文**
          //（老版本写的记录只有 score/level/verdict/at）⇒ 补写一次，让记录带上原文。
          //
          // 为什么需要：开放域认「我」的兜底判据之一是「托管数据原文逐字符相同」，
          // 没有原文那条路就用不了 —— 等玩家再破一次纪录才有，代价太大。
          //
          // 补写的是**云端权威最高分**，与原来写进去的是同一个分 ⇒ 榜上不变。
          // （本地分比云端还高时不动 —— 那是异常，宁可不动也不把托管数据写低。）
          if (Math.abs(localScore - best) < 0.0001 && !hasRaw) {
            log('[cloud] 对账：托管分已是最新但记录里没有原文 → 补写一次（认「我」要用）');
            lastSync = { status: 'resync', best: best };
            return reportHosting(best, level, verdict).then(function (ok) {
              lastSync = { status: ok ? 'resync' : 'failed', best: best };
              return ok ? best : null;
            });
          }
          log('[cloud] 对账：本地记的托管分 ' + localScore + ' ≥ 云端 ' + best + ' → 不用补写');
          lastSync = { status: 'noop', best: best };
          return null;
        }
        log('[cloud] 对账：云端 best=' + best + '，本地记的托管分=' +
            (local ? local.score : '无') + ' → 补写托管数据');
        lastSync = { status: 'writing', best: best };
        return reportHosting(best, level, verdict).then(function (ok) {
          lastSync = { status: ok ? 'ok' : 'failed', best: best };
          return ok ? best : null;
        });
      }, function () {
        lastSync = { status: 'unreachable', best: null };
        return null;   // 云端不可达：对账失败不影响玩法
      });
    }

    return {
      submitIfRecord: submitIfRecord,
      flushPending: flushPending,
      pendingCount: pendingCount,
      reportHosting: reportHosting,
      syncBest: syncBest,
      recallHosting: recallHosting,
      // 最近一次对账的过程状态（返回值分不出「不用补写 / 云端没给分 / 不可达」，
      // 所以单独暴露一个状态口，诊断行靠它说人话）
      syncStatus: function () { return lastSync; },
      enabled: enabled,
      key: key,
      highScore: highScore,
      maxPending: maxPending,
      timeoutMs: timeoutMs,
      // 内部件，暴露出来是为了单测能直接断言格式与降级分支
      _buildHostingValue: buildHostingValue,
      _loadPending: loadPending,
      _savePending: savePending,
      _rememberHosting: rememberHosting,
      _recallHosting: recallHosting
    };
  }

  return {
    createClient: createClient,
    buildHostingValue: buildHostingValue,
    PENDING_KEY: PENDING_KEY,
    DEFAULT_KEY: DEFAULT_KEY,
    DEFAULT_HIGH: DEFAULT_HIGH,
    DEFAULT_MAX_PENDING: DEFAULT_MAX_PENDING
  };
});
