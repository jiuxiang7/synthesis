/* =========================================================================
 *  合成大奶龙 · 物理内核
 *  -------------------------------------------------------------------------
 *  位置约束求解（PBD），碰撞与合成的思路来自 BigNaiWa v1，形状数据用的是
 *  我们自己素材的轮廓：
 *
 *    · 一颗果子 = 一组「内切小圆」，沿着素材轮廓铺开（不是一个大圆）
 *    · 每个子步：积分 → 若干次约束迭代（墙 + 小圆两两求最近间距）→ 由位移反推速度
 *    · 合成直接在约束迭代里判定：同级 + 最近的一对圆真贴上了 → 当场标记、
 *      当场生成下一级
 *
 *  和之前用 Matter.js 的做法相比，这里少了两件事，也就少了两类 bug：
 *    ① 不再依赖碰撞事件。事件是「这一帧新产生的接触」，漏一次就永远补不上；
 *       这里每帧拿几何重新算，贴上了就是贴上了。
 *    ② 不再需要「事后再把谁挤开」。重叠由位置约束本身在消：每次迭代都沿最近
 *       间距按质量反比把两颗推开，一帧三个子步足够收敛。不存在「四周受力对称
 *       推不出来」的死角 —— 那种死角只有「当刚体 + 每步只修一次」才会出现。
 * ========================================================================= */
