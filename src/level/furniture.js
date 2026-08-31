import * as THREE from 'three';
import { BLOCK } from '../voxel/blocks.js';
import { buildGroup, P, mergeParts, VERTEX_MAT } from '../systems/kit.js';

// Improved furniture palette and placement metadata.
export const F = {
  sofa: 0x5b4f66, sofaDark: 0x463c50, sofaLite: 0x6d6079,
  wood: 0x5c4835, woodDark: 0x3f3125, woodLite: 0x6f5842,
  fabric: 0x4e5766, fabricLite: 0x626d7e, sheet: 0x8f97a4,
  screen: 0x141a20, carpet: 0x54403f, carpetEdge: 0x6b5350,
  plant: 0x3a5c42, plantLite: 0x4a704f, pot: 0x6b4a3a, soil: 0x2e2620,
  stone: 0x5d636b, stoneLite: 0x757c85, porcelain: 0x7d8794, porcelainDark: 0x5f6874,
  frame: 0x6b543c, canvas: 0x3a4450, doorPanel: 0x8a6a4a, doorInset: 0x6f5842,
  lamp: 0xe0b268, lampGlow: 0xffe0a0,
  crate: 0x46525f, crateDark: 0x333d48, crateEdge: 0x59687a,
  shelf: 0x515f6e, shelfDark: 0x3a444f, metal: 0x8a929c, metalDark: 0x4a525c,
  bookA: 0x8a4a42, bookB: 0x4a5f7a, bookC: 0x7a6a3a, bookD: 0x4a6a52,
  cargo: 0x6b5a44, cargoAlt: 0x55606b, tube: 0xfff2c4, tubeDead: 0x3a3f46,
};

export const FURN_HEIGHT = {
  sofa: 0.55, sofaBack: 1.0, table: 0.75, chair: 0.5, counter: 0.9,
  bed: 0.5, cabinet: 1.0, wardrobe: 1.0, bookshelf: 1.0, shelf: 1.0,
  crate: 1.0, tv: 0.7, sink: 0.8, plant: 0.8, lamp: 0.6,
  picture: 1.0, carpet: 0.03, flickerLamp: 0.3, lampBroken: 0.3,
};

export const FURN_SIZES = {
  sofa: [[1, 5], [2, 1]], sofaBack: [[1, 1], [1, 5], [2, 1]],
  table: [[1, 1], [2, 2], [1, 2], [4, 3]], chair: [[1, 1], [1, 2]],
  counter: [[2, 1], [1, 3], [1, 5]], bed: [[2, 3], [2, 5], [1, 1], [1, 2], [2, 2]],
  cabinet: [[1, 1], [1, 3], [3, 1]], wardrobe: [[2, 1], [1, 2], [1, 1]],
  bookshelf: [[2, 1], [1, 1], [1, 3], [2, 5]], shelf: [[1, 2], [1, 1], [2, 1]],
  crate: [[1, 1], [2, 1], [2, 2], [3, 3]], tv: [[1, 1], [1, 2]],
  sink: [[1, 1], [2, 1]], plant: [[1, 1]], lamp: [[1, 1]], picture: [[1, 1]],
  carpet: [[8, 6], [5, 5], [3, 4]], flickerLamp: [[1, 1]], lampBroken: [[1, 1]],
};

// These flags mirror the old BLOCKS definitions and travel with each placement.
export const FURN_OPAQUE = {
  sofa: false, sofaBack: true, table: false, tv: false, bed: false,
  cabinet: true, carpet: false, lamp: false, plant: false, counter: true,
  chair: false, wardrobe: true, picture: false, sink: false, bookshelf: false,
  shelf: false, crate: true, flickerLamp: false, lampBroken: false,
};
export const FURN_COLLIDABLE = {
  sofa: true, sofaBack: true, table: true, tv: true, bed: true,
  cabinet: true, carpet: false, lamp: false, plant: true, counter: true,
  chair: true, wardrobe: true, picture: false, sink: true, bookshelf: true,
  shelf: true, crate: true, flickerLamp: false, lampBroken: false,
};

/**
 * Door visual dimensions shared by every runtime doorway.
 * The voxel grid remains the collision/visibility authority; this is only
 * the detailed visual model attached by systems/doors.js.
 */
export const DOOR_SPEC = {
  height: 2,
  thick: 0.14,
  wallThick: 2,
  openAngle: Math.PI / 2,
  frame: 0.05,
  lintel: 0.10,
  faceInset: 0.5,
};

/**
 * Build a doorway in local coordinates.
 * The root origin is the doorway's minimum x/z cell and ground y. Leaves are
 * returned separately so Door can keep its established rotation contract.
 */
export function buildDoorway({ span = 1, through = 'z', interior = -1, wallThick } = {}) {
  const S = { ...DOOR_SPEC, wallThick: wallThick ?? DOOR_SPEC.wallThick };
  const root = new THREE.Group();
  root.name = `door-${span}wide-${through}`;
  const panelH = S.height - S.lintel;
  // Keep the legacy pivots on the doorway's two outside edges. The panels
  // meet at the center seam while the frame remains visible in front.
  const panelW = span / 2;
  const frameDepth = S.wallThick + 0.02;

  if (through === 'z') {
    const zc = S.faceInset;
    const zf = S.wallThick / 2;
    const hxL = 0;
    const hxR = span;
    root.add(buildGroup({ parts: [
      P('box', [S.frame, S.height, frameDepth], [S.frame / 2, S.height / 2, zf], F.frame),
      P('box', [S.frame, S.height, frameDepth], [span - S.frame / 2, S.height / 2, zf], F.frame),
      P('box', [span, S.lintel, frameDepth], [span / 2, S.height - S.lintel / 2, zf], F.frame),
    ] }));
    const leaf = (hx, sign, name) => {
      const group = new THREE.Group();
      group.name = name;
      group.position.set(hx, 0, zc);
      const mesh = new THREE.Mesh(mergeParts([
        P('box', [panelW, panelH, S.thick], [sign * panelW / 2, panelH / 2, 0], F.doorPanel),
        P('box', [panelW - 0.10, panelH - 0.12, 0.02],
          [sign * panelW / 2, panelH / 2, S.thick / 2 + 0.005], F.doorInset),
        P('box', [0.04, 0.13, 0.04],
          [sign * (panelW - 0.10), panelH * 0.52, S.thick / 2 + 0.015], F.metal),
      ]), VERTEX_MAT);
      mesh.name = 'leaf';
      mesh.castShadow = true;
      mesh.receiveShadow = true;
      group.add(mesh);
      root.add(group);
      return { group, angle: interior === -1 ? sign * S.openAngle : -sign * S.openAngle };
    };
    return { root, leaves: [leaf(hxL, 1, 'doorL'), leaf(hxR, -1, 'doorR')] };
  }

  const xc = S.faceInset;
  const xf = S.wallThick / 2;
  const hzL = 0;
  const hzR = span;
  root.add(buildGroup({ parts: [
    P('box', [frameDepth, S.height, S.frame], [xf, S.height / 2, S.frame / 2], F.frame),
    P('box', [frameDepth, S.height, S.frame], [xf, S.height / 2, span - S.frame / 2], F.frame),
    P('box', [frameDepth, S.lintel, span], [xf, S.height - S.lintel / 2, span / 2], F.frame),
  ] }));
  const leaf = (hz, sign, name) => {
    const group = new THREE.Group();
    group.name = name;
    group.position.set(xc, 0, hz);
    const mesh = new THREE.Mesh(mergeParts([
      P('box', [S.thick, panelH, panelW], [0, panelH / 2, sign * panelW / 2], F.doorPanel),
      P('box', [0.02, panelH - 0.12, panelW - 0.10],
        [S.thick / 2 + 0.005, panelH / 2, sign * panelW / 2], F.doorInset),
      P('box', [0.04, 0.13, 0.04],
        [S.thick / 2 + 0.015, panelH * 0.52, sign * (panelW - 0.10)], F.metal),
    ]), VERTEX_MAT);
    mesh.name = 'leaf';
    mesh.castShadow = true;
    mesh.receiveShadow = true;
    group.add(mesh);
    root.add(group);
    return { group, angle: interior === -1 ? -sign * S.openAngle : sign * S.openAngle };
  };
  return { root, leaves: [leaf(hzL, 1, 'doorL'), leaf(hzR, -1, 'doorR')] };
}

