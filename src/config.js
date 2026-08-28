/**
 * 肃清协议 3D — 全局调参表
 * 所有数值来自 GDD。1 vox = 1 世界单位 = 1 米。
 * 这里是唯一的数值来源，其他模块不得硬编码玩法常量。
 */

export const WORLD = {
  SX: 64, SY: 8, SZ: 64,        // 体素网格尺寸（单层建筑：层高 5 + 屋顶余量）
  CHUNK: 16,                    // 区块水平边长（高度整层）
  /**
   * 方块渲染缩放量。必须是 0。
   *
   * 曾经是 0.01（每块缩到 0.98）来「留描边缝」，但面剔除会去掉墙内部的面，
   * 于是相邻两块之间那 0.02 的缝就是一条能直接看穿整面墙的裂口 ——
   * 玩家看到的「墙是半透明的、有格线」就是这个。方块必须严丝合缝；
   * 体块的可读性交给 colorJitter 的每块明度抖动 + 六面明暗差来表达。
   */
  BLOCK_INSET: 0,
};

export const PALETTE = {
  wall:      0x1a2029,
  floor:     0x2b3240,
  cover:     0x3a4354,
  amber:     0xf5a623,
  threat:    0xe5484d,
  good:      0x3fb96f,
  cyan:      0x4cc9f0,
  purple:    0xa78bfa,
  moon:      0x9fb4cc,
  nearBlack: 0x141c26,
  white:     0xffffff,
  bloodDark: 0x7a2c2c,
  brass:     0xb08d3f,
  // 武装敌人的护甲外壳。深灰蓝，明显区别于敌人本体的 threat 红——
  // 玩家一眼就能认出「这个敌人扛着甲，别浪费弹药打身体」。
  armor:     0x4a5568,
  /**
   * 重甲盾兵的护盾。比 armor 更沉的钢灰（去掉蓝味、压低明度），
   * 让玩家一眼分辨「这个比普通精英还厚」——护盾只包正面与侧前方，
   * 所以看到这块钢灰板就意味着「这个方向打不穿，得绕」。
   */
  shieldSteel: 0x39414a,
  gearDark:  0x2a3038,
  visor:     0x0b0e12,
  boot:      0x1c1814,

  // 建筑材质三档明度：地板最亮、墙中等、天花板最暗。
  // 抬头比低头更暗，这是室内压迫感最廉价的来源。
  concrete:  0x39404a,   // 水泥地板（比原来的 floor 更亮，手电扫过有反馈）
  wallIn:    0x232b36,   // 室内墙面（略亮于外墙，区分内外）
  ceiling:   0x191f27,   // 天花板
  roof:      0x151a21,   // 屋顶

  /**
   * 家具配色。GDD 的 12 色限制是为了「黑暗中 0.2 秒内分辨墙/掩体/敌人/掉落」，
   * 所以这些家具色刻意都是低饱和的暗色，明度控制在墙体与掩体之间：
   * 它们提供「这是个家」的信息，但绝不会被误认成敌人（红）或拾取物（琥珀/绿/青）。
   */
  furniture: {
    sofa:      0x4a3f52,   // 暗紫灰布艺
    wood:      0x4a3a2c,   // 木色
    woodDark:  0x382c22,   // 深木色
    fabric:    0x3f4653,   // 床品
    screen:    0x0d1014,   // 电视屏（比墙更黑，关着的屏幕）
    carpet:    0x453040,   // 地毯
    plant:     0x2f4a35,   // 植物绿（明显暗于医疗包的亮绿）
    stone:     0x4d5259,   // 台面石材
    porcelain: 0x6b7480,   // 瓷白
    frame:     0x5a4632,   // 画框
    lamp:      0xd8a860,   // 台灯暖光（自发光）
  },
};

export const RENDER = {
  clearColor: PALETTE.nearBlack,
  fogDensity: 0.055,            // FogExp2，与清屏色一致
  /**
   * 每方块明度抖动。BLOCK_INSET 归零后方块之间不再有描边缝，
   * 体块的颗粒感全靠这个抖动 + 六面明暗差表达，所以从 4% 提到 7%。
   */
  colorJitter: 0.07,
  moonBake: 1.35,               // 庭院月光烘焙强度（可辨轮廓，不可辨细节）
  shadowMapSize: 1024,
  maxPixelRatio: 1.75,
};

