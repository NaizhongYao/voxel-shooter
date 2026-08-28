import { ARCHETYPE } from '../systems/enemy.js';
import { itemAt } from './furniture.js';

/**
 * 关卡 03「废弃电台」的敌人出生点池（15 人，tier 分层与 01/02 同构）。
 *
 * 十字形四翼夹一个中庭：没有单一主动线，玩家从北侧庭院进正门，
 * 但四个凹角都能绕进侧翼，所以「先打哪一翼」完全是玩家的选择——
 * 伏击者优先蹲在两个方向都可能被撞见的门内侧，巡逻者覆盖每间有
 * 净空环路的房间，中庭本身留给武装巡逻者当纵深火力点。
 *
 * ══ 数量与 tier 结构与 01/02 完全一致 ══
 *   tier 1（简单 10 人）：九间房 + 中庭都有人，保证「找得到、打得过」。
 *   tier 2（困难 13 人）：中庭追加武装巡逻、发射机房与主机房补人。
 *   tier 3（专家 15 人）：宿舍出现 DMR 武装巡逻（隔中庭长视线），
 *                        演播厅追加第二个伏击者。
 *
 * ══ 巡逻路线全部由求解器算出，不是手写 ══
 *
 * 家具是后铺的，肉眼看坐标表根本看不出哪条边被挡住 —— 第一版手算的
 * 9 条路线里有 7 条卡墙。现在每条环路都来自
 * `node tools/find-patrol-loops.mjs 03`（穷举房间内轴对齐矩形 +
 * 用真实 ENTITY_RADIUS 逐段采样，挑面积最大且四边全通的解），
 * 再由 `node tools/check-level03-spawns.mjs` 持续守着。
 * 改动任何一个坐标都要重跑这两个脚本。
 */

const Y1 = 1;

