/**
 * 改进版模型（合并mesh + 顶点色 + 精细部件）
 *
 * 与原基线版的三点根本差异：
 *   1. 层次：每把枪 4~6 个方块 → 18~26 个部件（枪管/护木/弹匣/瞄具/枪托/握把分工明确）
 *   2. 合并：整把枪压成 1 个 mesh，角色按部位压成 ~10 个 mesh，顶点色代替逐部件材质
 *   3. 姿态：两骨 IK 让手真正落在握把上（基线版整块转 -1.15 rad，手甩在身后）
 *
 * 体素感保留：枪管用 8 边棱柱，机身仍是方块，没有引入任何曲面。
 *
 * 来源：experimental-drafts/src/improved.js (2026-08-30)
 */

import * as THREE from 'three';
import { P, buildGroup, solveArm } from './kit.js';

const M = {
  metalDark: 0x15191f,
  metal: 0x242b34,
  metalLite: 0x3a4450,
  poly: 0x2c323a,
  polyLite: 0x3d454f,
  grip: 0x1d2229,
  wood: 0x6b5238,
  woodDark: 0x4a3826,
  glassLit: 0x3d8bab,
};

/** 每把枪的专属 accent 色。基线版里 PALETTE 没有这六个键，六把枪全退化成同一个灰 */
export const WEAPON_ACCENT = {
  pistol: 0xc7cfd8,
  pistolFast: 0xe0b64a,
  smg: 0x4cc9f0,
  shotgun: 0xc98a3c,
  ar: 0x6f8f5f,
  dmr: 0xa78bfa,
};

const CYL = [Math.PI / 2, 0, 0];

// ────────────────────────────── 武器 ──────────────────────────────

function pistolParts(A) {
  return {
    muzzleZ: -0.44,
    gripLocal: [0, -0.10, 0.09],
    supportLocal: [0, -0.07, -0.05],
    anchor: [0.10, 1.12, -0.24],
    parts: [
      P('cyl8', [0.086, 0.30, 0.086], [0, 0.05, -0.26], M.metalDark, CYL),
      P('cyl8', [0.072, 0.06, 0.072], [0, 0.05, -0.42], M.metal, CYL),
      P('box', [0.074, 0.088, 0.30], [0, 0.055, -0.03], M.metal),
      P('box', [0.078, 0.020, 0.09], [0, 0.055, 0.08], A),
      P('box', [0.066, 0.055, 0.26], [0, 0.0, -0.01], M.poly),
      P('box', [0.062, 0.045, 0.10], [0, -0.02, -0.15], M.metalDark),
      P('box', [0.062, 0.20, 0.11], [0, -0.11, 0.09], M.grip, [-0.22, 0, 0]),
      P('box', [0.013, 0.11, 0.092], [0.033, -0.11, 0.088], A, [-0.22, 0, 0]),
      P('box', [0.013, 0.11, 0.092], [-0.033, -0.11, 0.088], A, [-0.22, 0, 0]),
      P('box', [0.066, 0.10, 0.05], [0, -0.09, 0.16], M.grip, [-0.16, 0, 0]),
      P('box', [0.050, 0.14, 0.085], [0, -0.19, 0.06], M.metalDark, [-0.10, 0, 0]),
      P('box', [0.056, 0.030, 0.10], [0, -0.262, 0.045], A, [-0.10, 0, 0]),
      P('box', [0.018, 0.055, 0.10], [0, -0.045, 0.03], M.metal, [0.30, 0, 0]),
      P('box', [0.014, 0.036, 0.014], [0, -0.042, -0.005], M.metalDark),
      P('box', [0.014, 0.026, 0.014], [0, 0.115, -0.16], M.metalLite),
      P('box', [0.050, 0.026, 0.018], [0, 0.112, 0.10], M.metalLite),
    ],
  };
}

function pistolFastParts(A) {
  return {
    muzzleZ: -0.36,
    gripLocal: [0, -0.10, 0.08],
    supportLocal: [0, -0.06, -0.04],
    anchor: [0.10, 1.12, -0.22],
    parts: [
      P('box', [0.070, 0.078, 0.09], [0, 0.05, -0.24], M.metalDark),
      P('box', [0.050, 0.016, 0.05], [0, 0.096, -0.24], M.metal),
      P('cyl8', [0.044, 0.05, 0.044], [0, 0.05, -0.30], M.metal, CYL),
      P('box', [0.074, 0.088, 0.26], [0, 0.05, -0.05], M.metal),
      P('box', [0.078, 0.020, 0.10], [0, 0.05, 0.03], A),
      P('box', [0.066, 0.055, 0.24], [0, 0.0, -0.03], M.poly),
      P('box', [0.062, 0.19, 0.11], [0, -0.105, 0.08], M.grip, [-0.20, 0, 0]),
      P('box', [0.013, 0.10, 0.092], [0.033, -0.105, 0.078], A, [-0.20, 0, 0]),
      P('box', [0.013, 0.10, 0.092], [-0.033, -0.105, 0.078], A, [-0.20, 0, 0]),
      P('box', [0.052, 0.20, 0.09], [0, -0.24, 0.05], M.metalDark, [-0.06, 0, 0]),
      P('box', [0.060, 0.035, 0.105], [0, -0.342, 0.035], A, [-0.06, 0, 0]),
      P('box', [0.018, 0.055, 0.10], [0, -0.042, 0.02], M.metal, [0.30, 0, 0]),
      P('box', [0.014, 0.036, 0.014], [0, -0.04, -0.01], M.metalDark),
      P('box', [0.014, 0.034, 0.014], [0, 0.118, -0.14], M.metalLite),
      P('box', [0.052, 0.030, 0.020], [0, 0.114, 0.08], M.metalLite),
    ],
  };
}

