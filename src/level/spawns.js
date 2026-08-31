import { ARCHETYPE } from '../systems/enemy.js';
import { itemAt } from './furniture.js';

/**
 * 20 个敌人的出生点池（全难度 +30% 后的完整 tier 3 池）。
 *
 * 规则 4：约一半敌人初始朝向背对最近的门，奖励从正确方向进入的玩家。
 *
 * 单层布局下没有「垂直威胁」，取而代之的是「长视线威胁」：
 * 走廊两端的 DMR / AR 蹲守者可以隔着 40 vox 对射，玩家必须用掩体推进。
 *
 * 每个坐标都落在房间净空的中心（.5 偏移），且离墙至少 1.5 vox ——
 * 敌人绝不会在出生瞬间就卡在墙里。Enemy 构造函数还会做一次脱困兜底。
 *
 * ══ 数量按难度分层（tier），不是简单地改血量 ══
 *
 * 敌人数量本身也是难度的一部分：找遍全楼却只找到几个人，跟找到十几个
 * 完全是两种紧张感。每个敌人标一个 tier（1/2/3），main.js 按
 * `D().enemyTier` 过滤出当前难度要生成的子集：
 *
 *   tier 1（简单 13 人）：核心布置 + 3 个伏击者补点，保证「找得到、打得过」。
 *   tier 2（困难 17 人）：追加 4 人，补上主走廊与仓库的纵深火力。
 *   tier 3（专家 20 人）：追加 3 人，全楼铺满，含庭院教学区的巡逻者。
 *
 * 三档相对原 10/13/15 全部 +30%。分层是手工挑选、不是随机抽取 ——
 * 随机会导致同一难度下每局房间覆盖度不一样（可能全挤在一个区域），
 * 无法保证空间分布，也没法写死测试断言。tier 越高只是「追加」，
 * 不移除 tier 1 的任何一个，所以专家难度下永远是完整的 20 人池子。
 *
 * ══ 武装敌人（armored）══
 *
 * 挑了 3 个持 AR/DMR 的巡逻者标记 `armored: true`：护甲吸收大部分伤害
 * （见 config.ARMOR_ABSORB / ARMOR_MAX），视觉上在方块躯干外挂一层
 * 深灰护甲壳（见 player/rig.js BlockyRig 的 armored 选项）。他们全部
 * 是 tier 1 就存在的敌人，所以任何难度下武装敌人的数量单调递增：
 * 简单 1 个 · 困难 2 个 · 专家 3 个。
 */

const Y1 = 1;

/**
 * ── 为什么大部分敌人都有 patrol ──
 *
 * 原来一半是纯蹲守者（原地不动，只在 homeYaw 附近小幅摆动）。问题有两个：
 * 布置时给的朝向如果正好对着墙，那个敌人整局都在瞪墙；而且不动的敌人
 * 让整栋楼像个静态靶场，没有「这里有人在活动」的感觉。
 *
 * 现在只保留 4 个伏击者是真的不动（那是他们的战术：蹲在暗处等），
 * 其余 8 个全部沿路线走。
 *
 * ══ 路径点必须是「实测通畅」的，不能靠肉眼估 ══
 *
 * Enemy.moveToward 只做「撞墙则沿另一轴滑行」，没有任何寻路。
 * 如果某一段路线被掩体或墙垛挡住，敌人会朝那个点原地推墙，永远到不了、
 * 也永远不会切到下一个点 —— 表现就是「巡逻者根本不巡逻」。
 *
 * 上一版就踩了这个坑：8 条路线里有 4 条穿过掩体或墙垛，实测 120 秒里
 * 有 96–115 秒是完全静止的。肉眼看坐标表看不出来，因为掩体是后铺的。
 *
 * 现在这些环路是穷举房间内所有轴对齐矩形、逐段做碰撞采样之后挑出来的
 * 「面积最大且四条边全通」的解，由 test/spawns.test.mjs 持续守着。
 * 改动任何一个坐标都要重跑那个测试。
 *
 * 另外 Enemy.walkPatrol 里还有一层兜底：连续 2.5 秒没有实质位移就
 * 跳过当前点。数据和代码两边都防，因为这个失败模式的表现
 * （敌人完全静止）和「设计成蹲守」很难区分，容易长期没人发现。
 */
