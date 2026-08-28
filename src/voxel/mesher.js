import * as THREE from 'three';
import { WORLD, RENDER, LIGHT, PALETTE } from '../config.js';
import { BLOCK, BLOCKS, isOpaque, topOf } from './blocks.js';

/**
 * 体素网格 → three.js 几何体。
 *
 * 两个关键优化（GDD 09 章要求在 M1 就做）：
 *  1. 面剔除：被相邻不透光方块挡住的面不生成，可见面下降约 70%。
 *  2. 按区块合批：每个 chunk 一个 BufferGeometry，整关约个位数 draw call。
 *
 * 顶点色里同时烘焙了三样东西：方块基色、±4% 明度抖动、以及室外月光。
 * 这样室内环境光可以压到 0.03 而庭院仍然能看清轮廓，且不需要第二个光源。
 */

/**
 * 六个面的顶点定义。索引顺序是 (0,1,2) + (2,1,3)，见下方 idxArr。
 *
 * ══ 绕序必须与 dir 一致，否则那一面会被 GPU 背面剔除 ══
 *
 * 这里曾经有一个很难看出来的 bug：±x 和 ±z 四个侧面的绕序全是反的
 * （只有 ±y 是对的）。WebGL 默认剔除背面，判据是三角形在屏幕空间的绕向，
 * 所以这四个面从外部看全部消失 —— 表现出来就是：
 *   · 箱子只剩顶面和内壁（看进了盒子内部）
 *   · 墙看起来是半透明的（侧面朝外那层没渲染，直接看进墙体）
 * 而顶面/底面正常，所以现象很容易被误判成材质或光照问题。
 *
 * 校验方法（test/logic.test.mjs 里有对应用例）：
 *   cross(v1-v0, v2-v0) 必须与 dir 同向，cross(v1-v2, v3-v2) 同理。
 * 改动这张表之后务必跑那个测试。
 */
const FACES = [
  { dir: [ 1, 0, 0], corners: [[1,0,0],[1,1,0],[1,0,1],[1,1,1]], shade: 0.72 },
  { dir: [-1, 0, 0], corners: [[0,0,1],[0,1,1],[0,0,0],[0,1,0]], shade: 0.72 },
  { dir: [ 0, 1, 0], corners: [[0,1,1],[1,1,1],[0,1,0],[1,1,0]], shade: 1.00 },
  { dir: [ 0,-1, 0], corners: [[0,0,0],[1,0,0],[0,0,1],[1,0,1]], shade: 0.42 },
  { dir: [ 0, 0, 1], corners: [[1,0,1],[1,1,1],[0,0,1],[0,1,1]], shade: 0.86 },
  { dir: [ 0, 0,-1], corners: [[0,0,0],[0,1,0],[1,0,0],[1,1,0]], shade: 0.86 },
];

// 每个方块一份稳定的明度抖动，避免每帧变化产生闪烁
function hashJitter(x, y, z) {
  let h = (x * 73856093) ^ (y * 19349663) ^ (z * 83492791);
  h = (h ^ (h >>> 13)) * 1274126177;
  h = (h ^ (h >>> 16)) >>> 0;
  return (h / 0xffffffff) * 2 - 1;
}

const _c = new THREE.Color();
const _e = new THREE.Color();
const _moon = new THREE.Color(LIGHT.moonColor);

/** 导出给测试用：校验绕序与法线一致（见 test/logic.test.mjs 第 11 节） */
export const FACES_FOR_TEST = FACES;

/**
 * 方块材质：Lambert + 一个额外的「烘焙光」顶点属性。
 *
 * 为什么需要 patch：MeshLambertMaterial 的 vertexColor 是「反射率」，
 * 会被入射光乘掉。室内环境光只有 0.03，如果把月光写进 vertexColor，
 * 庭院会和室内一样黑。所以月光必须作为「自发光」加在光照结果之后。
 * 这样室内保持全黑、庭院可辨轮廓，而全场依然只有 1 个阴影光源。
 */
