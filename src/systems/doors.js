import { BLOCK } from '../voxel/blocks.js';
import { buildDoorway, DOOR_SPEC } from '../level/furniture.js';

/**
 * 门：**铰链贴左右墙垛的双开门**，向室内侧开。
 * 视觉模型由 level/furniture.js 的共享 doorway builder 提供，含门框、内嵌板和把手。
 *
 * 关闭时挡光挡视线挡子弹（往体素网格里写 BLOCK.DOOR），开启时移除。
 * 门的遮挡关系和墙完全一致，AI 视线判定与阴影贴图都自动正确。
 *
 * ══ 关着的门必须看起来像门 ══
 *
 * 以前关门是往格子里写 BLOCK.WALL —— 那是个整格实心立方体，正好把薄门板
 * 完全包在里面，玩家看到的是一堵灰墙，既看不出是门、也不知道能按 E。
 * 现在写的是 BLOCK.DOOR（solid + opaque 但 render:false），
 * 挡住的职责归体素，外观的职责归细化门模型，互不遮蔽。
 *
 * ══ 相邻门格必须合并成「一个门洞」══
 *
 * 主入口这类宽门洞在关卡里是**两个相邻的门格**（如 [[31,47],[32,47]]）。
 * 如果每格各自劈成一对门板，就会有两条铰链落在整个门洞的正中间 ——
 * 关着时中缝多一条竖线，开着时两片门板直接立在通道中央挡路。
 *
 * 所以 DoorManager 先把连续的门格并成一组，每组**只有两扇**门板，
 * 铰链钉在整个门洞最外侧的两条竖边上，也就是紧贴左右墙垛。
 * 每扇宽度 = 门洞总宽 / 2（1 格洞 → 0.5，2 格洞 → 1.0）。
 *
 * ══ 旋转几何（改数值前先看这里）══
 *
 * three.js 绕 +y 旋转 θ：x' = lx·cosθ + lz·sinθ，z' = −lx·sinθ + lz·cosθ
 *
 * 铰链组的原点放在「门洞外侧竖边 × 门板中面」上，门板局部只沿展开轴偏移
 * 半个扇宽（另一轴为 0）。于是 θ=±90° 时门板正好绕竖边扫进室内、
 * 平贴在门洞侧壁上，通道完全净空。
 *
 * · through='z'（门洞沿 z 贯穿，墙沿 x 延伸）→ 门板沿 x 展开、z 方向薄
 *     室内在 z−1 侧（与关卡 carveDoor 的约定一致），两扇都朝 −z 扫。
 *     左扇铰链 x=x0（局部 +w/2）→ θ:0→+90°
 *     右扇铰链 x=x0+span（局部 −w/2）→ θ:0→−90°
 *
 * · through='x'（门洞沿 x 贯穿，墙沿 z 延伸）→ 门板沿 z 展开、x 方向薄
 *     室内在 x−1 侧，两扇都朝 −x 扫。
 *     左扇铰链 z=z0（局部 +w/2）→ θ:0→−90°
 *     右扇铰链 z=z0+span（局部 −w/2）→ θ:0→+90°
 *
 * 两扇的 sign 相反，但因为铰链分居门洞两端，开门后**都落在室内一侧**，
 * 这正是真实双开门的行为。
 */

const OPEN_ANGLE = DOOR_SPEC.openAngle;
const OPEN_TIME = 0.35;          // 推门耗时
const DOOR_H = DOOR_SPEC.height;
/** 门的耐久（累计伤害）。见 Door.damage —— 打烂后门洞永久畅通。 */
export const DOOR_HP = 120;
/**
 * 门模型的薄轴居中在门洞深度（由 buildDoorway/DOOR_SPEC.faceInset 统一定义），
 * 让门的两面保持对称，且不与墙面共面。
 */
export class Door {
  /**
   * @param spec { x, y, z, through, thick, span? }
   *   span = 门洞沿展开轴的格数（1 = 单格洞，2 = 主入口那种宽洞）。
   *   (x,z) 永远是门洞在展开轴上最小坐标的那一格。
   */
  constructor(scene, world, spec) {
    this.world = world;
    this.gx = spec.x; this.gy = spec.y; this.gz = spec.z;
    this.open = false;
    this.anim = 0;               // 0=关 1=开
    /**
     * 门的耐久。打烂之后永久变成通路（见 damage / destroy）。
     * 120 ≈ 霰弹两发贴脸、AR 一个短点射 —— 破门要付出噪音代价，
     * 但不至于让「打门」变成需要打空一个弹匣的苦工。
     */
    this.hp = DOOR_HP;
    this.destroyed = false;

    /**
     * 门洞贯穿方向。关卡打洞时就知道方向，直接传过来比事后从网格反推可靠
     * 得多 —— 在 2 格厚的墙上反推必然出错。缺省时退回推断，兼容手写门规格。
     */
    this.through = spec.through ?? this.inferThrough();
    this.interior = spec.interior ?? -1;
    this.thick = spec.thick ?? 1;
    /** 门洞总宽（格）。相邻门格被 DoorManager 合并后 span 才会 >1。 */
    this.span = spec.span ?? 1;

    // The detailed doorway owns its frame and two leaf meshes. Keep the
    // legacy leaf shape as a small adapter for Door rotation/caller code.
    const model = buildDoorway({
      span: this.span, through: this.through, interior: this.interior,
      wallThick: this.thick,
    });
    this.root = model.root;
    this.root.position.set(this.gx, this.gy, this.gz);
    // Keep the static parent transform current for callers that update only a leaf pivot.
    this.root.updateMatrixWorld(true);
    this.leaves = model.leaves.map((leaf, index) => ({
      pivot: leaf.group,
      mesh: leaf.group.children.find((child) => child.isMesh) ?? leaf.group,
      sign: index === 0 ? 1 : -1,
      openAngle: leaf.angle,
    }));
    scene.add(this.root);


    // 关门状态：往网格里写 BLOCK.DOOR，挡住一切但不画整格立方体
    this.applyBlocking(true);
  }

