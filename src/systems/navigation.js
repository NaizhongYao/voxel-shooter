import { BLOCK } from '../voxel/blocks.js';

/**
 * Three.js-independent navigation data for the single-floor voxel levels.
 *
 * This module deliberately owns only static navigation infrastructure. It does
 * not open doors, move actors, or start a wander state. Door changes are
 * represented by a revision so callers can invalidate their own cached plans.
 */

export const NAVIGATION_DEFAULTS = Object.freeze({
  entityRadius: 0.28,
  entityHeight: 1.8,
  groundY: 1,
  boundaryMargin: 0.4,
  maxLocalNodes: 96,
  maxLocalDistance: 14,
});

export const OUTSIDE_ROOM = 'outside';

const FOUR_DIRECTIONS = Object.freeze([
  [1, 0],
  [0, 1],
  [-1, 0],
  [0, -1],
]);

function finite(value) {
  return Number.isFinite(Number(value));
}

function pointOf(value) {
  if (Array.isArray(value)) return { x: Number(value[0]), z: Number(value[1]) };
  return { x: Number(value?.x), z: Number(value?.z) };
}

function doorKeyOf(door) {
  if (!door || typeof door !== 'object') return null;
  const x = Number(door.x), y = Number(door.y), z = Number(door.z);
  if (![x, y, z].every(Number.isFinite) || typeof door.through !== 'string') return null;
  return {
    x,
    y,
    z,
    through: door.through,
    thick: Number(door.thick) || 1,
  };
}

function roomEntries(level) {
  return Object.entries(level?.rooms ?? {});
}

function roomContains(room, x, z) {
  // Room coordinates describe inclusive voxel indices, so the world-space
  // rectangle is half-open: [x0, x1 + 1) x [z0, z1 + 1).
  return finite(x) && finite(z)
    && x >= room.x0 && x < room.x1 + 1
    && z >= room.z0 && z < room.z1 + 1;
}

function groupedDoorSpecs(specs = []) {
  const groups = [];
  const sorted = [...specs].filter(Boolean).sort((a, b) => {
    if (a.through !== b.through) return a.through < b.through ? -1 : 1;
    const [aMain, aCross] = a.through === 'z' ? [a.x, a.z] : [a.z, a.x];
    const [bMain, bCross] = b.through === 'z' ? [b.x, b.z] : [b.z, b.x];
    return aCross - bCross || aMain - bMain || (a.y ?? 0) - (b.y ?? 0);
  });

  for (const spec of sorted) {
    const last = groups[groups.length - 1];
    const sameKind = last
      && last.through === spec.through
      && (last.thick ?? 1) === (spec.thick ?? 1)
      && (last.y ?? 0) === (spec.y ?? 0);
    const alongZ = spec.through === 'z';
    const contiguous = sameKind && (alongZ
      ? spec.z === last.z && spec.x === last.x + last.span
      : spec.x === last.x && spec.z === last.z + last.span);
    if (contiguous) {
      last.span += 1;
    } else {
      groups.push({ ...spec, span: Number(spec.span) || 1 });
    }
  }

  return groups.map((spec, index) => ({
    ...spec,
    id: spec.id ?? `door-${String(index + 1).padStart(2, '0')}`,
  }));
}

function doorSideSamples(door, side) {
  const span = Number(door.span) || 1;
  const thick = Number(door.thick) || 1;
  const small = side < 0;
  if (door.through === 'z') {
    const z = small ? door.z - 0.5 : door.z + thick + 0.5;
    return Array.from({ length: span }, (_, i) => ({
      x: door.x + i + 0.5,
      z,
    }));
  }
  const x = small ? door.x - 0.5 : door.x + thick + 0.5;
  return Array.from({ length: span }, (_, i) => ({
    x,
    z: door.z + i + 0.5,
  }));
}

