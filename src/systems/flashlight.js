import * as THREE from 'three';
import { LIGHT, RENDER } from '../config.js';

/**
 * 手电系统 —— 全场唯一带阴影贴图的光源（性能预算的核心决策）。
 *
 * 三件事：
 *  1. 锥光 + 阴影：GPU 阴影贴图直接给出正确的三维遮挡，这是 3D 版最大的技术红利。
 *  2. 光斑位置：锥光中心射线的命中点。敌人察觉的是这个光斑，不是玩家本人
 *     （GDD 12 章「光斑先于你抵达」）。
 *  3. 开关状态：对外暴露 detectionMultiplier，供敌人感知系统查询。
 */
export class Flashlight {
  constructor(scene, world) {
    this.world = world;
    this.on = true;

    const F = LIGHT.flashlight;
    this.light = new THREE.SpotLight(
      F.color, F.intensity, F.distance,
      F.angleDeg * Math.PI / 180, F.penumbra, F.decay
    );
    this.light.castShadow = true;
    this.light.shadow.mapSize.set(RENDER.shadowMapSize, RENDER.shadowMapSize);
    this.light.shadow.camera.near = 0.2;
    this.light.shadow.camera.far = F.distance;
    this.light.shadow.bias = -0.0012;
    this.light.shadow.normalBias = 0.035;

    // SpotLight 需要一个 target 对象来定朝向
    this.target = new THREE.Object3D();
    scene.add(this.light);
    scene.add(this.target);
    this.light.target = this.target;

    // 关灯时的贴身微光（保证「贴脸公平保护」，GDD 09 章规则 4）
    this.nearGlow = new THREE.PointLight(
      0x8fa4c0, F.nearGlowIntensity ?? 8, F.nearGlow, 1.4
    );
    scene.add(this.nearGlow);

    this.spotPoint = new THREE.Vector3();   // 光斑世界坐标
    this.spotValid = false;                 // 光斑是否落在实体上
    this._pos = new THREE.Vector3();
    this._dir = new THREE.Vector3();
  }

  toggle() {
    this.on = !this.on;
    this.light.visible = this.on;
    return this.on;
  }

  /** 敌人视觉探测距离倍率：开灯 ×1.8 / 关灯 ×0.45 */
  get detectionMultiplier() {
    return this.on ? LIGHT.flashlight.onDetectMul : LIGHT.flashlight.offDetectMul;
  }

  /**
   * @param origin 枪口世界坐标
   * @param dir    单位朝向
   */
  update(origin, dir) {
    this._pos.copy(origin);
    this._dir.copy(dir).normalize();

    this.light.position.copy(this._pos);
    this.target.position.copy(this._pos).addScaledVector(this._dir, 8);
    this.nearGlow.position.copy(this._pos);
    this.nearGlow.visible = !this.on;

    // 光斑：锥光中心射线的命中点
    if (this.on) {
      const hit = this.world.raycast(
        this._pos.x, this._pos.y, this._pos.z,
        this._dir.x, this._dir.y, this._dir.z,
        LIGHT.flashlight.distance
      );
      if (hit) {
        this.spotPoint.set(hit.point[0], hit.point[1], hit.point[2]);
        this.spotValid = true;
      } else {
        this.spotValid = false;
      }
    } else {
      this.spotValid = false;
    }
  }

  /**
   * 敌人是否会察觉到手电光斑。
   * 供敌人 AI 每帧查询；玩家本人不需要在敌人视野内。
   */
  spotNoticedBy(ex, ey, ez) {
    if (!this.spotValid) return false;
    const d = Math.hypot(
      this.spotPoint.x - ex, this.spotPoint.y - ey, this.spotPoint.z - ez
    );
    if (d > LIGHT.flashlight.detectSpotRadius) return false;
    return !this.world.lineBlocked(
      ex, ey + 0.8, ez, this.spotPoint.x, this.spotPoint.y, this.spotPoint.z
    );
  }

