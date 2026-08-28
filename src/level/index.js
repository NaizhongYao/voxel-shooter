import { buildLevel01, SPAWN, DOORS, MAIN_ENTRANCE, ROOMS, BUILDING } from './level01.js';
import {
  buildLevel02, SPAWN as SPAWN02, DOORS as DOORS02, MAIN_ENTRANCE as MAIN_ENTRANCE02,
  ROOMS as ROOMS02, BUILDING as BUILDING02,
} from './level02.js';
import { ENEMY_SPAWNS, MEDKIT_SPAWNS, WEAPON_SPAWNS } from './spawns.js';
import { ENEMY_SPAWNS02, MEDKIT_SPAWNS02, WEAPON_SPAWNS02 } from './spawns02.js';

/**
 * 关卡注册表：所有地图在这里挂号。
 *
 * 任务是「简报页、任务选择屏、主循环、平面图工具」四处共享的唯一数据源：
 *  · build      —— 生成体素世界（纯数据，不依赖 three）
 *  · spawns     —— 敌人出生池（敌人数量 = spawns 按 tier 过滤后的长度，
 *                   简报里的「X 人」永远与游戏实际生成数一致）
 *  · doors / mainEntrance / spawn / rooms / building —— 主循环取件处
 *  · roomLabels —— 地图页房间名的中文显示
 *
 * 新加一张地图：写关卡文件 + 家具 → 在这里登记一条 → 选择屏 / 简报 / 主循环
 * 全部自动有。locked: true 的关卡在 UI 上显示为「情报不足 · 开发中」，
 * 但玩家能看到它的存在和缩略图——这是「还有内容」的预告，不是白屏。
 */

export const LEVELS = [
  {
    id: 'blackhouse',
    code: '01',
    name: '黑楼',
    en: 'PROTOCOL 01 · BLACKHOUSE',
    subtitle: '平房清屋 · 南庭院进入',
    blurb: '进去，清掉全部敌人，从南侧庭院出来。没有检查点。',
    locked: false,
    build: buildLevel01,
    spawns: ENEMY_SPAWNS,
    medkits: MEDKIT_SPAWNS,
    weapons: WEAPON_SPAWNS,
    spawn: SPAWN,
    doors: DOORS,
    mainEntrance: MAIN_ENTRANCE,
    rooms: ROOMS,
    building: BUILDING,
    roomLabels: {
      bedroom: '卧室', northHall: '北走道', study: '书房',
      westStore: '西储', warehouse: '仓库', eastStore: '东储',
      corridor: '走廊', southHall: '南过道', living: '客厅', foyer: '门厅', kitchen: '厨房',
    },
  },
  {
    id: 'clinic',
    code: '02',
    name: '废弃诊所',
    en: 'PROTOCOL 02 · C-CLINIC',
    subtitle: 'C 形隔离区 · 东庭院进入',
    blurb: '开口朝东。候诊、隔离、手术、停尸翼，庭院绕打。',
    locked: false,
    build: buildLevel02,
    spawns: ENEMY_SPAWNS02,
    medkits: MEDKIT_SPAWNS02,
    weapons: WEAPON_SPAWNS02,
    spawn: SPAWN02,
    doors: DOORS02,
    mainEntrance: MAIN_ENTRANCE02,
    rooms: ROOMS02,
    building: BUILDING02,
    roomLabels: {
      staff: '值班休息', waiting: '候诊', examA: '诊室A', examB: '诊室B',
      records: '档案接待', isolation: '隔离病房', lab: '化验室',
      or: '手术室', morgue: '停尸房', duty: '值夜',
    },
  },
];

/** 按 id 取关卡；未知 id 回落到第一关（默认行为不变）。 */
export function getLevel(id) {
  return LEVELS.find((l) => l.id === id) ?? LEVELS[0];
}

/**
 * 敌人数量（按难度档位过滤）。
 * 简报、难度卡、HUD、测试全都用这一个函数——数字只有一个来源。
 */
export function countEnemies(spawns, maxTier) {
  return spawns.filter((s) => s.tier <= maxTier).length;
}

/** 当前难度会实际生成的敌人数（不带参数时用调用方传入的 difficulty） */
export function enemiesFor(level, difficulty) {
  return countEnemies(level.spawns, difficulty.enemyTier);
}
