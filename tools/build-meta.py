#!/usr/bin/env python3
# -*- coding: utf-8 -*-
"""给每张素材算「一组内切小圆」的形状数据（供 js/physics-kit.js 用）。

为什么是小圆而不是多边形：
    物理内核用的是位置约束（PBD），每次迭代只做一件事 —— 在最近的一对
    小圆上把两颗果子按质量反比推开。小圆天然适合这种求解：算距离只是几次
    乘法；多边形要先做 SAT 求最小穿透轴，慢一个量级，而一帧要算几十次。

    另外内切圆只会「盖不满」，不会「鼓出去」：
      · 盖不满 → 两个果子贴得比看起来紧一点点（几个亚像素，看不出来）
      · 鼓出去 → 撑出一圈看不见的边，别的果子压在上面 = "悬空感"
    所以宁可多加几个小圆，也不让圆的并集超出轮廓。

流程：
    素材 → 按 bake() 同款逻辑栅格化到 512、裁掉透明边
         → 缩到 256 网格做距离变换（两遍 chamfer）
         → 贪心：每次挑「未被覆盖、离边界最远」的点，以它到边界的距离为半径放圆
         → 归一化（以素材半径 r 为 1）输出
         → 自检：把圆重新画出来，和原始 mask 逐像素比，打印漏盖 / 外溢

用法：
    python tools/build-meta.py             # 生成 js/assets-meta.js
    python tools/build-meta.py --preview   # 顺便输出 tools/_preview/*.png 供肉眼检查
"""
import json
import math
import os
import sys

from PIL import Image, ImageDraw

SZ = 512                 # 和 game.js 的 bake() 一致
GRID = 256               # 形状计算用的网格（够精细，python 也跑得动）
alpha_solid = 110        # 轮廓阈值：半透明羽化边和投影不算实体
alpha_bbox = 8           # 裁边阈值，和 bake() 一致

MIN_RADIUS = 1.2         # 网格像素：比这还小的碎块不值得单独一个圆
MAX_CIRCLES = 30         # 单张素材最多几个圆（越多越准，物理越慢）
FILL_CIRCLES = 6         # 盖完之后再给"漏得最深的地方"补几个圆
COVER_TARGET = 0.995     # 盖满这个比例就停
PAD = 3.0                # 每个圆的额外余量（网格像素）。1 格 = 素材半径的 1/128，
                         # 所以 3 格在最胖的奶马身上也只有 1.8px，肉眼看不出来；
                         # 但它能把细腿、尾巴这些地方的边缘盖住 —— 漏盖才是穿模的来源。

ROOT = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
FRUIT_DIR = os.path.join(ROOT, 'assets', 'fruits')
OUT_JS = os.path.join(ROOT, 'js', 'assets-meta.js')
PREVIEW_DIR = os.path.join(ROOT, 'tools', '_preview')


# --------------------------------------------------------------------------
#  1. 栅格化（复刻 game.js bake()）
# --------------------------------------------------------------------------

