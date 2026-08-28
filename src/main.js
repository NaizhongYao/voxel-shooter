import * as THREE from 'three';
import { RENDER, LIGHT, PLAYER, WORLD, PALETTE, GRENADE, GRENADES, grenadeInventory } from './config.js';
import {
  DIFFICULTIES, DIFFICULTY_ORDER, resolveDifficulty, setDifficulty, D,
} from './difficulty.js';
import { LEVELS, getLevel, countEnemies } from './level/index.js';
import { DoorManager } from './systems/doors.js';
import { placeItems } from './level/furniture.js';
import { renderFloorplanSvg, roomLabelList } from './level/floorplan-svg.js';
import { VoxelMesher } from './voxel/mesher.js';
import { Player } from './player/player.js';
import { OrbitFollowCamera } from './player/camera.js';
import { Flashlight, FlashPool, EnemyFlashlights } from './systems/flashlight.js';
import { Input } from './systems/input.js';
import { Loadout, WEAPONS } from './systems/weapons.js';
import { Effects } from './systems/effects.js';
import { Enemy, setPlayerPosCache, STATE } from './systems/enemy.js';
import { Combat } from './systems/combat.js';
import { PickupManager } from './systems/pickups.js';
import { GrenadeSystem } from './systems/grenades.js';
import { Audio } from './systems/audio.js';
import { EnemyIndicators } from './systems/indicators.js';

const canvas = document.getElementById('game');
const $ = (id) => document.getElementById(id);

/**
 * 难度必须在创建玩家与敌人之前确定 —— 它决定血量上限、敌人 HP、感知参数。
 * 所以难度从 URL 读取，切换难度靠重载页面（?diff=expert）。
 *
 * 这比「运行时热切换」可靠得多：难度参数被 6 个模块在初始化时读取，
 * 中途改动会留下一半旧值一半新值的混合状态，那种 bug 极难排查。
 * 重载一次不到一秒，换来的是「难度在一局内绝对不变」这个强保证。
 */
setDifficulty(resolveDifficulty(location.search).id);

/**
 * 关卡从注册表取：?map=clinic 等。未知或锁定的关卡回落到第一关。
 * 关卡的一切（几何、门、房间、出生点、敌人池、拾取物）都从 LEVEL 取，
 * 不要单独 import 关卡文件的常量 —— 注册表是唯一入口。
 */
const LEVEL = (() => {
  const id = new URLSearchParams(location.search).get('map');
  const lv = getLevel(id);
  return lv.locked ? LEVELS[0] : lv;
})();

/** 当前关卡的玩家出生点。撤离判定与简报机位都用它（原 SPAWN 的注册表版）。 */
const SPAWN = LEVEL.spawn;

/**
 * 简报里预告过、但还没选中的难度。选卡只改 URL 和 UI（不重载），
 * 点「开始任务」时如果和当前实际难度不一样才重载进游戏——
 * 这样难度卡点击是即时的，游戏内数值又永远是自洽的一组。
 */
let pendingDiff = D().id;
const hud = {
  fps: $('fps'), pos: $('pos'), stance: $('stance'), light: $('light'),
  view: $('view'),
  hpFill: $('hp-fill'), hpText: $('hp-text'), hpBar: $('hp-bar'),
  armorFill: $('armor-fill'),
  nadeCount: $('nade-count'), nadeBox: $('nade-box'),
  lowhp: $('lowhp'),
  ammo: $('ammo'), ammoReserve: $('ammo-reserve'), weapon: $('weapon-name'),
  enemies: $('enemy-count'), crosshair: $('crosshair'),
  reload: $('reload'), reloadBar: $('reload-bar'),
  toast: $('toast'), damage: $('damage-flash'),
  dbgShots: $('dbg-shots'), dbgHits: $('dbg-hits'), dbgFire: $('dbg-fire'),
  dbgKeys: $('dbg-keys'),
  banner: $('banner'), bannerTitle: $('banner-title'), bannerBody: $('banner-body'),
  prompt: $('prompt'), stats: $('stats'), boot: $('boot'),
  brief: $('brief'), briefGo: $('brief-go'), briefPrev: $('brief-prev'),
  briefNext: $('brief-next'), briefDots: $('brief-dots'), diffs: $('diffs'),
  expose: $('expose'), exposeFill: $('expose-fill'),
  hint: $('hint'), hintCount: $('hint-count'),
  nadeKind: $('nade-kind'), flashWhite: $('flash-white'),
  missions: $('missions'), msGrid: $('ms-grid'), mapFull: $('map-full'),
};

// ── Renderer ───────────────────────────────────────────────────────────────
const renderer = new THREE.WebGLRenderer({
  canvas, antialias: false,
  powerPreference: 'high-performance',
  preserveDrawingBuffer: true,
});
renderer.setPixelRatio(Math.min(window.devicePixelRatio, RENDER.maxPixelRatio));
renderer.setSize(window.innerWidth, window.innerHeight);
renderer.shadowMap.enabled = true;
renderer.shadowMap.type = THREE.PCFShadowMap;
renderer.setClearColor(RENDER.clearColor);

const scene = new THREE.Scene();
scene.background = new THREE.Color(RENDER.clearColor);
scene.fog = new THREE.FogExp2(RENDER.clearColor, RENDER.fogDensity);
scene.add(new THREE.AmbientLight(0xffffff, LIGHT.ambientIndoor));
const shapeLight = new THREE.DirectionalLight(LIGHT.moonColor, 0.06);
shapeLight.position.set(-0.4, 1, 0.25);
scene.add(shapeLight);

// ── World ──────────────────────────────────────────────────────────────────
const world = LEVEL.build();
const mesher = new VoxelMesher(world);
const meshStats = mesher.buildAll();
scene.add(mesher.group);

// ── Actors & systems ───────────────────────────────────────────────────────
/**
 * 开发用出生点覆盖：?spawn=x,z（可选第三个值作为 y）。
 *
 * 关卡几何的问题（墙缝、卡位、门堵路）几乎都只在特定房间才看得见，
 * 每次都从庭院跑过去太慢。这个参数让「直接落在要检查的那面墙前」变成一件事。
 * 不带参数时行为完全不变，所以留在正式代码里没有副作用。
 */
function devSpawn() {
  const q = new URLSearchParams(location.search).get('spawn');
  if (!q) return LEVEL.spawn;
  const n = q.split(',').map(Number);
  if (n.length < 2 || n.some((v) => !Number.isFinite(v))) return LEVEL.spawn;
  return { x: n[0], y: n.length > 2 ? n[2] : LEVEL.spawn.y, z: n[1] };
}

