import { BLOCK } from '../voxel/blocks.js';

/**
 * 共享家具库。任何关卡都从这里取件，不要在关卡文件里再抄一份 put/sofa。
 *
 * 三层：
 *   1. 方块 ID 仍在 blocks.js（渲染 / 碰撞的唯一来源）
 *   2. 本文件：放置原语 + 命名组合件 + 门口清障白名单
 *   3. 关卡布局脚本：只调用 kit()，决定「这间房放哪几件」
 *
 * 三条硬约束（所有地图共用）：
 *   · 永不覆盖已有方块（地毯除外，家具可以压地毯）
 *   · 门口 2 格净空由关卡清障负责，组合件自己不去保证
 *   · 新增家具方块必须同时写进 PIECES 和 CLEARABLE，否则门口清障拆不掉
 */

/**
 * 可摆放的单件。关卡一般 F.place('table', x, z)，散件也可 F.put(x, z, PIECES.table)。
 * 新增方块：先在 blocks.js 登记，再写进这里 —— CLEARABLE 会自动跟上。
 */
export const PIECES = {
  sofa:      BLOCK.SOFA,
  sofaBack:  BLOCK.SOFA_BACK,
  table:     BLOCK.TABLE,
  tv:        BLOCK.TV,
  bed:       BLOCK.BED,
  cabinet:   BLOCK.CABINET,
  carpet:    BLOCK.CARPET,
  lamp:      BLOCK.LAMP,
  plant:     BLOCK.PLANT,
  counter:   BLOCK.COUNTER,
  chair:     BLOCK.CHAIR,
  wardrobe:  BLOCK.WARDROBE,
  picture:   BLOCK.PICTURE,
  sink:      BLOCK.SINK,
  bookshelf: BLOCK.BOOKSHELF,
  crate:     BLOCK.CRATE,
  shelf:     BLOCK.SHELF,
};

/**
 * 命名组合件（多格家具）。新地图优先调这些，不要在关卡里再拼 2×3 的床。
 * 值是给关卡作者看的说明；真正的放置函数在 kit() 上同名。
 */
export const SETS = {
  sofa:            '沙发（座位+靠背）',
  doubleBed:       '双人床（床垫+床头柜+灯）',
  examBed:         '诊床 / 隔离床',
  tvStand:         '电视柜（底座+双格屏幕）',
  tvLounge:        '客厅沙发+茶几+电视',
  diningTable:     '四人餐桌',
  kitchenRun:      '厨房台面（冰箱+水槽）',
  desk:            '书桌（桌+椅+灯）',
  wetCorner:       '双格洗手台',
  bookWall:        '沿墙书架',
  closet:          '衣柜组',
  operatingTable:  '手术台（桌+椅+灯）',
  labBench:        '化验台',
  morgueDrawers:   '停尸冷柜',
  receptionDesk:   '接待桌',
  waitingRow:      '面对面候诊沙发',
};

/**
 * 拾取物。和家具一样按名字取，坐标由关卡决定。
 * kind 字符串与 pickups.js 的 KIND 对齐，本文件不引用 three，逻辑测试才能继续纯跑。
 */
export const ITEMS = {
  medkit:     { kind: 'medkit', label: '医疗包' },
  ammo:       { kind: 'ammo',   label: '弹药', amount: 30 },
  pistol:     { kind: 'weapon', weapon: 'pistol',     label: 'M19 消音' },
  pistolFast: { kind: 'weapon', weapon: 'pistolFast', label: 'M19C 快射' },
  smg:        { kind: 'weapon', weapon: 'smg',        label: 'MP7 冲锋枪' },
  shotgun:    { kind: 'weapon', weapon: 'shotgun',    label: 'M870 霰弹枪' },
  ar:         { kind: 'weapon', weapon: 'ar',         label: 'AR-15 突击步枪' },
  dmr:        { kind: 'weapon', weapon: 'dmr',        label: 'DMR 精准步枪' },
};

/** 全目录索引：关卡设计时对着这份点名即可 */
export const CATALOG = {
  pieces: Object.keys(PIECES),
  sets:   Object.keys(SETS),
  items:  Object.keys(ITEMS),
};

/**
 * 在格子上生成一件拾取物描述（还没放进场景）。
 * y 默认 1.4 = 地面层 + 0.4，和现有医疗包/武器悬浮高度一致。
 */
