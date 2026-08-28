import * as THREE from 'three';
import { PALETTE } from '../config.js';
import { BLOCK } from '../voxel/blocks.js';

/**
 * 门：一格门洞里的**双开门** —— 两片 0.5 格宽 × 2 格高 × 0.14 厚的琥珀色
 * 扁方块，铰链分别在门洞的两条侧边，开门时从中间向两侧各转 90°。
 * 没有铰链模型、没有把手、没有蒙皮（GDD 11 章）。
 *
 * 关闭时挡光挡视线挡子弹（往体素网格里写 BLOCK.DOOR），开启时移除。
 * 门的遮挡关系和墙完全一致，AI 视线判定与阴影贴图都自动正确。
 *
 * ══ 关着的门必须看起来像门 ══
 *
 * 以前关门是往格子里写 BLOCK.WALL —— 那是个整格实心立方体，正好把薄门板
 * 完全包在里面，玩家看到的是一堵灰墙，既看不出是门、也不知道能按 E。
 * 现在写的是 BLOCK.DOOR（solid + opaque 但 render:false），
 * 挡住的职责归体素，外观的职责归门板网格，互不遮蔽。
 *
 * ══ 双开门的几何（改数值前先看这里）══
 *
 * three.js 绕 +y 旋转 θ：x' = x·cosθ + z·sinθ，z' = −x·sinθ + z·cosθ
 *
 * 门洞格是 (gx, gz)，占 1×1。双开门把这一格从中线劈成两半：
 *
 * · through='z'（门洞沿 z 贯穿，墙沿 x 延伸）→ 门板沿 x 展开、z 方向薄
 *     左扇：铰链在 x=gx 边，局部中心 (+0.25, 0)，θ 从 0 → −90°
 *     右扇：铰链在 x=gx+1 边，局部中心 (−0.25, 0)，θ 从 0 → +90°
 *     两扇各自旋到与墙面垂直（贴在门洞两侧的墙垛上），通道完全净空。
 *
 * · through='x'（门洞沿 x 贯穿，墙沿 z 延伸）→ 门板沿 z 展开、x 方向薄
 *     左扇：铰链在 z=gz 边，局部中心 (0, +0.25)，θ 从 0 → +90°
 *     右扇：铰链在 z=gz+1 边，局部中心 (0, −0.25)，θ 从 0 → −90°
 *
 * 双开门的关键好处：门板旋出后落在**门洞自身的两侧**（也就是墙厚方向的
 * 侧壁上），不再需要「铰链侧那一格必须是房间净空」这个前提 ——
 * 单开门时代那条约束正是「门打不开 / 门堵住通道」的来源。
 */

const DOOR_THICK = 0.14;
const OPEN_ANGLE = Math.PI / 2;
const OPEN_TIME = 0.35;          // 推门耗时
const DOOR_H = 2;
/** 每扇门板的宽度：一格门洞对半分 */
const LEAF_W = 0.5;
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
      ? new THREE.BoxGeometry(LEAF_W, DOOR_H, DOOR_THICK)
      : new THREE.BoxGeometry(DOOR_THICK, DOOR_H, LEAF_W);

    // 双面可见：开到一半时从背面看不能变成空洞
    const mat = new THREE.MeshLambertMaterial({
      color: PALETTE.amber, side: THREE.DoubleSide,
    });

    /**
     * 双开门：两个铰链组，分别钉在门洞的两条侧边，向相反方向旋转。
     * leaves[i] = { pivot, mesh, sign }，sign 决定该扇的旋转方向。
     */
    this.leaves = [];
    const mkLeaf = (pivotX, pivotZ, localX, localZ, sign) => {
      const pivot = new THREE.Group();
      pivot.position.set(pivotX, this.gy, pivotZ);
      const mesh = new THREE.Mesh(geo, mat);
      mesh.castShadow = true;
      mesh.receiveShadow = true;
      mesh.position.set(localX, DOOR_H / 2, localZ);
      pivot.add(mesh);
      scene.add(pivot);
      this.leaves.push({ pivot, mesh, sign });
    };

    if (widthOnX) {
      // 门板沿 x 展开、z 薄：铰链在 x=gx 与 x=gx+1 两条竖边
      mkLeaf(this.gx,     this.gz, LEAF_W / 2,  FACE_INSET, -1);
      mkLeaf(this.gx + 1, this.gz, -LEAF_W / 2, FACE_INSET,  1);
    } else {
      // 门板沿 z 展开、x 薄：铰链在 z=gz 与 z=gz+1 两条竖边
      mkLeaf(this.gx, this.gz,     FACE_INSET,  LEAF_W / 2,  1);
      mkLeaf(this.gx, this.gz + 1, FACE_INSET, -LEAF_W / 2, -1);
    }

    // 关门状态：往网格里写 BLOCK.DOOR，挡住一切但不画整格立方体
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
      this.world.set(this.gx, y, this.gz, blocking ? BLOCK.DOOR : BLOCK.AIR);
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

  /** 把两扇门板转到当前 anim 对应的角度 */
  applyRotation() {
    for (const leaf of this.leaves) {
      leaf.pivot.rotation.y = this.anim * OPEN_ANGLE * leaf.sign;
    }
  }

  /** 跳过动画直接到位，供初始化使用 */
  snap() {
    this.anim = this.open ? 1 : 0;
    this.applyRotation();
  }

  /**
   * 门板完全敞开后所占的格坐标。
   *
   * 双开门的两扇都落在门洞自身的侧壁上（墙厚方向），不侵入任何房间格，
   * 所以这里返回门洞格本身 —— 保留这个方法是为了兼容既有测试与调用方。
   */
  swingCell() {
    return { x: this.gx, z: this.gz };
  }

  update(dt) {
    const target = this.open ? 1 : 0;
    if (this.anim === target) return;
    const step = dt / OPEN_TIME;
    this.anim += Math.sign(target - this.anim) * step;
    this.anim = Math.max(0, Math.min(1, this.anim));
    this.applyRotation();
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
