import * as THREE from 'three';
import { PALETTE } from '../config.js';

/**
 * 全部射击表现，一律用小方块（GDD 07 章「方块化的射击表现」）：
 *   枪口焰 = 白色发光方块，80ms 内从 0.5 缩到 0
 *   曳光   = 沿弹道拉长的细方块
 *   血雾   = 6–10 个红色 0.08 方块，随机飞散 + 受重力
 *   抛壳   = 黄铜色小方块，落地 3 秒后消失
 *   碎屑   = 命中墙面时溅出的同色小方块
 *
 * 全部走 InstancedMesh 对象池，共用一个 BoxGeometry，零额外 draw call 压力。
 */

const BOX = new THREE.BoxGeometry(1, 1, 1);
const _m = new THREE.Matrix4();
const _q = new THREE.Quaternion();
const _v = new THREE.Vector3();
const _s = new THREE.Vector3();
const _c = new THREE.Color();

/** 通用实例化粒子池 */
class Pool {
  constructor(scene, count, { emissive = false, transparent = false } = {}) {
    const mat = emissive
      ? new THREE.MeshBasicMaterial({ transparent, opacity: 1 })
      : new THREE.MeshLambertMaterial({ transparent, opacity: 1 });
    this.mesh = new THREE.InstancedMesh(BOX, mat, count);
    this.mesh.instanceMatrix.setUsage(THREE.DynamicDrawUsage);
    this.mesh.frustumCulled = false;
    this.mesh.castShadow = false;
    this.mesh.receiveShadow = false;
    this.mesh.count = count;
    this.mesh.instanceColor = new THREE.InstancedBufferAttribute(
      new Float32Array(count * 3), 3
    );
    scene.add(this.mesh);

    this.items = [];
    for (let i = 0; i < count; i++) {
      this.items.push({
        alive: false, life: 0, maxLife: 1,
        pos: new THREE.Vector3(), vel: new THREE.Vector3(),
        scale: new THREE.Vector3(1, 1, 1), baseScale: 1,
        rot: new THREE.Euler(), spin: new THREE.Vector3(),
        gravity: 0, drag: 1, color: new THREE.Color(),
        shrink: false, grounded: false,
      });
    }
    this.cursor = 0;
    this.hideAll();
  }

  hideAll() {
    _m.makeScale(0, 0, 0);
    for (let i = 0; i < this.items.length; i++) this.mesh.setMatrixAt(i, _m);
    this.mesh.instanceMatrix.needsUpdate = true;
  }

  spawn(cfg) {
    // 环形复用：满了就覆盖最老的
    const it = this.items[this.cursor];
    this.cursor = (this.cursor + 1) % this.items.length;
    Object.assign(it, { alive: true, life: 0, grounded: false }, cfg);
    return it;
  }

  update(dt, world) {
    let dirty = false;
    for (let i = 0; i < this.items.length; i++) {
      const it = this.items[i];
      if (!it.alive) continue;
      dirty = true;
      it.life += dt;
      if (it.life >= it.maxLife) {
        it.alive = false;
        _m.makeScale(0, 0, 0);
        this.mesh.setMatrixAt(i, _m);
        continue;
      }

      if (!it.grounded) {
        if (it.gravity) it.vel.y += it.gravity * dt;
        if (it.drag !== 1) it.vel.multiplyScalar(Math.pow(it.drag, dt * 60));
        _v.copy(it.vel).multiplyScalar(dt);
        // 简单的体素碰撞：撞到方块就停住（弹壳落地）
        if (world) {
          const nx = it.pos.x + _v.x, ny = it.pos.y + _v.y, nz = it.pos.z + _v.z;
          if (world.solidAtPoint(nx, ny, nz)) {
            it.vel.set(0, 0, 0);
            it.grounded = true;
          } else {
            it.pos.set(nx, ny, nz);
          }
        } else {
          it.pos.add(_v);
        }
        it.rot.x += it.spin.x * dt;
        it.rot.y += it.spin.y * dt;
        it.rot.z += it.spin.z * dt;
      }

      const t = it.life / it.maxLife;
      const sc = it.shrink ? it.baseScale * (1 - t) : it.baseScale;
      _q.setFromEuler(it.rot);
      _s.copy(it.scale).multiplyScalar(sc);
      _m.compose(it.pos, _q, _s);
      this.mesh.setMatrixAt(i, _m);
      this.mesh.setColorAt(i, it.color);
    }
    if (dirty) {
      this.mesh.instanceMatrix.needsUpdate = true;
      if (this.mesh.instanceColor) this.mesh.instanceColor.needsUpdate = true;
    }
  }
}