export const ENEMY_SPAWNS = [
  // 庭院刻意留空：出生点附近不放任何敌人。
  // 玩家一进游戏就被秒杀不是紧张，只是挫败。

  // ── 门厅（进门第一个房间：一个伏击者教玩家「先看角落」）── tier 1
  { x: 28.5, y: Y1, z: 41.5, yaw: Math.PI, archetype: ARCHETYPE.AMBUSHER, weapon: 'shotgun', tier: 1 },

  // ── 客厅（西南）：绕房间一圈的巡逻者 + 一个伏击者 ──
  // 巡逻者 tier 2（困难/专家追加），伏击者 tier 1（三档都会遇到）。
  {
    x: 12.5, y: Y1, z: 38.5, yaw: 0,
    archetype: ARCHETYPE.PATROLLER, weapon: 'smg', tier: 1,
    // 修正：原路线西南角 (11.5,45.5) 卡在一个木箱里（家具比路线晚铺，
    // 没人重跑过求解器），由 tools/check-level01-spawns.mjs 抓出来。
    patrol: [[12.5, 38.5], [22.5, 38.5], [22.5, 45.5], [12.5, 45.5]],
  },
  { x: 20.5, y: Y1, z: 40.5, yaw: Math.PI / 2, archetype: ARCHETYPE.AMBUSHER, weapon: 'shotgun', tier: 1, wander: true, canCrossRooms: true,
    wanderRooms: ['living', 'southHall', 'foyer', 'kitchen', 'corridor'] },

  // ── 厨房（东南）── tier 3：专家难度才追加的第二个伏击者，
  // 与下方的武装巡逻者形成南翼的双重威胁。
  { x: 46.5, y: Y1, z: 45.5, yaw: 0, archetype: ARCHETYPE.AMBUSHER, weapon: 'shotgun', tier: 3 },
  {
    x: 43.5, y: Y1, z: 38.5, yaw: Math.PI,
    // 武装巡逻者：AR + 护甲。tier 1 就存在——三个难度都会遇到的
    // 「武装敌人数量随难度递增」里最先出现的那一个（简单档唯一的武装敌人）。
    archetype: ARCHETYPE.PATROLLER, weapon: 'ar', tier: 1, armored: true,
    patrol: [[43.5, 38.5], [53.5, 38.5], [53.5, 45.5], [43.5, 45.5]],
  },

  // ── 主走廊（净空 z=27..30，被墙垛切成三段）── tier 1
  // 两个巡逻者分守东西两段，路线不跨越墙垛
  {
    x: 10.5, y: Y1, z: 27.5, yaw: -Math.PI / 2,
    archetype: ARCHETYPE.PATROLLER, weapon: 'smg', tier: 1,
    patrol: [[10.5, 27.5], [20.5, 27.5], [20.5, 30.5], [10.5, 30.5]],
  },
  {
    x: 43.5, y: Y1, z: 27.5, yaw: Math.PI / 2,
    // 武装巡逻者：DMR + 护甲。tier 3——只有专家难度才会在走廊东段
    // 遇到这个隔着长视线点杀的护甲敌人，是三个武装敌人里最危险的一个，
    // 留给最高难度。
    archetype: ARCHETYPE.PATROLLER, weapon: 'dmr', tier: 3, armored: true,
    patrol: [[43.5, 27.5], [53.5, 27.5], [53.5, 30.5], [43.5, 30.5]],
  },

  // ── 南侧过道（z=33..35）：横穿半栋楼的长巡逻，最容易撞见玩家 ── tier 1
  {
    x: 10.5, y: Y1, z: 33.5, yaw: -Math.PI / 2,
    archetype: ARCHETYPE.PATROLLER, weapon: 'ar', tier: 1,
    patrol: [[10.5, 33.5], [26.5, 33.5], [26.5, 35.5], [10.5, 35.5]],
  },

  // ── 北侧仓库（大空间 + 掩体）──
  // 武装巡逻者 tier 2（困难/专家追加：仓库是最大房间，武装敌人在这里
  // 有更多掩体可以周旋，符合仓库「高潮区域」的定位）；
  // 伏击者 tier 1（简单难度就要教玩家「仓库黑暗角落也要照」）。
  {
    x: 29.5, y: Y1, z: 19.5, yaw: 0,
    archetype: ARCHETYPE.PATROLLER, weapon: 'ar', tier: 1, armored: true,
    // 修正：原路线东端 (42.5, 22.5 附近) 被货架挡住，同上一并修。
    patrol: [[29.5, 19.5], [36.5, 19.5], [36.5, 24.5], [29.5, 24.5]],
  },
  { x: 40.5, y: Y1, z: 17.5, yaw: Math.PI / 2, archetype: ARCHETYPE.AMBUSHER, weapon: 'shotgun', tier: 1 },

  // ── 卧室（西北）── tier 1：简单难度也要覆盖到北翼
  {
    x: 12.5, y: Y1, z: 8.5, yaw: Math.PI,
    archetype: ARCHETYPE.PATROLLER, weapon: 'smg', tier: 1,
    patrol: [[12.5, 8.5], [18.5, 8.5], [18.5, 14.5], [12.5, 14.5]],
  },
  // ── 书房（东北）── tier 2：困难/专家才追加，作为北翼的纵深补充
  {
    x: 46.5, y: Y1, z: 8.5, yaw: Math.PI,
    archetype: ARCHETYPE.PATROLLER, weapon: 'pistol', tier: 2,
    patrol: [[46.5, 8.5], [52.5, 8.5], [52.5, 14.5], [46.5, 14.5]],
  },

  // ── 困难/专家追加：东储、西储、南过道东段，避免「扫完南翼就找不到人」──
  {
    x: 46.5, y: Y1, z: 18.5, yaw: Math.PI,
    archetype: ARCHETYPE.PATROLLER, weapon: 'smg', tier: 1,
    // 修正：原路线东南角撞墙，由求解器重新算过。
    patrol: [[46.5, 18.5], [55.5, 18.5], [55.5, 23.5], [46.5, 23.5]],
  },
  {
    x: 10.5, y: Y1, z: 18.5, yaw: 0,
    archetype: ARCHETYPE.PATROLLER, weapon: 'ar', tier: 2,
    // 修正：原路线东南角撞墙，同上一并修。
    patrol: [[10.5, 18.5], [18.5, 18.5], [18.5, 23.5], [10.5, 23.5]],
  },
  {
    x: 47.5, y: Y1, z: 33.5, yaw: Math.PI / 2,
    archetype: ARCHETYPE.PATROLLER, weapon: 'smg', tier: 2,
    // 修正：原路线西端撞墙垛，环路收窄到墙垛以东的净空段。
    patrol: [[47.5, 33.5], [53.5, 33.5], [53.5, 35.5], [47.5, 35.5]],
  },

  /**
   * ── 人数 +30%（全难度）：13 / 17 / 20 ──
   *
   * 全部用伏击者（AMBUSHER），不加新的巡逻路线，也不用蹲守者（SENTRY）——
   * 本关早先就把纯蹲守者移除了：原地不动的敌人如果朝向对着墙，会整局
   * 都在瞪墙，而且不动的敌人让整栋楼像静态靶场（见 test/combat.test.mjs
   * 「没有原地不动的纯蹲守者」）。伏击者不需要 patrol 数组，出生点本身
   * 就是「实测通畅」的开放格（已用 find-patrol-loops.mjs 逐格验证过），
   * 复杂度不会因为加人而上升。
   */
  // tier 1 追加：书房伏击者、门厅第二伏击者、南过道东段伏击者
  { x: 49.5, y: Y1, z: 11.5, yaw: Math.PI, archetype: ARCHETYPE.AMBUSHER, weapon: 'pistol', tier: 1 },
  { x: 32.5, y: Y1, z: 43.5, yaw: 0, archetype: ARCHETYPE.AMBUSHER, weapon: 'shotgun', tier: 1 },
  { x: 46.5, y: Y1, z: 30.5, yaw: -Math.PI / 2, archetype: ARCHETYPE.AMBUSHER, weapon: 'smg', tier: 1 },

  // tier 2 追加：仓库伏击者
  { x: 32.5, y: Y1, z: 21.5, yaw: Math.PI / 2, archetype: ARCHETYPE.AMBUSHER, weapon: 'ar', tier: 2 },

  // tier 3 追加：客厅伏击者，专家档最后一重威胁
  { x: 13.5, y: Y1, z: 42.5, yaw: 0, archetype: ARCHETYPE.AMBUSHER, weapon: 'shotgun', tier: 3 },
];

