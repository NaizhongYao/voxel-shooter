import * as THREE from 'three';
import { PALETTE, PLAYER, CAMERA } from '../config.js';
import { D } from '../difficulty.js';
import { Body } from './physics.js';
import { BlockyRig } from './rig.js';
import { ENTITY_RADIUS } from '../systems/enemy.js';
import { createInventory, placeItem, clearLoot } from '../systems/inventory.js';
import { createRaidInventory, getCarriedItems } from '../systems/raid-inventory.js';

/**
 * 玩家控制器：把输入 → 三档速度 → 物理体 → 方块人形 串起来。
 *
 * 四档移动速度/姿态是节奏控制器（GDD 06 章）：
 *   常速 / 冲刺 / legacy slow walk / 蹲伏，同时影响噪音半径与散布倍率。
 */
export class Player {
  constructor(world, spawn, loadoutModifiers = {}) {
    this.world = world;
    this.body = new Body(spawn.x, spawn.y, spawn.z);
    this.rig = new BlockyRig(PALETTE.player, { isPlayer: true, kit: 'player' });
    this.loadoutModifiers = {
      moveSpeedMult: loadoutModifiers.moveSpeedMult ?? 1,
      noiseRadiusMult: loadoutModifiers.noiseRadiusMult ?? 1,
      detectionMult: loadoutModifiers.detectionMult ?? 1,
      // 值为护甲 id：rig.setArmorKit 按它查 ARMOR_KIT_COLORS 专属配色
      visualKit: loadoutModifiers.visualKit ?? 'standard',
      carryCapBonus: loadoutModifiers.carryCapBonus ?? 0,
      litExposureMul: loadoutModifiers.litExposureMul ?? 1,
      grenadeBonus: loadoutModifiers.grenadeBonus ?? 0,
    };
    this.rig.setArmorKit(this.loadoutModifiers.visualKit);
    // 难度定义基础血量，装备定义护甲上限与移动/潜行修正。
    this.hpMax = D().hpMax;
    this.armorMax = loadoutModifiers.armorMax ?? D().armorMax;
    this.hp = this.hpMax;
    /** 盔甲先扣、生命后扣。盔甲是否还在是玩家最重要的安全信号。 */
    this.armor = this.armorMax;

    this.leanTarget = 0;
    this.leanAmt = 0;
    this.stance = 'normal';        // normal | sprint | crouch | slow
    this.crouchToggled = false;
    this.crouchRequested = false;  // hold crouch 与切换 crouch 的合并结果
    this.rolling = false;
    this.rollRemaining = 0;
    this.rollCooldown = 0;
    this.horizSpeed = 0;
    this.aiming = false;           // 由主循环按右键状态同步
    this.lastFallDamage = 0;
    this.dead = false;

    /**
     * 本局背包（批 1：结构化容器，见 INVENTORY-SYSTEM-DESIGN.md §3.5）。
     * 真正的槽位化容器：armor 专属槽 + pistol 保底位 + primary/grenade/misc
     * 定长稀疏数组。护甲槽为空 = 视为 standard（§2.5.2）；手枪位在批 4
     * 由 Loadout 接线（§6），批 1 阶段游戏行为与改造前完全一致。
     * 局内不持久：刷新重载后这一局重开，背包随实例重建而清空。
     */
    this.inventory = createInventory();
    // 批 0 统一容器根：equipment/backpack/quickUse/openContainer。legacyInventory
    // 让 backpack 数组复用 this.inventory 的引用，因此旧 player API 与新容器
    // 没有两份可独立修改的局内背包真源；主武器战斗真源仍是 Loadout（批 2 才迁移）。
    this.raidInventory = createRaidInventory({ legacyInventory: this.inventory });
    this.syncCarryCapacity();

    this._fwd = new THREE.Vector3();
    this._right = new THREE.Vector3();
    this._rollDir = new THREE.Vector3();
    this._muzzlePos = new THREE.Vector3();
    this._muzzleDir = new THREE.Vector3();
  }

