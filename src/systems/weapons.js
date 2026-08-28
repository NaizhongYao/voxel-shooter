import { PALETTE, PLAYER } from '../config.js';

/**
 * 武器数据表（GDD 07 章）。纯数据，便于调参。
 *
 * 对称致死：敌我 HP 都是 60。
 * AR 3 枪、手枪 3 枪、SMG 5 枪、霰弹贴脸 1 枪、DMR 1 枪，任意武器爆头 1 枪。
 *
 * 单位：伤害为点数；rof 发/秒；spread 度；range/noise 为 vox；reload 秒。
 * sound: 合成枪声的档位（light / medium / heavy），见 systems/audio.js。
 */
export const WEAPONS = {
  pistol: {
    id: 'pistol', name: 'M19 消音', short: 'M19',
    color: PALETTE.pistol ?? 0x9aa7b8,
    damage: 26, rof: 4, auto: false,
    spread: 2.0, mag: 12, reload: 1.0,
    range: 26, pierce: 1, noise: 26,
    reserve: Infinity,                 // 保底武器：备弹无限
    pellets: 1,
    recoil: { kick: 0.45, climb: 1.5, shake: 0.16 },
    muzzleScale: 0.34, tracer: 0.5,
    sound: 'light',
    slot: 1,
  },
  pistolFast: {
    id: 'pistolFast', name: 'M19C 快射', short: 'M19C',
    color: 0xc9d4de,
    damage: 22, rof: 8, auto: false,
    spread: 3.2, mag: 15, reload: 1.1,
    range: 24, pierce: 1, noise: 36,
    reserve: Infinity,
    pellets: 1,
    recoil: { kick: 0.38, climb: 2.0, shake: 0.18 },
    muzzleScale: 0.38, tracer: 0.55,
    sound: 'medium',
    slot: 1,
  },
  smg: {
    id: 'smg', name: 'MP7 冲锋枪', short: 'MP7',
    color: 0x4cc9f0,
    damage: 13, rof: 12, auto: true,
    spread: 7.0, mag: 32, reload: 1.6,
    range: 20, pierce: 1, noise: 32,
    reserve: 96, pellets: 1,
    recoil: { kick: 0.3, climb: 2.6, shake: 0.13 },
    muzzleScale: 0.3, tracer: 0.45,
    sound: 'light',
    slot: 2,
  },
  shotgun: {
    id: 'shotgun', name: 'M870 霰弹枪', short: 'M870',
    color: 0xe5484d,
    damage: 11, rof: 1.1, auto: false,
    spread: 18.0, mag: 6, reload: 2.4,
    range: 16, pierce: 1, noise: 40,
    reserve: 24, pellets: 8,
    // 弹丸向锥心聚集：保证「贴脸一枪致死」，同时远距离依然散得很开
    pelletConcentrate: 3.2,
    recoil: { kick: 1.0, climb: 5.5, shake: 0.55 },
    muzzleScale: 0.62, tracer: 0.3,
    falloff: true,                     // 超出射程后快速衰减
    sound: 'heavy',
    slot: 2,
  },
  ar: {
    id: 'ar', name: 'AR-15 突击步枪', short: 'AR-15',
    color: 0xf5a623,
    damage: 21, rof: 8.5, auto: true,
    spread: 3.5, mag: 30, reload: 1.9,
    range: 35, pierce: 1, noise: 35,
    reserve: 90, pellets: 1,
    recoil: { kick: 0.5, climb: 2.1, shake: 0.2 },
    muzzleScale: 0.4, tracer: 0.6,
    sound: 'medium',
    slot: 2,
  },
  dmr: {
    id: 'dmr', name: 'DMR 精准步枪', short: 'DMR',
    color: 0xa78bfa,
    damage: 65, rof: 1.2, auto: false,
    spread: 0.4, mag: 5, reload: 2.6,
    range: 60, pierce: 2, noise: 44,
    reserve: 15, pellets: 1,
    recoil: { kick: 0.9, climb: 4.2, shake: 0.42 },
    muzzleScale: 0.5, tracer: 0.9,
    sound: 'heavy',
    slot: 2,
  },
};

/**
 * 敌人命中盒倍率。
 *
 * head 用 3.0 而不是玩家那侧的 2.5：GDD 的 TTK 表要求 AR 爆头一枪致死，
 * 但 21 × 2.5 = 52.5 < 60 会变成两枪。3.0 让 AR(63)、手枪(78)、DMR、
 * 霰弹全部一枪，同时 MP7(39) 仍是两枪 —— 正好与 TTK 表逐行吻合。
 * 玩家侧保持 2.5（见 config.PLAYER.hitbox），因为 26 × 2.5 = 65 已经致死。
 */
export const HITBOX_MULT = { head: 3.0, torso: 1.0, limb: 0.7 };

/**
 * 单把枪的运行时状态。武器数据本身不可变，状态放这里。
 */
export class WeaponInstance {
  constructor(spec, { ammo = null, reserve = null } = {}) {
    this.spec = spec;
    this.ammo = ammo ?? spec.mag;
    this.reserve = reserve ?? spec.reserve;
    this.reloading = false;
    this.reloadUntil = 0;
    this.nextFireAt = 0;
    this.climb = 0;              // 当前后坐抬枪累积（度）
  }

  get name() { return this.spec.name; }
  get id() { return this.spec.id; }
  get isEmpty() { return this.ammo <= 0; }
  get canReload() {
    return !this.reloading && this.ammo < this.spec.mag && this.reserve > 0;
  }

