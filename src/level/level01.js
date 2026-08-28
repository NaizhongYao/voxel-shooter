import { World, BLOCK } from '../voxel/world.js';
import { furnishLevel01 } from './furniture.js';

/**
 * 关卡 01「黑楼」——64×64 单层平房 + 外接庭院。
 *
 * 为什么砍掉二楼：楼板与墙体的接缝永远会漏出上层视野（玩家在一层抬头
 * 就能看进二楼卧室），室内感直接崩掉。修补接缝的成本远高于收益 ——
 * 单层布局把预算全花在「厚墙 + 密闭房间 + 长视线」上，战术玩法一点没少。
 *
 * ── 高度分配（层高 5 vox）──
 *   y=0     地板
 *   y=1..4  净空（4 格；站立 1.8 有充足头顶空间）
 *   y=5     天花板（铺满整栋，室内任何位置抬头都是实心顶）
 *
 * ── 墙体规则 ──
 *  · 所有墙（含内墙）一律 2 格厚。1 格薄墙两侧只有一层面，玩家贴墙时
 *    相机近平面容易切进墙里看到背面 —— 也就是穿模。2 格厚给相机留了
 *    一整格缓冲，穿模在几何上不可能发生。
 *  · 墙从 y=1 一直砌到 y=4，与天花板严丝合缝，不留任何光缝。
 *  · 门洞只有 2 格高（y=1..2），门板同样 2 格高，正好填满门框 ——
 *    关上的门完全密封，不会从门楣缝里漏光漏视线漏子弹。
 *
 * ── 房间平面图（内部净空坐标）──
 *
 *      x  8······19 22······43 46······55
 *   z= 8  ┌─卧室──┬─北走道──┬──书房──┐
 *     14  ├───────┴─────────┴────────┤   ← z=15,16 隔墙
 *     17  ├─西储──┬──仓库───┬──东储──┤
 *     24  ├───────┴─────────┴────────┤   ← z=25,26 隔墙
 *     27  ├────────主走廊─────────────┤
 *     30  ├──────────────────────────┤   ← z=31,32 隔墙
 *     33  ├──────南侧过道─────────────┤
 *     35  ├──────────────────────────┤   ← z=36,37 隔墙
 *     38  ├─客厅──┬──门厅───┬──厨房──┤
 *     46  └───────┴─────────┴────────┘
 *              ↑ x=20,21   ↑ x=44,45  （北区竖墙 z=8..24）
 *              ↑ x=23,24   ↑ x=40,41  （南区竖墙 z=38..46）
 */

export const FLOOR_Y  = 0;            // 地板所在层（顶面 = y=1）
export const CEIL_Y   = 5;            // 天花板所在层
export const WALL_TOP = CEIL_Y - 1;   // 墙体最高格
export const WALL_THICK = 2;          // 墙厚（vox）
export const DOOR_H = 2;              // 门洞 / 门板高度（格）

export const SPAWN = { x: 32.5, y: 1.0, z: 58.5 };   // 庭院

/** 门位置清单，交给门系统实例化 */
export const DOORS = [];

const Y0 = 1;                         // 墙体 / 门洞起始格

/**
 * 主入口双开门的格坐标。main.js 用它把这两扇门预先打开 ——
 * 玩家出生在庭院正对这里，开局撞在关着的门上是很差的第一印象。
 */
export const MAIN_ENTRANCE = [[31, 47], [32, 47]];

/**
 * 建筑外墙：内表面 x=8..55、z=8..46。
 * 外墙占 x=6,7 / x=56,57 / z=6,7 / z=47,48。
 */
export const BUILDING = { x0: 8, z0: 8, x1: 55, z1: 46 };

