import * as THREE from 'three';
import { PLAYER, CAMERA } from '../config.js';
import { Body } from './physics.js';
import { BlockyRig } from './rig.js';

/**
 * 玩家控制器：把输入 → 三档速度 → 物理体 → 方块人形 串起来。
 *
 * 三档移动速度是 RoN 的节奏控制器（GDD 06 章）：
 *   常速 2.6 / Ctrl 慢走 1.2 / 蹲伏 1.1，同时影响噪音半径与散布倍率。
 */
export class Player {
  constructor(world, spawn) {
    this.world = world;
    this.body = new Body(spawn.x, spawn.y, spawn.z);
    this.rig = new BlockyRig();
    this.hp = PLAYER.hpMax;

    this.leanTarget = 0;
    this.leanAmt = 0;
    this.stance = 'normal';        // normal | slow | crouch
    this.horizSpeed = 0;
    this.lastFallDamage = 0;

    this._fwd = new THREE.Vector3();
    this._right = new THREE.Vector3();
    this._muzzlePos = new THREE.Vector3();
    this._muzzleDir = new THREE.Vector3();
  }

  get pos() { return this.body.pos; }

  get noiseRadius() {
    if (this.horizSpeed < 0.05) return 0;
    return PLAYER.noise[this.stance === 'crouch' ? 'crouch' : this.stance];
  }

  get spreadMultiplier() {
    return PLAYER.spread[this.stance === 'crouch' ? 'crouch' : this.stance];
  }

  update(dt, input, cam) {
    // ---- 姿态 ----
    const wantCrouch = input.down('crouch');
    this.body.setCrouch(this.world, wantCrouch);
    const wantSlow = input.down('slow');
    this.stance = this.body.crouching ? 'crouch' : (wantSlow ? 'slow' : 'normal');

    const speedCap =
      this.stance === 'crouch' ? PLAYER.crouchSpeed :
      this.stance === 'slow'   ? PLAYER.slowSpeed   : PLAYER.speed;

    // ---- 移动（相对相机）----
    cam.basis(this._fwd, this._right);
    let mx = 0, mz = 0;
    if (input.down('forward')) { mx += this._fwd.x; mz += this._fwd.z; }
    if (input.down('back'))    { mx -= this._fwd.x; mz -= this._fwd.z; }
    if (input.down('right'))   { mx += this._right.x; mz += this._right.z; }
    if (input.down('left'))    { mx -= this._right.x; mz -= this._right.z; }
    const mlen = Math.hypot(mx, mz);
    if (mlen > 1e-4) { mx /= mlen; mz /= mlen; }

    const targetVX = mx * speedCap;
    const targetVZ = mz * speedCap;
    const accel = (this.body.onGround ? PLAYER.accel : PLAYER.airAccel) * dt;
    this.body.vel.x += (targetVX - this.body.vel.x) * Math.min(1, accel);
    this.body.vel.z += (targetVZ - this.body.vel.z) * Math.min(1, accel);

    if (input.justPressed('jump')) this.body.jump();

    this.body.trackApex();
    this.body.update(this.world, dt);

    if (this.body.justLanded) {
      const dmg = this.body.fallDamage();
      this.lastFallDamage = dmg;
      if (dmg > 0) this.hp = Math.max(0, this.hp - dmg);
    }

    this.horizSpeed = Math.hypot(this.body.vel.x, this.body.vel.z);

    // ---- 侧身倾斜（命中盒不动，只有视野探出）----
    const l = (input.down('leanLeft') ? -1 : 0) + (input.down('leanRight') ? 1 : 0);
    this.leanTarget = l;
    const leanRate = dt * 1000 / PLAYER.lean.timeMs;
    this.leanAmt += (this.leanTarget - this.leanAmt) * Math.min(1, leanRate);

    // ---- 视觉 ----
    const crouchAmt = 1 - (this.body.height - PLAYER.crouchHeight) /
                          (PLAYER.height - PLAYER.crouchHeight);
    this.rig.root.position.set(this.body.pos.x, this.body.pos.y, this.body.pos.z);
    this.rig.update(dt, {
      speed: this.horizSpeed,
      yaw: cam.yaw,
      pitch: cam.pitch,
      crouchAmt: THREE.MathUtils.clamp(crouchAmt, 0, 1),
      leanAmt: this.leanAmt,
      aiming: cam.aiming,
    });

    return { crouchAmt };
  }

  /** 枪口世界坐标与朝向。枪灯与子弹都从这里出发。 */
  muzzle() {
    this.rig.muzzleWorld(this._muzzlePos, this._muzzleDir);
    return { pos: this._muzzlePos, dir: this._muzzleDir };
  }

  /**
   * 准星命中一致性（GDD 05 章）：
   * 相机沿准星射线取命中点 P，子弹从枪口射向 P；
   * 若枪口 → P 被方块阻挡，则返回 blocked=true，上层禁止开火。
   */
  aimSolution(cam) {
    const camPos = cam.cam.position;
    const camDir = new THREE.Vector3();
    cam.cam.getWorldDirection(camDir);

    const hit = this.world.raycast(
      camPos.x, camPos.y, camPos.z, camDir.x, camDir.y, camDir.z, 80
    );
    const P = hit
      ? new THREE.Vector3(hit.point[0], hit.point[1], hit.point[2])
      : new THREE.Vector3().copy(camPos).addScaledVector(camDir, 80);

    const { pos } = this.muzzle();
    const dir = new THREE.Vector3().subVectors(P, pos).normalize();
    const dist = pos.distanceTo(P);
    const blocked = this.world.lineBlocked(pos.x, pos.y, pos.z, P.x, P.y, P.z)
      && dist > 0.6;

    return { point: P, dir, blocked, dist };
  }
}