const CYL_X = [0, 0, Math.PI / 2];
const CYL_Z = [Math.PI / 2, 0, 0];

function sofaParts(w, d) {
  const seats = Math.max(1, Math.round(w));
  const parts = [
    P('box', [w - 0.14, 0.12, d - 0.20], [0, 0.06, 0], F.sofaDark),
    P('box', [w - 0.10, 0.22, d - 0.16], [0, 0.23, 0.02], F.sofa),
    P('box', [w - 0.10, 0.26, 0.12], [0, 0.43, -(d / 2 - 0.08)], F.sofa),
    P('box', [w - 0.06, 0.06, 0.14], [0, 0.53, -(d / 2 - 0.08)], F.sofaLite),
    P('box', [0.13, 0.32, d - 0.10], [-(w / 2 - 0.07), 0.26, 0.02], F.sofaLite),
    P('box', [0.13, 0.32, d - 0.10], [w / 2 - 0.07, 0.26, 0.02], F.sofaLite),
  ];
  for (let i = 1; i < seats; i++) {
    const x = -w / 2 + (w / seats) * i;
    parts.push(P('box', [0.025, 0.20, d - 0.20], [x, 0.24, 0.02], F.sofaDark));
  }
  return parts;
}

function sofaBackParts(w, d) {
  const parts = [
    P('box', [w - 0.14, 0.08, d - 0.14], [0, 0.04, 0], F.sofaDark),
    P('box', [w - 0.10, 0.84, 0.16], [0, 0.50, 0], F.sofa),
    P('box', [w - 0.04, 0.09, 0.20], [0, 0.955, 0], F.sofaLite),
  ];
  const cols = Math.max(2, Math.round(w));
  for (let i = 0; i < cols; i++) for (let j = 0; j < 2; j++) {
    const x = -w / 2 + (w / cols) * (i + 0.5);
    parts.push(P('box', [w / cols - 0.14, 0.20, 0.03], [x, 0.32 + j * 0.32, 0.09], F.sofaDark));
  }
  return parts;
}

function tableParts(w, d) {
  const i = 0.09;
  const parts = [
    P('box', [w, 0.07, d], [0, 0.715, 0], F.woodLite),
    P('box', [w - 0.10, 0.05, d - 0.10], [0, 0.655, 0], F.wood),
    P('box', [0.08, 0.62, 0.08], [-(w / 2 - i), 0.31, -(d / 2 - i)], F.woodDark),
    P('box', [0.08, 0.62, 0.08], [w / 2 - i, 0.31, -(d / 2 - i)], F.woodDark),
    P('box', [0.08, 0.62, 0.08], [-(w / 2 - i), 0.31, d / 2 - i], F.woodDark),
    P('box', [0.08, 0.62, 0.08], [w / 2 - i, 0.31, d / 2 - i], F.woodDark),
  ];
  if (w >= 2) parts.push(P('box', [w - 0.26, 0.05, 0.05], [0, 0.18, 0], F.woodDark));
  if (d >= 2) parts.push(P('box', [0.05, 0.05, d - 0.26], [0, 0.18, 0], F.woodDark));
  return parts;
}

function chairParts(w, d) {
  const bench = d >= 2;
  const parts = [
    P('box', [w - 0.14, 0.07, d - 0.14], [0, 0.435, 0], F.woodLite),
    P('box', [0.06, 0.40, 0.06], [-(w / 2 - 0.11), 0.20, -(d / 2 - 0.11)], F.woodDark),
    P('box', [0.06, 0.40, 0.06], [w / 2 - 0.11, 0.20, -(d / 2 - 0.11)], F.woodDark),
    P('box', [0.06, 0.40, 0.06], [-(w / 2 - 0.11), 0.20, d / 2 - 0.11], F.woodDark),
    P('box', [0.06, 0.40, 0.06], [w / 2 - 0.11, 0.20, d / 2 - 0.11], F.woodDark),
  ];
  if (!bench) parts.push(
    P('box', [0.05, 0.34, 0.05], [-(w / 2 - 0.11), 0.63, -(d / 2 - 0.11)], F.woodDark),
    P('box', [0.05, 0.34, 0.05], [w / 2 - 0.11, 0.63, -(d / 2 - 0.11)], F.woodDark),
    P('box', [w - 0.26, 0.09, 0.05], [0, 0.76, -(d / 2 - 0.11)], F.wood),
    P('box', [w - 0.30, 0.05, 0.05], [0, 0.62, -(d / 2 - 0.11)], F.wood),
  );
  else parts.push(P('box', [w - 0.20, 0.04, 0.04], [0, 0.18, 0], F.woodDark));
  return parts;
}

function counterParts(w, d) {
  const doors = Math.max(1, Math.round(w));
  const parts = [
    P('box', [w - 0.12, 0.06, d - 0.16], [0, 0.03, 0], F.woodDark),
    P('box', [w - 0.06, 0.78, d - 0.10], [0, 0.45, 0], F.wood),
    P('box', [w, 0.08, d], [0, 0.86, 0], F.stone),
    P('box', [w, 0.02, d + 0.02], [0, 0.895, 0], F.stoneLite),
  ];
  for (let i = 0; i < doors; i++) {
    const x = -w / 2 + (w / doors) * (i + 0.5);
    parts.push(P('box', [0.02, 0.70, 0.02], [x, 0.45, d / 2 - 0.05], F.woodDark));
    parts.push(P('box', [w / doors - 0.16, 0.03, 0.04], [x, 0.74, d / 2 - 0.06], F.metal));
  }
  return parts;
}

function bedParts(w, d) {
  return [
    P('box', [w, 0.16, d], [0, 0.08, 0], F.woodDark),
    P('box', [w - 0.06, 0.28, d - 0.06], [0, 0.30, 0.02], F.fabric),
    P('box', [w - 0.02, 0.30, 0.07], [0, 0.37, -(d / 2 - 0.03)], F.wood),
    P('box', [w * 0.44, 0.07, 0.26], [0, 0.475, -(d / 2 - 0.20)], F.sheet),
    P('box', [w - 0.10, 0.09, d * 0.52], [0, 0.465, d * 0.20], F.fabricLite),
    P('box', [w - 0.10, 0.03, 0.05], [0, 0.50, d * 0.20 - d * 0.26], F.sheet),
  ];
}