const player = new Player(world, devSpawn());
scene.add(player.rig.root);
// 玩家的实体碰撞对象（敌人列表在下面创建后回填）
player.blockers = null;

const cam = new OrbitFollowCamera(world);
cam.resize(window.innerWidth, window.innerHeight);

const flashlight = new Flashlight(scene, world);
const flashPool = new FlashPool(scene);
/**
 * 瞬时光源（枪口焰 / 爆炸）不投阴影，所以必须靠视线检查防止穿墙。
 * 玩家看不见的闪光直接不点亮 —— 一次 DDA 射线远比一张立方体阴影贴图便宜。
 * 判定用相机位置而不是玩家脚底：第三人称相机可能在墙的另一侧。
 */
flashPool.setVisibilityProbe((x, y, z) => {
  const c = cam.cam.position;
  return !world.lineBlocked(c.x, c.y, c.z, x, y, z);
});
const effects = new Effects(scene, world);
const input = new Input(canvas);
function readLoadoutChoice() {
  try {
    const raw = JSON.parse(sessionStorage.getItem('loadoutChoice') || '{}');
    return {
      pistol: raw.pistol === 'pistolFast' ? 'pistolFast' : 'pistol',
      nade: raw.nade === 'he' ? 'he' : 'flash',
    };
  } catch {
    return { pistol: 'pistol', nade: 'flash' };
  }
}
function saveLoadoutChoice(choice) {
  sessionStorage.setItem('loadoutChoice', JSON.stringify(choice));
}
const loadoutChoice = readLoadoutChoice();
const loadout = new Loadout({ pistolId: loadoutChoice.pistol });

// 敌人数量按难度分层：简单 tier<=1，困难 tier<=2，专家全部。
// 简报里的「X 人」和这里用的是同一个 countEnemies —— 数字永远一致。
const activeSpawns = LEVEL.spawns.filter((s) => s.tier <= D().enemyTier);
const enemies = activeSpawns.map((s) => {
  const e = new Enemy(world, s);
  // 出生点脱困兜底：Enemy 构造函数只螺旋搜 3 vox，个别布置点可能救不出来。
  // 敌人卡在方块里 = 打不中、看不见、还占着胜利计数 —— 一出现就无法通关，
  // 所以这里扩大半径再救一次，绝不静默留下一个「不存在的敌人」。
  if (e.blockedAt(e.pos.x, e.pos.z) && !e.escapeIfStuck(12)) {
    console.error('[spawn] 敌人仍卡在几何里，请修正 spawns 数据:', s);
  }
  scene.add(e.rig.root);
  return e;
});
player.blockers = enemies;

// 自检：简报/难度卡承诺的人数必须等于实际生成的人数。
// 两处用的是同一个 countEnemies 过滤，理论上永远相等 —— 这个断言是
// 防止将来有人改了一处忘了另一处时，问题在开发阶段立刻暴露而不是留到玩家手里。
{
  const claimed = countEnemies(LEVEL.spawns, D().enemyTier);
  if (enemies.length !== claimed) {
    console.error(`[spawn] 承诺 ${claimed} 人，实际生成 ${enemies.length} 人 —— 必须一致！`);
  }
}

// 敌人手电：光源池按距离分配给最近的几个敌人（12 个真光源会拖死帧率）
const enemyLights = new EnemyFlashlights(scene);
// 头顶状态指示器：玩家判断「我被发现了吗」的唯一可靠信息源
const indicators = new EnemyIndicators(scene, enemies);

// 门：关闭时像墙一样挡光挡视线挡子弹（写进体素网格）
const doors = new DoorManager(scene, world, LEVEL.doors);
// 主入口默认敞开：玩家出生在庭院正对这两扇门，开局撞在关着的门上体验很差，
// 敞开的门同时也是「往这里走」的视觉引导。
doors.openAt(LEVEL.mainEntrance);
// 门改写了网格，需要重建一次几何
mesher.rebuildDirty();

const combat = new Combat(world, effects, flashPool, enemies);
const grenades = new GrenadeSystem(scene, world, effects, flashPool);
const audio = new Audio();
const pickups = new PickupManager(scene, world);
placeItems(pickups, [...LEVEL.medkits, ...LEVEL.weapons]);

// ── Game state ─────────────────────────────────────────────────────────────
const game = {
  totalEnemies: enemies.length,
  killed: 0,
  over: false,
  won: false,
  extractReady: false,
  startTime: performance.now() / 1000,
  endTime: 0,
  damageFlash: 0,
  toastUntil: 0,
  nades: grenadeInventory(loadoutChoice.nade, D().grenades),
  nadeKind: loadoutChoice.nade,
  playerFlash: 0,
  /** 玩家死亡后的镇头时间：让倒地动画播完再弹结算面板 */
  deathHold: 0,
  /**
   * 简报未关闭前不推进游戏逻辑。
   * 不这么做的话，玩家还在读简报，敌人已经在楼里巡逻了 ——
   * 甚至可能有巡逻者走到门口把玩家堵住。
   */
  started: false,
  /** 收尾阶段提示：剩最后 3 个敌人时亮出他们的位置（只提示一次） */
  revealed: false,
};

// ── 任务选择屏 ──────────────────────────────────────────────────────
/**
 * 卡片形式的选择屏：已解锁关卡有真平面图缩略图，锁定关卡显示灰卡
 * 和「情报不足 · 开发中」——未来地图的预告，而不是没有。
 * 第三格永远保留一个「未解密」占位，给以后的关卡留位置。
 */
let msIndex = 0;
const msCards = [];

