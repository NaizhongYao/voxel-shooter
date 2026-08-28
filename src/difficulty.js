/**
 * 难度设定。
 *
 * ══ 设计原则：难度不是简单地改血量 ══
 *
 * 只调血量的难度是最偷懒的做法 —— 玩家的操作方式完全不变，只是每场
 * 交火多按几下扳机。这里三个难度改的是**信息与反应时间**：
 *
 *   简单：给玩家更多情报（状态指示器常亮）、更长的反应窗口、更宽容的容错
 *   困难：情报只在敌人真的注意到你时才给，反应窗口接近真实
 *   专家：几乎没有情报，敌人反应快、瞄得准、会互相呼叫
 *
 * 这样三个难度玩起来是三种节奏：简单可以正面推进，专家必须关灯潜行。
 * 血量差异只是让这个节奏差异有生存空间，不是难度本身。
 *
 * 所有系统都从这里读参数（通过 DIFF.current），不要在别处硬编码难度分支。
 */

/** 每个难度的完整参数表 */
export const DIFFICULTIES = {
  easy: {
    id: 'easy',
    name: '简单',
    subtitle: 'RECRUIT',
    desc: '适合熟悉操作。敌人反应慢、视野短，状态指示器常亮。',
    color: 0x3fb96f,

    // ── 玩家 ──
    hpMax: 120,
    armorMax: 240,
    grenades: 4,
    /** 玩家受到的伤害倍率 */
    incomingDamageMul: 0.65,
    medkitHeal: 60,

    // ── 敌人感知 ──
    enemyHp: 50,
    visionRangeMul: 0.75,        // 视野更短
    reactionMul: 1.8,            // 举枪窗口更长（玩家有时间反应）
    aimErrorMul: 1.6,            // 打得更偏
    rofMul: 0.7,                 // 射速更慢
    callRadiusMul: 0.6,          // 呼叫同伴范围小
    investigateTimeMul: 0.7,     // 更快放弃搜索
    loseTargetMul: 0.6,          // 更快脱战

    /**
     * ── 侵略性（aggression）──
     *
     * hearRangeMul   听觉半径倍率。枪声/爆炸的传播距离 ×这个值，
     *                决定「多远之外的人会过来查房」。
     * suppressChance 看不见玩家时朝最后已知位置盲射的概率（每次射击机会）。
     *                盲射是压制，不是作弊：弹道有很大的散布，打中是运气，
     *                但它逼玩家不敢一直待在同一个掩体后面。
     * suppressSpread 盲射的额外散布（vox）。越大越像「泼子弹」而不是点杀。
     * pushChance     战斗中主动向玩家推进（而不是站桩对射）的概率。
     * searchRooms    调查时是否推进到房间深处搜索（而不是走到噪音点就停）。
     */
    hearRangeMul: 0.7,
    suppressChance: 0.0,         // 简单档不盲射 —— 新手需要安全的掩体
    suppressSpread: 2.0,
    pushChance: 0.15,
    searchRooms: false,

    // ── 情报（HUD）──
    /** 状态指示器可见距离（vox）。简单难度几乎全图可见。 */
    indicatorRange: 60,
    /** 是否在 IDLE 状态也显示指示器（让玩家先看到敌人在哪） */
    showIdleIndicator: true,
    /** 是否显示敌人朝向的视野提示 */
    showFacingHint: true,

    /**
     * 敌人数量层级：ENEMY_SPAWNS 里 tier <= enemyTier 的敌人才会生成。
     * 简单 10 / 困难 13 / 专家 15 —— 数量本身也是难度的一部分，而不只是
     * 血量/反应时间。人少的关卡才配得上「适合熟悉操作」。
     */
    enemyTier: 1,
  },

  hard: {
    id: 'hard',
    name: '困难',
    subtitle: 'OPERATOR',
    desc: '标准体验。敌人会呼叫同伴，只在注意到你时才有状态提示。',
    color: 0xf5a623,

    hpMax: 100,
    armorMax: 200,
    grenades: 3,
    incomingDamageMul: 1.0,
    medkitHeal: 50,

    enemyHp: 60,
    visionRangeMul: 1.0,
    reactionMul: 1.0,
    aimErrorMul: 1.0,
    rofMul: 1.0,
    callRadiusMul: 1.0,
    investigateTimeMul: 1.0,
    loseTargetMul: 1.0,

    // ── 侵略性（见 easy 档的字段说明）──
    hearRangeMul: 1.0,
    suppressChance: 0.35,        // 三次射击机会里约一次盲射压制
    suppressSpread: 1.5,
    pushChance: 0.45,
    searchRooms: true,           // 会真的走进房间搜人

    indicatorRange: 28,
    showIdleIndicator: false,    // 只有被注意到才显示
    showFacingHint: false,

    enemyTier: 2,
  },

  expert: {
    id: 'expert',
    name: '专家',
    subtitle: 'GHOST',
    desc: '几乎没有情报。敌人听得远、疯狂压制、会推进搜房。必须关灯潜行。',
    color: 0xe5484d,

    hpMax: 80,
    armorMax: 120,
    grenades: 2,
    incomingDamageMul: 1.35,
    medkitHeal: 40,

    enemyHp: 70,
    visionRangeMul: 1.25,
    reactionMul: 0.55,           // 举枪窗口只有 0.17–0.28 秒
    aimErrorMul: 0.6,            // 打得准
    rofMul: 1.15,
    callRadiusMul: 1.4,          // 一个发现你，半栋楼都知道
    investigateTimeMul: 1.5,     // 搜得更久
    loseTargetMul: 1.6,          // 更难脱战

    /**
     * ── 侵略性：GHOST 档是最凶的（见 easy 档的字段说明）──
     *
     * 听觉 1.8 倍 + 75% 盲射概率 + 主动推进，效果是「开一枪，半栋楼的人
     * 朝这边压过来，还没看见你就已经在往你的掩体泼子弹」。
     * 这一档不允许站桩对枪 —— 必须关灯、换位、逐个吃掉。
     */
    hearRangeMul: 1.8,
    suppressChance: 0.75,
    suppressSpread: 1.1,         // 压制得更密，散布反而更小
    pushChance: 0.8,
    searchRooms: true,

    indicatorRange: 14,          // 只有很近才看得到状态
    showIdleIndicator: false,
    showFacingHint: false,

    enemyTier: 3,
  },
};

export const DIFFICULTY_ORDER = ['easy', 'hard', 'expert'];

/**
 * 当前难度。模块级单例 —— 关卡与所有系统在初始化时读它。
 *
 * 为什么用可变单例而不是到处传参：难度参数被 8 个模块读取，
 * 挨个传会把签名污染得没法看，而难度在一局游戏里是不变的，
 * 单例的风险很低。切换难度靠重载页面（?diff=expert），
 * 所以不存在「运行中途改了但某些系统没跟上」的问题。
 */
export const DIFF = { current: DIFFICULTIES.hard };

/** 从 URL 参数或存档读取难度，默认困难 */
export function resolveDifficulty(search = '') {
  const q = new URLSearchParams(search).get('diff');
  if (q && DIFFICULTIES[q]) return DIFFICULTIES[q];
  return DIFFICULTIES.hard;
}

export function setDifficulty(id) {
  if (DIFFICULTIES[id]) DIFF.current = DIFFICULTIES[id];
  return DIFF.current;
}

/** 便捷读取：D().hpMax 之类 */
export const D = () => DIFF.current;