function smgParts(A) {
  return {
    muzzleZ: -0.45,
    gripLocal: [0, -0.11, 0.13],
    supportLocal: [0, -0.02, -0.22],
    anchor: [0.16, 1.12, -0.28],
    parts: [
      P('box', [0.085, 0.125, 0.42], [0, 0.045, 0.0], M.poly),
      P('box', [0.060, 0.022, 0.34], [0, 0.115, -0.02], M.metalLite),
      P('box', [0.050, 0.055, 0.09], [0, 0.150, -0.05], M.metalDark),
      P('cyl8', [0.032, 0.20, 0.032], [0, 0.05, -0.32], M.metalDark, CYL),
      P('box', [0.056, 0.056, 0.14], [0, 0.05, -0.24], M.poly),
      P('box', [0.060, 0.018, 0.030], [0, 0.086, -0.26], M.metalLite),
      P('box', [0.042, 0.14, 0.05], [0, -0.09, -0.22], M.grip, [0.12, 0, 0]),
      P('box', [0.048, 0.26, 0.075], [0, -0.16, 0.06], M.metalDark, [0.10, 0, 0]),
      P('box', [0.056, 0.028, 0.088], [0, -0.29, 0.035], A, [0.10, 0, 0]),
      P('box', [0.055, 0.17, 0.10], [0, -0.11, 0.13], M.grip, [-0.30, 0, 0]),
      P('box', [0.022, 0.022, 0.18], [0.03, -0.01, 0.26], M.metal),
      P('box', [0.022, 0.022, 0.18], [-0.03, -0.01, 0.26], M.metal),
      P('box', [0.085, 0.10, 0.025], [0, -0.01, 0.355], M.metalDark),
      P('box', [0.010, 0.060, 0.16], [0.045, 0.05, 0.02], A),
      P('box', [0.010, 0.060, 0.16], [-0.045, 0.05, 0.02], A),
      P('box', [0.030, 0.020, 0.05], [0.05, 0.09, 0.12], M.metalLite),
    ],
    glow: [P('cyl8', [0.030, 0.012, 0.030], [0, 0.150, -0.096], M.glassLit, CYL)],
  };
}

function shotgunParts(A) {
  return {
    muzzleZ: -0.95,
    gripLocal: [0, -0.12, 0.22],
    supportLocal: [0, -0.01, -0.22],
    anchor: [0.16, 1.14, -0.34],
    parts: [
      P('cyl8', [0.034, 1.05, 0.034], [0.030, 0.055, -0.40], M.metalDark, CYL),
      P('cyl8', [0.034, 1.05, 0.034], [-0.030, 0.055, -0.40], M.metalDark, CYL),
      P('box', [0.104, 0.046, 0.032], [0, 0.055, -0.90], M.metal),
      P('cyl8', [0.030, 0.60, 0.030], [0, -0.015, -0.30], M.metal, CYL),
      P('box', [0.085, 0.115, 0.28], [0, 0.03, 0.10], M.metal),
      P('box', [0.100, 0.095, 0.22], [0, -0.005, -0.24], M.wood),
      P('box', [0.104, 0.020, 0.030], [0, 0.045, -0.24], M.woodDark),
      P('box', [0.104, 0.020, 0.030], [0, 0.045, -0.18], M.woodDark),
      P('box', [0.075, 0.13, 0.28], [0, -0.02, 0.30], M.wood, [-0.10, 0, 0]),
      P('box', [0.085, 0.15, 0.03], [0, -0.06, 0.44], M.grip),
      P('box', [0.060, 0.16, 0.10], [0, -0.12, 0.22], M.wood, [-0.32, 0, 0]),
      P('box', [0.018, 0.055, 0.11], [0, -0.05, 0.10], M.metal, [0.25, 0, 0]),
      P('box', [0.014, 0.036, 0.014], [0, -0.048, 0.04], M.metalDark),
      P('box', [0.012, 0.016, 0.012], [0, 0.105, -0.88], M.metalLite),
      P('box', [0.020, 0.16, 0.10], [0.048, -0.02, 0.30], A),
      P('box', [0.010, 0.09, 0.055], [0.048, 0.02, -0.19], A),
    ],
  };
}

