import * as THREE from 'three';
import { PALETTE, LIGHT, PLAYER, NOISE_SPIKE_THRESHOLD } from '../config.js';
import { D } from '../difficulty.js';
import { BLOCKS } from '../voxel/blocks.js';
import { PERCEPTION, rayBox } from './enemy.js';

/**
 * 战斗解算：子弹用射线推进，命中判定精确且廉价（GDD 18 章）。
 *
 * 玩家开火流程：
 *  1. 准星一致性：从相机取命中点 P，子弹从枪口射向 P
 *  2. 散布：按姿态倍率 + 后坐抬枪，在圆锥内随机偏转
 *  3. 逐弹丸对「敌人命中盒」与「体素墙体」求最近交点
 *  4. 表现：枪口焰 + 曳光 + 血雾/碎屑 + 抛壳 + 瞬时点光
 *  5. 噪音：按武器噪音半径唤醒敌人（跨楼板 ×0.6）
 */

const _dir = new THREE.Vector3();
const _tmp = new THREE.Vector3();
const _hitPt = new THREE.Vector3();
const _norm = new THREE.Vector3();
const _right = new THREE.Vector3();

export class Combat {
  constructor(world, effects, flashPool, enemies) {
    this.world = world;
    this.fx = effects;
    this.flashPool = flashPool;
    this.enemies = enemies;
    this.stats = { shots: 0, hits: 0, headshots: 0, kills: 0 };
    this.onPlayerHit = null;      // 回调：(damage, zone) => void
    this.onKill = null;           // 回调：(enemy) => void
    this.onEnemyShot = null;      // 回调：(weaponSpec, distToPlayer) => void
  }

  /**
   * 玩家开火。
   * @returns {boolean} 是否真的打出了子弹
   */
  playerShoot(player, cam, weapon, now) {
    const aim = player.aimSolution(cam);
    // 枪口被自己的掩体挡住 → 禁止开火（GDD 05 章）
    if (aim.blocked) return false;

    // 先取散布，再 consume。consume() 会累加后坐抬枪，
    // 若顺序反了，每一发都会被自己的后坐打偏 ——
    // DMR 的 0.4° 会立刻变成 4.6°，「一击必杀 + 极小散布」彻底失效。
    const spread = weapon.currentSpread(player.spreadMultiplier);
    if (!weapon.consume(now)) return false;

    const spec = weapon.spec;
    // 弹道起点由 aimSolution 决定：第三人称是枪口，第一人称是眼睛。
    // 视觉上的枪口焰仍然画在枪口，所以两种视角看起来都对。
    const origin = aim.origin ? aim.origin.clone() : player.muzzle().pos.clone();

    this.stats.shots++;
    let anyHit = false;

    for (let p = 0; p < spec.pellets; p++) {
      _dir.copy(aim.dir);
      applySpread(_dir, spread, spec.pelletConcentrate ?? 1);
      const r = this.castBullet(origin, _dir, spec, spec.pierce, false);
      if (r.hitEnemy) anyHit = true;
    }

    // 表现：枪口焰与瞬时光始终画在真实枪口，
    // 即使第一人称的弹道起点是眼睛（否则光会闪在脸上）
    const visualMuzzle = player.muzzle().pos;
    this.fx.muzzleFlash(visualMuzzle, aim.dir, spec.muzzleScale);
    this.flashPool.pop(visualMuzzle.x, visualMuzzle.y, visualMuzzle.z, {
      intensity: LIGHT.muzzle.intensity * (spec.muzzleScale / 0.4),
      distance: LIGHT.muzzle.distance,
    });
    // 抛壳：从枪身右侧飞出
    _right.set(Math.cos(cam.yaw), 0, -Math.sin(cam.yaw));
    this.fx.shell(origin, _right);

    player.rig.kick(spec.recoil.kick);
    cam.kick(spec.recoil.shake);

    // 噪音：惊动半径内的敌人。口径越大（noise 越高），越可能让敌人
    // 直接举枪而不是慢悠悠地走过来查看——见 emitNoise 的 loud 参数。
    this.emitNoise(origin.x, origin.y, origin.z, spec.noise, spec.noise >= NOISE_SPIKE_THRESHOLD);

    if (anyHit) this.stats.hits++;
    return true;
  }