export const ENEMY_SPAWNS03 = [
  // ── 导播室（北翼西，进正门先看到的一间）── tier 1
  // 伏击者蹲在控制台后方：玩家推门进来先看到电视方向，看不到控制台侧。
  { x: 29.5, y: Y1, z: 12.5, yaw: -Math.PI / 2, archetype: ARCHETYPE.AMBUSHER, weapon: 'shotgun', tier: 1 },

  // ── 演播厅（北翼东）── tier 1
  // 绕沙发与电视柜的房间大环，手枪巡逻（演播厅不该有重火力）。
  {
    x: 37.5, y: Y1, z: 9.5, yaw: Math.PI,
    archetype: ARCHETYPE.PATROLLER, weapon: 'pistol', tier: 1,
    patrol: [[34.5, 8.5], [43.5, 8.5], [43.5, 16.5], [34.5, 16.5]],
  },

  // ── 宿舍（西脊北）── tier 1
  // 环路在床东侧的净空（床占 x=9..11，求解器自动避开了）。
  {
    x: 13.5, y: Y1, z: 21.5, yaw: Math.PI / 2,
    archetype: ARCHETYPE.PATROLLER, weapon: 'smg', tier: 1,
    patrol: [[12.5, 19.5], [19.5, 19.5], [19.5, 24.5], [12.5, 24.5]],
  },

  // ── 食堂（西脊南）── tier 1
  // 两张餐桌之间的伏击位，蹲在门内侧看不到的桌背。
  { x: 15.5, y: Y1, z: 29.5, yaw: 0, archetype: ARCHETYPE.AMBUSHER, weapon: 'shotgun', tier: 1 },

  // ── 中庭（十字交叉，最容易撞见玩家的区域）── tier 1
  // 大环走中庭西半，避开四道错位墙垛。
  {
    x: 26.5, y: Y1, z: 26.5, yaw: 0,
    archetype: ARCHETYPE.PATROLLER, weapon: 'ar', tier: 1,
    patrol: [[22.5, 22.5], [35.5, 22.5], [35.5, 33.5], [22.5, 33.5]],
  },

  // ── 发射机房（东脊北）── tier 1
  // 武装巡逻者：AR + 护甲。tier 1 就存在——三档都会遇到的武装敌人之一。
  {
    x: 50.5, y: Y1, z: 21.5, yaw: Math.PI,
    archetype: ARCHETYPE.PATROLLER, weapon: 'ar', tier: 1, armored: true,
    patrol: [[46.5, 19.5], [55.5, 19.5], [55.5, 24.5], [46.5, 24.5]],
  },

  // ── 器材库（东脊南）── tier 1
  // 货架列之间的伏击位。
  { x: 51.5, y: Y1, z: 31.5, yaw: Math.PI, archetype: ARCHETYPE.AMBUSHER, weapon: 'shotgun', tier: 1 },

  // ── 发电机房（南翼西）── tier 1
  // 绕木箱堆的房间大环，手枪巡逻。
  {
    x: 27.5, y: Y1, z: 41.5, yaw: Math.PI / 2,
    archetype: ARCHETYPE.PATROLLER, weapon: 'pistol', tier: 1,
    patrol: [[22.5, 36.5], [31.5, 36.5], [31.5, 46.5], [22.5, 46.5]],
  },

  // ── 主机房（南翼东，南后门就在这一间）── tier 1
  // 服务器台面后的伏击位，玩家从南后门或中庭两个方向都可能先撞见他。
  { x: 39.5, y: Y1, z: 39.5, yaw: -Math.PI / 2, archetype: ARCHETYPE.AMBUSHER, weapon: 'shotgun', tier: 1 },

  // ── 器材库巡逻者，与伏击者一静一动 ── tier 1
  {
    x: 49.5, y: Y1, z: 29.5, yaw: -Math.PI / 2,
    archetype: ARCHETYPE.PATROLLER, weapon: 'smg', tier: 1,
    patrol: [[46.5, 27.5], [55.5, 27.5], [55.5, 33.5], [46.5, 33.5]],
  },

  // ── 困难/专家追加：食堂武装巡逻，西脊纵深火力 ── tier 2
  {
    x: 12.5, y: Y1, z: 30.5, yaw: Math.PI / 2,
    archetype: ARCHETYPE.PATROLLER, weapon: 'ar', tier: 2, armored: true,
    patrol: [[10.5, 27.5], [19.5, 27.5], [19.5, 33.5], [10.5, 33.5]],
  },

  // ── 发射机房追加：伏击者，补上东北凹角绕打路线的第二重威胁 ── tier 2
  { x: 47.5, y: Y1, z: 22.5, yaw: 0, archetype: ARCHETYPE.AMBUSHER, weapon: 'shotgun', tier: 2 },

  // ── 主机房追加：SMG 巡逻，补上南后门 → 中庭这条推进线 ── tier 2
  {
    x: 41.5, y: Y1, z: 43.5, yaw: Math.PI,
    archetype: ARCHETYPE.PATROLLER, weapon: 'smg', tier: 2,
    patrol: [[34.5, 36.5], [43.5, 36.5], [43.5, 46.5], [34.5, 46.5]],
  },

  // ── 专家档追加：导播室 DMR 武装巡逻，隔中庭长视线点杀 ── tier 3
  // 与 01 走廊尽头 / 02 庭院对射的定位一致：三个武装敌人里最危险的一个。
  {
    x: 25.5, y: Y1, z: 10.5, yaw: 0,
    archetype: ARCHETYPE.PATROLLER, weapon: 'dmr', tier: 3, armored: true,
    patrol: [[22.5, 8.5], [31.5, 8.5], [31.5, 16.5], [22.5, 16.5]],
  },

  // ── 专家档追加：演播厅第二伏击者 ── tier 3
  { x: 40.5, y: Y1, z: 13.5, yaw: Math.PI, archetype: ARCHETYPE.AMBUSHER, weapon: 'shotgun', tier: 3 },
];

/**
 * 医疗包：全关 3 个，固定位置。
 * 导播室（进门顺路）、中庭（十字路口中点）、主机房（南后门补给）。
 */
export const MEDKIT_SPAWNS03 = [
  itemAt('medkit', 26.5, 10.5),   // 导播室
  itemAt('medkit', 32.5, 24.5),   // 中庭
  itemAt('medkit', 38.5, 43.5),   // 主机房
];

/** 初始武器拾取：进门就能捡 SMG，深入中庭捡 AR。 */
export const WEAPON_SPAWNS03 = [
  itemAt('smg', 27.5, 15.5),      // 导播室南门附近
  itemAt('ar', 33.5, 28.5),       // 中庭（避开错位墙垛）
];