function arParts(A) {
  return {
    muzzleZ: -0.78,
    gripLocal: [0, -0.13, 0.13],
    supportLocal: [0, 0.02, -0.24],
    anchor: [0.16, 1.14, -0.38],
    parts: [
      P('box', [0.082, 0.105, 0.36], [0, 0.06, -0.02], M.metal),
      P('box', [0.078, 0.090, 0.26], [0, -0.03, 0.04], M.poly),
      P('cyl8', [0.026, 0.46, 0.026], [0, 0.06, -0.42], M.metalDark, CYL),
      P('box', [0.040, 0.050, 0.05], [0, 0.10, -0.34], M.metalDark),
      P('box', [0.072, 0.078, 0.30], [0, 0.06, -0.32], M.poly),
      P('box', [0.076, 0.018, 0.026], [0, 0.02, -0.24], A),
      P('box', [0.076, 0.018, 0.026], [0, -0.02, -0.24], A),
      P('cyl8', [0.036, 0.09, 0.036], [0, 0.06, -0.70], M.metalDark, CYL),
      P('box', [0.014, 0.055, 0.26], [0.034, 0.145, -0.02], M.metal),
      P('box', [0.014, 0.055, 0.26], [-0.034, 0.145, -0.02], M.metal),
      P('box', [0.084, 0.018, 0.26], [0, 0.175, -0.02], M.metalLite),
      P('box', [0.050, 0.020, 0.030], [0, 0.192, 0.06], M.metalLite),
      P('box', [0.016, 0.050, 0.016], [0, 0.140, -0.60], M.metalDark),
      P('box', [0.050, 0.080, 0.075], [0, -0.14, 0.02], M.metalDark, [0.10, 0, 0]),
      P('box', [0.050, 0.080, 0.075], [0, -0.215, 0.005], M.metalDark, [0.22, 0, 0]),
      P('box', [0.050, 0.070, 0.075], [0, -0.28, -0.02], A, [0.34, 0, 0]),
      P('box', [0.058, 0.17, 0.10], [0, -0.13, 0.13], M.grip, [-0.34, 0, 0]),
      P('cyl8', [0.032, 0.16, 0.032], [0, 0.03, 0.24], M.metal, CYL),
      P('box', [0.070, 0.13, 0.20], [0, 0.0, 0.38], M.poly),
      P('box', [0.075, 0.14, 0.025], [0, -0.01, 0.485], M.grip),
      P('box', [0.012, 0.040, 0.09], [0.043, 0.06, 0.02], M.metalDark),
      P('box', [0.066, 0.022, 0.10], [0, 0.10, 0.30], A),
    ],
  };
}

function dmrParts(A) {
  return {
    muzzleZ: -1.05,
    gripLocal: [0, -0.12, 0.15],
    supportLocal: [0, 0.0, -0.26],
    anchor: [0.16, 1.14, -0.34],
    parts: [
      P('box', [0.088, 0.115, 0.42], [0, 0.045, 0.0], M.metal),
      P('cyl8', [0.024, 0.86, 0.024], [0, 0.055, -0.58], M.metalDark, CYL),
      P('cyl8', [0.038, 0.10, 0.038], [0, 0.055, -1.00], M.metalDark, CYL),
      P('box', [0.070, 0.075, 0.34], [0, 0.04, -0.36], M.poly),
      P('cyl8', [0.050, 0.30, 0.050], [0, 0.185, -0.22], M.metalDark, CYL),
      P('cyl8', [0.058, 0.06, 0.058], [0, 0.185, -0.38], M.metal, CYL),
      P('cyl8', [0.052, 0.05, 0.052], [0, 0.185, -0.07], M.metal, CYL),
      P('box', [0.09, 0.055, 0.035], [0, 0.12, -0.28], M.metal),
      P('box', [0.09, 0.055, 0.035], [0, 0.12, -0.12], M.metal),
      P('box', [0.014, 0.26, 0.014], [0.055, -0.20, -0.62], M.metalDark, [0.25, 0.35, 0]),
      P('box', [0.014, 0.26, 0.014], [-0.055, -0.20, -0.62], M.metalDark, [0.25, -0.35, 0]),
      P('box', [0.05, 0.05, 0.06], [0, -0.02, -0.66], M.metal),
      P('box', [0.050, 0.13, 0.08], [0, -0.12, 0.06], M.metalDark, [0.06, 0, 0]),
      P('box', [0.056, 0.026, 0.085], [0, -0.185, 0.03], A, [0.06, 0, 0]),
      P('box', [0.056, 0.17, 0.10], [0, -0.12, 0.15], M.grip, [-0.30, 0, 0]),
      P('box', [0.075, 0.14, 0.26], [0, 0.0, 0.26], M.poly, [-0.06, 0, 0]),
      P('box', [0.070, 0.07, 0.15], [0, 0.105, 0.24], M.polyLite),
      P('box', [0.080, 0.15, 0.03], [0, -0.02, 0.40], M.grip),
      P('box', [0.020, 0.10, 0.09], [0.048, 0.02, 0.22], A),
    ],
    glow: [P('cyl8', [0.046, 0.010, 0.046], [0, 0.185, -0.408], M.glassLit, CYL)],
  };
}

const WEAPON_BUILDERS = {
  pistol: pistolParts,
  pistolFast: pistolFastParts,
  smg: smgParts,
  shotgun: shotgunParts,
  ar: arParts,
  dmr: dmrParts,
};

/** 造一把枪：整把合并成 1 个 mesh（+ 瞄具镜片的自发光 mesh） */
export function buildWeapon(id = 'pistol') {
  const spec = (WEAPON_BUILDERS[id] || pistolParts)(WEAPON_ACCENT[id] ?? 0xc7cfd8);
  const g = buildGroup({ parts: spec.parts, glow: spec.glow });
  g.userData.muzzleZ = spec.muzzleZ;
  g.userData.gripLocal = spec.gripLocal;
  g.userData.supportLocal = spec.supportLocal;
  g.userData.anchor = spec.anchor;
  g.userData.partCount = spec.parts.length + (spec.glow ? spec.glow.length : 0);
  return g;
}

// ────────────────────────────── 道具 ──────────────────────────────