(function (root, factory) {
  var api = factory();
  if (typeof module === 'object' && module.exports) module.exports = api;
  if (root) root.PhysicsKit = api;
})(typeof window !== 'undefined' ? window : null, function () {
  'use strict';

  var DEFAULTS = {
    width: 384,
    height: 584,
    wall: 12,
    gravity: 2400,         // px/s²
    substeps: 3,           // 每帧物理子步
    iterations: 6,         // 每个子步的约束迭代次数
    restitution: 0.30,     // 果子之间的弹性
    wallRestitution: 0.38, // 撞墙 / 撞地的弹性
    restThreshold: 70,     // 撞击速度低于此值不反弹（保证堆叠稳、不抖）
    friction: 0.955,       // 接触时的摩擦（每个子步）
    mergePad: 1.0,         // 合成判定的接触容差（px）
    maxSpeed: 1500,        // 速度上限，防止极快的小果子钻过去
    maxOmega: 9,           // 角速度上限（rad/s），被挤飞时不至于疯狂打转
    angularDamping: 0.992, // 每个子步的角速度衰减
    /* 静止后"扶正"的力度：0 = 完全自由翻滚（停住时是什么角度就是什么角度）。
     * 角色类素材倒立着停住会很怪，所以默认给一点点，只在几乎不动时才起作用。 */
    upright: 6,
    maxCorr: 8,            // 单次迭代最多推开多少像素（太大反而抖）
    squashMax: 0.22,       // 最大挤压变形（纯视觉）
    squashDecay: 9,
    topWall: true          // 顶部也拦一下，别让果子飞出画面
  };

  function pick(v, d) { return (typeof v === 'number' && isFinite(v)) ? v : d; }

  var UNIT_SHAPE = { parts: [[0, 0, 1]], rb: 1 };

  /* 把局部小圆换算到世界坐标 —— 跟着刚体一起转。
   * 这是「画面能让素材转」的前提：角色转了多少度，碰撞小圆就转多少度，
   * 两边永远是同一个姿势，不会出现「看着转了、碰撞还是站着的」。 */
  function syncParts(b) {
    var r = b.r, parts = b.parts, n = parts.length;
    var wx = b.wx, wy = b.wy, ws = b.ws;
    var c = b.cos, s = b.sin;
    for (var i = 0; i < n; i++) {
      var p = parts[i];
      var ox = p[0] * r, oy = p[1] * r;
      wx[i] = b.x + ox * c - oy * s;
      wy[i] = b.y + ox * s + oy * c;
      ws[i] = p[2] * r;
    }
  }

  /* 改角度时顺手把 cos/sin 缓存好（求解里要调几百次，别每次算三角函数） */
  function setAngle(b, a) {
    b.angle = a;
    b.cos = Math.cos(a);
    b.sin = Math.sin(a);
  }

  function World(opts) {
    opts = opts || {};
    this.cfg = {
      width: pick(opts.width, DEFAULTS.width),
      height: pick(opts.height, DEFAULTS.height),
      wall: pick(opts.wall, DEFAULTS.wall),
      gravity: pick(opts.gravity, DEFAULTS.gravity),
      substeps: Math.max(1, Math.round(pick(opts.substeps, DEFAULTS.substeps))),
      iterations: Math.max(1, Math.round(pick(opts.iterations, DEFAULTS.iterations))),
      restitution: pick(opts.restitution, DEFAULTS.restitution),
      wallRestitution: pick(opts.wallRestitution, DEFAULTS.wallRestitution),
      restThreshold: pick(opts.restThreshold, DEFAULTS.restThreshold),
      friction: pick(opts.friction, DEFAULTS.friction),
      upright: pick(opts.upright, DEFAULTS.upright),
      mergePad: pick(opts.mergePad, DEFAULTS.mergePad),
      maxSpeed: pick(opts.maxSpeed, DEFAULTS.maxSpeed),
      maxCorr: pick(opts.maxCorr, DEFAULTS.maxCorr),
      squashMax: pick(opts.squashMax, DEFAULTS.squashMax),
      squashDecay: pick(opts.squashDecay, DEFAULTS.squashDecay),
      topWall: opts.topWall !== false
    };

    this.shapes = [];
    this.radii = [];
    this.balls = [];
    this.time = 0;          // ms
    this.events = [];       // 最近一次 step() 里发生的合成
    this.seq = 0;
    this.stats = { merges: 0, steps: 0 };
  }

  World.prototype.setTiers = function (shapes, radii) {
    this.shapes = shapes || [];
    this.radii = radii || [];
    return this;
  };

  /* ------------------------------------------------------------------ */
  /*  建 / 删                                                            */
  /* ------------------------------------------------------------------ */

  World.prototype.add = function (tier, x, y, vx, vy) {
    var r = this.radii[tier] || 20;
    var sh = this.shapes[tier] || UNIT_SHAPE;
    var n = sh.parts.length;
    var mass = Math.max(1, r * r);

    var b = {
      id: ++this.seq,
      tier: tier,
      x: x, y: y,
      px: x, py: y,
      vx: vx || 0, vy: vy || 0,
      r: r,
      mass: mass,
      invMass: 1 / mass,
      parts: sh.parts,
      rb: sh.rb * r,
      wx: new Float32Array(n),
      wy: new Float32Array(n),
      ws: new Float32Array(n),
      angle: 0, cos: 1, sin: 0,
      prevAngle: 0, omega: 0,
      /* 转动惯量（圆盘）：I = ½ m r²。质量已经取 r²，所以 I = ½ r⁴。
       * 大果子因此很难被转起来，小果子一碰就打转 —— 这个比例是对的。 */
      invI: 2 / (mass * r * r),
      dead: false,
      merged: false,
      contacts: 0,
      pvx: 0, pvy: 0,
      sq: 0, sqA: 0,
      bornAt: this.time,
      popAt: -1,          // >=0 表示正在"弹出来"（纯视觉）
      landed: false
    };
    syncParts(b);
    this.clampInside(b);
    this.balls.push(b);
    return b;
  };

  World.prototype.remove = function (ball) {
    var i = this.balls.indexOf(ball);
    if (i >= 0) this.balls.splice(i, 1);
    ball.dead = true;
  };

  World.prototype.reset = function () {
    this.balls.length = 0;
    this.time = 0;
    this.stats.merges = 0;
  };

  /* 把果子整个夹回场地内（合成出来的更大，不夹会瞬间穿墙） */
  World.prototype.clampInside = function (b) {
    var cfg = this.cfg;
    var x0 = Infinity, x1 = -Infinity, y1 = -Infinity;
    var n = b.wx.length;
    syncParts(b);                       // 形状是转过的，包围盒得按实际姿势算
    for (var i = 0; i < n; i++) {
      var ox = b.wx[i] - b.x, oy = b.wy[i] - b.y, s = b.ws[i];
      if (ox - s < x0) x0 = ox - s;
      if (ox + s > x1) x1 = ox + s;
      if (oy + s > y1) y1 = oy + s;
    }
    var dx = 0, dy = 0;
    if (b.x + x0 < cfg.wall) dx = cfg.wall - (b.x + x0);
    else if (b.x + x1 > cfg.width - cfg.wall) dx = (cfg.width - cfg.wall) - (b.x + x1);
    if (b.y + y1 > cfg.height - cfg.wall) dy = (cfg.height - cfg.wall) - (b.y + y1);
    if (dx || dy) {
      b.x += dx;
      b.y += dy;
      b.px = b.x;
      b.py = b.y;
      syncParts(b);
    }
  };

  /* ------------------------------------------------------------------ */
  /*  主循环                                                             */
  /* ------------------------------------------------------------------ */

  /* 推进一帧，返回本次发生的合成：
   *   [{ level, next, x, y, ball }]
   *   next === -1 表示这一级已经满了（下一级要不要生成、生成什么由游戏决定，
   *   比如"两个满级相撞变回低级"这种规则） */
  World.prototype.step = function (dt) {
    this.events.length = 0;
    if (!(dt > 0)) return this.events;
    this.time += dt * 1000;
    var n = this.cfg.substeps;
    var sub = dt / n;
    for (var i = 0; i < n; i++) this._substep(sub);
    this.stats.steps++;
    return this.events;
  };

  World.prototype._substep = function (dt) {
    var cfg = this.cfg, balls = this.balls;
    var i, k;

    /* --- 1. 积分 --- */
    var maxV = cfg.maxSpeed;
    for (i = 0; i < balls.length; i++) {
      var b = balls[i];
      if (b.dead) continue;

      var sp2 = b.vx * b.vx + b.vy * b.vy;
      if (sp2 > maxV * maxV) {
        var kv = maxV / Math.sqrt(sp2);
        b.vx *= kv; b.vy *= kv;
      }

      b.px = b.x;
      b.py = b.y;
      b.prevAngle = b.angle;
      b.pvx = b.vx;
      b.pvy = b.vy;
      b.vy += cfg.gravity * dt;

      b.omega *= cfg.angularDamping;
      if (b.omega > cfg.maxOmega) b.omega = cfg.maxOmega;
      else if (b.omega < -cfg.maxOmega) b.omega = -cfg.maxOmega;

      b.x += b.vx * dt;
      b.y += b.vy * dt;
      if (b.omega) setAngle(b, b.angle + b.omega * dt);
      b.contacts = 0;
      syncParts(b);
    }

    /* --- 2. 约束迭代 --- */
    var contacts = [];       // 只记第一轮，给弹性冲量用
    var pairs = [];          // 本子步要合成的一对对
    for (k = 0; k < cfg.iterations; k++) {
      this._solveWalls(k === 0 ? contacts : null);
      this._solvePairs(k === 0 ? contacts : null, k === 0, pairs);
    }
    this._solveWalls(null);  // 收尾：果子分离可能把谁顶出墙外

    /* --- 3. 由位移反推速度 + 摩擦 --- */
    var invDt = 1 / dt;
    for (i = 0; i < balls.length; i++) {
      var bb = balls[i];
      if (bb.dead) continue;

      bb.vx = (bb.x - bb.px) * invDt;
      bb.vy = (bb.y - bb.py) * invDt;
      bb.omega = (bb.angle - bb.prevAngle) * invDt;      // 和线速度同一套：由位移反推
      if (bb.omega > cfg.maxOmega) bb.omega = cfg.maxOmega;
      else if (bb.omega < -cfg.maxOmega) bb.omega = -cfg.maxOmega;

      /* 挤压变形慢慢回弹（纯视觉） */
      if (bb.sq > 0) bb.sq = Math.max(0, bb.sq - bb.sq * cfg.squashDecay * dt);

      if (bb.contacts > 0) {
        bb.vx *= cfg.friction;
        bb.vy *= cfg.friction;
        bb.omega *= 0.90;                                // 接触时转动很快被吃掉，堆稳了就不乱转

        /* 扶正：已经停稳了，但姿势是歪的 → 慢慢转回"立正"。
         * 只在几乎不动时接管角速度，所以翻滚、被挤、下落的过程完全不受影响。 */
        var resting = false;
        if (cfg.upright > 0 && bb.sq < 0.03 &&
            bb.vx * bb.vx + bb.vy * bb.vy < 3600 && Math.abs(bb.omega) < 2.5) {
          var TAU = Math.PI * 2;
          var lean = bb.angle - Math.round(bb.angle / TAU) * TAU;   // 离最近的"立正"差多少（-π~π）
          if (Math.abs(lean) > 0.05) {
            var want = -lean * 3;
            if (want > 1.6) want = 1.6;
            else if (want < -1.6) want = -1.6;
            bb.omega = want;
            resting = true;
          } else {
            bb.omega = 0;
            resting = true;
          }
        }

        /* 收尾：几乎不动了就把残余速度清零。位置约束收敛后总会剩一点残余位移，
         * 不清掉的话整堆东西会以 1px/s 的速度慢慢"爬"，看起来像画面在漂。 */
        if (!resting && bb.vx * bb.vx + bb.vy * bb.vy < 400 && Math.abs(bb.omega) < 0.9) {
          bb.vx = 0; bb.vy = 0; bb.omega = 0;
        }
      }

      if (!bb.landed && (bb.contacts > 0 || this.time - bb.bornAt > 900)) bb.landed = true;
    }

    /* --- 4. 弹性冲量 --- */
    this._impulse(contacts);

    /* --- 5. 合成落地 --- */
    if (pairs.length) this._applyMerges(pairs);
  };

  /* ------------------------------------------------------------------ */
  /*  约束：墙                                                            */
  /* ------------------------------------------------------------------ */

  World.prototype._solveWalls = function (contacts) {
    var cfg = this.cfg, balls = this.balls;
    var W = cfg.width, H = cfg.height, WALL = cfg.wall;

    for (var i = 0; i < balls.length; i++) {
      var b = balls[i];
      if (b.dead) continue;

      var pL = 0, pR = 0, pD = 0, pU = 0;
      var kL = 0, kR = 0, kD = 0, kU = 0;
      var n = b.wx.length;
      for (var k = 0; k < n; k++) {
        var x = b.wx[k], y = b.wy[k], rr = b.ws[k];
        var l = WALL - (x - rr);          if (l > pL) { pL = l; kL = k; }
        var rgt = (x + rr) - (W - WALL);  if (rgt > pR) { pR = rgt; kR = k; }
        var dn = (y + rr) - (H - WALL);   if (dn > pD) { pD = dn; kD = k; }
        if (cfg.topWall) {
          var up = 0 - (y - rr);          if (up > pU) { pU = up; kU = k; }
        }
      }

      if (!(pL || pR || pD || pU)) continue;

      /* 每个方向单独修：接触点在那枚小圆的边上，所以推力偏移中心会带一点转动
       * （站在桌角、被墙边顶住时会自然歪一下，不会像根柱子一样永远笔直） */
      if (pL) wallPush(b, 1, 0, pL, kL);
      if (pR) wallPush(b, -1, 0, pR, kR);
      if (pD) wallPush(b, 0, -1, pD, kD);
      if (pU) wallPush(b, 0, 1, pU, kU);
      b.contacts++;

      if (contacts) {
        if (pL) contacts.push({ ball: b, nx: 1, ny: 0 });
        if (pR) contacts.push({ ball: b, nx: -1, ny: 0 });
        if (pD) contacts.push({ ball: b, nx: 0, ny: -1 });
        if (pU) contacts.push({ ball: b, nx: 0, ny: 1 });
      }
      syncParts(b);
    }
  };

  /* 把一枚小圆顶出墙外，并把推力"作用在接触点"上：
   * 同样的位移，接触点离中心越偏，带出来的转动越多（陀螺力矩的简化版）。 */
  function wallPush(b, nx, ny, depth, idx) {
    var rr = b.ws[idx];
    var rax = (b.wx[idx] - b.x) - nx * rr;
    var ray = (b.wy[idx] - b.y) - ny * rr;
    var cn = rax * ny - ray * nx;
    var wsum = b.invMass + b.invI * cn * cn;
    var lam = depth / wsum;

    b.x += nx * lam * b.invMass;
    b.y += ny * lam * b.invMass;
    if (cn) setAngle(b, b.angle + cn * lam * b.invI);
  }

  /* ------------------------------------------------------------------ */
  /*  约束：小圆两两求最近间距                                            */
  /* ------------------------------------------------------------------ */

  World.prototype._solvePairs = function (contacts, firstIter, merges) {
    var cfg = this.cfg, balls = this.balls;
    var pad = cfg.mergePad;

    for (var i = 0; i < balls.length; i++) {
      var a = balls[i];
      if (a.dead) continue;

      for (var j = i + 1; j < balls.length; j++) {
        var b = balls[j];
        if (b.dead) continue;

        /* 包围圆粗筛 */
        var cdx = b.x - a.x, cdy = b.y - a.y, rbSum = a.rb + b.rb;
        if (cdx * cdx + cdy * cdy >= rbSum * rbSum) continue;

        /* 细筛：所有子圆两两求交，留"最贴近 / 最深"的那一对 */
        var minGap = Infinity, bnx = 0, bny = 0, cpx = 0, cpy = 0;
        var pa = a.wx.length, pb = b.wx.length;
        var brb = b.rb;

        for (var m = 0; m < pa; m++) {
          var ax = a.wx[m], ay = a.wy[m], ar = a.ws[m];
          var ddx = b.x - ax, ddy = b.y - ay, far = brb + ar;
          if (ddx * ddx + ddy * ddy >= far * far) continue;

          for (var k = 0; k < pb; k++) {
            var bx = b.wx[k], by = b.wy[k], br = b.ws[k];
            var dx = bx - ax, dy = by - ay, sum = ar + br;
            var d2 = dx * dx + dy * dy;
            if (d2 >= sum * sum) continue;

            var d = Math.sqrt(d2), gap = d - sum;
            if (gap < minGap) {
              minGap = gap;
              cpx = (ax + bx) * 0.5;
              cpy = (ay + by) * 0.5;
              if (d < 1e-4) { bnx = 1; bny = 0; }
              else { bnx = dx / d; bny = dy / d; }
            }
          }
        }

        if (minGap === Infinity) continue;   // 只是包围圆相交，实际没碰上

        /* --- 合成：同级、且真的贴上了 --- */
        if (firstIter && a.tier === b.tier && minGap <= pad) {
          a.dead = true;
          b.dead = true;
          merges.push([a, b]);
          continue;
        }

        if (minGap >= 0) continue;           // 还隔着，不用推

        if (firstIter && contacts) contacts.push({ a: a, b: b, nx: bnx, ny: bny });

        /* --- 位置投影：按质量 + 转动惯量分配。位移作用在接触点上，
         *     所以偏心挤压会顺带把果子转起来（这就是"素材会转动"的来源，
         *     而不是另外加的旋转动画）。合成点也因此天然钉死：
         *     新果子又大又重，被推开的几乎总是旁边小的。 --- */
        var corr = Math.min(-minGap, cfg.maxCorr) * 0.85;
        if (corr <= 0) continue;

        var rax = cpx - a.x, ray = cpy - a.y;
        var rbx = cpx - b.x, rby = cpy - b.y;
        var cna = rax * bny - ray * bnx;          // (r × n)
        var cnb = rbx * bny - rby * bnx;
        var wsum = a.invMass + b.invMass +
                   a.invI * cna * cna + b.invI * cnb * cnb;
        var lam = corr / wsum;

        a.x -= bnx * lam * a.invMass;
        a.y -= bny * lam * a.invMass;
        b.x += bnx * lam * b.invMass;
        b.y += bny * lam * b.invMass;
        setAngle(a, a.angle - cna * lam * a.invI);
        setAngle(b, b.angle + cnb * lam * b.invI);

        a.contacts++;
        b.contacts++;
        syncParts(a);
        syncParts(b);
      }
    }
  };

  /* ------------------------------------------------------------------ */
  /*  弹性冲量 + 挤压变形                                                 */
  /* ------------------------------------------------------------------ */

  World.prototype._impulse = function (contacts) {
    var cfg = this.cfg;

    for (var k = 0; k < contacts.length; k++) {
      var ct = contacts[k];

      if (ct.ball) {
        var b = ct.ball;
        if (b.dead) continue;
        var vnPre = b.pvx * ct.nx + b.pvy * ct.ny;     // <0 表示还在往墙里钻
        if (vnPre < -cfg.restThreshold) {
          var vnPost = b.vx * ct.nx + b.vy * ct.ny;
          var target = -cfg.wallRestitution * vnPre;
          var jw = target - vnPost;
          if (jw > 0) {
            b.vx += jw * ct.nx;
            b.vy += jw * ct.ny;
            squash(b, ct.nx, ct.ny, -vnPre, cfg);
          }
        }
        continue;
      }

      var a = ct.a, bb = ct.b;
      if (a.dead || bb.dead) continue;

      var nx = ct.nx, ny = ct.ny;                      // a → b
      var vn = (a.pvx - bb.pvx) * nx + (a.pvy - bb.pvy) * ny;   // >0 相互靠近
      if (vn <= cfg.restThreshold) continue;

      var vnAfter = (a.vx - bb.vx) * nx + (a.vy - bb.vy) * ny;
      var want = -cfg.restitution * vn;
      var j = (vnAfter - want) / (a.invMass + bb.invMass);
      if (j <= 0) continue;

      a.vx -= j * a.invMass * nx;   a.vy -= j * a.invMass * ny;
      bb.vx += j * bb.invMass * nx; bb.vy += j * bb.invMass * ny;
      squash(a, -nx, -ny, vn, cfg);
      squash(bb, nx, ny, vn, cfg);
    }
  };

  function squash(b, nx, ny, speed, cfg) {
    var k = Math.min(cfg.squashMax, speed / 1800);
    if (k <= b.sq) return;
    b.sq = k;
    b.sqA = Math.atan2(ny, nx);
  }

  /* ------------------------------------------------------------------ */
  /*  合成落地                                                           */
  /* ------------------------------------------------------------------ */

  World.prototype._applyMerges = function (list) {
    var maxTier = this.radii.length - 1;
    var i, m, a, b;

    for (i = 0; i < list.length; i++) {
      m = list[i];
      a = m[0]; b = m[1];
      if (a.merged || b.merged) continue;
      a.merged = b.merged = true;

      var mx = (a.x + b.x) * 0.5;
      var my = (a.y + b.y) * 0.5;
      var tier = a.tier;

      if (tier < maxTier) {
        /* 出生点就是合成点：位置钉死，周围的果子由约束自己推开 */
        var nb = this.add(tier + 1, mx, my,
          (a.vx + b.vx) * 0.5,
          (a.vy + b.vy) * 0.5 - 45);
        nb.popAt = this.time;
        nb.landed = true;
        nb.omega = ((nb.id % 5) - 2) * 0.9;              // 轻微自转，别每次都同一个姿势
        this.clampInside(nb);
        this.stats.merges++;
        this.events.push({ level: tier, next: tier + 1, x: mx, y: my, ball: nb });
      } else {
        /* 满级：不生新的，交给游戏（轮回 / 清场加分都由外面决定） */
        this.stats.merges++;
        this.events.push({ level: tier, next: -1, x: mx, y: my, ball: null });
      }
    }

    /* 原地压缩：外部拿着的 this.balls 引用一直有效 */
    var w = 0;
    for (i = 0; i < this.balls.length; i++) {
      if (!this.balls[i].dead) this.balls[w++] = this.balls[i];
    }
    this.balls.length = w;

    /* 新果子比被吃掉的两颗都大，出生瞬间一定压着邻居。
     * 这一步先用两轮约束把它推开，别把这个"最深"留到下一帧才看到 ——
     * 一帧 16ms 的 10px 叠压，在画面上是能看见的一次闪。 */
    for (var pass = 0; pass < 2; pass++) {
      this._solveWalls(null);
      this._solvePairs(null, false, []);
    }
  };

  /* ------------------------------------------------------------------ */
  /*  工具：量两颗果子之间的重叠（离线体检 / 调试用）                      */
  /* ------------------------------------------------------------------ */

  World.prototype.overlap = function (a, b) {
    var minGap = Infinity, nx = 0, ny = 0;
    for (var m = 0; m < a.wx.length; m++) {
      var ax = a.wx[m], ay = a.wy[m], ar = a.ws[m];
      for (var k = 0; k < b.wx.length; k++) {
        var dx = b.wx[k] - ax, dy = b.wy[k] - ay, sum = ar + b.ws[k];
        var d2 = dx * dx + dy * dy;
        if (d2 >= sum * sum) continue;
        var d = Math.sqrt(d2), gap = d - sum;
        if (gap < minGap) {
          minGap = gap;
          if (d < 1e-4) { nx = 1; ny = 0; } else { nx = dx / d; ny = dy / d; }
        }
      }
    }
    if (minGap === Infinity) return null;
    return { gap: minGap, depth: minGap < 0 ? -minGap : 0, nx: nx, ny: ny };
  };

  /* 场上最严重的一处重叠（minAgeMs：忽略刚落下的，避免把"出生瞬间"算进去） */
  World.prototype.worstOverlap = function (minAgeMs) {
    var best = 0, age = minAgeMs || 0, t = this.time;
    for (var i = 0; i < this.balls.length; i++) {
      var a = this.balls[i];
      if (a.dead || t - a.bornAt < age) continue;
      for (var j = i + 1; j < this.balls.length; j++) {
        var b = this.balls[j];
        if (b.dead || t - b.bornAt < age) continue;
        var o = this.overlap(a, b);
        if (o && o.depth > best) best = o.depth;
      }
    }
    return best;
  };

  return { create: function (opts) { return new World(opts); }, World: World };
});