  /**
   * 按当前护甲的 carryCapBonus 重算携带栏上限，并只调整 misc 格数。
   * 不碰 primary（weaponSlots 是双主武器任务的范围）。
   * 出击时 loadoutModifiers 整体替换后必须再调一次，否则 HUD / 放置仍是开局 4 格。
   */
  syncCarryCapacity() {
    const bonus = this.loadoutModifiers?.carryCapBonus ?? 0;
    this.carryCap = Math.max(1, (PLAYER.carryCap ?? 4) + bonus);
    const arr = this.inventory?.misc;
    if (!Array.isArray(arr)) return;
    while (arr.length < this.carryCap) arr.push(null);
    if (arr.length > this.carryCap) arr.length = this.carryCap;
  }

  get pos() { return this.body.pos; }

  /** 总有效血量，HUD 与评级都按它算 */
  get totalHp() { return this.hp + this.armor; }
  get totalHpMax() { return this.hpMax + this.armorMax; }
  /** 生命低于阈值 → 屏幕红色脉冲警告 */
  get lowHp() { return this.hp / this.hpMax <= PLAYER.lowHpFraction; }

  // ── 携带栏（战利品箱）──────────────────────────────────────────────────
  /**
   * 携带物扁平视图（向后兼容外壳，INVENTORY-SYSTEM-DESIGN §3.5 / §12）。
   * 从结构化容器打平返回非空实例。手枪位（保底）与护甲位（带入装备）不属于
   * 「本局战利品」，不打平 —— 否则空手局的结算横幅会被误判成「带回物品」
   * （main.js `hasLoot = player.carriedLoot.length > 0`）。
   */
  get carriedLoot() {
    // 统一容器的扁平兼容视图；保留原顺序（主武器 → 手雷 → 杂项）。
    return getCarriedItems(this.raidInventory);
  }
  /** 已占格数：每个非空格 1 件（堆叠发生在 autoPlace 路径，批 4 接线） */
  get carryCount() { return this.carriedLoot.length; }
  get carryFree() { return Math.max(0, this.carryCap - this.carryCount); }
  get carryFull() { return this.carryFree <= 0; }
  /** 携带物总价值（单件价值 × 数量之和）。HUD 与结算文案共用这一个数字。 */
  get carryValue() {
    return this.carriedLoot.reduce(
      (sum, i) => sum + (i.value ?? 0) * (i.quantity ?? 1), 0
    );
  }
  /**
   * 往携带栏放一件战利品。
   * 容量满返回 false：主循环把箱子里的货留在原处，等玩家腾出格子再来拿，
   * 而不是静默丢失（搜刮结果必须总是「可预期」的）。
   * 容量判断按目标类别（§12.3）：手雷格满不代表杂项格满。
   */
  addCarriedLoot(item) {
    if (!item) return false;
    return placeItem(this.inventory, item);
  }
  /**
   * 清空携带栏（死亡/放弃结算时把本局收获全部丢弃）。QuickUse 的开局种子
   * 用 payload.raidOrigin 标记，保留给旧 game.nades adapter；本局放入的 QuickUse
   * 物品则和背包战利品一起清除。
   */
  clearCarriedLoot() {
    clearLoot(this.inventory);
    for (let i = 0; i < this.raidInventory.quickUse.length; i++) {
      if (this.raidInventory.quickUse[i]?.payload?.raidOrigin !== 'loadout') {
        this.raidInventory.quickUse[i] = null;
      }
    }
  }

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
    return PLAYER.noise[this.stance]
      * this.loadoutModifiers.noiseRadiusMult;
  }

  /**
   * 当前散布倍率 = 姿态倍率 × 瞄准倍率 × 移动惩罚。
   * 之前开镜只改 FOV 和相机位置，对精度毫无影响——右键除了看得清一点
   * 没有任何机械收益。现在瞄准会明显收窄散布，蹲下瞄准最准。
   */
  get spreadMultiplier() {
    const stance = PLAYER.spread[this.stance];
    const ads = this.aiming ? PLAYER.spread.adsMul : 1;
    // 冲刺与翻滚都高于常速，移动惩罚按常速归一后钳到 1。
    const moveFrac = Math.min(1, this.horizSpeed / (PLAYER.speed * this.loadoutModifiers.moveSpeedMult));
    const move = 1 + moveFrac * (PLAYER.spread.movePenalty - 1);
    return stance * ads * move;
  }

  update(dt, input, cam) {
    // 翻滚期间锁定 ADS；主循环也会据此屏蔽开火。
    this.aiming = cam.aiming && !this.rolling;
    this.rollCooldown = Math.max(0, this.rollCooldown - dt);

    // ---- 姿态 ----
    if (input.justPressed('crouchToggle')) this.crouchToggled = !this.crouchToggled;
    this.crouchRequested = input.down('crouchHold') || this.crouchToggled;
    this.body.setCrouch(this.world, this.crouchRequested);
    const wantSlow = input.down('slow');

    // ---- 移动（相对相机）----
    cam.basis(this._fwd, this._right);
    let mx = 0, mz = 0;
    if (input.down('forward')) { mx += this._fwd.x; mz += this._fwd.z; }
    if (input.down('back'))    { mx -= this._fwd.x; mz -= this._fwd.z; }
    if (input.down('right'))   { mx += this._right.x; mz += this._right.z; }
    if (input.down('left'))    { mx -= this._right.x; mz -= this._right.z; }
    const mlen = Math.hypot(mx, mz);
    if (mlen > 1e-4) { mx /= mlen; mz /= mlen; }

    if (!this.rolling && input.justPressed('roll') && this.body.onGround && this.rollCooldown <= 0) {
      // 有 WASD 时翻向输入方向；没有输入时沿相机前向翻滚。
      this._rollDir.set(mlen > 1e-4 ? mx : this._fwd.x, 0, mlen > 1e-4 ? mz : this._fwd.z);
      this._rollDir.normalize();
      this.rolling = true;
      this.rollRemaining = PLAYER.roll.duration;
      this.rollCooldown = PLAYER.roll.cooldown;
      this.aiming = false;
      cam.aiming = false;
      this.body.vel.x = 0;
      this.body.vel.z = 0;
    }

    if (this.rolling) {
      const step = Math.min(dt, this.rollRemaining);
      const rollSpeed = PLAYER.roll.distance / PLAYER.roll.duration;
      // 保持正常高度，关闭自动登台，使用 Body 的 AABB 解算阻挡墙面。
      this.body.moveHorizontal(this.world,
        this._rollDir.x * rollSpeed * step,
        this._rollDir.z * rollSpeed * step,
        { allowStepUp: false });
      this.body.trackApex();
      this.body.update(this.world, dt);
      this.rollRemaining -= dt;
      if (this.rollRemaining <= 0) {
        this.rolling = false;
        this.rollRemaining = 0;
        this.body.vel.x = 0;
        this.body.vel.z = 0;
      }
      this.stance = 'normal';
    } else {
      const wantSprint = input.down('sprint') && !this.body.crouching && !wantSlow && mlen > 1e-4;
      this.stance = this.body.crouching ? 'crouch' : wantSlow ? 'slow' : wantSprint ? 'sprint' : 'normal';
      const baseSpeed =
        this.stance === 'crouch' ? PLAYER.crouchSpeed :
        this.stance === 'slow'   ? PLAYER.slowSpeed :
        this.stance === 'sprint' ? PLAYER.speed * PLAYER.sprintMultiplier : PLAYER.speed;
      const speedCap = baseSpeed * this.loadoutModifiers.moveSpeedMult;
      const targetVX = mx * speedCap;
      const targetVZ = mz * speedCap;
      const accel = (this.body.onGround ? PLAYER.accel : PLAYER.airAccel) * dt;
      this.body.vel.x += (targetVX - this.body.vel.x) * Math.min(1, accel);
      this.body.vel.z += (targetVZ - this.body.vel.z) * Math.min(1, accel);

      if (input.justPressed('jump')) this.body.jump();
      this.body.trackApex();
      this.body.update(this.world, dt);
    }

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

    this.horizSpeed = this.rolling
      ? PLAYER.roll.distance / PLAYER.roll.duration
      : Math.hypot(this.body.vel.x, this.body.vel.z);

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
