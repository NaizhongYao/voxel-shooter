import * as THREE from 'three';
import { PALETTE, PLAYER } from '../config.js';
import { BlockyRig } from '../player/rig.js';
import { WEAPONS, WeaponInstance, HITBOX_MULT } from './weapons.js';

/**
 * 敌人系统（GDD 12 章）。
 *
 * 三类行为原型：伏地者 / 蹲守者 / 巡逻者
 * 五个状态：基础行为 → 调查 → 警戒 → 战斗 → 死亡（+ 致盲）
 *
 * 公平性保障（60 HP 体系下玩家生存的唯一依靠）：
 *  - 发现玩家后有 300–500ms 反应延迟，期间有可见的举枪动作
 *  - 开枪时枪口焰暴露位置
 *  - 单个敌人有散布、会打空；多人同时交火才致命
 */

export const STATE = {
  IDLE: 'idle', INVESTIGATE: 'investigate', ALERT: 'alert',
  COMBAT: 'combat', BLINDED: 'blinded', DEAD: 'dead',
};

export const ARCHETYPE = {
  PRONE:    'prone',      // 伏地者：极低轮廓，近距离突然起身
  SENTRY:   'sentry',     // 蹲守者：固定朝向，大视野锥
  PATROLLER:'patroller',  // 巡逻者：沿路径走，会呼叫同伴
};

const PERCEPTION = {
  visionRange: 18,          // 基础视觉距离 vox
  hFovDeg: 100,             // 水平视野锥
  vFovDeg: 70,              // 垂直视野锥
  sentryRangeMul: 1.35,     // 蹲守者视野更远
  proneWakeRange: 6,        // 伏地者的惊起距离
  reactionMin: 0.30,        // 反应延迟下限（秒）
  reactionMax: 0.50,
  shadowMul: 0.6,           // 玩家处于阴影中再 ×0.6
  crossFloorMul: 0.6,       // 噪音跨楼板衰减
  callRadius: 15,           // 呼叫同伴半径
  investigateTime: 6,       // 调查状态持续时间
  loseTargetTime: 2.5,      // 失去目标后回落的时间
  aimSpread: 4.0,           // 敌人射击散布（度）——保证会打空
  burstGap: 0.45,           // 连发之间的停顿
};

let _idSeq = 0;
const _v = new THREE.Vector3();
const _v2 = new THREE.Vector3();

export class Enemy {
  /**
   * @param spec { x, z, y, archetype, weapon, yaw, patrol?: [[x,z],...] }
   */
  constructor(world, spec) {
    this.id = ++_idSeq;
    this.world = world;
    this.archetype = spec.archetype;
    this.spawn = new THREE.Vector3(spec.x, spec.y, spec.z);
    this.pos = this.spawn.clone();
    this.yaw = spec.yaw ?? 0;
    this.homeYaw = this.yaw;
    this.patrol = spec.patrol ?? null;
    this.patrolIdx = 0;

    this.hp = 60;                       // 与玩家对称
    this.state = STATE.IDLE;
    this.stateTime = 0;
    this.weapon = new WeaponInstance(WEAPONS[spec.weapon]);
    this.reactionTimer = 0;
    this.blindUntil = 0;
    this.lastSeenPlayer = new THREE.Vector3();
    this.hasLastSeen = false;
    this.investigateTarget = null;
    this.alerted = false;
    this.nextShotAt = 0;
    this.proneWoken = false;

    // 视觉：方块人形。伏地者整体躺平，轮廓极低
    this.rig = new BlockyRig(PALETTE.threat, { isPlayer: false });
    this.rig.root.position.copy(this.pos);
    if (this.archetype === ARCHETYPE.PRONE) this.setProne(true);

    this.height = this.archetype === ARCHETYPE.PRONE ? 0.5 : PLAYER.height;
    this.dead = false;
  }

  setProne(on) {
    // 躺平：整体压扁并旋转，命中盒随之变矮
    this.rig.body.rotation.x = on ? -Math.PI / 2.2 : 0;
    this.rig.body.position.y = on ? 0.18 : 0;
  }

  get eyeY() {
    return this.pos.y + (this.archetype === ARCHETYPE.PRONE ? 0.3 : 1.5);
  }

