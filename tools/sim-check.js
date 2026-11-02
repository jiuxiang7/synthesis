#!/usr/bin/env node
/* =========================================================================
 *  离线体检：用真实的形状数据跑一局，量三件事
 *    1) 穿模：场上任意两颗果子之间最深的重叠（像素）
 *    2) 合成：该合的有没有合上（每一级各放一对，看是不是都变下一级）
 *    3) 性能：单帧物理耗时
 *
 *  用法：
 *    node tools/sim-check.js            # 正常对局（堆到中局）
 *    node tools/sim-check.js --stress   # 挤满（每 0.2 秒塞一颗）
 *    node tools/sim-check.js --merge    # 合成可靠性（每一级各放一对）
 * ========================================================================= */
'use strict';

var fs = require('fs');
var path = require('path');
var PK = require('../js/physics-kit.js');
var CFG = require('../js/fruits.js');

var FRUITS = CFG.fruits;
var PHYS = CFG.physics;
var W = CFG.world.width, H = CFG.world.height, WALL = CFG.world.wall;

/* 素材形状数据（assets-meta.js 是给浏览器写的，这里塞个假 window 读出来） */
var win = {};
new Function('window', fs.readFileSync(path.join(__dirname, '../js/assets-meta.js'), 'utf8'))(win);
var META = win.SPRITE_META;

function buildWorld() {
  var w = PK.create({
    width: W, height: H, wall: WALL,
    gravity: PHYS.gravity,
    substeps: PHYS.substeps,
    iterations: PHYS.iterations,
    restitution: PHYS.restitution,
    wallRestitution: PHYS.wallRestitution,
    friction: PHYS.friction,
    restThreshold: PHYS.restThreshold,
    mergePad: PHYS.mergePad,
    maxSpeed: PHYS.maxSpeed
  });

  var shapes = [], radii = [];
  for (var i = 0; i < FRUITS.length; i++) {
    var f = FRUITS[i];
    var m = META[f.sprite];
    radii.push(f.radius * (f.spriteScale || 1));
    if (m && m.circles && m.circles.length) {
      shapes.push({ parts: m.circles, rb: m.rb || 1.06 });
    } else {
      shapes.push({ parts: [[0, 0, 1]], rb: 1 });
    }
  }
  w.setTiers(shapes, radii);
  return w;
}

/* 固定随机数：两次跑落在同样的位置，才能对比改动 */
var seed = 20261102;
function rnd() {
  seed = (seed * 1103515245 + 12345) & 0x7fffffff;
  return seed / 0x7fffffff;
}

function runGame(opts) {
  var w = buildWorld();
  var frameMs = 1000 / 60, frames = opts.frames;
  var raf = 0;

  var levelSeq = [0, 1, 0, 2, 0, 1, 3, 0, 2, 1, 4, 0, 1, 2, 0, 3, 1, 5, 0, 2, 1, 0, 3, 2, 1, 4];
  var spawnEvery = opts.spawnEvery;
  var seqIdx = 0;

  var mergeCount = 0, maxSeen = 0;
  var overlapSamples = [], worstEver = 0, worstAt = '';
  var escaped = 0;

  for (var f = 0; f < frames; f++) {
    /* 投放：按固定节奏往场地里丢 */
    if (f % spawnEvery === 0 && w.balls.length < opts.cap && seqIdx < levelSeq.length) {
      var lv = levelSeq[seqIdx++];
      var r = w.radii[lv];
      var x = WALL + r + 4 + rnd() * Math.max(1, W - 2 * WALL - 2 * r - 8);
      w.add(lv, x, 60, 0, 120);
    }

    var t0 = process.hrtime.bigint();
    var evs = w.step(frameMs / 1000);
    var ms = Number(process.hrtime.bigint() - t0) / 1e6;

    for (var e = 0; e < evs.length; e++) {
      mergeCount++;
      var nt = evs[e].next;
      if (nt > maxSeen) maxSeen = nt;
    }

    if (f > 120) {
      var worst = 0, pair = '';
      for (var i = 0; i < w.balls.length; i++) {
        var a = w.balls[i];
        if (w.time - a.bornAt < 400) continue;
        for (var j = i + 1; j < w.balls.length; j++) {
          var b = w.balls[j];
          if (w.time - b.bornAt < 400) continue;
          var o = w.overlap(a, b);
          if (o && o.depth > worst) { worst = o.depth; pair = 'L' + a.tier + '/L' + b.tier; }
        }
      }
      if (worst > worstEver) { worstEver = worst; worstAt = 'f' + f + ' ' + pair; }
      overlapSamples.push(worst);
    }

    for (var k = 0; k < w.balls.length; k++) {
      var bb = w.balls[k];
      if (bb.x - bb.r < -2 || bb.x + bb.r > W + 2 || bb.y - bb.r > H + 2) escaped++;
    }

    raf += ms;
  }

  var sum = 0;
  for (var s = 0; s < overlapSamples.length; s++) sum += overlapSamples[s];

  return {
    balls: w.balls.length,
    merges: mergeCount,
    maxLevel: maxSeen,
    worst: worstEver,
    worstAt: worstAt,
    avg: sum / Math.max(1, overlapSamples.length),
    escaped: escaped,
    ms: raf / frames
  };
}