export function itemAt(id, x, z, y = 1.4) {
  const spec = ITEMS[id];
  if (!spec) {
    throw new Error(`物品目录里没有「${id}」。可调取: ${CATALOG.items.join(', ')}`);
  }
  return { id, ...spec, x, y, z };
}

/**
 * 把物品清单交给 PickupManager。关卡和 main 都走这里，不要再手写 kind 分支。
 * manager.add(kind, pos, payload) 即可，不依赖 three 的具体类。
 */
export function placeItems(manager, list) {
  for (const it of list) {
    if (it.kind === 'weapon') manager.add('weapon', it, { weapon: it.weapon });
    else if (it.kind === 'medkit') manager.add('medkit', it, {});
    else if (it.kind === 'ammo') manager.add('ammo', it, { amount: it.amount ?? 30 });
    else throw new Error(`未知物品 kind: ${it.kind}`);
  }
}

/**
 * 门口 / 出生点清障白名单。必须显式枚举，不能用 `id >= BLOCK.SOFA`：
 * 建筑材质（CONCRETE / CEILING / WALL_IN / ROOF）的 ID 也在沙发之后，
 * 区间判断会把内墙一起拆掉。
 */
export const CLEARABLE = new Set(Object.values(PIECES));

const BACK_OFF = {
  east:  [-1,  0],
  west:  [ 1,  0],
  north: [ 0,  1],
  south: [ 0, -1],
};

/** F.place 允许点名的全部方法：命名组合件 + 单件 + 原位方法 */
const PLACEABLE = new Set([
  ...Object.keys(SETS),
  'sofa', 'picture', 'shelf', 'crate', 'lamp', 'plant', 'chair', 'tv',
  'sink', 'table', 'cabinet', 'wardrobe', 'counter', 'bookshelf', 'bed',
]);

/**
 * 打开一套家具工具。w 是体素世界，y 是地面层（家具写在这一层）。
 *
 *   import { kit } from './furniture.js';
 *   const F = kit(w, 1);
 *   F.doubleBed(9, 10, 'east');
 *   F.tvLounge(10, 41, { sofaLen: 5, facing: 'east' });
 */
