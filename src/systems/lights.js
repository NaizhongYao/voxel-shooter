import * as THREE from 'three';
import { LIGHT } from '../config.js';
import { BLOCK } from '../voxel/blocks.js';

/**
 * 应急灯系统：可击碎的闪烁灯。
 *
 * ══ 它解决的问题 ══
 *
 * 本作的黑暗是硬规则：不开手电几乎看不见路，开了手电敌人探测距离 ×1.8。
 * 这个二选一很干净，但整关只有这一个照明决策，中段会变得单调。
 * 应急灯加进第三个选项：**别人替你开的灯**。
 *
 *   站在灯下：不用开手电也勉强看得清（省下手电的暴露），
 *             但灯是持续、全向的暴露，敌人探测距离 ×2.0（比手电更糟）。
 *   打碎它：  换回全黑，代价是这片区域以后只能靠手电。
 *
 * 所以每盏灯都是一个「要光还是要暗」的局部决策，而不是背景装饰。
 *
 * ══ 为什么灯是体素而不是纯 Object3D ══
 *
 * 灯必须能被子弹打中。子弹判定走的是体素网格（world.raycast），
 * 所以灯的位置必须在网格里有个 ID（FLICKER_LAMP），打碎后写成
 * LAMP_BROKEN（残骸仍在，玩家看得出打过了）。
 * 但灯 solid:false —— 它挂在天花板下，不该挡人走路也不该挡别人的子弹，
 * 所以命中判定由本系统自己做一次射线，不依赖体素碰撞。
 *
 * ══ 性能 ══
 *
 * 只有最近的 maxLit 盏挂真 PointLight（不投阴影 —— 会穿墙，但它们的
 * 照射半径只有 5 vox，穿墙的观感损失远小于阴影贴图的开销）。
 * 其余的灯靠方块自发光的顶点色，远处看仍然是一个亮点。
 */

const L = () => LIGHT.emergencyLamp;

export class EmergencyLights {
  /**
   * @param scene three 场景
   * @param world 体素世界（灯的 ID 写在这里，所以子弹能打中）
   */
  constructor(scene, world) {
    this.scene = scene;
    this.world = world;
    /** 全部灯：{ gx, gy, gz, hp, broken, level, blackoutUntil, light } */
    this.lamps = [];
    /** 真光源池，按距离分配给最近的几盏 */
    this.pool = [];
    const cfg = L();
    for (let i = 0; i < cfg.maxLit; i++) {
      const p = new THREE.PointLight(cfg.color, 0, cfg.distance, cfg.decay);
      p.visible = false;
      scene.add(p);
      this.pool.push(p);
    }
    this._t = 0;
  }

  /**
   * 从体素网格扫出所有 FLICKER_LAMP，登记成灯对象。
   * 关卡只要往网格里写 FLICKER_LAMP，本系统就自动接管，不需要额外注册。
   */
  scan() {
    this.lamps.length = 0;
    const w = this.world;
    for (let y = 0; y < w.sy; y++)
      for (let z = 0; z < w.sz; z++)
        for (let x = 0; x < w.sx; x++) {
          if (w.get(x, y, z) !== BLOCK.FLICKER_LAMP) continue;
          this.lamps.push({
            gx: x, gy: y, gz: z,
            cx: x + 0.5, cy: y + (L().mountY - Math.floor(L().mountY)) + 0.15, cz: z + 0.5,
            hp: L().hp,
            broken: false,
            level: 1,
            blackoutUntil: 0,
            phase: Math.random() * 1000,
          });
        }
    return this.lamps.length;
  }

  get aliveCount() {
    let n = 0;
    for (const l of this.lamps) if (!l.broken) n++;
    return n;
  }

  /**
   * 玩家（或任意点）是否被某盏亮着的灯照到。
   * 敌人感知用这个来决定「站在灯下的玩家更容易被看见」。
   *
   * 只看水平距离与是否同层：灯照的是脚下一片地，不需要精确的球形衰减。
   * 完全熄灭的瞬间（blackout）不算被照亮 —— 这给潜行留出短暗窗。
   */
  litAt(x, y, z) {
    const r = L().litRadius;
    for (const l of this.lamps) {
      if (l.broken || l.level <= 0.01) continue;
      if (Math.abs(l.gy - y) > 4) continue;
      if (Math.hypot(l.cx - x, l.cz - z) > r) continue;
      // 灯与目标之间被墙挡住就不算照到
      if (this.world.lineBlocked(l.cx, l.cy, l.cz, x, y + 1.0, z)) continue;
      return true;
    }
    return false;
  }