function pickRoomForSide(level, door, side) {
  const counts = new Map();
  for (const point of doorSideSamples(door, side)) {
    const room = roomEntries(level).find(([, rect]) => roomContains(rect, point.x, point.z))?.[0];
    if (room) counts.set(room, (counts.get(room) ?? 0) + 1);
  }
  if (counts.size === 0) return null;
  // A doorway crossing two room rectangles is ambiguous. Refusing it is safer
  // than silently connecting one room to the wrong room.
  const ordered = [...counts.entries()].sort((a, b) => b[1] - a[1] || a[0].localeCompare(b[0]));
  if (ordered.length > 1 && ordered[0][1] === ordered[1][1]) return null;
  return ordered[0][0];
}

function doorSummary(door) {
  return {
    id: door.id,
    x: door.x,
    y: door.y,
    z: door.z,
    through: door.through,
    thick: door.thick ?? 1,
    span: door.span ?? 1,
    doorKey: doorKeyOf(door),
  };
}

function explicitLinks(level) {
  const supplied = typeof level?.roomLinks === 'function'
    ? level.roomLinks(level)
    : level?.roomLinks;
  return Array.isArray(supplied) ? supplied : null;
}

function normalizeLink(link, index, level) {
  const id = link?.id ?? `${level?.id ?? 'level'}-link-${String(index + 1).padStart(2, '0')}`;
  const rawDoor = link?.door && typeof link.door === 'object'
    ? { ...link.door }
    : link?.door ?? null;
  const door = rawDoor && typeof rawDoor === 'object'
    ? { id: rawDoor.id ?? `${id}-door`, ...rawDoor }
    : rawDoor;
  const doorKey = doorKeyOf(door);
  if (doorKey) door.doorKey = doorKey;
  const from = link?.from ?? null;
  const to = link?.to ?? null;
  const outside = !!link?.outside || from === OUTSIDE_ROOM || to === OUTSIDE_ROOM;
  return {
    id,
    from,
    to,
    door,
    doorId: link?.doorId ?? (typeof door === 'string' ? door : door?.id ?? null),
    doorKey,
    bidirectional: link?.bidirectional !== false,
    openConnection: link?.openConnection === true || !door,
    outside,
    ...(link?.opening ? { opening: { ...link.opening } } : {}),
    ...(link?.staging ? { staging: link.staging } : {}),
  };
}

/**
 * Build deterministic room links from grouped DOORS metadata.
 *
 * Exterior doors are intentionally omitted from inferred links. A caller may
 * add an explicit `{ outside: true, to: 'outside' }` link when a future policy
 * needs it; ordinary Wander room paths therefore cannot enter the courtyard.
 */
export function buildRoomLinks(level) {
  const supplied = explicitLinks(level);
  if (supplied && supplied.length > 0) {
    return supplied.map((link, index) => normalizeLink(link, index, level));
  }

  const links = [];
  const doors = groupedDoorSpecs(level?.doors ?? []);
  for (const door of doors) {
    const smallRoom = pickRoomForSide(level, door, -1);
    const largeRoom = pickRoomForSide(level, door, 1);
    if (!smallRoom || !largeRoom || smallRoom === largeRoom) continue;
    links.push({
      id: `${level?.id ?? 'level'}-link-${String(links.length + 1).padStart(2, '0')}`,
      from: smallRoom,
      to: largeRoom,
      door: doorSummary(door),
      doorId: door.id,
      bidirectional: true,
      openConnection: false,
      outside: false,
      doorKey: doorKeyOf(door),
    });
  }
  return links;
}