function buildMissionCards() {
  const grid = hud.msGrid;
  if (!grid) return;
  grid.innerHTML = '';
  msCards.length = 0;
  const entries = [...LEVELS, { future: true, code: '03', name: '未解密', en: 'PROTOCOL ??' }];
  entries.forEach((lv, i) => {
    const el = document.createElement('div');
    el.className = 'ms-card' + (lv.locked ? ' locked' : '') + (lv.future ? ' future' : '');
    el.dataset.level = lv.id ?? '';
    el.dataset.index = i;
    const n = !lv.future && !lv.locked
      ? countEnemies(lv.spawns, DIFFICULTIES[DIFFICULTY_ORDER[0]].enemyTier)
      : 0;
    if (lv.future) {
      el.innerHTML = `
        <div class="ms-thumb empty"><span class="ms-q">?</span></div>
        <div class="ms-body">
          <div class="ms-name">${lv.code} ${lv.name}<em>${lv.en}</em></div>
          <div class="ms-meta">档案受损 · 战场形态未知</div>
          <div class="ms-action off">▓ 等待解密</div>
        </div>`;
    } else {
      let thumb = '';
      if (!lv.locked) {
        const { svg } = renderFloorplanSvg(lv.build(), {
          theme: 'dark', spawn: lv.spawn, doors: lv.doors,
          roomLabels: roomLabelList(lv.rooms, lv.roomLabels),
        });
        thumb = svg;
      } else {
        // 灰卡：真轮廓 + 灰化滤镜，人看一眼就知道「那栋楼存在」
        const { svg } = renderFloorplanSvg(lv.build(), {
          theme: 'dark', spawn: null, doors: lv.doors,
          roomLabels: roomLabelList(lv.rooms, lv.roomLabels),
        });
        thumb = svg;
      }
      el.innerHTML = `
        <div class="ms-thumb">${thumb}<span class="ms-q">${lv.locked ? '?' : ''}</span></div>
        <div class="ms-body">
          <div class="ms-name">${lv.code} ${lv.name}<em>${lv.en}</em></div>
          <div class="ms-meta">${lv.locked ? '情报不足 · 开发中' : `${n} 敌人 · ${lv.subtitle}`}</div>
          <div class="ms-action${lv.locked ? ' off' : ''}">${lv.locked ? '▓ 开发中' : '▶ 进入任务'}</div>
        </div>`;
    }
    if (!lv.future && !lv.locked) {
      el.addEventListener('click', () => openBrief());
    } else if (lv.locked) {
      el.addEventListener('click', () => {
        el.classList.add('shake');
        setTimeout(() => el.classList.remove('shake'), 420);
      });
    }
    grid.appendChild(el);
    msCards.push(el);
  });
  paintMsSelection();
}

function paintMsSelection() {
  msCards.forEach((el, i) => el.classList.toggle('sel', i === msIndex));
}

function moveMsSelection(dm) {
  const n = msCards.length;
  msIndex = (msIndex + dm + n) % n;
  paintMsSelection();
}

function openBrief() {
  hud.missions.style.display = 'none';
  hud.brief.style.display = 'flex';
  showBriefPage(0);
}

// ── 任务简报 + 难度选择 ────────────────────────────────────────────────
/**
 * 简报里唯一保留的敌人数：难度页的「敌人 X 人」与点击进入提示。
 * 任务目标卡不再显示数量 —— 难度是下一页才选的，第一页报数会前后矛盾。
 */
function refreshBriefCounts() {
  const diff = DIFFICULTIES[pendingDiff] ?? D();
  const n = countEnemies(LEVEL.spawns, diff.enemyTier);
  if (hud.hintCount) hud.hintCount.textContent = n;
}

/**
 * 难度卡片。点击就地切换（只改 URL 与视觉，不重载）……
 * 真正的游戏参数在「开始任务」时才以当前难度重载成型，
 * 所以 UI 上是即时的，游戏内数值永远是自洽的一组。
 */
function buildDifficultyCards() {
  hud.diffs.innerHTML = '';
  for (const id of DIFFICULTY_ORDER) {
    const d = DIFFICULTIES[id];
    const el = document.createElement('div');
    el.className = 'diff' + (d.id === pendingDiff ? ' on' : '');
    const hex = `#${d.color.toString(16).padStart(6, '0')}`;
    const hpPct = Math.round((d.hpMax / 120) * 100);
    const enemies = countEnemies(LEVEL.spawns, d.enemyTier);
    el.innerHTML =
      `<div class="dn" style="color:${hex}">${d.name}</div>` +
      `<div class="ds">${d.subtitle}</div>` +
      `<div class="dd">${d.desc}</div>` +
      `<div class="hpbar"><i style="width:${hpPct}%;background:${hex}"></i></div>` +
      `<div class="dstat">生命 ${d.hpMax} · 护甲 ${d.armorMax} · 手雷 ${d.grenades}` +
      `<br>敌人 ${enemies} 人 · ${d.enemyHp} HP · 视野 ×${d.visionRangeMul}` +
      ` · 指示器 ${d.indicatorRange} vox</div>`;
    el.addEventListener('click', () => {
      if (id === pendingDiff) return;
      pendingDiff = id;
      // 就地更新 URL（不重载），保留 spawn 等调试参数
      const q = new URLSearchParams(location.search);
      q.set('diff', id);
      history.replaceState(null, '', location.pathname + '?' + q.toString());
      buildDifficultyCards();
      refreshBriefCounts();
    });
    hud.diffs.appendChild(el);
  }
}
buildDifficultyCards();
refreshBriefCounts();

/**
 * 简报「地图」页：直接复用平面图共享渲染器，
 * 和 floorplan.html / 任务选择屏缩略图是同一套图。
 */
function drawMapPage() {
  const box = hud.mapFull;
  if (!box) return;
  const { svg } = renderFloorplanSvg(LEVEL.build(), {
    theme: 'dark',
    spawn: LEVEL.spawn,
    doors: LEVEL.doors,
    roomLabels: roomLabelList(LEVEL.rooms, LEVEL.roomLabels),
  });
  box.innerHTML = svg;
  const cap = document.getElementById('map-cap');
  if (cap) cap.textContent = `${LEVEL.name} · ${LEVEL.subtitle}。悬停房间看名字。`;
}
drawMapPage();

let briefPage = 0;
const BRIEF_PAGES = 4;
function showBriefPage(i) {
  briefPage = Math.max(0, Math.min(BRIEF_PAGES - 1, i));
  document.querySelectorAll('.bpage').forEach((el) => {
    el.classList.toggle('on', Number(el.dataset.page) === briefPage);
  });
  if (hud.briefDots) {
    [...hud.briefDots.children].forEach((d, n) => d.classList.toggle('on', n === briefPage));
  }
  if (hud.briefPrev) hud.briefPrev.style.visibility = briefPage === 0 ? 'hidden' : 'visible';
  if (hud.briefNext) hud.briefNext.style.display = briefPage === BRIEF_PAGES - 1 ? 'none' : '';
  if (hud.briefGo) hud.briefGo.style.display = briefPage === BRIEF_PAGES - 1 ? '' : 'none';
}
showBriefPage(0);
hud.briefPrev?.addEventListener('click', () => showBriefPage(briefPage - 1));
hud.briefNext?.addEventListener('click', () => showBriefPage(briefPage + 1));