  /** 某点是否被手电照亮（敌人可见性判定用） */
  illuminates(px, py, pz) {
    if (!this.on) return false;
    const dx = px - this._pos.x, dy = py - this._pos.y, dz = pz - this._pos.z;
    const d = Math.hypot(dx, dy, dz);
    if (d > LIGHT.flashlight.distance) return false;
    const cosA = (dx * this._dir.x + dy * this._dir.y + dz * this._dir.z) / (d || 1);
    const halfAngle = LIGHT.flashlight.angleDeg * Math.PI / 180;
    if (cosA < Math.cos(halfAngle)) return false;
    return !this.world.lineBlocked(this._pos.x, this._pos.y, this._pos.z, px, py, pz);
  }
}

/**
 * 敌人手电池 —— 玩家在黑暗里唯一的「有人在那边」预警信号。
 *
 * ══ 为什么是「池」而不是每个敌人一个灯 ══
 *
 * 12 个 SpotLight 会让 three.js 为每个受影响的材质重编译 shader，
 * 而且每个带阴影的锥光都要额外一遍深度渲染 —— 12 个直接把帧率打死。
 * 这里预创建 maxLit 个光源，每帧按距离分配给最近的几个活敌人：
 * 远处的敌人玩家本来也看不清光斑，省下的预算全给近处。
 *
 * ══ 每个光源都必须投阴影（这是硬约束，不是优化项）══
 *
 * 曾经为了省性能只让最近的 1 个投阴影，结果剩下 3 个光源直接照穿墙壁：
 * 隔着两道墙都能看到敌人脚下的一片亮光。SpotLight 不投阴影时对几何体
 * 毫无感知，墙对它就是不存在。所以 maxLit 只能压到「全部都投得起阴影」
 * 的数量（现在是 2），而不是「点亮很多但大部分穿墙」。
 *
 * ══ 为什么没有可见光柱 ══
 *
 * 试过用半透明锥体网格表示空气散射，但那是个普通 Mesh：它不参与遮挡，
 * 于是整根光柱直接插穿墙体，在墙外看是一大片诡异的半透明灰色多边形。
 * 真正的体积光需要屏幕空间光线步进（要读深度缓冲、按 shadow map 采样），
 * 那是一整套后处理管线，远超这个项目的预算。
 * 现在靠「光斑 + 敌人身上的灯头方块」传达同样的信息，成本是零。
 */
export class EnemyFlashlights {
  constructor(scene) {
    const E = LIGHT.enemyFlashlight;
    this.cfg = E;
    this.slots = [];

    const halfAngle = E.angleDeg * Math.PI / 180;

    for (let i = 0; i < E.maxLit; i++) {
      const light = new THREE.SpotLight(
        E.color, E.intensity, E.distance,
        halfAngle, E.penumbra, E.decay
      );
      light.visible = false;

      // 无条件投阴影：不投阴影的光源会穿墙，那比少一个光源难看得多
      light.castShadow = true;
      light.shadow.mapSize.set(E.shadowMapSize, E.shadowMapSize);
      light.shadow.camera.near = 0.3;
      light.shadow.camera.far = E.distance;
      light.shadow.bias = -0.0015;
      light.shadow.normalBias = 0.04;

      const target = new THREE.Object3D();
      light.target = target;
      scene.add(light);
      scene.add(target);

      this.slots.push({ light, target });
    }

    this._pos = new THREE.Vector3();
    this._dir = new THREE.Vector3();
  }