  /** 当前实际散布（度）：基础 × 全局缩放 × 姿态/瞄准倍率 + 后坐抬枪 */
  currentSpread(stanceMul) {
    return this.spec.spread * PLAYER.spreadScale * stanceMul + this.climb;
  }

  canFire(now) {
    return !this.reloading && this.ammo > 0 && now >= this.nextFireAt;
  }

  /** 消耗一发并推进冷却，返回 true 表示成功开火 */
  consume(now) {
    if (!this.canFire(now)) return false;
    this.ammo--;
    this.nextFireAt = now + 1 / this.spec.rof;
    this.climb = Math.min(this.spec.recoil.climb * 2.4,
                          this.climb + this.spec.recoil.climb);
    return true;
  }

  startReload(now) {
    if (!this.canReload) return false;
    this.reloading = true;
    this.reloadUntil = now + this.spec.reload;
    return true;
  }

  update(now, dt) {
    // 后坐抬枪恢复
    if (this.climb > 0) this.climb = Math.max(0, this.climb - dt * 9);

    if (this.reloading && now >= this.reloadUntil) {
      this.reloading = false;
      const need = this.spec.mag - this.ammo;
      if (this.reserve === Infinity) {
        this.ammo = this.spec.mag;
      } else {
        const take = Math.min(need, this.reserve);
        this.ammo += take;
        this.reserve -= take;
      }
    }
  }

  reloadProgress(now) {
    if (!this.reloading) return 1;
    const total = this.spec.reload;
    return Math.min(1, Math.max(0, 1 - (this.reloadUntil - now) / total));
  }
}

/**
 * 玩家的两个武器槽：
 *  槽1 = M19 / M19C 手枪（永久、无限备弹、保底防卡关）
 *  槽2 = 开局所选或拾取的主武器（MP7 / AR / 霰弹 / DMR）
 */
export class Loadout {
  constructor({ pistolId = 'pistol', primaryId = null } = {}) {
    const pistol = WEAPONS[pistolId] ?? WEAPONS.pistol;
    this.slots = [new WeaponInstance(pistol), null];
    this.active = 0;
    this.switchUntil = 0;
    if (primaryId) this.setPrimary(primaryId, 0);
  }

  get current() { return this.slots[this.active]; }
  get switching() { return performance.now() / 1000 < this.switchUntil; }

  setPistol(pistolId) {
    const pistol = WEAPONS[pistolId] ?? WEAPONS.pistol;
    this.slots[0] = new WeaponInstance(pistol);
    if (this.active === 0) this.switchUntil = 0;
  }

  /**
   * 开局或热切换槽 2。传 null 卸下主武器并回到手枪。
   * now=0 时不锁切枪，保证「开始任务」第一帧就能开火。
   */
  setPrimary(weaponId, now = 0) {
    if (!weaponId) {
      this.slots[1] = null;
      this.active = 0;
      this.switchUntil = 0;
      return null;
    }
    const spec = WEAPONS[weaponId];
    if (!spec || spec.slot === 1) {
      this.slots[1] = null;
      this.active = 0;
      this.switchUntil = 0;
      return null;
    }
    const old = this.slots[1];
    this.slots[1] = new WeaponInstance(spec);
    this.active = 1;
    this.switchUntil = now > 0 ? now + 0.35 : 0;
    return old;
  }

  switchTo(idx, now) {
    if (idx === this.active || !this.slots[idx]) return false;
    this.active = idx;
    this.switchUntil = now + 0.35;      // 切换耗时 0.35s
    return true;
  }

  toggle(now) {
    return this.switchTo(this.active === 0 ? 1 : 0, now);
  }

  /**
   * 拾取主武器。旧主武器被返回，交给上层丢在脚下。
   */
  pickUp(spec, ammo, reserve, now) {
    const old = this.slots[1];
    this.slots[1] = new WeaponInstance(spec, { ammo, reserve });
    this.active = 1;
    this.switchUntil = now + 0.35;
    return old;
  }

  /**
   * 补充备弹。
   *
   * ══ 原来的实现有个玩家一定会撞上的坑 ══
   *
   * 旧版只给「当前手持的武器」加弹，且手枪备弹是 Infinity 直接 return false。
   * 于是两种极常见的情况下弹药盒完全捡不起来：
   *   1. 玩家还没捡到主武器（只有手枪）—— 开局阶段全部弹药盒都是废的
   *   2. 玩家有 AR 但临时切回手枪 —— 明明 AR 快没弹了，却补不进去
   * 返回 false 会让 PickupManager 不消耗那个拾取物，弹药盒就永远躺在地上，
   * 玩家反复走过去毫无反应，只会以为是 bug。
   *
   * 现在改成「优先补主武器，主武器不需要才补手枪」，
   * 并且无限备弹的武器不算「需要」。只要有任何一把枪能吃下这些弹药就返回 true。
   */
  addAmmo(amount) {
    // 需要补弹的候选：有限备弹、且没满到不需要
    const wants = this.slots.filter((w) => w && w.reserve !== Infinity);
    if (wants.length === 0) return false;

    // 优先给主武器（槽 2）—— 那是玩家真正在用的枪
    const primary = this.slots[1];
    const target = (primary && primary.reserve !== Infinity) ? primary : wants[0];
    target.reserve += amount;
    return true;
  }

  update(now, dt) {
    for (const w of this.slots) if (w) w.update(now, dt);
  }
}
