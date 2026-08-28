import * as THREE from 'three';
import { PLAYER, CAMERA } from '../config.js';
import { D } from '../difficulty.js';
import { Body } from './physics.js';
import { BlockyRig } from './rig.js';
import { ENTITY_RADIUS } from '../systems/enemy.js';

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
    this.rig = new BlockyRig(undefined, { isPlayer: true, kit: 'player' });
    // 血量与护甲上限由难度决定（简单 120+240 / 困难 100+200 / 专家 80+120）
    this.hpMax = D().hpMax;
    this.armorMax = D().armorMax;
    this.hp = this.hpMax;
    /** 盔甲先扣、生命后扣。盔甲是否还在是玩家最重要的安全信号。 */
    this.armor = this.armorMax;

    this.leanTarget = 0;
    this.leanAmt = 0;
    this.stance = 'normal';        // normal | slow | crouch
    this.horizSpeed = 0;
    this.aiming = false;           // 由主循环按右键状态同步
    this.lastFallDamage = 0;
    this.dead = false;

    this._fwd = new THREE.Vector3();
    this._right = new THREE.Vector3();
    this._muzzlePos = new THREE.Vector3();
    this._muzzleDir = new THREE.Vector3();
  }

  get pos() { return this.body.pos; }

  /** 总有效血量，HUD 与评级都按它算 */
  get totalHp() { return this.hp + this.armor; }
  get totalHpMax() { return this.hpMax + this.armorMax; }
  /** 生命低于阈值 → 屏幕红色脉冲警告 */
  get lowHp() { return this.hp / this.hpMax <= PLAYER.lowHpFraction; }

  /**
   * 承受伤害。盔甲吸收 armorAbsorb 比例，其余渗透到生命。
   *
   * 为什么不让盔甲全额吸收：那样前 200 点伤害对玩家毫无反馈，
   * 血条不动、屏幕不红，玩家学不到「该躲了」。留 15% 渗透之后，
   * 盔甲还在时也会掉血，但掉得很慢 —— 既是缓冲也是警报。
   *
   * @returns {{armorLost:number, hpLost:number, died:boolean}}
   */
  applyDamage(rawAmount) {
    if (this.dead || rawAmount <= 0) return { armorLost: 0, hpLost: 0, died: false };
    // 难度倍率在入口处统一施加，各个伤害来源不需要各自记得乘
    const amount = Math.max(1, Math.round(rawAmount * D().incomingDamageMul));

    let hpDamage = amount;
    let armorLost = 0;
    if (this.armor > 0) {
      const absorbed = Math.min(this.armor, Math.round(amount * PLAYER.armorAbsorb));
      armorLost = absorbed;
      this.armor -= absorbed;
      hpDamage = amount - absorbed;
    }

    const hpLost = Math.min(this.hp, hpDamage);
    this.hp -= hpLost;
    if (this.hp <= 0) {
      this.hp = 0;
      this.dead = true;
    }
    return { armorLost, hpLost, died: this.dead };
  }

  get noiseRadius() {
    if (this.horizSpeed < 0.05) return 0;
    return PLAYER.noise[this.stance === 'crouch' ? 'crouch' : this.stance];
  }

  /**
   * 当前散布倍率 = 姿态倍率 × 瞄准倍率 × 移动惩罚。
   * 之前开镜只改 FOV 和相机位置，对精度毫无影响——右键除了看得清一点
   * 没有任何机械收益。现在瞄准会明显收窄散布，蹲下瞄准最准。
   */
  get spreadMultiplier() {
    const stance = PLAYER.spread[this.stance === 'crouch' ? 'crouch' : this.stance];
    const ads = this.aiming ? PLAYER.spread.adsMul : 1;
    // 移动中射击额外惩罚，按当前速度占常速的比例插值
    const moveFrac = Math.min(1, this.horizSpeed / PLAYER.speed);
    const move = 1 + moveFrac * (PLAYER.spread.movePenalty - 1);
    return stance * ads * move;
  }

  update(dt, input, cam) {
    this.aiming = cam.aiming;

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

    // 玩家不能穿过敌人：解算完体素碰撞后，再把玩家推出实体重叠
    if (this.blockers) this.resolveEntityCollision();

    if (this.body.justLanded) {
      const dmg = this.body.fallDamage();
      this.lastFallDamage = dmg;
      // 摔伤直接打生命，不走盔甲 —— 护甲挡子弹，不挡地面
      if (dmg > 0) {
        this.hp = Math.max(0, this.hp - dmg);
        if (this.hp <= 0) this.dead = true;
      }
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

  /**
   * 把玩家推出与敌人的重叠。
   * 只移动玩家、且不推进方块里——所以贴着墙挤敌人时玩家会被卡住，
   * 而不是穿过去或被顶进墙内。
   */
  resolveEntityCollision() {
    const minD = ENTITY_RADIUS + PLAYER.width / 2;
    for (const e of this.blockers) {
      if (e.dead) continue;
      if (Math.abs(e.pos.y - this.body.pos.y) > 1.4) continue;
      const dx = this.body.pos.x - e.pos.x, dz = this.body.pos.z - e.pos.z;
      const d = Math.hypot(dx, dz);
      if (d >= minD || d < 1e-4) continue;
      const push = minD - d;
      const nx = dx / d, nz = dz / d;
      const tryX = this.body.pos.x + nx * push;
      const tryZ = this.body.pos.z + nz * push;
      if (!this.body.blocked(this.world, tryX, this.body.pos.y, this.body.pos.z)) {
        this.body.pos.x = tryX;
      }
      if (!this.body.blocked(this.world, this.body.pos.x, this.body.pos.y, tryZ)) {
        this.body.pos.z = tryZ;
      }
    }
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

    // 第一人称下相机就在眼睛处，直接沿视线出弹；
    // 第三人称才需要「枪口 → 准星命中点」的修正（GDD 05 章）。
    // 否则第一人称会因为枪口在身体侧面而产生可见的偏移。
    if (cam.firstPerson) {
      return {
        point: P, dir: camDir.clone(),
        blocked: false, dist: camPos.distanceTo(P), origin: camPos.clone(),
      };
    }

    const { pos } = this.muzzle();
    const dir = new THREE.Vector3().subVectors(P, pos).normalize();
    const dist = pos.distanceTo(P);
    const blocked = this.world.lineBlocked(pos.x, pos.y, pos.z, P.x, P.y, P.z)
      && dist > 0.6;

    return { point: P, dir, blocked, dist, origin: pos.clone() };
  }
}