export class Effects {
  constructor(scene, world) {
    this.world = world;
    this.debris = new Pool(scene, 260);                        // 血雾 / 碎屑 / 弹壳
    this.flashes = new Pool(scene, 24, { emissive: true });    // 枪口焰
    this.tracers = new Pool(scene, 48, { emissive: true });    // 曳光
  }

  /** 枪口焰：一个白色发光方块，80ms 内缩到 0 */
  muzzleFlash(pos, dir, scale = 0.4) {
    const it = this.flashes.spawn({
      maxLife: 0.08, baseScale: scale, gravity: 0, drag: 1,
      shrink: true, spin: new THREE.Vector3(0, 0, 14),
    });
    it.pos.copy(pos).addScaledVector(dir, 0.12);
    it.vel.set(0, 0, 0);
    it.scale.set(1, 1, 1.6);
    it.rot.set(0, Math.atan2(dir.x, dir.z), Math.random() * 3);
    it.color.setHex(0xffffff);
  }

  /** 曳光：沿弹道拉长的细方块 */
  tracer(from, to, color = 0xffe6a0, thickness = 0.035) {
    const dist = from.distanceTo(to);
    if (dist < 0.2) return;
    const it = this.tracers.spawn({
      maxLife: 0.055, baseScale: 1, gravity: 0, drag: 1, shrink: false,
      spin: new THREE.Vector3(),
    });
    it.pos.copy(from).add(to).multiplyScalar(0.5);
    it.vel.set(0, 0, 0);
    it.scale.set(thickness, thickness, dist);
    _v.copy(to).sub(from).normalize();
    it.rot.set(Math.asin(-_v.y), Math.atan2(_v.x, _v.z), 0);
    it.color.setHex(color);
  }

  /** 命中血雾：6–10 个红色小方块，随机飞散并受重力 */
  bloodMist(pos, dir, amount = 8) {
    for (let i = 0; i < amount; i++) {
      const it = this.debris.spawn({
        maxLife: 0.5 + Math.random() * 0.4, baseScale: 0.08,
        gravity: -16, drag: 0.96, shrink: true,
        spin: new THREE.Vector3(
          (Math.random() - 0.5) * 18, (Math.random() - 0.5) * 18, 0
        ),
      });
      it.pos.copy(pos);
      it.vel.set(
        dir.x * 2.2 + (Math.random() - 0.5) * 3.4,
        1.4 + Math.random() * 2.4,
        dir.z * 2.2 + (Math.random() - 0.5) * 3.4
      );
      it.scale.set(1, 1, 1);
      it.color.setHex(PALETTE.threat).multiplyScalar(0.55 + Math.random() * 0.5);
    }
  }

  /** 墙面碎屑：命中方块时溅出同色小块 */
  impact(pos, normal, colorHex = PALETTE.cover, amount = 5) {
    for (let i = 0; i < amount; i++) {
      const it = this.debris.spawn({
        maxLife: 0.4 + Math.random() * 0.3, baseScale: 0.07,
        gravity: -18, drag: 0.95, shrink: true,
        spin: new THREE.Vector3(
          (Math.random() - 0.5) * 20, (Math.random() - 0.5) * 20, 0
        ),
      });
      it.pos.copy(pos).addScaledVector(normal, 0.06);
      it.vel.set(
        normal.x * 2.5 + (Math.random() - 0.5) * 2.6,
        normal.y * 2.5 + Math.random() * 2.2,
        normal.z * 2.5 + (Math.random() - 0.5) * 2.6
      );
      it.scale.set(1, 1, 1);
      it.color.setHex(colorHex).multiplyScalar(0.7 + Math.random() * 0.6);
    }
  }

  /** 抛壳：黄铜色小方块，落地后停住，3 秒消失 */
  shell(pos, rightDir) {
    const it = this.debris.spawn({
      maxLife: 3.0, baseScale: 0.06, gravity: -20, drag: 0.99,
      shrink: false,
      spin: new THREE.Vector3(
        (Math.random() - 0.5) * 24, (Math.random() - 0.5) * 24, 0
      ),
    });
    it.pos.copy(pos);
    it.vel.set(
      rightDir.x * 2.2 + (Math.random() - 0.5) * 0.8,
      1.8 + Math.random(),
      rightDir.z * 2.2 + (Math.random() - 0.5) * 0.8
    );
    it.scale.set(1, 1, 1.8);
    it.color.setHex(PALETTE.brass);
  }

