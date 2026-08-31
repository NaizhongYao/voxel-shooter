import * as THREE from 'three';
import { buildWeapon, buildGrenade, buildMedkit } from './improved.js';
import { VERTEX_MAT, GLOW_MAT } from './kit.js';

const MUZZLE_Z = {
  pistol: -0.44,
  pistolFast: -0.36,
  smg: -0.45,
  shotgun: -0.95,
  ar: -0.78,
  dmr: -1.05,
};

function resolveWeaponId(spec) {
  return typeof spec === 'string' ? spec : spec?.id ?? 'pistol';
}

/**
 * 构建改进版武器，并保留旧调用方需要的枪口对象。
 *
 * improved.buildWeapon() 的枪口是数值 muzzleZ；rig.js 仍通过
 * userData.muzzle 这个 Object3D 读取世界坐标，所以这里将数值适配成
 * 同一局部坐标系下的标记对象。握把、支撑点、锚点和部件统计直接沿用
 * improved.js 的 userData，保证角色 IK 与调试数据不丢失。
 */
export function buildGunModel(weaponId = 'pistol') {
  const id = resolveWeaponId(weaponId);
  const root = buildWeapon(id);
  const muzzleZ = Number.isFinite(root.userData.muzzleZ)
    ? root.userData.muzzleZ
    : MUZZLE_Z.pistol;
  const muzzle = new THREE.Object3D();
  muzzle.name = 'muzzle';
  muzzle.position.set(0, 0.05, muzzleZ);
  root.add(muzzle);
  root.name = `gun-${id}`;
  root.userData.muzzle = muzzle;
  root.userData.muzzleZ = muzzleZ;
  root.userData.partCount ??= 0;
  return root;
}

export function buildGrenadeModel(kind = 'flash') {
  const root = buildGrenade(kind);
  root.name = `nade-${kind}`;
  return root;
}

export function buildMedkitModel() {
  const root = buildMedkit();
  root.name = 'medkit';
  return root;
}

export function muzzleLocalZ(weaponId = 'pistol') {
  return MUZZLE_Z[resolveWeaponId(weaponId)] ?? MUZZLE_Z.pistol;
}

/**
 * 释放模型树占用的 GPU 资源。
 *
 * 改进版模型的几何体是每次合并生成的，可以逐个释放；实体和自发光
 * 材质则由 kit.js 全局共享，不能在换枪时销毁，否则后续模型会失去材质。
 */
export function disposeModel(root) {
  root.traverse((obj) => {
    if (!obj.isMesh) return;
    const mats = Array.isArray(obj.material) ? obj.material : [obj.material];
    for (const m of mats) {
      if (m !== VERTEX_MAT && m !== GLOW_MAT) m?.dispose?.();
    }
    obj.geometry?.dispose?.();
  });
}
