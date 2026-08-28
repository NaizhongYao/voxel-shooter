import * as THREE from 'three';
import { PALETTE } from '../config.js';

/**
 * 每把枪用多个方块拼外形。持枪、地上掉落共用这一套，
 * 玩家才能从轮廓认出「这是霰弹还是 DMR」，而不是一颗琥珀方块。
 *
 * 局部坐标：枪口朝 -Z，握把在原点附近。
 */
const BOX = new THREE.BoxGeometry(1, 1, 1);
const METAL = 0x1a1e24;
const DARK = 0x11151c;
const WOOD = 0x5a4632;
const POLY = 0x2a3038;

function box(parent, size, color, pos) {
  const m = new THREE.Mesh(BOX, new THREE.MeshLambertMaterial({ color }));
  m.scale.set(size.x, size.y, size.z);
  m.position.set(pos.x, pos.y, pos.z);
  m.castShadow = true;
  parent.add(m);
  return m;
}

export function buildGunModel(weaponId = 'pistol') {
  const root = new THREE.Group();
  root.name = `gun-${weaponId}`;
  const accent = PALETTE[weaponId] ?? 0x9aa7b8;

  if (weaponId === 'shotgun') {
    box(root, { x: 0.10, y: 0.12, z: 1.05 }, METAL, { x: 0, y: 0.04, z: -0.42 });
    box(root, { x: 0.08, y: 0.08, z: 0.85 }, DARK, { x: 0, y: -0.05, z: -0.32 });
    box(root, { x: 0.14, y: 0.16, z: 0.28 }, WOOD, { x: 0, y: 0.02, z: 0.18 });
    box(root, { x: 0.10, y: 0.28, z: 0.12 }, WOOD, { x: 0, y: -0.16, z: 0.28 });
    box(root, { x: 0.16, y: 0.10, z: 0.16 }, accent, { x: 0, y: 0.12, z: 0.02 });
  } else if (weaponId === 'dmr') {
    box(root, { x: 0.09, y: 0.11, z: 1.15 }, METAL, { x: 0, y: 0.05, z: -0.48 });
    box(root, { x: 0.12, y: 0.14, z: 0.32 }, POLY, { x: 0, y: 0.04, z: 0.12 });
    box(root, { x: 0.08, y: 0.26, z: 0.10 }, DARK, { x: 0, y: -0.14, z: 0.22 });
    box(root, { x: 0.10, y: 0.10, z: 0.36 }, DARK, { x: 0, y: 0.16, z: -0.18 });
    box(root, { x: 0.07, y: 0.07, z: 0.22 }, accent, { x: 0, y: 0.22, z: -0.12 });
    box(root, { x: 0.16, y: 0.04, z: 0.22 }, DARK, { x: 0, y: -0.04, z: -0.55 });
  } else if (weaponId === 'ar') {
    box(root, { x: 0.09, y: 0.11, z: 0.95 }, METAL, { x: 0, y: 0.05, z: -0.38 });
    box(root, { x: 0.14, y: 0.16, z: 0.28 }, POLY, { x: 0, y: 0.02, z: 0.10 });
    box(root, { x: 0.08, y: 0.24, z: 0.10 }, DARK, { x: 0, y: -0.14, z: 0.16 });
    box(root, { x: 0.12, y: 0.08, z: 0.30 }, DARK, { x: 0, y: 0.14, z: -0.12 });
    box(root, { x: 0.16, y: 0.18, z: 0.08 }, accent, { x: 0, y: -0.08, z: 0.04 });
    box(root, { x: 0.10, y: 0.10, z: 0.22 }, POLY, { x: 0, y: 0.02, z: 0.32 });
  } else if (weaponId === 'smg') {
    box(root, { x: 0.10, y: 0.12, z: 0.62 }, METAL, { x: 0, y: 0.04, z: -0.22 });
    box(root, { x: 0.14, y: 0.16, z: 0.22 }, POLY, { x: 0, y: 0.02, z: 0.10 });
    box(root, { x: 0.09, y: 0.22, z: 0.10 }, DARK, { x: 0, y: -0.12, z: 0.12 });
    box(root, { x: 0.18, y: 0.16, z: 0.08 }, accent, { x: 0, y: -0.06, z: 0.02 });
    box(root, { x: 0.08, y: 0.08, z: 0.18 }, DARK, { x: 0, y: 0.12, z: -0.08 });
  } else {
    // pistol / pistolFast
    const long = weaponId === 'pistolFast';
    box(root, { x: 0.09, y: 0.11, z: long ? 0.42 : 0.36 }, METAL, { x: 0, y: 0.05, z: -0.12 });
    box(root, { x: 0.10, y: 0.22, z: 0.12 }, DARK, { x: 0, y: -0.10, z: 0.10 });
    box(root, { x: 0.12, y: 0.08, z: 0.16 }, POLY, { x: 0, y: 0.08, z: 0.04 });
    if (weaponId === 'pistol') {
      box(root, { x: 0.12, y: 0.08, z: 0.16 }, accent, { x: 0, y: 0.02, z: -0.28 });
    } else {
      box(root, { x: 0.08, y: 0.08, z: 0.10 }, accent, { x: 0, y: 0.12, z: 0.02 });
    }
  }

  const muzzle = new THREE.Object3D();
  muzzle.position.set(0, 0.05, weaponId === 'dmr' ? -1.12 : weaponId === 'shotgun' ? -1.0 : weaponId === 'ar' ? -0.92 : weaponId === 'smg' ? -0.58 : -0.36);
  root.add(muzzle);
  root.userData.muzzle = muzzle;
  return root;
}

