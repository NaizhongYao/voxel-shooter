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

    // ── 情报（HUD）──
    /** 状态指示器可见距离（vox）。简单难度几乎全图可见。 */
    indicatorRange: 60,
    /** 是否在 IDLE 状态也显示指示器（让玩家先看到敌人在哪） */
    showIdleIndicator: true,
    /** 是否显示敌人朝向的视野提示 */
    showFacingHint: true,
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

    indicatorRange: 28,
    showIdleIndicator: false,    // 只有被注意到才显示
    showFacingHint: false,
  },

  expert: {
    id: 'expert',
    name: '专家',
    subtitle: 'GHOST',
    desc: '几乎没有情报。敌人视野远、反应快、瞄得准。必须关灯潜行。',
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

    indicatorRange: 14,          // 只有很近才看得到状态
    showIdleIndicator: false,
    showFacingHint: false,
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
