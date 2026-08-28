import * as THREE from 'three';
import { GRENADE, PALETTE } from '../config.js';

/**
 * 手雷：抛物线飞行 → 撞墙反弹 → 引信到点爆炸。
 *
 * 三条设计约束：
 *  1. 爆炸必须要有视线才造成伤害。躲到墙后就是安全的 —— 这条规则
 *     玩家和敌人共享，所以「用手雷清掩体后的敌人」是一个可学习的技巧，
 *     而不是隔墙秒杀的随机死亡。
 *  2. 伤害按距离线性衰减（中心 180 → 边缘 25）。60 HP 的敌人在半径内
 *     大部分位置都是必杀，但边缘只是重伤 —— 手雷是清场工具不是核弹。
 *  3. 自伤打七折。手滑扔到脚下会重伤但不必死，留一次学习机会。
 *
 * 弹体是一个 0.22 vox 的小方块，跟全场其它表现保持同一套视觉语言。
 */

const GEO = new THREE.BoxGeometry(0.22, 0.22, 0.22);

class Grenade {
  constructor(scene, world, pos, vel, ownerIsPlayer) {
    this.world = world;
    this.pos = pos.clone();
    this.vel = vel.clone();
    this.fuse = GRENADE.fuseSec;
    this.ownerIsPlayer = ownerIsPlayer;
    this.done = false;

    this.mesh = new THREE.Mesh(GEO, new THREE.MeshLambertMaterial({
      color: 0x4a5a3a,          // 军绿，和拾取物的亮绿有明显区分
    }));
    this.mesh.position.copy(this.pos);
    this.mesh.castShadow = true;
    scene.add(this.mesh);
    this.scene = scene;
    this.spin = new THREE.Vector3(
      (Math.random() - 0.5) * 12, (Math.random() - 0.5) * 12, 8
    );
  }

  /**
   * 分轴推进 + 反弹。逐轴测试让手雷能沿地面滚动，
   * 而不是撞到地板就整体停死（那样扔出去的手雷会诡异地悬在半空）。
   */
  update(dt) {
    this.fuse -= dt;
    this.vel.y += GRENADE.gravity * dt;

    const r = GRENADE.radiusVox;
    for (const axis of ['x', 'y', 'z']) {
      const step = this.vel[axis] * dt;
      if (step === 0) continue;
      const next = this.pos[axis] + step;
      const probe = {
        x: axis === 'x' ? next : this.pos.x,
        y: axis === 'y' ? next : this.pos.y,
        z: axis === 'z' ? next : this.pos.z,
      };
      if (this.world.boxIntersects(
        probe.x - r, probe.y - r, probe.z - r,
        probe.x + r, probe.y + r, probe.z + r
      )) {
        // 撞到了：反弹并损失能量
        this.vel[axis] *= -GRENADE.bounce;
        if (axis === 'y' && Math.abs(this.vel.y) < 1.2) {
          // 竖直速度已经很小 → 认为落地，水平方向加摩擦开始滚停
          this.vel.y = 0;
          this.vel.x *= GRENADE.friction;
          this.vel.z *= GRENADE.friction;
        }
      } else {
        this.pos[axis] = next;
      }
    }

    this.mesh.position.copy(this.pos);
    this.mesh.rotation.x += this.spin.x * dt;
    this.mesh.rotation.y += this.spin.y * dt;
    this.mesh.rotation.z += this.spin.z * dt;
    return this.fuse <= 0;
  }

  dispose() {
    this.scene.remove(this.mesh);
    this.mesh.material.dispose();
  }
}

export class GrenadeSystem {
  /**
   * @param onExplode 回调 (pos, ownerIsPlayer) => void，由主循环接上伤害与音效
   */
  constructor(scene, world, effects, flashPool) {
    this.scene = scene;
    this.world = world;
    this.fx = effects;
    this.flashPool = flashPool;
    this.items = [];
    this.onExplode = null;
    this._v = new THREE.Vector3();
  }

  /** 投掷。dir 应当是归一化的视线方向。 */
  throwFrom(pos, dir, ownerIsPlayer = true) {
    // 稍微上抬：直接沿视线扔会导致平视时手雷贴地滚，扔不出距离
    this._v.copy(dir).normalize();
    this._v.y += 0.22;
    this._v.normalize().multiplyScalar(GRENADE.throwSpeed);
    const g = new Grenade(this.scene, this.world, pos, this._v, ownerIsPlayer);
    this.items.push(g);
    return g;
  }

  update(dt) {
    for (const g of this.items) {
      if (g.done) continue;
      if (g.update(dt)) {
        this.explode(g);
        g.done = true;
      }
    }
    if (this.items.some((g) => g.done)) {
      for (const g of this.items) if (g.done) g.dispose();
      this.items = this.items.filter((g) => !g.done);
    }
  }

  explode(g) {
    const p = g.pos;
    // 闪光 + 碎块 + 血雾色的火花
    this.flashPool.pop(p.x, p.y, p.z, {
      intensity: GRENADE.flashIntensity,
      distance: GRENADE.flashDistance,
      lifeMs: GRENADE.flashMs,
      color: 0xffd090,
    });
    this.fx.explosion(p, GRENADE.debris);
    if (this.onExplode) this.onExplode(p, g.ownerIsPlayer);
  }

  /**
   * 爆炸伤害查询：返回从爆心到目标点的伤害值（0 = 无伤害）。
   *
   * 视线检查是这套设计的核心 —— 墙后完全安全，所以掩体在手雷面前
   * 依然有意义。用爆心到目标胸口的连线判定，不做多点采样：
   * 单条射线足够表达「有没有掩体」，多点采样的收益不值那个成本。
   */
  damageAt(center, tx, ty, tz) {
    const d = Math.hypot(center.x - tx, center.y - ty, center.z - tz);
    if (d > GRENADE.radius) return 0;
    if (this.world.lineBlocked(center.x, center.y, center.z, tx, ty, tz)) return 0;
    const t = 1 - d / GRENADE.radius;
    return Math.round(
      GRENADE.minDamage + (GRENADE.maxDamage - GRENADE.minDamage) * t
    );
  }

  get count() { return this.items.length; }
}