export const LIGHT = {
  ambientIndoor: 0.05,          // 室内环境光（近乎全黑，但轮廓不至于完全消失）
  moonlight: 0.22,              // 室外庭院月光（烘焙进顶点色）
  moonColor: PALETTE.moon,
  flashlight: {
    color: 0xfff0d4,            // 略微提白：暖调保留，但照出来的地面更干净
    /**
     * three.js r155+ 的物理光照单位：SpotLight 强度是坎德拉，
     * 照度按 intensity / 距离² 衰减。
     *
     * 90 → 220：原来在 10 vox 外照度只有 0.9，扫过墙面几乎看不出光斑边界，
     * 黑屋里「照到哪儿」全靠猜。220 让 10 vox 处照度约 2.2，光斑轮廓清晰，
     * 远端 20 vox 仍有 0.55 的可辨亮度。手电依然是唯一的主动光源。
     */
    intensity: 220,
    distance: 34,               // 射程 34 vox（走廊尽头能照到）
    angleDeg: 30,               // three.js 用半角；锥角 60°
    penumbra: 0.32,             // 边缘再柔一点，避免硬边圆斑
    decay: 1.0,                 // 1.0 = 标准平方反比
    detectSpotRadius: 12,       // 「光斑」被敌人察觉的半径
    onDetectMul: 1.8,           // 开灯：敌人探测距离 ×1.8
    offDetectMul: 0.45,         // 关灯：×0.45
    nearGlow: 5,                // 关灯时身边可见范围
    nearGlowIntensity: 14,
  },
  /**
   * 敌人手电。玩家在黑暗里唯一的「敌人预警」信号 —— 看到光柱扫过就知道有人。
   *
   * 强度刻意远低于玩家（220 → 55）：敌人的灯是给玩家看的线索，
   * 不是给敌人照明的工具（敌人的感知走 canSeePlayer，与光照无关）。
   * 太亮会把整栋楼点亮，黑暗压迫感就没了。
   *
   * 只有最近的 maxLit 个敌人真的挂光源 —— 12 个带阴影的 SpotLight 会直接
   * 把帧率打死，而且远处的灯玩家本来也看不清。
   */
  enemyFlashlight: {
    color: 0xffd9a0,            // 比玩家的更黄，一眼能分辨「那不是我的灯」
    intensity: 55,
    distance: 18,
    angleDeg: 20,               // 锥角 40°，比玩家窄 —— 光斑形状也是识别信号
    penumbra: 0.4,
    decay: 1.0,
    /**
     * 同时点亮的敌人手电数量。
     *
     * 为什么只有 2：每个光源都必须投阴影，否则光会直接照穿墙壁
     * （不投阴影的 SpotLight 对几何体毫无感知，墙对它不存在）。
     * 阴影贴图是这里最贵的一项，2 个 512² 的贴图刚好在预算内。
     * 提高这个值必须同步降低 shadowMapSize，否则帧率会掉。
     */
    maxLit: 2,
    shadowMapSize: 512,
    sweepDeg: 14,               // 待机时左右扫视的幅度
    sweepSpeed: 0.7,
  },
  // 枪口焰同样是物理单位（坎德拉）：要在 ~8 vox 内打出明显的一瞬亮光
  muzzle: { intensity: 60, distance: 10, lifeMs: 80, poolSize: 4 },

  /**
   * ── 应急灯（可击碎的闪烁灯）──
   *
   * 这是唯一「关卡自带、且玩家能改写」的照明。设计意图是一个交换：
   * 站在灯下不开手电也勉强看得清（省下手电的暴露代价），
   * 但敌人也更容易看见你（litDetectMul 比开手电的 1.8 还高）——
   * 想安静过就把灯打掉，代价是重新回到全黑。
   *
   * intensity 刻意压得比手电低一个量级：它只照亮脚下一小片，
   * 不能让整个房间变成白天，否则黑暗压迫感与手电的战术地位都没了。
   */
  emergencyLamp: {
    color: 0xbfd4e8,            // 冷白（区别于手电的暖光，一眼看出不是自己的灯）
    intensity: 26,
    distance: 11,
    decay: 1.0,
    /** 挂灯高度（格底之上多少）。灯管贴天花板下沿。 */
    mountY: 3.4,
    /**
     * 闪烁：亮度在 [flickerMin, 1] 之间随机突跳。
     * 不用平滑正弦 —— 接触不良的灯管是跳变，不是呼吸灯。
     */
    flickerMin: 0.35,
    flickerHz: 11,              // 每秒重新掷一次亮度
    /** 偶发的完全熄灭（更像坏灯，也给潜行留出短暗窗） */
    blackoutChance: 0.06,
    blackoutMs: 90,
    /**
     * 站在灯照范围内时敌人对玩家的探测距离倍率。
     * 比开手电（1.8）更高 —— 灯是持续、全向的暴露，比手电锥更糟。
     */
    litDetectMul: 2.0,
    /** 判定「玩家被这盏灯照到」的水平半径（vox） */
    litRadius: 5.0,
    /** 灯的血量：手枪两发、霰弹一发打碎 */
    hp: 40,
    /** 同时挂真光源的灯数上限（只给最近的几盏，其余靠自发光顶点色） */
    maxLit: 6,
  },
};