export function buildGrenade(kind = 'flash') {
  const he = kind === 'he';
  const body = he ? 0x55663f : 0xd8dee8;
  const ridge = he ? 0x3a4a2c : 0xa8b0bd;
  const cap = he ? 0x2a3322 : 0x8b93a3;
  return buildGroup({
    parts: [
      P('cyl6', [0.17, 0.22, 0.17], [0, 0, 0], body),
      P('cyl6', [0.188, 0.028, 0.188], [0, 0.055, 0], ridge),
      P('cyl6', [0.188, 0.028, 0.188], [0, -0.055, 0], ridge),
      P('cyl6', [0.09, 0.05, 0.09], [0, 0.135, 0], cap),
      P('box', [0.05, 0.028, 0.16], [0.09, 0.152, 0], 0x9aa3ad),
      P('cyl8', [0.05, 0.014, 0.05], [0.145, 0.16, 0], 0xc0c7cf, [Math.PI / 2, 0, 0]),
      P('box', [0.03, 0.03, 0.03], [0.10, 0.10, 0.06], cap),
    ],
    glow: he ? [] : [P('cyl6', [0.176, 0.05, 0.176], [0, 0.03, 0], 0xf2f6ff)],
  });
}

export function buildMedkit() {
  const white = 0xeef1ec;
  const gray = 0x39414d;
  const red = 0x3fb96f;
  return buildGroup({
    parts: [
      P('box', [0.38, 0.20, 0.28], [0, -0.02, 0], white),
      P('box', [0.40, 0.09, 0.30], [0, 0.09, 0], white),
      P('box', [0.412, 0.022, 0.312], [0, 0.045, 0], gray),
      P('box', [0.22, 0.022, 0.07], [0, 0.142, 0], red),
      P('box', [0.07, 0.022, 0.18], [0, 0.142, 0], red),
      P('box', [0.16, 0.05, 0.03], [0, 0.075, -0.155], gray),
      P('box', [0.05, 0.07, 0.03], [0.13, 0.075, -0.152], 0x22282f),
      P('box', [0.05, 0.07, 0.03], [-0.13, 0.075, -0.152], 0x22282f),
      P('box', [0.05, 0.05, 0.05], [0.185, -0.11, 0.13], gray),
      P('box', [0.05, 0.05, 0.05], [-0.185, -0.11, 0.13], gray),
      P('box', [0.05, 0.05, 0.05], [0.185, -0.11, -0.13], gray),
      P('box', [0.05, 0.05, 0.05], [-0.185, -0.11, -0.13], gray),
    ],
  });
}

// ────────────────────────────── 人物 ──────────────────────────────

const B = {
  headPivotY: 1.44,
  head: { s: [0.40, 0.38, 0.38], p: [0, 0.19, 0] },
  neck: { s: [0.16, 0.12, 0.16], p: [0, -0.05, 0] },
  chest: { s: [0.62, 0.44, 0.34], p: [0, 1.16, 0] },
  waist: { s: [0.52, 0.28, 0.30], p: [0, 0.84, 0] },
  shoulderY: 1.32,
  shoulderX: 0.22,
  L1: 0.34,
  L2: 0.42,
  upper: { s: [0.17, 0.34, 0.17], p: [0, -0.17, 0] },
  forearm: { s: [0.15, 0.34, 0.15], p: [0, -0.17, 0] },
  hand: { s: [0.16, 0.16, 0.18], p: [0, -0.42, 0] },
  hipY: 0.76,
  hipX: 0.15,
  thigh: { s: [0.24, 0.32, 0.26], p: [0, -0.16, 0] },
  shin: { s: [0.21, 0.30, 0.23], p: [0, -0.47, 0] },
  boot: { s: [0.25, 0.14, 0.34], p: [0, -0.69, 0.04] },
};

const GEAR = {
  gear: 0x39414d,
  gearLite: 0x4a5462,
  boot: 0x3a3128,
  armor: 0x5a6678,
  steel: 0x4d5763,
  dark: 0x22282f,
};

/** 8 套护甲配色（与 rig.js 的 ARMOR_KIT_COLORS 一致） */
export const ARMOR_KIT_COLORS = {
  light: 0xb7c0c9,
  standard: 0x5e86c4,
  heavy: 0x8b7fb8,
  ghost: 0x7fd0d8,
  runner: 0xd4c24a,
  carrier: 0x8b9a6e,
  chameleon: 0x5aa68c,
  dualist: 0xb85e8e,
};

export const ENEMY_KITS = {
  sentry: { label: '哨兵', body: 0xe5484d, weapon: 'ar' },
  patroller: { label: '巡逻者', body: 0xe5484d, weapon: 'smg' },
  ambusher: { label: '伏击者', body: 0xa3353c, weapon: 'shotgun' },
  rusher: { label: '冲锋手', body: 0xf2705a, weapon: 'shotgun' },
  armored: { label: '武装精英', body: 0xe5484d, weapon: 'ar' },
  shield: { label: '重甲盾兵', body: 0xe5484d, weapon: 'smg' },
};

function tones(hex) {
  const c = new THREE.Color(hex);
  return {
    main: c.getHex(),
    skin: c.clone().multiplyScalar(0.9).getHex(),
    accent: c.clone().multiplyScalar(0.8).getHex(),
    helm: c.clone().multiplyScalar(0.64).getHex(),
  };
}

/**
 * 8 套护甲各自的剪影。
 *
 * 现状是「8 套共享几何、只有背心换个颜色」—— 结果多套护甲互相长得一模一样，
 * 而且头、躯干、四肢根本不参与换色。这里给每套一套独立的头部 / 躯干 / 腿部挂件，
 * 目标是只看轮廓也能认出是哪一套。
 *
 * head(tones)  → { parts, glow }   坐标相对 headPivot
 * torso(tones) → { parts, glow }   坐标 = 身体局部坐标（脚底为 0）
 * leg(tones, side) → parts         side: -1 左 / +1 右，坐标相对腿 pivot
 */
