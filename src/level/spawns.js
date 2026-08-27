import { ARCHETYPE } from '../systems/enemy.js';
import { FLOOR2_Y } from './level01.js';

/**
 * 12 个敌人的布置（GDD 12 章 + 10 章关卡规则）。
 *
 * 规则 4：约一半敌人初始朝向背对最近的门，奖励从正确方向进入的玩家。
 * 规则 6：垂直威胁（二层 / 货架顶）必须在下方有可见线索。
 *
 * 分布：伏地者 4（黑暗转角）· 蹲守者 5（封锁门口/走廊，含 2 个高处）· 巡逻者 3（含跨层）
 */

const Y1 = 1;
const Y2 = FLOOR2_Y + 1;

export const ENEMY_SPAWNS = [
  // 庭院刻意留空：出生点附近不放任何敌人。
  // 原来这里有一个蹲守者，玩家一进游戏就会被秒杀 —— 那不是紧张，只是挫败。
  // 「仰头检查」的教学改在建筑内部第一个大空间完成（见下方仓库的高处威胁）。

  // ── 一层门厅 / 西翼 ──
  { x: 27.5, y: Y1, z: 41.5, yaw: Math.PI,     archetype: ARCHETYPE.PRONE,   weapon: 'shotgun' },
  { x: 20.5, y: Y1, z: 44.5, yaw: 0,           archetype: ARCHETYPE.SENTRY,  weapon: 'smg' },

  // ── 一层东翼 ──
  { x: 46.5, y: Y1, z: 44.5, yaw: 0,           archetype: ARCHETYPE.PRONE,   weapon: 'shotgun' },

  // ── 一层中央走廊（巡逻，跨东西）──
  {
    x: 24.5, y: Y1, z: 27.5, yaw: -Math.PI / 2,
    archetype: ARCHETYPE.PATROLLER, weapon: 'smg',
    patrol: [[24.5, 27.5], [50.5, 27.5], [24.5, 27.5]],
  },

  // ── 北侧仓库（大空间，含掩体）──
  { x: 31.5, y: Y1, z: 21.5, yaw: 0,           archetype: ARCHETYPE.SENTRY,  weapon: 'ar' },
  { x: 39.5, y: Y1, z: 19.5, yaw: Math.PI / 2, archetype: ARCHETYPE.PRONE,   weapon: 'shotgun' },
  {
    x: 25.5, y: Y1, z: 20.5, yaw: 0,
    archetype: ARCHETYPE.PATROLLER, weapon: 'pistol',
    patrol: [[25.5, 20.5], [41.5, 24.5], [30.5, 19.5]],
  },

  // ── 西北 / 东北小房间 ──
  { x: 12.5, y: Y1, z: 12.5, yaw: Math.PI,     archetype: ARCHETYPE.PRONE,   weapon: 'shotgun' },
  { x: 52.5, y: Y1, z: 12.5, yaw: Math.PI,     archetype: ARCHETYPE.SENTRY,  weapon: 'smg' },

  // ── 二层：狙击位（俯视天井，是 DMR 的主要威胁）──
  { x: 17.5, y: Y2, z: 26.5, yaw: -Math.PI / 2, archetype: ARCHETYPE.SENTRY, weapon: 'dmr' },
  { x: 46.5, y: Y2, z: 26.5, yaw: Math.PI / 2,  archetype: ARCHETYPE.SENTRY, weapon: 'ar' },

  // ── 二层巡逻者（跨层，会呼叫同伴）──
  {
    x: 30.5, y: Y2, z: 40.5, yaw: 0,
    archetype: ARCHETYPE.PATROLLER, weapon: 'smg',
    patrol: [[30.5, 40.5], [45.5, 40.5], [30.5, 30.5]],
  },
];

/** 医疗包：全关仅 3 个，固定位置，敌人不掉落 */
export const MEDKIT_SPAWNS = [
  { x: 18.5, y: Y1 + 0.4, z: 46.5 },
  { x: 42.5, y: Y1 + 0.4, z: 20.5 },
  { x: 33.5, y: Y2 + 0.4, z: 38.5 },
];

/** 初始武器拾取：让玩家早期就能升级掉手枪 */
export const WEAPON_SPAWNS = [
  { x: 31.5, y: Y1 + 0.4, z: 43.5, weapon: 'smg' },
  { x: 26.5, y: Y1 + 0.4, z: 24.5, weapon: 'ar' },
];