  /**
   * 单条弹道解算。同时对敌人命中盒与体素墙体求最近交点。
   * @param fromEnemy 敌人开的枪（会打玩家，不会打敌人）
   */
  castBullet(origin, dir, spec, pierce, fromEnemy, playerRef = null) {
    let remaining = pierce;
    let start = origin.clone();
    let hitEnemy = false;

    for (let bounce = 0; bounce < pierce + 1; bounce++) {
      // 1) 墙体
      const wall = this.world.raycast(
        start.x, start.y, start.z, dir.x, dir.y, dir.z, spec.range
      );
      const wallDist = wall ? wall.dist : spec.range;

      // 2) 目标（最近的一个）
      let target = null;
      if (fromEnemy) {
        if (playerRef) {
          const t = playerHitTest(playerRef, start, dir, wallDist);
          if (t) target = t;
        }
      } else {
        for (const e of this.enemies) {
          if (e.dead) continue;
          const h = e.hitTest(start.x, start.y, start.z, dir.x, dir.y, dir.z, wallDist);
          if (h && (!target || h.dist < target.dist)) target = h;
        }
      }

      if (target) {
        _hitPt.copy(start).addScaledVector(dir, target.dist);
        let dmg = spec.damage * target.mult;
        // 霰弹超出射程后快速衰减
        if (spec.falloff && target.dist > spec.range * 0.6) {
          dmg *= Math.max(0.25, 1 - (target.dist - spec.range * 0.6) / spec.range);
        }
        dmg = Math.round(dmg);

        this.fx.tracer(start, _hitPt, fromEnemy ? PALETTE.threat : 0xffe6a0, spec.tracer * 0.06);
        this.fx.bloodMist(_hitPt, dir, target.zone === 'head' ? 11 : 7);

        if (fromEnemy) {
          if (this.onPlayerHit) this.onPlayerHit(dmg, target.zone);
        } else {
          hitEnemy = true;
          if (target.zone === 'head') this.stats.headshots++;
          // 传入弹道方向：敌人会朝子弹飞去的方向倒下
          const killed = target.enemy.takeDamage(dmg, target.zone, dir);
          if (killed) {
            this.stats.kills++;
            this.markBlood(target.enemy.pos);
            if (this.onKill) this.onKill(target.enemy);
          }
        }

        remaining--;
        if (remaining <= 0) return { hitEnemy };
        // 穿透：从命中点继续
        start.copy(_hitPt).addScaledVector(dir, 0.35);
        continue;
      }

      // 没打到人：打墙或飞空
      if (wall) {
        _hitPt.set(wall.point[0], wall.point[1], wall.point[2]);
        _norm.set(wall.normal[0], wall.normal[1], wall.normal[2]);
        this.fx.tracer(start, _hitPt, fromEnemy ? PALETTE.threat : 0xffe6a0, spec.tracer * 0.06);
        const spec2 = BLOCKS[wall.id];
        this.fx.impact(_hitPt, _norm, spec2 ? spec2.color : PALETTE.cover, 5);
      } else {
        _tmp.copy(start).addScaledVector(dir, spec.range);
        this.fx.tracer(start, _tmp, fromEnemy ? PALETTE.threat : 0xffe6a0, spec.tracer * 0.06);
      }
      return { hitEnemy };
    }
    return { hitEnemy };
  }

  /** 敌人开火：带瞄准误差，保证会打空（受控 DPS） */
  enemyShoot(enemy, player, now) {
    const spec = enemy.weapon.spec;
    const origin = new THREE.Vector3(enemy.pos.x, enemy.eyeY, enemy.pos.z);
    const torsoY = player.pos.y + player.body.height * 0.62;
    _dir.set(
      player.pos.x - origin.x, torsoY - origin.y, player.pos.z - origin.z
    );
    const dist = _dir.length() || 1;
    _dir.divideScalar(dist);

    // 瞄准误差按「固定的线性偏移」而不是固定角度。
    // 纯角度散布在近距离等于零误差（4 vox 处锥半径只有 0.4 vox，比躯干还窄），
    // 结果贴脸时敌人 30/30 全中、玩家必死。改成线性偏移后，
    // 无论远近敌人都会打偏一部分，「多人交火才致命」的设计才成立。
    // 瞄准误差按难度缩放（简单 ×1.6 打得偏 / 专家 ×0.6 打得准）
    const missOffset = PERCEPTION.aimError * D().aimErrorMul;
    const angleDeg = Math.atan2(missOffset, dist) * 180 / Math.PI;

    for (let p = 0; p < spec.pellets; p++) {
      const d = _dir.clone();
      applySpread(d, angleDeg + spec.spread * 0.3, spec.pelletConcentrate ?? 1);
      this.castBullet(origin, d, spec, 1, true, player);
    }

    this.fx.muzzleFlash(origin, _dir, spec.muzzleScale);
    this.flashPool.pop(origin.x, origin.y, origin.z, {
      intensity: LIGHT.muzzle.intensity * 0.8,
      distance: LIGHT.muzzle.distance,
    });
    this.emitNoise(origin.x, origin.y, origin.z, spec.noise, spec.noise >= NOISE_SPIKE_THRESHOLD);
    // 敌人的枪声按距离衰减 —— 远处的交火声是玩家的重要情报
    if (this.onEnemyShot) this.onEnemyShot(spec, dist);
  }