  /** 敌人探测倍率：站在灯下比开手电更容易被发现 */
  detectMultiplierAt(x, y, z) {
    return this.litAt(x, y, z) ? L().litDetectMul : 1;
  }

  /**
   * 子弹是否命中某盏灯。由 combat 在打完墙体射线后调用 ——
   * 只有当灯比墙更近时才算命中（否则等于隔墙打灯）。
   *
   * @param ox,oy,oz 起点   @param dx,dy,dz 单位方向   @param maxDist 到墙的距离
   * @returns 命中的灯对象与距离，或 null
   */
  hitTest(ox, oy, oz, dx, dy, dz, maxDist) {
    let best = null;
    for (const l of this.lamps) {
      if (l.broken) continue;
      // 球体求交：灯管当作半径 0.45 的球（比一格小，要瞄一下才打得中）
      const R = 0.45;
      const mx = l.cx - ox, my = l.cy - oy, mz = l.cz - oz;
      const tca = mx * dx + my * dy + mz * dz;
      if (tca < 0) continue;
      const d2 = mx * mx + my * my + mz * mz - tca * tca;
      if (d2 > R * R) continue;
      const thc = Math.sqrt(R * R - d2);
      const t = tca - thc;
      if (t < 0 || t > maxDist) continue;
      if (!best || t < best.dist) best = { lamp: l, dist: t };
    }
    return best;
  }

  /**
   * 打灯。返回 true 表示这一枪把灯打碎了。
   * 打碎后写 LAMP_BROKEN 并标脏区块 —— 顶点色会重建成不发光的残骸。
   */
  damage(lamp, amount) {
    if (lamp.broken) return false;
    lamp.hp -= amount;
    if (lamp.hp > 0) return false;
    lamp.broken = true;
    lamp.level = 0;
    this.world.set(lamp.gx, lamp.gy, lamp.gz, BLOCK.LAMP_BROKEN);
    if (lamp.light) {
      lamp.light.visible = false;
      lamp.light = null;
    }
    return true;
  }

  /**
   * 每帧：更新闪烁亮度，并把真光源分配给离玩家最近的几盏。
   * @param dt   秒
   * @param px,py,pz 玩家位置（用于分配光源池）
   */
  update(dt, px, py, pz) {
    this._t += dt;
    const cfg = L();
    const now = this._t * 1000;

    // 1. 闪烁：按 flickerHz 重新掷亮度，偶发完全熄灭
    const step = 1 / cfg.flickerHz;
    for (const l of this.lamps) {
      if (l.broken) { l.level = 0; continue; }
      if (now < l.blackoutUntil) { l.level = 0; continue; }
      // 每盏灯用自己的相位，避免全场同步闪（同步闪像舞台灯，不像坏灯）
      const slot = Math.floor((this._t + l.phase) / step);
      if (slot !== l._slot) {
        l._slot = slot;
        if (Math.random() < cfg.blackoutChance) {
          l.blackoutUntil = now + cfg.blackoutMs;
          l.level = 0;
        } else {
          l.level = cfg.flickerMin + Math.random() * (1 - cfg.flickerMin);
        }
      }
    }

    // 2. 光源池：只给最近的 maxLit 盏挂真光源
    const alive = this.lamps.filter((l) => !l.broken);
    alive.sort((a, b) =>
      (Math.hypot(a.cx - px, a.cz - pz)) - (Math.hypot(b.cx - px, b.cz - pz)));
    for (const l of this.lamps) l.light = null;
    for (let i = 0; i < this.pool.length; i++) {
      const p = this.pool[i];
      const l = alive[i];
      if (!l) { p.visible = false; continue; }
      l.light = p;
      p.position.set(l.cx, l.cy, l.cz);
      p.intensity = cfg.intensity * l.level;
      p.visible = l.level > 0.01;
    }
  }
}