def bake_like_browser(path):
    im = Image.open(path).convert('RGBA')
    iw, ih = im.size
    k = min(SZ / iw, SZ / ih)
    dw, dh = max(1, round(iw * k)), max(1, round(ih * k))

    probe = Image.new('RGBA', (SZ, SZ), (0, 0, 0, 0))
    probe.paste(im.resize((dw, dh), Image.LANCZOS), ((SZ - dw) // 2, (SZ - dh) // 2))

    alpha = probe.split()[3]
    bbox = alpha.point(lambda v: 255 if v > alpha_bbox else 0).getbbox()
    if not bbox:
        raise RuntimeError('素材全是透明的：' + path)
    bx, by, bx1, by1 = bbox
    bw, bh = bx1 - bx, by1 - by

    s = min(SZ / bw, SZ / bh)
    w2, h2 = max(1, round(bw * s)), max(1, round(bh * s))
    out = Image.new('RGBA', (SZ, SZ), (0, 0, 0, 0))
    out.paste(probe.crop((bx, by, bx1, by1)).resize((w2, h2), Image.LANCZOS),
              ((SZ - w2) // 2, (SZ - h2) // 2))
    return out, [bx, by, bw, bh]


def build_mask(img):
    """GRID 网格上的实心 mask。"""
    small = img.split()[3].resize((GRID, GRID), Image.LANCZOS)
    px = small.load()
    mask = bytearray(GRID * GRID)
    for y in range(GRID):
        base = y * GRID
        for x in range(GRID):
            if px[x, y] > alpha_solid:
                mask[base + x] = 1
    return mask


# --------------------------------------------------------------------------
#  2. 距离变换（每个实心像素离最近背景像素有多远）
# --------------------------------------------------------------------------

def distance_transform(mask):
    INF = 1e9
    d = [INF] * (GRID * GRID)
    for i in range(GRID * GRID):
        if not mask[i]:
            d[i] = 0.0
    a, b = 1.0, math.sqrt(2.0)

    for y in range(GRID):
        row = y * GRID
        for x in range(GRID):
            i = row + x
            v = d[i]
            if v == 0.0:
                continue
            if x > 0:
                t = d[i - 1] + a
                if t < v: v = t
            if y > 0:
                t = d[i - GRID] + a
                if t < v: v = t
                if x > 0:
                    t = d[i - GRID - 1] + b
                    if t < v: v = t
                if x < GRID - 1:
                    t = d[i - GRID + 1] + b
                    if t < v: v = t
            d[i] = v

    for y in range(GRID - 1, -1, -1):
        row = y * GRID
        for x in range(GRID - 1, -1, -1):
            i = row + x
            v = d[i]
            if v == 0.0:
                continue
            if x < GRID - 1:
                t = d[i + 1] + a
                if t < v: v = t
            if y < GRID - 1:
                t = d[i + GRID] + a
                if t < v: v = t
                if x < GRID - 1:
                    t = d[i + GRID + 1] + b
                    if t < v: v = t
                if x > 0:
                    t = d[i + GRID - 1] + b
                    if t < v: v = t
            d[i] = v
    return d


# --------------------------------------------------------------------------
#  3. 贪心铺圆
# --------------------------------------------------------------------------

def cover(mask, dist):
    """贪心铺圆：每次挑「还没被盖住、离边界最远」的点，用它到边界的距离当半径。

    从最厚的地方开始，自然先盖住躯干，再沿着腿、耳朵、尾巴这些细处补小圆。
    最后再单独做一轮"残区补圆"：只看还没盖住的地方，把漏得最深的几处补上 ——
    不然细长的尾巴、耳朵会因为面积小、永远排在最后而完全漏掉。
    """
    total = sum(mask)
    covered = bytearray(GRID * GRID)
    circles = []

    cand = [(dist[i], i) for i in range(GRID * GRID) if mask[i]]
    cand.sort(reverse=True)

    def paint(cx, cy, r):
        x0, x1 = max(0, int(cx - r - 1)), min(GRID - 1, int(cx + r + 1))
        y0, y1 = max(0, int(cy - r - 1)), min(GRID - 1, int(cy + r + 1))
        rr = r * r
        for yy in range(y0, y1 + 1):
            base = yy * GRID
            dy2 = (yy - cy) * (yy - cy)
            for xx in range(x0, x1 + 1):
                if covered[base + xx]:
                    continue
                dx = xx - cx
                if dx * dx + dy2 <= rr:
                    covered[base + xx] = 1

    def covered_count():
        return sum(1 for i in range(GRID * GRID) if mask[i] and covered[i])

    for dv, i in cand:
        if len(circles) >= MAX_CIRCLES:
            break
        if covered[i]:
            continue
        r = dv + PAD
        if r < MIN_RADIUS:
            continue
        circles.append((i % GRID, i // GRID, r))
        paint(i % GRID, i // GRID, r)
        if covered_count() >= total * COVER_TARGET:
            break

    for _ in range(FILL_CIRCLES):
        best, bi = 0.0, -1
        for i in range(GRID * GRID):
            if mask[i] and not covered[i] and dist[i] > best:
                best, bi = dist[i], i
        if bi < 0 or best < 1.0:
            break
        circles.append((bi % GRID, bi // GRID, best + PAD * 0.5))
        paint(bi % GRID, bi // GRID, best + PAD * 0.5)

    return circles, covered_count(), total


def depth_to_covered(mask, covered):
    """没盖住的像素离"已盖住的像素"有多远（网格像素）= 视觉误差的深度。"""
    INF = 1e9
    d = [0.0 if covered[i] else INF for i in range(GRID * GRID)]
    a, b = 1.0, math.sqrt(2.0)
    for y in range(GRID):
        for x in range(GRID):
            i = y * GRID + x
            v = d[i]
            if v == 0.0:
                continue
            if x > 0: v = min(v, d[i - 1] + a)
            if y > 0:
                v = min(v, d[i - GRID] + a)
                if x > 0: v = min(v, d[i - GRID - 1] + b)
                if x < GRID - 1: v = min(v, d[i - GRID + 1] + b)
            d[i] = v
    for y in range(GRID - 1, -1, -1):
        for x in range(GRID - 1, -1, -1):
            i = y * GRID + x
            v = d[i]
            if v == 0.0:
                continue
            if x < GRID - 1: v = min(v, d[i + 1] + a)
            if y < GRID - 1:
                v = min(v, d[i + GRID] + a)
                if x < GRID - 1: v = min(v, d[i + GRID + 1] + b)
                if x > 0: v = min(v, d[i + GRID - 1] + b)
            d[i] = v
    worst = 0.0
    for i in range(GRID * GRID):
        if mask[i] and not covered[i] and d[i] > worst:
            worst = d[i]
    return worst


def measure(mask, circles):
    """重新栅格化，统计漏盖 / 外溢 / 最深处（面积按素材面积归一）。"""
    area = sum(mask)
    covered = bytearray(GRID * GRID)      # 按像素去重，不能按"命中次数"累加
    spill = 0
    for cx, cy, r in circles:
        x0, x1 = max(0, int(cx - r - 1)), min(GRID - 1, int(cx + r + 1))
        y0, y1 = max(0, int(cy - r - 1)), min(GRID - 1, int(cy + r + 1))
        rr = r * r
        for yy in range(y0, y1 + 1):
            base = yy * GRID
            dy2 = (yy - cy) * (yy - cy)
            for xx in range(x0, x1 + 1):
                dx = xx - cx
                if dx * dx + dy2 > rr:
                    continue
                covered[base + xx] = 1
    hit_in = 0
    for i in range(GRID * GRID):
        if covered[i]:
            if mask[i]:
                hit_in += 1
            else:
                spill += 1
    miss = max(0.0, 1.0 - hit_in / area)
    deepest = depth_to_covered(mask, covered)
    return miss, spill / area, deepest


# --------------------------------------------------------------------------
#  4. 归一化 + 输出
# --------------------------------------------------------------------------

def normalize(circles):
    half = GRID / 2.0
    out = []
    for cx, cy, r in circles:
        out.append([
            round((cx - half) / half, 4),
            round((cy - half) / half, 4),
            round(r / half, 4)
        ])
    rb = 0.0
    for cx, cy, r in out:
        rb = max(rb, math.hypot(cx, cy) + r)
    return out, round(rb, 4)


def preview(name, img, circles, out_dir):
    os.makedirs(out_dir, exist_ok=True)
    base = img.resize((GRID, GRID), Image.LANCZOS).convert('RGBA')
    layer = Image.new('RGBA', (GRID, GRID), (0, 0, 0, 0))
    dr = ImageDraw.Draw(layer)
    for cx, cy, r in circles:
        dr.ellipse([cx - r, cy - r, cx + r, cy + r],
                   outline=(232, 40, 120, 235), width=1)
    out = Image.alpha_composite(base, layer)
    out = out.resize((GRID * 2, GRID * 2), Image.LANCZOS)
    out.save(os.path.join(out_dir, name + '.png'))


def main():
    files = sorted(f for f in os.listdir(FRUIT_DIR)
                   if f.lower().endswith(('.webp', '.png', '.jpg', '.jpeg')))
    if not files:
        print('assets/fruits 里没找到素材', file=sys.stderr)
        return 1

    do_preview = '--preview' in sys.argv
    meta = {}
    problems = []

    print('%-24s %5s %8s %8s %8s %8s'
          % ('素材', '圆数', '覆盖率', '漏盖', '外溢', '最深'))
    print('-' * 70)

    for name in files:
        path = os.path.join(FRUIT_DIR, name)
        img, box = bake_like_browser(path)
        mask = build_mask(img)
        if not any(mask):
            problems.append('%s: 整张图都是透明的' % name)
            continue

        dist = distance_transform(mask)
        circles, got, total = cover(mask, dist)
        miss, spill, deepest = measure(mask, circles)
        parts, rb = normalize(circles)

        key = 'assets/fruits/' + name
        meta[key] = {'box': box, 'circles': parts, 'rb': rb}

        if do_preview:
            preview(os.path.splitext(name)[0], img, circles, PREVIEW_DIR)

        print('%-24s %5d %7.1f%% %7.2f%% %7.2f%% %6.1f 格'
              % (name, len(circles), 100.0 * got / total, miss * 100,
                 spill * 100, deepest))

        if miss > 0.02:
            problems.append('%s: 漏盖 %.1f%% 偏大（会显得贴得比看着紧）'
                            % (name, miss * 100))
        if spill > 0.05:
            problems.append('%s: 外溢 %.1f%% 偏大（会显得隔空相撞）'
                            % (name, spill * 100))

    js = ['/* =========================================================================',
          ' *  素材预计算数据（由 tools/build-meta.py 生成，不要手改）',
          ' *  ---------------------------------------------------------------',
          ' *  circles —— 贴着素材轮廓铺的「内切小圆」，单位以素材半径 r 为 1：',
          ' *             [x, y, r]，(x, y) 是圆心相对素材中心的偏移，r 是半径。',
          ' *             物理内核拿它做位置约束：同级的两颗只要有一对圆贴上就合成。',
          ' *  rb      —— 包围圆半径（快速粗筛用）',
          ' *  box     —— 主体在 512×512 栅格里的包围盒，和历史数据保持一致',
          ' *',
          ' *  为什么用小圆而不是多边形：物理是「每帧多次位置投影」的求解方式，',
          ' *  圆算距离只要几次乘法；多边形得先求最小穿透轴，慢一个量级，',
          ' *  而且一帧要算几十次，手机上扛不住。',
          ' *',
          ' *  内切圆只会「盖不满」，不会「鼓出去」：漏盖表现为贴得略紧（看不出来），',
          ' *  外溢才会撑出看不见的边（那才是"悬空感"）。所以宁可多加几个小圆，',
          ' *  也不让圆的并集超出轮廓。',
          ' * ========================================================================= */',
          'window.SPRITE_META = {']
    keys = sorted(meta.keys())
    for i, k in enumerate(keys):
        v = meta[k]
        cs = ','.join('[%s,%s,%s]' % (c[0], c[1], c[2]) for c in v['circles'])
        js.append("  '%s': { box: %s, rb: %s, circles: [%s] }%s"
                  % (k, json.dumps(v['box']), v['rb'], cs,
                     ',' if i < len(keys) - 1 else ''))
    js.append('};')
    js.append('')

    with open(OUT_JS, 'w', encoding='utf-8') as f:
        f.write('\n'.join(js))

    print('-')
    print('已写入 %s（%d 张素材，%.1f KB）'
          % (os.path.relpath(OUT_JS, ROOT), len(meta),
             os.path.getsize(OUT_JS) / 1024.0))

    if problems:
        print('\n需要注意：')
        for p in problems:
            print('  · ' + p)
    return 0


if __name__ == '__main__':
    sys.exit(main())
