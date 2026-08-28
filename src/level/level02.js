import { World, BLOCK } from '../voxel/world.js';
import { furnishLevel02, clearDoorways, clearSpawn } from './furniture.js';

/**
 * 关卡 02「废弃诊所」——同样 64×64 单层，平面却和 01 完全不同。
 *
 * 01 是填满的矩形平房（南庭院 → 往北推进）。
 * 02 是开口朝东的 C 形诊所：北翼候诊/诊室、西脊档案/隔离、南翼手术/停尸，
 * 庭院嵌在 C 的开口里，玩家从东侧月光接近，主入口开在西脊接待处。
 *
 * 建造规则与 01 相同（所以门、相机、视线判定可以原样复用）：
 *  · 所有墙 2 格厚，y=1..4 砌到天花板下沿
 *  · 门洞 2 格高；carveDoor 的 (x,z) 是小坐标端，门板旋向 x-1 / z-1
 *  · 单层：y=0 地板，y=5 天花板只盖建筑，庭院见天
 *
 * ── 房间平面图（内部净空）──
 *
 *           x  8········23 26····37 40··47 50··55
 *        z= 8  ┌─值班休息─┬─候诊──┬─诊A─┬─诊B─┐
 *          16  ├──────────┴───────┴─────┴─────┤   ← z=17,18
 *          19  ├─档案/接待─┐                  │
 *          24  ├──────────┤     东侧庭院      │
 *          27  ├─隔离病房─┤     （见天开口）  │
 *          33  ├──────────┤                  │
 *          36  ├─化验室───┬─手术──┬─停尸┬─值夜┤
 *          46  └──────────┴───────┴─────┴─────┘
 */

export const FLOOR_Y  = 0;
export const CEIL_Y   = 5;
export const WALL_TOP = CEIL_Y - 1;
export const WALL_THICK = 2;
export const DOOR_H = 2;

/** 东侧庭院，正对 C 形开口 */
export const SPAWN = { x: 58.5, y: 1.0, z: 26.5 };

export const DOORS = [];

const Y0 = 1;

/** 主入口：西脊接待处双开门，正对庭院出生点 */
export const MAIN_ENTRANCE = [[24, 21], [24, 22]];
/** 北后门：候诊室出到北侧外廊 */
export const BACK_ENTRANCE = [[31, 6], [32, 6]];
/** 西侧门：化验室通西外廊 */
export const SIDE_WEST = [[6, 41]];
/** 东北侧门：诊室 B 通东外廊 */
export const SIDE_EAST_N = [[56, 12]];
/** 东南侧门：值夜室通东外廊 */
export const SIDE_EAST_S = [[56, 41]];
/** 南门：手术室出到南外廊 */
export const SIDE_SOUTH = [[31, 47]];

/**
 * 建筑轴对齐包围盒（内部净空）。C 的开口（庭院）在这个盒子里面，
 * 不是实心矩形 —— 用 COURTYARD 把东侧缺口标出来。
 */
export const BUILDING = { x0: 8, z0: 8, x1: 55, z1: 46 };

/** 庭院（见天）：C 形开口 + 东侧外廊，直到世界边界 */
export const COURTYARD = { x0: 26, z0: 19, x1: 63, z1: 33 };

export const ROOMS = {
  staff:      { x0: 8,  x1: 23, z0: 8,  z1: 16 },
  waiting:    { x0: 26, x1: 37, z0: 8,  z1: 16 },
  examA:      { x0: 40, x1: 47, z0: 8,  z1: 16 },
  examB:      { x0: 50, x1: 55, z0: 8,  z1: 16 },
  records:    { x0: 8,  x1: 23, z0: 19, z1: 24 },
  isolation:  { x0: 8,  x1: 23, z0: 27, z1: 33 },
  lab:        { x0: 8,  x1: 23, z0: 36, z1: 46 },
  or:         { x0: 26, x1: 37, z0: 36, z1: 46 },
  morgue:     { x0: 40, x1: 47, z0: 36, z1: 46 },
  duty:       { x0: 50, x1: 55, z0: 36, z1: 46 },
};