  /**
   * 手雷爆炸：一团向外飞散的橙白色方块 + 中心一瞬的大亮块。
   *
   * 分三层，因为单一颜色的爆炸读不出「热度」：
   *   核心 —— 白热，寿命最短（一瞬即灭）
   *   火焰 —— 橙黄，中等寿命，受轻微重力
   *   烟灰 —— 深灰，寿命最长，向上飘
   */
  explosion(pos, amount = 34) {
    // 核心闪块：几个大白块，60ms 内消失
    for (let i = 0; i < 5; i++) {
      const it = this.flashes.spawn({
        maxLife: 0.06 + Math.random() * 0.05, baseScale: 0.9,
        gravity: 0, drag: 1, shrink: true,
        spin: new THREE.Vector3(
          (Math.random() - 0.5) * 10, (Math.random() - 0.5) * 10, 0
        ),
      });
      it.pos.set(
        pos.x + (Math.random() - 0.5) * 0.6,
        pos.y + (Math.random() - 0.5) * 0.6,
        pos.z + (Math.random() - 0.5) * 0.6
      );
      it.vel.set(0, 0, 0);
      it.scale.set(1, 1, 1);
      it.rot.set(Math.random() * 3, Math.random() * 3, Math.random() * 3);
      it.color.setHex(0xfff4d0);
    }

    // 火焰与烟灰
    for (let i = 0; i < amount; i++) {
      const smoke = i > amount * 0.6;
      const speed = 4 + Math.random() * 9;
      const th = Math.random() * Math.PI * 2;
      const ph = Math.acos(2 * Math.random() - 1);
      const it = this.debris.spawn({
        maxLife: smoke ? 0.8 + Math.random() * 0.7 : 0.3 + Math.random() * 0.35,
        baseScale: smoke ? 0.16 : 0.11,
        gravity: smoke ? 2.5 : -9,          // 烟往上飘，火星往下落
        drag: 0.9, shrink: true,
        spin: new THREE.Vector3(
          (Math.random() - 0.5) * 22, (Math.random() - 0.5) * 22, 0
        ),
      });
      it.pos.set(
        pos.x + (Math.random() - 0.5) * 0.35,
        pos.y + (Math.random() - 0.5) * 0.35,
        pos.z + (Math.random() - 0.5) * 0.35
      );
      it.vel.set(
        Math.sin(ph) * Math.cos(th) * speed,
        Math.cos(ph) * speed * 0.8 + 2,
        Math.sin(ph) * Math.sin(th) * speed
      );
      it.scale.set(1, 1, 1);
      if (smoke) {
        it.color.setHex(0x3a3a3a).multiplyScalar(0.6 + Math.random() * 0.7);
      } else {
        it.color.setHex(Math.random() < 0.5 ? 0xffa63a : 0xffd98a)
          .multiplyScalar(0.7 + Math.random() * 0.5);
      }
    }
  }

  /** 死亡爆散：敌人死亡时整个人形炸成方块 */
  deathBurst(pos, colorHex = PALETTE.threat, amount = 16) {
    for (let i = 0; i < amount; i++) {
      const it = this.debris.spawn({
        maxLife: 0.7 + Math.random() * 0.5, baseScale: 0.13,
        gravity: -17, drag: 0.95, shrink: true,
        spin: new THREE.Vector3(
          (Math.random() - 0.5) * 14, (Math.random() - 0.5) * 14, 0
        ),
      });
      it.pos.set(
        pos.x + (Math.random() - 0.5) * 0.5,
        pos.y + 0.4 + Math.random() * 1.1,
        pos.z + (Math.random() - 0.5) * 0.5
      );
      it.vel.set(
        (Math.random() - 0.5) * 3.6, 1.6 + Math.random() * 2.6,
        (Math.random() - 0.5) * 3.6
      );
      it.scale.set(1, 1, 1);
      it.color.setHex(colorHex).multiplyScalar(0.5 + Math.random() * 0.6);
    }
  }

  update(dt) {
    this.debris.update(dt, this.world);
    this.flashes.update(dt, null);
    this.tracers.update(dt, null);
  }
}