export const ARMOR_VARIANTS = {
  light: {
    label: '幽影软甲',
    head: (t) => ({
      parts: [
        P('box', [0.42, 0.08, 0.42], [0, 0.29, 0], GEAR.gear),
        P('box', [0.44, 0.10, 0.05], [0, 0.20, -0.185], t.helm),
      ],
      glow: [P('box', [0.34, 0.055, 0.03], [0, 0.20, -0.212], 0x9fe8ff)],
    }),
    torso: (t) => ({
      parts: [
        P('box', [0.50, 0.34, 0.055], [0, 1.14, -0.185], t.main),
        P('box', [0.50, 0.32, 0.05], [0, 1.14, 0.185], t.accent),
        P('box', [0.13, 0.11, 0.08], [-0.27, 1.02, 0.03], t.accent),
        P('box', [0.13, 0.11, 0.08], [0.27, 1.02, 0.03], t.accent),
        P('box', [0.46, 0.06, 0.30], [0, 0.80, 0], GEAR.gear),
      ],
    }),
    leg: () => [],
  },

  standard: {
    label: '标准战术背心',
    head: (t) => ({
      parts: [
        P('box', [0.46, 0.17, 0.46], [0, 0.29, 0], t.helm),
        P('box', [0.48, 0.05, 0.48], [0, 0.235, 0], GEAR.gearLite),
      ],
      glow: [P('box', [0.32, 0.085, 0.03], [0, 0.175, -0.196], 0x8fd8ff)],
    }),
    torso: (t) => ({
      parts: [
        P('box', [0.56, 0.42, 0.10], [0, 1.16, -0.185], t.main),
        P('box', [0.56, 0.40, 0.08], [0, 1.16, 0.185], t.accent),
        P('box', [0.14, 0.13, 0.09], [-0.15, 1.02, -0.195], t.accent),
        P('box', [0.14, 0.13, 0.09], [0, 1.02, -0.195], t.accent),
        P('box', [0.14, 0.13, 0.09], [0.15, 1.02, -0.195], t.accent),
        P('box', [0.13, 0.16, 0.10], [-0.29, 1.22, 0.06], GEAR.gear),
        P('box', [0.02, 0.30, 0.02], [-0.31, 1.45, 0.08], GEAR.dark),
        P('box', [0.56, 0.09, 0.34], [0, 0.78, 0], t.accent),
        P('box', [0.24, 0.20, 0.34], [0.30, 1.30, -0.02], t.helm),
        P('box', [0.24, 0.20, 0.34], [-0.30, 1.30, -0.02], t.helm),
      ],
    }),
    leg: () => [],
  },

  heavy: {
    label: '重型防弹板',
    head: (t) => ({
      parts: [
        P('box', [0.50, 0.22, 0.50], [0, 0.27, 0], t.helm),
        P('box', [0.52, 0.06, 0.52], [0, 0.17, 0], GEAR.gear),
        P('box', [0.11, 0.15, 0.06], [0, 0.17, -0.235], GEAR.gear),
      ],
      glow: [P('box', [0.26, 0.055, 0.03], [0, 0.19, -0.218], 0xbfe4ff)],
    }),
    torso: (t) => ({
      parts: [
        P('box', [0.68, 0.50, 0.16], [0, 1.14, -0.20], t.main),
        P('box', [0.66, 0.46, 0.12], [0, 1.14, 0.21], t.accent),
        P('box', [0.10, 0.44, 0.34], [0.35, 1.12, 0], t.accent),
        P('box', [0.10, 0.44, 0.34], [-0.35, 1.12, 0], t.accent),
        P('box', [0.32, 0.26, 0.38], [0.32, 1.32, -0.02], t.main),
        P('box', [0.32, 0.26, 0.38], [-0.32, 1.32, -0.02], t.main),
        P('box', [0.58, 0.10, 0.40], [0, 0.78, 0], GEAR.gear),
      ],
    }),
    leg: (t) => [P('box', [0.26, 0.14, 0.13], [0, -0.34, -0.14], t.accent)],
  },

  ghost: {
    label: '幽灵作战服',
    head: (t) => ({
      parts: [
        P('box', [0.48, 0.30, 0.48], [0, 0.21, -0.02], t.helm),
        P('box', [0.42, 0.09, 0.05], [0, 0.17, -0.215], GEAR.dark),
      ],
      glow: [P('box', [0.32, 0.05, 0.03], [0, 0.17, -0.238], 0xa8f0ff)],
    }),
    torso: (t) => ({
      parts: [
        P('box', [0.52, 0.40, 0.07], [0, 1.15, -0.18], t.main),
        P('box', [0.52, 0.38, 0.06], [0, 1.15, 0.18], t.accent),
        P('box', [0.13, 0.52, 0.07], [-0.10, 1.14, -0.20], t.accent, [0, 0, 0.42]),
        P('box', [0.02, 0.22, 0.02], [0.24, 1.46, 0.10], GEAR.dark),
        P('box', [0.46, 0.07, 0.30], [0, 0.80, 0], GEAR.dark),
      ],
    }),
    leg: () => [P('box', [0.16, 0.10, 0.10], [0.09, -0.30, -0.10], GEAR.gear)],
  },

  runner: {
    label: '斥候轻装',
    head: (t) => ({
      parts: [
        P('box', [0.42, 0.07, 0.42], [0, 0.27, 0], t.main),
        P('box', [0.44, 0.09, 0.05], [0, 0.19, -0.185], GEAR.dark),
      ],
      glow: [P('box', [0.34, 0.05, 0.03], [0, 0.19, -0.212], 0xffe9a8)],
    }),
    torso: (t) => ({
      parts: [
        P('box', [0.44, 0.24, 0.06], [0, 1.20, -0.185], t.main),
        P('box', [0.40, 0.36, 0.16], [0, 1.16, 0.26], t.accent),
        P('box', [0.42, 0.05, 0.06], [0, 1.32, -0.18], t.accent),
        P('box', [0.44, 0.06, 0.28], [0, 0.80, 0], GEAR.dark),
      ],
    }),
    leg: (t, side) => (side > 0
      ? [P('box', [0.14, 0.22, 0.16], [0.10, -0.34, 0.02], GEAR.gear)]
      : []),
  },

  carrier: {
    label: '携行装具',
    head: (t) => ({
      parts: [
        P('box', [0.42, 0.12, 0.42], [0, 0.31, 0], t.helm),
        P('box', [0.56, 0.035, 0.56], [0, 0.25, -0.02], GEAR.gear),
      ],
      glow: [],
    }),
    torso: (t) => ({
      parts: [
        P('box', [0.26, 0.18, 0.09], [-0.13, 1.24, -0.19], t.accent),
        P('box', [0.26, 0.18, 0.09], [0.13, 1.24, -0.19], t.accent),
        P('box', [0.26, 0.18, 0.09], [-0.13, 1.04, -0.19], t.accent),
        P('box', [0.26, 0.18, 0.09], [0.13, 1.04, -0.19], t.accent),
        P('box', [0.50, 0.52, 0.26], [0, 1.16, 0.30], t.main),
        P('box', [0.54, 0.12, 0.30], [0, 1.42, 0.31], t.accent),
        P('box', [0.26, 0.26, 0.26], [0.30, 0.80, 0.08], GEAR.gear),
        P('box', [0.50, 0.09, 0.32], [0, 0.78, 0], GEAR.gear),
      ],
    }),
    leg: () => [],
  },

  chameleon: {
    label: '光学迷彩服',
    head: (t) => ({
      parts: [
        P('box', [0.46, 0.26, 0.46], [0, 0.22, -0.01], t.helm),
        P('box', [0.48, 0.10, 0.48], [0, 0.08, -0.01], t.accent),
      ],
      glow: [P('box', [0.36, 0.07, 0.03], [0, 0.18, -0.222], 0x8affd8)],
    }),
    torso: (t) => ({
      parts: [
        P('box', [0.54, 0.30, 0.08], [0, 1.24, -0.18], t.main),
        P('box', [0.50, 0.22, 0.07], [0, 0.98, -0.19], t.main),
        P('box', [0.54, 0.40, 0.07], [0, 1.14, 0.19], t.accent),
        P('box', [0.20, 0.16, 0.30], [0.30, 1.32, -0.02], t.main),
        P('box', [0.20, 0.16, 0.30], [-0.30, 1.32, -0.02], t.main),
        P('box', [0.46, 0.07, 0.30], [0, 0.80, 0], GEAR.dark),
      ],
      glow: [
        P('box', [0.08, 0.05, 0.08], [0.30, 1.41, -0.06], 0x8affd8),
        P('box', [0.08, 0.05, 0.08], [-0.30, 1.41, -0.06], 0x8affd8),
      ],
    }),
    leg: () => [],
  },

  dualist: {
    label: '双枪战术甲',
    head: (t) => ({
      parts: [
        P('box', [0.44, 0.13, 0.30], [0, 0.31, 0.04], t.helm),
        P('box', [0.44, 0.10, 0.05], [0, 0.20, -0.185], GEAR.dark),
      ],
      glow: [P('box', [0.34, 0.05, 0.03], [0, 0.20, -0.212], 0xffb8dc)],
    }),
    torso: (t) => ({
      parts: [
        P('box', [0.12, 0.44, 0.26], [0.20, 1.20, -0.02], t.accent),
        P('box', [0.12, 0.44, 0.26], [-0.20, 1.20, -0.02], t.accent),
        P('box', [0.40, 0.24, 0.06], [0, 1.16, -0.185], t.main),
        P('box', [0.11, 0.56, 0.05], [0, 1.14, -0.195], t.main, [0, 0, 0.55]),
        P('box', [0.11, 0.56, 0.05], [0, 1.14, -0.195], t.main, [0, 0, -0.55]),
        P('box', [0.44, 0.07, 0.30], [0, 0.80, 0], GEAR.dark),
      ],
    }),
    leg: () => [P('box', [0.15, 0.24, 0.17], [0.10, -0.34, 0.02], GEAR.gear)],
  },
};