// ───────────────────────────────────────────────────────────────────────────
// 建造原语（与 level01 相同，关卡文件自包含，避免互相改坏）
// ───────────────────────────────────────────────────────────────────────────

function wallRun(w, x0, z0, x1, z1, yFrom, yTo, id) {
  const dx = Math.sign(x1 - x0), dz = Math.sign(z1 - z0);
  let x = x0, z = z0;
  const steps = Math.max(Math.abs(x1 - x0), Math.abs(z1 - z0));
  for (let i = 0; i <= steps; i++) {
    for (let y = yFrom; y <= yTo; y++) w.set(x, y, z, id);
    x += dx; z += dz;
  }
}

function xWall(w, x, z0, z1, id = BLOCK.WALL_IN, thick = WALL_THICK) {
  for (let t = 0; t < thick; t++) wallRun(w, x + t, z0, x + t, z1, Y0, WALL_TOP, id);
}

function zWall(w, z, x0, x1, id = BLOCK.WALL_IN, thick = WALL_THICK) {
  for (let t = 0; t < thick; t++) wallRun(w, x0, z + t, x1, z + t, Y0, WALL_TOP, id);
}

function carveDoor(w, x, z, through, thick = WALL_THICK) {
  for (let t = 0; t < thick; t++) {
    const px = through === 'x' ? x + t : x;
    const pz = through === 'z' ? z + t : z;
    for (let y = Y0; y < Y0 + DOOR_H; y++) w.set(px, y, pz, BLOCK.AIR);
  }
  w.set(x, Y0, z, BLOCK.DOORFRAME);
  DOORS.push({ x, y: Y0, z, through, thick });
}

function inCourtyard(x, z) {
  return x >= COURTYARD.x0 && x <= COURTYARD.x1
      && z >= COURTYARD.z0 && z <= COURTYARD.z1;
}

// ───────────────────────────────────────────────────────────────────────────