/**
 * 手雷外形：闪光浅灰、高爆橄榄。挂在角色背心与 UI 预览共用，
 * 玩家才能从第一屏认到「进游戏按 3 扔的就是这一颗」。
 */
export function buildGrenadeModel(kind = 'flash') {
  const root = new THREE.Group();
  root.name = `nade-${kind}`;
  const body = kind === 'he' ? 0x4a5a3a : 0xd8dee8;
  const cap = kind === 'he' ? 0x2a3322 : 0x8b93a3;
  box(root, { x: 0.16, y: 0.20, z: 0.16 }, body, { x: 0, y: 0, z: 0 });
  box(root, { x: 0.08, y: 0.06, z: 0.08 }, cap, { x: 0, y: 0.13, z: 0 });
  box(root, { x: 0.14, y: 0.03, z: 0.04 }, 0x2a3038, { x: 0.08, y: 0.12, z: 0 });
  if (kind === 'flash') {
    box(root, { x: 0.05, y: 0.05, z: 0.05 }, 0xffffff, { x: 0, y: 0.04, z: 0.10 });
  }
  return root;
}

export function buildMedkitModel() {
  const root = new THREE.Group();
  root.name = 'medkit';
  const white = 0xf2f4f0;
  const red = PALETTE.good;
  box(root, { x: 0.38, y: 0.22, z: 0.28 }, white, { x: 0, y: 0, z: 0 });
  box(root, { x: 0.22, y: 0.08, z: 0.08 }, red, { x: 0, y: 0.14, z: 0 });
  box(root, { x: 0.08, y: 0.22, z: 0.08 }, red, { x: 0, y: 0.14, z: 0 });
  box(root, { x: 0.40, y: 0.04, z: 0.10 }, 0x2a4a34, { x: 0, y: -0.12, z: 0 });
  return root;
}

export function muzzleLocalZ(weaponId = 'pistol') {
  if (weaponId === 'dmr') return -1.12;
  if (weaponId === 'shotgun') return -1.0;
  if (weaponId === 'ar') return -0.92;
  if (weaponId === 'smg') return -0.58;
  return -0.36;
}
