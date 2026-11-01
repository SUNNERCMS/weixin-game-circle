/**
 * 评分引擎 / 防作弊模块单元测试
 * 直接 require game.js（纯函数已导出），不依赖任何平台 API、无需画布
 * 运行：node test/unit/scorer.test.js   （退出码非 0 = 有用例失败）
 */
const G = require('../../who-is-circle/game.js');

let pass = 0, fail = 0;
function ok(cond, name, extra) {
  if (cond) { pass++; console.log('  ✅ ' + name + (extra ? '  ' + extra : '')); }
  else { fail++; console.log('  ❌ ' + name + (extra ? '  ' + extra : '')); }
}

// ---------- 造笔画工具 ----------
function circle(cx, cy, r, { n = 240, noise = 0, dur = 1200, jitter = 0, start = 0, sweep = 360 } = {}) {
  const pts = [];
  for (let i = 0; i <= n; i++) {
    const a = (start + sweep * i / n) * Math.PI / 180;
    const rr = r * (1 + (Math.random() - 0.5) * 2 * noise);
    const t = dur * i / n + (jitter ? (Math.random() - 0.5) * jitter : 0);
    pts.push({ x: cx + rr * Math.cos(a), y: cy + rr * Math.sin(a), t });
  }
  return pts;
}
function ellipse(cx, cy, a, b, opt = {}) {
  const pts = [];
  const n = opt.n || 240;
  for (let i = 0; i <= n; i++) {
    const th = 360 * i / n * Math.PI / 180;
    pts.push({ x: cx + a * Math.cos(th), y: cy + b * Math.sin(th), t: 1200 * i / n });
  }
  return pts;
}
function line(x0, y0, x1, y1, dur = 600) {
  const pts = [];
  for (let i = 0; i <= 40; i++) {
    pts.push({ x: x0 + (x1 - x0) * i / 40, y: y0 + (y1 - y0) * i / 40, t: dur * i / 40 });
  }
  return pts;
}
function scribble(cx, cy, n = 200) {
  const pts = [];
  for (let i = 0; i <= n; i++) {
    pts.push({
      x: cx + Math.sin(i * 1.7) * 120 + (Math.random() - .5) * 40,
      y: cy + Math.cos(i * 2.3) * 120 + (Math.random() - .5) * 40,
      t: i * 8
    });
  }
  return pts;
}

console.log('\n========== 一、评分引擎 ==========');

// 1. 完美圆
let r = G.evaluate(circle(375, 700, 250));
ok(r.valid && r.score >= 97, '完美圆 → 高分', `score=${r.score} eps=${r.eps.toFixed(5)} deg=${r.deg.toFixed(1)}`);
ok(r.loss && Math.abs((r.loss.round + r.loss.close + r.loss.dir) - (100 - r.score)) < 0.15,
   '扣分明细三项之和 = 100 − 总分', `Σloss=${(r.loss.round + r.loss.close + r.loss.dir).toFixed(2)} vs ${(100 - r.score).toFixed(2)}`);

// 2. 2% 噪声圆（ε 经 4px 等弧长重采样后会被平滑到 ~0.9%，对应锚点表 ~93 分）
r = G.evaluate(circle(375, 700, 250, { noise: 0.02 }));
ok(r.valid && r.score >= 85 && r.score <= 97, '2% 噪声圆 → 85~97', `score=${r.score} eps=${(r.eps * 100).toFixed(2)}%`);

// 3. 5% 噪声圆
r = G.evaluate(circle(375, 700, 250, { noise: 0.05 }));
ok(r.valid && r.score >= 72 && r.score <= 88, '5% 噪声圆 → 72~88', `score=${r.score} eps=${(r.eps * 100).toFixed(2)}%`);

// 4. 分数单调性：噪声越大分越低
const sc = [0.005, 0.01, 0.02, 0.05, 0.1].map(n => G.evaluate(circle(375, 700, 250, { noise: n })).score);
ok(sc.every((v, i) => i === 0 || v < sc[i - 1]), '分数随噪声单调递减', sc.join(' > '));

