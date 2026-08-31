import { World, BLOCK } from '../voxel/world.js';
import { furnishLevel03 } from './furniture.js';

/**
 * 关卡 03「废弃电台」——64×64 单层，十字形四翼夹一个中庭。
 *
 * 01 是填满的矩形平房（南庭院 → 往北推进）。
 * 02 是开口朝东的 C（东庭院 → 绕打）。
 * 03 是十字：北/西/东/南四翼各自独立，中间的中庭是唯一的十字路口。
 * 四个凹角（西北/东北/西南/东南）见天，玩家能从外廊绕到任意一翼，
 * 没有「沿一面墙扫过去」的主动线 —— 每一翼都要单独决定「从哪个门进」。
 *
 * 建造规则与 01/02 相同：
 *  · 所有墙 2 格厚，y=1..4 砌到天花板下沿
 *  · 门洞 2 格高；carveDoor 的 (x,z) 是小坐标端，门洞沿 through 方向再空一格
 *  · 单层：y=0 地板，y=5 天花板只盖建筑，庭院与四凹角见天
 *
 * ── 房间平面图（内部净空坐标）──
 *
 *                    x  22······31 34······43
 *                 z=  8  ┌─导播──┼──演播厅──┐
 *                    16  └───────┴──────────┘
 *      x  8······19        z=17,18 北翼南沿         x  46······55
 *   z= 19 ┌─宿舍──┐  ┌──────────────────────┐  ┌─发射机房─┐
 *      24 ├───────┤  │                      │  ├──────────┤
 *      27 ├─食堂──┤  │        中庭          │  ├─器材库───┤
 *      33 └───────┘  └──────────────────────┘  └──────────┘
 *                       z=34,35 南翼北沿         x  46······55
 *                    x  22······31 34······43
 *                 z= 36  ┌─发电机─┼──主机房──┐
 *                    46  └────────┴──────────┘
 *
 * 四翼内部净空都是 10×9（北/南）或 12×15（西/东，含内部分间横墙）。
 * 中庭净空 22..43 × 19..33（22×15），四道错位墙垛切断十字向的长视线。
 */

export const FLOOR_Y  = 0;
export const CEIL_Y   = 5;
export const WALL_TOP = CEIL_Y - 1;
export const WALL_THICK = 2;
export const DOOR_H = 2;

/** 北侧庭院，正对北翼主入口 */
export const SPAWN = { x: 32.5, y: 1.0, z: 58.5 };

export const DOORS = [];

const Y0 = 1;

/** 主入口：北翼北外墙双开门，正对北侧庭院出生点 */
export const MAIN_ENTRANCE = [[31, 6], [32, 6]];
/** 南后门：主机房出到南外廊 */
export const BACK_ENTRANCE = [[38, 47]];
/** 西侧门：食堂通西外廊 */
export const SIDE_WEST = [[6, 30]];
/** 东侧门：器材库通东外廊 */
export const SIDE_EAST = [[56, 30]];

/**
 * 建筑轴对齐包围盒（十字最大外框，含四个凹角占位）。
 * 凹角本身不铺地板/不砌墙，只作为「范围参考」，真正形状由墙体决定。
 */
export const BUILDING = { x0: 8, z0: 8, x1: 55, z1: 46 };

/** 十字交叉的中庭（内部净空），用于视野/平面图等需要「这块是室内」的判断 */
export const ATRIUM = { x0: 22, z0: 19, x1: 43, z1: 33 };

export const ROOMS = {
  control:   { x0: 22, x1: 31, z0: 8,  z1: 16 },   // 导播室
  studio:    { x0: 34, x1: 43, z0: 8,  z1: 16 },   // 演播厅
  dorm:      { x0: 8,  x1: 19, z0: 19, z1: 24 },   // 宿舍
  canteen:   { x0: 8,  x1: 19, z0: 27, z1: 33 },   // 食堂
  atrium:    { x0: 22, x1: 43, z0: 19, z1: 33 },   // 中庭
  txroom:    { x0: 46, x1: 55, z0: 19, z1: 24 },   // 发射机房
  storeroom: { x0: 46, x1: 55, z0: 27, z1: 33 },   // 器材库
  generator: { x0: 22, x1: 31, z0: 36, z1: 46 },   // 发电机房
  mainframe: { x0: 34, x1: 43, z0: 36, z1: 46 },   // 主机房
};

