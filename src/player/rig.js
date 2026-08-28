import * as THREE from 'three';
import { RIG, PALETTE, PLAYER } from '../config.js';

/**
 * 方块人形（6 部件 + 枪）。零骨骼、零外部模型：
 * 每个部件是一个 BoxGeometry，靠整块的位移与旋转做动画。
 *
 * 层级：root(位置+yaw) → body(蹲伏缩放/倾斜) → 各部件
 *   - head 单独跟随 pitch
 *   - arms 持枪时锁定前伸
 *   - legs 正弦摆动，频率随速度
 */

const SHARED_BOX = new THREE.BoxGeometry(1, 1, 1);

function part(size, color, name) {
  const mat = new THREE.MeshLambertMaterial({ color });
  const m = new THREE.Mesh(SHARED_BOX, mat);
  m.scale.set(size.x, size.y, size.z);
  m.castShadow = true;
  m.receiveShadow = false;
  m.name = name;
  return m;
}

export class BlockyRig {
  constructor(color = PALETTE.amber, { isPlayer = true } = {}) {
    this.root = new THREE.Group();
    this.root.name = isPlayer ? 'player-rig' : 'actor-rig';

    // body 承担蹲伏与倾斜，root 只负责世界位置与 yaw
    this.body = new THREE.Group();
    this.root.add(this.body);

    const R = RIG;
    // 站立时各部件中心高度（脚底为 0）
    this.torso = part(R.torso, color, 'torso');
    this.torso.position.y = 1.05;
    this.body.add(this.torso);

    this.headPivot = new THREE.Group();
    this.headPivot.position.y = 1.48;
    this.body.add(this.headPivot);
    this.head = part(R.head, color, 'head');
    this.head.position.y = R.head.y / 2;
    this.headPivot.add(this.head);

    this.armL = this.makeLimb(R.arm, color, 'armL', -0.42, 1.32);
    this.armR = this.makeLimb(R.arm, color, 'armR',  0.42, 1.32);
    this.legL = this.makeLimb(R.leg, color, 'legL', -0.16, 0.75);
    this.legR = this.makeLimb(R.leg, color, 'legR',  0.16, 0.75);

    // 枪挂在右臂前方，后坐时沿 Z 回弹
    this.gunPivot = new THREE.Group();
    this.gunPivot.position.set(0.34, 1.3, 0);
    this.body.add(this.gunPivot);
    this.gun = part(R.gun, 0x11151c, 'gun');
    this.gun.position.z = -R.gun.z / 2 - 0.1;
    this.gunPivot.add(this.gun);

    // 枪口锚点：枪灯与枪口焰的挂载位置
    this.muzzle = new THREE.Object3D();
    this.muzzle.position.set(0, 0, -R.gun.z - 0.12);
    this.gunPivot.add(this.muzzle);

    /**
     * 枪挂手电的灯头：一个自发光的小方块。
     *
     * 真正的照明由光源池负责，这块方块只解决「光是从哪儿发出来的」——
     * 没有它，玩家看到的就是一束凭空出现的光锥，读不出「那是个拿着灯的人」。
     * 默认隐藏，由持有者调用 setLampOn 打开。
     */
    this.lamp = new THREE.Mesh(SHARED_BOX, new THREE.MeshBasicMaterial({
      color: 0xffe2b0,
    }));
    this.lamp.scale.set(0.13, 0.13, 0.13);
    this.lamp.position.set(0, 0.1, -R.gun.z + 0.05);
    this.lamp.visible = false;
    this.gunPivot.add(this.lamp);

    this.walkPhase = 0;
    this.recoil = 0;
    this.crouchAmt = 0;
    this.leanAmt = 0;

    /**
     * 倒地动画状态。0=站立，1=完全倒地。
     *
     * 为什么需要它：原来死亡就是 setVisible(false) —— 敌人凭空消失，
     * 玩家完全读不出「我打死了他」还是「他躲到掩体后了」。
     * 倒地是最廉价的死亡反馈：一个绕脚底的 90° 旋转，零骨骼、零新资源。
     */
    this.deathAmt = 0;
    this.deathYaw = 0;      // 朝哪一侧倒（受击方向决定）
  }

  makeLimb(size, color, name, x, pivotY) {
    const pivot = new THREE.Group();
    pivot.position.set(x, pivotY, 0);
    this.body.add(pivot);
    const mesh = part(size, color, name);
    mesh.position.y = -size.y / 2;
    pivot.add(mesh);
    pivot.name = `${name}-pivot`;
    return pivot;
  }

  /**
   * @param dt        秒
   * @param speed     水平速度（vox/s）
   * @param yaw       身体朝向
   * @param pitch     视角俯仰（头部与枪跟随）
   * @param crouchAmt 0..1
   * @param leanAmt   -1..1（左负右正）
   */
  /**
   * 开始倒地。
   * @param dirX,dirZ 受击方向（子弹飞行方向），决定往哪一侧倒
   */
  startDeath(dirX = 0, dirZ = 1) {
    if (this.deathAmt > 0) return;
    // 往子弹飞去的方向倒 —— 「被打得往后仰」是最直觉的读法
    this.deathYaw = Math.atan2(dirX, dirZ);
    this.deathAmt = 1e-4;         // 非零即进入倒地流程
    this.lamp.visible = false;    // 死人的手电灭掉
  }