  /** 命中盒：三段 AABB（头 / 躯干 / 四肢），返回命中倍率 */
  hitTest(ox, oy, oz, dx, dy, dz, maxDist) {
    if (this.dead) return null;
    const prone = this.archetype === ARCHETYPE.PRONE;
    const h = prone ? 0.55 : PLAYER.height;
    const zones = prone
      ? [
          { name: 'torso', y0: 0.05, y1: 0.5, half: 0.42, mult: HITBOX_MULT.torso },
          { name: 'head',  y0: 0.15, y1: 0.5, half: 0.22, mult: HITBOX_MULT.head, off: 0.3 },
        ]
      : [
          { name: 'head',  y0: 1.48, y1: 1.98, half: 0.26, mult: HITBOX_MULT.head },
          { name: 'torso', y0: 0.68, y1: 1.48, half: 0.32, mult: HITBOX_MULT.torso },
          { name: 'limb',  y0: 0.0,  y1: 0.68, half: 0.30, mult: HITBOX_MULT.limb },
        ];

    let best = null;
    for (const z of zones) {
      const cx = this.pos.x + (z.off ? Math.sin(this.yaw) * -z.off : 0);
      const cz = this.pos.z + (z.off ? Math.cos(this.yaw) * -z.off : 0);
      const t = rayBox(
        ox, oy, oz, dx, dy, dz,
        cx - z.half, this.pos.y + z.y0, cz - z.half,
        cx + z.half, this.pos.y + z.y1, cz + z.half
      );
      if (t !== null && t >= 0 && t <= maxDist && (!best || t < best.dist)) {
        best = { dist: t, zone: z.name, mult: z.mult, enemy: this };
      }
    }
    return best;
  }

  takeDamage(amount, zone) {
    if (this.dead) return false;
    this.hp -= amount;
    // 被打中立即转入战斗（知道自己被攻击了）
    if (this.state !== STATE.BLINDED) this.state = STATE.COMBAT;
    this.alerted = true;
    if (this.hp <= 0) {
      this.hp = 0;
      this.dead = true;
      this.state = STATE.DEAD;
      this.rig.setVisible(false);
      return true;                     // 击杀
    }
    return false;
  }

  blind(now, duration = 3.5) {
    if (this.dead) return;
    this.state = STATE.BLINDED;
    this.blindUntil = now + duration;
  }

  /** 能否看见玩家：视野锥 + 无遮挡 + 被照亮或极近 */
  canSeePlayer(player, flashlight) {
    if (this.dead) return false;
    const px = player.pos.x, pz = player.pos.z;
    const py = player.pos.y + player.body.height * 0.7;

    const dx = px - this.pos.x, dz = pz - this.pos.z;
    const dy = py - this.eyeY;
    const dist = Math.hypot(dx, dy, dz);

    let range = PERCEPTION.visionRange * flashlight.detectionMultiplier;
    if (this.archetype === ARCHETYPE.SENTRY) range *= PERCEPTION.sentryRangeMul;
    // 玩家不在光照中时更难被发现
    const lit = flashlight.on;
    if (!lit) range *= PERCEPTION.shadowMul;

    if (dist > range) return false;

    // 极近距离无条件察觉（贴身公平性）
    if (dist < 2.5) return !this.world.lineBlocked(this.pos.x, this.eyeY, this.pos.z, px, py, pz);

    // 视野锥：水平 + 垂直
    const fwdX = -Math.sin(this.yaw), fwdZ = -Math.cos(this.yaw);
    const hLen = Math.hypot(dx, dz) || 1;
    const cosH = (dx / hLen) * fwdX + (dz / hLen) * fwdZ;
    if (cosH < Math.cos(PERCEPTION.hFovDeg * Math.PI / 360)) return false;
    const vAngle = Math.abs(Math.atan2(dy, hLen));
    if (vAngle > PERCEPTION.vFovDeg * Math.PI / 360) return false;

    return !this.world.lineBlocked(this.pos.x, this.eyeY, this.pos.z, px, py, pz);
  }

  /** 听到噪音 → 进入调查 */
  hearNoise(x, y, z, radius) {
    if (this.dead || this.state === STATE.COMBAT) return false;
    const dy = Math.abs(y - this.pos.y);
    // 跨楼板半径衰减
    const effective = dy > 2 ? radius * PERCEPTION.crossFloorMul : radius;
    const d = Math.hypot(x - this.pos.x, y - this.pos.y, z - this.pos.z);
    if (d > effective) return false;
    this.investigateTarget = new THREE.Vector3(x, y, z);
    if (this.state === STATE.IDLE) {
      this.state = STATE.INVESTIGATE;
      this.stateTime = 0;
    }
    return true;
  }

  /** 被同伴呼叫 → 进入警戒 */
  onCalled(x, y, z) {
    if (this.dead || this.state === STATE.COMBAT) return;
    this.alerted = true;
    this.investigateTarget = new THREE.Vector3(x, y, z);
    if (this.state === STATE.IDLE) { this.state = STATE.INVESTIGATE; this.stateTime = 0; }
  }

