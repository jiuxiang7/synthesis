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
  var PK      = window.PhysicsKit;
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
  var DEBUG   = /[?&]debug\b/.test(location.search);   // ?debug=1 显示碰撞体，调素材时用

  /* 合成出来的果子会"弹"一下 —— 纯视觉，碰撞体一出生就是全尺寸。
   * 这一点和之前的做法正好相反：之前靠缩放碰撞体来演动画，动画那 0.26 秒里
   * 画面和碰撞一直对不上，才会出现"看着没碰却顶着"的怪事。 */
  var POP_MS = 170;

  /* ---------------------------- DOM ---------------------------- */

  var canvas      = document.getElementById('game');
  var ctx         = canvas.getContext('2d');
  var stage       = document.getElementById('stage');
  var scoreEl     = document.getElementById('score');
  var bestEl      = document.getElementById('best');
  var comboEl     = document.getElementById('combo');
  var nextCanvas  = document.getElementById('next-canvas');
  var nextCtx     = nextCanvas ? nextCanvas.getContext('2d') : null;
  var soundBtn    = document.getElementById('sound-btn');
  var loadingEl   = document.getElementById('loading');
  var loadingText = document.getElementById('loading-text');
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
    assetsReady: false,
    mode: 'ready',        // ready | playing | over
    score: 0,
    best: Number(storeGet('best', 0)) || 0,
    soundOn: storeGet('sound', '1') !== '0',
    time: 0,
    current: null,        // { level, x, born } 手里这颗
    nextLevel: 0,         // 「下一个」显示的那颗 —— 也是落下后立刻到手上的那颗
    backup: 0,            // 藏在后面的备胎：手上换人时它顶上「下一个」的位置
    cooldown: 0,
    dragging: false,
    pointerX: W / 2,
    combo: 0,
    maxMerged: 0,         // 本局靠合成做到过的最高等级（决定哪些等级可以掉落）
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

  var world = PK.create({
    width: W,
    height: H,
    wall: WALL,
    gravity: PHYS.gravity,
    substeps: PHYS.substeps,
    iterations: PHYS.iterations,
    restitution: PHYS.restitution,
    wallRestitution: PHYS.wallRestitution,
    friction: PHYS.friction,
    restThreshold: PHYS.restThreshold,
    mergePad: PHYS.mergePad,
    maxSpeed: PHYS.maxSpeed,
    upright: PHYS.upright
  });

  /* 引擎原地增删，这里拿的是同一个数组，不用每帧同步 */
  var fruits = world.balls;

  /* 把素材形状交给引擎。必须在素材全部加载完之后调用一次：
   * 形状是「沿轮廓铺的一圈内切小圆」，由 tools/build-meta.py 离线算好。 */
  function applyShapes() {
    var shapes = [], radii = [];
    for (var i = 0; i < FRUITS.length; i++) {
      var info = sprites[i];
      var r = FRUITS[i].radius * (FRUITS[i].spriteScale || 1);
      var cs = info && info.shape && info.shape.circles;
      radii.push(r);

      if (cs && cs.length) {
        var parts = [];
        for (var k = 0; k < cs.length; k++) {
          var c = cs[k];
          parts.push(Array.isArray(c) ? [c[0], c[1], c[2]] : [c.x, c.y, c.r]);
        }
        shapes.push({ parts: parts, rb: info.shape.rb || 1.06 });
      } else {
        shapes.push({ parts: [[0, 0, 1]], rb: 1 });   // 没数据：退化成单个圆
      }
    }
    world.setTiers(shapes, radii);
  }

  /* 放一颗果子。位置、速度、质量都由引擎管，游戏这边不保存副本。 */
  function addFruit(level, x, y, vx, vy) {
    return world.add(level, x, y, vx, vy);
  }

  /* ============================ 3. 合成逻辑 ============================ */

  /* 引擎报上来的合成：位置已经定好（两颗的中点），下一级也已经按全尺寸建好，
   * 这里只负责分数、特效、音效。
   *
   * 这里**没有**"把旁边的果子挤开"这一步：位置约束在同一个子步里就把重叠
   * 推干净了，而且新果子质量大（质量 ∝ 半径²），被推开的几乎总是旁边小的那颗，
   * 所以合成点天然被保住。 */
  function onMerge(ev) {
    var level = ev.level;
    var finished = ev.next < 0;
    var mx = ev.x, my = ev.y;

    /* --- 连击 --- */
    var chained = (S.time - S.lastMergeAt) < RULES.comboWindow;
    S.combo = chained ? S.combo + 1 : 1;
    S.lastMergeAt = S.time;
    var mult = 1 + Math.min((S.combo - 1) * RULES.comboStep, RULES.comboMax);

    /* --- 掉落解锁：合出这一级之后，下一级才进入掉落池 --- */
    if (ev.next >= 0 && ev.next > S.maxMerged) {
      var wasN = dropPoolSize();
      S.maxMerged = ev.next;
      var nowN = dropPoolSize();
      if (nowN > wasN) floatingText(W / 2, DEATH_Y + 38, '掉落解锁 ' + nowN + ' 级', false);
    }

    /* --- 计分 --- */
    var base = finished ? FRUITS[MAX_LV].score * 2 : FRUITS[ev.next].score;
    var gain = Math.round(base * mult);
    addScore(gain);

    /* --- 特效 --- */
    burst(mx, my, level, finished);
    floatingText(mx, my - FRUITS[level].radius * 0.4, '+' + gain, mult > 1);
    showCombo(mult);

    if (!finished) {
      S.shake = Math.min(S.shake + 1.1 + level * 0.3, 11);
      sfx.merge(ev.next);
      vibrate(level >= 6 ? 18 : 9);
      return;
    }

    /* --- 轮回：两个满级果子相撞，按 rules.recycle 变回某个低级果子 --- */
    S.shake = 13;
    bigBurst(mx, my);
    sfx.win();
    vibrate([20, 40, 20]);

    var backTo = (typeof RULES.recycle === 'number') ? RULES.recycle : 0;
    if (backTo >= 0 && backTo <= MAX_LV) {
      world.add(backTo, mx, my, 0, -120);
      rings.push({ x: mx, y: my, r: FRUITS[MAX_LV].radius * 0.7, life: 0, max: 640, color: '#ffcf5c' });
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
  /* 本局当前可以掉落的等级数（前 n 级）。
   *
   * 规则「靠合成解锁」：开局只掉前 spawnBaseLevels 级；合出第 k 级之后，
   * 第 k+1 级才会进入掉落池。也就是——没合到过的等级，不会白白掉给你。
   * 这样前期不会被高等级果子"喂"到，节奏完全靠自己合出来。 */
  function dropPoolSize() {
    var n = Math.min(RULES.spawnLevels, RULES.spawnWeights.length, FRUITS.length);
    if (RULES.spawnUnlock !== false) {
      var base = Math.max(1, Math.min(RULES.spawnBaseLevels || 3, n));
      n = Math.min(n, Math.max(base, S.maxMerged + 1));
    }
    return n;
  }

  function randLevel() {
    var w = RULES.spawnWeights;
    var n = dropPoolSize();
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
    world.reset();
    particles.length = 0;
    rings.length = 0;
    texts.length = 0;

    S.score = 0;
    S.combo = 0;
    S.maxMerged = 0;
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

    /* 三格队列，顺序就是它们到手上的顺序：
     *   current（手上） → nextLevel（「下一个」，落下后接手） → backup（备胎，补位用）
     * 「下一个」永远显示 nextLevel，也就是你落下手上这颗之后**立刻**拿到的那颗。 */
    S.current = { level: first, x: W / 2, born: S.time };
    S.nextLevel = nextSpawnLevel();
    S.backup = nextSpawnLevel();
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

  /* 画「下一个」。
   *
   * 用 canvas 而不是 <img>，因为 <img> 加载的是另一条 URL（可能走 CDN、可能被缓存），
   * 和游戏里真正画出来的那张图不一定是同一张 —— 那就会出现"显示的是一个、落下的是另一个"。
   * 这里直接拿 sprites[] 里已经烘焙好的画布，和场上用的是同一份像素。 */
  function updateNextChip() {
    if (!nextCtx) return;
    var cw = nextCanvas.width, ch = nextCanvas.height;
    nextCtx.clearRect(0, 0, cw, ch);

    var f = FRUITS[S.nextLevel];
    if (!f) return;

    var sprite = sprites[S.nextLevel];
    if (sprite && sprite.canvas) {
      var pad = cw * 0.05;
      var d = Math.min(cw, ch) - pad * 2;
      nextCtx.drawImage(sprite.canvas, (cw - d) / 2, (ch - d) / 2, d, d);
      return;
    }

    /* 没素材的兜底：画一颗渐变圆 */
    var r = Math.min(cw, ch) * 0.38;
    var grd = nextCtx.createRadialGradient(
      cw / 2 - r * 0.3, ch / 2 - r * 0.3, r * 0.1, cw / 2, ch / 2, r);
    grd.addColorStop(0, f.color);
    grd.addColorStop(1, f.color2 || f.color);
    nextCtx.beginPath();
    nextCtx.arc(cw / 2, ch / 2, r, 0, Math.PI * 2);
    nextCtx.fillStyle = grd;
    nextCtx.fill();
  }

  /* ---------------------------- 投放 ---------------------------- */

  function dropCurrent() {
    if (S.mode !== 'playing' || !S.current || S.cooldown > 0) return;
    var f = FRUITS[S.current.level];
    var r = f.radius * (f.spriteScale || 1);
    var x = clamp(S.current.x, WALL + r, W - WALL - r);
    addFruit(S.current.level, x, DROP_Y, 0, 120);
    sfx.drop();
    S.cooldown = RULES.dropCooldown;

    /* 掉落的同时把下一颗直接拿到手上，整个队列往前挪一格：
     *     手上   ← 「下一个」显示的那颗
     *     「下一个」 ← 备胎
     *     备胎   ← 新抽一颗
     *
     * 所以 chip 上画的那颗，就是你**落下手上这颗之后立刻会拿到**的那颗（不是再下一颗）。
     * 之前是把备胎直接塞进手上、chip 却换成新抽的，等于显示的东西要隔一次才轮到 —— 
     * 看起来就是「下一个」老是慢一拍。 */
    var nx = FRUITS[S.nextLevel];
    var nr = nx.radius * (nx.spriteScale || 1);
    S.current = {
      level: S.nextLevel,
      x: clamp(S.pointerX, WALL + nr, W - WALL - nr),
      born: S.time
    };
    S.nextLevel = S.backup;
    S.backup = nextSpawnLevel();
    updateNextChip();
  }

  /* ---------------------------- 死亡判定 ---------------------------- */

  function checkDanger(dt) {
    var over = false;
    for (var i = 0; i < fruits.length; i++) {
      var b = fruits[i];
      if (world.time - b.bornAt < 1200) continue;        // 刚掉下来的不算
      var sp = Math.sqrt(b.vx * b.vx + b.vy * b.vy);
      if (sp > 70) continue;                             // 还在动的也不算（px/s）
      if (b.y - b.r < DEATH_Y) { over = true; break; }
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

  /* 素材加载：全部就绪才允许开局。
   * 前 6 级优先下载（开局只会出现这几级），其余并行下载；
   * 任何一张没加载完都不放开操作，避免缺图的等级画成备用渐变色。 */
  var CRITICAL = 6;                     // 只用来标记下载优先级，不再分批放行
  var loadState = { done: 0, total: 0, failed: [], t0: 0 };

  function updateLoading() {
    if (!loadingText) return;

    if (loadState.done < loadState.total) {
      loadingText.innerHTML = '正在载入素材 ' + loadState.done + ' / ' + loadState.total;
      loadingEl.classList.remove('hidden');
      S.assetsReady = false;
      return;
    }

    if (loadState.failed.length) {
      loadingText.innerHTML = '正在载入素材 ' + loadState.done + ' / ' + loadState.total +
        
        '<span class="sub">检查网络后刷新重试</span>';
      loadingEl.classList.remove('hidden');
      return;
    }

    loadingEl.classList.add('hidden');
    if (!S.assetsReady) {
      applyShapes();                     // 素材齐了才能把形状交给物理
      updateNextChip();                  // 素材到了，「下一个」从占位圆换成真图
      S.assetsReady = true;
      S.loadMs = Math.round(performance.now() - loadState.t0);
      if (DEBUG) console.info('[载入] 可开始游戏用时 ' + S.loadMs + 'ms');
      setTimeout(collectTiming, 0);
    }
  }

  /* 首屏耗时诊断（?debug=1 时打到控制台 + 画在角落），用来区分"服务端慢"和"文件大" */
  var netInfo = null;
  function collectTiming() {
    try {
      var nav = performance.getEntriesByType('navigation')[0];
      var res = performance.getEntriesByType('resource');
      var bytes = 0, slow = { n: '', ms: 0 }, count = 0;
      for (var i = 0; i < res.length; i++) {
        bytes += res[i].transferSize || 0;
        count++;
        var ms = res[i].responseEnd - res[i].startTime;
        if (ms > slow.ms) slow = { n: res[i].name.split('/').pop(), ms: ms };
      }
      netInfo = {
        ttfb: nav ? Math.round(nav.responseStart) : 0,
        html: nav ? Math.round(nav.responseEnd) : 0,
        total: Math.round(performance.now()),
        reqs: count,
        kb: Math.round(bytes / 1024),
        slow: slow.n + ' ' + Math.round(slow.ms) + 'ms'
      };
      console.info('[首屏]', JSON.stringify(netInfo));
    } catch (e) {}
  }

  /* 素材地址：默认用仓库里的相对路径；配置了 assets.spriteBase 就走 CDN */
  var SPRITE_BASE = (CFG.assets && CFG.assets.spriteBase) || '';
  function spriteURL(path) {
    return SPRITE_BASE ? SPRITE_BASE + path.replace(/^assets\/fruits\//, '') : path;
  }

  /* 素材地址：默认仓库相对路径；配了 assets.spriteBase 就先走 CDN。
   * 另外做了"竞速"：CDN 超过 RACE_MS 还没回，就同时开始拉本地文件，谁先到用谁。
   * 这样 CDN 抽风/绕路时最多损失一点点时间，不会把开局拖到十几秒。 */
  var RACE_MS = 1800;

  function loadOne(f, i, critical) {
    var settled = false;
    var timer = null;

    function settle(ok, img) {
      if (settled) return;
      settled = true;
      if (timer) { clearTimeout(timer); timer = null; }
      if (ok) {
        sprites[i] = bake(img, f.sprite);
      } else {
        loadState.failed.push(f.sprite);
        console.error('[素材加载失败] ' + f.sprite);
      }
      loadState.done++;
      updateLoading();
    }

    function make(url) {
      var im = new Image();
      im.decoding = 'async';
      if (critical && 'fetchPriority' in im) im.fetchPriority = 'high';
      im.src = url;
      return im;
    }

    /* 拉仓库里的本地文件；giveUp=true 时失败就直接判失败 */
    function startLocal(giveUp) {
      if (settled) return;
      var im = make(f.sprite);
      im.onload = function () { settle(true, im); };
      im.onerror = function () { if (giveUp) settle(false); };
    }

    if (!SPRITE_BASE) {
      var a = make(f.sprite);
      a.onload = function () { settle(true, a); };
      a.onerror = function () { startLocal(true); };   // 再试一次本地（带缓存绕行）
      return;
    }

    var c = make(spriteURL(f.sprite));
    c.onload = function () { settle(true, c); };
    c.onerror = function () { startLocal(true); };
    timer = setTimeout(function () { startLocal(false); }, RACE_MS);
  }

  function loadSprites() {
    loadState.t0 = performance.now();
    loadState.done = 0;
    loadState.failed = [];
    loadState.total = FRUITS.filter(function (f) { return !!f.sprite; }).length;
    updateLoading();

    FRUITS.forEach(function (f, i) {
      if (f.sprite) loadOne(f, i, i < CRITICAL);
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

    /* 碰撞形状：优先用预计算好的「沿轮廓的小圆」。
     * 没数据（换了素材又没重跑 tools/build-meta.py）就退化成单个圆 ——
     * 会有点误差，但不会崩，也不会像以前那样在运行时算出个更大的怪形状。 */
    var shape = null;
    if (meta && meta.circles && meta.circles.length) {
      var cs = [];
      for (var ci = 0; ci < meta.circles.length; ci++) {
        var cc = meta.circles[ci];
        cs.push(Array.isArray(cc) ? [cc[0], cc[1], cc[2]] : [cc.x, cc.y, cc.r]);
      }
      shape = { circles: cs, rb: meta.rb || 1.05 };
    }

    return { canvas: out, shape: shape, box: box };
  }

  /* ---------------------------- 绘制工具 ---------------------------- */

  function easeOutBack(t) {
    var c1 = 1.70158, c3 = c1 + 1;
    return 1 + c3 * Math.pow(t - 1, 3) + c1 * Math.pow(t - 1, 2);
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

  /* 画一颗果子。r 是屏幕上的半径（= 碰撞半径 × 弹出动画的比例），
   * squash / sqA 是撞击时的挤压（纯视觉，最多 20% 出头）。
   *
   * 注意这里**不旋转**：碰撞体是一圈固定朝向的小圆，角色立着才和它对得上。
   * 以前让精灵跟着物理角度转，马的腿能转到天上去，碰撞和画面却还是同一个角度 ——
   * 看着更奇怪。 */
  function drawFruit(f, x, y, r, squash, sqA, angle) {
    var sprite = sprites[FRUITS.indexOf(f)];
    var d = r * 2;

    ctx.save();
    ctx.translate(x, y + (f.spriteOffsetY || 0) * r);
    /* 画面角度 = 物理角度：碰撞小圆是跟着一起转的，所以转了也不会错位。 */
    if (angle) ctx.rotate(angle);
    if (squash > 0.002) {
      ctx.rotate(sqA);
      ctx.scale(1 - squash, 1 + squash * 0.55);
      ctx.rotate(-sqA);
    }

    if (sprite) {
      ctx.drawImage(sprite.canvas, -d / 2, -d / 2, d, d);
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

  /* 刚合成出来的果子"弹"一下：从 86% 长到 100%（纯画面，碰撞体一直是全尺寸） */
  function popScale(b) {
    if (!(b.popAt >= 0)) return 1;
    var t = (world.time - b.popAt) / POP_MS;
    if (t >= 1) { b.popAt = -1; return 1; }
    var e = 1 - Math.pow(1 - t, 3);
    return 0.86 + 0.14 * e;
  }

  /* 绘制顺序：大的先画、小的后画。
   * 小果子经常落在大果子腿间、肚皮下的空隙里，如果被后画的大果子盖住一角，
   * 看起来就像"嵌进身体里"。让它压在上层，读起来就是"待在空隙里"，自然得多。 */
  var drawOrder = [];
  function drawFruits() {
    drawOrder.length = 0;
    for (var i = 0; i < fruits.length; i++) drawOrder.push(fruits[i]);
    drawOrder.sort(function (a, b) { return b.r - a.r; });
    for (var j = 0; j < drawOrder.length; j++) {
      var b = drawOrder[j];
      drawFruit(FRUITS[b.tier], b.x, b.y, b.r * popScale(b), b.sq, b.sqA, b.angle);
    }
  }

  function drawCurrent() {
    if (!S.current || S.mode !== 'playing') return;
    var f = FRUITS[S.current.level];
    var t = Math.min(1, (S.time - S.current.born) / 170);
    var drop = (1 - easeOutBack(t)) * 34;          // 从上方滑入
    var bob = Math.sin(S.time / 430) * 2.4;
    drawFruit(f, S.current.x, DROP_Y - drop + bob, f.radius * (f.spriteScale || 1));
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
    if (DEBUG) { drawHitboxes(); drawDebugInfo(); }

    ctx.restore();
  }

  /* 调素材用：显示每个果子的碰撞体（凸块 / 圆），方便对齐「图上大小」与「实际碰撞」 */
  function drawDebugInfo() {
    if (!netInfo) return;
    ctx.save();
    ctx.setTransform(view.dpr, 0, 0, view.dpr, 0, 0);
    ctx.font = '11px ui-monospace, Menlo, Consolas, monospace';
    ctx.textAlign = 'left';          // 之前画分数的函数把它改成了 center
    ctx.textBaseline = 'top';
    ctx.fillStyle = 'rgba(60, 40, 20, .78)';
    var lines = [
      'TTFB ' + netInfo.ttfb + 'ms   HTML ' + netInfo.html + 'ms',
      '可玩 ' + (S.loadMs || 0) + 'ms   请求 ' + netInfo.reqs + ' 个   ' + netInfo.kb + 'KB',
      '最慢 ' + netInfo.slow
    ];
    for (var i = 0; i < lines.length; i++) ctx.fillText(lines[i], 10, 16 + i * 14);
    ctx.restore();
  }

  function drawHitboxes() {
    ctx.save();
    ctx.setLineDash([4, 3]);
    ctx.lineWidth = 1;
    ctx.strokeStyle = 'rgba(232, 40, 120, 0.9)';
    for (var i = 0; i < fruits.length; i++) {
      var b = fruits[i];
      for (var k = 0; k < b.wx.length; k++) {
        ctx.beginPath();
        ctx.arc(b.wx[k], b.wy[k], b.ws[k], 0, Math.PI * 2);
        ctx.stroke();
      }
    }
    if (S.current) {
      ctx.strokeStyle = 'rgba(232, 40, 120, 0.45)';
      var cf = FRUITS[S.current.level];
      var cd = cf.radius * (cf.spriteScale || 1);
      ctx.beginPath();
      ctx.arc(S.current.x, DROP_Y, cd, 0, Math.PI * 2);
      ctx.stroke();
    }
    ctx.restore();
  }

  /* ============================ 主循环 ============================ */

  var acc = 0;
  var lastTs = 0;

  function update(dt) {
    S.time += dt;

    if (S.cooldown > 0) {
      S.cooldown -= dt;
      if (S.cooldown < 0) S.cooldown = 0;
    }

    if (S.mode === 'playing' && S.current) {
      var f = FRUITS[S.current.level];
      var rr = f.radius * (f.spriteScale || 1);
      S.pointerX = clamp(S.pointerX, WALL + rr, W - WALL - rr);
      S.current.x += (S.pointerX - S.current.x) * (1 - Math.exp(-dt / 55));
    }

    /* 物理：固定步长，最多补 4 帧。引擎内部再分 3 个子步，
     * 所以一帧最多 12 次约束迭代 —— 堆得再挤也推得动。 */
    acc += dt;
    var steps = 0;
    while (acc >= STEP && steps < 4) {
      var merges = world.step(STEP / 1000);
      for (var m = 0; m < merges.length; m++) onMerge(merges[m]);
      acc -= STEP;
      steps++;
      if (S.mode === 'playing') checkDanger(STEP);
    }
    if (steps === 4) acc = 0;

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
      var rr = f.radius * (f.spriteScale || 1);
      S.pointerX = clamp(toWorldX(e.clientX), WALL + rr, W - WALL - rr);
    } else {
      S.pointerX = clamp(toWorldX(e.clientX), WALL, W - WALL);
    }
  }

  function onDown(e) {
    if (!S.assetsReady || S.mode !== 'playing') return;
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
  window.__watermelon = {
    S: S, world: world, fruits: fruits, reset: resetGame,
    seq: spawnSeq, sprites: sprites, add: addFruit,
    pool: dropPoolSize, randLevel: randLevel
  };
})();
