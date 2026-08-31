import { WORLD } from '../config.js';
import { BLOCK, BLOCKS, isSolid, isOpaque, topOf } from './blocks.js';
import { FurnitureCollider } from '../systems/furniture-collider.js';

const { SX, SY, SZ } = WORLD;

/**
 * 体素世界：一个 Uint8Array 就是全部关卡数据。
 * 索引顺序 (y, z, x) —— 让同一层同一行在内存里连续，利于按层遍历。
 */
export class World {
  constructor() {
    this.sx = SX; this.sy = SY; this.sz = SZ;
    this.data = new Uint8Array(SX * SY * SZ);
    this.dirtyChunks = new Set();
    this.furnitureCollider = null;
  }

  setFurnitureColliders(colliders = []) {
    this.furnitureCollider = new FurnitureCollider(colliders);
    return this.furnitureCollider;
  }

  _ensureFurnitureCollider() {
    if (!this.furnitureCollider && Array.isArray(this.furniture?.colliders)) {
      this.setFurnitureColliders(this.furniture.colliders);
    }
    return this.furnitureCollider;
  }

  idx(x, y, z) { return (y * SZ + z) * SX + x; }
  inBounds(x, y, z) {
    return x >= 0 && y >= 0 && z >= 0 && x < SX && y < SY && z < SZ;
  }

  /** 越界视为空气（世界外可以自由落下 / 看向天空） */
  get(x, y, z) {
    if (!this.inBounds(x, y, z)) return BLOCK.AIR;
    return this.data[this.idx(x, y, z)];
  }

  set(x, y, z, id) {
    if (!this.inBounds(x, y, z)) return;
    this.data[this.idx(x, y, z)] = id;
    this.dirtyChunks.add(this.chunkKey(x, z));
  }

  chunkKey(x, z) {
    return `${Math.floor(x / WORLD.CHUNK)},${Math.floor(z / WORLD.CHUNK)}`;
  }

  // ---- 采样查询 ----------------------------------------------------------

  /** 世界坐标点是否落在实心方块内（考虑非整格高度） */
  solidAtPoint(wx, wy, wz) {
    const gx = Math.floor(wx), gy = Math.floor(wy), gz = Math.floor(wz);
    const id = this.get(gx, gy, gz);
    if (!isSolid(id)) return false;
    return (wy - gy) < topOf(id) - 1e-6;
  }

  opaqueAt(gx, gy, gz) {
    const id = this.get(gx, gy, gz);
    return isOpaque(id) && topOf(id) >= 1;
  }

  /** 该格上方是否完全没有不透光方块 —— 用于烘焙室外月光 */
  skyExposed(gx, gy, gz) {
    for (let y = gy + 1; y < SY; y++) {
      if (this.opaqueAt(gx, y, gz)) return false;
    }
    return true;
  }

  /**
   * AABB 与体素网格求交。box 为世界坐标区间。
   * 逐格测试，格内按 topOf 高度构造实体盒。
   */
  boxIntersects(minX, minY, minZ, maxX, maxY, maxZ) {
    const x0 = Math.floor(minX), x1 = Math.floor(maxX - 1e-6);
    const y0 = Math.floor(minY), y1 = Math.floor(maxY - 1e-6);
    const z0 = Math.floor(minZ), z1 = Math.floor(maxZ - 1e-6);
    for (let y = y0; y <= y1; y++) {
      for (let z = z0; z <= z1; z++) {
        for (let x = x0; x <= x1; x++) {
          const id = this.get(x, y, z);
          if (!isSolid(id)) continue;
          const top = y + topOf(id);
          if (minY < top - 1e-6 && maxY > y + 1e-6) return true;
        }
      }
    }
    return !!this._ensureFurnitureCollider()?.boxIntersects(
      minX, minY, minZ, maxX, maxY, maxZ
    );
  }

  /**
   * 在给定 AABB 覆盖范围内，找出低于 probeTop 的最高实心顶面。
   * 用于地面吸附与自动登台（返回 -Infinity 表示脚下无物）。
   */
  highestSurfaceUnder(minX, minZ, maxX, maxZ, probeTop, probeBottom) {
    let best = -Infinity;
    const x0 = Math.floor(minX), x1 = Math.floor(maxX - 1e-6);
    const z0 = Math.floor(minZ), z1 = Math.floor(maxZ - 1e-6);
    const y0 = Math.max(0, Math.floor(probeBottom));
    const y1 = Math.min(SY - 1, Math.floor(probeTop));
    for (let z = z0; z <= z1; z++) {
      for (let x = x0; x <= x1; x++) {
        for (let y = y1; y >= y0; y--) {
          const id = this.get(x, y, z);
          if (!isSolid(id)) continue;
          const top = y + topOf(id);
          if (top <= probeTop + 1e-6 && top > best) best = top;
          break;
        }
      }
    }
    const furnitureBest = this._ensureFurnitureCollider()?.highestSurfaceUnder(
      minX, minZ, maxX, maxZ, probeTop, probeBottom
    ) ?? -Infinity;
    return Math.max(best, furnitureBest);
  }