/**
 * 敌人数量随难度：简单/困难/专家分别应该看到多少个。
 *
 * ══ 唯一来源：这里不再写死数字，直接从 ENEMY_SPAWNS 的 tier 过滤推导。
 * 否则「简报显示的敌人数量」和「游戏实际生成的敌人数量」是两份数据，
 * 加一个巡逻兵或调一次 tier 就会前后对不上 —— 这正是任务简报报错数的根因。
 * 要改人数就去改 ENEMY_SPAWNS 的 tier 分配，数字自动跟上。
 */
function countTier(maxTier) {
  return ENEMY_SPAWNS.filter((s) => s.tier <= maxTier).length;
}
export const ENEMY_COUNT_BY_TIER = { 1: countTier(1), 2: countTier(2), 3: countTier(3) };

/**
 * 拾取物清单：全部从共享目录 itemAt() 生成（src/level/furniture.js 的 ITEMS）。
 * 以后新增物品只要往 ITEMS 里加名字，这里按名字点即可。
 */
export const MEDKIT_SPAWNS = [
  itemAt('medkit', 16.5, 34.5),   // 南侧过道西段
  itemAt('medkit', 41.5, 19.5),   // 仓库东侧
  itemAt('medkit', 30.5, 28.5),   // 主走廊中段
];

/** 初始武器拾取：让玩家早期就能升级掉手枪 */
export const WEAPON_SPAWNS = [
  itemAt('smg', 32.5, 44.5),      // 门厅（进门就能捡）
  itemAt('ar', 30.5, 22.5),       // 仓库
];
