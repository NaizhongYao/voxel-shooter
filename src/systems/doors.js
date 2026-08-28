import * as THREE from 'three';
import { PALETTE } from '../config.js';
import { BLOCK } from '../voxel/blocks.js';

/**
 * 门：1 格宽 × 2 格高 × 0.14 厚的琥珀色扁方块，绕一条竖边旋转 90°。
 * 没有铰链模型、没有把手、没有蒙皮（GDD 11 章）。
 *
 * 关闭时挡光挡视线挡子弹（往体素网格里写实心方块），开启时移除。
 * 门的遮挡关系和墙完全一致，AI 视线判定与阴影贴图都自动正确。
 *
 * ══ 之前「门把玩家堵在门口」的两个根因，都在这里修掉 ══
 *
 * 1. 门板尺寸的朝向判断反了。
 *    旧代码看「左右两侧是否是墙」(solidX)，是则把门板做成 x 薄 z 宽。
 *    但左右是墙 ⇒ 墙沿 x 延伸 ⇒ 门洞沿 z 贯穿 ⇒ 门板必须是 x 宽 z 薄。
 *    做反的门板正好横插在通道里，转到 90° 依旧糊在门洞中间。
 *    现在直接用关卡 carveDoor 时记录的 `through`（门洞贯穿方向），不再猜。
 *
 * 2. 门板绕格子中心转，开门后仍在通道内。
 *    现在铰链放在门洞格的一条竖边上，开门时门板整体旋出通道、
 *    立到房间一侧 —— 门洞恢复完整净空，这也是真实的门的行为。
 *
 * ══ 铰链几何（推导，别改数值前先看这里）══
 *
 * three.js 绕 +y 旋转 θ：x' = x·cosθ + z·sinθ，z' = −x·sinθ + z·cosθ
 *
 * · through='z'（门洞沿 z 贯穿，墙沿 x 延伸，房间在 z−1 侧）
 *     铰链 = 格子的 (x=gx, z=gz) 竖边；门板局部偏移 (+0.5, 0)，沿 x 展开。
 *     θ=+90° → 局部 (0.5,0) 映射到 (0, −0.5)：门板转到 z−1 侧，沿 z 展开。
 *     ⇒ openSign = +1
 *
 * · through='x'（门洞沿 x 贯穿，墙沿 z 延伸，房间在 x−1 侧）
 *     铰链 = 格子的 (x=gx, z=gz) 竖边；门板局部偏移 (0, +0.5)，沿 z 展开。
 *     θ=−90° → 局部 (0,0.5) 映射到 (−0.5, 0)：门板转到 x−1 侧，沿 x 展开。
 *     ⇒ openSign = −1
 *
 * 两种情况的共同前提：门板旋出的那一格必须是房间净空。
 * 关卡的 carveDoor 调用全部遵守这条，由 logic.test.mjs 的
 * 「门完全敞开后门洞净空」用例守着。
 */

const DOOR_THICK = 0.14;
const OPEN_ANGLE = Math.PI / 2;
const OPEN_TIME = 0.35;          // 推门耗时
const DOOR_H = 2;
/** 门板沿自身薄轴的微小内缩，避免与墙面共面导致 z-fighting */
const FACE_INSET = DOOR_THICK / 2 + 0.01;

export class Door {
  constructor(scene, world, spec) {
    this.world = world;
    this.gx = spec.x; this.gy = spec.y; this.gz = spec.z;
    this.open = false;
    this.anim = 0;               // 0=关 1=开

    /**
     * 门洞贯穿方向。关卡打洞时就知道方向，直接传过来比事后从网格反推可靠
     * 得多 —— 在 2 格厚的墙上反推必然出错。缺省时退回推断，兼容手写门规格。
     */
    this.through = spec.through ?? this.inferThrough();
    this.thick = spec.thick ?? 1;

    // 门洞沿 z 贯穿 ⇒ 墙沿 x 延伸 ⇒ 门板宽度在 x 轴上
    const widthOnX = this.through === 'z';
    const geo = widthOnX
      ? new THREE.BoxGeometry(1, DOOR_H, DOOR_THICK)
      : new THREE.BoxGeometry(DOOR_THICK, DOOR_H, 1);

    // 双面可见：开到一半时从背面看不能变成空洞
    const mat = new THREE.MeshLambertMaterial({
      color: PALETTE.amber, side: THREE.DoubleSide,
    });
    this.mesh = new THREE.Mesh(geo, mat);
    this.mesh.castShadow = true;
    this.mesh.receiveShadow = true;

    // 铰链固定在门洞格的 (gx, gz) 竖边上（见文件头的推导）
    this.pivot = new THREE.Group();
    this.pivot.position.set(this.gx, this.gy, this.gz);
    if (widthOnX) {
      this.mesh.position.set(0.5, DOOR_H / 2, FACE_INSET);
      this.openSign = 1;
    } else {
      this.mesh.position.set(FACE_INSET, DOOR_H / 2, 0.5);
      this.openSign = -1;
    }
    this.pivot.add(this.mesh);
    scene.add(this.pivot);

    // 关门状态：往网格里写实心方块，让它像墙一样挡住一切
    this.applyBlocking(true);
  }