// ───────────────────────────────────────────────────────────────────────────
// 建造原语（与 01/02 相同，关卡文件自包含，避免互相改坏）
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

/**
 * 在厚墙上开门洞并登记一扇门。(x,z) 是门洞贯穿方向上的小坐标端。
 * 与 01/02 完全一致：调用方必须保证 (x-1,z) 或 (x,z-1) 是通行侧的净空。
 */
function carveDoor(w, x, z, through, thick = WALL_THICK) {
  for (let t = 0; t < thick; t++) {
    const px = through === 'x' ? x + t : x;
    const pz = through === 'z' ? z + t : z;
    for (let y = Y0; y < Y0 + DOOR_H; y++) w.set(px, y, pz, BLOCK.AIR);
  }
  w.set(x, Y0, z, BLOCK.DOORFRAME);
  DOORS.push({ x, y: Y0, z, through, thick });
}

// ───────────────────────────────────────────────────────────────────────────

export function buildLevel03() {
  const w = new World();
  DOORS.length = 0;

  // ---- 地面：整幅先铺草（含四凹角与外圈），四翼 + 中庭再盖水泥 -----------
  w.fill(0, 0, 0, 63, 0, 63, BLOCK.GRASS);
  w.fill(20, 0, 6, 45, 0, 18, BLOCK.CONCRETE);   // 北翼（不含西北/东北凹角）
  w.fill(6, 0, 17, 21, 0, 35, BLOCK.CONCRETE);   // 西脊
  w.fill(44, 0, 17, 57, 0, 35, BLOCK.CONCRETE);  // 东脊
  w.fill(20, 0, 34, 45, 0, 48, BLOCK.CONCRETE);  // 南翼（不含西南/东南凹角）
  w.fill(22, 0, 19, 43, 0, 33, BLOCK.CONCRETE);  // 中庭

  // ---- 庭院边界矮墙（挡玩家跑出世界，但不挡月光）-------------------------
  for (let t = 0; t < 2; t++) {
    wallRun(w, 1, 1 + t, 62, 1 + t, Y0, 2, BLOCK.WALL);
    wallRun(w, 1, 62 - t, 62, 62 - t, Y0, 2, BLOCK.WALL);
    wallRun(w, 1 + t, 1, 1 + t, 62, Y0, 2, BLOCK.WALL);
    wallRun(w, 62 - t, 1, 62 - t, 62, Y0, 2, BLOCK.WALL);
  }

  // ---- 建筑外墙（2 格厚，只沿十字外轮廓）---------------------------------
  const EX = BLOCK.WALL;
  zWall(w, 6,  20, 45, EX);   // 北翼北外墙 z=6,7   x=20..45
  zWall(w, 47, 20, 45, EX);   // 南翼南外墙 z=47,48 x=20..45
  xWall(w, 6,  17, 35, EX);   // 西脊西外墙 x=6,7   z=17..35
  xWall(w, 56, 17, 35, EX);   // 东脊东外墙 x=56,57 z=17..35

  // 北翼西/东外墙（凹角内沿竖墙）x=20,21 / 44,45  z=6..18
  xWall(w, 20, 6, 18, EX);
  xWall(w, 44, 6, 18, EX);
  // 西脊/东脊朝向北凹的南沿（见天）z=17,18  x=6..21 / 44..57
  zWall(w, 17, 6, 21, EX);
  zWall(w, 17, 44, 57, EX);

  // 南翼西/东外墙（凹角内沿竖墙）x=20,21 / 44,45  z=34..48
  xWall(w, 20, 34, 48, EX);
  xWall(w, 44, 34, 48, EX);
  // 西脊/东脊朝向南凹的北沿（见天）z=34,35  x=6..21 / 44..57
  zWall(w, 34, 6, 21, EX);
  zWall(w, 34, 44, 57, EX);

  // ---- 室内隔墙（全部 2 格厚）---------------------------------------------
  zWall(w, 17, 22, 43);   // 北翼南沿（室内段）：导播/演播厅 ↔ 中庭
  zWall(w, 34, 22, 43);   // 南翼北沿（室内段）：发电机/主机房 ↔ 中庭
  xWall(w, 20, 19, 33);   // 西脊东沿：宿舍/食堂 ↔ 中庭
  xWall(w, 44, 19, 33);   // 东脊西沿：发射机房/器材库 ↔ 中庭

  xWall(w, 32, 8,  16);   // 北翼竖墙：导播 ↔ 演播厅
  zWall(w, 25, 8,  19);   // 西脊横墙：宿舍 ↔ 食堂
  zWall(w, 25, 46, 55);   // 东脊横墙：发射机房 ↔ 器材库
  xWall(w, 32, 36, 46);   // 南翼竖墙：发电机 ↔ 主机房

  /**
   * 中庭错位墙垛：切断十字向的长视线（北↔南、西↔东都不能一眼看穿）。
   * 中庭净空 x=22..43 z=19..33。每垛封 3 格只留 1 格通道，两组留的
   * 是不同的那 1 格 —— 与 01 走廊的错位墙垛同一套手法。
   */
  xWall(w, 30, 19, 21, BLOCK.WALL_IN);   // 竖墙垛（南北向），留 z=22..24
  xWall(w, 36, 22, 24, BLOCK.WALL_IN);   // 竖墙垛，留 z=19..21（与上面错开）
  zWall(w, 24, 26, 28, BLOCK.WALL_IN);   // 横墙垛（东西向），留 x=29..31
  zWall(w, 29, 32, 34, BLOCK.WALL_IN);   // 横墙垛，留 x=26..28（与上面错开）

  // ---- 门与通道口 ----------------------------------------------------------
  // 主入口：北翼北墙双开，正对北侧庭院出生点
  for (const [mx, mz] of MAIN_ENTRANCE) carveDoor(w, mx, mz, 'z');
  // 南后门：主机房出到南外廊
  for (const [mx, mz] of BACK_ENTRANCE) carveDoor(w, mx, mz, 'z');
  // 东西侧门：庭院绕侧翼进食堂 / 器材库
  for (const [mx, mz] of SIDE_WEST) carveDoor(w, mx, mz, 'x');
  for (const [mx, mz] of SIDE_EAST) carveDoor(w, mx, mz, 'x');

  // 北翼内部：导播 ↔ 演播厅
  carveDoor(w, 32, 11, 'x');
  // 导播 → 中庭；演播厅 → 中庭（各自独立开门，不用绕室内竖墙）
  carveDoor(w, 26, 17, 'z');   // 导播南墙
  carveDoor(w, 38, 17, 'z');   // 演播厅南墙
  // 导播 / 演播厅各自的第二入口，直通西北 / 东北凹角外廊（绕打路线）
  carveDoor(w, 20, 11, 'x');   // 导播开向西北凹角
  carveDoor(w, 44, 11, 'x');   // 演播厅开向东北凹角

  // 西脊：宿舍 ↔ 食堂
  carveDoor(w, 14, 25, 'z');
  // 宿舍 → 中庭；食堂 → 中庭
  carveDoor(w, 20, 21, 'x');
  carveDoor(w, 20, 30, 'x');

  // 东脊：发射机房 ↔ 器材库
  carveDoor(w, 50, 25, 'z');
  // 发射机房 → 中庭；器材库 → 中庭
  carveDoor(w, 44, 21, 'x');
  carveDoor(w, 44, 30, 'x');

  // 南翼内部：发电机 ↔ 主机房
  carveDoor(w, 32, 41, 'x');
  // 发电机 → 中庭；主机房 → 中庭
  carveDoor(w, 26, 34, 'z');
  carveDoor(w, 38, 34, 'z');
  // 发电机 / 主机房各自的第二入口，直通西南 / 东南凹角外廊
  carveDoor(w, 20, 41, 'x');   // 发电机开向西南凹角
  carveDoor(w, 44, 41, 'x');   // 主机房开向东南凹角

  // ---- 天花板（只盖十字五块，四凹角与庭院见天）----------------------------
  w.fill(20, CEIL_Y, 6,  45, CEIL_Y, 18, BLOCK.CEILING);   // 北翼
  w.fill(6,  CEIL_Y, 17, 21, CEIL_Y, 35, BLOCK.CEILING);   // 西脊
  w.fill(44, CEIL_Y, 17, 57, CEIL_Y, 35, BLOCK.CEILING);   // 东脊
  w.fill(20, CEIL_Y, 34, 45, CEIL_Y, 48, BLOCK.CEILING);   // 南翼
  w.fill(22, CEIL_Y, 19, 43, CEIL_Y, 33, BLOCK.CEILING);   // 中庭

  // ---- 家具与掩体（坐标留在 furnishLevel03，统一走家具库）----------------
  const furniture = furnishLevel03(w, Y0, DOORS, SPAWN);
  w.furniture = furniture;

  return w;
}