/** 头部的 kit 挂件（坐标相对 headPivot） */
function headKit(kind, t) {
  const parts = [];
  const glow = [];
  if (kind === 'player' || kind === 'armored') {
    parts.push(P('box', [0.46, 0.17, 0.46], [0, 0.29, 0], t.helm));
    parts.push(P('box', [0.48, 0.05, 0.48], [0, 0.235, 0], GEAR.gearLite));
    glow.push(P('box', [0.32, 0.085, 0.03], [0, 0.175, -0.196], 0x8fd8ff));
  } else if (kind === 'shield') {
    parts.push(P('box', [0.50, 0.24, 0.50], [0, 0.26, 0], GEAR.steel));
    parts.push(P('box', [0.52, 0.06, 0.52], [0, 0.16, 0], GEAR.gear));
    glow.push(P('box', [0.34, 0.075, 0.03], [0, 0.185, -0.20], 0xffc98f));
  } else if (kind === 'patroller') {
    parts.push(P('box', [0.42, 0.13, 0.42], [0, 0.30, 0], GEAR.gear));
    parts.push(P('box', [0.40, 0.04, 0.22], [0, 0.245, -0.28], GEAR.gear));
  } else if (kind === 'ambusher') {
    parts.push(P('box', [0.50, 0.30, 0.50], [0, 0.22, -0.02], GEAR.gear));
    parts.push(P('box', [0.44, 0.10, 0.06], [0, 0.16, -0.22], GEAR.dark));
  } else if (kind === 'rusher') {
    parts.push(P('box', [0.42, 0.07, 0.42], [0, 0.27, 0], 0xd94f3d));
    glow.push(P('box', [0.34, 0.09, 0.04], [0, 0.19, -0.19], 0xffd98a));
  } else {
    parts.push(P('box', [0.44, 0.14, 0.44], [0, 0.30, 0], GEAR.gear));
    glow.push(P('box', [0.30, 0.08, 0.03], [0, 0.18, -0.195], 0xffb0a8));
  }
  return { parts, glow };
}

