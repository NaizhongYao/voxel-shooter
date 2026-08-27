import { World, BLOCK } from '../voxel/world.js';

/**
 * 关卡 01「黑楼」——64×64、两层、外接庭院。
 * 层高 4 vox：一层地板 y=0，净空 y=1..3，二层楼板 y=4，净空 y=5..7，屋顶 y=8。
 *
 * 关卡几何遵循 GDD 10 章的六条硬规则：门口留白 2 格、掩体错位、
 * 每房间至少两个入口、走廊不超过 20 vox。
 */

export const FLOOR1_Y = 0;   // 一层地板顶面 = y1
export const FLOOR2_Y = 4;   // 二层楼板顶面 = y5
export const ROOF_Y   = 8;

export const SPAWN = { x: 32.5, y: 1.0, z: 58.5 };   // 庭院

/** 门位置清单，交给门系统实例化（这里只留 DOORFRAME 标记与空气缺口） */
export const DOORS = [];

function wallRun(w, x0, z0, x1, z1, yFrom, yTo, id = BLOCK.WALL) {
  const dx = Math.sign(x1 - x0), dz = Math.sign(z1 - z0);
  let x = x0, z = z0;
  const steps = Math.max(Math.abs(x1 - x0), Math.abs(z1 - z0));
  for (let i = 0; i <= steps; i++) {
    for (let y = yFrom; y <= yTo; y++) w.set(x, y, z, id);
    x += dx; z += dz;
  }
}

/** 在墙上开门洞：清空 1 格宽 2 格高，底部标记 DOORFRAME */
function carveDoor(w, x, z, y0, facing) {
  for (let y = y0; y < y0 + 3; y++) w.set(x, y, z, BLOCK.AIR);
  w.set(x, y0, z, BLOCK.DOORFRAME);
  DOORS.push({ x, y: y0, z, facing });
}

/** 开一个无门的通道口（宽 wSpan 格） */
function carveOpening(w, x, z, y0, along, span) {
  for (let i = 0; i < span; i++) {
    const px = along === 'x' ? x + i : x;
    const pz = along === 'z' ? z + i : z;
    for (let y = y0; y < y0 + 3; y++) w.set(px, y, pz, BLOCK.AIR);
  }
}

/**
 * 半格阶梯楼梯：沿 axis 方向每格抬高 0.5 vox。
 *
 * 每级台阶的顶面高度 = yBase + (i+1)*0.5，用 STAIR_LO(0.5) / STAIR_HI(1.0)
 * 交替表达格内的半格与满格，配合玩家 stepUp(0.6) 走上去平滑无卡顿。
 * 台阶正上方强制清空 3 格净空，避免被后铺的楼板封住。
 *
 * @returns {{topY:number, endAxis:number}} 楼梯顶面高度与终点格坐标
 */
function buildStairs(w, x, z, yBase, len, axis, width = 2) {
  let topY = yBase;
  for (let i = 0; i < len; i++) {
    const surface = yBase + (i + 1) * 0.5;   // 这一级的顶面绝对高度
    const gy = Math.ceil(surface) - 1;       // 顶面所在格
    const id = (surface - gy) <= 0.5 + 1e-6 ? BLOCK.STAIR_LO : BLOCK.STAIR_HI;
    topY = surface;

    for (let k = 0; k < width; k++) {
      const px = axis === 'z' ? x + k : x + i;
      const pz = axis === 'z' ? z + i : z + k;
      // 台阶下方填实
      for (let fy = yBase; fy < gy; fy++) w.set(px, fy, pz, BLOCK.FLOOR);
      w.set(px, gy, pz, id);
      // 台阶上方净空 3 格（含头顶余量）
      for (let cy = gy + 1; cy <= gy + 3 && cy < w.sy; cy++) w.set(px, cy, pz, BLOCK.AIR);
    }
  }
  const endAxis = (axis === 'z' ? z : x) + len - 1;
  return { topY, endAxis };
}

/** 在楼板上开一个楼梯井口，并保证上层净空 */
function carveStairwell(w, x0, z0, x1, z1, slabY, clearance = 3) {
  for (let y = slabY; y <= slabY + clearance && y < w.sy; y++) {
    w.fill(x0, y, z0, x1, y, z1, BLOCK.AIR);
  }
}