export class NavigationIndex {
  constructor(world, level, options = {}) {
    if (!world || typeof world.boxIntersects !== 'function'
      || typeof world.highestSurfaceUnder !== 'function') {
      throw new TypeError('NavigationIndex expects a World-like collision object');
    }
    this.world = world;
    this.level = level ?? {};
    this.options = { ...NAVIGATION_DEFAULTS, ...options };
    this.entityRadius = Number(this.options.entityRadius);
    this.entityHeight = Number(this.options.entityHeight);
    this.groundY = Number(this.options.groundY);
    this.boundaryMargin = Number(this.options.boundaryMargin);
    this.links = buildRoomLinks(this.level);
    this.roomLinks = this.links;
    this.roomNodes = new Map();
    this.nodeByKey = new Map();
    this._doorRevision = 0;
    this._roomPathCache = new Map();
    this._buildNodes();
    this._buildStaging();
    this._buildComponents();
  }

  get doorRevision() { return this._doorRevision; }

  invalidateDoors() {
    this._doorRevision += 1;
    this._roomPathCache.clear();
    this._buildStaging();
    return this._doorRevision;
  }

  getRoomAt(x, z) {
    for (const [id, room] of roomEntries(this.level)) {
      if (roomContains(room, x, z)) return id;
    }
    return null;
  }

  getRoomNodes(roomId) {
    return (this.roomNodes.get(roomId) ?? []).slice();
  }

  nearestNode(roomId, x, z) {
    if (!this.roomNodes.has(roomId) || !finite(x) || !finite(z)) return null;
    let best = null;
    let bestDistance = Infinity;
    for (const node of this.roomNodes.get(roomId)) {
      const distance = (node.x - x) ** 2 + (node.z - z) ** 2;
      if (distance < bestDistance - 1e-9
        || (Math.abs(distance - bestDistance) <= 1e-9 && node.key < best?.key)) {
        best = node;
        bestDistance = distance;
      }
    }
    return best;
  }

  neighbors(node) {
    if (!node?.roomId || !this.nodeByKey.has(node.key)) return [];
    const gx = Math.floor(node.x);
    const gz = Math.floor(node.z);
    const result = [];
    for (const [dx, dz] of FOUR_DIRECTIONS) {
      const next = this.nodeByKey.get(`${node.roomId}:${gx + dx},${gz + dz}`);
      if (next) result.push(next);
    }
    return result;
  }

  findRoomPath(fromRoom, toRoom, policy = {}) {
    const details = this._findRoomPathDetails(fromRoom, toRoom, policy);
    return details?.rooms.slice() ?? null;
  }

  _findRoomPathDetails(fromRoom, toRoom, policy = {}) {
    const allowOutside = policy.allowOutside === true || policy.includeOutside === true;
    const roomExists = (id) => roomEntries(this.level).some(([roomId]) => roomId === id);
    const validEndpoint = (id) => roomExists(id) || (allowOutside && id === OUTSIDE_ROOM);
    if (!validEndpoint(fromRoom) || !validEndpoint(toRoom)) return null;
    if (fromRoom === toRoom) return { rooms: [fromRoom], links: [] };

    const cacheKey = `${fromRoom}|${toRoom}|${allowOutside}`;
    const cached = this._roomPathCache.get(cacheKey);
    if (cached) {
      return { rooms: cached.rooms.slice(), links: cached.links.slice() };
    }

    const queue = [fromRoom];
    const parent = new Map([[fromRoom, null]]);
    while (queue.length > 0) {
      const current = queue.shift();
      for (const link of this.links) {
        if (link.outside && !allowOutside) continue;
        let next = null;
        if (link.from === current) next = link.to;
        else if (link.bidirectional && link.to === current) next = link.from;
        if (next === null || parent.has(next)) continue;
        if (!validEndpoint(next)) continue;
        parent.set(next, { room: current, link });
        if (next === toRoom) {
          const rooms = [toRoom];
          const links = [];
          let cursor = toRoom;
          while (cursor !== fromRoom) {
            const step = parent.get(cursor);
            links.push(step.link);
            cursor = step.room;
            rooms.push(cursor);
          }
          rooms.reverse();
          links.reverse();
          const details = { rooms, links };
          this._roomPathCache.set(cacheKey, details);
          return { rooms: rooms.slice(), links: links.slice() };
        }
        queue.push(next);
      }
    }
    return null;
  }

