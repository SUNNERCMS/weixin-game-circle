"""端到端像素验收：统计截图里的关键颜色并断言界面状态
用法：python3 test/e2e/analyze.py [截图目录]
依赖：Pillow（pip install pillow）
"""
import os
import sys
from PIL import Image
from collections import Counter

S, L, T = 0.41459, 39.52, 31.0
PAPER = (239, 236, 228)


SHOTS = sys.argv[1] if len(sys.argv) > 1 else os.path.join(os.path.dirname(os.path.abspath(__file__)), '..', 'shots')


def load(name):
    path = name if os.path.isabs(name) else os.path.join(SHOTS, name)
    im = Image.open(path).convert('RGB')
    return im, im.load(), im.size


def canvas_box(p, size):
    W, H = size
    xs, ys = [], []
    for y in range(0, H, 3):
        for x in range(0, W, 3):
            q = p[x, y]
            if abs(q[0]-PAPER[0]) < 5 and abs(q[1]-PAPER[1]) < 5 and abs(q[2]-PAPER[2]) < 6:
                xs.append(x); ys.append(y)
    if not xs:
        return (int(L)+6, int(T)+6, int(L)+305, int(T)+667)
    return (min(xs)+3, min(ys)+3, max(xs)-3, max(ys)-3)


def classify(r, g, b):
    # 注意：橙 #D95F28=(217,95,40) 与红 #C0392B=(192,57,43) 的 g 值重叠，
    # 必须用 g>=70 把橙排除，否则诊断红字会被误判成橙色
    if r > 168 and 70 <= g < 148 and b < 118 and (r-b) > 62: return 'orange'
    if g > r+15 and g > 85 and b < 128 and r < 178:        return 'green'
    if r > 182 and 112 < g < 202 and b < 128:              return 'amber'
    if 150 < r <= 205 and 33 < g < 82 and 22 < b < 66:      return 'red'
    if sum((r, g, b)) < 215:                              return 'ink'
    if 88 < r < 152 and 84 < g < 146 and 74 < b < 138 and abs(r-g) < 26 and abs(g-b) < 26:
        return 'gray'
    return None


def max_blob(points):
    """最大 8-邻域连通簇大小：区分「整段笔迹变色」（上千像素的大簇）
    与预览壳 UI 覆盖层造成的零星色块（几十像素的小簇）"""
    pset = set(points)
    seen = set(); best = 0
    for p in points:
        if p in seen:
            continue
        stack = [p]; seen.add(p); n = 0
        while stack:
            cx, cy = stack.pop(); n += 1
            for dx in (-1, 0, 1):
                for dy in (-1, 0, 1):
                    q = (cx + dx, cy + dy)
                    if q in pset and q not in seen:
                        seen.add(q); stack.append(q)
        best = max(best, n)
    return best


def report(name, label):
    im, p, size = load(name)
    X0, Y0, X1, Y1 = canvas_box(p, size)
    cnt = Counter(); rows = Counter(); redrows = Counter(); colored = []
    for y in range(Y0, Y1):
        for x in range(X0, X1):
            k = classify(*p[x, y])
            if k:
                cnt[k] += 1
                if k in ('ink', 'red', 'gray'): rows[y] += 1
                if k == 'red': redrows[y] += 1
                if k in ('green', 'amber', 'red'): colored.append((x, y))
    cnt['maxblob'] = max_blob(colored)
    print('\n【%s】%s   画布 x %d..%d y %d..%d' % (name, label, X0, X1, Y0, Y1))
    print('  像素统计:', dict(cnt))
    if redrows:
        ys = sorted(redrows)
        print('  红字行: y %d..%d → 设计 %4.0f..%4.0f  共 %d px'
              % (ys[0], ys[-1], (ys[0]-T)/S, (ys[-1]-T)/S, sum(redrows.values())))
    bands = []; cur = None
    for y in sorted(rows):
        if rows[y] > 0:
            if cur is None: cur = [y, y, 0]
            cur[1] = y; cur[2] += rows[y]
        else:
            if cur: bands.append(cur); cur = None
    if cur: bands.append(cur)
    print('  文字带（页面y → 设计y）:')
    for b in bands:
        print('    y %d..%d → 设计 %4.0f..%4.0f  像素 %d' %
              (b[0], b[1], (b[0]-T)/S, (b[1]-T)/S, b[2]))
    return cnt


c_live = report('live.png', '画到一半（笔迹应为单色墨线）')
c_res = report('result.png', '完整圆结算')
c_gap = report('gap.png', '残缺圆结算（诊断红字 + 升级提示）')
c_re = report('redraw.png', '结算后落笔重画')
c_home = report('home.png', '返回首页')

print('\n' + '=' * 70)
print('断言：')

FAILED = []


def chk(cond, text):
    print(('  ✅ ' if cond else '  ❌ ') + text)
    if not cond:
        FAILED.append(text)


# v0.4 去掉实时反馈后，笔迹全程单色墨线：不允许出现成片的彩色分段
# （预览壳 UI 覆盖层会留下几十像素的零星色块，用最大连通簇区分）
chk(c_live['maxblob'] < 150 and c_live['green'] + c_live['amber'] + c_live['red'] < 120,
    '笔迹为单色墨线（无彩色分段）  彩色总数=%d 最大色块=%d'
    % (c_live['green'] + c_live['amber'] + c_live['red'], c_live['maxblob']))
chk(c_live['ink'] > 200, '画到一半笔迹已渲染  ink=%d' % c_live['ink'])
chk(c_res['orange'] > 300, '结算页主色按钮存在  orange=%d' % c_res['orange'])
chk(c_res['amber'] > 100, '新纪录徽章存在  amber=%d' % c_res['amber'])
# v0.5 起结算卡片不再显示「诊断红字」与「距下一档还差 X 分」两行
chk(c_gap['red'] < 20, '结算卡片已无诊断红字  red=%d' % c_gap['red'])
chk(c_gap['orange'] > 300, '残缺圆结算按钮存在  orange=%d' % c_gap['orange'])
chk(c_re['orange'] < 150, '重画后结算卡片已清除  orange=%d' % c_re['orange'])
chk(c_home['orange'] > 300, '首页开画按钮存在  orange=%d' % c_home['orange'])
print('=' * 70)
print('结果：%d 条通过 / %d 条失败' % (8 - len(FAILED), len(FAILED)))
sys.exit(1 if FAILED else 0)
