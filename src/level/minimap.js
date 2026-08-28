/**
 * 战斗中的小地图：只画「大致的房间」。
 *
 * ══ 为什么不复用 floorplan-svg.js ══
 *
 * floorplan 直接读体素网格，于是每一件家具、每一格墙都会被画出来 ——
 * 那是开发者视图，信息量恰好是战斗中最不该给的。小地图换了数据源：
 * 它只吃关卡注册表里的房间矩形（`rooms`）、建筑范围（`building`）、
 * 门与出生点。家具和敌人根本不在这份数据里，所以「不泄露」不是靠
 * 记得别画，而是结构上画不出来 —— 以后有人往小地图加功能也漏不了。
 *
 * ══ 新地图要做什么 ══
 *
 * 什么都不用做。只要在 `level/index.js` 登记 `rooms` / `building` /
 * `spawn` / `doors` / `roomLabels`，小地图自动就有。房间名用 `roomLabels`，
 * 没登记的房间回落到 id，不会崩。
 *
 * ══ 坐标约定 ══
 *
 * viewBox 直接用世界坐标（vox），所以「世界 (x,z) → 图上位置」是恒等映射，
 * 不需要任何缩放换算。玩家箭头每帧只改 transform，开销可以忽略。
 * 上为北（−Z），与 floorplan.html 和任务简报地图一致。
 */

/** 房间矩形外扩一点，让相邻房间之间留出可见的墙缝 */
const ROOM_INSET = 0.35;

/**
 * 地图可视范围：房间 + 建筑 + 出生点（庭院）的并集，再留一圈边距。
 *
 * 不直接用固定的 64×64：那样每张图四周都会留一大片空白，
 * 小地图本来就只有一个角落那么大，浪费不起。
 */
function computeBounds(level, pad = 2.5) {
  let x0 = Infinity, x1 = -Infinity, z0 = Infinity, z1 = -Infinity;
  const eat = (ax0, az0, ax1, az1) => {
    if (ax0 < x0) x0 = ax0; if (ax1 > x1) x1 = ax1;
    if (az0 < z0) z0 = az0; if (az1 > z1) z1 = az1;
  };
  const b = level.building;
  if (b) eat(b.x0, b.z0, b.x1, b.z1);
  for (const r of Object.values(level.rooms ?? {})) eat(r.x0, r.z0, r.x1, r.z1);
  for (const d of level.doors ?? []) eat(d.x, d.z, d.x, d.z);
  const s = level.spawn;
  if (s) eat(Math.floor(s.x) - 1, Math.floor(s.z) - 1, Math.floor(s.x) + 1, Math.floor(s.z) + 1);
  if (!Number.isFinite(x0)) return { x0: 0, z0: 0, x1: 63, z1: 63 };
  return { x0: x0 - pad, z0: z0 - pad, x1: x1 + pad, z1: z1 + pad };
}

/** 玩家所在房间的 id（不在任何房间内时返回 null，例如站在庭院或走廊夹缝） */
export function roomAt(level, x, z) {
  for (const [id, r] of Object.entries(level.rooms ?? {})) {
    if (x >= r.x0 && x <= r.x1 + 1 && z >= r.z0 && z <= r.z1 + 1) return id;
  }
  return null;
}

/**
 * 渲染小地图 SVG（静态部分：房间、门、出生点 + 一个待定位的玩家箭头）。
 *
 * @param level 关卡注册表条目
 * @returns {{ svg: string, bounds: {x0,z0,x1,z1} }}
 */
export function renderMinimapSvg(level) {
  const b = computeBounds(level);
  const w = b.x1 - b.x0, h = b.z1 - b.z0;
  const labels = level.roomLabels ?? {};
  const parts = [];

  // 建筑底色：把「室内」和「室外庭院」区分开，玩家一眼知道自己在楼里还是在外面
  if (level.building) {
    const bd = level.building;
    parts.push(
      `<rect class="mm-bld" x="${bd.x0 - 2}" y="${bd.z0 - 2}" ` +
      `width="${bd.x1 - bd.x0 + 5}" height="${bd.z1 - bd.z0 + 5}"/>`
    );
  }

  /**
   * 房间块 + 房间名。房间是小地图唯一的「内容」——没有家具、没有敌人。
   *
   * ══ 探索状态 ══
   *
   * 所有房间初始都是 `.mm-room`（未探索：暗、无名字）。玩家走进去之后
   * main.js 给它加 `.seen`，房间才亮起来并显示名字。
   * 这样小地图从「一张全知平面图」变成「一张边走边画的地图」——
   * 玩家能一眼看出哪几间还没清过，收尾找人不再靠记忆。
   *
   * 房间名同样只在探索后显示（预先摆好名字等于泄露了楼里有什么）。
   */
  for (const [id, r] of Object.entries(level.rooms ?? {})) {
    const rw = r.x1 - r.x0 + 1 - ROOM_INSET * 2;
    const rh = r.z1 - r.z0 + 1 - ROOM_INSET * 2;
    parts.push(
      `<rect class="mm-room" data-room="${id}" x="${(r.x0 + ROOM_INSET).toFixed(2)}" ` +
      `y="${(r.z0 + ROOM_INSET).toFixed(2)}" width="${rw.toFixed(2)}" height="${rh.toFixed(2)}"/>`
    );
    const cx = (r.x0 + r.x1 + 1) / 2, cz = (r.z0 + r.z1 + 1) / 2;
    // 窄房间放不下横排文字就不放 —— 宁可少一个名字，也不要糊成一团
    if (rw >= 5 && rh >= 3.2) {
      parts.push(
        `<text class="mm-label" data-label="${id}" x="${cx.toFixed(2)}" ` +
        `y="${(cz + 0.9).toFixed(2)}">${labels[id] ?? id}</text>`
      );
    }
  }

  // 门：只画一个小方点，用来认出「这里能过人」。它是结构信息，不是敌情。
  for (const d of level.doors ?? []) {
    parts.push(`<rect class="mm-door" x="${d.x + 0.15}" y="${d.z + 0.15}" width="0.7" height="0.7"/>`);
  }

  // 出生点 = 撤离点，全程都该看得见「往哪走能出去」
  if (level.spawn) {
    const s = level.spawn;
    parts.push(`<circle class="mm-exit" cx="${s.x.toFixed(2)}" cy="${s.z.toFixed(2)}" r="1.5"/>`);
    parts.push(`<text class="mm-exit-t" x="${s.x.toFixed(2)}" y="${(s.z + 0.75).toFixed(2)}">E</text>`);
  }

  // 玩家箭头：位置与朝向每帧由 main.js 改 transform。上为北，yaw=0 指向正上。
  parts.push(
    '<g class="mm-player"><path d="M0,-2.1 L1.5,1.9 L0,1.05 L-1.5,1.9 Z"/></g>'
  );

  return {
    svg: `<svg class="mm-svg" viewBox="${b.x0.toFixed(2)} ${b.z0.toFixed(2)} ${w.toFixed(2)} ${h.toFixed(2)}" ` +
      `preserveAspectRatio="xMidYMid meet" xmlns="http://www.w3.org/2000/svg">${parts.join('')}</svg>`,
    bounds: b,
  };
}
