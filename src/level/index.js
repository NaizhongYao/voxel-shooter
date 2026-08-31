import {
  buildLevel01, SPAWN, DOORS, MAIN_ENTRANCE, ROOMS, BUILDING, LOOT_CONTAINERS,
} from './level01.js';
import {
  buildLevel02, SPAWN as SPAWN02, DOORS as DOORS02, MAIN_ENTRANCE as MAIN_ENTRANCE02,
  ROOMS as ROOMS02, BUILDING as BUILDING02,
} from './level02.js';
import { ENEMY_SPAWNS, MEDKIT_SPAWNS, WEAPON_SPAWNS } from './spawns.js';
import { ENEMY_SPAWNS02, MEDKIT_SPAWNS02, WEAPON_SPAWNS02 } from './spawns02.js';
import {
  buildLevel03, SPAWN as SPAWN03, DOORS as DOORS03, MAIN_ENTRANCE as MAIN_ENTRANCE03,
  ROOMS as ROOMS03, BUILDING as BUILDING03,
} from './level03.js';
import { ENEMY_SPAWNS03, MEDKIT_SPAWNS03, WEAPON_SPAWNS03 } from './spawns03.js';

/**
 * 稳定的室内房间图边。门边保留门洞坐标，拱门边用 opening 描述永久开口。
 * 外部庭院门不登记到普通 Wander 图；未来若需要可单独增加 outside link。
 */
const ROOM_LINKS01 = [
  { id: 'bh-bedroom-north-hall', from: 'bedroom', to: 'northHall', door: { x: 20, y: 1, z: 11, through: 'x', thick: 2 } },
  { id: 'bh-north-hall-study', from: 'northHall', to: 'study', door: { x: 44, y: 1, z: 11, through: 'x', thick: 2 } },
  { id: 'bh-west-store-warehouse', from: 'westStore', to: 'warehouse', door: { x: 20, y: 1, z: 21, through: 'x', thick: 2 } },
  { id: 'bh-warehouse-east-store', from: 'warehouse', to: 'eastStore', door: { x: 44, y: 1, z: 21, through: 'x', thick: 2 } },
  { id: 'bh-living-foyer', from: 'living', to: 'foyer', door: { x: 23, y: 1, z: 42, through: 'x', thick: 2 } },
  { id: 'bh-foyer-kitchen', from: 'foyer', to: 'kitchen', door: { x: 40, y: 1, z: 42, through: 'x', thick: 2 } },
  { id: 'bh-bedroom-west-store', from: 'bedroom', to: 'westStore', door: { x: 14, y: 1, z: 15, through: 'z', thick: 2 } },
  { id: 'bh-study-east-store', from: 'study', to: 'eastStore', door: { x: 50, y: 1, z: 15, through: 'z', thick: 2 } },
  { id: 'bh-west-store-corridor', from: 'westStore', to: 'corridor', door: { x: 12, y: 1, z: 25, through: 'z', thick: 2 } },
  { id: 'bh-east-store-corridor', from: 'eastStore', to: 'corridor', door: { x: 50, y: 1, z: 25, through: 'z', thick: 2 } },
  { id: 'bh-corridor-south-hall-west', from: 'corridor', to: 'southHall', door: { x: 12, y: 1, z: 31, through: 'z', thick: 2 } },
  { id: 'bh-corridor-south-hall-east', from: 'corridor', to: 'southHall', door: { x: 50, y: 1, z: 31, through: 'z', thick: 2 } },
  { id: 'bh-south-hall-living', from: 'southHall', to: 'living', door: { x: 14, y: 1, z: 36, through: 'z', thick: 2 } },
  { id: 'bh-south-hall-kitchen', from: 'southHall', to: 'kitchen', door: { x: 48, y: 1, z: 36, through: 'z', thick: 2 } },
  { id: 'bh-north-hall-warehouse-opening', from: 'northHall', to: 'warehouse', door: null, opening: { x: 31, y: 1, z: 15, through: 'z', thick: 2, span: 3 }, openConnection: true },
  { id: 'bh-warehouse-corridor-opening', from: 'warehouse', to: 'corridor', door: null, opening: { x: 30, y: 1, z: 25, through: 'z', thick: 2, span: 4 }, openConnection: true },
  { id: 'bh-corridor-south-hall-opening', from: 'corridor', to: 'southHall', door: null, opening: { x: 30, y: 1, z: 31, through: 'z', thick: 2, span: 3 }, openConnection: true },
  { id: 'bh-south-hall-foyer-opening', from: 'southHall', to: 'foyer', door: null, opening: { x: 30, y: 1, z: 36, through: 'z', thick: 2, span: 4 }, openConnection: true },
];