export function buildLevel01() {
  const w = new World();
  DOORS.length = 0;

  // ---- 地面 ----------------------------------------------------------------
  // 庭院草地（有天空 → 月光），建筑内部混凝土地板
  w.fill(0, 0, 0, 63, 0, 63, BLOCK.GRASS);

  const B = { x0: 6, z0: 6, x1: 57, z1: 48 };   // 建筑外墙范围
  w.fill(B.x0, 0, B.z0, B.x1, 0, B.z1, BLOCK.FLOOR);

  // 庭院边界矮墙（挡住玩家跑出世界，同时不挡月光）
  wallRun(w, 1, 1, 62, 1, 1, 2);
  wallRun(w, 1, 62, 62, 62, 1, 2);
  wallRun(w, 1, 1, 1, 62, 1, 2);
  wallRun(w, 62, 1, 62, 62, 1, 2);

  // ---- 一层外墙 ------------------------------------------------------------
  const y1 = 1, y1Top = 3;
  wallRun(w, B.x0, B.z0, B.x1, B.z0, y1, y1Top);
  wallRun(w, B.x0, B.z1, B.x1, B.z1, y1, y1Top);
  wallRun(w, B.x0, B.z0, B.x0, B.z1, y1, y1Top);
  wallRun(w, B.x1, B.z0, B.x1, B.z1, y1, y1Top);

  // 主入口（南墙，正对庭院出生点）+ 侧门（东墙）
  carveDoor(w, 31, B.z1, y1, 'south');
  carveDoor(w, 32, B.z1, y1, 'south');
  carveDoor(w, B.x1, 20, y1, 'east');

  // ---- 一层内部分区 --------------------------------------------------------
  // 中央走廊（东西向，z=26..28），长度 <20 vox 的分段由横墙切断
  const corrZ0 = 26, corrZ1 = 28;
  wallRun(w, B.x0 + 1, corrZ0 - 1, B.x1 - 1, corrZ0 - 1, y1, y1Top);
  wallRun(w, B.x0 + 1, corrZ1 + 1, B.x1 - 1, corrZ1 + 1, y1, y1Top);

  // 门厅（南侧，正对主入口）
  wallRun(w, 24, 36, 40, 36, y1, y1Top);
  wallRun(w, 24, 36, 24, B.z1 - 1, y1, y1Top);
  wallRun(w, 40, 36, 40, B.z1 - 1, y1, y1Top);
  carveOpening(w, 30, 36, y1, 'x', 4);            // 门厅 → 走廊南侧
  carveDoor(w, 24, 42, y1, 'west');               // 门厅 → 西翼
  carveDoor(w, 40, 42, y1, 'east');               // 门厅 → 东翼

  // 走廊南侧连通段
  wallRun(w, 30, 29, 30, 35, y1, y1Top);
  wallRun(w, 33, 29, 33, 35, y1, y1Top);
  carveOpening(w, 31, 29, y1, 'x', 2);

  // 西翼房间 A（办公室）
  wallRun(w, 16, 36, 23, 36, y1, y1Top);
  wallRun(w, 16, 36, 16, B.z1 - 1, y1, y1Top);
  carveDoor(w, 20, 36, y1, 'north');              // 第二入口（GDD 规则 3）

  // 东翼房间 B（储藏）
  wallRun(w, 41, 36, 50, 36, y1, y1Top);
  wallRun(w, 50, 36, 50, B.z1 - 1, y1, y1Top);
  carveDoor(w, 46, 36, y1, 'north');

  // 北侧仓库（大空间，长视线 + 掩体接近）
  wallRun(w, 20, 16, 20, corrZ0 - 2, y1, y1Top);
  wallRun(w, 44, 16, 44, corrZ0 - 2, y1, y1Top);
  wallRun(w, 20, 16, 44, 16, y1, y1Top);
  carveOpening(w, 30, corrZ0 - 2, y1, 'x', 4);
  carveDoor(w, 20, 22, y1, 'west');
  carveDoor(w, 44, 22, y1, 'east');

  // 西北小房间 C
  wallRun(w, B.x0 + 1, 18, 19, 18, y1, y1Top);
  carveDoor(w, 12, 18, y1, 'south');
  carveDoor(w, 19, 12, y1, 'east');

  // 东北小房间 D
  wallRun(w, 45, 18, B.x1 - 1, 18, y1, y1Top);
  carveDoor(w, 52, 18, y1, 'south');

  // ---- 二层楼板 ------------------------------------------------------------
  // 不铺满：留出中庭天井（仓库上方开放），形成垂直视线与「上下层」盲区
  w.fill(B.x0, FLOOR2_Y, B.z0, B.x1, FLOOR2_Y, B.z1, BLOCK.FLOOR);
  // 挖出中庭天井（仓库上方 22..42 × 18..26）
  w.fill(22, FLOOR2_Y, 18, 42, FLOOR2_Y, 26, BLOCK.AIR);
  // 天井四周栏杆
  for (let x = 21; x <= 43; x++) {
    w.set(x, FLOOR2_Y + 1, 17, BLOCK.RAILING);
    w.set(x, FLOOR2_Y + 1, 27, BLOCK.RAILING);
  }
  for (let z = 17; z <= 27; z++) {
    w.set(21, FLOOR2_Y + 1, z, BLOCK.RAILING);
    w.set(43, FLOOR2_Y + 1, z, BLOCK.RAILING);
  }
  w.fill(22, FLOOR2_Y + 1, 18, 42, FLOOR2_Y + 1, 26, BLOCK.AIR);

  // ---- 二层墙体 ------------------------------------------------------------
  const y2 = FLOOR2_Y + 1, y2Top = FLOOR2_Y + 3;
  wallRun(w, B.x0, B.z0, B.x1, B.z0, y2, y2Top);
  wallRun(w, B.x0, B.z1, B.x1, B.z1, y2, y2Top);
  wallRun(w, B.x0, B.z0, B.x0, B.z1, y2, y2Top);
  wallRun(w, B.x1, B.z0, B.x1, B.z1, y2, y2Top);

  // 二层环形走道 + 两个房间
  wallRun(w, 14, 34, 49, 34, y2, y2Top);
  carveDoor(w, 24, 34, y2, 'north');
  carveDoor(w, 40, 34, y2, 'north');
  wallRun(w, 30, 35, 30, B.z1 - 1, y2, y2Top);
  carveOpening(w, 30, 40, y2, 'z', 2);

  // 二层西房间（狙击位，可俯视天井）
  wallRun(w, 14, 20, 14, 33, y2, y2Top);
  carveDoor(w, 14, 30, y2, 'east');

  // 二层东房间
  wallRun(w, 49, 20, 49, 33, y2, y2Top);
  carveDoor(w, 49, 30, y2, 'west');

  // ---- 屋顶 ----------------------------------------------------------------
  w.fill(B.x0, ROOF_Y, B.z0, B.x1, ROOF_Y, B.z1, BLOCK.FLOOR);

  // ---- 楼梯（半格阶梯，从门厅东侧上二层）--------------------------------
  // 抬升 4 vox 需要 8 级半格台阶：z=38..45，顶面正好等于二层楼板 y=5 的地面
  // 先开井口（含顶部平台），再铺台阶，顺序反了会把最高几级削掉
  carveStairwell(w, 42, 38, 43, 47, FLOOR2_Y);
  const s1 = buildStairs(w, 42, 38, 1, 8, 'z', 2);
  // 楼梯顶端落脚平台，接上二层地面
  w.fill(42, FLOOR2_Y, 46, 43, FLOOR2_Y, 47, BLOCK.FLOOR);

  // 第二座楼梯（西北，跨层巡逻用）
  carveStairwell(w, 10, 22, 11, 31, FLOOR2_Y);
  const s2 = buildStairs(w, 10, 22, 1, 8, 'z', 2);
  w.fill(10, FLOOR2_Y, 30, 11, FLOOR2_Y, 31, BLOCK.FLOOR);

  // ---- 掩体布置（错位摆放，门口留白 2 格）------------------------------
  const crates = [
    // 仓库：错位货架，形成可接近的长视线
    [26, 20], [27, 20], [26, 21],
    [36, 22], [37, 22],
    [30, 24], [31, 24],
    [24, 25], [40, 19],
    // 门厅
    [27, 40], [36, 41],
    // 房间 A / B
    [19, 43], [21, 45], [44, 43], [47, 45],
  ];
  for (const [cx, cz] of crates) {
    w.set(cx, 1, cz, BLOCK.CRATE);
  }

  // 2 格高货架（齐胸掩体，透光形成条纹阴影）
  const shelves = [
    [29, 18], [29, 19], [33, 18], [33, 19],
    [38, 24], [38, 25], [23, 22], [23, 23],
  ];
  for (const [sx, sz] of shelves) {
    w.set(sx, 1, sz, BLOCK.SHELF);
    w.set(sx, 2, sz, BLOCK.SHELF);
  }

  // 二层掩体
  for (const [cx, cz] of [[18, 30], [19, 24], [45, 30], [46, 24], [26, 40], [36, 42]]) {
    w.set(cx, FLOOR2_Y + 1, cz, BLOCK.CRATE);
  }

  // 庭院掩体（教学区：一个高处蹲守位的视觉线索）
  for (const [cx, cz] of [[28, 54], [29, 54], [36, 56], [24, 58]]) {
    w.set(cx, 1, cz, BLOCK.CRATE);
  }

  return w;
}
