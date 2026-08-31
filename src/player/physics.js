import { PLAYER } from '../config.js';

/** 碰撞盒收缩量。整格通道 + 精确尺寸的碰撞体需要这层余量才不会卡住。 */
const SKIN = 0.02;

/**
 * 体素 AABB 碰撞体。无物理引擎：分轴推进 + 逐格测试。
 *
 * 关键设计：
 *  - 三轴分别推进并各自回退，得到贴墙滑行而不是卡死。
 *  - 水平受阻时尝试 stepUp（≤0.6 vox），让半格楼梯与 1 格台阶都能平滑走上。
 *  - 落地时记录下落高度，交给上层算摔伤（>4 vox 起算，5 HP/vox，上限 15）。
 */
export class Body {
  constructor(x, y, z) {
    this.pos = { x, y, z };           // pos.y = 脚底
    this.vel = { x: 0, y: 0, z: 0 };
    this.width = PLAYER.width;
    this.height = PLAYER.height;
    this.targetHeight = PLAYER.height;
    this.onGround = false;
    this.crouching = false;
    this.fallStartY = y;
    this.lastFallDistance = 0;
    this.justLanded = false;
  }

  get half() { return this.width / 2; }

  /**
   * 碰撞盒。水平方向与头顶各收一层 skin，脚底不收。
   *
   * 为什么头顶要收：蹲伏高度 1.0 恰好等于 1 格缝隙的净空，
   * 严丝合缝会被浮点误差判为碰撞，玩家永远钻不过去。
   * 为什么脚底不能收：脚底一旦抬高，落地检测会晚一个 skin 触发，
   * 角色会持续下沉并把摔落距离重置为 0。
   */
  bounds(px = this.pos.x, py = this.pos.y, pz = this.pos.z, h = this.height) {
    const hw = this.half - SKIN;
    return {
      minX: px - hw, maxX: px + hw,
      minY: py,      maxY: py + h - SKIN,
      minZ: pz - hw, maxZ: pz + hw,
    };
  }

  blocked(world, px, py, pz, h = this.height) {
    const b = this.bounds(px, py, pz, h);
    return world.boxIntersects(b.minX, b.minY, b.minZ, b.maxX, b.maxY, b.maxZ);
  }

  /** 能否在此位置站立（用于起身检测） */
  canStand(world, h) {
    return !this.blocked(world, this.pos.x, this.pos.y, this.pos.z, h);
  }

  setCrouch(world, want) {
    if (want) {
      this.crouching = true;
      this.targetHeight = PLAYER.crouchHeight;
    } else if (this.canStand(world, PLAYER.height)) {
      this.crouching = false;
      this.targetHeight = PLAYER.height;
    }
  }

  update(world, dt) {
    // 蹲伏高度平滑过渡
    const dh = this.targetHeight - this.height;
    if (Math.abs(dh) > 1e-4) {
      this.height += dh * Math.min(1, PLAYER.crouchLerp * dt);
    }

    this.vel.y = Math.max(this.vel.y + PLAYER.gravity * dt, -PLAYER.maxFallSpeed);
    this.justLanded = false;

    this.moveAxis(world, 'x', this.vel.x * dt);
    this.moveAxis(world, 'z', this.vel.z * dt);
    this.moveVertical(world, this.vel.y * dt);
  }

  /**
   * 单轴推进 + 碰撞响应。
   *
   * 关键：受阻时不整轴回退，而是二分推进到「刚好贴住墙面」。
   * 原来的整轴回退会让贴墙行走每帧都在「进入墙里 → 弹回原位」之间抖动，
   * 手感就是那种一卡一卡的顿感。推进到接触面后，贴墙滑行是连续的。
   */
  moveAxis(world, axis, delta, allowStepUp = true) {
    if (delta === 0) return 0;
    const before = this.pos[axis];
    this.pos[axis] = before + delta;
    if (!this.blocked(world, this.pos.x, this.pos.y, this.pos.z)) return delta;

    // 受阻：先尝试自动登台（半格阶梯 / 1 格台阶）
    if (allowStepUp && this.onGround) {
      for (let lift = 0.1; lift <= PLAYER.stepUpMax + 1e-6; lift += 0.1) {
        if (!this.blocked(world, this.pos.x, this.pos.y + lift, this.pos.z)) {
          this.pos.y += lift;
          return delta;
        }
      }
    }

    // 登不上去：二分找到最远的可行位置，贴住墙面而不是弹回。
    // 用距离 + 方向二分，保证向负轴滚动/后退时同样正确。
    const sign = Math.sign(delta);
    let lo = 0, hi = Math.abs(delta);
    for (let i = 0; i < 8; i++) {
      const mid = (lo + hi) / 2;
      this.pos[axis] = before + sign * mid;
      if (this.blocked(world, this.pos.x, this.pos.y, this.pos.z)) hi = mid;
      else lo = mid;
    }
    this.pos[axis] = before + sign * lo;
    this.vel[axis] = 0;
    return sign * lo;
  }

  /**
   * 用既有 AABB 解算推进一次水平位移。滚动等动作必须走这条路径，
   * 不能直接改视觉节点或跳过体素碰撞。
   */
  moveHorizontal(world, dx, dz, { allowStepUp = true } = {}) {
    const movedX = this.moveAxis(world, 'x', dx, allowStepUp);
    const movedZ = this.moveAxis(world, 'z', dz, allowStepUp);
    return { x: movedX, z: movedZ };
  }

  moveVertical(world, delta) {
    if (delta === 0) return;
    const before = this.pos.y;
    this.pos.y = before + delta;
    if (!this.blocked(world, this.pos.x, this.pos.y, this.pos.z)) {
      if (delta < 0) this.onGround = false;
      return;
    }

    if (delta < 0) {
      // 落地：吸附到脚下最高顶面
      const b = this.bounds();
      const surf = world.highestSurfaceUnder(
        b.minX, b.minZ, b.maxX, b.maxZ,
        before + 0.001, this.pos.y - 1
      );
      this.pos.y = Number.isFinite(surf) ? surf : before;
      if (!this.onGround) {
        this.lastFallDistance = Math.max(0, this.fallStartY - this.pos.y);
        this.justLanded = true;
      }
      this.onGround = true;
      this.fallStartY = this.pos.y;
      this.vel.y = 0;
    } else {
      // 撞头
      this.pos.y = before;
      this.vel.y = 0;
    }
  }

  /** 离地时持续记录最高点，供落地时算摔伤 */
  trackApex() {
    if (!this.onGround && this.pos.y > this.fallStartY) this.fallStartY = this.pos.y;
  }

  jump() {
    if (!this.onGround) return false;
    this.vel.y = Math.sqrt(-2 * PLAYER.gravity * PLAYER.jumpHeight);
    this.onGround = false;
    this.fallStartY = this.pos.y;
    return true;
  }

  fallDamage() {
    const d = this.lastFallDistance - PLAYER.terminalSafeFall;
    if (d <= 0) return 0;
    return Math.min(PLAYER.fallDmgCap, Math.round(d * PLAYER.fallDmgPerVox));
  }
}