/** 躯干的 kit 挂件（坐标 = 身体局部坐标，脚底为 0） */
function torsoKit(kind, t) {
  const parts = [];
  const pads = (color, size, y) => {
    parts.push(P('box', size, [0.30, y, -0.02], color));
    parts.push(P('box', size, [-0.30, y, -0.02], color));
  };
  if (kind === 'player') {
    parts.push(P('box', [0.56, 0.42, 0.10], [0, 1.16, -0.185], t.main));
    parts.push(P('box', [0.56, 0.40, 0.08], [0, 1.16, 0.185], t.accent));
    for (const x of [-0.15, 0, 0.15]) {
      parts.push(P('box', [0.14, 0.13, 0.09], [x, 1.02, -0.195], t.accent));
    }
    parts.push(P('box', [0.13, 0.16, 0.10], [-0.29, 1.22, 0.06], GEAR.gear));
    parts.push(P('box', [0.02, 0.30, 0.02], [-0.31, 1.45, 0.08], GEAR.dark));
    parts.push(P('box', [0.56, 0.09, 0.34], [0, 0.78, 0], t.accent));
    pads(t.helm, [0.24, 0.20, 0.34], 1.30);
  } else if (kind === 'armored') {
    parts.push(P('box', [0.66, 0.50, 0.42], [0, 1.14, 0], GEAR.armor));
    parts.push(P('box', [0.58, 0.30, 0.10], [0, 1.10, -0.23], GEAR.gearLite));
    parts.push(P('box', [0.56, 0.09, 0.36], [0, 0.78, 0], GEAR.gear));
    pads(GEAR.armor, [0.28, 0.24, 0.36], 1.30);
  } else if (kind === 'shield') {
    parts.push(P('box', [0.62, 0.46, 0.38], [0, 1.14, 0], GEAR.steel));
    parts.push(P('box', [0.78, 0.86, 0.16], [0, 1.10, -0.26], GEAR.steel));
    parts.push(P('box', [0.80, 0.10, 0.18], [0, 1.48, -0.27], GEAR.gearLite));
    parts.push(P('box', [0.56, 0.09, 0.36], [0, 0.78, 0], GEAR.gear));
    pads(GEAR.steel, [0.30, 0.26, 0.36], 1.30);
  } else if (kind === 'patroller') {
    parts.push(P('box', [0.54, 0.38, 0.09], [0, 1.14, -0.185], GEAR.gearLite));
    parts.push(P('box', [0.54, 0.36, 0.07], [0, 1.14, 0.185], GEAR.gear));
    parts.push(P('box', [0.13, 0.17, 0.10], [-0.29, 1.20, 0.06], GEAR.gear));
    parts.push(P('box', [0.02, 0.52, 0.02], [-0.31, 1.56, 0.08], GEAR.dark));
    parts.push(P('box', [0.03, 0.06, 0.03], [-0.31, 1.83, 0.08], 0xff6b5e));
    parts.push(P('box', [0.56, 0.09, 0.34], [0, 0.78, 0], GEAR.gear));
    pads(GEAR.gear, [0.22, 0.17, 0.32], 1.29);
  } else if (kind === 'ambusher') {
    parts.push(P('box', [0.66, 0.20, 0.46], [0, 1.33, 0], GEAR.gear));
    parts.push(P('box', [0.50, 0.30, 0.09], [0, 1.08, -0.18], GEAR.dark));
    parts.push(P('box', [0.56, 0.09, 0.34], [0, 0.78, 0], GEAR.dark));
  } else if (kind === 'rusher') {
    parts.push(P('box', [0.46, 0.28, 0.08], [0, 1.18, -0.175], GEAR.gear));
    parts.push(P('box', [0.20, 0.16, 0.10], [-0.24, 1.20, 0.04], GEAR.gear));
    parts.push(P('box', [0.56, 0.08, 0.34], [0, 0.78, 0], GEAR.dark));
  } else {
    parts.push(P('box', [0.52, 0.34, 0.09], [0, 1.15, -0.18], GEAR.gearLite));
    parts.push(P('box', [0.13, 0.15, 0.10], [-0.29, 1.20, 0.06], GEAR.gear));
    parts.push(P('box', [0.56, 0.09, 0.34], [0, 0.78, 0], GEAR.gear));
    pads(GEAR.gear, [0.22, 0.17, 0.32], 1.29);
  }
  return parts;
}