  /** 没有 through 信息时，从两侧墙体反推门洞方向 */
  inferThrough() {
    const w = this.world;
    const y = this.gy + 1;
    const wallOnX = w.get(this.gx - 1, y, this.gz) !== BLOCK.AIR
                 && w.get(this.gx + 1, y, this.gz) !== BLOCK.AIR;
    // 左右都是墙 ⇒ 墙沿 x 延伸 ⇒ 门洞沿 z 贯穿
    return wallOnX ? 'z' : 'x';
  }

  /**
   * 门的遮挡直接用体素表达，视线 / 子弹 / 阴影三者自动一致。
   *
   * 只占门板所在的那一格。2 格厚的墙上，门洞的另一格永远保持空气 ——
   * 那是给玩家站的门槛空间；堵上就等于门有 2 格厚，开门后照样过不去。
   */
  applyBlocking(blocking) {
    for (let y = this.gy; y < this.gy + DOOR_H; y++) {
      this.world.set(this.gx, y, this.gz, blocking ? BLOCK.WALL : BLOCK.AIR);
    }
    // 门框标记留在底格（开门后恢复，供 AI 寻路识别通道）
    if (!blocking) this.world.set(this.gx, this.gy, this.gz, BLOCK.DOORFRAME);
  }

  center() {
    return { x: this.gx + 0.5, y: this.gy + 1, z: this.gz + 0.5 };
  }

  distanceTo(px, py, pz) {
    const c = this.center();
    return Math.hypot(c.x - px, c.y - py, c.z - pz);
  }

  toggle() { return this.setOpen(!this.open); }

  /**
   * 门格是否被实体占据（玩家或敌人站在门洞里）。
   *
   * 关门时必须检查这个，否则玩家站在门洞里按 E 会把实心方块写在
   * 自己身上 —— 碰撞盒被完全包住，分轴推进的每个方向都受阻，
   * 玩家彻底卡死在墙里，只能重开。实测过，出不来。
   *
   * @param actors 需要避让的实体数组，每个要有 pos 与（可选）width/height
   */
  blockedByActor(actors) {
    if (!actors) return false;
    for (const a of actors) {
      if (!a || a.dead) continue;
      const p = a.pos;
      // 垂直方向：实体必须与门板的高度区间重叠
      if (p.y > this.gy + DOOR_H || p.y + (a.height ?? 1.8) < this.gy) continue;
      // 水平方向：实体的圆柱与门格（1×1）是否相交
      const r = a.radius ?? 0.3;
      const cx = Math.max(this.gx, Math.min(p.x, this.gx + 1));
      const cz = Math.max(this.gz, Math.min(p.z, this.gz + 1));
      if (Math.hypot(p.x - cx, p.z - cz) < r) return true;
    }
    return false;
  }

  /** 显式设定开关状态（关卡初始化时用来把主入口预先打开） */
  setOpen(open) {
    this.open = open;
    // 开门瞬间就解除遮挡（不等动画播完），否则会「看得见但打不过去」
    this.applyBlocking(!open);
    return this.open;
  }

  /** 跳过动画直接到位，供初始化使用 */
  snap() {
    this.anim = this.open ? 1 : 0;
    this.pivot.rotation.y = this.anim * OPEN_ANGLE * this.openSign;
  }

  /** 门板完全敞开后所占的格坐标（该格必须是房间净空） */
  swingCell() {
    return this.through === 'z'
      ? { x: this.gx, z: this.gz - 1 }
      : { x: this.gx - 1, z: this.gz };
  }

  update(dt) {
    const target = this.open ? 1 : 0;
    if (this.anim === target) return;
    const step = dt / OPEN_TIME;
    this.anim += Math.sign(target - this.anim) * step;
    this.anim = Math.max(0, Math.min(1, this.anim));
    this.pivot.rotation.y = this.anim * OPEN_ANGLE * this.openSign;
  }
}

export class DoorManager {
  constructor(scene, world, doorSpecs) {
    this.doors = doorSpecs.map((s) => new Door(scene, world, s));
  }

  /** 找出玩家附近可交互的门 */
  nearest(px, py, pz, maxDist = 2.0) {
    let best = null, bestD = maxDist;
    for (const d of this.doors) {
      const dist = d.distanceTo(px, py, pz);
      if (dist < bestD) { bestD = dist; best = d; }
    }
    return best;
  }

  /**
   * 把指定格坐标的门预先打开（不播动画）。
   *
   * 主入口必须默认敞开：玩家出生在庭院，正对一扇关着的门。虽然按 E 就能开，
   * 但「开局第一个动作是撞墙、然后翻按键表」是很差的第一印象。
   * 敞开的门同时也是「往这里走」的视觉引导。
   */
  openAt(cells) {
    let n = 0;
    for (const d of this.doors) {
      if (cells.some(([x, z]) => d.gx === x && d.gz === z)) {
        d.setOpen(true);
        d.snap();
        n++;
      }
    }
    return n;
  }

  update(dt) { for (const d of this.doors) d.update(dt); }
}
