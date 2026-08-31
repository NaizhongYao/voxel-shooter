import { PALETTE } from '../config.js';

/**
 * 方块类型总表（GDD 02 章 Block Registry）。
 * 索引 = 存进 Uint8Array 的 ID。
 *
 * solid       : 阻挡移动与子弹
 * opaque      : 阻挡视线与光（透光方块不投影）
 * height      : 占格高度（<1 的方块从格底往上长）
 * climbable   : 可被 stepUp 跨上
 */
export const BLOCK = {
  AIR:        0,
  WALL:       1,
  FLOOR:      2,
  CRATE:      3,
  SHELF:      4,
  // 5 号位曾是 RAILING（二层天井栏杆）。二楼砍掉后没有任何栏杆，
  // 但 ID 是存在 Uint8Array 里的，重新编号会让所有硬编码坐标失效，
  // 所以留一个不渲染的占位，等下次真的需要 5 号方块时再用。
  RESERVED_5: 5,
  STAIR_LO:   6,   // 半格阶梯（0.5 高）
  STAIR_HI:   7,   // 一格阶梯（1.0 高），与 STAIR_LO 交替堆出平缓楼梯
  DOORFRAME:  8,   // 逻辑标记，无几何
  DECAL:      9,   // 血迹贴花，贴地薄片
  GRASS:     10,   // 庭院地面（有月光）
  RESERVED_11: 11, // 曾是 CATWALK（二层薄走道），同上

  // ── 家具 ID（deprecated voxel compatibility slots）────────────────────
  // 正式家具布局只写 furniture metadata；这些 numeric ID 仍必须稳定，供旧
  // 存档、平面图 fallback 和测试工具读取，不能重新编号或删除槽位。
  SOFA:      12,   // deprecated: 沙发座
  SOFA_BACK: 13,   // deprecated: 沙发靠背
  TABLE:     14,   // deprecated: 桌面
  TV:        15,   // deprecated: 电视
  BED:       16,   // deprecated: 床垫
  CABINET:   17,   // deprecated: 柜子 / 冰箱
  CARPET:    18,   // deprecated: 地毯
  LAMP:      19,   // deprecated: 台灯
  PLANT:     20,   // deprecated: 盆栽
  COUNTER:   21,   // deprecated: 厨房台面 / 吧台
  CHAIR:     22,   // deprecated: 椅子
  WARDROBE:  23,   // deprecated: 衣柜
  PICTURE:   24,   // deprecated: 墙上挂画
  SINK:      25,   // deprecated: 洗手台 / 马桶
  BOOKSHELF: 26,   // deprecated: 书架

  // ── 建筑材质分层 ──
  // 地板/墙/天花板用不同明度，室内空间的上下界才读得出来。
  CONCRETE:  27,   // 水泥地板（一层地面）
  CEILING:   28,   // 天花板（= 二层楼板的下表面）
  WALL_IN:   29,   // 室内墙面（比外墙略亮，区分内外）
  ROOF:      30,   // 屋顶

  /**
   * 关着的门所占的格。solid + opaque（挡移动、挡子弹、挡视线、挡光，
   * 与墙完全一致），但 render:false —— 外观交给 Door 的琥珀色门板网格。
   *
   * ══ 为什么必须单独一个 ID ══
   *
   * 以前关门是往格子里写 BLOCK.WALL。那是个**整格实心立方体**，正好把
   * 0.14 厚的门板网格整个包在里面 —— 玩家看到的是一堵灰墙，根本看不出
   * 这里是门，也就不会想到按 E。现在体素只负责「挡住」，外观只由门板
   * 网格负责，两者不再互相遮蔽。
   */
  DOOR:      31,

  /** 应急灯保留为 lights.js/fallback 使用的正式体素标记。 */
  FLICKER_LAMP:  32,
  /** 打碎后的残骸，供运行时状态和 fallback 扫描使用。 */
  LAMP_BROKEN:   33,
};

const def = (o) => ({
  solid: true, opaque: true, height: 1, climbable: false,
  render: true, color: PALETTE.wall, jitter: true, emissive: 0, ...o,
});

