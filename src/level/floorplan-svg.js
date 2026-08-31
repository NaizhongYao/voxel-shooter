import { BLOCK } from '../voxel/blocks.js';

/**
 * 平面图共享渲染器。一份 SVG 渲染逻辑，三处用：
 *   1. tools/make-floorplan.mjs（导出 floorplan.html，浅色）
 *   2. tools/make-floorplan02.mjs（同上，第二关）
 *   3. 任务简报「地图」页 + 任务选择屏缩略图（深色）
 *
 * 建筑几何读体素网格；家具读关卡返回的 placement 元数据。
 */

const CELL = 11;

export const LEGEND = {
  [BLOCK.SOFA]:      { s: '▬', c: '#7a6a85', n: '沙发' },
  [BLOCK.SOFA_BACK]: { s: '▬', c: '#5f5270', n: '沙发靠背' },
  [BLOCK.TABLE]:     { s: '▢', c: '#8a6a4a', n: '桌子' },
  [BLOCK.TV]:        { s: '▣', c: '#2a3038', n: '电视' },
  [BLOCK.BED]:       { s: '▤', c: '#6a7488', n: '床' },
  [BLOCK.CABINET]:   { s: '▥', c: '#7a6244', n: '柜子/冰箱' },
  [BLOCK.CARPET]:    { s: '', c: '#3a2c38', n: '地毯' },
  [BLOCK.LAMP]:      { s: '☀', c: '#d8a860', n: '台灯' },
  // 可击碎的闪烁应急灯：真光源、会提高敌人探测倍率，打碎后变残骸。
  [BLOCK.FLICKER_LAMP]: { s: '⚡', c: '#bfd4e8', n: '闪烁应急灯' },
  [BLOCK.LAMP_BROKEN]:  { s: '×', c: '#3a3f46', n: '应急灯残骸' },
  [BLOCK.PLANT]:     { s: '❋', c: '#4a7a55', n: '盆栽' },
  [BLOCK.COUNTER]:   { s: '▭', c: '#7d838a', n: '台面' },
  [BLOCK.CHAIR]:     { s: '▪', c: '#8a6a4a', n: '椅子' },
  [BLOCK.WARDROBE]:  { s: '▦', c: '#584438', n: '衣柜' },
  [BLOCK.PICTURE]:   { s: '▬', c: '#8a7052', n: '挂画' },
  [BLOCK.SINK]:      { s: '◯', c: '#9ba4b0', n: '洗手台' },
  [BLOCK.BOOKSHELF]: { s: '▨', c: '#584438', n: '书架' },
  [BLOCK.CRATE]:     { s: '▪', c: '#5a6474', n: '木箱' },
  [BLOCK.SHELF]:     { s: '▨', c: '#5a6474', n: '货架' },
};

// 新家具覆盖层使用稳定的字符串 ID；旧 World 仍可能给出 BLOCK 数字 ID。
const LEGEND_BLOCK_BY_FURNITURE_ID = {
  sofa: BLOCK.SOFA,
  sofaBack: BLOCK.SOFA_BACK,
  table: BLOCK.TABLE,
  tv: BLOCK.TV,
  bed: BLOCK.BED,
  cabinet: BLOCK.CABINET,
  carpet: BLOCK.CARPET,
  lamp: BLOCK.LAMP,
  plant: BLOCK.PLANT,
  counter: BLOCK.COUNTER,
  chair: BLOCK.CHAIR,
  wardrobe: BLOCK.WARDROBE,
  picture: BLOCK.PICTURE,
  sink: BLOCK.SINK,
  bookshelf: BLOCK.BOOKSHELF,
  crate: BLOCK.CRATE,
  shelf: BLOCK.SHELF,
  flickerLamp: BLOCK.FLICKER_LAMP,
  lampBroken: BLOCK.LAMP_BROKEN,
};
const FURNITURE_ID_BY_BLOCK = new Map(
  Object.entries(LEGEND_BLOCK_BY_FURNITURE_ID).map(([id, block]) => [block, id])
);
const EMERGENCY_LAMP_IDS = new Set(['flickerLamp', 'lampBroken']);
const LAMP_IDS = new Set(['lamp', ...EMERGENCY_LAMP_IDS]);

const WALLS = new Set([BLOCK.WALL, BLOCK.WALL_IN]);
const STAIRS = new Set([BLOCK.STAIR_LO, BLOCK.STAIR_HI]);