/* 每一级各放一对贴在一起的同级果子，看是不是都能合出下一级 */
function runMerges() {
  var rows = [];
  for (var lv = 0; lv <= FRUITS.length - 2; lv++) {
    var w = buildWorld();
    var r = w.radii[lv];
    var cy = H - WALL - r - 4;
    /* 故意叠一点：这个用例只验证「贴上了就会合」，不验证几何 */
    w.add(lv, W / 2 - r * 0.55, cy, 0, 0);
    w.add(lv, W / 2 + r * 0.55, cy, 0, 0);
    var merged = null;
    for (var f = 0; f < 40 && !merged; f++) {
      var evs = w.step(1 / 60);
      for (var e = 0; e < evs.length; e++) if (evs[e].level === lv) merged = evs[e];
    }
    rows.push({ level: lv, ok: !!merged, left: w.balls.length, next: merged ? merged.next : -1 });
  }
  return rows;
}

/* ---------------- 输出 ---------------- */

var mode = process.argv.indexOf('--merge') >= 0 ? 'merge'
         : process.argv.indexOf('--stress') >= 0 ? 'stress' : 'normal';

if (mode === 'merge') {
  var rows = runMerges();
  console.log('合成可靠性（每一级各放一对贴在一起）\n');
  console.log('等级   结果     合成出   场上剩余');
  var bad = 0;
  rows.forEach(function (r) {
    console.log('%s   %s   %s      %s',
      ('L' + r.level).padEnd(5),
      r.ok ? '✓ 合成' : '✗ 没合',
      (r.ok ? 'L' + r.next : '-').padEnd(8),
      r.left);
    if (!r.ok) bad++;
  });
  console.log('\n' + (bad ? '有 ' + bad + ' 级合不上 ✗' : '全部正常 ✓'));
  process.exit(bad ? 1 : 0);
}

var opts = mode === 'stress'
  ? { frames: 1100, spawnEvery: 12, cap: 30 }
  : { frames: 1100, spawnEvery: 26, cap: 24 };

var out = runGame(opts);
console.log('场景：' + (mode === 'stress' ? '拥挤（每 0.2 秒塞一颗）' : '正常对局'));
console.log('  场上果子       ' + out.balls);
console.log('  合成次数       ' + out.merges + '（最高到 L' + out.maxLevel + '）');
console.log('  最深重叠       ' + out.worst.toFixed(2) + ' px  ' + (out.worstAt || ''));
console.log('  平均重叠       ' + out.avg.toFixed(2) + ' px');
console.log('  出界帧次       ' + out.escaped);
console.log('  单帧物理耗时   ' + out.ms.toFixed(2) + ' ms');
