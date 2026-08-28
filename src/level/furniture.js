import { BLOCK } from '../voxel/blocks.js';

/**
 * 家具布置：把空荡的黑楼变成一栋住过人的房子。
 *
 * 三条约束：
 *  1. 门内侧 2 格不放任何东西 —— 玩家需要切角的物理空间（GDD 10 章）。
 *  2. 家具错位摆放 —— 从不同门进来看到的扇区不同，「选哪扇门」才是决策。
 *  3. 永不覆盖已有方块。put() 会先检查目标格是不是空气，所以家具绝不会
 *     长进墙里、也不会盖掉掩体 —— 「家具嵌在墙中间」那类穿模从源头消失。
 *
 * 家具同时承担掩体功能，高度就是掩体等级：
 *  沙发座 0.55 / 桌 0.75 / 台面 0.9 / 沙发靠背·柜·衣柜 1.0
 */

/** 一组辅助函数，让房间布置读起来像在描述家具而不是填数组 */
function make(w, y) {
  return {
    /**
     * 单块。只写进空气格或地毯上 —— 家具永远不会长进墙里或盖掉掩体。
     *
     * 允许覆盖地毯是因为布置顺序是「先铺地毯再摆家具」（读起来才自然），
     * 而地毯是 0.03 高的非实体装饰片，被家具压住完全合理。
     * 换成「只写空气」会让沙发、床、电视全部被自己脚下的地毯挡掉。
     */
    put(x, z, id) {
      const cur = w.get(x, y, z);
      if (cur === BLOCK.AIR || cur === BLOCK.CARPET) w.set(x, y, z, id);
    },
    /** 沿 x 或 z 排一行 */
    row(x, z, len, id, axis = 'x') {
      for (let i = 0; i < len; i++) {
        this.put(axis === 'x' ? x + i : x, axis === 'x' ? z : z + i, id);
      }
    },
    /** 实心矩形 */
    rect(x0, z0, x1, z1, id) {
      for (let z = z0; z <= z1; z++) for (let x = x0; x <= x1; x++) this.put(x, z, id);
    },
    /** 地毯：贴地薄片，纯装饰 */
    carpet(x0, z0, x1, z1) {
      for (let z = z0; z <= z1; z++)
        for (let x = x0; x <= x1; x++) this.put(x, z, BLOCK.CARPET);
    },
    /**
     * 沙发：座位 + 靠背。facing 指沙发朝向（靠背在反侧）。
     * 「坐着看电视」的朝向关系是对的，玩家才能读懂房间的用途。
     */
    sofa(x, z, len, facing) {
      const horiz = facing === 'north' || facing === 'south';
      for (let i = 0; i < len; i++) {
        const sx = horiz ? x + i : x;
        const sz = horiz ? z : z + i;
        this.put(sx, sz, BLOCK.SOFA);
        const bx = sx + (facing === 'east' ? -1 : facing === 'west' ? 1 : 0);
        const bz = sz + (facing === 'south' ? -1 : facing === 'north' ? 1 : 0);
        this.put(bx, bz, BLOCK.SOFA_BACK);
      }
    },
    /**
     * 挂画：贴在墙面上的薄片，挂在腰上一格（y+1）。
     * 必须紧贴一面实心墙才挂 —— 否则会变成飘在房间中间的画框。
     */
    picture(x, z) {
      if (w.get(x, y + 1, z) !== BLOCK.AIR) return;
      const touchesWall =
        w.get(x - 1, y + 1, z) !== BLOCK.AIR || w.get(x + 1, y + 1, z) !== BLOCK.AIR ||
        w.get(x, y + 1, z - 1) !== BLOCK.AIR || w.get(x, y + 1, z + 1) !== BLOCK.AIR;
      if (touchesWall) w.set(x, y + 1, z, BLOCK.PICTURE);
    },
  };
}

/**
 * 单层布局的家具。房间边界与 level01.js 的 ROOMS 完全一致：
 *
 *   卧室     x= 8..19  z= 8..14
 *   北走道   x=22..43  z= 8..14
 *   书房     x=46..55  z= 8..14
 *   西储     x= 8..19  z=17..24
 *   仓库     x=22..43  z=17..24
 *   东储     x=46..55  z=17..24
 *   主走廊   x= 8..55  z=27..30
 *   南过道   x= 8..55  z=33..35
 *   客厅     x= 8..22  z=38..46
 *   门厅     x=25..39  z=38..46
 *   厨房     x=42..55  z=38..46
 *
 * @param w  World
 * @param y  地面所在层（家具放这一层）
 */