/** 房间净空范围，敌人布置与测试都从这里取，避免坐标散落各处 */
export const ROOMS = {
  bedroom:   { x0: 8,  x1: 19, z0: 8,  z1: 14 },
  northHall: { x0: 22, x1: 43, z0: 8,  z1: 14 },
  study:     { x0: 46, x1: 55, z0: 8,  z1: 14 },
  westStore: { x0: 8,  x1: 19, z0: 17, z1: 24 },
  warehouse: { x0: 22, x1: 43, z0: 17, z1: 24 },
  eastStore: { x0: 46, x1: 55, z0: 17, z1: 24 },
  corridor:  { x0: 8,  x1: 55, z0: 27, z1: 30 },
  southHall: { x0: 8,  x1: 55, z0: 33, z1: 35 },
  living:    { x0: 8,  x1: 22, z0: 38, z1: 46 },
  foyer:     { x0: 25, x1: 39, z0: 38, z1: 46 },
  kitchen:   { x0: 42, x1: 55, z0: 38, z1: 46 },
};

// ───────────────────────────────────────────────────────────────────────────
// 建造原语
// ───────────────────────────────────────────────────────────────────────────

/** 单格宽的一条墙 */
function wallRun(w, x0, z0, x1, z1, yFrom, yTo, id) {
  const dx = Math.sign(x1 - x0), dz = Math.sign(z1 - z0);
  let x = x0, z = z0;
  const steps = Math.max(Math.abs(x1 - x0), Math.abs(z1 - z0));
  for (let i = 0; i <= steps; i++) {
    for (let y = yFrom; y <= yTo; y++) w.set(x, y, z, id);
    x += dx; z += dz;
  }
}

/**
 * 沿 z 延伸的厚墙（占 x = x .. x+thick-1），从 y=1 砌到天花板下沿。
 * 命名按「墙面法线的轴」：xWall 的法线在 x 上，所以它是南北向的墙。
 */
function xWall(w, x, z0, z1, id = BLOCK.WALL_IN, thick = WALL_THICK) {
  for (let t = 0; t < thick; t++) wallRun(w, x + t, z0, x + t, z1, Y0, WALL_TOP, id);
}

/** 沿 x 延伸的厚墙（占 z = z .. z+thick-1） */
function zWall(w, z, x0, x1, id = BLOCK.WALL_IN, thick = WALL_THICK) {
  for (let t = 0; t < thick; t++) wallRun(w, x0, z + t, x1, z + t, Y0, WALL_TOP, id);
}

/**
 * 在厚墙上开门洞并登记一扇门。
 *
 * @param through 门洞贯穿方向 'x' | 'z'。门洞从 (x,z) 沿这个方向清空
 *                thick 格，所以 (x,z) 永远是门洞靠「小坐标」的那一端。
 *
 * 门板装在 (x,z) 这一格，开门时朝小坐标一侧旋转 90° 退出通道 ——
 * 所以调用方必须保证 (x-1,z) 或 (x,z-1) 是房间净空。
 * 这条约束由 test/logic.test.mjs 的「门可完全敞开」用例守着。
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

/**
 * 无门通道口（拱门）：沿 along 轴 span 格宽，穿墙方向清空整个厚度。
 * 拱门给 3 格高 —— 它是永久开口，高一点让主动线读起来更开阔。
 */
function carveOpening(w, x, z, along, span, through, thick = WALL_THICK) {
  for (let i = 0; i < span; i++) {
    for (let t = 0; t < thick; t++) {
      const px = x + (along === 'x' ? i : 0) + (through === 'x' ? t : 0);
      const pz = z + (along === 'z' ? i : 0) + (through === 'z' ? t : 0);
      for (let y = Y0; y < Y0 + 3; y++) w.set(px, y, pz, BLOCK.AIR);
    }
  }
}

// ───────────────────────────────────────────────────────────────────────────