  findDoorPath(fromRoom, toRoom, policy = {}) {
    const details = this._findRoomPathDetails(fromRoom, toRoom, policy);
    if (!details) return null;
    const { rooms, links } = details;
    // Keep null entries for permanent openings so room/link/door positions
    // stay aligned across the returned path arrays.
    const doors = links.map((link) => link.door ?? null);
    const doorObjects = links
      .filter((link) => link.door && typeof link.door === 'object')
      .map((link) => ({
        ...link.door,
        door: link.door,
        doorKey: link.doorKey,
        link,
      }));
    return {
      rooms: rooms.slice(),
      links: links.slice(),
      doors,
      roomPath: rooms.slice(),
      linkPath: links.slice(),
      doorPath: doors,
      doorObjects,
    };
  }

  /** Full entity AABB check at a point, including the exact ground surface. */
  isWalkablePoint(x, z, opts = {}) {
    if (!finite(x) || !finite(z)) return false;
    const radius = Number(opts.entityRadius ?? opts.radius ?? this.entityRadius);
    const height = Number(opts.entityHeight ?? opts.height ?? this.entityHeight);
    const y = Number(opts.y ?? opts.groundY ?? this.groundY);
    if (![radius, height, y].every(Number.isFinite) || radius < 0 || height <= 0) return false;

    if (opts.roomId != null && this.getRoomAt(x, z) !== opts.roomId) return false;
    const minX = x - radius, maxX = x + radius;
    const minZ = z - radius, maxZ = z + radius;
    const probeTop = y + height + 0.25;
    const surface = this.world.highestSurfaceUnder(
      minX, minZ, maxX, maxZ, probeTop, y - 0.5
    );
    const tolerance = Number(opts.surfaceTolerance ?? 1e-5);
    if (!Number.isFinite(surface) || Math.abs(surface - y) > tolerance) return false;
    return !this.world.boxIntersects(minX, y, minZ, maxX, y + height, maxZ);
  }

  findLocalPath(start, goal, opts = {}) {
    const startPoint = pointOf(start), goalPoint = pointOf(goal);
    if (![startPoint.x, startPoint.z, goalPoint.x, goalPoint.z].every(Number.isFinite)) return null;
    const startRoom = this.getRoomAt(startPoint.x, startPoint.z);
    const goalRoom = this.getRoomAt(goalPoint.x, goalPoint.z);
    // Cross-room paths must start from a room/staging point; this local search
    // intentionally handles only one room and never traverses a door opening.
    if (!startRoom || startRoom !== goalRoom) return null;
    if (opts.roomId != null && opts.roomId !== startRoom) return null;

    const first = this.nearestNode(startRoom, startPoint.x, startPoint.z);
    const last = this.nearestNode(goalRoom, goalPoint.x, goalPoint.z);
    if (!first || !last) return null;
    if (first.key === last.key) return [first];

    const requestedNodes = Number(opts.maxNodes ?? this.options.maxLocalNodes);
    const requestedDistance = Number(
      opts.maxDistance ?? opts.maxPathDistance ?? this.options.maxLocalDistance
    );
    const maxNodes = Number.isFinite(requestedNodes)
      ? Math.max(1, Math.floor(requestedNodes))
      : this.options.maxLocalNodes;
    const maxDistance = Number.isFinite(requestedDistance)
      ? Math.max(0, Math.floor(requestedDistance))
      : this.options.maxLocalDistance;
    const queue = [first];
    const parent = new Map([[first.key, null]]);
    const depth = new Map([[first.key, 0]]);
    let visited = 0;
    while (queue.length > 0 && visited < maxNodes) {
      const current = queue.shift();
      visited += 1;
      const currentDepth = depth.get(current.key);
      if (currentDepth >= maxDistance) continue;
      for (const next of this.neighbors(current)) {
        if (parent.has(next.key) || parent.size >= maxNodes) continue;
        parent.set(next.key, current.key);
        depth.set(next.key, currentDepth + 1);
        if (next.key === last.key) {
          const path = [next];
          let key = next.key;
          while (key !== first.key) {
            key = parent.get(key);
            path.push(this.nodeByKey.get(key));
          }
          path.reverse();
          return path;
        }
        if (parent.size < maxNodes) queue.push(next);
      }
    }
    return null;
  }