function markLoadoutCards() {
  document.querySelectorAll('[data-pistol]').forEach((el) => {
    el.classList.toggle('on', el.dataset.pistol === loadoutChoice.pistol);
  });
  document.querySelectorAll('[data-nade]').forEach((el) => {
    el.classList.toggle('on', el.dataset.nade === loadoutChoice.nade);
  });
}
markLoadoutCards();
document.querySelectorAll('[data-pistol]').forEach((el) => {
  el.addEventListener('click', () => {
    loadoutChoice.pistol = el.dataset.pistol;
    saveLoadoutChoice(loadoutChoice);
    markLoadoutCards();
  });
});
document.querySelectorAll('[data-nade]').forEach((el) => {
  el.addEventListener('click', () => {
    loadoutChoice.nade = el.dataset.nade;
    saveLoadoutChoice(loadoutChoice);
    markLoadoutCards();
  });
});

/**
 * 武器页的图形：方块风格的枪廓形 + 三段属性条（伤害/射速/噪音）。
 * 廓形只是为了「一眼看出是哪类枪」，精度不重要 — 和体素风格一致。
 */
const BAR_MAX = { damage: 90, rof: 12, noise: 44 };
const BAR_LBL = { damage: '伤害', rof: '射速', noise: '噪音' };
const GUN_ART = {
  pistol: (c) =>
    `<rect x="46" y="9" width="32" height="8" rx="1.5" fill="${c}"/>` +
    `<rect x="52" y="17" width="10" height="14" rx="1.5" fill="${c}"/>` +
    `<rect x="64" y="18" width="6" height="6" rx="1" fill="${c}"/>` +
    `<rect x="82" y="11" width="8" height="4" rx="1" fill="${c}"/>`,
  pistolFast: (c) =>
    `<rect x="52" y="9" width="28" height="8" rx="1.5" fill="${c}"/>` +
    `<rect x="58" y="17" width="9" height="13" rx="1.5" fill="${c}"/>` +
    `<rect x="36" y="11" width="12" height="4" rx="1" fill="${c}"/>` +
    `<rect x="84" y="11" width="6" height="4" rx="1" fill="${c}"/>`,
  smg: (c) =>
    `<rect x="6" y="6" width="10" height="7" rx="1" fill="${c}"/>` +
    `<rect x="14" y="8" width="48" height="10" rx="2" fill="${c}"/>` +
    `<rect x="60" y="10" width="24" height="6" rx="1.5" fill="${c}"/>` +
    `<rect x="20" y="18" width="9" height="14" rx="1.5" fill="${c}"/>` +
    `<rect x="34" y="18" width="14" height="8" rx="1" fill="${c}"/>`,
  ar: (c) =>
    `<rect x="2" y="6" width="10" height="14" rx="2" fill="${c}"/>` +
    `<rect x="10" y="9" width="50" height="9" rx="2" fill="${c}"/>` +
    `<rect x="60" y="11" width="26" height="6" rx="1.5" fill="${c}"/>` +
    `<rect x="18" y="18" width="9" height="16" rx="1.5" fill="${c}"/>` +
    `<rect x="32" y="18" width="12" height="9" rx="1" fill="${c}"/>` +
    `<rect x="72" y="9" width="6" height="6" rx="1" fill="${c}"/>`,
  shotgun: (c) =>
    `<rect x="2" y="8" width="8" height="12" rx="2" fill="${c}"/>` +
    `<rect x="8" y="10" width="66" height="8" rx="2" fill="${c}"/>` +
    `<rect x="74" y="12" width="26" height="5" rx="1.5" fill="${c}"/>` +
    `<rect x="28" y="18" width="10" height="12" rx="1.5" fill="${c}"/>` +
    `<rect x="52" y="18" width="8" height="8" rx="1" fill="${c}"/>`,
  dmr: (c) =>
    `<rect x="8" y="8" width="12" height="4" rx="1" fill="${c}"/>` +
    `<rect x="10" y="12" width="9" height="9" rx="1" fill="${c}"/>` +
    `<rect x="18" y="10" width="42" height="7" rx="2" fill="${c}"/>` +
    `<rect x="60" y="11" width="34" height="5" rx="1.5" fill="${c}"/>` +
    `<rect x="26" y="17" width="9" height="16" rx="1.5" fill="${c}"/>` +
    `<rect x="42" y="17" width="9" height="6" rx="1" fill="${c}"/>`,
};
const NADE_ART = {
  flash: (c) =>
    `<circle cx="46" cy="25" r="10" fill="#d8dee8"/>` +
    `<rect x="55" y="21" width="16" height="5" rx="2" fill="#8b93a3"/>` +
    `<path d="M30 8l4 6M64 6l-3 8M18 25h10M60 38l-4-6" stroke="#d8dee8" stroke-width="2" stroke-linecap="round"/>`,
  he: (c) =>
    `<circle cx="46" cy="25" r="10" fill="#4a5a3a"/>` +
    `<rect x="55" y="21" width="16" height="5" rx="2" fill="#8b93a3"/>` +
    `<path d="M42 19l4 4M50 24l-3 3" stroke="#8a9a6a" stroke-width="1.5" stroke-linecap="round"/>`,
};
function drawLoadoutVisuals() {
  // 注意：外层卡片也带 data-nade/data-pistol 属性，必须限定到图标格 .gun 上，
  // 否则 innerHTML 会把整张卡的标题和属性条一起覆盖掉。
  document.querySelectorAll('.gun[data-gun]').forEach((el) => {
    const id = el.dataset.gun;
    const w = WEAPONS[id];
    if (!w) return;
    const c = '#' + w.color.toString(16).padStart(6, '0');
    const art = GUN_ART[id] ?? GUN_ART.pistol;
    el.innerHTML = `<svg viewBox="0 0 120 40">${art(c)}</svg>`;
    const bars = document.querySelector(`[data-bars="${id}"]`);
    if (bars) {
      const val = (m) => m === 'damage'
        ? Math.min(BAR_MAX[m], w.damage * (w.pellets ?? 1))
        : m === 'rof' ? w.rof : w.noise;
      bars.innerHTML = Object.keys(BAR_MAX).map((m) =>
        `<span class="bar"><b>${BAR_LBL[m]}</b><i style="width:${Math.round(val(m) / BAR_MAX[m] * 100)}%"></i></span>`
      ).join('');
    }
  });
  document.querySelectorAll('.gun[data-nade]').forEach((el) => {
    const id = el.dataset.nade;
    el.innerHTML = `<svg viewBox="0 0 120 40">${NADE_ART[id]?.(id)}</svg>`;
  });
}
drawLoadoutVisuals();