/** 浅色（导出用）与深色（简报 UI 用）两套配色 */
const THEMES = {
  light: {
    svgBg: '#f6f7f9', grass: '#c5d4b8', carpet: '#3a2c38',
    wall: '#c8ccd4', wallIn: '#9aa2ae', stair: '#4a5260', stairLine: '#aab2c0',
    roomText: '#2f3742', roomOpacity: .55, doorFill: '#2fbf5f', doorText: '#06280f',
    spawnFill: '#f5a623', spawnText: '#1a1206', textFill: '#fff', textOpacity: .85,
  },
  dark: {
    svgBg: '#0a0e14', grass: '#1c2419', carpet: '#2b2130',
    wall: '#2c3441', wallIn: '#3a4452', stair: '#3d4552', stairLine: '#616c7a',
    roomText: '#8b93a3', roomOpacity: .5, doorFill: '#2fbf5f', doorText: '#06280f',
    spawnFill: '#f5a623', spawnText: '#1a1206', textFill: '#c5ccd6', textOpacity: .9,
  },
};

/** 找出该层的内容边界（含 y=0 的草地，让庭院开口也画出来） */
function bounds(w, y) {
  let x0 = 999, x1 = -1, z0 = 999, z1 = -1;
  const mark = (x, z) => {
    if (x < x0) x0 = x; if (x > x1) x1 = x;
    if (z < z0) z0 = z; if (z > z1) z1 = z;
  };
  for (let z = 0; z < w.sz; z++)
    for (let x = 0; x < w.sx; x++) {
      if (w.get(x, y, z) !== BLOCK.AIR) mark(x, z);
      if (w.get(x, 0, z) !== BLOCK.AIR) mark(x, z);
    }
  return { x0: Math.max(0, x0 - 1), x1: Math.min(w.sx - 1, x1 + 1),
           z0: Math.max(0, z0 - 1), z1: Math.min(w.sz - 1, z1 + 1) };
}

function legendForId(id) {
  return LEGEND[typeof id === 'string' ? LEGEND_BLOCK_BY_FURNITURE_ID[id] : id];
}

export function legendItems(used) {
  const seen = new Set();
  const out = [];
  for (const entry of used ?? []) {
    const id = used instanceof Map ? entry[0] : entry;
    const L = legendForId(id);
    if (!L || seen.has(L.n)) continue;
    seen.add(L.n);
    out.push({ n: L.n, c: L.c });
  }
  return out;
}

function placementId(item) {
  const baseId = typeof item.id === 'string' ? item.id : FURNITURE_ID_BY_BLOCK.get(item.id);
  const state = item.lampState ?? item.state;
  if (LAMP_IDS.has(baseId) && (state === 'broken' || item.broken === true)) return 'lampBroken';
  if (LAMP_IDS.has(baseId) && (state === 'flickerLamp' || state === 'flicker')) return 'flickerLamp';
  if (LAMP_IDS.has(baseId) && state === 'lamp') return 'lamp';
  return baseId;
}

function placementGridBounds(item) {
  const width = item.boundsW ?? item.w ?? 1;
  const depth = item.boundsD ?? item.d ?? 1;
  const x0 = Math.floor(item.x);
  const z0 = Math.floor(item.z);
  return {
    x0, z0,
    x1: Math.ceil(item.x + width) - 1,
    z1: Math.ceil(item.z + depth) - 1,
  };
}

function clippedGridBounds(item, b) {
  const aabb = placementGridBounds(item);
  const x0 = Math.max(b.x0, aabb.x0), x1 = Math.min(b.x1, aabb.x1);
  const z0 = Math.max(b.z0, aabb.z0), z1 = Math.min(b.z1, aabb.z1);
  return x0 <= x1 && z0 <= z1 ? { x0, x1, z0, z1 } : null;
}

function isFloorCarpet(item, y) {
  return placementId(item) === 'carpet' && Math.abs((item.y ?? y) - y) < 0.5;
}

/**
 * 渲染一层平面图。
 *
 * @param w      World
 * @param opts
 *   theme      'light' | 'dark'
 *   spawn      出生点 {x,z}，画出 S 圆点
 *   doors      门清单 [{x,z,y}]，画 D 标记
 *   roomLabels [{x0,z0,x1,z1,name}] 房间名字文本
 *   courtyardText  「东侧庭院」之类的地标文本 + 中心坐标
 */
