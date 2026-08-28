import { BLOCK } from '../voxel/blocks.js';

/**
 * 平面图共享渲染器。一份 SVG 渲染逻辑，三处用：
 *   1. tools/make-floorplan.mjs（导出 floorplan.html，浅色）
 *   2. tools/make-floorplan02.mjs（同上，第二关）
 *   3. 任务简报「地图」页 + 任务选择屏缩略图（深色）
 *
 * 直接读体素网格，所以图和游戏永远一致。
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

export function legendItems(used) {
  const seen = new Set();
  const out = [];
  for (const id of used) {
    const L = LEGEND[id];
    if (!L || seen.has(L.n)) continue;
    seen.add(L.n);
    out.push({ n: L.n, c: L.c });
  }
  return out;
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

  // 地毯（当作背景）
  for (let z = b.z0; z <= b.z1; z++)
    for (let x = b.x0; x <= b.x1; x++) {
      if (w.get(x, y, z) !== BLOCK.CARPET) continue;
      parts.push(`<rect x="${(x - b.x0) * CELL}" y="${(z - b.z0) * CELL}" width="${CELL}" height="${CELL}" fill="${T.carpet}"/>`);
      used.set(BLOCK.CARPET, true);
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

  // 家具
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