export const CAMERA = {
  fov: 70,
  adsFov: 55,
  // 第一人称（C 键切换）。GDD 把它列为 M7 可选项：复用同一套射击逻辑，
  // 只换相机并隐藏角色躯干。黑暗压迫感明显更强。
  fpFov: 80,
  fpAdsFov: 58,
  fpForward: 0.18,              // 眼睛稍微前移，避免看到自己的头部方块
  near: 0.05,
  far: 120,
  offset:    { x: 0.7,  y: 1.8, z: 3.2 },   // 右 / 上 / 后
  adsOffset: { x: 0.45, y: 1.7, z: 1.8 },
  pitchMin: -75 * Math.PI / 180,
  pitchMax:  70 * Math.PI / 180,
  followLerp: 0.18,
  adsFollowLerp: 0.35,
  pullbackPad: 0.3,             // 相机射线回拉留边
  probeRadius: 0.22,            // 回拉采样的四角撒开半径（相机近平面的近似体积）
  mouseSensitivity: 0.0022,
  crouchEyeDrop: 0.55,
};

export const PLAYER = {
  /**
   * 生命 100 + 盔甲 200 = 总有效血量 300。
   *
   * 盔甲先扣、生命后扣，所以「盔甲还在」是一个明确的安全信号，
   * 盔甲破了就是「下一轮交火可能会死」的警告 —— 比一条 300 点的长血条
   * 提供的信息多得多。敌人 HP 仍是 60，「先看见先开枪」的高致死感不变。
   */
  hpMax: 100,
  armorMax: 200,
  /**
   * 盔甲吸收伤害的比例。1.0 = 盔甲在时生命完全不掉。
   *
   * 取 0.85 而不是 1.0：留 15% 渗透伤害，让玩家在盔甲还满的时候
   * 也能感觉到「被打中了」。全吸收会让前 200 点伤害毫无反馈，
   * 玩家学不会躲。
   */
  armorAbsorb: 0.85,
  /** 低于这个生命比例开始屏幕红色脉冲警告 */
  lowHpFraction: 0.35,
  width: 0.6,                   // AABB
  height: 1.8,
  crouchHeight: 1.0,
  eyeHeight: 1.62,
  // GDD 原值 2.6 是「慢到有战术感」，但实际玩起来太拖。
  // 提到 3.6 仍明显慢于慢跑，节奏还在，但移动不再让人烦躁。
  speed: 3.6,                   // 常速 vox/s
  slowSpeed: 1.6,               // Ctrl 战术慢走
  crouchSpeed: 1.5,
  // 加速度调高：22 换算成每帧 lerp 只有 0.37，起步和转向都拖泥带水。
  // 45 让方向切换几乎即时响应，同时保留一点惯性。
  accel: 45,
  airAccel: 9,
  jumpHeight: 1.1,
  stepUpMax: 0.6,               // 自动登台
  gravity: -22,
  maxFallSpeed: 34,
  terminalSafeFall: 4,          // 超过 4 vox 才开始摔伤
  fallDmgPerVox: 5,
  fallDmgCap: 15,
  crouchLerp: 10,               // 蹲伏高度过渡速率
  lean: {
    angleDeg: 22,
    offset: 0.5,                // 侧移 vox（命中盒不动）
    timeMs: 180,
  },
  noise: { normal: 4.0, slow: 1.2, crouch: 0.8 },
  spread: {
    normal: 1.0, slow: 0.8, crouch: 0.6,
    adsMul: 0.4,        // 右键瞄准：散布收到 40%，这才是开镜的机械收益
    movePenalty: 1.5,   // 全速移动中射击的散布惩罚（静止时为 1.0）
  },
  // 基础散布整体缩放。武器表里的角度偏大，实际打靶手感偏飘，
  // 统一乘 0.7 让点射更可靠，武器之间的相对差异保持不变。
  spreadScale: 0.7,
  // 玩家命中盒倍率。HP 翻倍后爆头不再一枪致死（那样太随机），
  // 但 3.0 倍让爆头依然是重伤：AR 爆头 63、DMR 爆头 195（仍是一枪）。
  // 保留了「被爆头很痛」的反馈，又不会让玩家死得莫名其妙。
  hitbox: { head: 3.0, torso: 1.0, limb: 0.7 },
};

