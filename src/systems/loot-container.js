import * as THREE from 'three';
import { generateLoot } from '../data/loot-tables.js';
import { normalizeItemInstance } from './raid-inventory.js';

/**
 * 掠夺容器（战利品箱）· 箱子交互系统。
 *
 * 与家具里的装饰箱（voxel 方块）区分开：这些是**可交互的战利品箱**，
 * 由关卡注册表的坐标驱动（DECISIONS 2026-08-29「关卡内加入可开启的
 * 掠夺容器，按房间风险分稀有度」），不是体素网格的一部分 ——
 * 所以不参与碰撞/阴影/子弹，视觉上就是一件地板上的货物箱。
 *
 * 交互流程：
 *   1. 玩家靠近（CONTAINER_INTERACT_RANGE 内）→ HUD 提示「E 打开箱子」；
 *   2. 按 E → open() 生成一箱战利品（升档概率固定 0.15，见 loot-tables.js），
 *      视觉切换为「已开箱」（箱盖掀开 + 边条熄灭）；
 *   3. 物品按携带栏容量逐件转移，装不下的留在箱子里；
 *      已开箱但还有存货的箱子可以再按 E 搜刮。
 *
 * 视觉：一个体素风货物箱（箱体 + 掀盖 + 一条无光照的亮边条）。
 * 亮边条用 MeshBasicMaterial —— 它是唯一「关灯也能看到」的货箱信号，
 * 与拾取物的浮光同理；开箱后边条熄灭，一眼区分「这箱还开着没拿空」。
 */

/** 交互距离（vox）。和门（2.2）一致：近到能对持枪姿势说话，但不用贴脸。 */
export const CONTAINER_INTERACT_RANGE = 2.2;

/** 稀有度 → 外观与文案。颜色遵循现有 HUD 语义：青=军用、琥珀=高价值。 */
const TIER_STYLE = {
  low: {
    label: '普通物资',
    body: 0x4a3a2c,       // 木色（家具 wood 同源，读作「杂物」）
    strap: 0x8b93a3,      // 灰
  },
  med: {
    label: '军用物资',
    body: 0x44505c,       // 钢灰蓝（接近 PALETTE.armor）
    strap: 0x4cc9f0,      // 青
  },
  high: {
    label: '稀有物资',
    body: 0x54362a,       // 深红棕色，区别于普通木箱
    strap: 0xf5a623,      // 琥珀
  },
};

/** 开箱后变暗的箱体色；「还能再搜刮」靠 strap 亮不亮表达 */
const OPEN_BODY = 0x2e2620;

let containerSeq = 0;

export class LootContainer {
  /**
   * @param {THREE.Scene} scene
   * @param {{x:number,y:number,z:number}} pos - y 是地面顶面高度
   * @param {string} tier - 'low' | 'med' | 'high'
   * @param {object} [lootOptions] - 传给 generateLoot 的默认选项（蓝图通道：
   *   excludeBlueprints 数组或函数 / blueprintPool / blueprintChance）。
   *   容器层不依赖存档单例 —— 排除集由 main.js 在此注入，交给 loot-tables
   *   在 open 时求值（函数形式可跟随档案/本局实时变化）。
   */
  constructor(scene, pos, tier, lootOptions = {}) {
    this.scene = scene;
    this.tier = TIER_STYLE[tier] ? tier : 'low';
    this.style = TIER_STYLE[this.tier];
    this.lootOptions = { ...lootOptions };   // open 时与调用方 options 合并透传
    this.pos = new THREE.Vector3(pos.x, pos.y, pos.z);
    /**
     * 稳定容器 id（批 4）：openContainer 会话与面板按它识别同一个箱子。
     * 只在一局内存活，不需要跨局面板序列化稳定性。
     */
    this.id = `lc_${(++containerSeq).toString(36)}_${(Date.now() % 0xffff).toString(36)}`;
    this.opened = false;
    /**
     * 箱内存货。open() 后生成统一 ItemInstance；takeOne() 返回完整实例（包括
     * quantity），不会因为兼容旧 loot 数组而截断数量。外部仍可读写这个数组，
     * 以保持现有 open/takeOne/hasLoot/main.js 契约。
     */
    this.loot = [];
    this._phase = Math.random() * Math.PI * 2;

    this.group = new THREE.Group();
    this.group.position.copy(this.pos);

    const bodyMat = new THREE.MeshLambertMaterial({ color: this.style.body });
    const body = new THREE.Mesh(new THREE.BoxGeometry(0.9, 0.4, 0.58), bodyMat);
    body.position.y = 0.2;
    this.group.add(body);

    // 亮边条：无光照材质，黑暗里是「这箱有货」的唯一可见信号
    this.strap = new THREE.Mesh(
      new THREE.BoxGeometry(0.94, 0.05, 0.62),
      new THREE.MeshBasicMaterial({ color: this.style.strap, transparent: true })
    );
    this.strap.position.y = 0.45;
    this.group.add(this.strap);

    // 箱盖：开箱后绕后缘掀开（旋转轴在背部），视觉状态一眼可读
    this.lidPivot = new THREE.Group();
    this.lidPivot.position.set(0, 0.5, -0.29);
    const lidMat = new THREE.MeshLambertMaterial({ color: this.style.body });
    const lid = new THREE.Mesh(new THREE.BoxGeometry(0.98, 0.12, 0.66), lidMat);
    lid.position.set(0, 0.06, 0.29);
    this.lidPivot.add(lid);
    this.group.add(this.lidPivot);
    this._lidTarget = 0;
    this._lidAmt = 0;
    this._bodyMat = bodyMat;

    scene.add(this.group);
  }