export function kit(w, y) {
  const F = {
    /** 单块。只写空气或地毯，绝不长进墙里、也不盖掉掩体。 */
    put(x, z, id) {
      const cur = w.get(x, y, z);
      if (cur === BLOCK.AIR || cur === BLOCK.CARPET) w.set(x, y, z, id);
    },

    row(x, z, len, id, axis = 'x') {
      for (let i = 0; i < len; i++) {
        this.put(axis === 'x' ? x + i : x, axis === 'x' ? z : z + i, id);
      }
    },

    rect(x0, z0, x1, z1, id) {
      for (let z = z0; z <= z1; z++)
        for (let x = x0; x <= x1; x++) this.put(x, z, id);
    },

    carpet(x0, z0, x1, z1) {
      this.rect(x0, z0, x1, z1, BLOCK.CARPET);
    },

    /**
     * 沙发：座位 + 靠背。facing 是人坐着看的方向（靠背在反侧）。
     * 靠背格如果已经是墙，put 会跳过，不会把墙换成靠背。
     */
    sofa(x, z, len, facing) {
      const horiz = facing === 'north' || facing === 'south';
      const [bx, bz] = BACK_OFF[facing] ?? BACK_OFF.east;
      for (let i = 0; i < len; i++) {
        const sx = horiz ? x + i : x;
        const sz = horiz ? z : z + i;
        this.put(sx, sz, BLOCK.SOFA);
        this.put(sx + bx, sz + bz, BLOCK.SOFA_BACK);
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

    /** 2 格高货架。下层写不进则整件跳过，避免悬空上层。 */
    shelf(x, z) {
      if (w.get(x, y, z) !== BLOCK.AIR) return;
      w.set(x, y, z, BLOCK.SHELF);
      if (w.get(x, y + 1, z) === BLOCK.AIR) w.set(x, y + 1, z, BLOCK.SHELF);
    },

    crate(x, z) { this.put(x, z, BLOCK.CRATE); },
    lamp(x, z) { this.put(x, z, BLOCK.LAMP); },

    /**
     * 应急灯（可击碎的闪烁灯）。挂在天花板下（y=3），不是地面家具，
     * 所以不走 put()（那个只写地面层、还会被门口清障拆掉）。
     *
     * 直接写网格：灯 solid:false 不挡路，玩家能打碎它换回黑暗。
     * 由 systems/lights.js 扫网格自动接管，关卡这里只负责「摆在哪」。
     */
    ceilingLamp(x, z, y = 3) {
      if (w.get(x, y, z) !== BLOCK.AIR) return;
      w.set(x, y, z, BLOCK.FLICKER_LAMP);
    },

    /** 一批应急灯：ceilingLamps([[x,z], ...]) */
    ceilingLamps(points, y = 3) {
      for (const [x, z] of points) this.ceilingLamp(x, z, y);
    },
    plant(x, z) { this.put(x, z, BLOCK.PLANT); },
    chair(x, z) { this.put(x, z, BLOCK.CHAIR); },
    tv(x, z) { this.put(x, z, BLOCK.TV); },
    sink(x, z) { this.put(x, z, BLOCK.SINK); },
    table(x, z) { this.put(x, z, BLOCK.TABLE); },
    cabinet(x, z) { this.put(x, z, BLOCK.CABINET); },
    wardrobe(x, z) { this.put(x, z, BLOCK.WARDROBE); },
    counter(x, z) { this.put(x, z, BLOCK.COUNTER); },
    bookshelf(x, z) { this.put(x, z, BLOCK.BOOKSHELF); },
    bed(x, z) { this.put(x, z, BLOCK.BED); },

    /** 一批箱子：crates([[x,z], ...]) */
    crates(points) {
      for (const [x, z] of points) this.put(x, z, BLOCK.CRATE);
    },

    /** 一批 2 格高货架：shelves([[x,z], ...]) */
    shelves(points) {
      for (const [x, z] of points) this.shelf(x, z);
    },

    /**
     * 按名字放家具，这是地图设计的统一入口。
     * F.place('doubleBed', 9, 10);
     * F.place('diningTable', 46, 42);
     * F.place('lamp', 26, 46);
     */
    place(name, x, z, ...args) {
      const fn = this[name];
      if (typeof fn !== 'function' || !PLACEABLE.has(name)) {
        throw new Error(`家具目录里没有「${name}」。可调取: ${[...PLACEABLE].join(', ')}`);
      }
      return fn.call(this, x, z, ...args);
    },

    // ── 命名组合件。新地图优先调这些，坐标是「这组家具的锚点」。──

    /** 双人床：2×3 床垫 + 床头柜 + 床头灯。床沿 x 向东铺。 */
    doubleBed(x, z, { lampSide = 'south' } = {}) {
      this.rect(x, z, x + 1, z + 2, BLOCK.BED);
      this.put(x + 2, z, BLOCK.CABINET);
      this.put(x + 2, lampSide === 'south' ? z + 2 : z, BLOCK.LAMP);
    },

    /** 诊床 / 隔离床：2×3 床 + 一侧柜子。 */
    examBed(x, z, { lampAt = 'foot' } = {}) {
      this.rect(x, z, x + 1, z + 2, BLOCK.BED);
      this.put(x + 2, z, BLOCK.CABINET);
      if (lampAt === 'foot') this.put(x + 2, z + 2, BLOCK.LAMP);
    },

    /** 电视柜：两格屏幕 + 一格底座，沿 z 立着。 */
    tvStand(x, z) {
      this.put(x, z, BLOCK.CABINET);
      this.put(x, z + 1, BLOCK.TV);
      this.put(x, z + 2, BLOCK.TV);
    },

    /**
     * 客厅：沙发朝电视。anchor 是沙发座位起点。
     * facing = 人坐着看的方向。
     */
    tvLounge(x, z, { sofaLen = 5, facing = 'east' } = {}) {
      this.sofa(x, z, sofaLen, facing);
      const mid = Math.floor(sofaLen / 2);
      if (facing === 'east') {
        this.rect(x + 4, z + 1, x + 5, z + 2, BLOCK.TABLE);
        this.tvStand(x + 10, z);
      } else if (facing === 'west') {
        this.rect(x - 5, z + 1, x - 4, z + 2, BLOCK.TABLE);
        this.tvStand(x - 10, z);
      } else if (facing === 'south') {
        this.rect(x + 1, z + 4, x + 2, z + 5, BLOCK.TABLE);
      } else {
        this.rect(x + 1, z - 5, x + 2, z - 4, BLOCK.TABLE);
      }
      void mid;
    },

    /** 餐桌：2×2 桌面，四边各一把椅子。 */
    diningTable(x, z) {
      this.rect(x, z, x + 1, z + 1, BLOCK.TABLE);
      this.put(x - 1, z, BLOCK.CHAIR);
      this.put(x - 1, z + 1, BLOCK.CHAIR);
      this.put(x + 2, z, BLOCK.CHAIR);
      this.put(x + 2, z + 1, BLOCK.CHAIR);
    },

    /** 厨房台面：沿墙一排 COUNTER，一端冰箱，一端水槽。 */
    kitchenRun(x, z, len, axis = 'z', { fridgeAt = 'start', sinkAt = 'end' } = {}) {
      this.row(x, z, len, BLOCK.COUNTER, axis);
      const endX = axis === 'x' ? x + len - 1 : x;
      const endZ = axis === 'z' ? z + len - 1 : z;
      if (fridgeAt === 'start') this.put(axis === 'x' ? x : x - 1, axis === 'z' ? z : z, BLOCK.CABINET);
      if (sinkAt === 'end') this.put(endX, endZ, BLOCK.SINK);
    },

    /** 书桌：两格桌 + 椅子 + 台灯。椅子在桌的 +z 侧。 */
    desk(x, z) {
      this.rect(x, z, x + 1, z, BLOCK.TABLE);
      this.put(x, z + 1, BLOCK.CHAIR);
      this.put(x + 2, z, BLOCK.LAMP);
    },

    /** 双格洗手台 / 马桶组。 */
    wetCorner(x, z, axis = 'z') {
      this.row(x, z, 2, BLOCK.SINK, axis);
    },

    /** 沿墙一排书架或档案柜。 */
    bookWall(x, z, len, axis = 'z', id = BLOCK.BOOKSHELF) {
      this.row(x, z, len, id, axis);
    },

    /** 衣柜组。 */
    closet(x, z, len = 2, axis = 'x') {
      this.row(x, z, len, BLOCK.WARDROBE, axis);
    },

    /**
     * 手术台。锚点是桌面西北角。
     * 默认 4×3 桌，椅子在北（z-1），灯在南（z+3）。
     */
    operatingTable(x, z, { w = 3, d = 2 } = {}) {
      this.rect(x, z, x + w, z + d, BLOCK.TABLE);
      this.put(x, z - 1, BLOCK.CHAIR);
      this.put(x + w, z - 1, BLOCK.CHAIR);
      this.put(x, z + d + 1, BLOCK.LAMP);
      this.put(x + w, z + d + 1, BLOCK.LAMP);
    },

    /** 化验台：沿墙 COUNTER，一端柜子一端水槽。 */
    labBench(x, z, len, axis = 'z') {
      this.row(x, z, len, BLOCK.COUNTER, axis);
      this.put(axis === 'x' ? x + 1 : x + 1, axis === 'z' ? z : z, BLOCK.CABINET);
      const endX = axis === 'x' ? x + len - 1 : x;
      const endZ = axis === 'z' ? z + len - 1 : z;
      this.put(axis === 'x' ? endX : endX + 1, axis === 'z' ? endZ : endZ, BLOCK.SINK);
    },

    /** 停尸冷柜：沿墙一排满高柜子。 */
    morgueDrawers(x, z, len, axis = 'z') {
      this.row(x, z, len, BLOCK.CABINET, axis);
    },

    /** 接待桌：2×2 桌 + 内侧椅子 + 台灯。 */
    receptionDesk(x, z) {
      this.rect(x, z, x + 2, z + 1, BLOCK.TABLE);
      this.put(x, z + 2, BLOCK.CHAIR);
      this.put(x + 3, z, BLOCK.LAMP);
    },

    /** 面对面两排候诊沙发。xW 西排座位，xE 东排座位。 */
    waitingRow(xW, xE, z, len) {
      this.sofa(xW, z, len, 'east');
      this.sofa(xE, z, len, 'west');
    },
  };

  return F;
}

/**
 * 门口及其两侧各 2 格清掉家具 / 掩体（GDD 规则 1：留出切角空间）。
 * 绝不动墙体、地板与天花板。门框标记清掉后立刻写回。
 */
export function clearDoorways(w, doors, doorH = 2) {
  for (const d of doors) {
    const spanX = 2 + (d.through === 'x' ? d.thick : 0);
    const spanZ = 2 + (d.through === 'z' ? d.thick : 0);
    for (let y = d.y; y < d.y + doorH; y++) {
      for (let dx = -2; dx <= spanX; dx++) {
        for (let dz = -2; dz <= spanZ; dz++) {
          const id = w.get(d.x + dx, y, d.z + dz);
          if (CLEARABLE.has(id)) w.set(d.x + dx, y, d.z + dz, BLOCK.AIR);
        }
      }
    }
  }
  for (const d of doors) {
    if (w.get(d.x, d.y, d.z) === BLOCK.AIR) w.set(d.x, d.y, d.z, BLOCK.DOORFRAME);
  }
}

/** 出生点周围 2 格净空，避免开局卡在家具里 */
export function clearSpawn(w, spawn, y0 = 1) {
  const sx = Math.floor(spawn.x), sz = Math.floor(spawn.z);
  for (let y = y0; y < y0 + 3; y++) {
    for (let dx = -2; dx <= 2; dx++) {
      for (let dz = -2; dz <= 2; dz++) {
        const id = w.get(sx + dx, y, sz + dz);
        if (CLEARABLE.has(id)) w.set(sx + dx, y, sz + dz, BLOCK.AIR);
      }
    }
  }
}

/**
 * 关卡 01「黑楼」家具布局。房间坐标与 level01.js 的 ROOMS 一致。
 * 布局本身属于关卡，但件全部来自 kit()。
 */
export function furnishLevel01(w, y) {
  const F = kit(w, y);

  // ══ 门厅（南侧，正对主入口）══════════════════════════════════════════
  F.cabinet(26, 39);
  F.cabinet(38, 39);
  F.picture(26, 38);
  F.picture(38, 38);
  F.carpet(29, 43, 35, 46);
  F.rect(27, 44, 28, 44, PIECES.table);
  F.chair(27, 43);
  F.lamp(26, 46);
  F.plant(38, 45);
  F.crate(36, 39);

  // ══ 客厅（西南）══════════════════════════════════════════════════════
  F.carpet(10, 40, 20, 45);
  F.sofa(10, 41, 5, 'east');
  F.table(14, 42);
  F.table(14, 43);
  F.table(15, 42);
  F.tvStand(20, 41);
  F.lamp(9, 46);
  F.crate(11, 45);
  F.bookWall(17, 46, 2, 'x');
  F.picture(9, 39);

  // ══ 厨房 / 餐厅（东南）══════════════════════════════════════════════
  F.row(55, 40, 5, PIECES.counter, 'z');
  F.cabinet(54, 40);
  F.sink(55, 45);
  F.diningTable(46, 42);
  F.plant(46, 46);
  F.lamp(51, 40);
  F.carpet(45, 45, 50, 46);
  F.picture(43, 45);

  // ══ 仓库（北侧大空间）════════════════════════════════════════════════
  F.cabinet(22, 18);
  F.cabinet(22, 19);
  F.cabinet(43, 23);
  F.row(36, 17, 2, PIECES.counter, 'x');
  F.lamp(35, 17);
  F.plant(28, 24);
  F.bookshelf(42, 18);
  F.crate(24, 18);
  F.crate(25, 18);
  F.crate(24, 19);
  F.crate(39, 22);
  F.table(40, 22);

  // ══ 卧室（西北）══════════════════════════════════════════════════════
  F.carpet(9, 9, 17, 14);
  F.doubleBed(9, 10);
  F.closet(17, 9, 2, 'z');
  F.chair(16, 14);
  F.tv(13, 9);
  F.picture(9, 14);

  // ══ 书房 / 卫浴（东北）══════════════════════════════════════════════
  F.wetCorner(47, 9, 'z');
  F.bookWall(55, 9, 3, 'z');
  F.desk(52, 13);
  F.carpet(50, 12, 54, 14);
  F.picture(48, 14);

  // ══ 北走道 ══════════════════════════════════════════════════════════
  F.plant(23, 9);
  F.plant(42, 9);
  F.lamp(24, 13);
  F.crate(26, 9);
  F.table(38, 13);

  // ══ 储藏间（仓库两侧）══════════════════════════════════════════════
  F.closet(8, 17, 2, 'x');
  F.cabinet(19, 24);
  F.lamp(8, 24);
  F.closet(54, 17, 2, 'x');
  F.cabinet(46, 24);
  F.lamp(55, 24);

  // ══ 走廊 / 南侧过道 / 庭院 ══════════════════════════════════════════
  F.plant(9, 27);
  F.plant(54, 30);
  F.picture(10, 27);
  F.picture(52, 30);
  F.lamp(21, 30);
  F.lamp(36, 27);
  F.plant(9, 33);
  F.plant(54, 35);
  F.lamp(16, 35);
  F.lamp(50, 33);
  F.plant(30, 52);
  F.plant(34, 52);
  F.chair(26, 56);
  F.table(27, 56);
  F.plant(38, 55);
  F.crate(29, 55);
  F.crate(36, 54);

  // ══ 掩体 ════════════════════════════════════════════════════════════
  // 仓库：错位货箱，形成可接近的长视线
  F.crates([
    [25, 19], [26, 19], [25, 20], [37, 21], [38, 21], [30, 23], [31, 23], [41, 18],
    [27, 10], [28, 10], [38, 12],                    // 北走道
    [18, 28], [33, 29], [46, 28],                    // 主走廊
    [20, 34], [43, 34],                              // 南侧过道
    [27, 41], [37, 42], [10, 44], [52, 44],          // 门厅 / 客厅 / 厨房
    [12, 19], [17, 22], [48, 19], [53, 22],          // 储藏间
    [28, 54], [29, 54], [36, 56], [24, 58], [40, 52],// 庭院教学区
  ]);
  // 2 格高货架（齐胸掩体，透光形成条纹阴影）
  F.shelves([
    [29, 17], [29, 18], [34, 17], [34, 18],
    [39, 23], [39, 24], [23, 21], [23, 22],
    [15, 29], [42, 29],
  ]);

  /**
   * ── 应急灯（可击碎的闪烁灯）──
   *
   * 只装在「个别房间」，不是每间都有 —— 全屋有灯的话黑暗就不再是主题，
   * 手电也失去战术地位。挑的是主动线上的大空间（门厅、仓库、走廊中段），
   * 玩家推进时必然经过，所以「借这盏灯省下手电，还是打碎它保持安静」
   * 是一个真的会被反复遇到的决策。
   */
  F.ceilingLamps([
    [32, 42],          // 门厅（进门第一间）
    [31, 20], [37, 22],// 仓库（最大房间，两盏）
    [20, 28], [44, 29],// 主走廊东西两段
    [14, 11],          // 卧室
    [50, 42],          // 厨房
  ]);
}

/**
 * 关卡 02「废弃诊所」家具布局。房间坐标与 level02.js 的 ROOMS 一致。
 */
export function furnishLevel02(w, y) {
  const F = kit(w, y);

  // ══ 候诊室 ════════════════════════════════════════════════════════
  F.carpet(27, 10, 36, 15);
  F.waitingRow(26, 36, 10, 4);
  F.rect(28, 11, 29, 12, PIECES.table);
  F.plant(27, 15);
  F.plant(36, 15);
  F.lamp(26, 8);
  F.picture(28, 8);

  // ══ 值班休息（西北）════════════════════════════════════════════════
  F.carpet(9, 9, 16, 14);
  F.doubleBed(9, 10);
  F.closet(21, 9, 2, 'x');
  F.wardrobe(21, 10);
  F.sofa(9, 16, 2, 'south');
  F.tv(18, 8);
  F.plant(22, 16);
  F.picture(8, 12);

  // ══ 诊室 A / B ════════════════════════════════════════════════════
  F.carpet(41, 9, 46, 14);
  F.examBed(41, 10);
  F.wetCorner(47, 9, 'z');
  F.chair(40, 16);
  F.table(41, 16);
  F.picture(40, 9);

  F.carpet(51, 9, 54, 14);
  F.examBed(51, 10);
  F.sink(55, 9);
  F.plant(55, 16);
  F.chair(50, 8);
  F.picture(55, 14);

  // ══ 档案 / 接待 ════════════════════════════════════════════════════
  F.bookWall(8, 19, 5, 'z');
  F.bookshelf(9, 19);
  F.cabinet(9, 20);
  F.receptionDesk(12, 20);
  F.plant(8, 24);
  F.cabinet(22, 19);
  F.picture(16, 19);

  // ══ 隔离病房 ══════════════════════════════════════════════════════
  F.carpet(9, 28, 16, 32);
  F.examBed(8, 28);
  F.rect(8, 31, 9, 32, PIECES.bed);
  F.wetCorner(22, 27, 'x');
  F.closet(22, 33, 2, 'x');
  F.plant(16, 27);
  F.table(18, 30);
  F.chair(19, 30);
  F.picture(8, 33);

  // ══ 化验室 ════════════════════════════════════════════════════════
  F.row(8, 36, 8, PIECES.counter, 'z');
  F.cabinet(9, 36);
  F.wetCorner(9, 46, 'x');
  F.diningTable(16, 39);
  F.chair(16, 42);
  F.lamp(19, 41);
  F.plant(23, 46);
  F.bookWall(20, 44, 2, 'x');
  F.picture(23, 38);

  // ══ 手术室 ════════════════════════════════════════════════════════
  F.carpet(28, 39, 35, 44);
  F.operatingTable(29, 40, { w: 3, d: 2 });
  F.row(26, 36, 4, PIECES.cabinet, 'x');
  F.wetCorner(26, 46, 'x');
  F.plant(37, 46);
  F.picture(37, 38);

  // ══ 停尸房 ════════════════════════════════════════════════════════
  F.rect(40, 37, 41, 39, PIECES.bed);
  F.rect(40, 43, 41, 45, PIECES.bed);
  F.morgueDrawers(47, 36, 9, 'z');
  F.lamp(43, 46);
  F.sink(40, 46);
  F.table(46, 37);
  F.picture(40, 36);

  // ══ 值夜室 ════════════════════════════════════════════════════════
  F.carpet(51, 38, 54, 44);
  F.sofa(54, 38, 3, 'west');
  F.table(53, 39);
  F.chair(53, 40);
  F.tv(50, 36);
  F.bed(50, 46);
  F.cabinet(51, 46);
  F.lamp(54, 36);
  F.plant(55, 46);
  F.picture(55, 38);

  // ══ 庭院 ══════════════════════════════════════════════════════════
  F.plant(28, 21);
  F.plant(28, 32);
  F.plant(38, 20);
  F.plant(38, 32);
  F.plant(46, 26);
  F.table(34, 26);
  F.chair(35, 26);
  F.chair(33, 26);
  F.crate(50, 22);
  F.crate(54, 28);

  // ══ 掩体 ════════════════════════════════════════════════════════════
  F.crates([
    [48, 24], [49, 24], [40, 28], [41, 29], [32, 22],
    [36, 31], [52, 30], [44, 21],                    // 庭院教学区
    [10, 29], [18, 32], [20, 28],                    // 隔离病房（高潮）
    [10, 38], [18, 44], [12, 42],                    // 化验
    [28, 38], [34, 44],                              // 手术
    [10, 21], [11, 23],                              // 档案西侧
    [28, 10], [34, 14],                              // 候诊
    [10, 10], [18, 14],                              // 休息
    [42, 38], [54, 44],                              // 停尸 / 值夜
  ]);
  F.shelves([
    [9, 20], [9, 21], [9, 22],                       // 档案西墙
    [9, 37], [9, 38], [9, 39],                       // 化验西墙
    [20, 37], [20, 38],
    [27, 36], [36, 36],                              // 手术北墙
    [41, 36], [46, 36],                              // 停尸
  ]);

  /**
   * 应急灯：诊所是「还通着电」的建筑，手术室与候诊厅本来就该亮着。
   * 装在主动线（接待 → 候诊 → 手术）与高潮房间（隔离），
   * 其余房间保持全黑，黑暗仍然是默认状态。
   */
  F.ceilingLamps([
    [14, 21],          // 档案接待（主入口第一间）
    [31, 12],          // 候诊厅
    [31, 41],          // 手术室
    [18, 30],          // 隔离病房（高潮区域）——避开 x=13,14 的墙垛
    [43, 41],          // 停尸房
  ]);
}

/**
 * 关卡 03「废弃电台」家具布局。房间坐标与 level03.js 的 ROOMS 一致。
 * 十字四翼九间房 + 中庭，每件都离门口 2 格以上，clearDoorways 不用动它们。
 */
export function furnishLevel03(w, y) {
  const F = kit(w, y);

  // ══ 导播室（北翼西，x=22..31 z=8..16）════════════════════════════════
  F.carpet(24, 9, 30, 15);
  F.row(24, 9, 3, PIECES.counter, 'x');   // 控制台
  F.chair(25, 10);
  F.tv(29, 9);
  F.lamp(24, 15);
  F.plant(30, 15);
  F.picture(24, 8);
  F.bookshelf(30, 10);
  F.bookshelf(30, 11);

  // ══ 演播厅（北翼东，x=34..43 z=8..16）════════════════════════════════
  F.carpet(35, 10, 39, 14);
  F.sofa(35, 11, 3, 'east');
  F.rect(36, 13, 37, 13, PIECES.table);
  F.tvStand(41, 11);
  F.lamp(42, 15);
  F.plant(35, 15);
  F.picture(38, 8);

  // ══ 宿舍（西脊北，x=8..19 z=19..24）══════════════════════════════════
  F.carpet(9, 20, 18, 24);
  F.doubleBed(9, 20);
  F.doubleBed(9, 22, { lampSide: 'south' });
  F.closet(17, 20, 2, 'x');
  F.lamp(9, 23);
  F.plant(18, 23);

  // ══ 食堂（西脊南，x=8..19 z=27..33）══════════════════════════════════
  F.diningTable(11, 28);
  F.diningTable(11, 31);
  F.row(9, 32, 2, PIECES.counter, 'x');
  F.sink(11, 32);
  F.cabinet(9, 27);
  F.plant(18, 32);
  F.picture(8, 30);

  // ══ 发射机房（东脊北，x=46..55 z=19..24）════════════════════════════
  F.bookWall(46, 20, 3, 'z', PIECES.shelf);
  F.shelves([[47, 20], [47, 21], [47, 22]]);
  F.crates([[53, 21], [54, 21], [53, 23]]);
  F.lamp(54, 23);
  F.picture(46, 19);

  // ══ 器材库（东脊南，x=46..55 z=27..33）══════════════════════════════
  F.bookWall(46, 28, 3, 'z', PIECES.shelf);
  F.shelves([[47, 28], [47, 29], [47, 30]]);
  F.crates([[53, 29], [54, 29], [53, 31]]);
  F.plant(54, 32);
  F.picture(46, 32);

  // ══ 发电机房（南翼西，x=22..31 z=36..46）════════════════════════════
  F.crates([[24, 37], [25, 37], [29, 40], [30, 40]]);
  F.shelves([[24, 44], [25, 44]]);
  F.lamp(30, 44);
  F.picture(22, 40);

  // ══ 主机房（南翼东，x=34..43 z=36..46）══════════════════════════════
  F.row(36, 37, 4, PIECES.counter, 'x');   // 服务器台面
  F.chair(37, 38);
  F.chair(38, 38);
  F.bookshelf(42, 41);
  F.bookshelf(42, 42);
  F.plant(35, 44);
  F.lamp(42, 44);

  // ══ 中庭（十字交叉，x=22..43 z=19..33）══════════════════════════════
  // 四角盆栽 + 中央一件木箱，都离四道错位墙垛至少 2 格，不挡通道。
  F.plant(24, 21);
  F.plant(41, 21);
  F.plant(24, 31);
  F.plant(41, 31);
  F.crate(32, 26);

  // ══ 北侧庭院（出生点附近教学掩体）════════════════════════════════════
  F.crates([[27, 54], [37, 56], [24, 58]]);
  F.plant(23, 61);

  /**
   * 应急灯：电台还在供电（发电机房就在南翼），所以中庭与导播是亮的。
   * 中庭三盏是刻意的 —— 那是十字路口、也是冲锋手的主场，
   * 灯让玩家看得见冲过来的人，但也让玩家自己更容易被四翼的枪看见。
   * 想安静穿过中庭就得先把灯打掉，这正是这一关的核心决策。
   */
  F.ceilingLamps([
    [27, 22], [32, 26], [38, 30],   // 中庭三盏（十字路口）
    [26, 12],                       // 导播室
    [38, 12],                       // 演播厅
    [14, 30],                       // 食堂
    [50, 22],                       // 发射机房
    [38, 41],                       // 主机房
  ]);
}
