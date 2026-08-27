import * as THREE from 'three';
import { CAMERA, PLAYER } from '../config.js';

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

    this._anchor = new THREE.Vector3();
    this._desired = new THREE.Vector3();
    this._current = new THREE.Vector3();
    this._look = new THREE.Vector3();
    this._dir = new THREE.Vector3();
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
   */
  update(dt, { x, z, feetY, height, leanAmt }) {
    const off = this.aiming ? CAMERA.adsOffset : CAMERA.offset;
    const lerp = this.aiming ? CAMERA.adsFollowLerp : CAMERA.followLerp;
    const fovTarget = this.aiming ? CAMERA.adsFov : CAMERA.fov;

    this.leanAmt += (leanAmt - this.leanAmt) * Math.min(1, dt * 1000 / PLAYER.lean.timeMs);

    // 锚点：角色眼高（随蹲伏下沉）
    const eye = feetY + height * (PLAYER.eyeHeight / PLAYER.height);
    this._anchor.set(x, eye, z);

    // 倾斜时锚点侧移，让视野真的探出墙角
    const cy = Math.cos(this.yaw), sy = Math.sin(this.yaw);
    const leanShift = this.leanAmt * PLAYER.lean.offset;
    this._anchor.x += cy * leanShift;
    this._anchor.z -= sy * leanShift;

    // 目标相机位（局部 → 世界）
    const lx = off.x, ly = off.y - PLAYER.eyeHeight, lz = off.z;
    const cp = Math.cos(this.pitch), sp = Math.sin(this.pitch);
    // 先按 pitch 旋转（绕右轴），再按 yaw 旋转（绕 Y）
    const py = ly * cp + lz * sp;
    const pz = lz * cp - ly * sp;
    this._desired.set(
      this._anchor.x + cy * lx + (-sy) * pz,
      this._anchor.y + py,
      this._anchor.z + (-sy) * lx + (-cy) * pz
    );

    // 穿墙回拉：锚点 → 目标位射线
    this._dir.copy(this._desired).sub(this._anchor);
    const dist = this._dir.length();
    if (dist > 1e-4) {
      this._dir.divideScalar(dist);
      const hit = this.world.raycast(
        this._anchor.x, this._anchor.y, this._anchor.z,
        this._dir.x, this._dir.y, this._dir.z, dist
      );
      if (hit) {
        const d = Math.max(0.15, hit.dist - CAMERA.pullbackPad);
        this._desired.copy(this._anchor).addScaledVector(this._dir, d);
      }
    }

    if (!this._initialised) { this._current.copy(this._desired); this._initialised = true; }
    this._current.lerp(this._desired, Math.min(1, lerp * dt * 60));

    this.cam.position.copy(this._current);

    // 注视点：锚点前方，保证准星与角色朝向一致
    this._look.set(
      this._anchor.x - sy * cp * 8,
      this._anchor.y + sp * 8,
      this._anchor.z - cy * cp * 8
    );
    this.cam.lookAt(this._look);

    // 倾斜带来的相机滚转
    this._roll += (-this.leanAmt * 0.22 - this._roll) * Math.min(1, dt * 8);
    this.cam.rotateZ(this._roll);

    // 震屏：位置 + 旋转噪声
    if (this.shake > 0.001) {
      const s = this.shake * this.shake;
      this.cam.position.x += (Math.random() - 0.5) * 0.09 * s;
      this.cam.position.y += (Math.random() - 0.5) * 0.09 * s;
      this.cam.rotateZ((Math.random() - 0.5) * 0.04 * s);
      this.shake = Math.max(0, this.shake - dt * 3.2);
    }

    if (Math.abs(this.cam.fov - fovTarget) > 0.05) {
      this.cam.fov += (fovTarget - this.cam.fov) * Math.min(1, dt * 9);
      this.cam.updateProjectionMatrix();
    }
  }

  resize(w, h) {
    this.cam.aspect = w / h;
    this.cam.updateProjectionMatrix();
  }
}