function makeVoxelMaterial() {
  const mat = new THREE.MeshLambertMaterial({ vertexColors: true });
  mat.onBeforeCompile = (shader) => {
    shader.vertexShader = shader.vertexShader
      .replace(
        '#include <common>',
        `#include <common>
         attribute vec3 baked;
         varying vec3 vBaked;`
      )
      .replace(
        '#include <begin_vertex>',
        `#include <begin_vertex>
         vBaked = baked;`
      );
    shader.fragmentShader = shader.fragmentShader
      .replace(
        '#include <common>',
        `#include <common>
         varying vec3 vBaked;`
      )
      .replace(
        '#include <dithering_fragment>',
        `gl_FragColor.rgb += vBaked;
         #include <dithering_fragment>`
      );
  };
  // 保证 patch 后的 shader 不与其他 Lambert 材质共用程序缓存
  mat.customProgramCacheKey = () => 'voxel-baked-v1';
  return mat;
}

export class VoxelMesher {
  constructor(world) {
    this.world = world;
    this.group = new THREE.Group();
    this.group.name = 'voxel-terrain';
    this.chunks = new Map();
    this.material = makeVoxelMaterial();
    this.stats = { faces: 0, chunks: 0, draws: 0 };
  }

  buildAll() {
    const { CHUNK } = WORLD;
    const nx = Math.ceil(this.world.sx / CHUNK);
    const nz = Math.ceil(this.world.sz / CHUNK);
    for (let cz = 0; cz < nz; cz++) {
      for (let cx = 0; cx < nx; cx++) this.buildChunk(cx, cz);
    }
    this.refreshStats();
    this.world.dirtyChunks.clear();
    return this.stats;
  }

  rebuildDirty() {
    if (this.world.dirtyChunks.size === 0) return;
    for (const key of this.world.dirtyChunks) {
      const [cx, cz] = key.split(',').map(Number);
      this.buildChunk(cx, cz);
    }
    this.world.dirtyChunks.clear();
    this.refreshStats();
  }

  /**
   * 从当前几何体重新统计面数。
   *
   * 原来 buildChunk 里是 `this.stats.faces++` 累加，而 rebuildDirty 不清零 ——
   * 开一次门就把那个区块的面数又加了一遍，HUD 上的「可见面」会一路涨上去。
   * 直接数几何体里的三角形是唯一不会说谎的做法。
   */
  refreshStats() {
    let faces = 0;
    for (const mesh of this.chunks.values()) {
      const idx = mesh.geometry.getIndex();
      if (idx) faces += idx.count / 6;      // 每个面 2 个三角形 = 6 个索引
    }
    this.stats.faces = faces;
    this.stats.chunks = this.chunks.size;
    this.stats.draws = this.chunks.size;
    return this.stats;
  }