/** 简报标题 / 目标文案跟着所选关卡走 */
function fillBriefTexts() {
  const sub = document.getElementById('brief-sub');
  if (sub) sub.textContent = `${LEVEL.en} — ${LEVEL.subtitle}`;
  const cap = document.getElementById('goal-cap');
  if (cap) cap.textContent = LEVEL.blurb;
}
fillBriefTexts();

function startMission() {
  if (game.started) return;
  // 玩家在简报里换了难度（原地切换没重载）——现在才真正重载。
  // 难度参数必须在创建玩家与敌人之前确定，运行时热切换会留下
  // 一半旧值一半新值的混合状态，所以这里 reload，而不是就地改 D()。
  if (pendingDiff !== D().id) {
    const q = new URLSearchParams(location.search);
    q.set('diff', pendingDiff);
    location.href = location.pathname + '?' + q.toString();
    return;
  }
  loadout.setPistol(loadoutChoice.pistol);
  game.nadeKind = loadoutChoice.nade;
  game.nades = grenadeInventory(game.nadeKind, D().grenades);
  game.started = true;
  hud.brief.style.display = 'none';
  syncVitalsHud();
  // 简报是用户手势，正好在这里创建 AudioContext（浏览器要求手势触发）
  audio.init();
  canvas.requestPointerLock?.();
}
hud.briefGo.addEventListener('click', startMission);
window.addEventListener('keydown', (e) => {
  if (game.started) return;

  // 任务选择屏：方向键选档案，Enter 进入简报
  if (hud.missions && hud.missions.style.display !== 'none') {
    if (e.code === 'ArrowRight' || e.code === 'ArrowLeft') {
      e.preventDefault();
      moveMsSelection(e.code === 'ArrowRight' ? 1 : -1);
    } else if (e.code === 'Enter' || e.code === 'Space') {
      e.preventDefault();
      openBrief();
    }
    return;
  }

  if (e.code === 'Enter' || e.code === 'Space') {
    e.preventDefault();
    if (briefPage < BRIEF_PAGES - 1) showBriefPage(briefPage + 1);
    else startMission();
  }
  if (e.code === 'ArrowRight') showBriefPage(briefPage + 1);
  if (e.code === 'ArrowLeft') showBriefPage(briefPage - 1);
});

/**
 * 死亡后按 R 重开会跳过简报 —— 同一局内反复看同一份情报是噪声。
 * 想重看（或换难度）按 B，那条路径会清掉这个标记。
 * 用 sessionStorage 而不是 URL 参数：它不该出现在可分享的链接里。
 */
if (sessionStorage.getItem('skipBrief') === '1') {
  sessionStorage.removeItem('skipBrief');
  startMission();
}

// 选择屏渲染顺序：先建卡片，再定初始选中项（已解锁关卡）
buildMissionCards();
msIndex = Math.max(0, msCards.findIndex((c) => c.dataset.level === LEVEL.id));
paintMsSelection();

/**
 * 撤离点：12/12 后在出生点亮起绿色方块。
 *
 * transparent:true 是必需的 —— 帧循环里靠改 opacity 做呼吸闪烁，
 * 而 three.js 的 opacity 只在 transparent 为真时才参与渲染。
 * 少了这一行，闪烁完全不显示，玩家看到的是一个死的绿方块，
 * 分不清「这是撤离点」还是「这是个装饰」。
 */
const extractMesh = new THREE.Mesh(
  new THREE.BoxGeometry(1.6, 0.12, 1.6),
  new THREE.MeshBasicMaterial({
    color: PALETTE.good, transparent: true, opacity: 0.9,
  })
);
extractMesh.position.set(SPAWN.x, SPAWN.y + 0.07, SPAWN.z);
extractMesh.visible = false;
scene.add(extractMesh);

function toast(msg, ms = 1800) {
  hud.toast.textContent = msg;
  hud.toast.style.opacity = '1';
  game.toastUntil = performance.now() / 1000 + ms / 1000;
}

combat.onPlayerHit = (dmg, zone) => {
  if (game.over || player.dead) return;
  const r = player.applyDamage(dmg);
  // 打在护甲上 vs 打在肉上，声音不同 —— 玩家不看血条也知道护甲破没破
  audio.hurt(r.armorLost > 0 && r.hpLost === 0);
  game.damageFlash = 1;
  cam.kick(0.4);
  // 受击：准星大幅扩散（无无敌帧，被打中基本还不了手）
  player.hitStun = 0.3;
  if (r.died) killPlayer();
};

/**
 * 玩家死亡：先倒地，再弹结算。
 *
 * 原来是 hp<=0 立刻 endGame()，结算面板瞬间盖住画面 —— 玩家根本不知道
 * 自己是怎么死的、从哪个方向被打的。现在留 1.6 秒：角色倒下、相机跟着沉，
 * 死亡音效走完，然后才是面板。
 */
function killPlayer() {
  if (player.rig.deathAmt > 0) return;
  player.dead = true;
  player.rig.startDeath(0, 1);
  audio.death();
  game.deathHold = 1.6;
  document.exitPointerLock?.();
}

combat.onKill = (enemy) => {
  game.killed++;
  audio.kill();
  // 100% 掉落所持武器；30% 额外弹药
  pickups.dropWeapon(enemy.pos, enemy.weapon.spec.id,
    enemy.weapon.ammo, Math.floor(enemy.weapon.spec.reserve * 0.25) || 20);
  if (Math.random() < 0.3) pickups.dropAmmo(enemy.pos, 30);

  if (game.killed >= game.totalEnemies) {
    game.extractReady = true;
    extractMesh.visible = true;
    toast('全部目标已清除 · 返回庭院撤离', 4000);
  }
};

/**
 * 手雷爆炸的伤害结算。玩家和敌人走同一套规则：
 * 都按距离衰减、都需要视线、都会被墙挡住。
 */
// 敌人枪声：按距离衰减。远处的交火声是玩家判断「那边有人」的重要情报。
combat.onEnemyShot = (spec, dist) => audio.shoot(spec.sound ?? 'medium', dist);

