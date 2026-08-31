import * as THREE from 'three';
import { CAMERA, PLAYER } from '../config.js';

/** 相机回拉的采样点（中心 + 四角），单位为 probeRadius 的倍数 */
const CAMERA_PROBES = [
  [0, 0], [-1, -1], [1, -1], [-1, 1], [1, 1],
];

/**
 * 第三人称越肩相机。
 *  - 相机绕「肩部锚点」布置：右 0.7 / 上 1.8 / 后 3.2 vox
 *  - 右键瞄准拉近贴肩，FOV 70° → 55°
 *  - 穿墙处理：从锚点向目标相机位做体素射线，遇方块则回拉
 *  - 侧身倾斜：相机与角色一同倾斜侧移（视野换暴露）
 */
export class OrbitFollowCamera {
  constructor(world) {
    this.world = world;
    this.cam = new THREE.PerspectiveCamera(
      CAMERA.fov, 1, CAMERA.near, CAMERA.far
    );
    this.yaw = 0;
    this.pitch = -0.1;
    this.aiming = false;
    this.leanAmt = 0;
    this.shake = 0;
    this.firstPerson = false;     // V 键切换；第一人称复用同一套射击逻辑
    this.shoulder = 1;            // 1 = 右肩，-1 = 左肩

    this._anchor = new THREE.Vector3();
    this._desired = new THREE.Vector3();
    this._current = new THREE.Vector3();
    this._look = new THREE.Vector3();
    this._dir = new THREE.Vector3();
    this._view = new THREE.Vector3(0, 0, -1);   // 当前视线单位向量
    this._probeRight = new THREE.Vector3();
    this._probeUp = new THREE.Vector3();
    this._initialised = false;
    this._roll = 0;
  }

  addMouse(dx, dy) {
    this.yaw   -= dx * CAMERA.mouseSensitivity;
    this.pitch -= dy * CAMERA.mouseSensitivity;
    this.pitch = THREE.MathUtils.clamp(this.pitch, CAMERA.pitchMin, CAMERA.pitchMax);
  }

  /** 相机水平朝向的前 / 右向量，供 WASD 相对相机移动 */
  basis(outFwd, outRight) {
    outFwd.set(-Math.sin(this.yaw), 0, -Math.cos(this.yaw));
    outRight.set(Math.cos(this.yaw), 0, -Math.sin(this.yaw));
  }

  kick(amount) { this.shake = Math.min(1, this.shake + amount); }

