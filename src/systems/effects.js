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

/**
 * 弹孔：贴在墙面上的持久黑色薄片。
 *
 * 不能用 Pool —— 那套是「生存 maxLife 秒然后消失」的粒子系统，而弹孔
 * 必须留在墙上（打过的地方是玩家的战术记忆：哪面墙被压制过、
 * 交火发生在哪）。所以单独一个环形缓冲的 InstancedMesh：
 * 超过 MAX 之后从头覆盖，最老的弹孔消失，显存占用恒定。
 */
const HOLE_MAX = 220;

class BulletHoles {
  constructor(scene) {
    this.mesh = new THREE.InstancedMesh(
      BOX,
      new THREE.MeshLambertMaterial({ color: 0x0a0c10 }),
      HOLE_MAX
    );
    this.mesh.frustumCulled = false;
    this.mesh.castShadow = false;
    this.mesh.receiveShadow = false;
    this.next = 0;
    this.count = 0;
    // 全部先缩到 0，避免未使用的实例在原点堆成一个黑块
    _m.makeScale(0, 0, 0);
    for (let i = 0; i < HOLE_MAX; i++) this.mesh.setMatrixAt(i, _m);
    this.mesh.instanceMatrix.needsUpdate = true;
    scene.add(this.mesh);
  }

  /**
   * @param pos    命中点（世界坐标）
   * @param normal 命中面法线 —— 贴片要压在这个面上，稍微抬离避免 z-fighting
   */
  add(pos, normal) {
    const i = this.next;
    this.next = (this.next + 1) % HOLE_MAX;
    this.count = Math.min(this.count + 1, HOLE_MAX);

    const size = 0.09 + Math.random() * 0.05;
    // 沿法线压扁：法线方向只留 0.02 厚，另两轴是弹孔直径
    _s.set(
      Math.abs(normal.x) > 0.5 ? 0.02 : size,
      Math.abs(normal.y) > 0.5 ? 0.02 : size,
      Math.abs(normal.z) > 0.5 ? 0.02 : size
    );
    _v.copy(pos).addScaledVector(normal, 0.012);
    _q.identity();
    _m.compose(_v, _q, _s);
    this.mesh.setMatrixAt(i, _m);
    this.mesh.instanceMatrix.needsUpdate = true;
  }
}

/**
 * 弹壳：抛出 → 弹跳 → 落地后永久留在地上。
 *
 * ══ 为什么不能复用 Pool，也不能复用 BulletHoles ══
 *
 * Pool 是「活 maxLife 秒然后消失」的粒子系统 —— 弹壳原来就挂在那上面，
 * 3 秒后凭空蒸发。而 BulletHoles 是纯静态的：贴上去就不动了，没有物理。
 *
 * 弹壳两头都要：先有一段真实的抛物线 + 落地（打出去的壳会滚到脚边，
 * 这是射击反馈的一部分），之后必须**留下来** —— 地上的弹壳是玩家读
 * 「这条走廊刚打过一场」的痕迹，和弹孔一样属于战术记忆。
 *
 * 实现：一个环形缓冲的 InstancedMesh，每个壳有 live 标记。
 * 活跃的壳每帧走物理；落地静止后 live=false，从此只占一个矩阵、
 * 不再参与任何计算。所以「地上堆了 400 个壳」的开销和 0 个几乎一样。
 */
const SHELL_MAX = 400;
/** 弹壳落地判定：垂直速度低于这个值且贴着地面就算停住 */
const SHELL_REST_V = 0.35;

class Shells {
  constructor(scene, world) {
    this.world = world;
    this.mesh = new THREE.InstancedMesh(
      BOX,
      new THREE.MeshLambertMaterial({ color: PALETTE.brass }),
      SHELL_MAX
    );
    this.mesh.frustumCulled = false;
    this.mesh.castShadow = false;
    this.mesh.receiveShadow = true;
    this.next = 0;
    this.items = [];
    for (let i = 0; i < SHELL_MAX; i++) {
      this.items.push({
        live: false,
        pos: new THREE.Vector3(), vel: new THREE.Vector3(),
        rot: new THREE.Euler(), spin: new THREE.Vector3(),
      });
    }
    // 先全部缩到 0，否则未使用的实例会在原点堆成一个黄铜块
    _m.makeScale(0, 0, 0);
    for (let i = 0; i < SHELL_MAX; i++) this.mesh.setMatrixAt(i, _m);
    this.mesh.instanceMatrix.needsUpdate = true;
    scene.add(this.mesh);
  }

