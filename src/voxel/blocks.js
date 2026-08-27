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
  RAILING:    5,
  STAIR_LO:   6,   // 半格阶梯（0.5 高）
  STAIR_HI:   7,   // 一格阶梯（1.0 高），与 STAIR_LO 交替堆出平缓楼梯
  DOORFRAME:  8,   // 逻辑标记，无几何
  DECAL:      9,   // 血迹贴花，贴地薄片
  GRASS:     10,   // 庭院地面（有月光）
  CATWALK:   11,   // 二层走道（薄楼板）
};

const def = (o) => ({
  solid: true, opaque: true, height: 1, climbable: false,
  render: true, color: PALETTE.wall, jitter: true, ...o,
});

export const BLOCKS = [];
BLOCKS[BLOCK.AIR]       = def({ solid: false, opaque: false, render: false, height: 0 });
BLOCKS[BLOCK.WALL]      = def({ color: PALETTE.wall,  name: 'wall' });
BLOCKS[BLOCK.FLOOR]     = def({ color: PALETTE.floor, name: 'floor', climbable: true });
BLOCKS[BLOCK.CRATE]     = def({ color: PALETTE.cover, name: 'crate', climbable: true });
BLOCKS[BLOCK.SHELF]     = def({ color: PALETTE.cover, name: 'shelf', opaque: false });
BLOCKS[BLOCK.RAILING]   = def({ color: PALETTE.cover, name: 'railing', opaque: false, height: 0.9 });
BLOCKS[BLOCK.STAIR_LO]  = def({ color: PALETTE.floor, name: 'stair_lo', height: 0.5, climbable: true });
BLOCKS[BLOCK.STAIR_HI]  = def({ color: PALETTE.floor, name: 'stair_hi', height: 1.0, climbable: true });
BLOCKS[BLOCK.DOORFRAME] = def({ solid: false, opaque: false, render: false, height: 0 });
BLOCKS[BLOCK.DECAL]     = def({ solid: false, opaque: false, height: 0.02, color: PALETTE.bloodDark, jitter: false });
BLOCKS[BLOCK.GRASS]     = def({ color: 0x232b36, name: 'grass', climbable: true });
BLOCKS[BLOCK.CATWALK]   = def({ color: PALETTE.floor, name: 'catwalk', height: 0.25, climbable: true });

export const isSolid  = (id) => BLOCKS[id].solid;
export const isOpaque = (id) => BLOCKS[id].opaque;
/** 方块顶面在格内的相对高度，用于地面吸附与 stepUp */
export const topOf    = (id) => BLOCKS[id].height;