grenades.onExplode = (pos, ownerIsPlayer, spec = GRENADE) => {
  const dist = Math.hypot(pos.x - player.pos.x, pos.z - player.pos.z);
  audio.explosion(dist);
  cam.kick(spec.shake * Math.max(0.2, 1 - dist / Math.max(1, spec.radius)));

  if (spec.id === 'flash') {
    const now = performance.now() / 1000;
    for (const e of enemies) {
      if (e.dead) continue;
      if (grenades.canBlind(pos, e.pos.x, e.pos.y + e.height * 0.5, e.pos.z, spec)) {
        e.blind(now, spec.blindSec);
      }
    }
    if (grenades.canBlind(pos, player.pos.x, player.pos.y + 1.0, player.pos.z, spec)) {
      game.playerFlash = 1;
    }
    combat.emitNoise(pos.x, pos.y, pos.z, spec.noise);
    return;
  }

  for (const e of enemies) {
    if (e.dead) continue;
    const d = grenades.damageAt(pos, e.pos.x, e.pos.y + e.height * 0.5, e.pos.z, spec);
    if (d <= 0) continue;
    _blastDir.set(e.pos.x - pos.x, 0, e.pos.z - pos.z).normalize();
    const killed = e.takeDamage(d, 'torso', _blastDir);
    if (killed) {
      combat.stats.kills++;
      combat.markBlood(e.pos);
      combat.onKill?.(e);
    }
  }

  if (!player.dead) {
    const selfD = grenades.damageAt(
      pos, player.pos.x, player.pos.y + 1.0, player.pos.z, spec
    );
    if (selfD > 0) {
      const r = player.applyDamage(Math.round(selfD * spec.selfDamageMul));
      game.damageFlash = 1;
      audio.hurt(r.armorLost > 0 && r.hpLost === 0);
      if (r.died) killPlayer();
    }
  }

  combat.emitNoise(pos.x, pos.y, pos.z, spec.noise);
};

function endGame(won) {
  if (game.over) return;
  game.over = true;
  game.won = won;
  game.endTime = performance.now() / 1000;
  const secs = Math.round(game.endTime - game.startTime);
  const mins = Math.floor(secs / 60);
  const acc = combat.accuracy;

  /**
   * 评级：剩余有效血量（生命+护甲，归一到 100 分制）+ 命中率×50
   *      + max(0, 20−用时分钟)×2
   * 血量上限从 120 改成 100+200=300 之后必须归一化，否则满血通关直接爆表。
   */
  const hpScore = (player.totalHp / player.totalHpMax) * 100;
  const score = hpScore + acc * 50 + Math.max(0, 20 - secs / 60) * 2;
  const grade = score >= 120 ? 'S' : score >= 98 ? 'A' : score >= 72 ? 'B' : 'C';

  // 难度写进结算：S 评级在简单难度和专家难度显然不是一回事
  hud.bannerTitle.textContent = won ? '任务完成' : '你已阵亡';
  hud.bannerTitle.className = won ? 'win' : 'lose';
  const diffTag = `<b style="color:#${D().color.toString(16)}">${D().name}</b>`;
  hud.bannerBody.innerHTML = won
    ? `难度 ${diffTag} · 用时 <b>${mins}:${String(secs % 60).padStart(2, '0')}</b><br>` +
      `命中率 <b>${(acc * 100).toFixed(0)}%</b> · ` +
      `爆头 <b>${combat.stats.headshots}</b> · ` +
      `剩余 <b>${player.hp} HP</b> / 护甲 <b>${player.armor}</b>` +
      `<br>评级 <b class="grade">${grade}</b>` +
      `<br><span class="hint-key">按 R 重开 · 按 B 回到简报换难度</span>`
    : `难度 ${diffTag} · 已清除 <b>${game.killed}/${game.totalEnemies}</b> 个目标<br>` +
      `命中率 <b>${(acc * 100).toFixed(0)}%</b><br>` +
      `<span class="hint-key">按 R 整关重启 · 按 B 回到简报换难度</span>`;
  hud.banner.style.display = 'flex';
  document.exitPointerLock?.();
}

// ── Resize ─────────────────────────────────────────────────────────────────
window.addEventListener('resize', () => {
  renderer.setSize(window.innerWidth, window.innerHeight);
  renderer.setPixelRatio(Math.min(window.devicePixelRatio, RENDER.maxPixelRatio));
  cam.resize(window.innerWidth, window.innerHeight);
});

// ── Loop ───────────────────────────────────────────────────────────────────
let last = performance.now();
let fpsAccum = 0, fpsFrames = 0;
let nearWeapon = null;
let fireDebug = '–';
const _camDir = new THREE.Vector3();
const _blastDir = new THREE.Vector3();
player.hitStun = 0;