/**
 * 手雷（GDD 08 章的投掷物槽位）。
 *
 * 开局 3 枚，不可补充 —— 稀缺才让「什么时候用」成为决策。
 * 伤害按距离线性衰减，且必须有视线：手雷不会穿墙杀人，
 * 躲到墙后就是安全的（这是玩家和敌人共享的规则）。
 */
/**
 * 敌人感知的两个数据驱动常量：噪音警戒跳级 + 武装敌人护甲。
 *
 * NOISE_SPIKE_THRESHOLD：武器 noise 值 ≥ 此阈值时，范围内 IDLE 的敌人
 * 直接跳到 ALERT（举枪），跳过慢悠悠的 INVESTIGATE 阶段。卡在 AR(35) 和
 * 霰弹(40) 之间——手枪/SMG/AR 不触发，霰弹/DMR 触发。「口径越大越可能
 * 引来 aggression spike」就是这一个数字。
 *
 * ARMOR_ABSORB：武装敌人的护甲吸收比例，与玩家侧 PLAYER.armorAbsorb
 * 同源同理（护甲先扣、生命后扣，留一点渗透伤害保证有反馈）。
 *
 * ══ 爆头规则：普通一枪，精英两枪 ══
 *
 * 普通敌人（无护甲）任意武器爆头必死 —— 这是本作的核心奖励，
 * 「先看见先开枪」的价值全靠它兑现，任何难度都不打折。
 *
 * 精英（armored）明确要两枪，而且是算出来的硬保证、不是概率：
 * ARMOR_MAX = 60 配 85% 吸收 → 护甲能挡掉约 70 点入射伤害；
 * ARMORED_HP_MULT = 3 → 困难档生命 60 变 180。
 *   DMR 爆头 195：首发护甲吃 60、渗透 135 → 剩 45 血，不死；
 *                 第二发 195 全额进生命 → 倒。恰好两枪。
 *   AR  爆头 63 ：首发只渗透 ~9，需要更多枪 —— 那是「口径不够」
 *                 的合理代价，玩家能从掉血反馈里读出来。
 * 生命同时被 D().enemyHp 缩放，所以专家档的精英更厚（70×3=210）。
 */
export const NOISE_SPIKE_THRESHOLD = 38;
export const ARMOR_ABSORB = 0.85;
export const ARMOR_MAX = 60;
export const ARMORED_HP_MULT = 3;

/**
 * ── 重甲盾兵（SHIELD，02 诊所起引入）──
 *
 * 定位：正面几乎打不穿，专门逼玩家放弃「站桩对枪」，改成绕侧或用手雷。
 *
 * 护盾只挡正面：判定子弹来向与他面朝方向的夹角，落在前方 frontArcDeg
 * 扇区内就吸收 frontAbsorb，扇区外护盾完全不生效（与普通敌人无异）。
 * 手雷不吃这条判定 —— 爆炸是全方向的，炸他脚下永远是重伤。
 *
 * 数值固定 200 HP + 200 护甲（不吃难度的敌人 HP 缩放）：普通敌人只是
 * 「这一档难度下多几枪」，盾兵必须始终是诊所里最硬、最好辨认的点。
 * 但这 200 护甲**只在正面子弹命中时**参与吸收；侧后与爆炸完全绕过，
 * 所以绕位仍是核心解法，不会退化成纯粹堆弹药。
 */
export const SHIELD_ENEMY = {
  /** 前方护盾扇区总角度（度）。150 = 面朝方向 ±75°。 */
  frontArcDeg: 150,
  /** 正面命中的吸收比例。0.94 → 只透 6%，正面打他基本是放空枪。 */
  frontAbsorb: 0.94,
  /** 固定生命：三档都是 200。 */
  hpMax: 200,
  /** 固定方向性护甲：只吃正面子弹，三档都是 200。 */
  armorMax: 200,
  /** 转向速率倍率：比普通敌人慢半拍，绕后才有意义。 */
  turnRateMul: 0.45,
  /** 移动速度倍率：几乎不动。 */
  moveSpeedMul: 0.35,
};