  update(dt, now, ctx) {
    if (this.dead) return;
    const { player, flashlight, combat } = ctx;
    this.stateTime += dt;
    this.weapon.update(now, dt);

    const sees = this.canSeePlayer(player, flashlight);
    // 光斑先于你抵达：敌人察觉手电光斑，不需要看见玩家本人
    const spotsLight = !sees && flashlight.spotNoticedBy(this.pos.x, this.pos.y, this.pos.z);

    if (sees) {
      this.lastSeenPlayer.set(player.pos.x, player.pos.y, player.pos.z);
      this.hasLastSeen = true;
    }

    switch (this.state) {
      case STATE.BLINDED:
        // 致盲：无法射击，原地转身
        this.yaw += dt * 2.2;
        if (now >= this.blindUntil) {
          this.state = sees ? STATE.COMBAT : STATE.INVESTIGATE;
          this.stateTime = 0;
        }
        break;

      case STATE.IDLE:
        this.doIdle(dt, sees, spotsLight);
        break;

      case STATE.INVESTIGATE:
        this.doInvestigate(dt, sees);
        break;

      case STATE.ALERT:
        // 举枪窗口：玩家唯一的反应机会
        this.faceTarget(player, dt, 7);
        this.reactionTimer -= dt;
        this.rig.gunPivot.rotation.x = -0.35;      // 可见的举枪动作
        if (this.reactionTimer <= 0) {
          this.state = STATE.COMBAT;
          this.stateTime = 0;
          this.callAllies(ctx);
        }
        break;

      case STATE.COMBAT:
        this.doCombat(dt, now, sees, ctx);
        break;
    }

    // 视觉更新
    this.rig.root.position.copy(this.pos);
    const moving = this.state === STATE.INVESTIGATE || this.state === STATE.COMBAT
      || (this.archetype === ARCHETYPE.PATROLLER && this.state === STATE.IDLE);
    this.rig.update(dt, {
      speed: moving ? 1.4 : 0,
      yaw: this.yaw,
      pitch: 0,
      crouchAmt: this.archetype === ARCHETYPE.PRONE && !this.proneWoken ? 0 : 0,
      leanAmt: 0,
      aiming: this.state === STATE.COMBAT || this.state === STATE.ALERT,
    });
    if (this.archetype === ARCHETYPE.PRONE && !this.proneWoken) this.setProne(true);
  }

  doIdle(dt, sees, spotsLight) {
    if (this.archetype === ARCHETYPE.PRONE) {
      // 伏地者：玩家靠近或被照到才起身
      const d = Math.hypot(this.pos.x - _lastPlayerPos.x, this.pos.z - _lastPlayerPos.z);
      if (sees || d < PERCEPTION.proneWakeRange) {
        this.proneWoken = true;
        this.setProne(false);
        this.toAlert();
      }
      return;
    }

    if (this.archetype === ARCHETYPE.PATROLLER && this.patrol) {
      this.walkPatrol(dt);
    } else {
      // 蹲守者：朝向固定，轻微扫视
      this.yaw = this.homeYaw + Math.sin(this.stateTime * 0.5) * 0.35;
    }

    if (sees) this.toAlert();
    else if (spotsLight) {
      // 看到光斑 → 警戒（不是立刻开火，因为还没看见人）
      this.state = STATE.INVESTIGATE;
      this.stateTime = 0;
      this.investigateTarget = null;
      this.alerted = true;
    }
  }

  doInvestigate(dt, sees) {
    if (sees) { this.toAlert(); return; }
    if (this.investigateTarget) {
      const arrived = this.moveToward(this.investigateTarget, dt, 1.5);
      if (arrived) this.investigateTarget = null;
    } else {
      // 无明确目标：原地扫视
      this.yaw += dt * 1.4;
    }
    if (this.stateTime > PERCEPTION.investigateTime) {
      this.state = STATE.IDLE;
      this.stateTime = 0;
    }
  }

  doCombat(dt, now, sees, ctx) {
    const { player, combat } = ctx;
    this.faceTarget(player, dt, 9);

    if (!sees) {
      // 失去目标：走向最后看到的位置
      if (this.stateTime > PERCEPTION.loseTargetTime && this.hasLastSeen) {
        this.investigateTarget = this.lastSeenPlayer.clone();
        this.state = STATE.INVESTIGATE;
        this.stateTime = 0;
      }
      return;
    }

    // 换弹
    if (this.weapon.isEmpty) { this.weapon.startReload(now); return; }
    if (this.weapon.reloading) return;

    // 开火（带散布，会打空）
    if (now >= this.nextShotAt && this.weapon.canFire(now)) {
      this.weapon.consume(now);
      combat.enemyShoot(this, player, now);
      this.nextShotAt = now + 1 / this.weapon.spec.rof
        + (this.weapon.spec.auto ? 0 : PERCEPTION.burstGap);
    }
  }

