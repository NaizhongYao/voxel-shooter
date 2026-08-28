import { ARCHETYPE } from '../systems/enemy.js';

/**
 * 12 个敌人的布置（GDD 12 章 + 10 章关卡规则）。
 *
 * 规则 4：约一半敌人初始朝向背对最近的门，奖励从正确方向进入的玩家。
 *
 * 单层布局下没有「垂直威胁」，取而代之的是「长视线威胁」：
 * 走廊两端的 DMR / AR 蹲守者可以隔着 40 vox 对射，玩家必须用掩体推进。
 *
 * 每个坐标都落在房间净空的中心（.5 偏移），且离墙至少 1.5 vox ——
 * 敌人绝不会在出生瞬间就卡在墙里。Enemy 构造函数还会做一次脱困兜底。
 *
 * 分布：伏击者 4（黑暗转角）· 蹲守者 5（封锁门口/走廊）· 巡逻者 3
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

  // ── 门厅（进门第一个房间：一个伏击者教玩家「先看角落」）──
  { x: 28.5, y: Y1, z: 41.5, yaw: Math.PI, archetype: ARCHETYPE.AMBUSHER, weapon: 'shotgun' },

  // ── 客厅（西南）：绕房间一圈的巡逻者 + 一个伏击者 ──
  {
    x: 11.5, y: Y1, z: 38.5, yaw: 0,
    archetype: ARCHETYPE.PATROLLER, weapon: 'smg',
    patrol: [[11.5, 38.5], [21.5, 38.5], [21.5, 45.5], [11.5, 45.5]],
  },
  { x: 20.5, y: Y1, z: 40.5, yaw: Math.PI / 2, archetype: ARCHETYPE.AMBUSHER, weapon: 'shotgun' },

  // ── 厨房（东南）──
  { x: 46.5, y: Y1, z: 45.5, yaw: 0, archetype: ARCHETYPE.AMBUSHER, weapon: 'shotgun' },
  {
    x: 43.5, y: Y1, z: 38.5, yaw: Math.PI,
    archetype: ARCHETYPE.PATROLLER, weapon: 'ar',
    patrol: [[43.5, 38.5], [53.5, 38.5], [53.5, 45.5], [43.5, 45.5]],
  },

  // ── 主走廊（净空 z=27..30，被墙垛切成三段）──
  // 两个巡逻者分守东西两段，路线不跨越墙垛
  {
    x: 10.5, y: Y1, z: 27.5, yaw: -Math.PI / 2,
    archetype: ARCHETYPE.PATROLLER, weapon: 'smg',
    patrol: [[10.5, 27.5], [20.5, 27.5], [20.5, 30.5], [10.5, 30.5]],
  },
  {
    x: 43.5, y: Y1, z: 27.5, yaw: Math.PI / 2,
    archetype: ARCHETYPE.PATROLLER, weapon: 'dmr',
    patrol: [[43.5, 27.5], [53.5, 27.5], [53.5, 30.5], [43.5, 30.5]],
  },

  // ── 南侧过道（z=33..35）：横穿半栋楼的长巡逻，最容易撞见玩家 ──
  {
    x: 10.5, y: Y1, z: 33.5, yaw: -Math.PI / 2,
    archetype: ARCHETYPE.PATROLLER, weapon: 'ar',
    patrol: [[10.5, 33.5], [26.5, 33.5], [26.5, 35.5], [10.5, 35.5]],
  },

  // ── 北侧仓库（大空间 + 掩体）──
  {
    x: 27.5, y: Y1, z: 19.5, yaw: 0,
    archetype: ARCHETYPE.PATROLLER, weapon: 'ar',
    patrol: [[27.5, 19.5], [42.5, 19.5], [42.5, 22.5], [27.5, 22.5]],
  },
  { x: 40.5, y: Y1, z: 17.5, yaw: Math.PI / 2, archetype: ARCHETYPE.AMBUSHER, weapon: 'shotgun' },

  // ── 卧室（西北）/ 书房（东北）──
  {
    x: 12.5, y: Y1, z: 8.5, yaw: Math.PI,
    archetype: ARCHETYPE.PATROLLER, weapon: 'smg',
    patrol: [[12.5, 8.5], [18.5, 8.5], [18.5, 14.5], [12.5, 14.5]],
  },
  {
    x: 46.5, y: Y1, z: 8.5, yaw: Math.PI,
    archetype: ARCHETYPE.PATROLLER, weapon: 'pistol',
    patrol: [[46.5, 8.5], [52.5, 8.5], [52.5, 14.5], [46.5, 14.5]],
  },
];

/** 医疗包：全关仅 3 个，固定位置，敌人不掉落 */
export const MEDKIT_SPAWNS = [
  { x: 16.5, y: Y1 + 0.4, z: 34.5 },   // 南侧过道西段
  { x: 41.5, y: Y1 + 0.4, z: 19.5 },   // 仓库东侧
  { x: 30.5, y: Y1 + 0.4, z: 28.5 },   // 主走廊中段
];

/** 初始武器拾取：让玩家早期就能升级掉手枪 */
export const WEAPON_SPAWNS = [
  { x: 32.5, y: Y1 + 0.4, z: 44.5, weapon: 'smg' },   // 门厅（进门就能捡）
  { x: 30.5, y: Y1 + 0.4, z: 22.5, weapon: 'ar' },    // 仓库
];