export function furnishLevel01(w, y) {
  const F = make(w, y);

  // ══ 门厅（南侧，正对主入口）══════════════════════════════════════════
  // 玄关：鞋柜靠两侧竖墙，门内 2 格留空（主入口在 x=31,32）
  F.put(26, 39, BLOCK.CABINET);
  F.put(38, 39, BLOCK.CABINET);
  F.picture(26, 38);
  F.picture(38, 38);
  F.carpet(29, 43, 35, 46);
  F.rect(27, 44, 28, 44, BLOCK.TABLE);       // 侧边小桌，不挡正门
  F.put(27, 43, BLOCK.CHAIR);
  F.put(26, 46, BLOCK.LAMP);
  F.put(38, 45, BLOCK.PLANT);
  F.put(36, 39, BLOCK.CRATE);

  // ══ 客厅（西南）══════════════════════════════════════════════════════
  // 沙发朝东看电视，中间地毯 + 茶几 —— 一眼能认出是客厅
  F.carpet(10, 40, 20, 45);
  F.sofa(10, 41, 5, 'east');                 // 靠背在西侧（贴外墙）
  F.put(14, 42, BLOCK.TABLE);                // 茶几
  F.put(14, 43, BLOCK.TABLE);
  F.put(15, 42, BLOCK.TABLE);
  F.put(20, 42, BLOCK.TV);                   // 电视对着沙发，发微光
  F.put(20, 43, BLOCK.TV);
  F.put(20, 41, BLOCK.CABINET);              // 电视柜
  F.put(9, 46, BLOCK.LAMP);                  // 落地灯（暖光锚点）
  F.put(11, 45, BLOCK.CRATE);
  F.put(17, 46, BLOCK.BOOKSHELF);
  F.put(18, 46, BLOCK.BOOKSHELF);
  F.picture(9, 39);

  // ══ 厨房 / 餐厅（东南）══════════════════════════════════════════════
  F.row(55, 40, 5, BLOCK.COUNTER, 'z');      // 沿东外墙的台面
  F.put(54, 40, BLOCK.CABINET);              // 冰箱
  F.put(55, 45, BLOCK.SINK);
  F.rect(46, 42, 47, 43, BLOCK.TABLE);       // 餐桌 + 四把椅子
  F.put(45, 42, BLOCK.CHAIR);
  F.put(45, 43, BLOCK.CHAIR);
  F.put(48, 42, BLOCK.CHAIR);
  F.put(48, 43, BLOCK.CHAIR);
  F.put(46, 46, BLOCK.PLANT);
  F.put(51, 40, BLOCK.LAMP);
  F.carpet(45, 45, 50, 46);
  F.picture(43, 45);

  // ══ 仓库（北侧大空间）════════════════════════════════════════════════
  // 保留货架掩体格局，补一点「仓库也有人用」的细节
  F.put(22, 18, BLOCK.CABINET);
  F.put(22, 19, BLOCK.CABINET);
  F.put(43, 23, BLOCK.CABINET);
  F.put(36, 17, BLOCK.COUNTER);              // 工作台
  F.put(37, 17, BLOCK.COUNTER);
  F.put(35, 17, BLOCK.LAMP);
  F.put(28, 24, BLOCK.PLANT);
  F.put(42, 18, BLOCK.BOOKSHELF);
  F.put(24, 18, BLOCK.CRATE);
  F.put(25, 18, BLOCK.CRATE);
  F.put(24, 19, BLOCK.CRATE);
  F.put(39, 22, BLOCK.CRATE);
  F.put(40, 22, BLOCK.TABLE);

  // ══ 卧室（西北）══════════════════════════════════════════════════════
  F.carpet(9, 9, 17, 14);
  F.rect(9, 10, 10, 12, BLOCK.BED);          // 双人床
  F.put(11, 10, BLOCK.CABINET);              // 床头柜
  F.put(11, 12, BLOCK.LAMP);                 // 床头灯
  F.put(17, 9, BLOCK.WARDROBE);              // 衣柜
  F.put(17, 10, BLOCK.WARDROBE);
  F.put(16, 14, BLOCK.CHAIR);
  F.put(13, 9, BLOCK.TV);
  F.picture(9, 14);

  // ══ 书房 / 卫浴（东北）══════════════════════════════════════════════
  F.put(47, 9, BLOCK.SINK);
  F.put(47, 10, BLOCK.SINK);                 // 马桶
  F.put(55, 9, BLOCK.BOOKSHELF);
  F.put(55, 10, BLOCK.BOOKSHELF);
  F.put(55, 11, BLOCK.BOOKSHELF);
  F.rect(52, 13, 53, 13, BLOCK.TABLE);       // 书桌
  F.put(52, 14, BLOCK.CHAIR);
  F.put(54, 13, BLOCK.LAMP);
  F.carpet(50, 12, 54, 14);
  F.picture(48, 14);

  // ══ 北走道 ══════════════════════════════════════════════════════════
  F.put(23, 9, BLOCK.PLANT);
  F.put(42, 9, BLOCK.PLANT);
  F.put(24, 13, BLOCK.LAMP);
  F.put(26, 9, BLOCK.CRATE);
  F.put(38, 13, BLOCK.TABLE);

  // ══ 储藏间（仓库两侧）══════════════════════════════════════════════
  F.put(8, 17, BLOCK.WARDROBE);
  F.put(9, 17, BLOCK.WARDROBE);
  F.put(19, 24, BLOCK.CABINET);
  F.put(8, 24, BLOCK.LAMP);
  F.put(55, 17, BLOCK.WARDROBE);
  F.put(54, 17, BLOCK.WARDROBE);
  F.put(46, 24, BLOCK.CABINET);
  F.put(55, 24, BLOCK.LAMP);

  // ══ 走廊：少量装饰，绝不挡住这条主动线 ══════════════════════════════
  F.put(9, 27, BLOCK.PLANT);
  F.put(54, 30, BLOCK.PLANT);
  F.picture(10, 27);
  F.picture(52, 30);
  F.put(21, 30, BLOCK.LAMP);
  F.put(36, 27, BLOCK.LAMP);

  // ══ 南侧过道 ════════════════════════════════════════════════════════
  F.put(9, 33, BLOCK.PLANT);
  F.put(54, 35, BLOCK.PLANT);
  F.put(16, 35, BLOCK.LAMP);
  F.put(50, 33, BLOCK.LAMP);

  // ══ 庭院：门口的生活痕迹 ════════════════════════════════════════════
  F.put(30, 52, BLOCK.PLANT);
  F.put(34, 52, BLOCK.PLANT);
  F.put(26, 56, BLOCK.CHAIR);
  F.put(27, 56, BLOCK.TABLE);
  F.put(38, 55, BLOCK.PLANT);
  F.put(29, 55, BLOCK.CRATE);
  F.put(36, 54, BLOCK.CRATE);
}