const ROOM_LINKS02 = [
  { id: 'cl-staff-waiting', from: 'staff', to: 'waiting', door: { x: 24, y: 1, z: 11, through: 'x', thick: 2 } },
  { id: 'cl-waiting-exam-a', from: 'waiting', to: 'examA', door: { x: 38, y: 1, z: 12, through: 'x', thick: 2 } },
  { id: 'cl-exam-a-exam-b', from: 'examA', to: 'examB', door: { x: 48, y: 1, z: 12, through: 'x', thick: 2 } },
  { id: 'cl-lab-or', from: 'lab', to: 'or', door: { x: 24, y: 1, z: 41, through: 'x', thick: 2 } },
  { id: 'cl-or-morgue', from: 'or', to: 'morgue', door: { x: 38, y: 1, z: 41, through: 'x', thick: 2 } },
  { id: 'cl-morgue-duty', from: 'morgue', to: 'duty', door: { x: 48, y: 1, z: 41, through: 'x', thick: 2 } },
  { id: 'cl-staff-records', from: 'staff', to: 'records', door: { x: 14, y: 1, z: 17, through: 'z', thick: 2 } },
  { id: 'cl-records-isolation', from: 'records', to: 'isolation', door: { x: 14, y: 1, z: 25, through: 'z', thick: 2 } },
  { id: 'cl-isolation-lab', from: 'isolation', to: 'lab', door: { x: 14, y: 1, z: 34, through: 'z', thick: 2 } },
];

const ROOM_LINKS03 = [
  { id: 'rd-control-studio', from: 'control', to: 'studio', door: { x: 32, y: 1, z: 11, through: 'x', thick: 2 } },
  { id: 'rd-dorm-atrium', from: 'dorm', to: 'atrium', door: { x: 20, y: 1, z: 21, through: 'x', thick: 2 } },
  { id: 'rd-canteen-atrium', from: 'canteen', to: 'atrium', door: { x: 20, y: 1, z: 30, through: 'x', thick: 2 } },
  { id: 'rd-atrium-txroom', from: 'atrium', to: 'txroom', door: { x: 44, y: 1, z: 21, through: 'x', thick: 2 } },
  { id: 'rd-atrium-storeroom', from: 'atrium', to: 'storeroom', door: { x: 44, y: 1, z: 30, through: 'x', thick: 2 } },
  { id: 'rd-generator-mainframe', from: 'generator', to: 'mainframe', door: { x: 32, y: 1, z: 41, through: 'x', thick: 2 } },
  { id: 'rd-control-atrium', from: 'control', to: 'atrium', door: { x: 26, y: 1, z: 17, through: 'z', thick: 2 } },
  { id: 'rd-studio-atrium', from: 'studio', to: 'atrium', door: { x: 38, y: 1, z: 17, through: 'z', thick: 2 } },
  { id: 'rd-dorm-canteen', from: 'dorm', to: 'canteen', door: { x: 14, y: 1, z: 25, through: 'z', thick: 2 } },
  { id: 'rd-txroom-storeroom', from: 'txroom', to: 'storeroom', door: { x: 50, y: 1, z: 25, through: 'z', thick: 2 } },
  { id: 'rd-atrium-generator', from: 'atrium', to: 'generator', door: { x: 26, y: 1, z: 34, through: 'z', thick: 2 } },
  { id: 'rd-atrium-mainframe', from: 'atrium', to: 'mainframe', door: { x: 38, y: 1, z: 34, through: 'z', thick: 2 } },
];

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
    roomLinks: ROOM_LINKS01,
    /**
     * 掠夺容器：只有 01 黑楼有（本切片范围）。其他关卡不登记该字段，
     * 主循环对 undefined 做 `?? []`，后补时只需在对应关卡文件摆坐标。
     */
    lootContainers: LOOT_CONTAINERS,
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
    roomLinks: ROOM_LINKS02,
    roomLabels: {
      staff: '值班休息', waiting: '候诊', examA: '诊室A', examB: '诊室B',
      records: '档案接待', isolation: '隔离病房', lab: '化验室',
      or: '手术室', morgue: '停尸房', duty: '值夜',
    },
  },
  {
    id: 'radio',
    code: '03',
    name: '废弃电台',
    en: 'PROTOCOL 03 · RADIO STATION',
    subtitle: '十字四翼 · 北庭院进入',
    blurb: '四翼夹一个中庭，四角见天。正门在北，也可以从凹角绕进任意一翼。',
    locked: false,
    build: buildLevel03,
    spawns: ENEMY_SPAWNS03,
    medkits: MEDKIT_SPAWNS03,
    weapons: WEAPON_SPAWNS03,
    spawn: SPAWN03,
    doors: DOORS03,
    mainEntrance: MAIN_ENTRANCE03,
    rooms: ROOMS03,
    building: BUILDING03,
    roomLinks: ROOM_LINKS03,
    roomLabels: {
      control: '导播', studio: '演播厅', dorm: '宿舍', canteen: '食堂',
      atrium: '中庭', txroom: '发射机房', storeroom: '器材库',
      generator: '发电机', mainframe: '主机房',
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