export function buildLevel01() {
  const w = new World();
  DOORS.length = 0;
  const B = BUILDING;

  // ---- 地面 ----------------------------------------------------------------
  // 庭院草地（见天 → 有月光），建筑内部混凝土
  w.fill(0, 0, 0, 63, 0, 63, BLOCK.GRASS);
  w.fill(B.x0 - 2, 0, B.z0 - 2, B.x1 + 2, 0, B.z1 + 2, BLOCK.CONCRETE);

  // ---- 庭院边界矮墙（挡住玩家跑出世界，但不挡月光）------------------------
  for (let t = 0; t < 2; t++) {
    wallRun(w, 1, 1 + t, 62, 1 + t, Y0, 2, BLOCK.WALL);
    wallRun(w, 1, 62 - t, 62, 62 - t, Y0, 2, BLOCK.WALL);
    wallRun(w, 1 + t, 1, 1 + t, 62, Y0, 2, BLOCK.WALL);
    wallRun(w, 62 - t, 1, 62 - t, 62, Y0, 2, BLOCK.WALL);
  }

  // ---- 建筑外墙（2 格厚，地面直达天花板）---------------------------------
  const EX = BLOCK.WALL;
  zWall(w, B.z0 - 2, B.x0 - 2, B.x1 + 2, EX);   // 北 z=6,7
  zWall(w, B.z1 + 1, B.x0 - 2, B.x1 + 2, EX);   // 南 z=47,48
  xWall(w, B.x0 - 2, B.z0 - 2, B.z1 + 2, EX);   // 西 x=6,7
  xWall(w, B.x1 + 1, B.z0 - 2, B.z1 + 2, EX);   // 东 x=56,57

  // ---- 室内隔墙（全部 2 格厚）-------------------------------------------
  zWall(w, 15, B.x0, B.x1);        // 北区分隔：卧室/走道/书房 ↔ 储藏/仓库
  zWall(w, 25, B.x0, B.x1);        // 仓库带 ↔ 主走廊
  zWall(w, 31, B.x0, B.x1);        // 主走廊 ↔ 南侧过道
  zWall(w, 36, B.x0, B.x1);        // 南侧过道 ↔ 南三间

  xWall(w, 20, B.z0, 24);          // 北区西竖墙（卧室/西储 ↔ 中段）
  xWall(w, 44, B.z0, 24);          // 北区东竖墙（中段 ↔ 书房/东储）
  xWall(w, 23, 38, B.z1);          // 南区西竖墙（客厅 ↔ 门厅）
  xWall(w, 40, 38, B.z1);          // 南区东竖墙（门厅 ↔ 厨房）

  // ---- 门与通道口 --------------------------------------------------------
  // 主入口：南外墙双开门，正对庭院出生点（开门后退进门厅，不挡通道）
  for (const [mx, mz] of MAIN_ENTRANCE) carveDoor(w, mx, mz, 'z');
  // 东侧门：从庭院东侧绕后进东储
  carveDoor(w, B.x1 + 1, 20, 'x');

  // 门厅 → 南侧过道（4 格宽拱门，主动线）
  carveOpening(w, 30, 36, 'x', 4, 'z');
  // 门厅 ↔ 客厅 / 厨房
  carveDoor(w, 23, 42, 'x');       // 开向客厅（x=22 净空）
  carveDoor(w, 40, 42, 'x');       // 开向门厅（x=39 净空）
  // 客厅 / 厨房 各自的第二入口，直通南侧过道
  carveDoor(w, 14, 36, 'z');
  carveDoor(w, 48, 36, 'z');

  // 南侧过道 → 主走廊：中央拱门 + 两侧翼门（三条推进路线）
  carveOpening(w, 30, 31, 'x', 3, 'z');
  carveDoor(w, 12, 31, 'z');
  carveDoor(w, 50, 31, 'z');

  // 主走廊 → 仓库带
  carveOpening(w, 30, 25, 'x', 4, 'z');
  carveDoor(w, 12, 25, 'z');       // 开向西储
  carveDoor(w, 50, 25, 'z');       // 开向东储

  // 仓库 ↔ 两侧储藏间
  carveDoor(w, 20, 21, 'x');       // 开向西储（x=19 净空）
  carveDoor(w, 44, 21, 'x');       // 开向仓库（x=43 净空）

  // 仓库 → 北走道
  carveOpening(w, 31, 15, 'x', 3, 'z');
  // 北走道 ↔ 卧室 / 书房
  carveDoor(w, 20, 11, 'x');       // 开向卧室（x=19 净空）
  carveDoor(w, 44, 11, 'x');       // 开向北走道（x=43 净空）
  // 卧室 / 书房 的第二入口，直通两侧储藏间
  carveDoor(w, 14, 15, 'z');
  carveDoor(w, 50, 15, 'z');

  // ---- 天花板（铺满整栋，含墙体上方）------------------------------------
  w.fill(B.x0 - 2, CEIL_Y, B.z0 - 2, B.x1 + 2, CEIL_Y, B.z1 + 2, BLOCK.CEILING);

  /**
   * ---- 走廊断视线：错位墙垛 ---------------------------------------------
   *
   * 48 vox 的直走廊违反 GDD「走廊不超过 20 vox」。用错位墙垛切断长视线。
   *
   * ══ 墙垛必须封 3 格，不能只封 2 格 ══
   *
   * 走廊净空 4 格（z=27..30）。曾经一个墙垛封 z=27,28、另一个封 z=29,30，
   * 直线视线确实被挡住了，但存在一条从 (55,27) 到 (8,30) 的**斜线**
   * 恰好从两个墙垛的缺口穿过 —— 实测整条 47 vox 走廊仍然一眼看到底，
   * 墙垛等于没起作用。
   *
   * 现在每个墙垛封 3 格、只留 1 格通道，且两者留的是**不同**的那 1 格。
   * 任何一条从东端到西端的视线都必须同时穿过两个只有 1 格宽的缺口，
   * 而它们在 z 上错开 —— 几何上不可能。代价是通道变窄，推进必须切角，
   * 这正是想要的效果。
   */
  xWall(w, 24, 27, 29, BLOCK.WALL_IN);   // 留 z=30
  xWall(w, 39, 28, 30, BLOCK.WALL_IN);   // 留 z=27
  // 南侧过道（z=33..35，净空 3 格）：各封 2 格，留不同的那 1 格
  xWall(w, 27, 33, 34, BLOCK.WALL_IN);   // 留 z=35
  xWall(w, 45, 34, 35, BLOCK.WALL_IN);   // 留 z=33

  // ---- 掩体（错位摆放，门口留白 2 格）-----------------------------------
  const crates = [
    // 仓库：错位货箱，形成可接近的长视线
    [25, 19], [26, 19], [25, 20],
    [37, 21], [38, 21],
    [30, 23], [31, 23],
    [41, 18],
    // 北走道
    [27, 10], [28, 10], [38, 12],
    // 主走廊
    [18, 28], [33, 29], [46, 28],
    // 南侧过道
    [20, 34], [43, 34],
    // 门厅 / 客厅 / 厨房
    [27, 41], [37, 42], [10, 44], [52, 44],
    // 储藏间
    [12, 19], [17, 22], [48, 19], [53, 22],
  ];
  for (const [cx, cz] of crates) {
    if (w.get(cx, Y0, cz) === BLOCK.AIR) w.set(cx, Y0, cz, BLOCK.CRATE);
  }

  // 2 格高货架（齐胸掩体，透光形成条纹阴影）
  const shelves = [
    [29, 17], [29, 18], [34, 17], [34, 18],
    [39, 23], [39, 24], [23, 21], [23, 22],
    [15, 29], [42, 29],
  ];
  for (const [sx, sz] of shelves) {
    if (w.get(sx, Y0, sz) !== BLOCK.AIR) continue;
    w.set(sx, Y0, sz, BLOCK.SHELF);
    w.set(sx, Y0 + 1, sz, BLOCK.SHELF);
  }

  // 庭院掩体（教学区：进门前先学会用掩体）
  for (const [cx, cz] of [[28, 54], [29, 54], [36, 56], [24, 58], [40, 52]]) {
    w.set(cx, Y0, cz, BLOCK.CRATE);
  }

  // ---- 家具 --------------------------------------------------------------
  furnishLevel01(w, Y0);

  // 家具布置完之后统一清障：门洞、通道口与出生点必须净空。
  clearDoorways(w);
  clearSpawn(w);

  return w;
}

