/**
 * 开放数据域骨架单元测试（open-data/ + game.json 的 openDataContext）
 *
 * 作用：守住 P1 搭的那条「开放数据域通路」的配置契约。
 *      这些断言读的是**项目文件本身**，不需要微信环境 —— 任何一台机器上都能跑。
 *
 * 守护的东西：
 *   1. game.json 声明了 openDataContext，且指向的目录真实存在
 *      （拼错目录名不会报错，只会让开放数据域静默不加载 —— 这种失败最难查）
 *   2. 开放数据域是独立沙盒，不得引用主域符号，也不得在 P1 阶段就越界调好友数据
 *   3. 打包产物不含云函数源码（P6 的前置条件，提前守）
 *
 * 运行：node unit/opendata.test.js   （退出码非 0 = 有用例失败）
 */
const fs = require('fs');
const path = require('path');

let pass = 0, fail = 0;
function ok(cond, name, extra) {
  if (cond) { pass++; console.log('  ✅ ' + name + (extra ? '  ' + extra : '')); }
  else { fail++; console.log('  ❌ ' + name + (extra ? '  ' + extra : '')); }
}

const root = path.join(__dirname, '../../who-is-circle');
const gameJsonPath = path.join(root, 'game.json');
const gameJson = JSON.parse(fs.readFileSync(gameJsonPath, 'utf8'));

console.log('\n========== 一、game.json 的 openDataContext ==========');

ok(typeof gameJson.openDataContext === 'string' && gameJson.openDataContext.length > 0,
  'game.json 声明了 openDataContext',
  gameJson.openDataContext ? '值=' + gameJson.openDataContext : '缺失');

const dirName = gameJson.openDataContext;
ok(dirName && !dirName.includes('/') && !dirName.includes('\\'),
  'openDataContext 是子目录名而非路径', dirName || '(无)');

const odDir = dirName ? path.join(root, dirName) : null;
ok(odDir && fs.existsSync(odDir) && fs.statSync(odDir).isDirectory(),
  'openDataContext 指向的目录真实存在', dirName ? dirName + '/' : '(无)');

console.log('\n========== 二、开放数据域入口文件 ==========');

const odIndex = odDir ? path.join(odDir, 'index.js') : null;
ok(odIndex && fs.existsSync(odIndex), '开放数据域入口 index.js 存在',
  odIndex ? path.basename(odIndex) : '(无)');

let odSrc = '';
if (odIndex && fs.existsSync(odIndex)) odSrc = fs.readFileSync(odIndex, 'utf8');

// 剥离注释与字符串字面量后再做"禁止出现某 API"的断言 ——
// 否则文件头那段解释沙盒限制的注释里写着 "wx.request"，会把测试自己搞红。
// 字符串字面量要保留：URL 检查得看得到代码里真实的字符串。
function stripComments(src) {
  const literals = [];
  let s = src.replace(/'(?:\\.|[^'\\])*'|"(?:\\.|[^"\\])*"/g, function (m) {
    literals.push(m);
    return '\u0000' + (literals.length - 1) + '\u0000';
  });
  s = s.replace(/\/\*[\s\S]*?\*\//g, ' ');              // 块注释
  s = s.replace(/(^|[^:'"\\])\/\/[^\n]*/g, '$1');      // 行注释
  return s.replace(/\u0000(\d+)\u0000/g, function (_, i) { return literals[+i]; });
}
const odCode = stripComments(odSrc);

ok(odCode.includes('wx.getSharedCanvas'), 'index.js 通过 wx.getSharedCanvas 取离屏画布');
ok(!/wx\.getFriendCloudStorage|wx\.getUserCloudStorage|wx\.getGroupCloudStorage/.test(odCode),
  'P1 阶段不得调好友/用户云存储 API（属于 P3/P4）');

console.log('\n========== 三、开放数据域的沙盒隔离 ==========');

ok(!/\brequire\s*\(/.test(odCode), 'index.js 不 require 主域模块（沙盒内无主域 require）');
ok(!/\bgetApp\s*\(/.test(odCode), 'index.js 不调用 getApp（主域对象）');
ok(!/https?:\/\//.test(odCode), 'index.js 不引用远程 URL（开放数据域禁远程图片）');
ok(!/\bwx\.request\b/.test(odCode), 'index.js 不发网络请求（开放数据域无此能力）');

console.log('\n========== 四、打包产物边界 ==========');

const cfDir = path.join(root, 'cloudfunctions');
ok(!fs.existsSync(cfDir), '项目里没有 cloudfunctions/ 目录（打包产物不含云函数源码）');

const packIgnore = (JSON.parse(fs.readFileSync(path.join(root, 'project.config.json'), 'utf8'))
  .packOptions && JSON.parse(fs.readFileSync(path.join(root, 'project.config.json'), 'utf8'))
  .packOptions.ignore) || [];
const ignoreVals = packIgnore.map(x => x.value);
ok(ignoreVals.includes('index.html'), 'index.html 被排除出小程序包（浏览器端调试文件）');
ok(!(odDir && ignoreVals.includes(dirName)),
  '开放数据域目录未被误排除（排掉它开放数据域就不加载了）', dirName || '(无)');

console.log('\n========== 五、sharedCanvas 的降级矩阵 ==========');

const G = require('../../who-is-circle/game.js');

ok(typeof G.resolveSharedCanvas === 'function', 'game.js 导出了 resolveSharedCanvas');

ok(G.resolveSharedCanvas(undefined) === null, '没有 wx（浏览器 / Node）→ null');
ok(G.resolveSharedCanvas(null) === null, 'wx 为 null → null');
ok(G.resolveSharedCanvas({}) === null, '老基础库没有 getOpenDataContext → null');
ok(G.resolveSharedCanvas({ getOpenDataContext: function () { throw new Error('boom'); } }) === null,
  'getOpenDataContext 抛异常 → null（不能把异常抛到主玩法里）');
ok(G.resolveSharedCanvas({ getOpenDataContext: function () { return {}; } }) === null,
  '返回对象里没有 canvas → null');

const fakeCanvas = { width: 500, height: 96 };
ok(G.resolveSharedCanvas({ getOpenDataContext: function () { return { canvas: fakeCanvas }; } }) === fakeCanvas,
  '正常情况 → 原样返回 sharedCanvas');

console.log(`\n结果：${pass} 通过 / ${fail} 失败\n`);
process.exit(fail ? 1 : 0);