  /** 门洞覆盖的全部格坐标（span 可能 >1） */
  cells() {
    const out = [];
    for (let i = 0; i < this.span; i++) {
      out.push(this.through === 'z'
        ? { x: this.gx + i, z: this.gz }
        : { x: this.gx, z: this.gz + i });
    }
    return out;
  }

  /**
   * 挨枪：累计伤害到 DOOR_HP 后整扇门被打烂。
   *
   * 打烂的门永久变成通路（门板从场景移除、格子清空），所以：
   *  · 霰弹轰门是一个合法的破门方式（噪音巨大，代价是惊动整层）
   *  · 敌人把门关上堵路不再是死局
   *  · 交火中被流弹打坏的门会自己变成新的射界，房间形状是会变的
   *
   * @returns 这一击是否把门打烂了
   */
  damage(amount) {
    if (this.destroyed) return false;
    this.hp -= amount;
    if (this.hp > 0) return false;
    this.destroy();
    return true;
  }

  /** 门被打烂：移除门板几何 + 清空网格，变成永久通路 */
  destroy() {
    if (this.destroyed) return;
    this.destroyed = true;
    this.open = true;               // 语义上等同「永远开着」
    this.anim = 1;
    this.applyBlocking(false);      // 网格清空（保留门框标记）
    const geometries = new Set();
    this.root?.traverse?.((node) => {
      if (node.isMesh && node.geometry) geometries.add(node.geometry);
    });
    this.root?.removeFromParent?.();
    for (const geometry of geometries) {
      if (!geometry.userData?.shared) geometry.dispose?.();
    }
    this.root = null;
    this.leaves = [];
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
    for (const c of this.cells()) {
      for (let y = this.gy; y < this.gy + DOOR_H; y++) {
        this.world.set(c.x, y, c.z, blocking ? BLOCK.DOOR : BLOCK.AIR);
      }
      // 门框标记留在底格（开门后恢复，供 AI 寻路识别通道）
      if (!blocking) this.world.set(c.x, this.gy, c.z, BLOCK.DOORFRAME);
    }
  }

