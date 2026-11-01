/* =========================================================================
 *  合成大西瓜 · 配置表
 *  ---------------------------------------------------------------
 *  想换素材？只改 fruits[] 里每一项的 sprite 就行。
 *  想调手感？改 physics / rules。
 *  想改等级数量？直接增删 fruits[] 里的条目（引擎会自适应）。
 *
 *  坐标系统：世界宽度固定 360、高度 640，渲染时整体等比缩放到屏幕，
 *            所以手机 / 平板 / 电脑上的物理表现完全一致。
 * ========================================================================= */
var GAME_CONFIG = {

  /* ---------------------------- 场地 ---------------------------- */
  world: {
    width: 384,      // 世界宽度（外框，含两侧壁厚）
    height: 584,     // 世界高度（外框，含底壁厚）
    wall: 12,        // 容器壁厚度：内壁在 wall 处，可玩区域 = 360 x 560
    dropY: 50,       // 待落果子悬停的高度
    deathY: 92       // 死亡线高度：果子堆过这条线并保持一段时间就结束
  },

  /* ------------------------- 素材来源（可选） ------------------------- */
  /* 国内直连 GitHub Pages 常常要十几秒才响应。把素材放到更快的 CDN（比如 jsDelivr
   * 直接读这个仓库）能立竿见影，文件一个都不用挪：
   *
   *   spriteBase: 'https://cdn.jsdelivr.net/gh/用户名/仓库名@main/assets/fruits/'
   *
   * 留空 = 用仓库里的相对路径。注意末尾要带斜杠。 */
  assets: {
    /* 素材走 jsDelivr（免费、不用注册，直接读这个公开仓库）。
     * 万一 CDN 不通，代码会自动回退到仓库里的相对路径，不会卡死。
     * 想改回本地：把这里清空成 '' 即可。 */
    spriteBase: 'https://cdn.jsdelivr.net/gh/jiuxiang7/synthesis@main/assets/fruits/'
  },

  /* ---------------------------- 物理 ---------------------------- */
  physics: {
    gravity: 1.0,           // 重力，越大掉得越快
    restitution: 0.2,      // 弹性，0 = 完全不弹
    friction: 0.18,         // 摩擦，越大越不容易滑动
    frictionStatic: 0.55,   // 静摩擦
    frictionAir: 0.003,     // 空气阻力，让果子轻微“发闷”
    slop: 0.05,             // 允许的穿透量，太小会「弹开」而不是「挤在一起」
    maxSpeed: 22,           // 速度上限(px/帧)，防止偶发穿墙
    positionIterations: 12, // 位置迭代，越高堆叠越稳（性能换稳定）
    velocityIterations: 8,
    constraintIterations: 2
  },

  /* ---------------------------- 规则 ---------------------------- */
  rules: {
    spawnLevels: 5,                     // 只有前 N 级会掉落
    spawnWeights: [3.0, 2.8, 2.4, 1.9, 1.4], // 各等级出现权重
    firstLevel: 0,                      // 开局第一颗固定为第几级（0 = 最低级）
    maxRepeat: 2,                       // 同一级最多连着出几次（2 = 不会出现三连）
    dropCooldown: 340,                  // 两次投放的最短间隔(ms)
    dangerDwell: 1300,                  // 越过死亡线坚持多久算输(ms)
    comboWindow: 700,                   // 连击判定窗口(ms)
    comboStep: 0.2,                     // 每层连击的加成
    comboMax: 1.0,                      // 连击加成上限（1.0 = 最高 +100%）
    recycle: 0                          // 两个满级相撞后变回第几级（0 = 最低级；-1 = 直接消失）
  },

  /* ---------------------------- 水果 ---------------------------- */
  /*
   *  name          显示名称
   *  radius        碰撞半径（圆形碰撞体，世界坐标）
   *  score         合成出这一级时得到的分数
   *  color/color2  没有素材时的兜底渐变色
   *  sprite        素材路径，留空 '' 则画一个圆形色块
   *  spriteScale   视觉缩放，相对碰撞直径；非圆形素材可以用它调大小
   *  spriteOffsetY 视觉上下偏移，单位是「半径」，正数向下（叶子/果蒂类素材好用）
   *  rotate        是否跟随物理旋转（有明确朝向的素材可以设 false）
   */
  fruits: [
    { name: '电',   radius: 13, score: 0,  color: '#9a6ce0', color2: '#6236ad', sprite: 'assets/fruits/01-uestc.webp',     spriteScale: 1.02, spriteOffsetY: 0,    rotate: 0.4  },
    { name: '奶蛋',   radius: 16, score: 2,  color: '#e63b3b', color2: '#a81414', sprite: 'assets/fruits/02-egg.webp',    spriteScale: 1.05, spriteOffsetY: 0,    rotate: 0.4  },
    { name: '奶鼠',   radius: 26, score: 5,  color: '#ff9a1f', color2: '#dd6a00', sprite: 'assets/fruits/03-mice.webp',    spriteScale: 1.05, spriteOffsetY: 0,    rotate: true  },
    { name: '奶鸡',   radius: 35, score: 9,  color: '#ffe14d', color2: '#e0af00', sprite: 'assets/fruits/04-chicken.webp',     spriteScale: 1.08, spriteOffsetY: 0,    rotate: 0.4  },
    { name: '奶狗', radius: 45, score: 14, color: '#a6d94f', color2: '#6b4220', sprite: 'assets/fruits/05-dog.webp',      spriteScale: 1.00, spriteOffsetY: 0,    rotate: true  },
    { name: '奶猪',   radius: 60, score: 20, color: '#ec3b2f', color2: '#b31b12', sprite: 'assets/fruits/06-pig.webp',    spriteScale: 1.08, spriteOffsetY: -0.02, rotate: 0.4 },
    { name: '奶马', radius: 67, score: 28, color: '#ff9f8c', color2: '#d43a52', sprite: 'assets/fruits/07-horse.webp',     spriteScale: 1.08, spriteOffsetY: 0,    rotate: 0.4  },
    { name: '奶嘟嘟',   radius: 85, score: 38, color: '#f6b93b', color2: '#c98211', sprite: 'assets/fruits/08-kangaroo.webp', spriteScale: 1.06, spriteOffsetY: 0.05, rotate: 0.4  },
    { name: '奶龙',   radius: 100, score: 50, color: '#8b5a30', color2: '#5d3a1c', sprite: 'assets/fruits/09-long.webp',   spriteScale: 1.00, spriteOffsetY: 0,    rotate: true  },
    { name: '川', radius: 13, score: 65, color: '#ff5a6e', color2: '#2f8b3f', sprite: 'assets/fruits/10-scu.webp', spriteScale: 1.02, spriteOffsetY: 0.1, rotate: true }
  ]
};

/* Node 环境下也能 require（给离线物理测试用） */
if (typeof module !== 'undefined' && module.exports) { module.exports = GAME_CONFIG; }