  /**
   * @param feetY  角色脚底 y
   * @param height 当前碰撞高度（蹲伏时变小）
   * @param adsTime ADS 瞄准过渡时间（秒），来自武器配件修正
   */
  update(dt, { x, z, feetY, height, leanAmt, adsTime = 0.25 }) {
    const off = this.aiming ? CAMERA.adsOffset : CAMERA.offset;
    const lerp = this.aiming ? CAMERA.adsFollowLerp : CAMERA.followLerp;
    const fovTarget = this.aiming ? CAMERA.adsFov : CAMERA.fov;
    
    // ADS FOV 过渡速率：根据武器的 adsTime 动态调整
    // 默认 0.25s 完成过渡，速率 = 1 / adsTime * k（k=2.25 校准到原来的 dt*9）
    const adsFovRate = 1 / adsTime * 2.25;

    this.leanAmt += (leanAmt - this.leanAmt) * Math.min(1, dt * 1000 / PLAYER.lean.timeMs);

    // 锚点：角色眼高（随蹲伏下沉）
    const eye = feetY + height * (PLAYER.eyeHeight / PLAYER.height);
    this._anchor.set(x, eye, z);

    // 倾斜时锚点侧移，让视野真的探出墙角
    const cy = Math.cos(this.yaw), sy = Math.sin(this.yaw);
    const leanShift = this.leanAmt * PLAYER.lean.offset;
    this._anchor.x += cy * leanShift;
    this._anchor.z -= sy * leanShift;

    // 视线方向（yaw + pitch）。这是准星真正指向的方向。
    const cp = Math.cos(this.pitch), sp = Math.sin(this.pitch);
    this._view.set(-sy * cp, sp, -cy * cp);

    // ── 第一人称：相机直接放在眼睛位置，不做环绕与回拉 ──
    // 复用同一套 yaw/pitch 与 _view，所以射击逻辑完全不需要分支。
    if (this.firstPerson) {
      this._desired.copy(this._anchor).addScaledVector(this._view, CAMERA.fpForward);
      if (!this._initialised) { this._current.copy(this._desired); this._initialised = true; }
      // 第一人称不做位置平滑，否则快速转身会有拖影感
      this._current.copy(this._desired);
      this.cam.position.copy(this._current);
      this._look.copy(this._current).addScaledVector(this._view, 12);
      this.cam.lookAt(this._look);

      this._roll += (-this.leanAmt * 0.16 - this._roll) * Math.min(1, dt * 8);
      this.cam.rotateZ(this._roll);
      this.applyShake(dt);

      const fpFov = this.aiming ? CAMERA.fpAdsFov : CAMERA.fpFov;
      const fpAdsRate = 1 / adsTime * 3.0;  // 第一人称用稍快的速率
      if (Math.abs(this.cam.fov - fpFov) > 0.05) {
        this.cam.fov += (fpFov - this.cam.fov) * Math.min(1, dt * fpAdsRate);
        this.cam.updateProjectionMatrix();
      }
      return;
    }

    // 目标相机位 = 锚点 - 视线 × 后退距离 + 右 × 横向偏移 + 世界上 × 抬高
    //
    // 之前这里手写了一个绕右轴的旋转，符号是反的：抬头时相机往上跑、
    // 低头时相机沉到地板以下，角色看起来就像趴在地上。
    // 改成标准环绕公式后，低头相机升高俯视、抬头相机降低仰视，行为正确。
    const lx = off.x * this.shoulder, ly = off.y - PLAYER.eyeHeight, lz = off.z;
    this._desired.set(
      this._anchor.x - this._view.x * lz + cy * lx,
      this._anchor.y - this._view.y * lz + ly,
      this._anchor.z - this._view.z * lz + (-sy) * lx
    );

    // 穿墙回拉：锚点 → 目标位。
    // 只查中心一条射线不够——相机近平面有体积，贴墙时四角会切进方块里
    // （看到墙的背面）。这里对中心 + 四个角偏移各做一次射线，取最近命中。
    this._dir.copy(this._desired).sub(this._anchor);
    const dist = this._dir.length();
    if (dist > 1e-4) {
      this._dir.divideScalar(dist);

      // 构造与视线垂直的右/上向量，用来撒开采样点
      this._probeRight.set(-this._dir.z, 0, this._dir.x);
      if (this._probeRight.lengthSq() < 1e-6) this._probeRight.set(1, 0, 0);
      else this._probeRight.normalize();
      this._probeUp.crossVectors(this._probeRight, this._dir).normalize();

      const pad = CAMERA.probeRadius;
      let nearest = dist;
      for (const [ox, oy] of CAMERA_PROBES) {
        const sx = this._anchor.x + (this._probeRight.x * ox + this._probeUp.x * oy) * pad;
        const sy = this._anchor.y + (this._probeRight.y * ox + this._probeUp.y * oy) * pad;
        const sz = this._anchor.z + (this._probeRight.z * ox + this._probeUp.z * oy) * pad;
        const hit = this.world.raycast(
          sx, sy, sz, this._dir.x, this._dir.y, this._dir.z, dist
        );
        if (hit && hit.dist < nearest) nearest = hit.dist;
      }

      if (nearest < dist) {
        const d = Math.max(0.2, nearest - CAMERA.pullbackPad);
        this._desired.copy(this._anchor).addScaledVector(this._dir, d);
      }
    }

    if (!this._initialised) { this._current.copy(this._desired); this._initialised = true; }
    this._current.lerp(this._desired, Math.min(1, lerp * dt * 60));

    this.cam.position.copy(this._current);

    // 注视点 = 相机位置沿视线方向前方一点。
    // 关键：注视点必须相对「相机」而不是「锚点」计算，否则相机被墙回拉后
    // 视线会歪掉，准星指向和实际弹道就对不上（开镜时尤其明显）。
    this._look.copy(this._current).addScaledVector(this._view, 12);
    this.cam.lookAt(this._look);

    // 倾斜带来的相机滚转
    this._roll += (-this.leanAmt * 0.22 - this._roll) * Math.min(1, dt * 8);
    this.cam.rotateZ(this._roll);

    this.applyShake(dt);

    if (Math.abs(this.cam.fov - fovTarget) > 0.05) {
      this.cam.fov += (fovTarget - this.cam.fov) * Math.min(1, dt * adsFovRate);
      this.cam.updateProjectionMatrix();
    }
  }

  /** 震屏：位置 + 旋转噪声，叠加在已算好的相机变换上 */
  applyShake(dt) {
    if (this.shake <= 0.001) return;
    const s = this.shake * this.shake;
    this.cam.position.x += (Math.random() - 0.5) * 0.09 * s;
    this.cam.position.y += (Math.random() - 0.5) * 0.09 * s;
    this.cam.rotateZ((Math.random() - 0.5) * 0.04 * s);
    this.shake = Math.max(0, this.shake - dt * 3.2);
  }

  /**
   * 第三人称时在左右肩间切换；第一人称没有横向肩位，保持不变。
   * @returns {number} 切换后的肩位符号（右 1 / 左 -1）
   */
  toggleShoulder() {
    if (!this.firstPerson) this.shoulder *= -1;
    return this.shoulder;
  }

  /** 切换第一/第三人称，返回切换后是否为第一人称 */
  toggleView() {
    this.firstPerson = !this.firstPerson;
    this._initialised = false;      // 强制相机瞬移到新位置，不要插值穿墙
    return this.firstPerson;
  }

  resize(w, h) {
    this.cam.aspect = w / h;
    this.cam.updateProjectionMatrix();
  }
}
