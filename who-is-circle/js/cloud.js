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

    // ---------- 托管数据 ----------

    // 写托管数据。失败不抛 —— 云端已经确认过分了，托管数据写失败只是「暂时没上榜」。
    function reportHosting(score, level, verdict) {
      if (!setUserCloudStorage) return Promise.resolve(false);
      var value = buildHostingValue(score, level, now() / 1000, verdict);
      var payload = { KVDataList: [{ key: key, value: value }] };
      return Promise.resolve(setUserCloudStorage(payload)).then(function () {
        log('[cloud] 托管数据写入成功 key=' + key + ' score=' + score +
            (verdict === 'unverified' ? '（未完全验证）' : ''));
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
      if (v === 'reject') {
        return { status: 'reject', score: payload.score, reason: res.reason || '云端判定无效' };
      }
      if (v === 'shadow') {
        return { status: 'shadow', score: payload.score, reason: res.reason || '云端判定行为异常' };
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
          hosted: hosted
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
        // 服务不可达 → 把这一局存进 pending 队列，下次启动补传
        // （只有确定结论 ok/shadow/reject 才算「传完了」，那种不用重试）
        if (final.status === 'unavailable') {
          enqueuePending({
            score: payload.score,
            level: (typeof payload.level === 'number') ? payload.level : 0,
            pts: payload.pts || [],
            sig: payload.sig || null,
            guard: payload.guard || null,
            clientBest: (typeof payload.clientBest === 'number') ? payload.clientBest : null,
            ts: now()
          });
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
          return step(i + 1);
        });
      }
      return step(0);
    }

    function pendingCount() {
      return loadPending().length;
    }

    return {
      submitIfRecord: submitIfRecord,
      flushPending: flushPending,
      pendingCount: pendingCount,
      reportHosting: reportHosting,
      enabled: enabled,
      key: key,
      highScore: highScore,
      maxPending: maxPending,
      timeoutMs: timeoutMs,
      // 内部件，暴露出来是为了单测能直接断言格式与降级分支
      _buildHostingValue: buildHostingValue,
      _loadPending: loadPending,
      _savePending: savePending
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
