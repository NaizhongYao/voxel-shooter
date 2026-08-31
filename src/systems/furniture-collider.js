const EPSILON = 1e-6;

/**
 * Three.js-independent collision and ray queries for placed furniture.
 * Input bounds use [minX, minY, minZ, width, height, depth].
 */
export class FurnitureCollider {
  constructor(colliders = []) {
    if (!Array.isArray(colliders)) {
      throw new TypeError('FurnitureCollider expects an array of colliders');
    }
    this._colliders = colliders.map((collider, index) => this._normalize(collider, index));
  }

  _normalize(collider, index) {
    if (!collider || !Array.isArray(collider.bounds) || collider.bounds.length < 6) {
      throw new TypeError(`Invalid furniture collider at index ${index}`);
    }
    const values = collider.bounds.slice(0, 6).map(Number);
    if (values.some((value) => !Number.isFinite(value))) {
      throw new TypeError(`Invalid furniture collider bounds at index ${index}`);
    }

    const [x, y, z, width, height, depth] = values;
    const x2 = x + width;
    const y2 = y + height;
    const z2 = z + depth;
    const minX = Math.min(x, x2);
    const minY = Math.min(y, y2);
    const minZ = Math.min(z, z2);
    const maxX = Math.max(x, x2);
    const maxY = Math.max(y, y2);
    const maxZ = Math.max(z, z2);
    return {
      id: collider.id,
      opaque: collider.opaque !== false && collider.transparent !== true,
      minX, minY, minZ, maxX, maxY, maxZ,
      bounds: [minX, minY, minZ, maxX - minX, maxY - minY, maxZ - minZ],
    };
  }

  /** Return copies so callers cannot mutate the collider index. */
  getColliders() {
    return this._colliders.map(({ id, bounds, opaque }) => ({
      id,
      bounds: bounds.slice(),
      ...(opaque ? {} : { opaque: false }),
    }));
  }

  boxIntersects(minX, minY, minZ, maxX, maxY, maxZ) {
    if (maxX <= minX || maxY <= minY || maxZ <= minZ) return false;
    return this._colliders.some((collider) =>
      minX < collider.maxX - EPSILON && maxX > collider.minX + EPSILON &&
      minY < collider.maxY - EPSILON && maxY > collider.minY + EPSILON &&
      minZ < collider.maxZ - EPSILON && maxZ > collider.minZ + EPSILON
    );
  }

  highestSurfaceUnder(minX, minZ, maxX, maxZ, probeTop, probeBottom) {
    let best = -Infinity;
    for (const collider of this._colliders) {
      const horizontalOverlap =
        minX < collider.maxX - EPSILON && maxX > collider.minX + EPSILON &&
        minZ < collider.maxZ - EPSILON && maxZ > collider.minZ + EPSILON;
      if (!horizontalOverlap) continue;

      const top = collider.maxY;
      if (top > probeTop + EPSILON || top < probeBottom - EPSILON) continue;
      if (top > best) best = top;
    }
    return best;
  }

  /** Ray/AABB slab test. Direction is normalized before distance is reported. */
  raycast(ox, oy, oz, dx, dy, dz, maxDist = 64, opaqueOnly = false) {
    if (maxDist < 0) return null;
    const length = Math.hypot(dx, dy, dz);
    if (!Number.isFinite(length)) return null;
    const invLength = length || 1;
    dx /= invLength; dy /= invLength; dz /= invLength;

    let closest = null;
    for (const collider of this._colliders) {
      if (opaqueOnly && !collider.opaque) continue;

      const hit = this._rayBox(ox, oy, oz, dx, dy, dz, maxDist, collider);
      if (!hit || (closest && hit.dist >= closest.dist - EPSILON)) continue;
      const point = [ox + dx * hit.dist, oy + dy * hit.dist, oz + dz * hit.dist];
      closest = {
        grid: [Math.floor(point[0]), Math.floor(point[1]), Math.floor(point[2])],
        normal: hit.normal,
        dist: hit.dist,
        point,
        id: collider.id,
        furniture: true,
      };
    }
    return closest;
  }

  _rayBox(ox, oy, oz, dx, dy, dz, maxDist, collider) {
    const origin = [ox, oy, oz];
    const direction = [dx, dy, dz];
    const mins = [collider.minX, collider.minY, collider.minZ];
    const maxs = [collider.maxX, collider.maxY, collider.maxZ];
    let near = -Infinity;
    let far = Infinity;
    let nearNormal = [0, 0, 0];

    for (let axis = 0; axis < 3; axis++) {
      const o = origin[axis];
      const d = direction[axis];
      if (Math.abs(d) < EPSILON) {
        if (o < mins[axis] - EPSILON || o > maxs[axis] + EPSILON) return null;
        continue;
      }

      let t1 = (mins[axis] - o) / d;
      let t2 = (maxs[axis] - o) / d;
      let normal = [0, 0, 0];
      normal[axis] = d > 0 ? -1 : 1;
      if (t1 > t2) [t1, t2] = [t2, t1];
      if (t1 > near) {
        near = t1;
        nearNormal = normal;
      }
      far = Math.min(far, t2);
      if (near > far + EPSILON) return null;
    }

    if (far < -EPSILON || near > maxDist + EPSILON) return null;
    const dist = Math.max(0, near);
    return {
      dist,
      // A ray starting inside has no forward entering face. Keep the
      // immediate-hit distance while matching the voxel query's zero normal.
      normal: near < -EPSILON ? [0, 0, 0] : nearNormal,
    };
  }
}

export default FurnitureCollider;