// 4b. 采样密度无关性：同一条圆，采样 40 点与 400 点分数必须一致
//     （回归测试：重采样曾因向量记账错误让稀疏采样反向比例暴涨、白扣 27 分）
const sparse = G.evaluate(circle(375, 700, 250, { n: 40, noise: 0 }));
const dense = G.evaluate(circle(375, 700, 250, { n: 400, noise: 0 }));
ok(Math.abs(sparse.score - dense.score) <= 1 && sparse.score >= 95,
   '分数与采样密度无关（稀疏 40 点 = 密集 400 点）', `${sparse.score} vs ${dense.score}`);

// 5. 椭圆（圆度差）
r = G.evaluate(ellipse(375, 700, 300, 200));
ok(r.valid && r.score < 70, '椭圆 → 明显低于圆', `score=${r.score}`);

// 6. 缺口：300° 弧（缺 60°）
r = G.evaluate(circle(375, 700, 250, { sweep: 300, n: 200 }));
ok(r.valid && r.loss.close > 0.5, '300° 弧 → 闭合扣分生效', `score=${r.score} close扣=${r.loss.close.toFixed(1)}`);

// 7. 缺口很小（350°）按曲线只轻微扣分（Doc B 预期 ≈95 分）
const r350 = G.evaluate(circle(375, 700, 250, { sweep: 350, n: 220 }));
ok(r350.loss.close < 6 && r350.score >= 92, '350° 弧 → 轻微扣分且仍在 92 分以上',
   `close扣=${r350.loss.close.toFixed(2)} score=${r350.score}`);

// 8. 无效笔迹判定
ok(G.evaluate(line(100, 100, 600, 100)).reason === 'line', '一条线 → reason=line');
ok(G.evaluate(circle(375, 700, 30)).reason === 'small', '半径 30 → reason=small');
ok(G.evaluate(circle(375, 700, 250, { n: 3, dur: 50 })).reason === 'short', '过短 → reason=short');
ok(G.evaluate(circle(375, 700, 250, { sweep: 40, n: 30 })).reason === 'arc', '只画 40° → reason=arc');

// 9. 乱涂：判为有效但极低分（进"灾难现场"档），而不是被丢弃 —— 玩家仍能拿到吐槽
const scrib = scribble(375, 700);
r = G.evaluate(scrib);
ok(r.valid && r.score < 45, '乱涂 → 有效但极低分', `score=${r.score}`);

// 9b. 乱涂必须稳定判「有效低分」：绕角会随机落在 0～360°，早期会被误判成 reason=arc（无效）
let scribBad = 0, scribMax = 0;
for (let i = 0; i < 30; i++) {
  const s = G.evaluate(scribble(375, 700));
  if (!s.valid) scribBad++;
  else scribMax = Math.max(scribMax, s.score);
}
ok(scribBad === 0 && scribMax < 45, '乱涂 30 次均判有效低分（不再随机报「只画了一小段」）',
   `无效=${scribBad}/30 最高分=${scribMax}`);

console.log('\n========== 二、段位 / 文案 ==========');
const rk = G.getRank(0), rk2 = G.getRank(50), rk3 = G.getRank(99.5);
ok(rk.rank.name === '灾难现场' && rk2.rank.name === '甜甜圈' && rk3.rank.name === '神之圆',
   '段位映射正确', `${rk.rank.name} / ${rk2.rank.name} / ${rk3.rank.name}`);
ok(G.RANKS.length === 13, '共 13 档段位', `${G.RANKS.length}`);
ok(G.getRank(95).next && G.getRank(95).next.min === 97, '下一档存在', `95 → ${G.getRank(95).next.name}`);
ok(G.upgradeTip(95, G.getRank(95).next).includes('2.0'), '升级提示算差值', G.upgradeTip(95, G.getRank(95).next));

console.log('\n========== 三、防作弊 ==========');
// 机器：完全匀速 + 无噪声
const bot = circle(375, 700, 250, { n: 300, noise: 0, jitter: 0 });
const botRaw = bot.map((p, i) => ({ t: i * 10, h: i * 10, x: p.x, y: p.y }));
const gb = G.guardCheck(botRaw, G.evaluate(bot).fit, G.evaluate(bot).score, {});
ok(gb.risk >= 8, '匀速机器笔迹 → 高风险', `risk=${gb.risk} hits=${gb.hits.join(',')}`);
ok(G.judge(G.evaluate(bot), gb, false) === 'shadow', '机器笔迹 → 判 shadow（不计入最佳）',
   `verdict=${G.judge(G.evaluate(bot), gb, false)}`);