function cabinetParts(w, d) {
  const doors = Math.max(1, Math.round(w));
  const parts = [
    P('box', [w - 0.10, 0.04, d - 0.10], [0, 0.02, 0], F.woodDark),
    P('box', [w - 0.05, 0.90, d - 0.05], [0, 0.49, 0], F.wood),
    P('box', [w, 0.06, d], [0, 0.97, 0], F.woodLite),
  ];
  for (let i = 0; i < doors; i++) {
    const x = -w / 2 + (w / doors) * (i + 0.5);
    parts.push(P('box', [0.02, 0.82, 0.02], [x, 0.48, d / 2 - 0.02], F.woodDark));
    parts.push(P('box', [0.05, 0.14, 0.04], [x + w / doors / 2 - 0.10, 0.55, d / 2 - 0.01], F.metal));
  }
  return parts;
}

function wardrobeParts(w, d) {
  return [
    P('box', [w - 0.08, 0.05, d - 0.08], [0, 0.025, 0], F.woodDark),
    P('box', [w - 0.04, 0.88, d - 0.04], [0, 0.49, 0], F.woodDark),
    P('box', [w, 0.08, d + 0.03], [0, 0.96, 0], F.wood),
    P('box', [0.025, 0.80, 0.02], [0, 0.49, d / 2 - 0.01], F.wood),
    P('box', [0.05, 0.16, 0.04], [-(w / 4), 0.52, d / 2 - 0.005], F.metal),
    P('box', [0.05, 0.16, 0.04], [w / 4, 0.52, d / 2 - 0.005], F.metal),
  ];
}

function bookshelfParts(w, d) {
  const parts = [
    P('box', [0.07, 0.94, d - 0.03], [-(w / 2 - 0.035), 0.47, 0], F.woodDark),
    P('box', [0.07, 0.94, d - 0.03], [w / 2 - 0.035, 0.47, 0], F.woodDark),
    P('box', [w, 0.06, d], [0, 0.97, 0], F.woodDark),
    P('box', [w, 0.06, d], [0, 0.03, 0], F.woodDark),
    P('box', [w - 0.14, 0.82, 0.035], [0, 0.47, -(d / 2 - 0.02)], F.wood),
    P('box', [w - 0.14, 0.04, d - 0.10], [0, 0.34, 0], F.woodDark),
    P('box', [w - 0.14, 0.04, d - 0.10], [0, 0.66, 0], F.woodDark),
  ];
  const books = [F.bookA, F.bookB, F.bookC, F.bookD];
  let k = 0;
  for (const y of [0.06, 0.40, 0.72]) {
    const n = Math.max(2, Math.round(w * 2.2));
    for (let i = 0; i < n; i++) {
      const bw = (w - 0.22) / n;
      const x = -(w - 0.22) / 2 + bw * (i + 0.5);
      const bh = 0.20 + ((k * 7) % 5) * 0.012;
      parts.push(P('box', [bw - 0.015, bh, d - 0.34], [x, y + bh / 2, 0.02], books[k++ % books.length]));
    }
  }
  return parts;
}

function shelfParts(w, d) {
  const H = 2;
  const parts = [];
  for (const x of [-w / 2 + 0.05, w / 2 - 0.05]) for (const z of [-d / 2 + 0.05, d / 2 - 0.05]) {
    parts.push(P('box', [0.09, H - 0.06, 0.09], [x, H / 2 - 0.03, z], F.shelfDark));
  }
  for (const y of [0.10, 0.72, 1.34, 1.94]) parts.push(P('box', [w - 0.06, 0.055, d - 0.06], [0, y, 0], F.shelf));
  parts.push(P('box', [0.04, 0.72, 0.04], [-(w / 2 - 0.05), 1.05, 0], F.shelfDark, [0, 0, 0.42]));
  parts.push(P('box', [0.04, 0.72, 0.04], [w / 2 - 0.05, 1.05, 0], F.shelfDark, [0, 0, -0.42]));
  parts.push(P('box', [w - 0.30, 0.34, d - 0.26], [0, 0.31, 0], F.cargo));
  parts.push(P('box', [w - 0.40, 0.26, d - 0.30], [-(w * 0.16), 0.89, 0], F.cargoAlt));
  parts.push(P('box', [w - 0.44, 0.22, d - 0.32], [w * 0.14, 0.87, 0.02], F.cargo));
  parts.push(P('box', [w - 0.34, 0.30, d - 0.28], [0, 1.51, 0], F.cargoAlt));
  return parts;
}

function crateParts(w, d) {
  return [
    P('box', [w - 0.05, 0.94, d - 0.05], [0, 0.47, 0], F.crate),
    ...[-1, 1].flatMap((sx) => [-1, 1].map((sz) => P('box', [0.08, 0.98, 0.08], [sx * (w / 2 - 0.04), 0.49, sz * (d / 2 - 0.04)], F.crateEdge))),
    P('box', [w - 0.02, 0.07, d - 0.02], [0, 0.88, 0], F.crateEdge),
    P('box', [w - 0.02, 0.07, d - 0.02], [0, 0.12, 0], F.crateEdge),
    P('box', [w - 0.10, 0.03, 0.07], [0, 0.965, 0], F.crateDark),
    P('box', [0.07, 0.03, d - 0.10], [0, 0.965, 0], F.crateDark),
  ];
}

function tvParts(w, d) {
  return [P('box', [w * 0.46, 0.04, d * 0.30], [0, 0.02, 0], F.metalDark),
    P('box', [0.10, 0.12, 0.08], [0, 0.10, 0], F.metalDark),
    P('box', [w - 0.10, 0.56, 0.05], [0, 0.44, 0], F.metalDark),
    P('box', [w - 0.18, 0.48, 0.03], [0, 0.44, 0.035], F.screen)];
}

function sinkParts(w, d) {
  return [P('box', [w - 0.10, 0.72, d - 0.14], [0, 0.36, 0], F.porcelainDark),
    P('box', [w, 0.08, d - 0.06], [0, 0.76, 0], F.porcelain),
    P('box', [w * 0.52, 0.02, d * 0.42], [0, 0.785, 0.02], F.porcelainDark),
    P('cyl8', [0.05, 0.18, 0.05], [0, 0.89, -(d / 2 - 0.14)], F.metal),
    P('cyl8', [0.035, 0.16, 0.035], [0, 0.96, -(d / 2 - 0.22)], F.metal, CYL_Z),
    P('box', [0.02, 0.66, 0.02], [0, 0.36, (d - 0.14) / 2 + 0.02], F.porcelainDark)];
}