  /** 门洞几何中心（宽门洞取整跨中点，交互距离判定才不偏向一侧） */
  center() {
    const half = this.span / 2;
    return this.through === 'z'
      ? { x: this.gx + half, y: this.gy + 1, z: this.gz + 0.5 }
      : { x: this.gx + 0.5,  y: this.gy + 1, z: this.gz + half };
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
      // 水平方向：实体的圆柱与整个门洞矩形（span×1）是否相交
      const r = a.radius ?? 0.3;
      const w = this.through === 'z' ? this.span : 1;
      const d = this.through === 'z' ? 1 : this.span;
      const cx = Math.max(this.gx, Math.min(p.x, this.gx + w));
      const cz = Math.max(this.gz, Math.min(p.z, this.gz + d));
      if (Math.hypot(p.x - cx, p.z - cz) < r) return true;
    }
    return false;
  }

  /** 显式设定开关状态（关卡初始化时用来把主入口预先打开） */
  setOpen(open) {
    // 打烂的门没有门板可关 —— 强行写回实心方块会凭空出现一堵隐形墙
    if (this.destroyed) return true;
    this.open = open;
    // 开门瞬间就解除遮挡（不等动画播完），否则会「看得见但打不过去」
    this.applyBlocking(!open);
    return this.open;
  }

  /** 把两扇门板转到当前 anim 对应的角度 */
  applyRotation() {
    for (const leaf of this.leaves) {
      leaf.pivot.rotation.y = this.anim * (leaf.openAngle ?? OPEN_ANGLE * leaf.sign);
    }
  }

  /** 跳过动画直接到位，供初始化使用 */
  snap() {
    this.anim = this.open ? 1 : 0;
    this.applyRotation();
  }

  /**
   * 门板完全敞开后落在哪一格 —— 铰链在门洞两端、门板朝室内扫，
   * 所以占的是室内侧那一格（through='z' → z−1；through='x' → x−1）。
   * 关卡的 carveDoor 已经保证那一侧是房间净空。
   */
  swingCell() {
    const side = this.interior < 0 ? -1 : 1;
    return this.through === 'z'
      ? { x: this.gx, z: this.gz + side }
      : { x: this.gx + side, z: this.gz };
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

/**
 * 把关卡登记的门格合并成「门洞」。
 *
 * 关卡里宽门洞是逐格 carveDoor 出来的（主入口 = [[31,47],[32,47]]），
 * 但那是**一个**门洞、只该有两扇门板。不合并的话每格各自劈成一对，
 * 整个门洞正中间会多出两条铰链 —— 关着时中缝多一条线，开着时门板
 * 立在通道中央挡路，正是要修的那个问题。
 *
 * 合并规则：through 与 thick 相同、且沿展开轴（through='z' 时是 x）
 * 坐标连续的门格，并成一条 span。垂直于展开轴的坐标必须一致。
 */
function groupDoorSpecs(specs) {
  const groups = [];
  const sorted = [...specs].sort((a, b) => {
    if (a.through !== b.through) return a.through < b.through ? -1 : 1;
    // 沿展开轴排序：through='z' 沿 x 展开，through='x' 沿 z 展开
    const [aMain, aCross] = a.through === 'z' ? [a.x, a.z] : [a.z, a.x];
    const [bMain, bCross] = b.through === 'z' ? [b.x, b.z] : [b.z, b.x];
    return aCross - bCross || aMain - bMain;
  });
  for (const s of sorted) {
    const last = groups[groups.length - 1];
    if (last) {
      const sameKind = last.through === s.through && last.thick === s.thick;
      const alongZ = s.through === 'z';
      // 展开轴上正好接续，且另一轴与 y 完全一致 → 并入上一组
      const contiguous = alongZ
        ? (s.z === last.z && s.x === last.x + last.span)
        : (s.x === last.x && s.z === last.z + last.span);
      if (sameKind && contiguous && last.y === s.y) {
        last.span += 1;
        continue;
      }
    }
    groups.push({ ...s, span: 1 });
  }
  return groups;
}

export class DoorManager {
  constructor(scene, world, doorSpecs, options = {}) {
    this.doors = groupDoorSpecs(doorSpecs).map((s) => new Door(scene, world, s));
    this.navigation = options.navigation ?? null;
    this.actors = options.actors ?? null;
    /** Called once when an AI successfully opens a door. */
    this.onAIOpen = options.onAIOpen ?? null;
  }

  /** 找出玩家附近可交互的门 */
  nearest(px, py, pz, maxDist = 2.0) {
    let best = null, bestD = maxDist;
    for (const d of this.doors) {
      if (d.destroyed) continue;      // 打烂的门没有交互意义
      const dist = d.distanceTo(px, py, pz);
      if (dist < bestD) { bestD = dist; best = d; }
    }
    return best;
  }

  /**
   * 按格坐标找门。子弹命中 BLOCK.DOOR 时用它定位是哪一扇 ——
   * 宽门洞（span>1）的任意一格都要能查到同一扇门。
   */
  atCell(x, z) {
    for (const d of this.doors) {
      if (d.destroyed) continue;
      for (const c of d.cells()) {
        if (c.x === x && c.z === z) return d;
      }
    }
    return null;
  }

  /**
   * Resolve a runtime Door from NavigationIndex's stable doorKey. Navigation
   * stores data-only door descriptions, so callers must not compare object
   * identity between a link and a Door instance.
   */
  byKey(key) {
    if (!key) return null;
    const same = (door) => door && !door.destroyed
      && Number(door.gx) === Number(key.x)
      && Number(door.gy) === Number(key.y)
      && Number(door.gz) === Number(key.z)
      && door.through === key.through
      && Number(door.thick ?? 1) === Number(key.thick ?? 1);
    return this.doors.find(same) ?? null;
  }

  /**
   * Request an AI-only open operation. The actor is not considered a blocker
   * for its own request, while every other supplied actor is still checked.
   * A successful request changes the voxel state immediately, invalidates the
   * navigation cache once, and invokes exactly one open callback.
   */
  requestAIOpen(door, actor = null, opts = {}) {
    const runtimeDoor = door?.cells ? door : this.byKey(door?.doorKey ?? door);
    if (!runtimeDoor || runtimeDoor.destroyed || runtimeDoor.open) return false;
    const source = opts.actors ?? this.actors ?? [];
    const allActors = typeof source === 'function' ? source() : source;
    const actors = Array.isArray(allActors)
      ? allActors.filter((candidate) => candidate && candidate !== actor)
      : [];
    if (runtimeDoor.blockedByActor(actors)) return false;

    runtimeDoor.setOpen(true);
    runtimeDoor.snap?.();
    const navigation = opts.navigation ?? this.navigation;
    navigation?.invalidateDoors?.();
    const callback = opts.onDoorNoise ?? this.onAIOpen;
    callback?.(runtimeDoor, actor);
    return true;
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
      // 宽门洞被合并成一扇门，任意一格命中就算命中（主入口两格 → 一扇门）
      const own = d.cells();
      if (cells.some(([x, z]) => own.some((c) => c.x === x && c.z === z))) {
        d.setOpen(true);
        d.snap();
        n++;
      }
    }
    return n;
  }

  update(dt) { for (const d of this.doors) d.update(dt); }
}
