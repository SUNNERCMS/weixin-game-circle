/**
 * 《谁最圆》评分引擎 —— 主域与云函数共用的唯一实现
 *
 * 纯函数模块：不引用任何平台全局对象、不读写存储、不使用宿主 API。
 * 这条约束是硬性的 —— 云函数与小游戏主域没有共同的平台 API，
 * 一旦混入宿主调用，"共享"就失效了。
 *
 * 导出（CommonJS + 浏览器全局 Scoring）：
 *   配置   SCORE_CFG GUARD_CFG RANKS INVALID_TIPS
 *   评分   resample kasaFit refineFit winding roundScore closeFactor largestGap
 *          evaluate getRank diagnose upgradeTip
 *   防作弊 stat guardCheck shapeSig isReplay fnv encodePts decodePts judge
 *         BEST_SALT（最高分存档自校验盐值，主域与云端必须一致）
 */
(function (root, factory) {
  var api = factory();
  if (typeof module === 'object' && module && module.exports) module.exports = api;
  if (root) root.Scoring = api;
})(typeof GameGlobal !== 'undefined' ? GameGlobal
   : (typeof globalThis !== 'undefined' ? globalThis
   : (typeof window !== 'undefined' ? window : null)), function () {
  'use strict';

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

  // 处置策略：明确作弊丢弃 / 高风险不计入最佳 / 中风险仅不出分享 / 正常全开放
  // 注意：shadow 需要 ≥2 条命中同时成立 —— 单条弱信号（如"过于干净"）不足以定罪，
  // 否则正常玩家的高分会被误判为不可入榜。
  function judge(r, g, replay, dev) {
    if (dev) return 'ok';
    if (g.hard && g.hard.length) return 'reject';
    if (replay || (g.hits.length >= 2 && g.risk >= GUARD_CFG.SHADOW_RISK) ||
        (r.score >= 99 && g.risk > 0)) return 'shadow';
    if (g.risk >= GUARD_CFG.UNVERIFIED_RISK) return 'unverified';
    return 'ok';
  }

    return {
      SCORE_CFG: SCORE_CFG, GUARD_CFG: GUARD_CFG, RANKS: RANKS, INVALID_TIPS: INVALID_TIPS,
      resample: resample, kasaFit: kasaFit, refineFit: refineFit, winding: winding,
      roundScore: roundScore, closeFactor: closeFactor, largestGap: largestGap,
      evaluate: evaluate, getRank: getRank, diagnose: diagnose, upgradeTip: upgradeTip,
      stat: stat, guardCheck: guardCheck, shapeSig: shapeSig, isReplay: isReplay,
      fnv: fnv, encodePts: encodePts, decodePts: decodePts, judge: judge,
      BEST_SALT: BEST_SALT
    };
  });