  /** 倒地动画推进。返回是否已经完全躺平。 */
  updateDeath(dt) {
    if (this.deathAmt <= 0) return false;
    this.deathAmt = Math.min(1, this.deathAmt + dt * DEATH_RATE);
    // easeOut：一开始快速失去平衡，接触地面时减速（不是匀速倒下的木板）
    const t = 1 - (1 - this.deathAmt) * (1 - this.deathAmt);

    // 绕脚底往受击方向倒 90°
    this.body.rotation.set(0, 0, 0);
    this.body.rotation.x = t * Math.PI / 2 * Math.cos(this.deathYaw);
    this.body.rotation.z = t * Math.PI / 2 * -Math.sin(this.deathYaw);
    // 倒下时整体略微下沉，避免躯干悬在半空
    this.body.position.set(0, -t * 0.12, 0);
    this.body.scale.set(1, 1, 1);

    // 四肢摊开（活人不会这么放松），头垂下
    const limp = t * 0.9;
    this.armL.rotation.x = -1.15 + limp * 1.5;
    this.armR.rotation.x = -1.15 + limp * 1.5;
    this.armL.rotation.z = -limp * 0.6;
    this.armR.rotation.z = limp * 0.6;
    this.legL.rotation.x = limp * 0.35;
    this.legR.rotation.x = -limp * 0.25;
    this.headPivot.rotation.x = limp * 0.7;
    this.gunPivot.rotation.x = limp * 1.2;
    return this.deathAmt >= 1;
  }

  update(dt, { speed, yaw, pitch, crouchAmt, leanAmt, aiming }) {
    // 倒地中：完全接管姿态，不再跑常规的行走/瞄准动画
    if (this.deathAmt > 0) {
      this.root.rotation.y = yaw;
      this.updateDeath(dt);
      return;
    }

    this.root.rotation.y = yaw;

    // 蹲伏：整体下沉并压缩，与碰撞高度 1.8 → 1.0 对应
    this.crouchAmt = crouchAmt;
    const sy = 1 - crouchAmt * (1 - PLAYER.crouchHeight / PLAYER.height);
    this.body.scale.set(1, sy, 1);

    // 倾斜：绕脚底轴旋转 + 侧移。命中盒不动（由 Body 保证）
    this.leanAmt = leanAmt;
    const leanRad = leanAmt * RIG_LEAN_RAD;
    this.body.rotation.z = -leanRad;
    this.body.position.x = leanAmt * PLAYER.lean.offset * 0.6;

    // 头部跟随 pitch（限幅，避免脖子扭断的观感）
    this.headPivot.rotation.x = THREE.MathUtils.clamp(pitch, -0.9, 0.7);

    // 持枪：手臂锁定前伸，枪跟随 pitch
    const armFwd = aiming ? -1.42 : -1.15;
    this.armL.rotation.x = armFwd;
    this.armR.rotation.x = armFwd;
    this.gunPivot.rotation.x = THREE.MathUtils.clamp(pitch, -1.1, 0.9);

    // 腿部正弦摆动
    const moving = speed > 0.05;
    if (moving) {
      this.walkPhase += dt * speed * RIG.walkFreq * Math.PI;
    } else {
      // 停下时回中
      this.walkPhase += dt * 6;
    }
    const amp = moving
      ? Math.min(RIG.walkSwingMax, speed / PLAYER.speed * RIG.walkSwingMax)
      : 0;
    const sw = Math.sin(this.walkPhase) * amp;
    this.legL.rotation.x =  sw;
    this.legR.rotation.x = -sw;
    // 移动时躯干轻微前倾
    this.torso.rotation.x = moving ? -0.06 - amp * 0.04 : 0;

    // 后坐回弹
    if (this.recoil > 0) {
      this.recoil = Math.max(0, this.recoil - dt * 7);
      this.gun.position.z = -RIG.gun.z / 2 - 0.1 + this.recoil * 0.22;
    }
  }

  kick(amount = 1) { this.recoil = Math.min(1, this.recoil + amount); }

  setVisible(v) { this.root.visible = v; }

  /** 枪挂手电的灯头亮 / 灭 */
  setLampOn(on) { this.lamp.visible = on; }

  /**
   * 第一人称模式：隐藏会挡住视线的部件（头、躯干、腿），
   * 保留手臂与枪 —— 这样仍能看到换弹与后坐动作。
   */
  setFirstPerson(on) {
    this.head.visible = !on;
    this.torso.visible = !on;
    this.legL.visible = !on;
    this.legR.visible = !on;
    // 手臂在第一人称里不投影，否则自己的影子会糊在准星附近
    for (const m of [this.armL, this.armR]) {
      m.traverse((o) => { if (o.isMesh) o.castShadow = !on; });
    }
    this.gun.castShadow = !on;
  }

  /** 枪口的世界坐标与朝向，供枪灯与射线使用 */
  muzzleWorld(outPos, outDir) {
    this.muzzle.getWorldPosition(outPos);
    this.muzzle.getWorldDirection(outDir);
    outDir.negate();   // three 的 -Z 为前
    return outPos;
  }
}

const RIG_LEAN_RAD = PLAYER.lean.angleDeg * Math.PI / 180;
/** 倒地耗时约 1/2.2 ≈ 0.45 秒 —— 足够看清，又不至于拖沓 */
const DEATH_RATE = 2.2;