  /**
   * 体素 DDA 射线步进。命中返回 { grid, normal, dist, point }，否则 null。
   * 用于相机回拉、视线判定、子弹与光斑检测。
   */
  raycast(ox, oy, oz, dx, dy, dz, maxDist = 64, opaqueOnly = false) {
    const len = Math.hypot(dx, dy, dz) || 1;
    dx /= len; dy /= len; dz /= len;

    let gx = Math.floor(ox), gy = Math.floor(oy), gz = Math.floor(oz);
    const stepX = Math.sign(dx), stepY = Math.sign(dy), stepZ = Math.sign(dz);
    const tDeltaX = stepX !== 0 ? Math.abs(1 / dx) : Infinity;
    const tDeltaY = stepY !== 0 ? Math.abs(1 / dy) : Infinity;
    const tDeltaZ = stepZ !== 0 ? Math.abs(1 / dz) : Infinity;
    let tMaxX = stepX > 0 ? (gx + 1 - ox) * tDeltaX : stepX < 0 ? (ox - gx) * tDeltaX : Infinity;
    let tMaxY = stepY > 0 ? (gy + 1 - oy) * tDeltaY : stepY < 0 ? (oy - gy) * tDeltaY : Infinity;
    let tMaxZ = stepZ > 0 ? (gz + 1 - oz) * tDeltaZ : stepZ < 0 ? (oz - gz) * tDeltaZ : Infinity;

    let normal = [0, 0, 0];
    let voxelHit = null;
    let t = 0;
    for (let guard = 0; guard < 512; guard++) {
      const id = this.get(gx, gy, gz);
      const hit = opaqueOnly ? isOpaque(id) && id !== BLOCK.AIR : isSolid(id);
      if (hit) {
        // 非整格方块：只在射线确实进入实体部分时才算命中
        const h = topOf(id);
        const py = oy + dy * t;
        if (h >= 1 || (py - gy) < h) {
          voxelHit = {
            grid: [gx, gy, gz], normal, dist: t,
            point: [ox + dx * t, oy + dy * t, oz + dz * t],
            id,
          };
          break;
        }
      }
      if (voxelHit || t > maxDist) break;
      if (tMaxX < tMaxY && tMaxX < tMaxZ) {
        gx += stepX; t = tMaxX; tMaxX += tDeltaX; normal = [-stepX, 0, 0];
      } else if (tMaxY < tMaxZ) {
        gy += stepY; t = tMaxY; tMaxY += tDeltaY; normal = [0, -stepY, 0];
      } else {
        gz += stepZ; t = tMaxZ; tMaxZ += tDeltaZ; normal = [0, 0, -stepZ];
      }
      if (gy < -2 || gy > SY + 2) break;
    }
    const furnitureHit = this._ensureFurnitureCollider()?.raycast(
      ox, oy, oz, dx, dy, dz, maxDist, opaqueOnly
    ) ?? null;
    if (!voxelHit) {
      return furnitureHit ? { ...furnitureHit, id: BLOCK.WALL_IN } : null;
    }
    if (!furnitureHit || voxelHit.dist <= furnitureHit.dist + 1e-6) return voxelHit;
    return { ...furnitureHit, id: BLOCK.WALL_IN };
  }

  /** 两点之间是否有不透光方块（敌人视线判定用） */
  lineBlocked(ax, ay, az, bx, by, bz) {
    const dx = bx - ax, dy = by - ay, dz = bz - az;
    const d = Math.hypot(dx, dy, dz);
    if (d < 1e-4) return false;
    const hit = this.raycast(ax, ay, az, dx, dy, dz, d, true);
    return !!hit && hit.dist < d - 1e-3;
  }

  fill(x0, y0, z0, x1, y1, z1, id) {
    for (let y = y0; y <= y1; y++)
      for (let z = z0; z <= z1; z++)
        for (let x = x0; x <= x1; x++) this.set(x, y, z, id);
  }

  /** 空心盒（只留墙，不填内部）——搭房间用 */
  box(x0, y0, z0, x1, y1, z1, id) {
    for (let y = y0; y <= y1; y++)
      for (let z = z0; z <= z1; z++)
        for (let x = x0; x <= x1; x++) {
          const onEdge = x === x0 || x === x1 || z === z0 || z === z1;
          if (onEdge) this.set(x, y, z, id);
        }
  }
}

export { BLOCK, BLOCKS };