function plantParts(w, d) {
  const parts = [P('cyl8', [w * 0.60, 0.28, w * 0.60], [0, 0.14, 0], F.pot),
    P('cyl8', [w * 0.68, 0.06, w * 0.68], [0, 0.29, 0], F.pot),
    P('cyl8', [w * 0.58, 0.03, w * 0.58], [0, 0.30, 0], F.soil),
    P('box', [0.05, 0.22, 0.05], [0, 0.42, 0], F.plant)];
  for (let i = 0; i < 6; i++) { const a = (i / 6) * Math.PI * 2; const r = 0.14;
    parts.push(P('box', [0.06, 0.30, 0.16], [Math.cos(a) * r, 0.58 + (i % 2) * 0.08, Math.sin(a) * r], i % 2 ? F.plantLite : F.plant, [0.42 * Math.cos(a + Math.PI / 2), -a, 0.42 * Math.sin(a)])); }
  return parts;
}

function lampParts(w, d) {
  return [P('cyl8', [0.26, 0.05, 0.26], [0, 0.025, 0], F.metalDark), P('cyl6', [0.05, 0.30, 0.05], [0, 0.20, 0], F.metal),
    P('cyl8', [0.34, 0.075, 0.34], [0, 0.40, 0], F.lamp), P('cyl8', [0.28, 0.075, 0.28], [0, 0.475, 0], F.lamp), P('cyl8', [0.22, 0.09, 0.22], [0, 0.555, 0], F.lamp)];
}
function pictureParts(w) { return [P('box', [w - 0.06, 0.96, 0.05], [0, 0.50, 0], F.frame), P('box', [w - 0.18, 0.84, 0.02], [0, 0.50, 0.035], F.canvas), P('box', [(w - 0.18) * 0.5, 0.34, 0.015], [-(w - 0.18) * 0.18, 0.40, 0.05], F.bookB), P('box', [(w - 0.18) * 0.34, 0.20, 0.015], [(w - 0.18) * 0.22, 0.66, 0.05], F.bookA)]; }
function carpetParts(w, d) { return [P('box', [w, 0.026, d], [0, 0.013, 0], F.carpet), P('box', [w - 0.22, 0.010, d - 0.22], [0, 0.028, 0], F.carpetEdge), P('box', [w - 0.44, 0.008, d - 0.44], [0, 0.031, 0], F.carpet)]; }
function flickerLampParts(w) { return [P('box', [0.04, 0.18, 0.04], [-(w * 0.34), 0.26, 0], F.metalDark), P('box', [0.04, 0.18, 0.04], [w * 0.34, 0.26, 0], F.metalDark), P('box', [w * 0.86, 0.10, 0.16], [0, 0.16, 0], F.metalDark)]; }
function lampBrokenParts(w) { return [...flickerLampParts(w), P('cyl8', [0.09, 0.16, 0.09], [-(w * 0.26), 0.15, 0.02], F.tubeDead, [0, 0, 0.5]), P('cyl8', [0.09, 0.12, 0.09], [w * 0.02, 0.12, -0.01], F.tubeDead, [0, 0, 1.2]), P('cyl8', [0.09, 0.10, 0.09], [w * 0.28, 0.11, 0.03], F.tubeDead, [0, 0, 0.8]), P('box', [0.02, 0.14, 0.02], [w * 0.34, 0.10, 0], F.metalDark)]; }

const BUILDERS = { sofa: sofaParts, sofaBack: sofaBackParts, table: tableParts, chair: chairParts, counter: counterParts, bed: bedParts, cabinet: cabinetParts, wardrobe: wardrobeParts, bookshelf: bookshelfParts, shelf: shelfParts, crate: crateParts, tv: tvParts, sink: sinkParts, plant: plantParts, lamp: lampParts, picture: pictureParts, carpet: carpetParts, flickerLamp: flickerLampParts, lampBroken: lampBrokenParts };
const ORIENT = new Set(['tv']);

export const OPENABLE = {
  cabinet: { leaves: 2, kind: 'door', angle: 1.85 },
  wardrobe: { leaves: 2, kind: 'door', angle: 1.75 },
  crate: { leaves: 1, kind: 'lid', angle: 1.85 },
  tv: { leaves: 0, kind: null, angle: 0 },
};
export const OPENABLE_FURNITURE = OPENABLE;

function cabinetBody(w, d) {
  const dy = 0.86;
  const back = -(d / 2 - 0.03);
  return [
    P('box', [w - 0.10, 0.04, d - 0.10], [0, 0.02, 0], F.woodDark),
    P('box', [w - 0.05, 0.06, d], [0, dy + 0.04, 0], F.woodLite),
    P('box', [w - 0.08, dy, 0.04], [0, dy / 2 + 0.03, back], F.woodDark),
    P('box', [0.04, dy, d - 0.10], [-(w / 2 - 0.03), dy / 2 + 0.03, 0], F.wood),
    P('box', [0.04, dy, d - 0.10], [w / 2 - 0.03, dy / 2 + 0.03, 0], F.wood),
    P('box', [w - 0.12, 0.03, d - 0.16], [0, dy * 0.60, 0], F.woodDark),
  ];
}

function wardrobeBody(w, d) {
  const dy = 0.88;
  const back = -(d / 2 - 0.03);
  return [
    P('box', [w - 0.08, 0.05, d - 0.08], [0, 0.025, 0], F.woodDark),
    P('box', [w, 0.08, d + 0.03], [0, dy + 0.09, 0], F.wood),
    P('box', [w - 0.06, dy, 0.04], [0, dy / 2 + 0.03, back], F.woodDark),
    P('box', [0.04, dy, d - 0.08], [-(w / 2 - 0.02), dy / 2 + 0.03, 0], F.woodDark),
    P('box', [0.04, dy, d - 0.08], [w / 2 - 0.02, dy / 2 + 0.03, 0], F.woodDark),
    P('box', [w - 0.10, 0.03, d - 0.14], [0, dy * 0.55, 0], F.wood),
    P('cyl6', [0.04, w - 0.14, 0.04], [0, dy * 0.86, 0], F.metal, [0, 0, Math.PI / 2]),
  ];
}

function crateBody(w, d) {
  const h = 0.94;
  const t = 0.07;
  const i = 0.03;
  return [
    P('box', [w - 0.06, 0.06, d - 0.06], [0, 0.03, 0], F.crateDark),
    P('box', [t, h, d - 0.06], [-(w / 2 - i), h / 2, 0], F.crate),
    P('box', [t, h, d - 0.06], [w / 2 - i, h / 2, 0], F.crate),
    P('box', [w - 0.06, h, t], [0, h / 2, -(d / 2 - i)], F.crate),
    P('box', [w - 0.06, h, t], [0, h / 2, d / 2 - i], F.crate),
    P('box', [0.08, h, 0.08], [-(w / 2 - 0.04), h / 2, -(d / 2 - 0.04)], F.crateEdge),
    P('box', [0.08, h, 0.08], [w / 2 - 0.04, h / 2, -(d / 2 - 0.04)], F.crateEdge),
    P('box', [0.08, h, 0.08], [-(w / 2 - 0.04), h / 2, d / 2 - 0.04], F.crateEdge),
    P('box', [0.08, h, 0.08], [w / 2 - 0.04, h / 2, d / 2 - 0.04], F.crateEdge),
    P('box', [w - 0.02, 0.07, d - 0.02], [0, 0.14, 0], F.crateEdge),
  ];
}