export function buildLevel02() {
  const w = new World();
  DOORS.length = 0;

  // ---- 地面 ----------------------------------------------------------------
  w.fill(0, 0, 0, 63, 0, 63, BLOCK.GRASS);
  // 建筑三翼铺水泥；庭院缺口保持草地（见天有月光）
  w.fill(6, 0, 6, 57, 0, 18, BLOCK.CONCRETE);    // 北翼
  w.fill(6, 0, 19, 25, 0, 33, BLOCK.CONCRETE);   // 西脊
  w.fill(6, 0, 34, 57, 0, 48, BLOCK.CONCRETE);   // 南翼

  // ---- 庭院边界矮墙 --------------------------------------------------------
  for (let t = 0; t < 2; t++) {
    wallRun(w, 1, 1 + t, 62, 1 + t, Y0, 2, BLOCK.WALL);
    wallRun(w, 1, 62 - t, 62, 62 - t, Y0, 2, BLOCK.WALL);
    wallRun(w, 1 + t, 1, 1 + t, 62, Y0, 2, BLOCK.WALL);
    wallRun(w, 62 - t, 1, 62 - t, 62, Y0, 2, BLOCK.WALL);
  }

  // ---- 建筑外墙（2 格厚，C 形）--------------------------------------------
  const EX = BLOCK.WALL;
  zWall(w, 6, 6, 57, EX);             // 北外墙 z=6,7
  zWall(w, 47, 6, 57, EX);            // 南外墙 z=47,48
  xWall(w, 6, 6, 48, EX);             // 西外墙 x=6,7
  xWall(w, 56, 6, 18, EX);            // 北翼东外墙（到庭院北沿）
  xWall(w, 56, 34, 48, EX);           // 南翼东外墙（从庭院南沿）

  // C 形朝向庭院的内沿（仍是外墙材质：一侧见天）
  zWall(w, 17, 26, 57, EX);           // 北翼南沿 z=17,18  x=26..57
  zWall(w, 34, 26, 57, EX);           // 南翼北沿 z=34,35  x=26..57
  xWall(w, 24, 17, 35, EX);           // 西脊东沿 x=24,25  z=17..35

  // ---- 室内隔墙 ------------------------------------------------------------
  // 北翼横墙西段：值班休息 ↔ 档案（庭院北沿的西半是内墙）
  zWall(w, 17, 8, 23);
  // 西脊：档案 ↔ 隔离
  zWall(w, 25, 8, 23);
  // 西脊：隔离 ↔ 化验（南翼北沿的西半是内墙）
  zWall(w, 34, 8, 23);

  // 北翼竖墙
  xWall(w, 24, 8, 16);                // 休息 ↔ 候诊
  xWall(w, 38, 8, 16);                // 候诊 ↔ 诊 A
  xWall(w, 48, 8, 16);                // 诊 A ↔ 诊 B

  // 南翼竖墙
  xWall(w, 24, 36, 46);               // 化验 ↔ 手术
  xWall(w, 38, 36, 46);               // 手术 ↔ 停尸
  xWall(w, 48, 36, 46);               // 停尸 ↔ 值夜

  // ---- 门 ------------------------------------------------------------------
  for (const [mx, mz] of MAIN_ENTRANCE) carveDoor(w, mx, mz, 'x');
  for (const [mx, mz] of BACK_ENTRANCE) carveDoor(w, mx, mz, 'z');
  for (const [mx, mz] of SIDE_WEST)     carveDoor(w, mx, mz, 'x');
  for (const [mx, mz] of SIDE_EAST_N)   carveDoor(w, mx, mz, 'x');
  for (const [mx, mz] of SIDE_EAST_S)   carveDoor(w, mx, mz, 'x');
  for (const [mx, mz] of SIDE_SOUTH)    carveDoor(w, mx, mz, 'z');

  // 北翼各室 → 庭院（门板旋进室内）
  carveDoor(w, 31, 17, 'z');          // 候诊
  carveDoor(w, 43, 17, 'z');          // 诊 A
  carveDoor(w, 52, 17, 'z');          // 诊 B
  // 隔离 → 庭院
  carveDoor(w, 24, 30, 'x');
  // 南翼各室 → 庭院（门板旋进庭院，外门）
  carveDoor(w, 31, 34, 'z');          // 手术
  carveDoor(w, 43, 34, 'z');          // 停尸
  carveDoor(w, 52, 34, 'z');          // 值夜

  // 室内连通（每个房间至少两扇门）
  carveDoor(w, 14, 17, 'z');          // 休息 → 档案
  carveDoor(w, 24, 11, 'x');          // 休息 → 候诊
  carveDoor(w, 38, 12, 'x');          // 候诊 → 诊 A
  carveDoor(w, 48, 12, 'x');          // 诊 A → 诊 B
  carveDoor(w, 14, 25, 'z');          // 档案 → 隔离
  carveDoor(w, 14, 34, 'z');          // 隔离 → 化验
  carveDoor(w, 24, 41, 'x');          // 化验 → 手术
  carveDoor(w, 38, 41, 'x');          // 手术 → 停尸
  carveDoor(w, 48, 41, 'x');          // 停尸 → 值夜

  // C 形把主动线放到庭院，室内全靠门，不再挖无门拱口（拱口会漏光漏子弹）。

  /**
   * 错位墙垛：门全开时南翼 / 北翼 / 西脊仍不能一眼看穿。
   * 每垛封在房间中段，躲开门口 2 格清障范围。
   */
  xWall(w, 31, 13, 14);               // 候诊：切断北后门 → 庭院门
  xWall(w, 33, 40, 42);               // 手术室：切断化验 ↔ 停尸
  xWall(w, 13, 30, 31);               // 隔离：切断档案 ↔ 化验

  // ---- 天花板：只盖 C 形三翼，庭院开口见天 --------------------------------
  w.fill(6, CEIL_Y, 6, 57, CEIL_Y, 18, BLOCK.CEILING);
  w.fill(6, CEIL_Y, 19, 25, CEIL_Y, 33, BLOCK.CEILING);
  w.fill(6, CEIL_Y, 34, 57, CEIL_Y, 48, BLOCK.CEILING);

  // ---- 家具与掩体（坐标留在 furnishLevel02，统一走家具库）----------------
  furnishLevel02(w, Y0);
  clearDoorways(w, DOORS, DOOR_H);
  clearSpawn(w, SPAWN, Y0);

  return w;
}

export { inCourtyard };