export function renderFloorplanSvg(w, {
  theme = 'dark', spawn = null, doors = [], roomLabels = [], courtyardText = null,
} = {}) {
  const T = THEMES[theme] ?? THEMES.dark;
  const y = 1;
  const b = bounds(w, y);
  const W = (b.x1 - b.x0 + 1) * CELL;
  const H = (b.z1 - b.z0 + 1) * CELL;
  const parts = [];
  const used = new Map();

  // 草地（y=0 是草地、这层是空气 → 见天庭院/外圈）
  for (let z = b.z0; z <= b.z1; z++) {
    for (let x = b.x0; x <= b.x1; x++) {
      if (w.get(x, 0, z) !== BLOCK.GRASS) continue;
      if (w.get(x, y, z) !== BLOCK.AIR) continue;
      parts.push(`<rect x="${(x - b.x0) * CELL}" y="${(z - b.z0) * CELL}" width="${CELL}" height="${CELL}" fill="${T.grass}"/>`);
    }
  }

  const placements = Array.isArray(w.furniture?.placements) ? w.furniture.placements : null;

  // 地毯（当作背景）。正式关卡以 placement 为准；旧 World 才读体素。
  if (placements) {
    for (const item of placements) {
      if (!isFloorCarpet(item, y)) continue;
      const aabb = clippedGridBounds(item, b);
      if (!aabb) continue;
      const px = (aabb.x0 - b.x0) * CELL, pz = (aabb.z0 - b.z0) * CELL;
      parts.push(`<rect x="${px}" y="${pz}" width="${(aabb.x1 - aabb.x0 + 1) * CELL}" height="${(aabb.z1 - aabb.z0 + 1) * CELL}" fill="${T.carpet}"/>`);
      used.set('carpet', true);
    }
  } else {
    for (let z = b.z0; z <= b.z1; z++)
      for (let x = b.x0; x <= b.x1; x++) {
        if (w.get(x, y, z) !== BLOCK.CARPET) continue;
        parts.push(`<rect x="${(x - b.x0) * CELL}" y="${(z - b.z0) * CELL}" width="${CELL}" height="${CELL}" fill="${T.carpet}"/>`);
        used.set(BLOCK.CARPET, true);
      }
  }

  // 墙
  for (let z = b.z0; z <= b.z1; z++)
    for (let x = b.x0; x <= b.x1; x++) {
      const id = w.get(x, y, z);
      if (!WALLS.has(id)) continue;
      parts.push(`<rect x="${(x - b.x0) * CELL}" y="${(z - b.z0) * CELL}" width="${CELL}" height="${CELL}" fill="${id === BLOCK.WALL ? T.wall : T.wallIn}"/>`);
    }

  // 楼梯
  for (let z = b.z0; z <= b.z1; z++)
    for (let x = b.x0; x <= b.x1; x++) {
      if (!STAIRS.has(w.get(x, y, z))) continue;
      const px = (x - b.x0) * CELL, pz = (z - b.z0) * CELL;
      parts.push(`<rect x="${px}" y="${pz}" width="${CELL}" height="${CELL}" fill="${T.stair}"/>`);
      parts.push(`<line x1="${px}" y1="${pz + CELL / 2}" x2="${px + CELL}" y2="${pz + CELL / 2}" stroke="${T.stairLine}" stroke-width="1"/>`);
    }

  // 家具。每个 placement 只投影一次，所以 2 格高货架等多层记录不会重复。
  if (placements) {
    for (const item of placements) {
      const id = placementId(item);
      const L = legendForId(id);
      if (!L || id === 'carpet' || EMERGENCY_LAMP_IDS.has(id)) continue;
      const aabb = clippedGridBounds(item, b);
      if (!aabb) continue;
      used.set(id, true);
      const px = (aabb.x0 - b.x0) * CELL, pz = (aabb.z0 - b.z0) * CELL;
      const width = (aabb.x1 - aabb.x0 + 1) * CELL;
      const height = (aabb.z1 - aabb.z0 + 1) * CELL;
      parts.push(`<rect x="${px + 0.5}" y="${pz + 0.5}" width="${width - 1}" height="${height - 1}" fill="${L.c}" rx="1"/>`);
      if (L.s) {
        parts.push(`<text x="${px + width / 2}" y="${pz + height / 2 + 3}" font-size="8" fill="${T.textFill}" text-anchor="middle" opacity="${T.textOpacity}">${L.s}</text>`);
      }
    }
  } else {
    for (let z = b.z0; z <= b.z1; z++)
      for (let x = b.x0; x <= b.x1; x++) {
        const id = w.get(x, y, z);
        const L = LEGEND[id];
        if (!L || id === BLOCK.CARPET) continue;
        used.set(id, true);
        const px = (x - b.x0) * CELL, pz = (z - b.z0) * CELL;
        parts.push(`<rect x="${px + 0.5}" y="${pz + 0.5}" width="${CELL - 1}" height="${CELL - 1}" fill="${L.c}" rx="1"/>`);
        if (L.s) {
          parts.push(`<text x="${px + CELL / 2}" y="${pz + CELL / 2 + 3}" font-size="8" fill="${T.textFill}" text-anchor="middle" opacity="${T.textOpacity}">${L.s}</text>`);
        }
      }
  }

  /**
   * 天花板下的可击碎应急灯不在 y=1（挂在 y=3），所以不能混进上面的
   * 地面家具循环。正式关卡从 placement 取位置和状态，旧 World 才扫顶层。
   *
   * 普通战斗小地图不走这条渲染器（它只读 rooms），因此灯只会出现在
   * 开发者平面图 / 简报地图 / 任务选择缩略图，不会给战斗 HUD 添杂物。
   */
  if (placements) {
    for (const item of placements) {
      const id = placementId(item);
      if (!EMERGENCY_LAMP_IDS.has(id)) continue;
      const L = legendForId(id);
      const aabb = clippedGridBounds(item, b);
      if (!L || !aabb) continue;
      used.set(id, true);
      const px = (aabb.x0 - b.x0) * CELL, pz = (aabb.z0 - b.z0) * CELL;
      parts.push(`<rect x="${px + 1.5}" y="${pz + 1.5}" width="${CELL - 3}" height="${CELL - 3}" fill="${L.c}" rx="5.5"/>`);
      parts.push(`<text x="${px + CELL / 2}" y="${pz + CELL / 2 + 3}" font-size="8" fill="${T.textFill}" text-anchor="middle" opacity="${T.textOpacity}">${L.s}</text>`);
    }
  } else {
    for (let z = b.z0; z <= b.z1; z++)
      for (let x = b.x0; x <= b.x1; x++) {
        let id = BLOCK.AIR;
        for (let ly = 2; ly < w.sy; ly++) {
          const candidate = w.get(x, ly, z);
          if (candidate === BLOCK.FLICKER_LAMP || candidate === BLOCK.LAMP_BROKEN) {
            id = candidate;
            break;
          }
        }
        const L = LEGEND[id];
        if (!L) continue;
        used.set(id, true);
        const px = (x - b.x0) * CELL, pz = (z - b.z0) * CELL;
        parts.push(`<rect x="${px + 1.5}" y="${pz + 1.5}" width="${CELL - 3}" height="${CELL - 3}" fill="${L.c}" rx="5.5"/>`);
        parts.push(`<text x="${px + CELL / 2}" y="${pz + CELL / 2 + 3}" font-size="8" fill="${T.textFill}" text-anchor="middle" opacity="${T.textOpacity}">${L.s}</text>`);
      }
  }

  // 门
  for (const d of doors) {
    const px = (d.x - b.x0) * CELL, pz = (d.z - b.z0) * CELL;
    parts.push(`<rect x="${px}" y="${pz}" width="${CELL}" height="${CELL}" fill="${T.doorFill}"/>`);
    parts.push(`<text x="${px + CELL / 2}" y="${pz + CELL / 2 + 3}" font-size="8" fill="${T.doorText}" text-anchor="middle" font-weight="bold">D</text>`);
  }

  // 房间名
  for (const r of roomLabels) {
    const cx = ((r.x0 + r.x1) / 2 - b.x0 + 0.5) * CELL;
    const cz = ((r.z0 + r.z1) / 2 - b.z0 + 0.5) * CELL;
    parts.push(`<text x="${cx}" y="${cz}" font-size="11" fill="${T.roomText}" text-anchor="middle" opacity="${T.roomOpacity}" letter-spacing="1">${r.name}</text>`);
  }

  // 地标文本（如「东侧庭院」）
  if (courtyardText) {
    const cx = ((courtyardText.x0 + courtyardText.x1) / 2 - b.x0 + 0.5) * CELL;
    const cz = ((courtyardText.z0 + courtyardText.z1) / 2 - b.z0 + 0.5) * CELL;
    parts.push(`<text x="${cx}" y="${cz}" font-size="13" fill="${T.roomText}" text-anchor="middle" opacity="${T.roomOpacity}" letter-spacing="2">${courtyardText.name}</text>`);
  }

  // 出生点
  if (spawn) {
    const px = (Math.floor(spawn.x) - b.x0) * CELL, pz = (Math.floor(spawn.z) - b.z0) * CELL;
    parts.push(`<circle cx="${px + CELL / 2}" cy="${pz + CELL / 2}" r="${CELL * 0.55}" fill="${T.spawnFill}"/>`);
    parts.push(`<text x="${px + CELL / 2}" y="${pz + CELL / 2 + 3.5}" font-size="8" fill="${T.spawnText}" text-anchor="middle" font-weight="bold">S</text>`);
  }

  return {
    svg: `<svg viewBox="0 0 ${W} ${H}" width="${W}" height="${H}" xmlns="http://www.w3.org/2000/svg" style="background:${T.svgBg}">${parts.join('')}</svg>`,
    W, H, used, bounds: b,
  };
}

/** 房间范围转标签列表（ROOMS 对象 → [{x0,z0,x1,z1,name}]） */
export function roomLabelList(rooms, labels = {}) {
  return Object.entries(rooms).map(([id, r]) => ({
    x0: r.x0, z0: r.z0, x1: r.x1, z1: r.z1,
    name: labels[id] ?? id,
  }));
}
