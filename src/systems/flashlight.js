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
    this.nearGlow = new THREE.PointLight(0x8fa4c0, 0.5, F.nearGlow, 1.6);
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
 * 瞬时光源池（枪口焰 / 爆炸）。
 * 预创建固定数量的 PointLight 并复用，避免运行时新增光源导致 shader 重编译。
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
  }

  pop(x, y, z, {
    intensity = LIGHT.muzzle.intensity,
    lifeMs = LIGHT.muzzle.lifeMs,
    distance = LIGHT.muzzle.distance,
    color = 0xffffff,
  } = {}) {
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