/**
 * 门口 / 出生点清障时「可以拆掉」的方块白名单。
 *
 * ══ 为什么必须是白名单，不能用 ID 区间 ══
 *
 * 原来写的是 `id >= BLOCK.SOFA` —— 想表达「家具的 ID 都在 SOFA 之后」。
 * 但 blocks.js 后来在家具之后又追加了建筑材质（CONCRETE 27 / CEILING 28 /
 * WALL_IN 29 / ROOF 30），它们的 ID 也都 >= SOFA(12)，于是门口清障
 * 把内墙一起拆了：北区两道竖墙在 z=9..13 被清空，卧室 / 走道 / 书房
 * 变成一个巨大的通间，室内最长视线达到 47 vox（整栋楼对角）。
 *
 * ID 区间判断在「枚举还会继续增长」的地方是必错的。白名单不会随
 * 新增方块而失效 —— 新方块默认不可拆，这是安全的默认值。
 */
const CLEARABLE = new Set([
  // 掩体
  BLOCK.CRATE, BLOCK.SHELF,
  // 家具
  BLOCK.SOFA, BLOCK.SOFA_BACK, BLOCK.TABLE, BLOCK.TV, BLOCK.BED,
  BLOCK.CABINET, BLOCK.CARPET, BLOCK.LAMP, BLOCK.PLANT, BLOCK.COUNTER,
  BLOCK.CHAIR, BLOCK.WARDROBE, BLOCK.PICTURE, BLOCK.SINK, BLOCK.BOOKSHELF,
]);

