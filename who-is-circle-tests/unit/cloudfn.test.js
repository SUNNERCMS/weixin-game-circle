/**
 * 云函数骨架单元测试（cloudfunctions/score/）
 *
 * 作用：守住"云端算分"这条路的**工程契约**。
 *      这些断言读的是项目文件本身，不需要云环境 —— 任何一台机器上都能跑。
 *
 * 守护的东西：
 *   1. 云函数里的评分引擎与 shared/scoring.js **字节级一致**（同一份算法，不许漂移）
 *   2. cloudfunctions/ **不进小程序包**（服务端逻辑不该进客户端包）
 *   3. 云函数不内联一份评分引擎（只能 require 同步产物）
 *   4. 云函数不引用小游戏主域符号（服务端跑在小游戏沙盒外）
 *
 * 运行：node unit/cloudfn.test.js   （退出码非 0 = 有用例失败）
 */
const fs = require('fs');
const path = require('path');
const crypto = require('crypto');

let pass = 0, fail = 0;
function ok(cond, name, extra) {
  if (cond) { pass++; console.log('  ✅ ' + name + (extra ? '  ' + extra : '')); }
  else { fail++; console.log('  ❌ ' + name + (extra ? '  ' + extra : '')); }
}

const root = path.join(__dirname, '../../who-is-circle');
const cfDir = path.join(root, 'cloudfunctions', 'score');

console.log('\n========== 一、目录与入口 ==========');

ok(fs.existsSync(cfDir) && fs.statSync(cfDir).isDirectory(), 'cloudfunctions/score/ 目录存在');

const indexPath = path.join(cfDir, 'index.js');
const corePath = path.join(cfDir, 'core.js');
const pkgPath = path.join(cfDir, 'package.json');
const cfScoringPath = path.join(cfDir, 'scoring.js');

ok(fs.existsSync(indexPath), 'index.js 存在（云函数入口）');
ok(fs.existsSync(corePath), 'core.js 存在（纯逻辑，与 wx-server-sdk 解耦）');
ok(fs.existsSync(pkgPath), 'package.json 存在');

console.log('\n========== 二、评分引擎必须与 shared/ 字节级一致 ==========');

const sharedPath = path.join(root, 'shared', 'scoring.js');
ok(fs.existsSync(sharedPath), 'shared/scoring.js 存在');
ok(fs.existsSync(cfScoringPath), 'cloudfunctions/score/scoring.js 存在（同步产物）');

if (fs.existsSync(sharedPath) && fs.existsSync(cfScoringPath)) {
  const h = (p) => crypto.createHash('sha256').update(fs.readFileSync(p)).digest('hex');
  const hs = h(sharedPath), hc = h(cfScoringPath);
  ok(hs === hc, '两份 scoring.js 的 sha256 相同（算法不许漂移）',
    hs === hc ? hs.slice(0, 12) : 'shared=' + hs.slice(0, 12) + ' cloud=' + hc.slice(0, 12));
}

console.log('\n========== 三、云函数不得内联评分引擎 ==========');

function readIfExists(p) { return fs.existsSync(p) ? fs.readFileSync(p, 'utf8') : ''; }
const indexSrc = readIfExists(indexPath);
const coreSrc = readIfExists(corePath);

// 剥离注释与字符串，避免注释里的 API 名把断言搞红（与 opendata.test.js 同一套处理）
function stripComments(src) {
  const literals = [];
  let s = src.replace(/'(?:\\.|[^'\\])*'|"(?:\\.|[^"\\])*"/g, function (m) {
    literals.push(m); return '\u0000' + (literals.length - 1) + '\u0000';
  });
  s = s.replace(/\/\*[\s\S]*?\*\//g, ' ');
  s = s.replace(/(^|[^:'"\\])\/\/[^\n]*/g, '$1');
  return s.replace(/\u0000(\d+)\u0000/g, function (_, i) { return literals[+i]; });
}
const indexCode = stripComments(indexSrc);
const coreCode = stripComments(coreSrc);

// 评分引擎的内部实现特征：出现这些函数名说明是抄了一份
const ENGINE_FNS = ['kasaFit', 'refineFit', 'winding', 'closeFactor', 'largestGap', 'roundScore'];
const INLINE_RE = new RegExp('function\\s+(' + ENGINE_FNS.join('|') + ')\\s*\\(');
ok(!INLINE_RE.test(indexCode), 'index.js 没有内联评分引擎实现');
ok(!INLINE_RE.test(coreCode), 'core.js 没有内联评分引擎实现');

ok(/require\(['"]\.\/scoring\.js['"]\)/.test(coreCode), 'core.js require 同步产物 ./scoring.js');
ok(!/require\(['"][^.]/.test(coreCode) || /require\(['"]\.\/scoring\.js['"]\)/.test(coreCode),
  'core.js 只依赖本地 ./scoring.js，不依赖服务端 SDK');

console.log('\n========== 四、云函数不得引用小游戏主域符号 ==========');

ok(!/\bwx\.createCanvas\b|\bwx\.onTouchStart\b|\bwx\.getStorageSync\b/.test(indexCode + coreCode),
  '不调用小游戏主域 API');
ok(!/\bgetApp\s*\(/.test(indexCode + coreCode), '不调用 getApp');
ok(!/\bwx\./.test(coreCode), 'core.js 里完全不出现 wx.（服务端沙盒里没有 wx）');

console.log('\n========== 五、打包产物边界 ==========');

const projCfg = JSON.parse(fs.readFileSync(path.join(root, 'project.config.json'), 'utf8'));
const ignoreVals = ((projCfg.packOptions && projCfg.packOptions.ignore) || []).map(x => x.value);
ok(ignoreVals.includes('cloudfunctions'),
  'packOptions.ignore 显式排除 cloudfunctions（服务端源码不进客户端包）',
  ignoreVals.join(', ') || '(空)');

// P1 时的断言写的是"项目里没有 cloudfunctions 目录" —— P2 建了之后那条就不成立了，
// 正确的不变式是上面的"目录在 ⇒ 必须在 ignore 列表里"。opendata.test.js 里那条要一起改。
const odTest = path.join(__dirname, 'opendata.test.js');
const odTestSrc = readIfExists(odTest);
ok(!/没有 cloudfunctions/.test(odTestSrc),
  'opendata.test.js 里那条"没有 cloudfunctions 目录"的旧断言已改掉（否则 P2 必然把它弄红）');

console.log(`\n结果：${pass} 通过 / ${fail} 失败\n`);
process.exit(fail ? 1 : 0);