  toAlert() {
    this.state = STATE.ALERT;
    this.stateTime = 0;
    this.reactionTimer = PERCEPTION.reactionMin
      + Math.random() * (PERCEPTION.reactionMax - PERCEPTION.reactionMin);
  }

  callAllies(ctx) {
    if (this.archetype !== ARCHETYPE.PATROLLER) return;
    for (const e of ctx.enemies) {
      if (e === this || e.dead) continue;
      const dy = Math.abs(e.pos.y - this.pos.y);
      const r = dy > 2 ? PERCEPTION.callRadius * PERCEPTION.crossFloorMul
                       : PERCEPTION.callRadius;
      if (e.pos.distanceTo(this.pos) <= r) e.onCalled(this.pos.x, this.pos.y, this.pos.z);
    }
  }

  faceTarget(player, dt, rate) {
    const dx = player.pos.x - this.pos.x, dz = player.pos.z - this.pos.z;
    const want = Math.atan2(-dx, -dz);
    let diff = want - this.yaw;
    while (diff > Math.PI) diff -= Math.PI * 2;
    while (diff < -Math.PI) diff += Math.PI * 2;
    this.yaw += diff * Math.min(1, dt * rate);
  }

  /** 朝目标走一步，返回是否已到达。会做简单的墙体规避 */
  moveToward(target, dt, speed) {
    const dx = target.x - this.pos.x, dz = target.z - this.pos.z;
    const d = Math.hypot(dx, dz);
    if (d < 0.6) return true;
    const nx = dx / d, nz = dz / d;
    const want = Math.atan2(-nx, -nz);
    let diff = want - this.yaw;
    while (diff > Math.PI) diff -= Math.PI * 2;
    while (diff < -Math.PI) diff += Math.PI * 2;
    this.yaw += diff * Math.min(1, dt * 6);

    const stepX = nx * speed * dt, stepZ = nz * speed * dt;
    // 分轴推进，撞墙则只走另一轴（沿墙滑行）
    if (!this.blockedAt(this.pos.x + stepX, this.pos.z)) this.pos.x += stepX;
    if (!this.blockedAt(this.pos.x, this.pos.z + stepZ)) this.pos.z += stepZ;

    // 贴地：跟随地面高度（含半格阶梯）
    const surf = this.world.highestSurfaceUnder(
      this.pos.x - 0.28, this.pos.z - 0.28, this.pos.x + 0.28, this.pos.z + 0.28,
      this.pos.y + 0.65, this.pos.y - 1.2
    );
    if (Number.isFinite(surf)) this.pos.y = surf;
    return false;
  }

  blockedAt(x, z) {
    return this.world.boxIntersects(
      x - 0.28, this.pos.y + 0.05, z - 0.28,
      x + 0.28, this.pos.y + this.height - 0.05, z + 0.28
    );
  }

  walkPatrol(dt) {
    const pt = this.patrol[this.patrolIdx];
    _v.set(pt[0], this.pos.y, pt[1]);
    if (this.moveToward(_v, dt, 1.2)) {
      this.patrolIdx = (this.patrolIdx + 1) % this.patrol.length;
    }
  }
}

/** 伏地者需要知道玩家位置，用一个模块级缓存避免每帧传参 */
const _lastPlayerPos = new THREE.Vector3();
export function setPlayerPosCache(p) { _lastPlayerPos.set(p.x, p.y, p.z); }

/** 射线 vs AABB（slab 法），返回进入距离或 null */
function rayBox(ox, oy, oz, dx, dy, dz, minX, minY, minZ, maxX, maxY, maxZ) {
  let tmin = -Infinity, tmax = Infinity;
  const o = [ox, oy, oz], d = [dx, dy, dz];
  const lo = [minX, minY, minZ], hi = [maxX, maxY, maxZ];
  for (let i = 0; i < 3; i++) {
    if (Math.abs(d[i]) < 1e-8) {
      if (o[i] < lo[i] || o[i] > hi[i]) return null;
    } else {
      let t1 = (lo[i] - o[i]) / d[i];
      let t2 = (hi[i] - o[i]) / d[i];
      if (t1 > t2) { const t = t1; t1 = t2; t2 = t; }
      tmin = Math.max(tmin, t1);
      tmax = Math.min(tmax, t2);
      if (tmin > tmax) return null;
    }
  }
  return tmin >= 0 ? tmin : (tmax >= 0 ? 0 : null);
}

export { PERCEPTION, rayBox };