/** 腿部的 kit 挂件（坐标相对腿 pivot） */
function legKit(kind) {
  if (kind === 'armored') return [P('box', [0.24, 0.12, 0.12], [0, -0.34, -0.13], GEAR.armor)];
  if (kind === 'shield') return [P('box', [0.25, 0.13, 0.13], [0, -0.34, -0.13], GEAR.steel)];
  return [];
}

/**
 * 造一个角色。
 * @param {'player'|'sentry'|'patroller'|'ambusher'|'rusher'|'armored'|'shield'} kind
 * @param {{armorId?:string, weapon?:string}} opts
 */
export function buildCharacter(kind = 'player', opts = {}) {
  const isPlayer = kind === 'player';
  const baseHex = isPlayer
    ? (ARMOR_KIT_COLORS[opts.armorId] ?? ARMOR_KIT_COLORS.standard)
    : (ENEMY_KITS[kind]?.body ?? 0xe5484d);
  const t = tones(baseHex);
  const skin = isPlayer ? t.skin : t.main;
  const limb = isPlayer ? t.skin : t.main;

  // 玩家按 armorId 取专属剪影；敌人按原型取 kit
  const spec = isPlayer
    ? (() => {
      const v = ARMOR_VARIANTS[opts.armorId] ?? ARMOR_VARIANTS.standard;
      return { head: v.head(t), torso: v.torso(t), leg: v.leg };
    })()
    : (() => {
      const hk = headKit(kind, t);
      return { head: hk, torso: { parts: torsoKit(kind, t), glow: [] }, leg: () => legKit(kind) };
    })();

  const root = new THREE.Group();
  const body = new THREE.Group();
  root.add(body);

  // 躯干（胸 + 腰分开，出腰线；颈、肩甲、背心、挂件全部合并进这一个 mesh）
  const torsoParts = [
    P('box', B.chest.s, B.chest.p, skin),
    P('box', B.waist.s, B.waist.p, skin),
    P('box', B.neck.s, [0, 1.40, 0], skin),
    ...spec.torso.parts,
  ];
  const torso = buildGroup({ parts: torsoParts, glow: spec.torso.glow });
  body.add(torso);

  // 头（头 + 颈 + 头盔/兜帽 合并；面窗/风镜单独走自发光）
  const headPivot = new THREE.Group();
  headPivot.position.y = B.headPivotY;
  body.add(headPivot);
  const headParts = [P('box', B.head.s, B.head.p, skin), ...spec.head.parts];
  const head = buildGroup({ parts: headParts, glow: spec.head.glow });
  headPivot.add(head);

  // 四肢
  const legs = [];
  for (const side of [-1, 1]) {
    const hip = new THREE.Group();
    hip.position.set(side * B.hipX, B.hipY, 0);
    body.add(hip);
    hip.add(buildGroup({
      parts: [
        P('box', B.thigh.s, B.thigh.p, limb),
        P('box', B.shin.s, B.shin.p, limb),
        P('box', B.boot.s, B.boot.p, GEAR.boot),
        ...spec.leg(t, side),
      ],
    }));
    legs.push(hip);
  }

  // 枪 + 两骨 IK
  const weaponId = opts.weapon || (isPlayer ? 'ar' : (ENEMY_KITS[kind]?.weapon ?? 'ar'));
  const gun = buildWeapon(weaponId);
  const anchor = gun.userData.anchor;
  const gunPivot = new THREE.Group();
  gunPivot.position.set(anchor[0], anchor[1], anchor[2]);
  body.add(gunPivot);
  gunPivot.add(gun);

  const grip = new THREE.Vector3(...anchor).add(new THREE.Vector3(...gun.userData.gripLocal));
  const support = new THREE.Vector3(...anchor).add(new THREE.Vector3(...gun.userData.supportLocal));

  const arms = [];
  for (const side of [-1, 1]) {
    const target = side > 0 ? grip : support;
    const shoulder = new THREE.Vector3(side * B.shoulderX, B.shoulderY, 0);

    const shoulderPivot = new THREE.Group();
    shoulderPivot.position.copy(shoulder);
    shoulderPivot.rotation.order = 'YXZ';
    body.add(shoulderPivot);

    const dx = target.x - shoulder.x;
    const dy = target.y - shoulder.y;
    const dz = target.z - shoulder.z;
    const horiz = Math.hypot(dx, dz);
    const psi = Math.atan2(-dx, -dz);
    const flat = new THREE.Vector2(Math.hypot(dx, dz), dy);

    // 用「肩点到目标的水平/垂直分量」解两骨，再把侧向偏航作为 rotation.y
    const sol = solveArm(
      { y: 0, z: 0 },
      { y: flat.y, z: -flat.x },
      B.L1,
      B.L2,
    );

    shoulderPivot.rotation.y = psi;
    shoulderPivot.rotation.x = sol.upper;
    shoulderPivot.add(buildGroup({ parts: [P('box', B.upper.s, B.upper.p, limb)] }));

    const elbow = new THREE.Group();
    elbow.position.y = -B.L1;
    elbow.rotation.x = sol.lower;
    shoulderPivot.add(elbow);
    elbow.add(buildGroup({
      parts: [
        P('box', B.forearm.s, B.forearm.p, limb),
        P('box', B.hand.s, B.hand.p, kind === 'rusher' ? t.main : GEAR.gear),
      ],
    }));
    arms.push({ shoulderPivot, elbow });
  }

  root.userData = { arms, legs, headPivot, gun, gunPivot, kind, weaponId, grip, support };
  return root;
}