  _buildNodes() {
    for (const [roomId, room] of roomEntries(this.level)) {
      const nodes = [];
      for (let gz = Math.ceil(room.z0); gz <= Math.floor(room.z1); gz++) {
        for (let gx = Math.ceil(room.x0); gx <= Math.floor(room.x1); gx++) {
          const x = gx + 0.5, z = gz + 0.5;
          const clear = x - room.x0 >= this.boundaryMargin
            && room.x1 + 1 - x >= this.boundaryMargin
            && z - room.z0 >= this.boundaryMargin
            && room.z1 + 1 - z >= this.boundaryMargin;
          if (!clear || this.getRoomAt(x, z) !== roomId) continue;
          if (!this.isWalkablePoint(x, z, { roomId })) continue;
          const node = {
            key: `${roomId}:${gx},${gz}`,
            x, y: this.groundY, z, roomId,
          };
          nodes.push(node);
          this.nodeByKey.set(node.key, node);
        }
      }
      this.roomNodes.set(roomId, nodes);
    }
  }

  _buildComponents() {
    let componentCounter = 0;
    for (const nodes of this.roomNodes.values()) {
      const seen = new Set();
      for (const start of nodes) {
        if (seen.has(start.key)) continue;
        const componentId = `component-${componentCounter++}`;
        const queue = [start];
        seen.add(start.key);
        while (queue.length > 0) {
          const node = queue.shift();
          node.componentId = componentId;
          for (const next of this.neighbors(node)) {
            if (seen.has(next.key)) continue;
            seen.add(next.key);
            queue.push(next);
          }
        }
      }
    }
  }

  _buildStaging() {
    for (const link of this.links) {
      if (link.outside) continue;
      const passage = link.door && typeof link.door === 'object'
        ? link.door
        : link.openConnection && link.opening;
      if (!passage) continue;
      const existing = Array.isArray(link.staging) && link.staging.length > 0
        ? link.staging
        : [
          { ...doorSideSamples(passage, -1)[0], y: this.groundY, roomId: link.from },
          { ...doorSideSamples(passage, 1)[0], y: this.groundY, roomId: link.to },
        ];
      const requiresOpen = !!link.door && this._doorIsClosed(link.door);
      link.requiresOpen = requiresOpen;
      // `stagingBlocked` describes this point only. `requiresOpen` describes
      // the link's current door state; permanent openings always remain false.
      link.staging = existing.map((point, index) => {
        const roomId = point.roomId ?? (index === 0 ? link.from : link.to);
        return {
          ...point,
          y: point.y ?? this.groundY,
          roomId,
          stagingBlocked: !this.isWalkablePoint(point.x, point.z, { roomId }),
          requiresOpen,
        };
      });
    }
  }

  _doorIsClosed(door) {
    if (typeof this.world.get !== 'function' || !doorKeyOf(door)) return false;
    const span = Number(door.span) || 1;
    for (let i = 0; i < span; i++) {
      const x = door.through === 'z' ? Number(door.x) + i : Number(door.x);
      const z = door.through === 'x' ? Number(door.z) + i : Number(door.z);
      if (this.world.get(x, Number(door.y), z) === BLOCK.DOOR) return true;
    }
    return false;
  }
}

export function buildNavigationIndex(world, level, options = {}) {
  return new NavigationIndex(world, level, options);
}

export default NavigationIndex;