function frame(nowMs) {
  const dt = Math.min(0.05, (nowMs - last) / 1000);
  last = nowMs;
  const now = nowMs / 1000;

  /**
   * 简报阶段：只渲染，不推进任何游戏逻辑。
   * 玩家还在读简报时敌人不应该已经在巡逻 —— 那会导致读完简报一进游戏
   * 就发现有人堵在门口，而玩家完全不知道发生过什么。
   */
  if (!game.started) {
    // 相机摆一个能看到建筑南面的机位，让简报背后有画面而不是黑屏
    cam.update(dt, {
      x: SPAWN.x, z: SPAWN.z + 2,
      feetY: SPAWN.y, height: PLAYER.height, leanAmt: 0,
    });
    const mz = player.muzzle();
    cam.cam.getWorldDirection(_camDir);
    flashlight.update(mz.pos, _camDir);
    renderer.render(scene, cam.cam);
    game.startTime = now;           // 计时从真正开始的那一刻算
    last = nowMs;
    requestAnimationFrame(frame);
    return;
  }

  // 死亡镇头：倒地动画播完再弹结算面板（玩家需要看到自己是怎么死的）
  if (game.deathHold > 0) {
    game.deathHold -= dt;
    player.rig.updateDeath(dt);
    // 相机跟着视点下沉，强化「视野倒下去」的感觉
    cam.update(dt, {
      x: player.pos.x, z: player.pos.z,
      feetY: player.pos.y,
      height: PLAYER.height * (1 - player.rig.deathAmt * 0.72),
      leanAmt: 0,
    });
    for (const e of enemies) e.rig.updateDeath(dt);
    effects.update(dt);
    flashPool.update(dt);
    grenades.update(dt);
    renderer.render(scene, cam.cam);
    if (game.deathHold <= 0) endGame(false);
    input.endFrame();
    requestAnimationFrame(frame);
    return;
  }

  if (!game.over) {
    cam.addMouse(input.mouseDX, input.mouseDY);
    cam.aiming = input.buttons.has(2);

    // AudioContext 必须由用户手势创建，否则浏览器会把它挂成静音
    if (input.locked || input.buttons.size > 0) audio.init();

    if (input.justPressed('mute')) {
      const on = audio.toggle();
      toast(on ? '音效已开' : '音效已关', 900);
    }
    if (input.justPressed('music')) {
      const on = audio.toggleMusic();
      toast(on ? '背景音乐已开' : '背景音乐已关', 900);
    }

    if (input.justPressed('flashlight')) {
      const on = flashlight.toggle();
      hud.light.textContent = on ? 'ON' : 'OFF';
      hud.light.className = on ? 'v on' : 'v off';
    }
    // C 键切换第一/第三人称
    if (input.justPressed('toggleView')) {
      const fp = cam.toggleView();
      player.rig.setFirstPerson(fp);
      hud.view.textContent = fp ? '1ST' : '3RD';
      toast(fp ? '第一人称' : '第三人称', 1000);
    }
    if (input.justPressed('debug')) {
      hud.stats.style.display = hud.stats.style.display === 'none' ? '' : 'none';
    }

    // 武器切换
    if (input.pressed.has('Digit1')) loadout.switchTo(0, now);
    if (input.pressed.has('Digit2')) loadout.switchTo(1, now);
    if (input.wheel !== 0) loadout.toggle(now);

    // ── 手雷（3 键）──
    if (input.justPressed('grenade')) {
      if (game.nades > 0) {
        game.nades--;
        cam.cam.getWorldDirection(_camDir);
        const eye = new THREE.Vector3(
          player.pos.x, player.pos.y + PLAYER.eyeHeight, player.pos.z
        ).addScaledVector(_camDir, 0.5);
        grenades.throwFrom(eye, _camDir, true, game.nadeKind);
        audio.grenadeThrow();
        syncVitalsHud();          // 手雷计数立刻更新，不等 0.35 秒采样
        toast(`${GRENADES[game.nadeKind]?.label ?? '手雷'} ×${game.nades}`, 900);
      } else {
        toast('没有手雷了', 900);
      }
    }

    player.update(dt, input, cam);
    setPlayerPosCache(player.pos);
    if (player.hitStun > 0) player.hitStun -= dt;
    // 脚步：按累积移动距离触发，慢走/蹲行会更轻更稀
    audio.updateFootsteps(player.pos, player.stance, player.body.onGround);

    cam.update(dt, {
      x: player.pos.x, z: player.pos.z,
      feetY: player.pos.y, height: player.body.height,
      leanAmt: player.leanAmt,
    });

    // 枪灯跟随视角
    const { pos } = player.muzzle();
    cam.cam.getWorldDirection(_camDir);
    flashlight.update(pos, _camDir);

    // ── 射击 ──
    loadout.update(now, dt);
    const weapon = loadout.current;
    const canAct = !loadout.switching && player.hitStun <= 0;

    if (weapon && canAct) {
      // 全自动按住连发；半自动必须逐次点击
      const wantFire = weapon.spec.auto ? input.buttons.has(0) : input.justClicked(0);
      if (wantFire) {
        const ok = combat.playerShoot(player, cam, weapon, now);
        if (ok) audio.shoot(weapon.spec.sound ?? 'medium', 0);
        // 开不出枪时把原因写到 HUD，便于定位（阻挡 / 冷却 / 换弹 / 空仓）
        fireDebug = ok ? 'FIRED'
          : weapon.reloading ? 'RELOADING'
          : weapon.isEmpty ? 'EMPTY'
          : player.aimSolution(cam).blocked ? 'BLOCKED'
          : 'COOLDOWN';
      }
      const wasReloading = weapon.reloading;
      if (input.pressed.has('KeyR')) weapon.startReload(now);
      if (weapon.isEmpty && weapon.canReload) weapon.startReload(now);
      if (!wasReloading && weapon.reloading) audio.reload();
    } else if (input.buttons.has(0) || input.justClicked(0)) {
      fireDebug = loadout.switching ? 'SWITCHING' : 'STUNNED';
    }

    // ── 敌人 ──
    const ctx = { player, flashlight, combat, enemies };
    for (const e of enemies) e.update(dt, now, ctx);
    // 实体碰撞：敌人之间、敌人与玩家都不能重叠
    for (const e of enemies) {
      if (!e.dead) e.resolveOverlap(enemies, player);
    }
    // 敌人手电：光源池按距离分配给最近的几个（远处的灯玩家看不清，不值一个光源）
    enemyLights.update(enemies, player.pos, now);
    // 头顶状态指示器：用相机位置做距离裁剪（第三人称下相机才是"眼睛"）。
    // 只剩最后 3 个敌人时无视距离与平静隐藏、全部亮标 —— 保证胜利条件永远可达。
    indicators.update(cam.cam.position, now, dt, game.totalEnemies - game.killed <= 3);

    // ── 门 ──
    // E 键开关最近的门。门在体素网格里是实心方块，开关会改动网格，
    // 所以下面统一调用 mesher.rebuildDirty() 重建受影响的区块。
    const nearDoor = doors.nearest(
      player.pos.x, player.pos.y + 1, player.pos.z, 2.2
    );
    if (nearDoor && input.pressed.has('KeyX')) {
      /**
       * 关门前检查门洞里有没有人。站在门洞里关门会把实心方块写在自己
       * 身上，碰撞盒被完全包住，玩家彻底卡死在墙里只能重开 —— 而这是
       * 一个玩家几乎必然会做一次的操作（走到门口顺手按 E）。
       */
      const actors = [
        { pos: player.pos, height: player.body.height, radius: PLAYER.width / 2 },
        ...enemies,
      ];
      if (!nearDoor.open || !nearDoor.blockedByActor(actors)) {
        const opened = nearDoor.toggle();
        audio.door(opened);
        toast(opened ? '门已打开' : '门已关闭', 900);
      } else {
        toast('门口有人，关不上', 900);
      }
    }
    doors.update(dt);

    // ── 手雷 ──
    grenades.update(dt);

    // ── 拾取 ──
    nearWeapon = pickups.update(dt, player, loadout, now, (msg) => {
      audio.pickup();
      toast(msg);
    });
    if (nearWeapon && input.pressed.has('KeyG')) {
      const spec = pickups.takeWeapon(nearWeapon, loadout, player, now);
      if (spec) toast(`拾取 ${spec.name}`);
      nearWeapon = null;
    }
    hud.prompt.style.display = nearWeapon ? 'block' : 'none';
    if (nearWeapon) {
      hud.prompt.innerHTML =
        `<b>G</b> 拾取 ${WEAPONS[nearWeapon.payload.weapon]?.name ?? '武器'}`;
    }

    // ── 撤离判定 ──
    if (game.extractReady) {
      const d = Math.hypot(player.pos.x - SPAWN.x, player.pos.z - SPAWN.z);
      if (d < 1.6) endGame(true);
      extractMesh.material.opacity = 0.6 + Math.sin(now * 4) * 0.35;
    }
  } else if (input.pressed.has('KeyR')) {
    // 同难度立刻重开：跳过简报（已经读过一遍了，再看一遍是噪声）
    sessionStorage.setItem('skipBrief', '1');
    location.reload();
  } else if (input.pressed.has('KeyB')) {
    // 回到简报：重新读情报或换难度
    sessionStorage.removeItem('skipBrief');
    location.reload();
  }

  effects.update(dt);
  flashPool.update(dt);
  mesher.rebuildDirty();

  // 准星阻挡提示
  const aim = player.aimSolution(cam);
  hud.crosshair.classList.toggle('blocked', aim.blocked);
  // 受击 / 移动导致的准星扩散
  const spreadPx = 8 + (loadout.current
    ? loadout.current.currentSpread(player.spreadMultiplier) * 1.6 : 0)
    + (player.hitStun > 0 ? 26 : 0);
  hud.crosshair.style.setProperty('--gap', `${spreadPx.toFixed(1)}px`);

  renderer.render(scene, cam.cam);

  // ── HUD ──
  if (game.damageFlash > 0) {
    game.damageFlash = Math.max(0, game.damageFlash - dt * 2.6);
    hud.damage.style.opacity = String(game.damageFlash * 0.55);
  }
  if (hud.flashWhite) {
    if (game.playerFlash > 0) {
      game.playerFlash = Math.max(0, game.playerFlash - dt / 1.2);
      hud.flashWhite.style.opacity = String(game.playerFlash);
    } else {
      hud.flashWhite.style.opacity = '0';
    }
  }

  /**
   * 低血警告：生命（不含护甲）低于阈值时屏幕边缘持续红色脉冲。
   * 强度随血量越低越强，所以「有多危险」是可读的，不是一个开关。
   */
  if (!player.dead && player.lowHp) {
    const severity = 1 - (player.hp / player.hpMax) / PLAYER.lowHpFraction;
    hud.lowhp.style.opacity = String(0.3 + severity * 0.55);
  } else {
    hud.lowhp.style.opacity = '0';
  }

  /**
   * 暴露度条：场上最高的警戒度。
   *
   * 这是「关手电降低 alert」的即时反馈 —— 玩家按 F 关灯，能立刻看到
   * 这根条在往下掉。没有这个反馈，机制存在但玩家学不到。
   */
  const exposure = indicators.maxAlert;
  hud.expose.style.opacity = exposure > 0.03 ? '1' : '0';
  hud.exposeFill.style.width = `${(exposure * 100).toFixed(0)}%`;
  hud.exposeFill.style.backgroundColor =
    exposure > 0.85 ? '#e5484d' : exposure > 0.4 ? '#f5a623' : '#f5d76e';
  if (game.toastUntil > 0 && now > game.toastUntil) {
    hud.toast.style.opacity = '0';
    game.toastUntil = 0;
  }

  const w = loadout.current;
  if (w) {
    hud.ammo.textContent = String(w.ammo);
    hud.ammoReserve.textContent = w.reserve === Infinity ? '∞' : String(w.reserve);
    hud.weapon.textContent = w.spec.short;
    hud.weapon.style.color = `#${w.spec.color.toString(16).padStart(6, '0')}`;
    player.rig.setGun(w.spec.id);
    if (w.reloading) {
      hud.reload.style.display = 'block';
      hud.reloadBar.style.width = `${(w.reloadProgress(now) * 100).toFixed(0)}%`;
    } else {
      hud.reload.style.display = 'none';
    }
  }
  const alive = enemies.filter((e) => !e.dead).length;
  hud.enemies.textContent = `${alive} / ${game.totalEnemies}`;
  // 收尾提示（一次）：剩下的敌人全图亮标，玩家不会再找不到人、无法通关
  if (!game.revealed && alive > 0 && alive <= 3) {
    game.revealed = true;
    toast('剩余目标已暴露 · 肃清他们', 2600);
  }
  hud.dbgShots.textContent = String(combat.stats.shots);
  hud.dbgHits.textContent = String(combat.stats.hits);
  hud.dbgFire.textContent = fireDebug;
  hud.dbgKeys.textContent = String(input.keyEventCount);

  fpsAccum += dt; fpsFrames++;
  if (fpsAccum >= 0.35) {
    hud.fps.textContent = String(Math.round(fpsFrames / fpsAccum));
    fpsAccum = 0; fpsFrames = 0;
    hud.pos.textContent =
      `${player.pos.x.toFixed(1)} ${player.pos.y.toFixed(1)} ${player.pos.z.toFixed(1)}`;
    hud.stance.textContent =
      player.stance === 'crouch' ? 'CROUCH' : player.stance === 'slow' ? 'SLOW' : 'NORMAL';
    // 上限读 player 实例而不是 PLAYER 常量 —— 上限由难度决定
    syncVitalsHud();
  }

  input.endFrame();
  requestAnimationFrame(frame);
}