/**
 * ── 冲锋手（RUSHER，03 电台起引入）──
 *
 * 定位：与盾兵相反 —— 不是「肉但不动」，而是「脆但极快」。
 * 电台中庭是开阔地，冲锋手逼玩家不能一直站在原地瞄同一个方向。
 *
 * 关键：冲刺只在**确认交火之后**才开始（举枪反应延迟照常生效），
 * 所以玩家第一次看到他转向自己时仍有正常的反应窗口，
 * 不是偷袭式的瞬间贴脸。
 */
export const RUSHER_ENEMY = {
  /** 冲刺速度（vox/s）。玩家常规跑动约 4.2，这里刻意更快。 */
  chargeSpeed: 5.4,
  /** 冲到这个距离就停下开火（霰弹有效距离） */
  stopDist: 5.5,
  /** 血量倍率：比普通敌人还低，冲得快但很脆。 */
  hpMult: 0.8,
  /** 冲刺时的转向速率倍率（要能跟着玩家拐弯，但不能是制导导弹） */
  turnRateMul: 1.15,
};

export const GRENADES = {
  he: {
    id: 'he',
    label: '高爆',
    countMul: 0.5,
    throwSpeed: 13.15,
    gravity: -20,
    fuseSec: 2.0,
    radius: 19.5,
    maxDamage: 180,
    minDamage: 25,
    selfDamageMul: 0.7,
    bounce: 0.35,
    friction: 0.72,
    radiusVox: 0.14,
    noise: 26,
    flashIntensity: 2700,
    flashDistance: 66,
    flashMs: 180,
    debris: 102,
    shake: 1.0,
    color: 0x4a5a3a,
    blindSec: 0,
  },
  flash: {
    id: 'flash',
    label: '闪光',
    countMul: 2,
    throwSpeed: 13.15,
    gravity: -20,
    fuseSec: 1.0,
    radius: 14,
    maxDamage: 0,
    minDamage: 0,
    selfDamageMul: 0,
    bounce: 0.4,
    friction: 0.7,
    radiusVox: 0.14,
    noise: 22,
    flashIntensity: 4200,
    flashDistance: 28,
    flashMs: 1500,
    debris: 30,
    shake: 0.35,
    color: 0xd8dee8,
    blindSec: 3.5,
    playerFlashMs: 1200,
  },
};

/** 兼容旧测试与旧调用：默认仍是高爆参数表 */
export const GRENADE = GRENADES.he;

/** 开局手雷数量：闪光 ×2，高爆 ×0.5（至少 1） */
export function grenadeInventory(kind, baseCount) {
  const spec = GRENADES[kind] ?? GRENADES.he;
  if (spec.countMul >= 1) return Math.round(baseCount * spec.countMul);
  return Math.max(1, Math.floor(baseCount * spec.countMul));
}

/** 方块人形部件尺寸（vox），来自 GDD 02 章 */
export const RIG = {
  head:  { x: 0.5,  y: 0.5,  z: 0.5  },
  torso: { x: 0.6,  y: 0.75, z: 0.35 },
  arm:   { x: 0.2,  y: 0.6,  z: 0.2  },
  leg:   { x: 0.25, y: 0.75, z: 0.25 },
  gun:   { x: 0.15, y: 0.15, z: 0.9  },
  walkSwingMax: 0.9,            // 腿部正弦摆动最大弧度
  walkFreq: 2.1,                // 每 vox/s 的摆动频率系数
  leanPivotAtFeet: true,
};

export const INPUT = {
  forward: ['KeyW'], back: ['KeyS'], left: ['KeyA'], right: ['KeyD'],
  jump: ['Space'], crouch: ['ShiftLeft', 'ShiftRight'],
  slow: ['ControlLeft', 'ControlRight'],
  // 倾斜 Q / E（左右探头），开门 X，手电 F（保持原键位）
  leanLeft: ['KeyQ'], leanRight: ['KeyE'],
  flashlight: ['KeyF'],
  toggleView: ['KeyC'],
  grenade: ['Digit3'],
  mute: ['KeyM'],
  // N 紧挨 M：M 管全部音效，N 只切背景音乐
  music: ['KeyN'],
  // Tab 切小地图。input.js 在指针锁定时已经吞掉 Tab 的默认行为（焦点跳转），
  // 所以按它不会把焦点甩到浏览器 UI 上。
  minimap: ['Tab'],
  debug: ['Backquote'],
};
