/**
 * 几何工具库（实验区专用，不进正式游戏）
 *
 * 目标：把「一堆小方块」压成「一个合并 mesh + 顶点色」。
 * 正式游戏里每个部件都是一个独立 Mesh + 一份独立 Material，
 * 一个角色 15~19 个 draw call；合并后按部位只剩 7~8 个，
 * 材质也从「每部件一份」变成全局共享的两份（实体 + 自发光）。
 */

import * as THREE from 'three';
import { mergeGeometries } from 'three/examples/jsm/utils/BufferGeometryUtils.js';

const SHAPES = {
  box: new THREE.BoxGeometry(1, 1, 1),
  cyl6: new THREE.CylinderGeometry(0.5, 0.5, 1, 6, 1),
  cyl8: new THREE.CylinderGeometry(0.5, 0.5, 1, 8, 1),
  cyl12: new THREE.CylinderGeometry(0.5, 0.5, 1, 12, 1),
};

/** 实体材质：全局唯一一份，所有合并 mesh 共用 */
export const VERTEX_MAT = new THREE.MeshLambertMaterial({ vertexColors: true });
/** 自发光材质：面窗、瞄准镜镜片、枪灯这类「自己会亮」的部件 */
export const GLOW_MAT = new THREE.MeshBasicMaterial({ vertexColors: true });

/**
 * 声明一个部件。
 * @param {'box'|'cyl6'|'cyl8'|'cyl12'} shape
 * @param {[number,number,number]} s 尺寸（圆柱 = [直径, 长度, 直径]）
 * @param {[number,number,number]} p 位置
 * @param {number} c 颜色
 * @param {[number,number,number]} [r] 欧拉旋转
 */
export function P(shape, s, p, c, r) {
  return { shape, s, p, c, r: r || null };
}

const _m = new THREE.Matrix4();
const _q = new THREE.Quaternion();
const _e = new THREE.Euler();
const _pos = new THREE.Vector3();
const _scl = new THREE.Vector3();
const _col = new THREE.Color();

/** 把一组部件合并成一个带顶点色的 BufferGeometry */
export function mergeParts(parts) {
  if (!parts || parts.length === 0) return null;
  const geos = parts.map((pt) => {
    const g = SHAPES[pt.shape].clone();
    _pos.set(pt.p[0], pt.p[1], pt.p[2]);
    _scl.set(pt.s[0], pt.s[1], pt.s[2]);
    if (pt.r) {
      _e.set(pt.r[0], pt.r[1], pt.r[2]);
      _q.setFromEuler(_e);
    } else {
      _q.identity();
    }
    _m.compose(_pos, _q, _scl);
    g.applyMatrix4(_m);
    g.deleteAttribute('uv');
    _col.setHex(pt.c);
    const n = g.attributes.position.count;
    const arr = new Float32Array(n * 3);
    for (let i = 0; i < n; i++) {
      arr[i * 3] = _col.r;
      arr[i * 3 + 1] = _col.g;
      arr[i * 3 + 2] = _col.b;
    }
    g.setAttribute('color', new THREE.BufferAttribute(arr, 3));
    return g;
  });
  const merged = mergeGeometries(geos, false);
  geos.forEach((g) => g.dispose());
  if (!merged) throw new Error('mergeParts 失败：部件属性不一致');
  return merged;
}

/**
 * 由部件清单生成一个 Group（最多两个 mesh：实体 + 自发光）。
 * @param {{parts?:Array, glow?:Array}} spec
 */
export function buildGroup(spec) {
  const g = new THREE.Group();
  if (spec.parts && spec.parts.length) {
    const m = new THREE.Mesh(mergeParts(spec.parts), VERTEX_MAT);
    m.castShadow = true;
    m.name = 'body';
    g.add(m);
  }
  if (spec.glow && spec.glow.length) {
    const m = new THREE.Mesh(mergeParts(spec.glow), GLOW_MAT);
    m.name = 'glow';
    g.add(m);
  }
  return g;
}

/** 统计一个 Object3D 的 mesh 数 / 材质数 / 三角面数 */
export function stats(obj) {
  let meshes = 0;
  let tris = 0;
  const mats = new Set();
  obj.traverse((o) => {
    if (!o.isMesh) return;
    meshes++;
    mats.add(o.material);
    const g = o.geometry;
    tris += g.index ? g.index.count / 3 : g.attributes.position.count / 3;
  });
  return { meshes, materials: mats.size, tris: Math.round(tris) };
}

/**
 * 两骨 IK（只在矢状面 Y-Z 内求解）。
 *
 * 正式游戏里手臂是「整块旋转 -1.15 rad」，而 -Z 才是角色正前方，
 * 负角把手甩到了身后 —— 手永远够不到枪。这里改成真正的两骨解算：
 * 给定肩点与握把世界坐标，算出上臂与前臂各自该转多少，手正好落在握把上。
 *
 * 约定：手臂初始沿 -Y 下垂，绕 X 正向旋转 = 向前（-Z）抬起。
 */
export function solveArm(shoulder, target, L1, L2) {
  const dy = target.y - shoulder.y;
  const dz = target.z - shoulder.z;
  let d = Math.hypot(dy, dz);
  const min = Math.abs(L1 - L2) + 1e-4;
  const max = L1 + L2 - 1e-4;
  d = Math.min(max, Math.max(min, d));

  // 肩 → 目标 的方向角（手臂沿 -Y 下垂为 0）
  const base = Math.atan2(-dz, -dy);
  // 余弦定理：目标方向与上臂的夹角
  const a1 = Math.acos(clamp((L1 * L1 + d * d - L2 * L2) / (2 * L1 * d), -1, 1));
  // 余弦定理：肘关节内角
  const elbow = Math.PI - Math.acos(clamp((L1 * L1 + L2 * L2 - d * d) / (2 * L1 * L2), -1, 1));

  return { upper: base - a1, lower: elbow };
}

function clamp(v, lo, hi) {
  return v < lo ? lo : v > hi ? hi : v;
}

/** 明度换算（HSV 的 V），用于校验配色在暗光下会不会糊成黑块 */
export function value(hex) {
  const c = new THREE.Color(hex);
  return Math.max(c.r, c.g, c.b);
}