  /**
   * 每帧把光源分配给离玩家最近的活敌人。
   *
   * @param enemies 全部敌人
   * @param viewPos 玩家（或相机）位置，用来排优先级
   * @param now     秒，用于待机扫视
   */
  update(enemies, viewPos, now) {
    // 按到玩家的距离挑出最近的 maxLit 个开着灯的活敌人
    const live = [];
    for (const e of enemies) {
      if (e.dead || !e.flashlightOn) continue;
      const dx = e.pos.x - viewPos.x, dz = e.pos.z - viewPos.z;
      live.push({ e, d: dx * dx + dz * dz });
    }
    live.sort((a, b) => a.d - b.d);

    for (let i = 0; i < this.slots.length; i++) {
      const slot = this.slots[i];
      const entry = live[i];
      if (!entry) { slot.light.visible = false; continue; }

      const e = entry.e;
      // 灯朝敌人正面；待机时缓慢扫视（光斑扫过是玩家的预警信号）
      const sweep = e.state === 'idle'
        ? Math.sin(now * this.cfg.sweepSpeed + e.id) * (this.cfg.sweepDeg * Math.PI / 180)
        : 0;
      const yaw = e.yaw + sweep;

      // 灯头位置与 rig 上那块自发光方块对齐（光要看起来是从灯里出来的）
      this._pos.set(
        e.pos.x - Math.sin(yaw) * 0.3,
        e.pos.y + e.height * 0.78,
        e.pos.z - Math.cos(yaw) * 0.3
      );
      // 略微低头照地面，光斑才会扫过地板而不是平射进虚空
      this._dir.set(-Math.sin(yaw), -0.14, -Math.cos(yaw)).normalize();

      slot.light.position.copy(this._pos);
      slot.target.position.copy(this._pos).addScaledVector(this._dir, 8);
      slot.light.visible = true;
    }
  }
}

/**
 * 瞬时光源池（枪口焰 / 爆炸）。
 * 预创建固定数量的 PointLight 并复用，避免运行时新增光源导致 shader 重编译。
 *
 * ══ 为什么这些光不投阴影，却也不穿墙 ══
 *
 * PointLight 投阴影需要一张立方体阴影贴图（6 次深度渲染）。为一个只存在
 * 80ms 的枪口焰付这个代价完全不值，但不投阴影的光会照穿墙壁 ——
 * 敌人在隔壁房间开枪，玩家这边的墙面会跟着闪。手雷爆炸的 900 坎德拉
 * 更明显，隔两道墙都能看到一片亮光。
 *
 * 解法不是加阴影，而是「玩家看不见的闪光根本不用点亮」：
 * 每次 pop 之前做一条视线射线，被墙挡住就直接跳过这个光源。
 * 代价是一次 DDA 射线（比一次阴影渲染便宜三个数量级），
 * 而且结果在观感上和真阴影一致 —— 玩家永远不会看到穿墙的闪光。
 *
 * 视线检查由 main.js 通过 setVisibilityProbe 注入，因为光源池本身
 * 不应该知道「玩家」这个概念。
 */
export class FlashPool {
  constructor(scene, size = LIGHT.muzzle.poolSize) {
    this.items = [];
    for (let i = 0; i < size; i++) {
      const l = new THREE.PointLight(0xffffff, 0, LIGHT.muzzle.distance, 1.8);
      l.castShadow = false;
      l.visible = false;
      scene.add(l);
      this.items.push({ light: l, until: 0, peak: 0, life: 1 });
    }
    this.cursor = 0;
    /** (x,y,z) => boolean：该点是否对玩家可见。未注入时一律点亮。 */
    this.visibilityProbe = null;
  }

  /** 注入视线检查，避免玩家看不见的闪光照穿墙壁 */
  setVisibilityProbe(fn) { this.visibilityProbe = fn; }

  pop(x, y, z, {
    intensity = LIGHT.muzzle.intensity,
    lifeMs = LIGHT.muzzle.lifeMs,
    distance = LIGHT.muzzle.distance,
    color = 0xffffff,
  } = {}) {
    // 玩家看不见这个位置 → 不点灯（否则光会穿墙照亮玩家这侧的墙面）
    if (this.visibilityProbe && !this.visibilityProbe(x, y, z)) return;

    const it = this.items[this.cursor];
    this.cursor = (this.cursor + 1) % this.items.length;
    it.light.position.set(x, y, z);
    it.light.color.setHex(color);
    it.light.distance = distance;
    it.light.intensity = intensity;
    it.light.visible = true;
    it.peak = intensity;
    it.life = lifeMs / 1000;
    it.until = it.life;
  }

  update(dt) {
    for (const it of this.items) {
      if (!it.light.visible) continue;
      it.until -= dt;
      if (it.until <= 0) {
        it.light.visible = false;
        it.light.intensity = 0;
      } else {
        it.light.intensity = it.peak * (it.until / it.life);
      }
    }
  }
}