hud.boot.innerHTML =
  `难度 ${D().name} · 世界 ${WORLD.SX}×${WORLD.SY}×${WORLD.SZ}<br>` +
  `可见面 ${meshStats.faces.toLocaleString()} · ` +
  `draw ${meshStats.draws} · 敌人 ${enemies.length}`;

/**
 * 立刻把 HUD 刷成真实数值。
 *
 * 血量/护甲/手雷的初始文本写在 index.html 里（100/200/3），但上限由难度
 * 决定 —— 简单难度是 120/240/4。这些文本只在帧循环的 0.35 秒采样块里更新，
 * 而简报阶段那个块根本不会执行，于是玩家在简报界面看到的是错的数字。
 * 抽成函数在启动时先调一次，帧循环里继续复用同一份逻辑。
 */
function syncVitalsHud() {
  hud.hpFill.style.width = `${(player.hp / player.hpMax) * 100}%`;
  hud.armorFill.style.width = `${(player.armor / player.armorMax) * 100}%`;
  hud.hpText.innerHTML = player.armor > 0
    ? `${player.hp} / ${player.hpMax} · <b>护甲 ${player.armor}</b>`
    : `${player.hp} / ${player.hpMax} · 护甲已破`;
  hud.hpBar.classList.toggle('low', player.lowHp && !player.dead);
  hud.nadeCount.textContent = String(game.nades);
  hud.nadeBox.classList.toggle('empty', game.nades === 0);
  if (hud.nadeKind) hud.nadeKind.textContent = GRENADES[game.nadeKind]?.label ?? '手雷';
}
syncVitalsHud();

requestAnimationFrame(frame);

window.__game = {
  world, player, cam, flashlight, scene, renderer, mesher,
  enemies, combat, loadout, pickups, game, effects,
};