function cabinetDoors(w, d) {
  const H = 0.84;
  const doorW = (w - 0.10) / 2;
  const spec = [
    { name: 'doorL', hx: -(w / 2 - 0.05), sign: 1, angle: -1.85 },
    { name: 'doorR', hx: w / 2 - 0.05, sign: -1, angle: 1.85 },
  ];
  return spec.map((s) => ({
    name: s.name,
    angle: s.angle,
    axis: 'y',
    hinge: [s.hx, 0.05, d / 2 - 0.05],
    parts: [
      P('box', [doorW, H, 0.05], [s.sign * doorW / 2, H / 2, 0], F.wood),
      P('box', [doorW - 0.08, H - 0.10, 0.02],
        [s.sign * doorW / 2, H / 2, 0.035], F.woodLite),
      P('box', [0.04, 0.16, 0.04],
        [s.sign * (doorW - 0.09), H * 0.5, 0.05], F.metal),
    ],
  }));
}

function wardrobeDoors(w, d) {
  const H = 0.80;
  const doorW = (w - 0.08) / 2;
  return [
    { name: 'doorL', hx: -(w / 2 - 0.04), sign: 1, angle: -1.75 },
    { name: 'doorR', hx: w / 2 - 0.04, sign: -1, angle: 1.75 },
  ].map((s) => ({
    name: s.name,
    angle: s.angle,
    axis: 'y',
    hinge: [s.hx, 0.06, d / 2 - 0.04],
    parts: [
      P('box', [doorW, H, 0.05], [s.sign * doorW / 2, H / 2, 0], F.woodDark),
      P('box', [doorW - 0.10, H - 0.12, 0.02],
        [s.sign * doorW / 2, H / 2, 0.035], F.wood),
      P('box', [0.04, 0.18, 0.04],
        [s.sign * (doorW - 0.10), H * 0.48, 0.05], F.metal),
    ],
  }));
}

function crateLid(w, d) {
  return [{
    name: 'lid',
    axis: 'x',
    angle: -1.85,
    hinge: [0, 0.94, -(d / 2 - 0.02)],
    parts: [
      P('box', [w - 0.04, 0.08, d - 0.04], [0, 0.02, d / 2 - 0.02], F.crateEdge),
      P('box', [w - 0.14, 0.03, d - 0.14], [0, 0.07, d / 2 - 0.02], F.crateDark),
    ],
  }];
}

const OPEN_BODY = { cabinet: cabinetBody, wardrobe: wardrobeBody, crate: crateBody };

export function buildOpenable(id, opts = {}) {
  const [dw, dd] = FURN_SIZES[id]?.[0] ?? [1, 1];
  const w = opts.w ?? dw;
  const d = opts.d ?? dd;
  const root = new THREE.Group();
  root.name = `openable-${id}-${w}x${d}`;

  const bodyFn = OPEN_BODY[id];
  if (bodyFn) {
    const m = new THREE.Mesh(mergeParts(bodyFn(w, d)), VERTEX_MAT);
    m.name = 'body';
    m.castShadow = true;
    m.receiveShadow = true;
    root.add(m);
  } else {
    const plain = buildFurniture(id, { w, d });
    plain.position.set(0, 0, 0);
    plain.rotation.set(0, 0, 0);
    plain.traverse((o) => {
      if (!o.isMesh) return;
      o.castShadow = true;
      o.receiveShadow = true;
    });
    root.add(plain);
  }

  const spec = id === 'cabinet' ? cabinetDoors(w, d)
    : id === 'wardrobe' ? wardrobeDoors(w, d)
      : id === 'crate' ? crateLid(w, d)
        : [];
  const leaves = spec.map((s) => {
    const g = new THREE.Group();
    g.name = s.name;
    g.position.set(...s.hinge);
    const m = new THREE.Mesh(mergeParts(s.parts), VERTEX_MAT);
    m.castShadow = true;
    g.add(m);
    root.add(g);
    return { name: s.name, group: g, axis: s.axis ?? 'y', angle: s.angle };
  });

  const info = OPENABLE[id] ?? { kind: null, angle: 0 };
  return { root, leaves, kind: info.kind };
}

function glowOf(id, w) {
  if (id === 'lamp') return [P('cyl8', [0.20, 0.06, 0.20], [0, 0.40, 0], F.lampGlow)];
  if (id === 'flickerLamp') return [P('cyl8', [0.13, w * 0.80, 0.13], [0, 0.10, 0], F.tube, CYL_X)];
  if (id === 'tv') return [P('box', [w - 0.26, 0.40, 0.02], [0, 0.44, 0.055], 0x1b2733)];
  return [];
}
export function buildFurniture(id, opts = {}) {
  const [dw, dd] = FURN_SIZES[id]?.[0] ?? [1, 1];
  const w = opts.w ?? dw; const d = opts.d ?? dd; const fn = BUILDERS[id];
  if (!fn) throw new Error(`没有家具 builder: ${id}`);
  const flip = ORIENT.has(id) && d > w; const bw = flip ? d : w; const bd = flip ? w : d;
  if (opts.openable === true && OPENABLE_FURNITURE[id]?.leaves > 0) {
    const built = buildOpenable(id, { w: bw, d: bd });
    const root = built.root;
    root.userData.openable = { leaves: built.leaves, kind: built.kind };
    if (flip) root.rotation.y = Math.PI / 2;
    root.name = `furniture-${id}-${w}x${d}`;
    return root;
  }
  const g = buildGroup({ parts: fn(bw, bd), glow: glowOf(id, bw) });
  if (flip) g.rotation.y = Math.PI / 2;
  if (id === 'shelf' && opts.height != null) g.scale.y = opts.height / 2;
  g.name = `furniture-${id}-${w}x${d}`;
  return g;
}

/**
 * 共享家具库。任何关卡都从这里取件，不要在关卡文件里再抄一份 put/sofa。
 *
 * 三层：
 *   1. 方块 ID 仍在 blocks.js（渲染 / 碰撞的唯一来源）
 *   2. 本文件：放置原语 + 命名组合件 + placement AABB 清障
 *   3. 关卡布局脚本：只调用 canonical metadata writer，决定「这间房放哪几件」
 *
 * 三条硬约束（所有地图共用）：
 *   · 永不覆盖已有方块（地毯除外，家具可以压地毯）
 *   · 门口 2 格净空由关卡清障负责，组合件自己不去保证
 *   · 新增家具必须同时登记元数据语义，否则模型与碰撞边界会失配
 */

/**
 * 可摆放的单件。关卡一般 F.place('table', x, z)，散件也可 F.put(x, z, 'table')。
 * 普通家具通过 canonical metadata writer 登记，不再接受 numeric block ID。
 */
const CATALOG_PIECES = [
  'sofa', 'sofaBack', 'table', 'tv', 'bed', 'cabinet', 'carpet', 'lamp',
  'plant', 'counter', 'chair', 'wardrobe', 'picture', 'sink', 'bookshelf',
  'crate', 'shelf',
];
const CATALOG_SETS = [
  'sofa', 'doubleBed', 'examBed', 'tvStand', 'tvLounge', 'diningTable',
  'kitchenRun', 'desk', 'wetCorner', 'bookWall', 'closet', 'operatingTable',
  'labBench', 'morgueDrawers', 'receptionDesk', 'waitingRow',
];

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
  pieces: CATALOG_PIECES,
  sets:   CATALOG_SETS,
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