export const BLOCKS = [];
BLOCKS[BLOCK.AIR]       = def({ solid: false, opaque: false, render: false, height: 0 });
BLOCKS[BLOCK.WALL]      = def({ color: PALETTE.wall,  name: 'wall' });
BLOCKS[BLOCK.FLOOR]     = def({ color: PALETTE.floor, name: 'floor', climbable: true });
// Deprecated compatibility fixtures: canonical furniture uses metadata, but
// render/logic/fallback tools still need real generic obstacle definitions.
BLOCKS[BLOCK.CRATE]     = def({ color: PALETTE.cover, name: 'crate', climbable: true });
BLOCKS[BLOCK.SHELF]     = def({ color: PALETTE.cover, name: 'shelf', opaque: false });
BLOCKS[BLOCK.RESERVED_5] = def({ solid: false, opaque: false, render: false, height: 0, name: 'reserved_5' });
BLOCKS[BLOCK.STAIR_LO]  = def({ color: PALETTE.floor, name: 'stair_lo', height: 0.5, climbable: true });
BLOCKS[BLOCK.STAIR_HI]  = def({ color: PALETTE.floor, name: 'stair_hi', height: 1.0, climbable: true });
BLOCKS[BLOCK.DOORFRAME] = def({ solid: false, opaque: false, render: false, height: 0 });
BLOCKS[BLOCK.DECAL]     = def({ solid: false, opaque: false, height: 0.02, color: PALETTE.bloodDark, jitter: false });
BLOCKS[BLOCK.GRASS]     = def({ color: 0x232b36, name: 'grass', climbable: true });
BLOCKS[BLOCK.RESERVED_11] = def({ solid: false, opaque: false, render: false, height: 0, name: 'reserved_11' });

// ── 普通家具兼容槽位 ───────────────────────────────────────────────────────
// 普通家具的颜色、高度、碰撞和发光语义已迁移到 furniture metadata/mesh/
// collider。这里不能留旧的实体定义，否则任一误写 numeric ID 都会把家具
// 重新带回 voxel 生产路径；每个 ID 仍有完整 BLOCKS 槽位供兼容读取。
const deprecatedFurniture = (name) => def({
  name: `${name}_deprecated`, solid: false, opaque: false, render: false, height: 0,
  climbable: false, emissive: 0, jitter: false,
});
BLOCKS[BLOCK.SOFA]      = deprecatedFurniture('sofa');
BLOCKS[BLOCK.SOFA_BACK] = deprecatedFurniture('sofa_back');
BLOCKS[BLOCK.TABLE]     = deprecatedFurniture('table');
BLOCKS[BLOCK.TV]        = deprecatedFurniture('tv');
BLOCKS[BLOCK.BED]       = deprecatedFurniture('bed');
BLOCKS[BLOCK.CABINET]   = deprecatedFurniture('cabinet');
BLOCKS[BLOCK.CARPET]    = deprecatedFurniture('carpet');
BLOCKS[BLOCK.LAMP]      = deprecatedFurniture('lamp');
BLOCKS[BLOCK.PLANT]     = deprecatedFurniture('plant');
BLOCKS[BLOCK.COUNTER]   = deprecatedFurniture('counter');
BLOCKS[BLOCK.CHAIR]     = deprecatedFurniture('chair');
BLOCKS[BLOCK.WARDROBE]  = deprecatedFurniture('wardrobe');
BLOCKS[BLOCK.PICTURE]   = deprecatedFurniture('picture');
BLOCKS[BLOCK.SINK]      = deprecatedFurniture('sink');
BLOCKS[BLOCK.BOOKSHELF] = deprecatedFurniture('bookshelf');

// ── 建筑材质 ──────────────────────────────────────────────────────────────
// 明度刻意分三档：地板最亮（手电扫过去有反馈）、墙中等、天花板最暗
// （抬头是压迫感的来源）。这三档让室内空间的上下界一眼可读。
// 关着的门：挡住一切，但不画几何（门板网格自己画，见 systems/doors.js）
BLOCKS[BLOCK.DOOR]      = def({ color: PALETTE.amber, name: 'door', render: false });
BLOCKS[BLOCK.CONCRETE]  = def({ color: PALETTE.concrete, name: 'concrete', climbable: true });
BLOCKS[BLOCK.CEILING]   = def({ color: PALETTE.ceiling,  name: 'ceiling',  climbable: true });
BLOCKS[BLOCK.WALL_IN]   = def({ color: PALETTE.wallIn,   name: 'wall_in' });
BLOCKS[BLOCK.ROOF]      = def({ color: PALETTE.roof,     name: 'roof' });

/**
 * 应急灯与它的残骸。
 *
 * solid:false —— 灯挂在天花板下（y=3），玩家不会撞到它，也不该挡子弹；
 * 打碎它靠 lights.js 自己的射线判定，不走体素碰撞。
 * opaque:false —— 灯不挡视线，否则亮着的灯会在敌人视野里投出一块盲区。
 * emissive 很高：即使真光源被打掉，顶点色也要让人看出「那里有个灯」。
 */
BLOCKS[BLOCK.FLICKER_LAMP] = def({
  color: 0xfff2c4, name: 'flicker_lamp', height: 0.3,
  solid: false, opaque: false, emissive: 0.9, jitter: false,
});
BLOCKS[BLOCK.LAMP_BROKEN]  = def({
  color: 0x3a3f46, name: 'lamp_broken', height: 0.3,
  solid: false, opaque: false, emissive: 0, jitter: false,
});

export const isSolid  = (id) => BLOCKS[id].solid;
export const isOpaque = (id) => BLOCKS[id].opaque;
/** 方块顶面在格内的相对高度，用于地面吸附与 stepUp */
export const topOf    = (id) => BLOCKS[id].height;