  /** 箱子是否还有东西可拿（未开箱 = 有货） */
  get hasLoot() { return !this.opened || this.loot.length > 0; }

  /** 从玩家脚下到箱子的水平距离（交互距离判定用 y 无关的 2D 距离） */
  distance2D(x, z) { return Math.hypot(this.pos.x - x, this.pos.z - z); }

  /**
   * 开箱：第一次生成战利品；重复调用只返回当前存货，不重新生成。
   * @param {object} options - 传给 generateLoot（rng / 蓝图通道覆盖）。
   *   构造函数存入的 lootOptions（excludeBlueprints 等）与调用方选项合并，
   *   调用方（测试 rng / 覆盖概率）优先。
   * @returns {Array} 战利品列表（引用就是 this.loot）
   */
  open(options = {}) {
    if (!this.opened) {
      this.opened = true;
      this.loot = generateLoot(this.tier, { ...this.lootOptions, ...options })
        .map((item) => normalizeItemInstance(item))
        .filter(Boolean);
      this._lidTarget = -1.9;         // 亮边条熄灭 + 盖掀开（负角 = 向背后倒）
      this._bodyMat.color.setHex(OPEN_BODY);
      this.strap.material.opacity = 0.12;
    }
    return this.loot;
  }

  /** 取走一件存货；空箱返回 null */
  takeOne() {
    if (!this.loot.length) return null;
    const item = this.loot.shift();
    return normalizeItemInstance(item) ?? item;
  }

  /** 每帧动画：盖子的掀开过渡 + 未开箱时边条呼吸闪 */
  update(dt, t) {
    this._lidAmt += (this._lidTarget - this._lidAmt) * Math.min(1, dt * 6);
    this.lidPivot.rotation.x = this._lidAmt;
    if (!this.opened) {
      this.strap.material.opacity = 0.55 + Math.sin(t * 2.4 + this._phase) * 0.3;
    }
  }
}

export class LootContainerManager {
  constructor(scene) {
    this.scene = scene;
    this.containers = [];
  }

  /**
   * @param {{x,y,z}} pos @param {string} tier
   * @param {object} [lootOptions] - 蓝图掉落通道选项（见 LootContainer 构造）
   * @returns {LootContainer}
   */
  add(pos, tier, lootOptions) {
    const c = new LootContainer(this.scene, pos, tier, lootOptions);
    this.containers.push(c);
    return c;
  }

  /**
   * 交互检测：返回范围内「最近且有货」的箱子（已开空的不占提示位）。
   * @param {number} x @param {number} y @param {number} z 玩家位置
   * @returns {LootContainer|null}
   */
  nearest(x, y, z, range = CONTAINER_INTERACT_RANGE) {
    let best = null;
    let bestD = range;
    for (const c of this.containers) {
      if (!c.hasLoot) continue;
      const d = c.distance2D(x, z);
      if (d <= bestD) { bestD = d; best = c; }
    }
    return best;
  }

  update(dt, t) {
    for (const c of this.containers) c.update(dt, t);
  }
}