  /** 抛一枚壳：从枪身右侧飞出 */
  spawn(pos, rightDir) {
    const i = this.next;
    this.next = (this.next + 1) % SHELL_MAX;
    const it = this.items[i];
    it.live = true;
    it.pos.copy(pos);
    it.vel.set(
      rightDir.x * 2.2 + (Math.random() - 0.5) * 0.8,
      1.8 + Math.random(),
      rightDir.z * 2.2 + (Math.random() - 0.5) * 0.8
    );
    it.rot.set(Math.random() * 3, Math.random() * 3, Math.random() * 3);
    it.spin.set(
      (Math.random() - 0.5) * 24, (Math.random() - 0.5) * 24, 0
    );
    this.write(i, it);
  }

  write(i, it) {
    _v.copy(it.pos);
    _q.setFromEuler(it.rot);
    _s.set(0.06, 0.06, 0.108);          // 细长的小圆柱（用方块近似）
    _m.compose(_v, _q, _s);
    this.mesh.setMatrixAt(i, _m);
    this.mesh.instanceMatrix.needsUpdate = true;
  }

  update(dt) {
    let dirty = false;
    for (let i = 0; i < SHELL_MAX; i++) {
      const it = this.items[i];
      if (!it.live) continue;           // 已落定：零开销
      it.vel.y -= 22 * dt;
      it.pos.addScaledVector(it.vel, dt);
      it.rot.x += it.spin.x * dt;
      it.rot.y += it.spin.y * dt;

      // 地面碰撞：踩到实心方块顶面就弹一下，能量耗尽后永久停住
      const surf = this.world?.highestSurfaceUnder(
        it.pos.x - 0.05, it.pos.z - 0.05, it.pos.x + 0.05, it.pos.z + 0.05,
        it.pos.y + 0.4, it.pos.y - 1.5
      );
      if (Number.isFinite(surf) && it.pos.y <= surf + 0.03) {
        it.pos.y = surf + 0.03;
        if (Math.abs(it.vel.y) < SHELL_REST_V) {
          // 停住：躺平在地上，从此不再参与物理
          it.vel.set(0, 0, 0);
          it.spin.set(0, 0, 0);
          it.rot.x = Math.PI / 2;       // 侧躺
          it.live = false;
        } else {
          it.vel.y = -it.vel.y * 0.35;  // 弹跳
          it.vel.x *= 0.6; it.vel.z *= 0.6;
          it.spin.multiplyScalar(0.5);
        }
      } else if (it.pos.y < -4) {
        it.live = false;               // 掉出世界，直接收掉
      }
      this.write(i, it);
      dirty = true;
    }
    if (dirty) this.mesh.instanceMatrix.needsUpdate = true;
  }
}

export class Effects {
  constructor(scene, world) {
    this.world = world;
    this.debris = new Pool(scene, 260);                        // 血雾 / 碎屑 / 弹壳
    this.flashes = new Pool(scene, 24, { emissive: true });    // 枪口焰
    this.tracers = new Pool(scene, 48, { emissive: true });    // 曳光
    this.holes = new BulletHoles(scene);                       // 弹孔（持久）
    this.shells = new Shells(scene, world);                    // 弹壳（落地后持久）
  }

  /** 墙面弹孔：留在打中的那一面上，不会消失 */
  bulletHole(pos, normal) {
    this.holes.add(pos, normal);
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
    this.shells.spawn(pos, rightDir);
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
    // 弹壳：只有还在飞的那几枚参与物理，落地的已从循环里短路掉
    this.shells.update(dt);
  }
}
