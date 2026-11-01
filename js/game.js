/* =========================================================================
 *  合成大西瓜 · 主程序
 *  -----------------------------------------------------------------------
 *  结构：
 *    1. 常量 / 状态      2. 物理世界      3. 合成逻辑
 *    4. 游戏流程         5. 渲染          6. 输入 / 音效
 * ========================================================================= */
(function () {
  'use strict';

  /* ============================ 1. 常量 ============================ */

  var CFG     = window.GAME_CONFIG;
  var M       = window.Matter;
  var W       = CFG.world.width;
  var H       = CFG.world.height;
  var WALL    = CFG.world.wall;
  var DROP_Y  = CFG.world.dropY;
  var DEATH_Y = CFG.world.deathY;
  var FRUITS  = CFG.fruits;
  var RULES   = CFG.rules;
  var PHYS    = CFG.physics;
  var MAX_LV  = FRUITS.length - 1;
  var STEP    = 1000 / 60;
  var DEBUG   = /[?&]debug\b/.test(location.search);   // ?debug=1 显示碰撞圆，调素材时用

  /* ---------------------------- DOM ---------------------------- */

  var canvas      = document.getElementById('game');
  var ctx         = canvas.getContext('2d');
  var stage       = document.getElementById('stage');
  var scoreEl     = document.getElementById('score');
  var bestEl      = document.getElementById('best');
  var comboEl     = document.getElementById('combo');
  var nextImg     = document.getElementById('next-img');
  var nextDot     = document.getElementById('next-dot');
  var soundBtn    = document.getElementById('sound-btn');
  var overOv      = document.getElementById('over-overlay');
  var againBtn    = document.getElementById('again-btn');
  var finalScore  = document.getElementById('final-score');
  var finalBest   = document.getElementById('final-best');
  var newRecord   = document.getElementById('new-record');

  /* ---------------------------- 存档 ---------------------------- */

  var KEY = 'merge-watermelon.v1';

  function storeGet(k, def) {
    try {
      var v = localStorage.getItem(KEY + '.' + k);
      return v === null ? def : v;
    } catch (e) { return def; }
  }
  function storeSet(k, v) {
    try { localStorage.setItem(KEY + '.' + k, String(v)); } catch (e) {}
  }

  /* ---------------------------- 状态 ---------------------------- */

  var S = {
    mode: 'ready',        // ready | playing | over
    score: 0,
    best: Number(storeGet('best', 0)) || 0,
    soundOn: storeGet('sound', '1') !== '0',
    time: 0,
    current: null,        // { level, x, born }
    nextLevel: 0,
    cooldown: 0,
    dragging: false,
    pointerX: W / 2,
    combo: 0,
    lastMergeAt: -9999,
    danger: 0,
    shake: 0
  };

  var fruits    = [];
  var particles = [];
  var rings     = [];
  var texts     = [];
  var view      = { scale: 1, dpr: 1 };
  var sprites   = [];     // 索引 -> HTMLCanvasElement（已栅格化的素材）

  /* ============================ 2. 物理世界 ============================ */

  var engine = M.Engine.create({
    positionIterations: PHYS.positionIterations,
    velocityIterations: PHYS.velocityIterations,
    constraintIterations: PHYS.constraintIterations
  });
  engine.gravity.x = 0;
  engine.gravity.y = PHYS.gravity;
  engine.gravity.scale = 0.001;

  var world = engine.world;

  // 碰撞体做得非常厚：视觉上只有 12px 的壁，但物理上是实心大块，
  // 这样即使果子被高速弹出也不会“穿墙逃跑”（12px 薄壁会被 17px/帧 的速度打穿）。
  //
  // 关键：碰撞面向内缩进一个 WALL，让出一圈正好是「墙体本身」的位置。
  // 否则果子会挨在 0 / W / H 上，被盖在上面的墙体视觉压掉 12px。
  var THICK = 400;
  var walls = [
    M.Bodies.rectangle(WALL - THICK / 2, H / 2, THICK, H * 2, { isStatic: true, friction: 0.5, restitution: 0 }),
    M.Bodies.rectangle(W - WALL + THICK / 2, H / 2, THICK, H * 2, { isStatic: true, friction: 0.5, restitution: 0 }),
    M.Bodies.rectangle(W / 2, H - WALL + THICK / 2, W + THICK * 2, THICK, { isStatic: true, friction: 0.6, restitution: 0 })
  ];
  M.Composite.add(world, walls);

  function addFruit(level, x, y, vx, vy, merged) {
    var f = FRUITS[level];
    var info = sprites[level];
    var shape = info && info.shape;
    var d = f.radius * 2 * (f.spriteScale || 1);

    var opts = {
      label: 'fruit',
      restitution: PHYS.restitution,
      friction: PHYS.friction,
      frictionStatic: PHYS.frictionStatic,
      frictionAir: PHYS.frictionAir,
      density: 0.0012,
      slop: PHYS.slop
    };

    var body;
    if (shape && shape.circles && shape.circles.length > 1) {
      /* 异形素材：用多个圆拼出贴近轮廓的复合刚体 */
      var parts = [];
      for (var k = 0; k < shape.circles.length; k++) {
        var c = shape.circles[k];
        parts.push(M.Bodies.circle(x + c.x * d, y + c.y * d, c.r * d, opts));
      }
      body = M.Body.create({
        parts: parts,
        label: 'fruit',
        friction: PHYS.friction,
        frictionStatic: PHYS.frictionStatic,
        frictionAir: PHYS.frictionAir,
        restitution: PHYS.restitution
      });
    } else {
      body = M.Bodies.circle(x, y, f.radius, opts);
    }

    body.plugin = {
      level: level,
      born: S.time,
      animated: !!merged,
      dead: false,
      /* 复合刚体的 position 是质心，精灵要画在几何中心上，这里记下偏移 */
      com: (shape && shape.circles && shape.circles.length > 1)
        ? { x: body.position.x - x, y: body.position.y - y }
        : null
    };

    M.Body.setVelocity(body, { x: vx || 0, y: vy || 0 });
    if (merged) M.Body.setAngularVelocity(body, (Math.random() - 0.5) * 0.12);
    M.Composite.add(world, body);
    fruits.push(body);
    return body;
  }

  function removeFruit(body) {
    var i = fruits.indexOf(body);
    if (i >= 0) fruits.splice(i, 1);
    M.Composite.remove(world, body);
  }

  /* ============================ 3. 合成逻辑 ============================ */

  /** 速度兜底：极端情况下（多个大果子同时挤压）限速，避免穿透与“飞出去” */
  function clampSpeeds() {
    var max = PHYS.maxSpeed;
    if (!max) return;
    for (var i = 0; i < fruits.length; i++) {
      var b = fruits[i];
      if (b.speed > max) {
        var k = max / b.speed;
        M.Body.setVelocity(b, { x: b.velocity.x * k, y: b.velocity.y * k });
      }
    }
  }

  /* 合成出来的果子比原来两颗都大，经常直接把旁边的小果子"吞"进身体里。
   * 而被吞的小果子如果正好陷在腿间这种凹槽里，四周都是碰撞圆、受力对称，
   * 求解器永远推不出来 —— 会一直保持十几像素的穿透挂在画面上。
   * 所以合成后主动做一次分离：把和新果子重叠的其他果子沿连线推到体外。 */
  function separateOverlaps(nb) {
    var nbParts = nb.parts.filter(function (p) { return p.circleRadius; });
    for (var pass = 0; pass < 2; pass++) {
      var moved = false;
      for (var i = 0; i < fruits.length; i++) {
        var o = fruits[i];
        if (o === nb || o.plugin.dead) continue;
        var oParts = o.parts.filter(function (p) { return p.circleRadius; });
        var deepest = 0, dirx = 0, diry = -1;
        for (var a = 0; a < nbParts.length; a++) {
          for (var b = 0; b < oParts.length; b++) {
            var pa = nbParts[a], pb = oParts[b];
            var dx = pb.position.x - pa.position.x;
            var dy = pb.position.y - pa.position.y;
            var dist = Math.sqrt(dx * dx + dy * dy) || 0.001;
            var d = pa.circleRadius + pb.circleRadius - dist;   // >0 就是重叠
            if (d > deepest) { deepest = d; dirx = dx / dist; diry = dy / dist; }
          }
        }
        if (deepest > 2) {
          /* 沿"从新果子指向它"的方向推出去；正好同心就往上推 */
          if (!dirx && !diry) { dirx = 0; diry = -1; }
          M.Body.translate(o, { x: dirx * (deepest + 2), y: diry * (deepest + 2) });
          /* 别把它推到墙外面去 */
          var bb = o.bounds, fx = 0, fy = 0;
          if (bb.min.x < WALL) fx = WALL - bb.min.x;
          else if (bb.max.x > W - WALL) fx = (W - WALL) - bb.max.x;
          if (bb.max.y > H - WALL) fy = (H - WALL) - bb.max.y;
          if (fx || fy) M.Body.translate(o, { x: fx, y: fy });
          moved = true;
        }
      }
      if (!moved) break;
    }
  }

  /* 静止冻结：全场都挪不动了就干脆不跑物理，一有动静立刻恢复。
   * 比 Matter 的单体休眠可靠 —— 单体休眠在「支撑它的果子被合成掉 / 自己滚走」之后
   * 不会自己醒，会原地冻结在半空，看起来就是"悬空"。整场冻结不存在这个问题。 */
  var frozen = false;
  var quietFrames = 0;

  function sceneIsQuiet() {
    for (var i = 0; i < fruits.length; i++) {
      var b = fruits[i];
      if (b.plugin.dead) continue;
      if (b.speed > 0.2 || Math.abs(b.angularVelocity) > 0.02) return false;
      /* 有果子探到死亡线附近时不许冻结：危险计时得继续走，压线的东西也该继续塌 */
      if (b.bounds.min.y < DEATH_Y + 24) return false;
    }
    return true;
  }

  var frozenTick = 0;

  /* 有没有「悬空」的果子：冻结时直接查物理引擎的接触对。
   * 一个果子只要贴着任何东西（别的果子、地面、器壁），就一定在 engine.pairs 里；
   * 一个接触对都没有、又不在底部，那就是悬空的。比包围盒判断准得多。 */
  function hasSuspended() {
    var pairs = engine.pairs.list, touching = {}, i, p;
    for (i = 0; i < pairs.length; i++) {
      p = pairs[i];
      if (!p.isActive) continue;
      touching[(p.bodyA.parent || p.bodyA).id] = 1;
      touching[(p.bodyB.parent || p.bodyB).id] = 1;
    }
    for (i = 0; i < fruits.length; i++) {
      var b = fruits[i];
      if (b.plugin.dead) continue;
      if (!touching[b.id]) return true;
    }
    return false;
  }

  /* 有任何东西被投放 / 合成 / 重置都要调用它，把物理唤醒。
   * wakeUntil：合成/落地之后至少再跑 0.8 秒物理，留出时间把重叠推开。
   * 否则"速度已经很低但还压着"的瞬间会被冻结，穿透就永久留在画面上了。 */
  var wakeUntil = 0;
  function thaw() {
    frozen = false;
    quietFrames = 0;
    wakeUntil = S.time + 800;
  }

  /* 合成判定改成「真的撞上了才算」——复合刚体的形状千奇百怪，
   * 用圆心距离没法判断，直接听物理引擎的碰撞事件最准。 */
  var pendingMerges = [];
  var mgStats = { pairs: 0, merged: 0, skipped: 0 };

  function onCollisionStart(evt) {
    var pairs = evt.pairs;
    for (var i = 0; i < pairs.length; i++) {
      /* 复合刚体的碰撞对给的是子圆，要回溯到整体刚体 */
      var a = pairs[i].bodyA.parent || pairs[i].bodyA;
      var b = pairs[i].bodyB.parent || pairs[i].bodyB;
      if (a === b) continue;
      if (a.label !== 'fruit' || b.label !== 'fruit') continue;
      if (a.plugin.dead || b.plugin.dead) continue;
      if (a.plugin.level !== b.plugin.level) continue;
      mgStats.pairs++;
      pendingMerges.push([a, b]);
    }
  }
  M.Events.on(engine, 'collisionStart', onCollisionStart);

  function processMerges() {
    if (!pendingMerges.length) return;
    var list = pendingMerges;
    pendingMerges = [];
    for (var i = 0; i < list.length; i++) {
      var a = list[i][0], b = list[i][1];
      if (a.plugin.dead || b.plugin.dead) { mgStats.skipped++; continue; }
      if (fruits.indexOf(a) < 0 || fruits.indexOf(b) < 0) { mgStats.skipped++; continue; }
      a.plugin.dead = true;
      b.plugin.dead = true;
      mgStats.merged++;
      doMerge(a, b);
    }
  }

  function doMerge(a, b) {
    var level = a.plugin.level;
    var next  = level + 1;
    var mx = (a.position.x + b.position.x) / 2;
    var my = (a.position.y + b.position.y) / 2;
    var vx = (a.velocity.x + b.velocity.x) * 0.5;
    var vy = (a.velocity.y + b.velocity.y) * 0.5;

    thaw();
    removeFruit(a);
    removeFruit(b);

    /* --- 连击 --- */
    var chained = (S.time - S.lastMergeAt) < RULES.comboWindow;
    S.combo = chained ? S.combo + 1 : 1;
    S.lastMergeAt = S.time;
    var mult = 1 + Math.min((S.combo - 1) * RULES.comboStep, RULES.comboMax);

    /* --- 计分 --- */
    var finished = next > MAX_LV;
    var base = finished ? FRUITS[MAX_LV].score * 2 : FRUITS[next].score;
    var gain = Math.round(base * mult);
    addScore(gain);

    /* --- 特效 --- */
    burst(mx, my, level, finished);
    floatingText(mx, my - FRUITS[level].radius * 0.4, '+' + gain, mult > 1);
    showCombo(mult);

    if (!finished) {
      var nb = addFruit(next, mx, my, vx * 0.55, vy * 0.55 - 0.4, true);
      nb.plugin.animated = true;
      thaw();
      separateOverlaps(nb);
      S.shake = Math.min(S.shake + 1.1 + level * 0.3, 11);
      sfx.merge(next);
      vibrate(level >= 6 ? 18 : 9);
    } else {
      /* --- 轮回：两个满级果子相撞，按 rules.recycle 变回某个低级果子 --- */
      S.shake = 13;
      bigBurst(mx, my);
      sfx.win();
      vibrate([20, 40, 20]);

      var backTo = (typeof RULES.recycle === 'number') ? RULES.recycle : 0;
      if (backTo >= 0 && backTo <= MAX_LV) {
        var reborn = addFruit(backTo, mx, my, vx * 0.3, vy * 0.3 - 1.8, true);
        reborn.plugin.animated = true;
        rings.push({ x: mx, y: my, r: FRUITS[MAX_LV].radius * 0.7, life: 0, max: 640, color: '#ffcf5c' });
      }
    }
  }

  function addScore(n) {
    S.score += n;
    scoreEl.textContent = S.score;
    scoreEl.classList.remove('bump');
    void scoreEl.offsetWidth;
    scoreEl.classList.add('bump');
  }

  var comboTimer = 0;
  function showCombo(mult) {
    if (mult <= 1.001) return;
    comboEl.textContent = '连击 ×' + mult.toFixed(1);
    comboEl.classList.add('show');
    clearTimeout(comboTimer);
    comboTimer = setTimeout(function () { comboEl.classList.remove('show'); }, 950);
  }

  /* ============================ 4. 游戏流程 ============================ */

  var spawnSeq = [];      // 最近生成过的等级，用来避免同一种连着出

  /** 抽下一颗的等级：若已经连着出了 maxRepeat 次同一级，本次把这个等级排除掉 */
  function randLevel() {
    var w = RULES.spawnWeights;
    var n = Math.min(RULES.spawnLevels, w.length, FRUITS.length);
    var rep = (typeof RULES.maxRepeat === 'number') ? RULES.maxRepeat : 2;

    var ban = -1;
    if (rep > 0 && spawnSeq.length >= rep) {   // rep=0 表示不限制；rep=2 表示最多连出 2 次
      var last = spawnSeq[spawnSeq.length - 1];
      var sameRun = true;
      for (var k = 1; k < rep; k++) {
        if (spawnSeq[spawnSeq.length - 1 - k] !== last) { sameRun = false; break; }
      }
      if (sameRun) ban = last;
    }

    var total = 0, i;
    for (i = 0; i < n; i++) if (i !== ban) total += w[i];
    if (total <= 0) {                    // 兜底：全被排除就取消禁用
      ban = -1;
      for (i = 0; i < n; i++) total += w[i];
    }

    var r = Math.random() * total;
    for (i = 0; i < n; i++) {
      if (i === ban) continue;
      r -= w[i];
      if (r <= 0) return i;
    }
    for (i = n - 1; i >= 0; i--) if (i !== ban) return i;
    return 0;
  }

  /** 生成并记录一次出果 */
  function nextSpawnLevel() {
    var lv = randLevel();
    spawnSeq.push(lv);
    if (spawnSeq.length > 200) spawnSeq.shift();
    return lv;
  }

  function resetGame() {
    thaw();
    fruits.slice().forEach(removeFruit);
    fruits.length = 0;
    particles.length = 0;
    rings.length = 0;
    texts.length = 0;

    S.score = 0;
    S.combo = 0;
    S.lastMergeAt = -9999;
    S.danger = 0;
    S.shake = 0;
    S.cooldown = 0;
    S.dragging = false;
    S.pointerX = W / 2;
    S.mode = 'playing';

    scoreEl.textContent = '0';
    comboEl.classList.remove('show');
    bestEl.textContent = S.best;

    /* 开局第一颗固定为最低级（rules.firstLevel） */
    spawnSeq.length = 0;
    var first = Math.max(0, Math.min(RULES.firstLevel || 0, MAX_LV));
    first = Math.min(first, Math.min(RULES.spawnLevels, FRUITS.length) - 1);
    spawnSeq.push(first);

    S.current = { level: first, x: W / 2, born: S.time };
    S.nextLevel = nextSpawnLevel();
    updateNextChip();
  }

  function startGame() {
    sfx.unlock();
    overOv.classList.add('hidden');
    resetGame();
  }

  function gameOver() {
    if (S.mode !== 'playing') return;
    S.mode = 'over';
    S.current = null;
    S.dragging = false;
    sfx.over();

    var record = S.score > S.best;
    if (record) {
      S.best = S.score;
      storeSet('best', S.best);
    }
    bestEl.textContent = S.best;
    finalScore.textContent = S.score;
    finalBest.textContent = S.best;
    newRecord.classList.toggle('hidden', !record);

    setTimeout(function () {
      if (S.mode === 'over') overOv.classList.remove('hidden');
    }, 420);
  }

  function updateNextChip() {
    var f = FRUITS[S.nextLevel];
    if (f.sprite) {
      if (nextImg.getAttribute('src') !== f.sprite) nextImg.src = f.sprite;
      nextImg.classList.add('on');
      nextDot.classList.remove('on');
    } else {
      nextImg.classList.remove('on');
      nextDot.classList.add('on');
      nextDot.style.background = 'linear-gradient(180deg,' + f.color + ',' + (f.color2 || f.color) + ')';
    }
  }

  /* ---------------------------- 投放 ---------------------------- */

  function dropCurrent() {
    thaw();
    if (S.mode !== 'playing' || !S.current || S.cooldown > 0) return;
    var f = FRUITS[S.current.level];
    var x = clamp(S.current.x, WALL + f.radius, W - WALL - f.radius);
    addFruit(S.current.level, x, DROP_Y, 0, 1.4, false);
    sfx.drop();
    S.current = null;
    S.cooldown = RULES.dropCooldown;
  }

  function spawnNext() {
    var f = FRUITS[S.nextLevel];
    var x = clamp(S.pointerX, WALL + f.radius, W - WALL - f.radius);
    S.current = { level: S.nextLevel, x: x, born: S.time };
    S.nextLevel = nextSpawnLevel();
    updateNextChip();
  }

  /* ---------------------------- 死亡判定 ---------------------------- */

  function checkDanger(dt) {
    var over = false;
    for (var i = 0; i < fruits.length; i++) {
      var b = fruits[i];
      if (S.time - b.plugin.born < 1200) continue;   // 刚掉下来的不算
      if (b.speed > 1.1) continue;                   // 还在动的也不算
      if (b.bounds.min.y < DEATH_Y) { over = true; break; }
    }
    if (over) {
      S.danger += dt;
      if (S.danger >= RULES.dangerDwell) gameOver();
    } else {
      S.danger = Math.max(0, S.danger - dt * 2.2);
    }
  }

  /* ============================ 5. 渲染 ============================ */

  function resize() {
    var cs = window.getComputedStyle(stage);
    var availW = stage.clientWidth - parseFloat(cs.paddingLeft) - parseFloat(cs.paddingRight);
    var availH = stage.clientHeight - parseFloat(cs.paddingTop) - parseFloat(cs.paddingBottom);
    if (availW <= 0 || availH <= 0) return;

    var scale = Math.min(availW / W, availH / H);
    var cssW = Math.max(1, Math.floor(W * scale));
    var cssH = Math.max(1, Math.floor(H * scale));
    var dpr = Math.min(window.devicePixelRatio || 1, 2);

    canvas.style.width = cssW + 'px';
    canvas.style.height = cssH + 'px';
    canvas.width = Math.round(cssW * dpr);
    canvas.height = Math.round(cssH * dpr);

    view.scale = scale;
    view.dpr = dpr;
    bgReady = false;
    ctx.imageSmoothingEnabled = true;
    if ('imageSmoothingQuality' in ctx) ctx.imageSmoothingQuality = 'high';
  }

  /* ---------------------------- 素材 ---------------------------- */

  function loadSprites() {
    FRUITS.forEach(function (f, i) {
      if (!f.sprite) return;
      var img = new Image();
      img.decoding = 'async';
      img.onload = function () { sprites[i] = bake(img, f.sprite); };
      img.onerror = function () { console.warn('[素材加载失败] ' + f.sprite); };
      img.src = f.sprite;
    });
  }

  /* 把素材栅格化到 512 的画布（之后每帧只做贴图，性能稳）。
   * 同时裁掉四周的透明留白——这样果子能紧贴碰撞体，
   * 堆起来不会有「明明碰到了却还空一大块」的缝。
   *
   * 裁边框和贴形圆优先取 js/assets-meta.js 里预计算好的数据。
   * 原因：file:// 直接双击打开时浏览器禁止读像素，getImageData 会抛异常，
   * 那样就会退化成「不裁边 + 单圆」，画面立刻出现空隙和穿模。
   * 预计算后本地双击和本地服务器两种打开方式完全一致。
   * 换了素材而没重算 meta 也不会崩：读得到像素就现场算，读不到才退回单圆。 */
  function bake(img, src) {
    var SZ = 512;
    var probe = document.createElement('canvas');
    probe.width = probe.height = SZ;
    var pg = probe.getContext('2d');

    var iw = img.naturalWidth || img.width || 1;
    var ih = img.naturalHeight || img.height || 1;
    var k = Math.min(SZ / iw, SZ / ih);
    var dw = iw * k, dh = ih * k;
    pg.drawImage(img, (SZ - dw) / 2, (SZ - dh) / 2, dw, dh);

    var meta = (window.SPRITE_META && src) ? window.SPRITE_META[src] : null;

    var box = { x: 0, y: 0, w: SZ, h: SZ };
    if (meta && meta.box) {
      box = { x: meta.box[0], y: meta.box[1], w: meta.box[2], h: meta.box[3] };
    } else {
      try {
        var data = pg.getImageData(0, 0, SZ, SZ).data;
        var minX = SZ, minY = SZ, maxX = -1, maxY = -1;
        for (var y = 0; y < SZ; y++) {
          var row = y * SZ * 4;
          for (var x = 0; x < SZ; x++) {
            if (data[row + x * 4 + 3] > 8) {
              if (x < minX) minX = x;
              if (x > maxX) maxX = x;
              if (y < minY) minY = y;
              if (y > maxY) maxY = y;
            }
          }
        }
        if (maxX > minX && maxY > minY) {
          box = { x: minX, y: minY, w: maxX - minX + 1, h: maxY - minY + 1 };
        }
      } catch (e) { /* 读不到像素就按整张图处理 */ }
    }

    var out = document.createElement('canvas');
    out.width = out.height = SZ;
    var og = out.getContext('2d');
    var s = Math.min(SZ / box.w, SZ / box.h);
    var w2 = box.w * s, h2 = box.h * s;
    og.drawImage(probe, box.x, box.y, box.w, box.h, (SZ - w2) / 2, (SZ - h2) / 2, w2, h2);

    var shape = null;
    if (meta && meta.circles) {
      /* assets-meta.js 里存的是 [x, y, r] 紧凑数组，这里统一成对象 */
      var cs = [];
      for (var ci = 0; ci < meta.circles.length; ci++) {
        var cc = meta.circles[ci];
        cs.push(Array.isArray(cc)
          ? { x: cc[0], y: cc[1], r: cc[2] }
          : { x: cc.x, y: cc.y, r: cc.r });
      }
      shape = { circles: cs, cover: meta.cover, preset: true };
    } else {
      shape = fitShape(out);
    }

    return { canvas: out, shape: shape, box: box };
  }

  /* ------------------------------------------------------------------
   *  按图形轮廓拟合碰撞体
   *  ------------------------------------------------------------------
   *  圆对异形素材是硬伤：四条腿的马、趴着的猪，圆形要么盖到邻居身上（穿模），
   *  要么留一大块空当（间隙）。这里直接在素材轮廓上「铺内切圆」：
   *    1) 对 alpha 做距离变换，得到每个实心点到边缘的距离
   *    2) 贪心：每次挑「还没被覆盖、且最厚」的点，放一个圆（半径=厚度×微膨胀）
   *    3) 重复到圆数上限或图形被覆盖得差不多
   *  得到的多个圆组成复合刚体，碰撞就贴着图形走了。
   *  坐标系：圆心/半径都归一化到「精灵边长=1」，画的时候乘以实际绘制尺寸即可。
   * ------------------------------------------------------------------ */
  function fitShape(src) {
    var SZ = 192;
    var px = document.createElement('canvas');
    px.width = px.height = SZ;
    var pg = px.getContext('2d');
    pg.drawImage(src, 0, 0, SZ, SZ);

    var data;
    try {
      data = pg.getImageData(0, 0, SZ, SZ).data;
    } catch (e) {
      return null;                       // file:// 读不到像素 → 退回单圆
    }

    var N = SZ * SZ;
    var mask = new Uint8Array(N);
    var area = 0, x0 = SZ, y0 = SZ, x1 = -1, y1 = -1;
    for (var i = 0; i < N; i++) {
      if (data[i * 4 + 3] > 24) {
        mask[i] = 1; area++;
        var mx = i % SZ, my = (i / SZ) | 0;
        if (mx < x0) x0 = mx;
        if (mx > x1) x1 = mx;
        if (my < y0) y0 = my;
        if (my > y1) y1 = my;
      }
    }
    if (!area) return null;

    /* 素材裁完边正好贴满画布，最外一圈像素的"外面"不在网格里。
     * 距离变换看不到这层背景，会误以为边缘离背景很远，于是在边上铺出半径过大的圆，
     * 整个碰撞体比图形大一圈（别的果子落在看不见的圆上 → 看起来悬空）。
     * 把边框一圈视为背景即可。 */
    for (var bx = 0; bx < SZ; bx++) {
      mask[bx] = 0;
      mask[(SZ - 1) * SZ + bx] = 0;
      mask[bx * SZ] = 0;
      mask[bx * SZ + SZ - 1] = 0;
    }

    var bw = x1 - x0 + 1, bh = y1 - y0 + 1;
    var fill = area / (bw * bh);

    /* 注意：这里**故意不再**用「面积占比」提前判定"圆素材、直接用单圆"。
     * 狗这种圆乎乎的造型也能占到包围盒 73%，按占比判圆会用一个直径等于包围盒的大圆兜住，
     * 身体比圆小一圈 → 别的果子落在看不见的圆上，看着就是"悬空"。
     * 真正的圆在这个贪心算法下本来就会只铺出 1 个圆（第一圈就全覆盖），
     * 所以交给拟合判断更可靠。 */

    /* --- 距离变换（两趟倒角） --- */
    var INF = 1e6, A = 1, B = 1.4142;
    var dt = new Float32Array(N);
    for (i = 0; i < N; i++) dt[i] = mask[i] ? INF : 0;

    for (var y = 0; y < SZ; y++) {
      for (var x = 0; x < SZ; x++) {
        i = y * SZ + x;
        if (!mask[i]) continue;
        var v = dt[i];
        if (x > 0) v = Math.min(v, dt[i - 1] + A);
        if (y > 0) v = Math.min(v, dt[i - SZ] + A);
        if (x > 0 && y > 0) v = Math.min(v, dt[i - SZ - 1] + B);
        if (x < SZ - 1 && y > 0) v = Math.min(v, dt[i - SZ + 1] + B);
        dt[i] = v;
      }
    }
    for (y = SZ - 1; y >= 0; y--) {
      for (x = SZ - 1; x >= 0; x--) {
        i = y * SZ + x;
        if (!mask[i]) continue;
        var v2 = dt[i];
        if (x < SZ - 1) v2 = Math.min(v2, dt[i + 1] + A);
        if (y < SZ - 1) v2 = Math.min(v2, dt[i + SZ] + A);
        if (x < SZ - 1 && y < SZ - 1) v2 = Math.min(v2, dt[i + SZ + 1] + B);
        if (x > 0 && y < SZ - 1) v2 = Math.min(v2, dt[i + SZ - 1] + B);
        dt[i] = v2;
      }
    }

    /* --- 贪心铺圆 --- */
    var covered = new Uint8Array(N);
    var circles = [];
    /* 圆半径 = 该处内切半径 + 固定外扩量。
     * 用「固定量」而不是「按比例放大」：并集在轮廓边缘本来会内缩一点点（相邻圆之间塌腰），
     * 补一个固定外扩正好抵掉，超出的部分始终只有 ~1.5% 素材宽度（≈2 世界像素），肉眼看不出来。
     * 按比例放大的话，粗的地方会鼓出去一大圈，反而在相邻果子之间撑出空隙。 */
    var MARGIN = SZ * 0.012, MAXN = 26, MINR = SZ * 0.009;

    function markCovered(cx, cy, r) {
      var r2 = r * r;
      var ys = Math.max(0, Math.floor(cy - r)), ye = Math.min(SZ - 1, Math.ceil(cy + r));
      var xs = Math.max(0, Math.floor(cx - r)), xe = Math.min(SZ - 1, Math.ceil(cx + r));
      for (var yy = ys; yy <= ye; yy++) {
        for (var xx = xs; xx <= xe; xx++) {
          var ddx = xx - cx, ddy = yy - cy;
          if (ddx * ddx + ddy * ddy <= r2) covered[yy * SZ + xx] = 1;
        }
      }
    }

    for (var n = 0; n < MAXN; n++) {
      var best = 0, bi = -1;
      for (i = 0; i < N; i++) {
        if (mask[i] && !covered[i] && dt[i] > best) { best = dt[i]; bi = i; }
      }
      if (bi < 0 || best < MINR) break;

      var cx = bi % SZ, cy = (bi / SZ) | 0;
      var r = best + MARGIN;
      circles.push({ x: cx / SZ - 0.5, y: cy / SZ - 0.5, r: r / SZ });
      markCovered(cx, cy, r);
    }

    /* --- 细节补圆：脚、耳朵、尾巴这类细突出物 ---
     * 上面的循环按「厚度」优先，细结构永远排不上。这里专门扫没盖住的零碎区域，
     * 补几个贴着实际粗细的小圆（不外扩），这样细部也有碰撞，且不会凭空撑出空隙。 */
    var EXTRA = 4, DMIN = SZ * 0.075;
    for (var e = 0; e < EXTRA; e++) {
      var best2 = 0, bi2 = -1;
      for (i = 0; i < N; i++) {
        if (!mask[i] || covered[i] || dt[i] <= best2) continue;
        var px2 = i % SZ, py2 = (i / SZ) | 0;
        var tooClose = false;
        for (var c2 = 0; c2 < circles.length; c2++) {
          var ox = circles[c2].x * SZ + SZ / 2 - px2;
          var oy = circles[c2].y * SZ + SZ / 2 - py2;
          if (ox * ox + oy * oy < DMIN * DMIN) { tooClose = true; break; }
        }
        if (tooClose) continue;
        best2 = dt[i]; bi2 = i;
      }
      if (bi2 < 0 || best2 < SZ * 0.007) break;

      var ex = bi2 % SZ, ey = (bi2 / SZ) | 0;
      var er = Math.max(best2 + MARGIN, SZ * 0.014);
      circles.push({ x: ex / SZ - 0.5, y: ey / SZ - 0.5, r: er / SZ });
      markCovered(ex, ey, er);
    }

    if (!circles.length) return null;

    // 覆盖率（调试/调参用）
    var coveredArea = 0;
    for (i = 0; i < N; i++) if (mask[i] && covered[i]) coveredArea++;

    return { circles: circles, fill: +fill.toFixed(1), cover: +(coveredArea / area).toFixed(2) };
  }

  /* ---------------------------- 绘制工具 ---------------------------- */

  function easeOutBack(t) {
    var c1 = 1.70158, c3 = c1 + 1;
    return 1 + c3 * Math.pow(t - 1, 3) + c1 * Math.pow(t - 1, 2);
  }

  function popScale(p) {
    if (!p.animated) return 1;
    var t = Math.min(1, (S.time - p.born) / 240);
    var e = 1 - Math.pow(1 - t, 3);   // easeOutCubic：不会冲过头，避免一瞬间胀进邻居
    return 0.62 + 0.38 * e;
  }

  function containerPath() {
    var R = 28;
    ctx.beginPath();
    ctx.moveTo(0, 0);
    ctx.lineTo(W, 0);
    ctx.lineTo(W, H - R);
    ctx.quadraticCurveTo(W, H, W - R, H);
    ctx.lineTo(R, H);
    ctx.quadraticCurveTo(0, H, 0, H - R);
    ctx.closePath();
  }

  function drawContainerFill() {
    var g = ctx.createLinearGradient(0, 0, 0, H);
    g.addColorStop(0, 'rgba(255, 255, 255, 0.55)');
    g.addColorStop(0.55, 'rgba(255, 250, 240, 0.86)');
    g.addColorStop(1, 'rgba(255, 241, 224, 0.96)');

    containerPath();
    ctx.fillStyle = g;
    ctx.fill();

    // 底部暖色阴影，增加纵深
    var g2 = ctx.createLinearGradient(0, H - 150, 0, H);
    g2.addColorStop(0, 'rgba(198, 140, 92, 0)');
    g2.addColorStop(1, 'rgba(198, 140, 92, 0.14)');
    ctx.fillStyle = g2;
    ctx.fill();
  }

  /* 容器壁画在果子之后：贴墙的果子会被壁“裁掉”一点，像真的装在里面 */
  function drawContainerWalls() {
    var hw = WALL / 2, R = 26;
    var wg = ctx.createLinearGradient(0, 0, W, 0);
    wg.addColorStop(0, '#eccfae');
    wg.addColorStop(0.1, '#f6e2ca');
    wg.addColorStop(0.5, '#e7c4a1');
    wg.addColorStop(0.9, '#f6e2ca');
    wg.addColorStop(1, '#eccfae');

    ctx.beginPath();
    ctx.moveTo(hw, -4);
    ctx.lineTo(hw, H - R);
    ctx.quadraticCurveTo(hw, H - hw, R, H - hw);
    ctx.lineTo(W - R, H - hw);
    ctx.quadraticCurveTo(W - hw, H - hw, W - hw, H - R);
    ctx.lineTo(W - hw, -4);
    ctx.lineWidth = WALL;
    ctx.lineCap = 'round';
    ctx.lineJoin = 'round';
    ctx.strokeStyle = wg;
    ctx.stroke();

    // 壁内侧高光
    ctx.strokeStyle = 'rgba(255, 255, 255, 0.55)';
    ctx.lineWidth = 1.5;
    ctx.stroke();
  }

  function drawDeathLine() {
    var ratio = Math.min(1, S.danger / RULES.dangerDwell);
    var pulse = 0.5 + 0.5 * Math.sin(S.time / 160);

    ctx.save();
    ctx.setLineDash([10, 9]);
    ctx.lineWidth = 2 + ratio * 1.6;
    ctx.strokeStyle = ratio > 0.02
      ? 'rgba(232, ' + Math.round(96 - 40 * ratio) + ', 78, ' + (0.5 + 0.45 * pulse) + ')'
      : 'rgba(214, 150, 110, 0.5)';
    if (ratio > 0.02) {
      ctx.shadowColor = 'rgba(255, 90, 70, 0.7)';
      ctx.shadowBlur = 10 * ratio;
    }
    ctx.beginPath();
    ctx.moveTo(WALL + 3, DEATH_Y);
    ctx.lineTo(W - WALL - 3, DEATH_Y);
    ctx.stroke();
    ctx.restore();
  }

  function drawGuide() {
    if (!S.current || S.mode !== 'playing') return;
    var f = FRUITS[S.current.level];
    var x = S.current.x;
    var y0 = DROP_Y + f.radius * 0.8;
    var y1 = Math.min(H - WALL - 4, DROP_Y + H * 0.5);

    ctx.save();
    var lg = ctx.createLinearGradient(0, y0, 0, y1);
    lg.addColorStop(0, 'rgba(190, 132, 88, 0.22)');
    lg.addColorStop(1, 'rgba(190, 132, 88, 0)');
    ctx.strokeStyle = lg;
    ctx.lineWidth = 2;
    ctx.setLineDash([7, 11]);
    ctx.beginPath();
    ctx.moveTo(x, y0);
    ctx.lineTo(x, y1);
    ctx.stroke();
    ctx.restore();
  }

  function drawFruit(f, x, y, angle, scale, sync) {
    var r = f.radius * scale;
    var sprite = sprites[FRUITS.indexOf(f)];
    var d = r * 2 * (f.spriteScale || 1);

    ctx.save();
    ctx.translate(x, y + (f.spriteOffsetY || 0) * r);

    if (sprite) {
      ctx.save();
      /* 贴形碰撞体（sync）必须和物理角度完全一致；
         单圆果子可以用 rotate 做阻尼：0.4 = 只跟随 40%，永远翻不过来 */
      if (sync) {
        ctx.rotate(angle);
      } else if (typeof f.rotate === 'number') {
        if (f.rotate > 0) ctx.rotate(angle * Math.min(1, f.rotate));
      } else if (f.rotate !== false) {
        ctx.rotate(angle);
      }
      ctx.drawImage(sprite.canvas, -d / 2, -d / 2, d, d);
      ctx.restore();
    } else {
      var g = ctx.createRadialGradient(-r * 0.32, -r * 0.36, r * 0.1, 0, 0, r * 1.05);
      g.addColorStop(0, f.color);
      g.addColorStop(1, f.color2 || f.color);
      ctx.beginPath();
      ctx.arc(0, 0, r, 0, Math.PI * 2);
      ctx.fillStyle = g;
      ctx.fill();

      ctx.beginPath();
      ctx.ellipse(-r * 0.32, -r * 0.38, r * 0.27, r * 0.16, -0.6, 0, Math.PI * 2);
      ctx.fillStyle = 'rgba(255, 255, 255, 0.42)';
      ctx.fill();
    }
    ctx.restore();
  }

  /* 复合刚体的 position 是质心，精灵要画在几何中心；把质心偏移按当前角度转回去 */
  function spritePos(b) {
    var c = b.plugin.com;
    if (!c) return { x: b.position.x, y: b.position.y };
    var ca = Math.cos(b.angle), sa = Math.sin(b.angle);
    return {
      x: b.position.x - (c.x * ca - c.y * sa),
      y: b.position.y - (c.x * sa + c.y * ca)
    };
  }

  /* 绘制顺序：大的先画、小的后画。
   * 小果子经常落在大果子腿间、肚皮下的空隙里，如果被后画的大果子盖住一角，
   * 看起来就像"嵌进身体里"。让它压在上层，读起来就是"待在空隙里"，自然得多。 */
  var drawOrder = [];
  function drawFruits() {
    drawOrder.length = 0;
    for (var i = 0; i < fruits.length; i++) drawOrder.push(fruits[i]);
    drawOrder.sort(function (a, b) {
      return FRUITS[b.plugin.level].radius - FRUITS[a.plugin.level].radius;
    });
    for (var j = 0; j < drawOrder.length; j++) {
      var b = drawOrder[j];
      var f = FRUITS[b.plugin.level];
      var p = spritePos(b);
      /* 贴形的复合碰撞体必须和画面同角度，否则碰撞和看到的位置会错开 */
      drawFruit(f, p.x, p.y, b.angle, popScale(b.plugin), !!b.plugin.com);
    }
  }

  function drawCurrent() {
    if (!S.current || S.mode !== 'playing') return;
    var f = FRUITS[S.current.level];
    var t = Math.min(1, (S.time - S.current.born) / 170);
    var drop = (1 - easeOutBack(t)) * 34;          // 从上方滑入
    var bob = Math.sin(S.time / 430) * 2.4;
    drawFruit(f, S.current.x, DROP_Y - drop + bob, 0, 1);
  }

  /* ---------------------------- 特效 ---------------------------- */

  function burst(x, y, level, big) {
    var f = FRUITS[level];
    var n = big ? 30 : 9 + level;
    for (var i = 0; i < n; i++) {
      var a = Math.random() * Math.PI * 2;
      var sp = 1.1 + Math.random() * (big ? 5.4 : 3.0);
      particles.push({
        x: x, y: y,
        vx: Math.cos(a) * sp,
        vy: Math.sin(a) * sp - 1.1,
        r: (1.4 + Math.random() * 2.6) * (1 + level * 0.05),
        life: 0,
        max: 340 + Math.random() * 320,
        color: Math.random() < 0.55 ? f.color : (f.color2 || f.color)
      });
    }
    rings.push({ x: x, y: y, r: f.radius * 0.45, life: 0, max: 420, color: f.color });
  }

  function bigBurst(x, y) {
    for (var i = 0; i < 44; i++) {
      var a = Math.random() * Math.PI * 2;
      var sp = 2 + Math.random() * 7;
      particles.push({
        x: x, y: y,
        vx: Math.cos(a) * sp,
        vy: Math.sin(a) * sp - 2,
        r: 2 + Math.random() * 4,
        life: 0,
        max: 500 + Math.random() * 500,
        color: ['#ff5f6d', '#ffc371', '#3fae5a', '#ffe14d'][i % 4]
      });
    }
    rings.push({ x: x, y: y, r: 20, life: 0, max: 700, color: '#ff8a3d' });
  }

  function floatingText(x, y, str, strong) {
    texts.push({
      x: x + (Math.random() - 0.5) * 16,
      y: y - Math.random() * 12,
      str: str,
      life: 0, max: 900,
      color: strong ? '#ff5a2d' : '#d9743a',
      size: strong ? 20 : 16
    });
  }

  function drawEffects() {
    var i, p, k;

    for (i = 0; i < particles.length; i++) {
      p = particles[i];
      var a = 1 - p.life / p.max;
      ctx.globalAlpha = Math.max(0, a);
      ctx.fillStyle = p.color;
      ctx.beginPath();
      ctx.arc(p.x, p.y, p.r * (0.4 + a * 0.6), 0, Math.PI * 2);
      ctx.fill();
    }
    ctx.globalAlpha = 1;

    for (i = 0; i < rings.length; i++) {
      p = rings[i];
      k = p.life / p.max;
      ctx.globalAlpha = (1 - k) * 0.55;
      ctx.strokeStyle = p.color;
      ctx.lineWidth = 3 * (1 - k) + 0.6;
      ctx.beginPath();
      ctx.arc(p.x, p.y, p.r + k * p.r * 2.4, 0, Math.PI * 2);
      ctx.stroke();
    }
    ctx.globalAlpha = 1;

    ctx.textAlign = 'center';
    ctx.textBaseline = 'middle';
    for (i = 0; i < texts.length; i++) {
      p = texts[i];
      k = p.life / p.max;
      ctx.globalAlpha = k < 0.15 ? k / 0.15 : Math.max(0, 1 - (k - 0.15) / 0.85);
      ctx.font = '800 ' + p.size + 'px -apple-system, "PingFang SC", "Microsoft YaHei", sans-serif';
      ctx.fillStyle = '#fff';
      ctx.lineWidth = 3;
      ctx.strokeStyle = 'rgba(255,255,255,0.92)';
      ctx.strokeText(p.str, p.x, p.y - k * 34);
      ctx.fillStyle = p.color;
      ctx.fillText(p.str, p.x, p.y - k * 34);
    }
    ctx.globalAlpha = 1;
  }

  function updateEffects(dt) {
    var k = dt / 16.667, i;

    for (i = particles.length - 1; i >= 0; i--) {
      var p = particles[i];
      p.life += dt;
      if (p.life >= p.max) { particles.splice(i, 1); continue; }
      p.vy += 0.16 * k;
      p.vx *= 0.995;
      p.x += p.vx * k;
      p.y += p.vy * k;
      if (p.y > H - WALL - 2) { p.y = H - WALL - 2; p.vy *= -0.35; p.vx *= 0.7; }
    }
    for (i = rings.length - 1; i >= 0; i--) {
      rings[i].life += dt;
      if (rings[i].life >= rings[i].max) rings.splice(i, 1);
    }
    for (i = texts.length - 1; i >= 0; i--) {
      texts[i].life += dt;
      if (texts[i].life >= texts[i].max) texts.splice(i, 1);
    }
  }

  function drawDanger() {
    if (S.danger <= 0) return;
    var ratio = Math.min(1, S.danger / RULES.dangerDwell);
    var g = ctx.createLinearGradient(0, 0, 0, H * 0.45);
    g.addColorStop(0, 'rgba(255, 70, 60, ' + (0.2 * ratio) + ')');
    g.addColorStop(1, 'rgba(255, 70, 60, 0)');
    containerPath();
    ctx.fillStyle = g;
    ctx.fill();
  }

  /* 静态背景（容器底色 + 器壁）缓存成一张图，只在尺寸变化时重绘。
   * 这个画布在手机上要处理上百万像素，每帧重画整块渐变其实不便宜，
   * 缓存后每帧只剩一次贴图。 */
  var bgCanvas = document.createElement('canvas');
  var bgReady = false;

  function buildBackground() {
    if (!canvas.width || !canvas.height) return;
    bgCanvas.width = canvas.width;
    bgCanvas.height = canvas.height;
    var keep = ctx;
    ctx = bgCanvas.getContext('2d');
    ctx.setTransform(view.dpr * view.scale, 0, 0, view.dpr * view.scale, 0, 0);
    ctx.clearRect(0, 0, W, H);
    drawContainerFill();
    drawContainerWalls();
    ctx = keep;
    bgReady = true;
  }

  function render() {
    ctx.setTransform(view.dpr * view.scale, 0, 0, view.dpr * view.scale, 0, 0);
    ctx.clearRect(0, 0, W, H);

    ctx.save();
    if (S.shake > 0.15) {
      ctx.translate((Math.random() - 0.5) * S.shake, (Math.random() - 0.5) * S.shake);
    }

    /* 容器底色和器壁是静态的，缓存成一张图，省掉每帧重画整块渐变 */
    if (!bgReady) buildBackground();
    ctx.drawImage(bgCanvas, 0, 0, bgCanvas.width, bgCanvas.height, 0, 0, W, H);

    drawDeathLine();
    drawGuide();
    drawFruits();
    drawEffects();
    drawDanger();
    drawCurrent();
    if (DEBUG) drawHitboxes();

    ctx.restore();
  }

  /* 调素材用：显示每个果子的圆形碰撞体，方便对齐「图上大小」与「实际碰撞」 */
  function drawHitboxes() {
    ctx.save();
    ctx.setLineDash([4, 3]);
    ctx.lineWidth = 1;
    ctx.strokeStyle = 'rgba(232, 40, 120, 0.9)';
    for (var i = 0; i < fruits.length; i++) {
      var b = fruits[i];
      var parts = b.parts.length > 1 ? b.parts.slice(1) : [b];
      for (var k = 0; k < parts.length; k++) {
        ctx.beginPath();
        ctx.arc(parts[k].position.x, parts[k].position.y, parts[k].circleRadius, 0, Math.PI * 2);
        ctx.stroke();
      }
    }
    if (S.current) {
      ctx.strokeStyle = 'rgba(232, 40, 120, 0.45)';
      ctx.beginPath();
      ctx.arc(S.current.x, DROP_Y, FRUITS[S.current.level].radius, 0, Math.PI * 2);
      ctx.stroke();
    }
    ctx.restore();
  }

  /* ============================ 主循环 ============================ */

  var acc = 0;
  var lastTs = 0;

  function update(dt) {
    S.time += dt;

    if (S.mode === 'playing') {
      if (S.current) {
        var f = FRUITS[S.current.level];
        S.pointerX = clamp(S.pointerX, WALL + f.radius, W - WALL - f.radius);
        S.current.x += (S.pointerX - S.current.x) * (1 - Math.exp(-dt / 55));
      } else if (S.cooldown > 0) {
        S.cooldown -= dt;
        if (S.cooldown <= 0) { S.cooldown = 0; spawnNext(); }
      }
    }

    // 物理：固定步长，最多补 4 帧，避免掉帧后爆炸
    acc += dt;
    var steps = 0;
    if (frozen) {
      acc = 0;
      if (S.mode === 'playing') checkDanger(dt);   // 冻住也要继续判危险
      /* 保险：冻结状态下如果有果子四周什么都没挨着，说明它是悬空的（不该发生），
       * 立刻解冻让它掉下来。这条保证"冻结 ⇒ 一定有支撑"。 */
      if ((++frozenTick % 20) === 0 && hasSuspended()) thaw();
    } else {
      while (acc >= STEP && steps < 4) {
        M.Engine.update(engine, STEP);
        clampSpeeds();
        processMerges();
        acc -= STEP;
        steps++;
        if (S.mode === 'playing') checkDanger(STEP);
      }
      if (steps === 4) acc = 0;
      quietFrames = sceneIsQuiet() ? quietFrames + 1 : 0;
      if (quietFrames > 30 && S.time > wakeUntil) frozen = true;   // 安静半秒且过了缓冲期才冻住
                                                // 悬空的果子在重力下几帧内就会超过阈值，
                                                // 所以"安静"本身就等价于"都踩实了"。
    }

    updateEffects(dt);
    S.shake *= Math.pow(0.86, dt / 16.667);
    if (S.shake < 0.15) S.shake = 0;
  }

  function loop(ts) {
    requestAnimationFrame(loop);
    if (!lastTs) lastTs = ts;
    var dt = ts - lastTs;
    lastTs = ts;
    if (dt > 64) dt = 64;
    if (dt < 0) dt = 0;
    update(dt);
    render();
  }

  /* ============================ 6. 输入 ============================ */

  function clamp(v, a, b) { return v < a ? a : (v > b ? b : v); }

  function toWorldX(clientX) {
    var r = canvas.getBoundingClientRect();
    return (clientX - r.left) / r.width * W;
  }

  function pointerX(e) {
    if (S.current) {
      var f = FRUITS[S.current.level];
      S.pointerX = clamp(toWorldX(e.clientX), WALL + f.radius, W - WALL - f.radius);
    } else {
      S.pointerX = clamp(toWorldX(e.clientX), WALL, W - WALL);
    }
  }

  function onDown(e) {
    if (S.mode !== 'playing') return;
    e.preventDefault();
    S.dragging = true;
    pointerX(e);
    try { canvas.setPointerCapture(e.pointerId); } catch (err) {}
    sfx.unlock();
  }

  function onMove(e) {
    if (S.mode !== 'playing') return;
    // 鼠标没有按下也应该跟着走（电脑端选位）；触屏只有按下才会有 pointermove
    if (!S.dragging && e.pointerType !== 'mouse') return;
    if (e.pointerType === 'mouse') e.preventDefault();
    pointerX(e);
  }

  function onUp(e) {
    if (!S.dragging) return;
    S.dragging = false;
    if (S.mode !== 'playing') return;
    pointerX(e);
    dropCurrent();
  }

  canvas.addEventListener('pointerdown', onDown, { passive: false });
  canvas.addEventListener('pointermove', onMove, { passive: false });
  canvas.addEventListener('pointerup', onUp);
  canvas.addEventListener('pointercancel', function () { S.dragging = false; });
  canvas.addEventListener('contextmenu', function (e) { e.preventDefault(); });

  againBtn.addEventListener('click', startGame);

  soundBtn.addEventListener('click', function () {
    S.soundOn = !S.soundOn;
    storeSet('sound', S.soundOn ? '1' : '0');
    soundBtn.classList.toggle('off', !S.soundOn);
    if (S.soundOn) sfx.unlock();
  });

  window.addEventListener('resize', resize);
  window.addEventListener('orientationchange', function () {
    setTimeout(resize, 260);
  });
  if (window.ResizeObserver) {
    new ResizeObserver(function () { resize(); }).observe(stage);
  }
  document.addEventListener('visibilitychange', function () {
    if (!document.hidden) lastTs = 0;
  });

  /* ============================ 音效 ============================ */

  var sfx = (function () {
    var ac = null;

    function ctxOn() {
      if (!S.soundOn) return null;
      if (!ac) {
        var AC = window.AudioContext || window.webkitAudioContext;
        if (!AC) return null;
        try { ac = new AC(); } catch (e) { return null; }
      }
      if (ac.state === 'suspended') { try { ac.resume(); } catch (e) {} }
      return ac;
    }

    function tone(freq, dur, type, vol, delay, freqTo) {
      var c = ctxOn();
      if (!c) return;
      var t0 = c.currentTime + (delay || 0);
      var o = c.createOscillator();
      var g = c.createGain();
      o.type = type || 'sine';
      o.frequency.setValueAtTime(freq, t0);
      if (freqTo) o.frequency.exponentialRampToValueAtTime(freqTo, t0 + dur);
      g.gain.setValueAtTime(0.0001, t0);
      g.gain.exponentialRampToValueAtTime(vol, t0 + 0.012);
      g.gain.exponentialRampToValueAtTime(0.0001, t0 + dur);
      o.connect(g);
      g.connect(c.destination);
      o.start(t0);
      o.stop(t0 + dur + 0.03);
    }

    return {
      unlock: function () { ctxOn(); },
      drop: function () { tone(190, 0.08, 'sine', 0.12, 0, 120); },
      merge: function (lv) {
        var base = 230 * Math.pow(1.085, lv);
        tone(base, 0.15, 'triangle', 0.11);
        tone(base * 1.5, 0.1, 'sine', 0.05, 0.012);
      },
      win: function () {
        tone(523, 0.12, 'triangle', 0.12);
        tone(659, 0.12, 'triangle', 0.11, 0.1);
        tone(784, 0.24, 'triangle', 0.11, 0.2);
      },
      over: function () {
        tone(392, 0.16, 'sine', 0.1);
        tone(311, 0.18, 'sine', 0.1, 0.15);
        tone(233, 0.34, 'sine', 0.1, 0.32);
      }
    };
  })();

  function vibrate(p) {
    if (navigator.vibrate) { try { navigator.vibrate(p); } catch (e) {} }
  }

  /* ============================ 启动 ============================ */

  bestEl.textContent = S.best;
  soundBtn.classList.toggle('off', !S.soundOn);
  loadSprites();
  resize();
  updateNextChip();
  resetGame();          // 直接开局，不再有开始弹窗
  requestAnimationFrame(loop);

  // 调试用
  window.__watermelon = { S: S, engine: engine, fruits: fruits, reset: resetGame, seq: spawnSeq, sprites: sprites, mg: mgStats, add: addFruit };
})();
