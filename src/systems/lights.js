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
 * 灯的身份来自 furniture placement / mesh metadata。子弹命中仍由本系统
 * 单独做球体求交，因此灯不需要参与体素碰撞；旧体素扫描只作为没有
 * furniture.placements 的过渡兼容路径。
 *
 * ══ 性能 ══
 *
 * 只有最近的 maxLit 盏挂真 PointLight（不投阴影 —— 会穿墙，但它们的
 * 照射半径只有 5 vox，穿墙的观感损失远小于阴影贴图的开销）。
 * 其余的灯靠家具模型的自发光材质，远处看仍然是一个亮点。
 */

const L = () => LIGHT.emergencyLamp;

export class EmergencyLights {
  /**
   * @param scene three 场景
   * @param world 体素世界；正式灯身份来自 world.furniture 元数据
   */
  constructor(scene, world) {
    this.scene = scene;
    this.world = world;
    /** 全部灯：{ gx, gy, gz, cx, cy, cz, hp, broken, level, blackoutUntil, phase, mesh } */
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
    this._brokenMaterial = null;
  }

  /**
   * 从 furniture placement / mesh metadata 登记应急灯。
   * placements 存在时即使网格里没有 FLICKER_LAMP 也必须能工作；只有旧世界
   * 没有 placements 时，才回退到旧体素扫描，避免普通家具 voxel 参与灯识别。
   */
  scan() {
    this.lamps.length = 0;
    const w = this.world;
    const furniture = w.furniture;
    const placementsExist = Array.isArray(furniture?.placements);
    const placements = placementsExist ? furniture.placements : [];
    const meshes = Array.isArray(furniture?.meshes) ? furniture.meshes : [];
    const meshEntries = meshes
      .map((mesh) => ({ mesh, metadata: mesh?.userData?.furniture }))
      .filter(({ metadata }) => metadata &&
        (metadata.id === 'flickerLamp' || metadata.id === 'lampBroken' ||
          metadata.lampState === 'broken'));

    let entries;
    if (placementsExist) {
      entries = placements
        .filter((item) => item &&
          (item.id === 'flickerLamp' || item.id === 'lampBroken' ||
            item.lampState === 'broken'))
        .map((placement) => ({ placement, mesh: this._findLampMesh(placement, meshEntries) }));
      // A furniture object may expose only mesh metadata for lamps. Use it when
      // the placements array exists but contains no lamp entries; still never
      // fall back to voxels in that case.
      if (entries.length === 0) {
        entries = meshEntries.map(({ mesh, metadata }) => ({ placement: metadata, mesh }));
      }
    } else if (meshEntries.length > 0) {
      entries = meshEntries.map(({ mesh, metadata }) => ({ placement: metadata, mesh }));
    } else {
      entries = [];
      for (let y = 0; y < w.sy; y++)
        for (let z = 0; z < w.sz; z++)
          for (let x = 0; x < w.sx; x++) {
            if (w.get(x, y, z) !== BLOCK.FLICKER_LAMP) continue;
            entries.push({ placement: { id: 'flickerLamp', x, y, z }, mesh: null });
          }
    }

    for (const { placement, mesh } of entries) {
      const x = Number.isFinite(placement.x) ? placement.x : placement.gx;
      const y = Number.isFinite(placement.y) ? placement.y : placement.gy;
      const z = Number.isFinite(placement.z) ? placement.z : placement.gz;
      if (![x, y, z].every(Number.isFinite)) continue;
      const gx = Math.floor(x), gy = Math.floor(y), gz = Math.floor(z);
      const broken = placement.broken === true || placement.id === 'lampBroken' ||
        placement.lampState === 'broken';
      this.lamps.push({
        gx, gy, gz,
        cx: x + 0.5, cy: y + (L().mountY - Math.floor(L().mountY)) + 0.15, cz: z + 0.5,
        hp: Number.isFinite(placement.hp) ? placement.hp : (broken ? 0 : L().hp),
        broken,
        level: broken ? 0 : (Number.isFinite(placement.level) ? placement.level : 1),
        blackoutUntil: Number.isFinite(placement.blackoutUntil) ? placement.blackoutUntil : 0,
        phase: Number.isFinite(placement.phase) ? placement.phase : Math.random() * 1000,
        placement,
        mesh,
      });
    }
    return this.lamps.length;
  }

  _findLampMesh(placement, meshEntries) {
    return meshEntries.find(({ metadata }) => metadata === placement ||
      (metadata.x === placement.x && metadata.y === placement.y && metadata.z === placement.z))?.mesh ?? null;
  }

  _showBrokenMesh(lamp) {
    const mesh = lamp.mesh;
    if (!mesh) return;
    mesh.visible = true;
    const metadata = mesh.userData?.furniture;
    if (metadata) {
      metadata.id = 'lampBroken';
      metadata.broken = true;
      metadata.lampState = 'broken';
      metadata.level = 0;
    }
    // The original fixture is a body plus a glow child. Keep the mount/body and
    // replace only the luminous tube with a few dark fragments in the same group.
    if (typeof mesh.traverse === 'function') {
      mesh.traverse((child) => {
        if (child.name === 'glow') child.visible = false;
      });
    }
    if (mesh.userData && mesh.userData.lampBrokenVisual) return;
    if (typeof mesh.add !== 'function') return;
    if (!this._brokenMaterial) this._brokenMaterial = new THREE.MeshLambertMaterial({ color: 0x3a3f46 });
    const debris = new THREE.Group();
    debris.name = 'lamp-broken-visual';
    for (const [x, y, z, sx, sy, sz, rz] of [
      [-0.26, 0.15, 0.02, 0.09, 0.16, 0.09, 0.5],
      [0.02, 0.12, -0.01, 0.09, 0.12, 0.09, 1.2],
      [0.28, 0.11, 0.03, 0.09, 0.10, 0.09, 0.8],
    ]) {
      const fragment = new THREE.Mesh(new THREE.CylinderGeometry(0.5, 0.5, 1, 8), this._brokenMaterial);
      fragment.scale.set(sx, sy, sz);
      fragment.position.set(x, y, z);
      fragment.rotation.z = rz;
      debris.add(fragment);
    }
    mesh.add(debris);
    if (mesh.userData) mesh.userData.lampBrokenVisual = debris;
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
   * 灯是家具视觉对象，不改写体素；状态写回 placement，并在原模型内
   * 关闭发光部件、追加稳定的暗色碎管视觉。
   */
  damage(lamp, amount) {
    if (lamp.broken) return false;
    lamp.hp -= amount;
    if (lamp.placement) lamp.placement.hp = Math.max(0, lamp.hp);
    if (lamp.hp > 0) return false;
    lamp.broken = true;
    lamp.level = 0;
    if (lamp.placement) {
      lamp.placement.broken = true;
      lamp.placement.id = 'lampBroken';
      lamp.placement.lampState = 'broken';
      lamp.placement.hp = 0;
      lamp.placement.level = 0;
    }
    this._showBrokenMesh(lamp);
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