// 真人：低频形变（手腕漂移）+ 少量白噪 + 变速时序 + 起笔收笔慢
function humanStroke(cx, cy, r, n = 300) {
  const pts = [], raw = [];
  let t = 0;
  for (let i = 0; i <= n; i++) {
    const th = 2 * Math.PI * i / n;
    // 低频半径漂移（真人手腕的缓慢形变）
    const rr = r * (1 + 0.006 * Math.sin(2 * th) - 0.004 * Math.cos(3 * th) + (Math.random() - .5) * 0.004);
    const px = cx + rr * Math.cos(th), py = cy + rr * Math.sin(th);
    // 时序：随机间隔 + 起笔/收笔减速包络
    const edge = Math.min(i, n - i) / (n * 0.15);
    const dt = (7 + Math.random() * 9) * (0.45 + 0.55 * Math.min(1, edge));
    t += dt;
    pts.push({ x: px, y: py, t });
    raw.push({ t, h: t + Math.random() * 2, x: px, y: py });   // 回调时刻≈事件时刻
  }
  return { pts, raw };
}
const H = humanStroke(375, 700, 250);
const gh = G.guardCheck(H.raw, G.evaluate(H.pts).fit, G.evaluate(H.pts).score, {});
ok(gh.risk < 5, '真人笔迹 → 低于中风险阈值（不误伤）', `risk=${gh.risk} hits=${gh.hits.join(',') || '无'}`);
ok(G.judge(G.evaluate(H.pts), gh, false) === 'ok', '真人笔迹 → 判定 ok（可计入最佳）', `risk=${gh.risk}`);

// 重放：同一笔迹算两次 → 指纹一致
const rp1 = humanStroke(375, 700, 250);
const rp2 = rp1;   // 完全相同
const sg1 = G.shapeSig(rp1.pts, G.evaluate(rp1.pts).fit);
const sg2 = G.shapeSig(rp2.pts, G.evaluate(rp2.pts).fit);
ok(G.isReplay(sg1, [sg2]) === true, '同一形状重放 → 判定为重放');
ok(G.isReplay(sg1, [sg2.map(v => v + 0.05)]) === false, '不同形状 → 不判重放');

// 轨迹存档往返：编码→解码→重算，分数应一致
const pts = circle(375, 700, 250, { noise: 0.02 });
const ev = G.evaluate(pts);
const dec = G.decodePts(G.encodePts(pts));
const ev2 = G.evaluate(dec);
ok(Math.abs(ev.score - ev2.score) < 0.2, '存档往返后分数一致', `${ev.score} vs ${ev2.score}`);
ok(G.fnv('abc') === G.fnv('abc'), '哈希函数稳定');

// 伪造存档（改分数不改笔迹）应被发现
const tampered = { v: 3, score: 99, pts: G.encodePts(pts) };
tampered.sum = G.fnv('yz#750#v3' + JSON.stringify([tampered.v, tampered.score, tampered.pts]));
ok(Math.abs(G.evaluate(G.decodePts(tampered.pts)).score - 99) > 0.15,
   '改分数不改笔迹 → 重算对不上', `笔迹真实分=${G.evaluate(G.decodePts(tampered.pts)).score}`);

console.log('\n========== 四、不完整笔迹的评分口径 ==========');
// v0.4 起取消了实时反馈（边画边给分 + 笔迹三色着色），评分只在松手后跑一次，
// 这里保留对「部分弧」的回归，确保低完成度的圆仍能给出可解释的分数
const partial = circle(375, 700, 250, { sweep: 200, n: 120 });
const rp = G.evaluate(partial);
ok(rp.valid, '部分弧（200°）也能算分', `score=${rp.score} deg=${rp.deg.toFixed(0)}`);
ok(rp.deg > 150 && rp.deg < 250, '部分弧的已画角度在合理区间', `deg=${rp.deg.toFixed(0)}`);
const full = G.evaluate(circle(375, 700, 250, { n: 240 }));
ok(full.score > rp.score, '画得越完整分数越高', `200°=${rp.score} 360°=${full.score}`);
ok(G.evaluate(circle(375, 700, 250, { sweep: 60, n: 40 })).valid === false,
   '一小段弧（60°）判无效', '理由=arc');

console.log(`\n结果：${pass} 通过 / ${fail} 失败\n`);
process.exit(fail ? 1 : 0);