  /**
   * @param loud 大口径武器（noise ≥ NOISE_SPIKE_THRESHOLD，见 config.js）。
   *             范围内 IDLE 的敌人会跳过 INVESTIGATE 直接进入 ALERT ——
   *             霰弹/DMR 的枪声就是这么大，手枪/SMG/AR 不触发。
   */
  emitNoise(x, y, z, radius, loud = false) {
    for (const e of this.enemies) e.hearNoise(x, y, z, radius, loud);
  }

  /** 血迹贴花：标记「这里清过」 */
  markBlood(pos) {
    const gx = Math.floor(pos.x), gz = Math.floor(pos.z);
    const gy = Math.floor(pos.y);
    for (const [dx, dz] of [[0, 0], [1, 0], [0, 1], [-1, 0]]) {
      const x = gx + dx, z = gz + dz;
      if (this.world.get(x, gy, z) === 0 &&
          this.world.get(x, gy - 1, z) !== 0) {
        this.world.set(x, gy, z, 9);   // BLOCK.DECAL
      }
    }
  }

  get accuracy() {
    return this.stats.shots === 0 ? 0 : this.stats.hits / this.stats.shots;
  }
}

/**
 * 在圆锥内随机偏转方向。
 *
 * @param concentrate >1 时弹丸向锥心聚集。霰弹枪需要它：
 *   18° 锥在 2 vox 处的半径已经是 0.65 vox，而躯干半宽只有 0.32，
 *   均匀撒点意味着贴脸也只有一半弹丸命中，「贴脸一枪致死」在几何上
 *   根本不可能发生。真实霰弹的弹丸分布本来也是中心密、边缘疏。
 */
function applySpread(dir, degrees, concentrate = 1) {
  if (degrees <= 0.001) return;
  const rad = degrees * Math.PI / 180;
  // 构造与 dir 垂直的两个基向量
  const up = Math.abs(dir.y) > 0.95
    ? _tmp.set(1, 0, 0) : _tmp.set(0, 1, 0);
  const right = new THREE.Vector3().crossVectors(dir, up).normalize();
  const realUp = new THREE.Vector3().crossVectors(right, dir).normalize();
  const a = Math.random() * Math.PI * 2;
  // concentrate=1 → sqrt 分布（圆内均匀）；更大的指数把点拉向中心
  const r = Math.pow(Math.random(), concentrate / 2) * rad;
  dir.addScaledVector(right, Math.tan(r) * Math.cos(a));
  dir.addScaledVector(realUp, Math.tan(r) * Math.sin(a));
  dir.normalize();
}

/** 玩家命中盒（头 ×2.5 / 躯干 ×1.0 / 四肢 ×0.7）*/
function playerHitTest(player, origin, dir, maxDist) {
  const h = player.body.height;
  const scale = h / PLAYER.height;
  const zones = [
    { name: 'head',  y0: 1.48 * scale, y1: 1.98 * scale, half: 0.26, mult: PLAYER.hitbox.head },
    { name: 'torso', y0: 0.68 * scale, y1: 1.48 * scale, half: 0.32, mult: PLAYER.hitbox.torso },
    { name: 'limb',  y0: 0.0,          y1: 0.68 * scale, half: 0.30, mult: PLAYER.hitbox.limb },
  ];
  let best = null;
  for (const z of zones) {
    const t = rayBox(
      origin.x, origin.y, origin.z, dir.x, dir.y, dir.z,
      player.pos.x - z.half, player.pos.y + z.y0, player.pos.z - z.half,
      player.pos.x + z.half, player.pos.y + z.y1, player.pos.z + z.half
    );
    if (t !== null && t <= maxDist && (!best || t < best.dist)) {
      best = { dist: t, zone: z.name, mult: z.mult };
    }
  }
  return best;
}

export { applySpread };
