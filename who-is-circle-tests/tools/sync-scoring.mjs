/**
 * 把 `shared/scoring.js` 同步到 `cloudfunctions/score/scoring.js`
 *
 * 为什么需要这个脚本：
 *   云函数跑在服务端沙盒里，够不到小游戏项目根目录的 shared/，
 *   所以必须在 cloudfunctions/score/ 里放一份副本。
 *   但**两份算法必须永远是同一份** —— 云端算的分要能和客户端对得上，
 *   客户端改了分、云端没跟着改，比分就对不上了。
 *
 *   所以：拷贝是机械的、不允许手改；一致性由 sha256 守卫测试盯着
 *   （who-is-circle-tests/unit/cloudfn.test.js）。
 *
 * 用法：npm run sync:cloud
 */
import fs from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';
import { fileURLToPath } from 'node:url';

const here = path.dirname(fileURLToPath(import.meta.url));
const gameRoot = path.join(here, '../../who-is-circle');

const src = path.join(gameRoot, 'shared', 'scoring.js');
const dst = path.join(gameRoot, 'cloudfunctions', 'score', 'scoring.js');

const sha = (buf) => crypto.createHash('sha256').update(buf).digest('hex');

if (!fs.existsSync(src)) {
  console.error('❌ 源文件不存在：' + src);
  process.exit(1);
}

const content = fs.readFileSync(src);
const before = fs.existsSync(dst) ? sha(fs.readFileSync(dst)) : null;

fs.mkdirSync(path.dirname(dst), { recursive: true });
fs.writeFileSync(dst, content);

const after = sha(content);
console.log('源    ' + path.relative(gameRoot, src) + '  sha256=' + after.slice(0, 16));
console.log('产物  ' + path.relative(gameRoot, dst) + '  sha256=' + after.slice(0, 16));

if (before === null) console.log('✅ 已生成（原先不存在）');
else if (before === after) console.log('✅ 已是最新（无变化）');
else {
  console.log('🔄 已同步（原先 ' + before.slice(0, 16) + '）');
  console.log('   ⚠️  云函数若已部署，需要重新上传才会生效');
}
