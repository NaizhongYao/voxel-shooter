/**
 * 可开合家具交互：管理 placement.open 与实验家具的门片/箱盖旋转。
 * 家具 AABB 仍由 world.furniture.colliders 提供，本系统不改动碰撞索引。
 */

export const OPENABLE_FURNITURE_RANGE = 2.2;

const OPENABLE_IDS = new Set(['crate', 'cabinet', 'wardrobe']);
const LABELS = {
  crate: '木箱',
  cabinet: '柜子',
  wardrobe: '衣柜',
};

function placementKey(item) {
  return `${item?.id}@${item?.x},${item?.y},${item?.z}`;
}

function distanceToBounds(item, px, py, pz) {
  const raw = Array.isArray(item?.bounds) && item.bounds.length >= 6
    ? item.bounds
    : [item?.x, item?.y, item?.z, item?.boundsW ?? item?.w ?? 1,
      item?.boundsH ?? item?.height ?? 1, item?.boundsD ?? item?.d ?? 1];
  const bounds = raw.map(Number);
  if (bounds.some((value) => !Number.isFinite(value))) return Infinity;
  const [x, y, z, width, height, depth] = bounds;
  const dx = px < x ? x - px : px > x + width ? px - (x + width) : 0;
  const dy = py < y ? y - py : py > y + height ? py - (y + height) : 0;
  const dz = pz < z ? z - pz : pz > z + depth ? pz - (z + depth) : 0;
  return Math.hypot(dx, dy, dz);
}

export class OpenableFurnitureManager {
  /** @param {THREE.Scene} scene @param {{placements?:Array,meshes?:Array}} furniture */
  constructor(scene, furniture, maxDist = OPENABLE_FURNITURE_RANGE) {
    this.scene = scene;
    this.furniture = furniture ?? {};
    this.maxDist = maxDist;
    this.openables = this._scan();
  }

  _scan() {
    const placements = Array.isArray(this.furniture.placements)
      ? this.furniture.placements : [];
    const meshes = Array.isArray(this.furniture.meshes) ? this.furniture.meshes : [];
    return placements.filter((placement) =>
      placement?.openable === true || OPENABLE_IDS.has(placement?.id)
    ).map((placement) => {
      const mesh = meshes.find((candidate) => {
        const metadata = candidate?.userData?.furniture;
        return metadata === placement || placementKey(metadata) === placementKey(placement);
      });
      const openable = mesh?.userData?.openable;
      const leaves = Array.isArray(openable?.leaves) ? openable.leaves : [];
      if (!mesh || leaves.length === 0) return null;
      const initial = placement.open === true ? 1 : 0;
      return {
        placement,
        mesh,
        leaves,
        kind: openable.kind ?? (placement.id === 'crate' ? 'lid' : 'door'),
        amount: initial,
        target: initial,
      };
    }).filter(Boolean);
  }

  /** 返回范围内离玩家 AABB 最近的 placement。 */
  nearest(px, py, pz, maxDist = this.maxDist) {
    const limit = Number(maxDist);
    if (!Number.isFinite(limit) || limit < 0) return null;
    let best = null;
    let bestDistance = limit;
    for (const entry of this.openables) {
      const distance = distanceToBounds(entry.placement, px, py, pz);
      if (distance <= bestDistance) {
        bestDistance = distance;
        best = entry.placement;
      }
    }
    return best;
  }

  _entry(item) {
    if (!item) return null;
    return this.openables.find((entry) =>
      entry.placement === item || placementKey(entry.placement) === placementKey(item)
    ) ?? null;
  }

  _apply(entry) {
    const amount = entry.amount;
    for (const leaf of entry.leaves) {
      const axis = leaf.axis ?? (entry.kind === 'lid' ? 'x' : 'y');
      if (leaf.group?.rotation) leaf.group.rotation[axis] = leaf.angle * amount;
    }
  }

  /** 切换门片/箱盖，返回切换后的 open 状态；不触碰碰撞索引。 */
  toggle(item) {
    const entry = this._entry(item);
    if (!entry) return false;
    entry.placement.open = !entry.placement.open;
    entry.target = entry.placement.open ? 1 : 0;
    entry.amount = entry.target;
    this._apply(entry);
    return entry.placement.open;
  }

  /** 逐帧把门片/箱盖平滑过渡到 placement.open 对应状态。 */
  update(dt = 0) {
    const step = Number.isFinite(dt) && dt > 0 ? Math.min(1, dt * 8) : 0;
    for (const entry of this.openables) {
      entry.target = entry.placement.open ? 1 : 0;
      if (step > 0) entry.amount += (entry.target - entry.amount) * step;
      else entry.amount = entry.target;
      this._apply(entry);
    }
  }

  label(item) {
    return LABELS[item?.id] ?? '家具';
  }
}

export default OpenableFurnitureManager;
