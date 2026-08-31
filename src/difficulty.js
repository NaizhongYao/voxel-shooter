/**
 * 难度设定（单一难度）。
 *
 * ══ 背景：三档难度已合并 ══
 *
 * 原「简单 / 困难 / 专家」三档已合并为单一「标准」难度
 * （2026-08-29 司令官裁决，见 BLUEPRINT-SYSTEM-FINAL-DECISION.md §7.5）：
 *
 *   · 战斗参数（视野/反应/瞄准/呼叫/压制等）= 原困难档数值，
 *     不采用专家档的疯狂压制；
 *   · 敌人数量 = 原专家档池（enemyTier: 3，三关 20/17/17 人）；
 *   · 蓝图/材料升档概率固定 0.15（loot-tables.js 的 DIFF_UPGRADE_CHANCE）。
 *
 * 为什么删掉玩家可选难度：局外成长（蓝图解锁装备）和局内难度选择是
 * 同一个杠杆的两份 —— 玩家若随时能「选简单」，装备成长带来的挑战
 * 就被绕过了。提取玩法的风险应该由固定的敌人配置 + 玩家的装备与
 * 技巧来对抗，不再由难度开关兜底。
 *
 * 所有系统都从这里读参数（通过 D()），不要在别处硬编码难度分支。
 */

/**
 * 唯一难度的完整参数表。字段结构与原三档完全同构，
 * 取值 = 原 hard 档全部字段 ∪ { enemyTier: 3 }（原 expert 档）。
 */
export const DIFFICULTY = {
  id: 'standard',
  name: '标准',
  subtitle: 'OPERATOR',
  desc: '标准体验。敌人会呼叫同伴，只在注意到你时才有状态提示。',
  color: 0xf5a623,

  // ── 玩家 ──
  hpMax: 100,
  armorMax: 200,
  grenades: 3,
  /** 玩家受到的伤害倍率 */
  incomingDamageMul: 1.0,
  medkitHeal: 50,

  // ── 敌人感知 ──
  enemyHp: 60,
  visionRangeMul: 1.0,
  reactionMul: 1.0,            // 举枪窗口基准（不拉到专家档）
  aimErrorMul: 1.0,
  rofMul: 1.0,
  callRadiusMul: 1.0,
  investigateTimeMul: 1.0,
  loseTargetMul: 1.0,

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
  hearRangeMul: 1.0,
  suppressChance: 0.35,        // 三次射击机会里约一次盲射压制
  suppressSpread: 1.5,
  pushChance: 0.45,
  searchRooms: true,           // 会真的走进房间搜人

  // ── 情报（HUD）──
  /** 状态指示器可见距离（vox）。 */
  indicatorRange: 28,
  /** 是否在 IDLE 状态也显示指示器（让玩家先看到敌人在哪） */
  showIdleIndicator: false,    // 只有被注意到才显示
  /** 是否显示敌人朝向的视野提示 */
  showFacingHint: false,

  /**
   * 敌人数量层级：ENEMY_SPAWNS 里 tier <= enemyTier 的敌人才会生成。
   * 单一难度固定为原专家档的 tier 3 —— 三关完整的 20/17/17 敌人池。
   */
  enemyTier: 3,
};

/**
 * 当前难度。模块级单例 —— 关卡与所有系统在初始化时读它。
 *
 * 为什么用单例而不是到处传参：难度参数被 6 个模块读取，
 * 挨个传会把签名污染得没法看。单一难度下它永远是 DIFFICULTY，
 * 保留 DIFF.current 的结构是为了不破坏既有读取接口（D()）。
 */
export const DIFF = { current: DIFFICULTY };

/** 便捷读取：D().hpMax 之类 */
export const D = () => DIFF.current;