const BACK_OFF = {
  east:  [-1,  0],
  west:  [ 1,  0],
  north: [ 0,  1],
  south: [ 0, -1],
};

/** F.place 允许点名的全部方法：命名组合件 + 单件 + 原位方法 */
const CANONICAL_COMPOSITES = [
  'sofa', 'doubleBed', 'examBed', 'tvStand', 'tvLounge', 'diningTable',
  'kitchenRun', 'desk', 'wetCorner', 'bookWall', 'closet', 'operatingTable',
  'labBench', 'morgueDrawers', 'receptionDesk', 'waitingRow',
];
const PLACEABLE = new Set([
  ...CANONICAL_COMPOSITES,
  'picture', 'shelf', 'crate', 'lamp', 'plant', 'chair', 'tv', 'sink',
  'table', 'cabinet', 'wardrobe', 'counter', 'bookshelf', 'bed',
]);

/**
 * 打开 canonical 家具 writer。w 只作为结构体素的只读快照，y 是地面层。
 * 普通家具只写入 placements 覆盖层，不写进 World；应急灯保留体素标记，
 * 因为 systems/lights.js 仍从网格扫描它们。
 */
function createPlacementWriter(w, y, log = []) {
  const placements = log ?? [];
  const overlay = new Map();
  const placementCells = new Map();
  const keyAt = (x, yy, z) => `${x},${yy},${z}`;
  const cellValue = (x, yy, z) => {
    const item = overlay.get(keyAt(x, yy, z));
    if (item) return item.id;
    return w?.get?.(x, yy, z) ?? BLOCK.AIR;
  };
  const removePlacement = (item) => {
    const cells = placementCells.get(item);
    if (cells) for (const cell of cells) overlay.delete(cell);
    placementCells.delete(item);
    const index = placements.indexOf(item);
    if (index >= 0) placements.splice(index, 1);
  };
  const record = (id, x, yy, z, opts = {}) => {
    if (typeof id !== 'string') return null;
    const key = id;
    const width = opts.w ?? 1;
    const depth = opts.d ?? 1;
    const height = opts.height ?? FURN_HEIGHT[key] ?? 1;
    const item = {
      id: key, x, y: yy, z, w: width, d: depth,
      rotation: opts.rotation ?? 0,
      height,
      opaque: opts.opaque ?? FURN_OPAQUE[key] ?? false,
      collidable: opts.collidable ?? FURN_COLLIDABLE[key] ?? true,
      boundsW: opts.boundsW ?? width,
      boundsD: opts.boundsD ?? depth,
      boundsH: opts.boundsH ?? height,
      openable: OPENABLE_FURNITURE[key]?.leaves > 0,
      open: false,
    };
    const cells = [];
    const layers = key === 'shelf' && height >= 2 ? 2 : 1;
    for (let gy = yy; gy < yy + layers; gy++) {
      const cell = keyAt(x, gy, z);
      const previous = overlay.get(cell);
      if (previous && previous !== item) removePlacement(previous);
      overlay.set(cell, item);
      cells.push(cell);
    }
    placementCells.set(item, cells);
    placements.push(item);
    return item;
  };
  const putPlacement = (x, yy, z, id, opts = {}) => {
    const current = cellValue(x, yy, z);
    if (typeof current === 'string') {
      const previous = overlay.get(keyAt(x, yy, z));
      if (previous) removePlacement(previous);
    } else if (current !== BLOCK.AIR && current !== BLOCK.CARPET) {
      return false;
    }
    return !!record(id, x, yy, z, opts);
  };
  const writeEmergencyVoxel = (x, yy, z, id, blockId) => {
    if (!w?.set || w.get(x, yy, z) !== BLOCK.AIR || overlay.has(keyAt(x, yy, z))) return false;
    w.set(x, yy, z, blockId);
    if (w.get(x, yy, z) !== blockId) return false;
    record(id, x, yy, z);
    return true;
  };
  const F = {
    /** 单块。只占空气或地毯，绝不长进墙里、也不盖掉已有家具。 */
    put(x, z, id, opts = {}) {
      putPlacement(x, y, z, id, opts);
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
      this.rect(x0, z0, x1, z1, 'carpet');
    },

    /**
     * 沙发：座位 + 靠背。facing 是人坐着看的方向（靠背在反侧）。
     * 靠背格如果已经是墙，put 会跳过，不会把墙换成靠背。
     */
    sofa(x, z, len, facing) {
      const horiz = facing === 'north' || facing === 'south';
      const [bx, bz] = BACK_OFF[facing] ?? BACK_OFF.east;
      const rotation = facing === 'east' ? Math.PI / 2
        : facing === 'west' ? -Math.PI / 2
          : facing === 'north' ? Math.PI : 0;
      const backRotation = facing === 'east' ? -Math.PI / 2
        : facing === 'west' ? Math.PI / 2
          : facing === 'north' ? 0 : Math.PI;
      for (let i = 0; i < len; i++) {
        const sx = horiz ? x + i : x;
        const sz = horiz ? z : z + i;
        this.put(sx, sz, 'sofa', { rotation });
        this.put(sx + bx, sz + bz, 'sofaBack', { rotation: backRotation });
      }
    },

    /**
     * 挂画：贴在墙面上的薄片，挂在腰上一格（y+1）。
     * 必须紧贴一面实心墙才挂 —— 否则会变成飘在房间中间的画框。
     */
    picture(x, z) {
      if (cellValue(x, y + 1, z) !== BLOCK.AIR) return;
      const touchesWall =
        cellValue(x - 1, y + 1, z) !== BLOCK.AIR || cellValue(x + 1, y + 1, z) !== BLOCK.AIR ||
        cellValue(x, y + 1, z - 1) !== BLOCK.AIR || cellValue(x, y + 1, z + 1) !== BLOCK.AIR;
      if (touchesWall) putPlacement(x, y + 1, z, 'picture');
    },

    /** 2 格高货架。下层占用失败则整件跳过，避免悬空上层。 */
    shelf(x, z) {
      const current = cellValue(x, y, z);
      if (typeof current !== 'string' && current !== BLOCK.AIR) return;
      const top = cellValue(x, y + 1, z);
      const topWritten = top === BLOCK.AIR || typeof top === 'string';
      putPlacement(x, y, z, 'shelf', { height: topWritten ? 2 : 1 });
    },

    crate(x, z) { this.put(x, z, 'crate'); },
    lamp(x, z) { this.put(x, z, 'lamp'); },

    /**
     * 应急灯（可击碎的闪烁灯）。挂在天花板下（y=3），不是地面家具，
     * 所以不走 put()（那个只写地面层、还会被门口清障拆掉）。
     *
     * 直接写网格：灯 solid:false 不挡路，玩家能打碎它换回黑暗。
     * 由 systems/lights.js 扫网格自动接管，关卡这里只负责「摆在哪」。
     */
    ceilingLamp(x, z, y = 3) {
      writeEmergencyVoxel(x, y, z, 'flickerLamp', BLOCK.FLICKER_LAMP);
    },

    /** 一批应急灯：ceilingLamps([[x,z], ...]) */
    ceilingLamps(points, y = 3) {
      for (const [x, z] of points) this.ceilingLamp(x, z, y);
    },
    plant(x, z) { this.put(x, z, 'plant'); },
    chair(x, z) { this.put(x, z, 'chair'); },
    tv(x, z) { this.put(x, z, 'tv'); },
    sink(x, z) { this.put(x, z, 'sink'); },
    table(x, z) { this.put(x, z, 'table'); },
    cabinet(x, z) { this.put(x, z, 'cabinet'); },
    wardrobe(x, z) { this.put(x, z, 'wardrobe'); },
    counter(x, z) { this.put(x, z, 'counter'); },
    bookshelf(x, z) { this.put(x, z, 'bookshelf'); },
    bed(x, z) { this.put(x, z, 'bed'); },

    /** 一批箱子：crates([[x,z], ...]) */
    crates(points) {
      for (const [x, z] of points) this.put(x, z, 'crate');
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
      this.rect(x, z, x + 1, z + 2, 'bed');
      this.put(x + 2, z, 'cabinet');
      this.put(x + 2, lampSide === 'south' ? z + 2 : z, 'lamp');
    },

    /** 诊床 / 隔离床：2×3 床 + 一侧柜子。 */
    examBed(x, z, { lampAt = 'foot' } = {}) {
      this.rect(x, z, x + 1, z + 2, 'bed');
      this.put(x + 2, z, 'cabinet');
      if (lampAt === 'foot') this.put(x + 2, z + 2, 'lamp');
    },

    /** 电视柜：两格屏幕 + 一格底座，沿 z 立着。 */
    tvStand(x, z) {
      this.put(x, z, 'cabinet');
      this.put(x, z + 1, 'tv');
      this.put(x, z + 2, 'tv');
    },

    /**
     * 客厅：沙发朝电视。anchor 是沙发座位起点。
     * facing = 人坐着看的方向。
     */
    tvLounge(x, z, { sofaLen = 5, facing = 'east' } = {}) {
      this.sofa(x, z, sofaLen, facing);
      const mid = Math.floor(sofaLen / 2);
      if (facing === 'east') {
        this.rect(x + 4, z + 1, x + 5, z + 2, 'table');
        this.tvStand(x + 10, z);
      } else if (facing === 'west') {
        this.rect(x - 5, z + 1, x - 4, z + 2, 'table');
        this.tvStand(x - 10, z);
      } else if (facing === 'south') {
        this.rect(x + 1, z + 4, x + 2, z + 5, 'table');
      } else {
        this.rect(x + 1, z - 5, x + 2, z - 4, 'table');
      }
      void mid;
    },

    /** 餐桌：2×2 桌面，四边各一把椅子。 */
    diningTable(x, z) {
      this.rect(x, z, x + 1, z + 1, 'table');
      this.put(x - 1, z, 'chair');
      this.put(x - 1, z + 1, 'chair');
      this.put(x + 2, z, 'chair');
      this.put(x + 2, z + 1, 'chair');
    },

    /** 厨房台面：沿墙一排 COUNTER，一端冰箱，一端水槽。 */
    kitchenRun(x, z, len, axis = 'z', { fridgeAt = 'start', sinkAt = 'end' } = {}) {
      this.row(x, z, len, 'counter', axis);
      const endX = axis === 'x' ? x + len - 1 : x;
      const endZ = axis === 'z' ? z + len - 1 : z;
      if (fridgeAt === 'start') this.put(axis === 'x' ? x : x - 1, axis === 'z' ? z : z, 'cabinet');
      if (sinkAt === 'end') this.put(endX, endZ, 'sink');
    },

    /** 书桌：两格桌 + 椅子 + 台灯。椅子在桌的 +z 侧。 */
    desk(x, z) {
      this.rect(x, z, x + 1, z, 'table');
      this.put(x, z + 1, 'chair');
      this.put(x + 2, z, 'lamp');
    },

    /** 双格洗手台 / 马桶组。 */
    wetCorner(x, z, axis = 'z') {
      this.row(x, z, 2, 'sink', axis);
    },

    /** 沿墙一排书架或档案柜。 */
    bookWall(x, z, len, axis = 'z', id = 'bookshelf') {
      this.row(x, z, len, id, axis);
    },

    /** 衣柜组。 */
    closet(x, z, len = 2, axis = 'x') {
      this.row(x, z, len, 'wardrobe', axis);
    },

    /**
     * 手术台。锚点是桌面西北角。
     * 默认 4×3 桌，椅子在北（z-1），灯在南（z+3）。
     */
    operatingTable(x, z, { w = 3, d = 2 } = {}) {
      this.rect(x, z, x + w, z + d, 'table');
      this.put(x, z - 1, 'chair');
      this.put(x + w, z - 1, 'chair');
      this.put(x, z + d + 1, 'lamp');
      this.put(x + w, z + d + 1, 'lamp');
    },

    /** 化验台：沿墙 COUNTER，一端柜子一端水槽。 */
    labBench(x, z, len, axis = 'z') {
      this.row(x, z, len, 'counter', axis);
      this.put(axis === 'x' ? x + 1 : x + 1, axis === 'z' ? z : z, 'cabinet');
      const endX = axis === 'x' ? x + len - 1 : x;
      const endZ = axis === 'z' ? z + len - 1 : z;
      this.put(axis === 'x' ? endX : endX + 1, axis === 'z' ? endZ : endZ, 'sink');
    },

    /** 停尸冷柜：沿墙一排满高柜子。 */
    morgueDrawers(x, z, len, axis = 'z') {
      this.row(x, z, len, 'cabinet', axis);
    },

    /** 接待桌：2×2 桌 + 内侧椅子 + 台灯。 */
    receptionDesk(x, z) {
      this.rect(x, z, x + 2, z + 1, 'table');
      this.put(x, z + 2, 'chair');
      this.put(x + 3, z, 'lamp');
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
 * 关卡 01「黑楼」家具布局。房间坐标与 level01.js 的 ROOMS 一致。
 * 布局本身属于关卡，但件全部来自 canonical metadata writer。
 */
function layoutLevel01(F) {

  // ══ 门厅（南侧，正对主入口）══════════════════════════════════════════
  F.cabinet(26, 39);
  F.cabinet(38, 39);
  F.picture(26, 38);
  F.picture(38, 38);
  F.carpet(29, 43, 35, 46);
  F.rect(27, 44, 28, 44, 'table');
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

  // ══ 厨房 / 餐厅（东南）══════════════════════════════════════════════
  F.row(55, 40, 5, 'counter', 'z');
  F.cabinet(54, 40);
  F.sink(55, 45);
  F.diningTable(46, 42);
  F.plant(46, 46);
  F.lamp(51, 40);
  F.carpet(45, 45, 50, 46);

  // ══ 仓库（北侧大空间）════════════════════════════════════════════════
  F.cabinet(22, 18);
  F.cabinet(22, 19);
  F.cabinet(43, 23);
  F.row(36, 17, 2, 'counter', 'x');
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
 * 布局直接写入 canonical placement metadata。
 */
function layoutLevel02(F) {

  // ══ 候诊室 ════════════════════════════════════════════════════════
  F.carpet(27, 10, 36, 15);
  F.waitingRow(26, 36, 10, 4);
  F.rect(28, 11, 29, 12, 'table');
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
  F.rect(8, 31, 9, 32, 'bed');
  F.wetCorner(22, 27, 'x');
  F.closet(22, 33, 2, 'x');
  F.plant(16, 27);
  F.table(18, 30);
  F.chair(19, 30);
  F.picture(8, 33);

  // ══ 化验室 ════════════════════════════════════════════════════════
  F.row(8, 36, 8, 'counter', 'z');
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
  F.row(26, 36, 4, 'cabinet', 'x');
  F.wetCorner(26, 46, 'x');
  F.plant(37, 46);
  F.picture(37, 38);

  // ══ 停尸房 ════════════════════════════════════════════════════════
  F.rect(40, 37, 41, 39, 'bed');
  F.rect(40, 43, 41, 45, 'bed');
  F.morgueDrawers(47, 36, 9, 'z');
  F.lamp(43, 46);
  F.sink(40, 46);
  F.table(46, 37);
  F.picture(40, 36);

  // ══ 值夜室 ════════════════════════════════════════════════════════
  F.carpet(51, 38, 54, 44);
  // Keep the surviving backrest, relocated away from the wall edge.
  F.put(55, 36, 'sofaBack', { rotation: Math.PI / 2 });
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
 * 布局直接写入 canonical placement metadata。
 */
function layoutLevel03(F) {

  // ══ 导播室（北翼西，x=22..31 z=8..16）════════════════════════════════
  F.carpet(24, 9, 30, 15);
  F.row(24, 9, 3, 'counter', 'x');   // 控制台
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
  F.rect(36, 13, 37, 13, 'table');
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
  F.row(9, 32, 2, 'counter', 'x');
  F.sink(11, 32);
  F.cabinet(9, 27);
  F.plant(18, 32);

  // ══ 发射机房（东脊北，x=46..55 z=19..24）════════════════════════════
  F.bookWall(46, 20, 3, 'z', 'shelf');
  F.shelves([[47, 20], [47, 21], [47, 22]]);
  F.crates([[53, 21], [54, 21], [53, 23]]);
  F.lamp(54, 23);
  F.picture(46, 19);

  // ══ 器材库（东脊南，x=46..55 z=27..33）══════════════════════════════
  F.bookWall(46, 28, 3, 'z', 'shelf');
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
  F.row(36, 37, 4, 'counter', 'x');   // 服务器台面
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

function addFurnitureModel(meshes, colliders, item) {
  const { id, x, y, z, w, d, rotation = 0 } = item;
  const boundsW = item.boundsW ?? (Math.abs(Math.cos(rotation)) > 0.5 ? w : d);
  const boundsD = item.boundsD ?? (Math.abs(Math.cos(rotation)) > 0.5 ? d : w);
  const height = item.height ?? item.boundsH ?? FURN_HEIGHT[id] ?? 1;
  const openable = item.openable === true || OPENABLE_FURNITURE[id]?.leaves > 0;
  const model = buildFurniture(id, { w, d, height, openable });
  model.position.set(x + boundsW / 2, y, z + boundsD / 2);
  model.rotation.y = rotation;
  const bounds = [x, y, z, boundsW, height, boundsD];
  const metadata = Object.assign(item, {
    bounds, boundsW, boundsD, boundsH: height, openable,
    open: false,
    opaque: item.opaque === true,
    collidable: item.collidable !== false,
  });
  model.userData.furniture = metadata;
  if (openable && model.userData.openable) {
    model.userData.openable.placement = metadata;
  }
  meshes.push(model);
  if (metadata.collidable) colliders.push(metadata);
  return model;
}

function buildFurnitureResult(placements, levelName) {
  const meshes = [];
  const colliders = [];
  for (const item of placements) addFurnitureModel(meshes, colliders, item);
  const group = new THREE.Group();
  group.name = `furniture-${levelName}`;
  meshes.forEach((mesh) => group.add(mesh));
  return { placements, meshes, group, colliders };
}

function placementInBox(item, x0, y0, z0, x1, y1, z1) {
  const boundsW = item.boundsW ?? item.w ?? 1;
  const boundsD = item.boundsD ?? item.d ?? 1;
  const boundsH = item.boundsH ?? item.height ?? FURN_HEIGHT[item.id] ?? 1;
  return item.x < x1 + 1 && item.x + boundsW > x0 &&
    item.y < y1 + 1 && item.y + boundsH > y0 &&
    item.z < z1 + 1 && item.z + boundsD > z0;
}

/** Pure metadata equivalent of the old door clearing pass. */
export function clearDoorways(placements, doors = [], doorH = 2) {
  if (!Array.isArray(placements)) return [];
  const doorList = Array.isArray(doors) ? doors : [];
  const kept = placements.filter((item) => !doorList.some((d) => {
    const spanX = 2 + (d.through === 'x' ? d.thick : 0);
    const spanZ = 2 + (d.through === 'z' ? d.thick : 0);
    return placementInBox(item, d.x - 2, d.y, d.z - 2,
      d.x + spanX, d.y + doorH - 1, d.z + spanZ);
  }));
  placements.splice(0, placements.length, ...kept);
  return placements;
}

/** Pure metadata equivalent of the old spawn clearing pass. */
export function clearSpawn(placements, spawn, y0 = 1) {
  if (!Array.isArray(placements) || !spawn) return placements ?? [];
  const sx = Math.floor(spawn.x), sz = Math.floor(spawn.z);
  const kept = placements.filter((item) => !placementInBox(item, sx - 2, y0, sz - 2,
    sx + 2, y0 + 2, sz + 2));
  placements.splice(0, placements.length, ...kept);
  return placements;
}

/** Apply both canonical clear passes before any mesh or collider is built. */
export function pruneFurniturePlacements(placements, doors = [], spawn = null, doorH = 2, y0 = 1) {
  clearDoorways(placements, doors, doorH);
  clearSpawn(placements, spawn, y0);
  return placements;
}

function furnishCanonical(w, y, layout, levelName, doors, spawn) {
  if (!w) return buildFurnitureResult([], levelName);
  const placements = [];
  const writer = createPlacementWriter(w, y, placements);
  layout(writer);
  pruneFurniturePlacements(placements, doors, spawn, 2, y);
  return buildFurnitureResult(placements, levelName);
}

/** Return canonical placement metadata, meshes and collision bounds for level 01. */
export function furnishLevel01(w, y = 1, doors = [], spawn = null) {
  return furnishCanonical(w, y, layoutLevel01, 'level01', doors, spawn);
}

/** Return canonical placement metadata, meshes and collision bounds for level 02. */
export function furnishLevel02(w, y = 1, doors = [], spawn = null) {
  return furnishCanonical(w, y, layoutLevel02, 'level02', doors, spawn);
}

/** Return canonical placement metadata, meshes and collision bounds for level 03. */
export function furnishLevel03(w, y = 1, doors = [], spawn = null) {
  return furnishCanonical(w, y, layoutLevel03, 'level03', doors, spawn);
}