/**
 * 门洞及其两侧各 2 格无阻挡（GDD 规则 1：留出切角空间）。
 * 只清家具与掩体，绝不动墙体、地板与天花板。
 */
function clearDoorways(w) {
  for (const d of DOORS) {
    const spanX = 2 + (d.through === 'x' ? d.thick : 0);
    const spanZ = 2 + (d.through === 'z' ? d.thick : 0);
    for (let y = d.y; y < d.y + DOOR_H; y++) {
      for (let dx = -2; dx <= spanX; dx++) {
        for (let dz = -2; dz <= spanZ; dz++) {
          const id = w.get(d.x + dx, y, d.z + dz);
          if (CLEARABLE.has(id)) w.set(d.x + dx, y, d.z + dz, BLOCK.AIR);
        }
      }
    }
  }
  // 门框标记本身要保住（clear 可能把它连带清掉）
  for (const d of DOORS) {
    if (w.get(d.x, d.y, d.z) === BLOCK.AIR) w.set(d.x, d.y, d.z, BLOCK.DOORFRAME);
  }
}

/** 出生点周围 2 格净空，避免开局卡在家具里 */
function clearSpawn(w) {
  const sx = Math.floor(SPAWN.x), sz = Math.floor(SPAWN.z);
  for (let y = Y0; y < Y0 + 3; y++) {
    for (let dx = -2; dx <= 2; dx++) {
      for (let dz = -2; dz <= 2; dz++) {
        const id = w.get(sx + dx, y, sz + dz);
        // 同样用白名单：`id >= BLOCK.CRATE` 会把庭院矮墙也拆掉
        if (CLEARABLE.has(id)) w.set(sx + dx, y, sz + dz, BLOCK.AIR);
      }
    }
  }
}