  buildChunk(cx, cz) {
    const { CHUNK, BLOCK_INSET: INSET } = WORLD;
    const w = this.world;
    const x0 = cx * CHUNK, z0 = cz * CHUNK;
    const x1 = Math.min(x0 + CHUNK, w.sx), z1 = Math.min(z0 + CHUNK, w.sz);

    const pos = [], norm = [], col = [], baked = [], idxArr = [];
    let vCount = 0;

    for (let y = 0; y < w.sy; y++) {
      for (let z = z0; z < z1; z++) {
        for (let x = x0; x < x1; x++) {
          const id = w.get(x, y, z);
          if (id === BLOCK.AIR) continue;
          const spec = BLOCKS[id];
          if (!spec.render) continue;

          const h = topOf(id);
          const jitter = spec.jitter ? hashJitter(x, y, z) * RENDER.colorJitter : 0;

          // 室外方块把月光烘焙进顶点色 —— 庭院可辨轮廓，室内保持全黑
          const sky = w.skyExposed(x, y, z);
          const moonAmt = sky ? LIGHT.moonlight : 0;

          for (const face of FACES) {
            const [dx, dy, dz] = face.dir;
            /**
             * 面剔除：相邻格不透光且满高，则此面不可见。
             *
             * ══ 相邻格还必须真的会被渲染 ══
             *
             * BLOCK.DOOR 是 opaque:true / height:1 但 render:false —— 它负责
             * 挡视线挡子弹，几何却由 Door 类那两扇薄门板（0.14 厚）单独画。
             * 只看 isOpaque 的话，门洞四周的墙面全部被当成「被门挡住了」而
             * 剔掉，可门格自己又不画任何面，于是那里留下一圈没有内壁的空腔：
             * 从门的一侧看，视线擦过薄门板边缘直接穿进隔壁房间。
             * 「同一扇门一面正常、另一面透视」就是这么来的。
             *
             * 加上 canHide 之后，只有真正会画出实体面的方块才允许剔除邻面。
             */
            const canHide = (nid) =>
              nid !== BLOCK.AIR && isOpaque(nid) && BLOCKS[nid].render;
            if (h >= 1 && !(dy !== 0 && h < 1)) {
              const nid = w.get(x + dx, y + dy, z + dz);
              if (canHide(nid) && topOf(nid) >= 1) continue;
            } else if (dy === 0) {
              // 矮方块的侧面：只有相邻方块同样高或更高才剔除
              const nid = w.get(x + dx, y + dy, z + dz);
              if (canHide(nid) && topOf(nid) >= h) continue;
            } else if (dy === -1) {
              const nid = w.get(x, y - 1, z);
              if (canHide(nid) && topOf(nid) >= 1) continue;
            }

            // 反射率：基色 × 面明暗 × 每方块抖动
            _c.setHex(spec.color);
            _c.multiplyScalar(face.shade * (1 + jitter));

            // 烘焙月光：作为自发光加在光照之后，只影响室外方块。
            // 强度调到「能看清轮廓但看不清细节」——庭院是唯一有环境光的区域。
            let br = 0, bg = 0, bb = 0;
            if (moonAmt > 0) {
              const facing = dy > 0 ? 1 : dy < 0 ? 0.12 : 0.5;
              const k = moonAmt * facing * RENDER.moonBake;
              br = _moon.r * k * (0.35 + _c.r);
              bg = _moon.g * k * (0.35 + _c.g);
              bb = _moon.b * k * (0.35 + _c.b);
            }

            // 自发光方块（台灯）：把基色直接加进 baked 通道，
            // 这样它在全黑房间里也能被看到，但不需要真的新增光源。
            if (spec.emissive > 0) {
              _e.setHex(spec.color);
              br += _e.r * spec.emissive;
              bg += _e.g * spec.emissive;
              bb += _e.b * spec.emissive;
            }

            for (const c of face.corners) {
              const px = x + (c[0] === 0 ? INSET : 1 - INSET);
              const pz = z + (c[2] === 0 ? INSET : 1 - INSET);
              const py = y + (c[1] === 0 ? INSET * 0.5 : h - INSET * 0.5);
              pos.push(px, py, pz);
              norm.push(dx, dy, dz);
              col.push(_c.r, _c.g, _c.b);
              baked.push(br, bg, bb);
            }
            idxArr.push(vCount, vCount + 1, vCount + 2, vCount + 2, vCount + 1, vCount + 3);
            vCount += 4;
          }
        }
      }
    }

    const key = `${cx},${cz}`;
    const old = this.chunks.get(key);
    if (old) { this.group.remove(old); old.geometry.dispose(); }

    if (vCount === 0) { this.chunks.delete(key); return; }

    const geo = new THREE.BufferGeometry();
    geo.setAttribute('position', new THREE.Float32BufferAttribute(pos, 3));
    geo.setAttribute('normal', new THREE.Float32BufferAttribute(norm, 3));
    geo.setAttribute('color', new THREE.Float32BufferAttribute(col, 3));
    geo.setAttribute('baked', new THREE.Float32BufferAttribute(baked, 3));
    geo.setIndex(idxArr);
    geo.computeBoundingSphere();

    const mesh = new THREE.Mesh(geo, this.material);
    mesh.name = `chunk-${key}`;
    mesh.castShadow = true;
    mesh.receiveShadow = true;
    mesh.matrixAutoUpdate = false;
    mesh.updateMatrix();
    this.chunks.set(key, mesh);
    this.group.add(mesh);
  }
}
