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

  // ── 家具（让黑楼像个住过人的地方）──
  // 全部仍是方块，只是高度/颜色/透光性不同，所以掩体分级依然一眼可读。
  SOFA:      12,   // 沙发座（矮掩体，可跳上）
  SOFA_BACK: 13,   // 沙发靠背（齐胸，挡视线）
  TABLE:     14,   // 桌面（腿高，可蹲身躲）
  TV:        15,   // 电视（深色屏幕）
  BED:       16,   // 床垫
  CABINET:   17,   // 柜子 / 冰箱（满高，挡光）
  CARPET:    18,   // 地毯（贴地薄片，纯装饰）
  LAMP:      19,   // 台灯（自发光，唯一的室内光点）
  PLANT:     20,   // 盆栽（透光，不挡视线）
  COUNTER:   21,   // 厨房台面 / 吧台
  CHAIR:     22,   // 椅子
  WARDROBE:  23,   // 衣柜（满高）
  PICTURE:   24,   // 墙上挂画（贴墙薄片）
  SINK:      25,   // 洗手台 / 马桶
  BOOKSHELF: 26,   // 书架（透光，缝隙漏光）

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

  /**
   * 应急灯（可击碎）。天花板下的老式灯管，接触不良所以一直在闪。
   *
   * 与 LAMP 的区别：LAMP 是纯装饰的自发光方块（顶点色，没有真光源），
   * 这个挂一盏真的 PointLight —— 会真的照亮房间，也真的让站在灯下的
   * 玩家更容易被敌人看见。玩家可以把它打碎换回黑暗，这是本作唯一
   * 「玩家能改写关卡照明」的手段，所以它必须是可被子弹命中的方块。
   *
   * 不 solid（贴在天花板下，不该挡人走路），但 hittable —— 命中判定
   * 由 combat 的方块射线单独处理，见 systems/lights.js。
   */
  FLICKER_LAMP:  32,
  /** 打碎后的残骸：同样占格但不发光，让玩家看得出「这盏已经打过了」 */
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
BLOCKS[BLOCK.CRATE]     = def({ color: PALETTE.cover, name: 'crate', climbable: true });
BLOCKS[BLOCK.SHELF]     = def({ color: PALETTE.cover, name: 'shelf', opaque: false });
BLOCKS[BLOCK.RESERVED_5] = def({ solid: false, opaque: false, render: false, height: 0, name: 'reserved_5' });
BLOCKS[BLOCK.STAIR_LO]  = def({ color: PALETTE.floor, name: 'stair_lo', height: 0.5, climbable: true });
BLOCKS[BLOCK.STAIR_HI]  = def({ color: PALETTE.floor, name: 'stair_hi', height: 1.0, climbable: true });
BLOCKS[BLOCK.DOORFRAME] = def({ solid: false, opaque: false, render: false, height: 0 });
BLOCKS[BLOCK.DECAL]     = def({ solid: false, opaque: false, height: 0.02, color: PALETTE.bloodDark, jitter: false });
BLOCKS[BLOCK.GRASS]     = def({ color: 0x232b36, name: 'grass', climbable: true });
BLOCKS[BLOCK.RESERVED_11] = def({ solid: false, opaque: false, render: false, height: 0, name: 'reserved_11' });

// ── 家具 ──────────────────────────────────────────────────────────────────
// 高度决定掩体等级（GDD 02 章「掩体天然分级」）：
//   ≤0.6 → 蹲下可完全遮蔽   1.0 → 遮蔽蹲伏玩家   ≥1.5 → 遮蔽站立躯干
const FURN = PALETTE.furniture;
BLOCKS[BLOCK.SOFA]      = def({ color: FURN.sofa,   name: 'sofa',   height: 0.55, climbable: true, opaque: false });
BLOCKS[BLOCK.SOFA_BACK] = def({ color: FURN.sofa,   name: 'sofa_back', height: 1.0, climbable: true });
BLOCKS[BLOCK.TABLE]     = def({ color: FURN.wood,   name: 'table',  height: 0.75, climbable: true, opaque: false });
BLOCKS[BLOCK.TV]        = def({ color: FURN.screen, name: 'tv',     height: 0.7,  opaque: false, emissive: 0.35 });
BLOCKS[BLOCK.BED]       = def({ color: FURN.fabric, name: 'bed',    height: 0.5,  climbable: true, opaque: false });
BLOCKS[BLOCK.CABINET]   = def({ color: FURN.wood,   name: 'cabinet', height: 1.0, climbable: true });
BLOCKS[BLOCK.CARPET]    = def({ color: FURN.carpet, name: 'carpet', height: 0.03, solid: false, opaque: false });
BLOCKS[BLOCK.PLANT]     = def({ color: FURN.plant,  name: 'plant',  height: 0.8,  opaque: false });
BLOCKS[BLOCK.COUNTER]   = def({ color: FURN.stone,  name: 'counter', height: 0.9, climbable: true });
BLOCKS[BLOCK.CHAIR]     = def({ color: FURN.wood,   name: 'chair',  height: 0.5,  climbable: true, opaque: false });
BLOCKS[BLOCK.WARDROBE]  = def({ color: FURN.woodDark, name: 'wardrobe', height: 1.0 });
BLOCKS[BLOCK.PICTURE]   = def({ color: FURN.frame,  name: 'picture', height: 1.0, solid: false, opaque: false, jitter: false });
BLOCKS[BLOCK.SINK]      = def({ color: FURN.porcelain, name: 'sink', height: 0.8, climbable: true, opaque: false });
BLOCKS[BLOCK.BOOKSHELF] = def({ color: FURN.woodDark, name: 'bookshelf', height: 1.0, opaque: false });
// 台灯：唯一的室内自发光方块。它给黑屋提供零星的「有人住过」的暖光锚点，
// 同时不破坏「只有手电带阴影」的性能预算（发光靠顶点色，不是真光源）。
BLOCKS[BLOCK.LAMP]      = def({ color: FURN.lamp,   name: 'lamp',   height: 0.6, opaque: false, emissive: 0.55 });

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
