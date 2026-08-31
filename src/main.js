import * as THREE from 'three';
import { RENDER, LIGHT, PLAYER, WORLD, PALETTE, GRENADE, INPUT, grenadeInventory } from './config.js';
import { D } from './difficulty.js';
import { LEVELS, getLevel, countEnemies } from './level/index.js';
import { DoorManager } from './systems/doors.js';
import { buildNavigationIndex } from './systems/navigation.js';
import { placeItems } from './level/furniture.js';
import { renderFloorplanSvg, roomLabelList } from './level/floorplan-svg.js';
import { renderMinimapSvg, roomAt } from './level/minimap.js';
import { VoxelMesher } from './voxel/mesher.js';
import { Player } from './player/player.js';
import { OrbitFollowCamera } from './player/camera.js';
import { Flashlight, FlashPool, EnemyFlashlights } from './systems/flashlight.js';
import { Input } from './systems/input.js';
import { Loadout, WEAPONS } from './systems/weapons.js';
import { Effects } from './systems/effects.js';
import { Enemy, setPlayerPosCache, STATE } from './systems/enemy.js';
import { loadoutManager } from './systems/loadout-manager.js';
import { initEquipmentUI, showEquipment, hideEquipment } from './ui/equipment.js';
import { gunGlyph, grenadeGlyph } from './ui/loadout-art.js';
import { Combat } from './systems/combat.js';
import { PickupManager } from './systems/pickups.js';
import { LootContainerManager } from './systems/loot-container.js';
import { OpenableFurnitureManager } from './systems/openable-furniture.js';
import { GrenadeSystem } from './systems/grenades.js';
import { Audio } from './systems/audio.js';
import { EnemyIndicators } from './systems/indicators.js';
import { EmergencyLights } from './systems/lights.js';
import { getSaveStore } from './systems/save-store.js';
import {
  seedQuickUseGrenade,
  syncLegacyGrenadeFromQuickUse,
  syncEquipmentFromLoadout,
  mirrorPrimaryFromLoadout,
  nextLootInstanceId,
  attemptGrenadeThrow,
  getQuickUseSelectedIndex,
  setQuickUseSelectedIndex,
  openContainerSession,
  closeContainerSession,
} from './systems/raid-inventory.js';
import { QuickWheel } from './ui/quick-wheel.js';
import { createRaidInventoryView } from './ui/raid-inventory.js';
import { initHubNav } from './ui/hub-nav.js';

const canvas = document.getElementById('game');
const $ = (id) => document.getElementById(id);

/**
 * ── Save Store ─────────────────────────────────────────────────────────────
 * 存档系统初始化：读取 localStorage 档案，处理 pendingRaid，恢复局外进度。
 * 
 * 必须在游戏启动最早期执行，因为装备整备、仓库、统计等都依赖档案数据。
 * init() 返回 { ok, profile, warning }：
 *   - ok=true: 档案正常加载或创建
 *   - warning: 如果有未完成任务（刷新/崩溃），会按放弃处理并提示
 *   - ok=false: 档案损坏，需要提示玩家重置
 */
const saveStore = getSaveStore();
const saveInitResult = saveStore.init();

if (!saveInitResult.ok) {
  // 档案损坏，显示错误并禁止继续
  console.error('[Main] Save file corrupted:', saveInitResult.error);
  alert(`存档文件损坏：${saveInitResult.error}\n\n请在控制台执行 localStorage.clear() 后刷新页面。`);
  // 暂时允许继续运行（会创建新档案），但已记录错误
}

if (saveInitResult.warning) {
  // 任务中异常退出警告（后续可在 UI 显示）
  console.warn('[Main] Save warning:', saveInitResult.warning);
}

/**
 * 难度是单一「标准」档（原三档已合并，见 BLUEPRINT-SYSTEM-FINAL-DECISION.md
 * §7.5）：参数固定在 difficulty.js 的 DIFFICULTY 表，模块加载即生效，
 * 不再从 URL 读取、也不提供玩家切换 —— 风险由固定敌人配置 + 装备/技巧
 * 对抗，这是局外成长（蓝图解锁装备）存在意义的前提。
 */

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
 * 任务选择屏里选中的关卡。简报阶段只改这个变量与 URL 显示，
 * 点「开始任务」时若与页面实际加载的 LEVEL 不一致，先带 ?map= 重载。
 * 运行时世界（world/门/敌人/拾取物）全部在模块初始化时按 LEVEL 建好，
 * 原地换关等于要重建一切 —— 重载一次反而最可靠。
 */
let pendingLevel = LEVEL;
const hud = {
  fps: $('fps'), pos: $('pos'), stance: $('stance'), light: $('light'),
  view: $('view'),
  hpFill: $('hp-fill'), hpText: $('hp-text'), hpBar: $('hp-bar'),
  armorFill: $('armor-fill'),
  nadeCount: $('nade-count'), nadeBox: $('nade-box'),
  carryBox: $('carry-box'), carryCurrent: $('carry-current'),
  carryMax: $('carry-max'), carryValue: $('carry-value'),
  lowhp: $('lowhp'),
  ammo: $('ammo'), ammoReserve: $('ammo-reserve'), weapon: $('weapon-name'),
  ammoSlotPistol: $('ammo-slot-pistol'),
  ammoSlot1: $('ammo-slot-1'), ammo1: $('ammo-1'), ammoReserve1: $('ammo-reserve-1'),
  weapon1: $('weapon-name-1'), reload1: $('reload-1'), reloadBar1: $('reload-bar-1'),
  ammoSlot2: $('ammo-slot-2'), ammo2: $('ammo-2'), ammoReserve2: $('ammo-reserve-2'),
  weapon2: $('weapon-name-2'), reload2: $('reload-2'), reloadBar2: $('reload-bar-2'),
  objective: $('objective'), objectiveLabel: $('objective-label'),
  enemies: $('enemy-count'), crosshair: $('crosshair'),
  reload: $('reload'), reloadBar: $('reload-bar'),
  weaponSwapChoice: $('weapon-swap-choice'), swapSlot1: $('swap-slot1'),
  swapSlot2: $('swap-slot2'), swapCancel: $('swap-cancel'),
  toast: $('toast'), damage: $('damage-flash'),
  dbgShots: $('dbg-shots'), dbgHits: $('dbg-hits'), dbgFire: $('dbg-fire'),
  dbgKeys: $('dbg-keys'),
  banner: $('banner'), bannerTitle: $('banner-title'), bannerBody: $('banner-body'),
  bannerLoot: $('banner-loot'),
  prompt: $('prompt'), stats: $('stats'), boot: $('boot'),
  brief: $('brief'), briefGo: $('brief-go'), briefPrev: $('brief-prev'),
  briefNext: $('brief-next'), briefDots: $('brief-dots'), diffs: $('diffs'),
  expose: $('expose'), exposeFill: $('expose-fill'),
  hint: $('hint'), hintCount: $('hint-count'),
  nadeKind: $('nade-kind'), flashWhite: $('flash-white'),
  missions: $('missions'), msGrid: $('ms-grid'), mapFull: $('map-full'),
  minimap: $('minimap'), mmBox: $('mm-box'), mmHere: $('mm-here'),
  equipment: $('equipment'),
  quickWheel: $('quick-wheel'),
  raidInventory: $('raid-inventory'),
};
// 调试面板（FPS/POS/SHOTS/HITS…）默认隐藏，反引号切换（见下方 input.justPressed('debug')）。
// 不在 HTML 里写死 display:none，是因为面板同时也是 boot 信息的容器；
// 这里只在启动时收起一次，避免它从第一帧就糊在开局界面右上角。
hud.stats.style.display = 'none';

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
// DoorManager must write the initial BLOCK.DOOR cells before navigation samples
// `requiresOpen`; otherwise every closed indoor door looks permanently open.
const audio = new Audio();
const doors = new DoorManager(scene, world, LEVEL.doors);
// Navigation is built after the main entrance has its final state.
doors.openAt(LEVEL.mainEntrance);
const navigation = buildNavigationIndex(world, LEVEL);
world.navigation = navigation;
doors.navigation = navigation;
doors.onAIOpen = () => audio.door(true);
const mesher = new VoxelMesher(world);
const meshStats = mesher.buildAll();
scene.add(mesher.group);
// 家具模型放在体素几何之后加入，保持正常深度测试并让模型层优先参与绘制。
if (world.furniture?.group) scene.add(world.furniture.group);

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

const initialLoadout = loadoutManager.export();

/** 开局手雷基数 = 难度基数 + 护甲 grenadeBonus，钳到 ≥0（允许某种手雷直接不带，不允许负数）。 */
function grenadeBaseCount() {
  const bonus = loadoutManager.getPlayerModifiers().grenadeBonus ?? 0;
  return Math.max(0, D().grenades + bonus);
}

const player = new Player(world, devSpawn(), loadoutManager.getPlayerModifiers());
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
const loadout = new Loadout({
  pistolId: initialLoadout.pistol,
  primaryId: null,
  maxPrimarySlots: 1 + (loadoutManager.getPlayerModifiers().weaponSlots ?? 0),
});
player.rig.setGun(loadout.current.id);
player.rig.setGrenade(initialLoadout.grenade);

// 敌人数量固定按 tier 3 完整池生成（原专家档 20/17/17 人）。
// 简报里的「X 人」和这里用的是同一个 countEnemies —— 数字永远一致。
const activeSpawns = LEVEL.spawns.filter((s) => s.tier <= D().enemyTier);
const enemyServices = {
  doors,
  navigation,
  rooms: LEVEL.rooms,
  roomLinks: navigation.roomLinks,
  onDoorNoise: () => audio.door(true),
};
const enemies = activeSpawns.map((s) => {
  const e = new Enemy(world, s, enemyServices);
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
// AI door requests must respect the live player/enemy occupancy of a doorway,
// while requestAIOpen excludes only the requesting enemy itself.
doors.actors = () => [player, ...enemies];

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

/**
 * 应急灯：关卡自带的可击碎闪烁灯。从体素网格扫出来，所以关卡只要
 * 往网格里写 FLICKER_LAMP 就自动接管。
 * 敌人要能查「玩家是不是站在灯下」，所以每个敌人都拿到这个引用。
 */
const lights = new EmergencyLights(scene, world);
lights.scan();
for (const e of enemies) e.lights = lights;

const combat = new Combat(world, effects, flashPool, enemies);
// 玩家的子弹可以打碎应急灯（灯不在体素碰撞里，combat 单独做球体求交）
combat.lights = lights;
combat.onLampBreak = () => {
  // 打碎的灯写成残骸方块，需要重建那一块的顶点色
  mesher.rebuildDirty();
  toast('灯被打碎', 900);
};
const grenades = new GrenadeSystem(scene, world, effects, flashPool);
const pickups = new PickupManager(scene, world);
placeItems(pickups, [...LEVEL.medkits, ...LEVEL.weapons]);

// ── 掠夺容器（战利品箱）───────────────────────────────────────────────────
// 关卡注册表只给坐标与稀有度（level01.js 的 LOOT_CONTAINERS），y 用地面
// 吸附补齐（与拾取物同一套 API）。三个箱子是交互道具不是体素方块：
// 不参与碰撞/阴影，视觉上就是地板上的货物箱（见 loot-container.js）。
const lootContainers = new LootContainerManager(scene);
// 蓝图掉落排除集：已拥有蓝图（档案解锁位）+ 本局已掉蓝图。容器层不依赖
// 存档单例 —— 由这里注入排除函数，loot-tables 在每个容器 open 时才求值，
// 因而跨局（页面重载）自动跟随最新档案；本局内已掉蓝图也加入，同一局内
// 不会让两台箱子掉同一张蓝图（掉落是独立通道，不挤占材料池）。
const blueprintDropExclude = new Set(Object.keys(saveStore.getProfile()?.blueprints ?? {}));
const blueprintLootOptions = { excludeBlueprints: () => [...blueprintDropExclude] };
for (const c of LEVEL.lootContainers ?? []) {
  const surf = world.highestSurfaceUnder(
    c.x - 0.2, c.z - 0.2, c.x + 0.2, c.z + 0.2, 1.6, -2
  );
  lootContainers.add(
    { x: c.x, y: Number.isFinite(surf) ? surf : 1.0, z: c.z },
    c.tier,
    blueprintLootOptions
  );
}
const openableFurniture = new OpenableFurnitureManager(scene, world.furniture);

/**
 * ── 战斗小地图 ────────────────────────────────────────────────────────────
 *
 * 只画房间轮廓、门、撤离点和玩家自己。数据源是关卡注册表的 `rooms`，
 * 不是体素网格 —— 家具和敌人不在那份数据里，所以「不泄露」是结构保证。
 * 新地图只要在 level/index.js 登记 rooms/building/spawn/doors 就自动有图。
 */
hud.mmBox.innerHTML = renderMinimapSvg(LEVEL).svg;
const mmPlayer = hud.mmBox.querySelector('.mm-player');
let minimapOn = true;
let mmHereId = undefined;        // 与 roomAt 的 null（室外）区分，保证第一帧会写「室外」
// 开局在任务选择屏/简报，小地图先收起，startMission() 里再放出来
hud.minimap.classList.add('off');

/** 玩家箭头跟位置与朝向走。上为北（−Z），所以 yaw=0 时箭头指向正上。 */
function updateMinimap() {
  /**
   * 探索记录必须先做、且不受 minimapOn 影响 —— 小地图被 TAB 收起时
   * 玩家仍在推进，重新打开时该亮的房间必须已经亮着。
   */
  const id = roomAt(LEVEL, player.pos.x, player.pos.z);
  if (id) markRoomSeen(id);

  if (!minimapOn) return;
  const arrow = hud.mmBox?.querySelector('.mm-player');
  if (!arrow) return;
  const deg = (-cam.yaw * 180) / Math.PI;
  arrow.setAttribute(
    'transform',
    `translate(${player.pos.x.toFixed(2)} ${player.pos.z.toFixed(2)}) rotate(${deg.toFixed(1)})`
  );
  if (id !== mmHereId) {
    mmHereId = id;
    if (hud.mmHere) hud.mmHere.textContent = id ? (LEVEL.roomLabels?.[id] ?? id) : '室外';
  }
}

/**
 * 标记房间为「已探索」：小地图上亮起来并显示名字。
 *
 * 探索集合独立于 minimapOn —— 小地图被 TAB 收起时玩家仍在探索，
 * 重新打开时该亮的房间必须已经是亮的。
 */
const seenRooms = new Set();
function markRoomSeen(id) {
  if (seenRooms.has(id)) return;
  seenRooms.add(id);
  hud.mmBox?.querySelector(`.mm-room[data-room="${id}"]`)?.classList.add('seen');
  hud.mmBox?.querySelector(`.mm-label[data-label="${id}"]`)?.classList.add('seen');
}

// ── Game state ─────────────────────────────────────────────────────────────
const game = {
  totalEnemies: enemies.length,
  killed: 0,
  over: false,
  won: false,
  extractReady: false,
  startTime: performance.now() / 1000,
  endTime: 0,
  /** 本局用时（秒）：结算评级与存档字段共用 */
  elapsedTime: 0,
  damageFlash: 0,
  toastUntil: 0,
  /**
   * 批 2 起为「兼容只读」字段：由 initializeLegacyGrenadeAdapter() 从
   * raidInventory.quickUse 单向初始化，之后没有任何写入方 —— 投掷扣减必须走
   * consumeQuickUse()。保留这两个字段只给外部调试脚本/旧测试做只读兼容，
   * HUD 与投掷真源已经是 QuickUse。
   */
  nades: 0,
  nadeKind: null,
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
  /**
   * 局内背包面板（批 3）唯一游戏级状态：打开只屏蔽玩家侧输入与面板互斥，
   * 世界照常 tick（敌人/门/容器/家具/手雷/计时/撤离不停摆）。
   */
  inventoryOpen: false,
  mapOpen: false,
};

/**
 * 开局/整备同步点：QuickUse 是唯一初始化源（seedQuickUseGrenade 填充槽 0），
 * game.nades/nadeKind 只是它的一次性只读投影（兼容字段），批 2 起不再有任何
 * 调用方向旧字段写新数量 —— 投掷扣减唯一真源是 quickUse（consumeQuickUse）。
 */
function initializeLegacyGrenadeAdapter(grenadeId) {
  const count = grenadeInventory(grenadeId, grenadeBaseCount());
  seedQuickUseGrenade(player.raidInventory, grenadeId, count, 0);
  return syncLegacyGrenadeFromQuickUse(game, player.raidInventory, 0);
}
initializeLegacyGrenadeAdapter(initialLoadout.grenade);

// ── Quick Wheel（Q 按住打开，松开确认；不暂停世界）────────────────────────
/**
 * 会话状态与 UI 分离：QuickWheel 只负责几何、方向映射和 DOM 刷新，
 * onConfirm/onCancel 由这里注入；QuickUse 数据层是唯一的物品真源。
 */
const quickWheel = new QuickWheel({
  root: hud.quickWheel,
  slotNodes: hud.quickWheel ? [...hud.quickWheel.querySelectorAll('.qw-slot')] : null,
  centerName: hud.quickWheel?.querySelector('.qw-center-name') ?? null,
  onConfirm: (index) => handleQuickUseConfirm(index),
  onCancel: () => { /* 中央/Esc/右键取消：不消耗，静默收轮盘 */ },
});
// 指针解锁（Esc / 失焦）时轮盘必须收起：解锁会清空键盘状态，松开确认可能
// 永远等不到，保持打开只剩下一张永远不动的双环 UI。
document.addEventListener('pointerlockchange', () => {
  if (!document.pointerLockElement) quickWheel.close();
});
// 失焦（Alt+Tab / 点出浏览器）时 Input 只清自己的按住状态，QuickWheel 是
// 独立会话状态 —— 不主动收口的话，回焦瞬间松开 Q 的释放帧会走确认路径，
// 把粘性选中的旧槽意外投掷出去。close 只清状态不消耗，与 pointerlockchange/
// 死亡路径一致；渲染也会随之移除 .open。
window.addEventListener('blur', () => {
  quickWheel.close();
});

/** 轮盘打开时在 player 层被屏蔽的动作（掩码代理，见 WHEEL_PLAYER_INPUT）。 */
const WHEEL_PLAYER_BLOCK = new Set(['roll']);
/**
 * player.update 的输入掩码：轮盘打开时屏蔽翻滚，但保留移动/姿态输入 ——
 * 世界不暂停，玩家仍要能挪动找掩体；射击/瞄准/交互在帧循环的另一层屏蔽。
 */
const WHEEL_PLAYER_INPUT = {
  down: (action) => !WHEEL_PLAYER_BLOCK.has(action) && input.down(action),
  justPressed: (action) => !WHEEL_PLAYER_BLOCK.has(action) && input.justPressed(action),
  longPress: (action, sec) => !WHEEL_PLAYER_BLOCK.has(action) && input.longPress(action, sec),
  releasedShort: (action, sec) => !WHEEL_PLAYER_BLOCK.has(action) && input.releasedShort(action, sec),
  releasedAny: (action) => !WHEEL_PLAYER_BLOCK.has(action) && input.releasedAny(action),
};

/**
 * 背包面板打开时的 player.update 输入掩码：屏蔽全部移动/姿态/交互动作。
 * 战斗（射击/瞄准/换枪/投掷/换弹）在帧循环里由 `!invOpen` 门控，
 * 两层各自负责自己管辖的输入，不会留下穿透缺口。
 */
const INVENTORY_PLAYER_BLOCK = new Set([
  'forward', 'back', 'left', 'right', 'jump',
  'sprint', 'slow', 'crouchHold', 'crouchToggle', 'crouch',
  'roll', 'leanLeft', 'leanRight',
  'interact', 'interactDoor', 'pickup',
]);
const INVENTORY_PLAYER_INPUT = {
  down: (action) => !INVENTORY_PLAYER_BLOCK.has(action) && input.down(action),
  justPressed: (action) => !INVENTORY_PLAYER_BLOCK.has(action) && input.justPressed(action),
  longPress: (action, sec) => !INVENTORY_PLAYER_BLOCK.has(action) && input.longPress(action, sec),
  releasedShort: (action, sec) => !INVENTORY_PLAYER_BLOCK.has(action) && input.releasedShort(action, sec),
  releasedAny: (action) => !INVENTORY_PLAYER_BLOCK.has(action) && input.releasedAny(action),
};

/**
 * QuickUse 槽 → 轮盘显示条目。空槽是显式 null（占位不压缩）；glyph 是
 * 本项目物品的工具图标（手雷用 loadout-art），绝不放 ARC 图标/名称。
 */
function quickUseWheelItems() {
  const slots = player.raidInventory?.quickUse ?? [];
  const items = [];
  for (let i = 0; i < slots.length; i++) {
    const item = slots[i];
    if (!item) { items.push(null); continue; }
    items.push({
      name: item.name ?? item.defId ?? '物品',
      quantity: item.quantity ?? 1,
      kind: item.slotKind,
      defId: item.defId,
      glyph: item.slotKind === 'grenade' ? grenadeGlyph(item.defId) : '',
    });
  }
  return items;
}

/**
 * 轮盘确认入口。空槽仍回调（可选择但绝不可能消耗）；grenade 走真实投掷 +
 * consumeQuickUse 原子扣减；consumable 本批只允许注入的 onUseConsumable
 * 适配器产生效果，未接入前绝不伪造扣除成功。
 *
 * 选中槽同步规则：只有「有效确认」才调用 setQuickUseSelectedIndex ——
 * 空槽 / 取消 / 中央取消都不改变当前有效槽（G 与 HUD 继续读旧 getter）。
 */
function handleQuickUseConfirm(index) {
  const item = player.raidInventory?.quickUse?.[index];
  if (!item) { toast(`快速栏位 ${index + 1} · 空`, 900); return; }
  if (item.slotKind === 'grenade') {
    setQuickUseSelectedIndex(player.raidInventory, index);
    throwGrenadeFromQuickUse(index);
  } else if (item.slotKind === 'consumable') {
    // 只有真实使用成功才同步选中；未接入使用回调时「确认」只是提示，
    // 不能把空确认当成成功。
    const used = useConsumableFromQuickUse(index);
    if (used?.ok) setQuickUseSelectedIndex(player.raidInventory, index);
  }
}

/**
 * QuickUse 消耗品使用入口（批 3 接入完整急救包效果；普通环境下只提示，不扣数量）。
 * @returns {{ok: boolean, reason?: string}} 真实使用成功才 ok:true
 */
let onUseConsumable = null;
function useConsumableFromQuickUse(index) {
  const item = player.raidInventory?.quickUse?.[index];
  if (!item) return { ok: false, reason: 'QuickUse 槽为空' };
  if (typeof onUseConsumable === 'function') {
    const result = onUseConsumable(item, index);
    if (result?.ok) return { ok: true };          // 效果回调自己完成扣减
    toast(result?.reason ?? '该物品当前无法使用', 1400);
    return { ok: false, reason: result?.reason ?? '该物品当前无法使用' };
  }
  toast(`${item.name}：效果将在局内背包批次接入 · 未消耗`, 1600);
  return { ok: false, reason: '未接入' };
}

/**
 * 真实投掷器（Gameplay 物理闭环）：只负责把实例真的扔出去并返回是否成功。
 * 扣减与否完全由 attemptGrenadeThrow 的原子结算决定 —— G 键、Q 轮盘确认、
 * 局内背包面板的「使用」共用同一个投掷器，不存在绕过原子 API 的路径。
 */
function throwGrenadeItem(item) {
  cam.cam.getWorldDirection(_camDir);
  const eye = new THREE.Vector3(
    player.pos.x, player.pos.y + PLAYER.eyeHeight, player.pos.z
  ).addScaledVector(_camDir, 0.5);
  grenades.throwFrom(eye, _camDir, true, item.defId);
  return true;
}

/**
 * 投掷当前 QuickUse 槽手雷：结算序列（读取 → 投掷 → 扣减）在
 * attemptGrenadeThrow 里原子化 —— 投掷失败/抛异常绝不扣数量，
 * 也不双维护 game.nades。
 */
function throwGrenadeFromQuickUse(index) {
  const grenadeName = player.raidInventory?.quickUse?.[index]?.name ?? '手雷';
  const result = attemptGrenadeThrow(player.raidInventory, index, throwGrenadeItem);
  if (result.ok) {
    audio.grenadeThrow();
    syncVitalsHud();          // 手雷计数立刻更新，不等 0.35 秒采样
    // 最后一颗：不显示「×0」，用「已用尽」明确数量语义（扣减语义不变）
    toast(result.remaining > 0
      ? `${grenadeName} ×${result.remaining}`
      : `${grenadeName} 已用尽`, 900);
    return result;
  }
  if (result.reason === 'no-grenade') {
    toast('当前快捷位没有手雷 · 按 Q 打开轮盘', 1100);
  } else {
    console.error('[Main] 投掷失败，已拦截扣减:');
    toast('投掷失败', 1200);
  }
  return result;
}

// ── 局内背包面板（批 3：Tab 切换，不暂停世界）────────────────────────────
/**
 * 面板是只读视图 + 会话控制器。game.inventoryOpen 是面板的唯一游戏级状态
 * （不新增第二个同义标志）；RaidInventoryView.isOpen 只是它自己的 DOM 镜像。
 * 世界照常推进（敌人/门/容器/家具/手雷/计时/撤离），帧循环里只有「玩家侧」
 * 输入被掩码 —— 不存在任何 `if (inventoryOpen) return` 让世界停摆的路径。
 * 数据改写（使用/放回背包）全部由 view 走 raid-inventory 原子 API，
 * 打开/关闭面板本身不修改 loadout 或 ProfileData。
 */
const raidInventoryView = createRaidInventoryView(player, loadout, {
  root: hud.raidInventory,
  throwGrenadeItem,
  onCloseRequest: () => closeRaidInventory(),
  onActionResult: (result) => {
    if (!result?.ok) {
      toast(result?.reason ?? '该操作不可用', 1400);
      return;
    }
    if (result.consumed) {
      audio.grenadeThrow();
      const name = result.item?.name ?? '手雷';
      toast(result.remaining > 0
        ? `${name} ×${result.remaining}`
        : `${name} 已用尽`, 900);
    } else if (result.cleared) {
      const name = result.item?.name ?? '物品';
      toast(`${name} · 已放回背包`, 1100);
    } else if (result.target === 'backpack') {
      // 容器拿取：成功才计入携带物（HUD 与结算同一视图）
      const name = result.item?.name ?? '物品';
      toast(`拿取 ${name} ×${result.item?.quantity ?? 1} · 已放入背包`, 1100);
    } else if (result.target === 'container') {
      const name = result.item?.name ?? '物品';
      toast(`已放入容器 ${name} ×${result.item?.quantity ?? 1}`, 1100);
    }
    syncVitalsHud();          // 手雷/携带计数立刻刷新，不等 0.35 秒采样
    syncCarryHud();           // 携带栏 HUD 同步容器转移后的占格
  },
});

/**
 * 打开面板：先收 Q 轮盘（互斥，不能两个模态层叠）；退出指针锁定让鼠标
 * 能点住槽位；不暂停世界、不修改 loadout/ProfileData。
 */
function openRaidInventory() {
  if (game.inventoryOpen) return;
  if (pendingWeaponSwap) { toast('先完成替换槽位选择', 1100); return; }
  if (quickWheel.isOpen) quickWheel.close();   // 互斥：背包优先，轮盘先收
  game.inventoryOpen = true;
  raidInventoryView.open();
  document.exitPointerLock?.();
}

/**
 * 关闭面板（Tab / Esc 正常路径）。silent=true 用于死亡/结算/重开等强制收口：
 * 不再请求指针锁定（结算界面/重置流程不需要，且会被浏览器拒绝）。
 */
function closeRaidInventory(options = {}) {
  if (!game.inventoryOpen) return;
  game.inventoryOpen = false;
  raidInventoryView.close();
  if (!options.silent && !game.over && !player.dead
    && canvas.requestPointerLock) {
    try { canvas.requestPointerLock()?.catch?.(() => {}); }
    catch { /* 等下一次点击 */ }
  }
}

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
  // 占位卡编号跟着已登记关卡数走 —— 写死 '03' 的话，新加一关就会出现
  // 两张「03」（真关卡 03 与占位 03 并排）。
  const nextCode = String(LEVELS.length + 1).padStart(2, '0');
  const entries = [...LEVELS, { future: true, code: nextCode, name: '未解密', en: 'PROTOCOL ??' }];
  entries.forEach((lv, i) => {
    const el = document.createElement('div');
    el.className = 'ms-card' + (lv.locked ? ' locked' : '') + (lv.future ? ' future' : '');
    el.dataset.level = lv.id ?? '';
    el.dataset.index = i;
    /**
     * 卡片上的敌人数按单一难度（tier 3 完整池）报数 —— 这里曾经写死
     * 简单档，于是专家难度下卡片报低于实际值。人数唯一来源仍是
     * countEnemies(关卡, D().enemyTier)，三关固定 20/17/17。
     */
    const n = !lv.future && !lv.locked
      ? countEnemies(lv.spawns, D().enemyTier)
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
      el.addEventListener('click', () => {
        msIndex = i;
        paintMsSelection();
        openBrief();
      });
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
  // 简报内容跟着「选中的关卡」走，而不是页面加载时的 LEVEL。
  const card = msCards[msIndex];
  const lv = LEVELS.find((l) => l.id === card?.dataset.level);
  if (!lv || lv.locked) {
    toast('该档案尚未解密', 1200);
    return;
  }
  pendingLevel = lv;
  openTaskBrief();
}

function openTaskBrief(page = 0) {
  fillBriefTexts();
  buildDifficultyCards();
  refreshBriefCounts();
  drawMapPage();
  hud.missions.style.display = 'none';
  hideEquipment();
  hud.brief.style.display = 'flex';
  showBriefPage(page);
  updateBriefLoadoutSummary();
}

function openEquipmentFromBrief() {
  hud.brief.style.display = 'none';
  showEquipment();
}

// ── 任务简报 + 难度展示 ────────────────────────────────────────────────
/**
 * 简报里唯一保留的敌人数：难度页的「敌人 X 人」与点击进入提示。
 * 任务目标卡不再显示数量 —— 数量只在单一难度卡上展示。
 */
function refreshBriefCounts() {
  const n = countEnemies(pendingLevel.spawns, D().enemyTier);
  if (hud.hintCount) hud.hintCount.textContent = n;
}

/**
 * 难度展示卡：单一「标准」难度（原三档已合并，见 BLUEPRINT §7.5）。
 * 只渲染一张只读信息卡，没有点击切换 —— 玩家无法通过选简单来绕过
 * 固定风险，局外成长（蓝图解锁装备）才成立。
 */
function buildDifficultyCards() {
  hud.diffs.innerHTML = '';
  const d = D();
  const el = document.createElement('div');
  el.className = 'diff';
  const hex = `#${d.color.toString(16).padStart(6, '0')}`;
  const hpPct = Math.round((d.hpMax / 120) * 100);
  const enemies = countEnemies(pendingLevel.spawns, d.enemyTier);
  el.innerHTML =
    `<div class="dn" style="color:${hex}">${d.name}</div>` +
    `<div class="ds">${d.subtitle}</div>` +
    `<div class="dd">${d.desc}</div>` +
    `<div class="hpbar"><i style="width:${hpPct}%;background:${hex}"></i></div>` +
    `<div class="dstat">生命 ${d.hpMax} · 护甲 ${d.armorMax} · 手雷 ${d.grenades}` +
    `<br>敌人 ${enemies} 人 · ${d.enemyHp} HP · 视野 ×${d.visionRangeMul}` +
    ` · 指示器 ${d.indicatorRange} vox</div>`;
  hud.diffs.appendChild(el);
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
  const { svg } = renderFloorplanSvg(pendingLevel.build(), {
    theme: 'dark',
    spawn: pendingLevel.spawn,
    doors: pendingLevel.doors,
    roomLabels: roomLabelList(pendingLevel.rooms, pendingLevel.roomLabels),
  });
  box.innerHTML = svg;
  const cap = document.getElementById('map-cap');
  if (cap) cap.textContent = `${pendingLevel.name} · ${pendingLevel.subtitle}。悬停房间看名字。`;
}

function updateBriefLoadoutSummary() {
  const weapon = WEAPONS[loadoutManager.pistol] ?? WEAPONS.pistol;
  const armor = loadoutManager.getSummary().armor;
  const grenade = loadoutManager.getSummary().grenade;
  const gunName = document.getElementById('brief-gun-name');
  const gunDetail = document.getElementById('brief-gun-detail');
  const gunArt = document.getElementById('brief-gun-art');
  const armorName = document.getElementById('brief-armor-name');
  const armorDetail = document.getElementById('brief-armor-detail');
  const nadeName = document.getElementById('brief-nade-name');
  const nadeDetail = document.getElementById('brief-nade-detail');
  if (gunName) gunName.textContent = weapon.name;
  if (gunDetail) gunDetail.textContent = `伤害 ${weapon.damage} · 射速 ${weapon.rof}/s · 噪音 ${weapon.noise}`;
  if (gunArt) gunArt.innerHTML = gunGlyph(weapon.id, weapon.color);
  if (armorName) armorName.textContent = armor?.name ?? '标准战术背心';
  if (armorDetail) armorDetail.textContent = armor?.desc ?? '均衡防护与机动';
  if (nadeName) nadeName.textContent = `${grenade?.name ?? '闪光弹'} ×${grenadeInventory(loadoutManager.grenade, grenadeBaseCount())}`;
  if (nadeDetail) nadeDetail.textContent = grenade?.desc ?? '按 G 投掷';
  const nadeArt = document.getElementById('brief-nade-art');
  if (nadeArt) nadeArt.innerHTML = grenadeGlyph(loadoutManager.grenade);
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
document.getElementById('brief-back')?.addEventListener('click', () => {
  hud.brief.style.display = 'none';
  hud.missions.style.display = 'flex';
});
function markLoadoutCards() {
  const selectedGun = loadoutManager.pistol;
  const selectedNade = loadoutManager.grenade;
  document.querySelectorAll('.lcard[data-gun], .lcard[data-pistol]').forEach((el) => {
    const id = el.dataset.gun || el.dataset.pistol;
    el.classList.toggle('on', id === selectedGun);
  });
  document.querySelectorAll('.lcard[data-nade]').forEach((el) => {
    el.classList.toggle('on', el.dataset.nade === selectedNade);
  });
}

/**
 * 整备阶段装备刷新（曾把武器/手雷卡切换与装备页预览连起来用）。
 *
 * 守卫：只允许 game.started 之前调用 —— 函数体内 initializeLegacyGrenadeAdapter
 * 会把 QuickUse 槽 0 seedQuickUseGrenade 重置回 loadout 种子，若未来被误接到
 * 「局内换装」路径，会覆盖已经消费/重排的 QuickUse（投掷扣减唯一真源），
 * 造成双真源冲突。局内一律只走 QuickUse 单向扣减。当前没有调用方
 * （startMission() 是唯一正式初始化路径），保留函数 + 守卫防未来误调用。
 */
function applyLoadoutLive() {
  if (game.started) return false;   // 仅整备阶段有效，局内禁止
  loadout.setPistol(loadoutManager.pistol, loadoutManager.getWeaponModifiers(loadoutManager.pistol));
  loadout.setMaxPrimarySlots(1 + (loadoutManager.getPlayerModifiers().weaponSlots ?? 0));
  loadout.clearPrimaries();
  player.rig.setGun(loadout.current.id);
  player.rig.setGrenade(loadoutManager.grenade);
  initializeLegacyGrenadeAdapter(loadoutManager.grenade);
  syncVitalsHud();
  return true;
}

markLoadoutCards();
document.querySelectorAll('.lcard[data-gun], .lcard[data-pistol]').forEach((el) => {
  el.setAttribute('aria-disabled', 'true');
});
document.querySelectorAll('.lcard[data-nade]').forEach((el) => {
  el.setAttribute('aria-disabled', 'true');
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

// 初始化装备整备 UI
initEquipmentUI();

// 装备页只负责返回简报或提交开战；主流程由这里统一切换。
window.addEventListener('equipment-back-brief', () => openTaskBrief(briefPage));
window.addEventListener('equipment-start', startMission);
window.addEventListener('loadout-changed', () => {
  markLoadoutCards();
  updateBriefLoadoutSummary();
});

/** 简报标题 / 目标文案跟着所选关卡走 */
function fillBriefTexts() {
  const sub = document.getElementById('brief-sub');
  if (sub) sub.textContent = `${pendingLevel.en} — ${pendingLevel.subtitle}`;
  const cap = document.getElementById('goal-cap');
  if (cap) cap.textContent = `${pendingLevel.blurb} 本局没有存档，也没有重生。`;
}
fillBriefTexts();

function startMission() {
  if (game.started) return;
  // 玩家在简报里换了关卡（原地切换没重载）——现在才真正重载。
  // 整个世界（玩家/敌人/门/拾取物）都在模块初始化时按 LEVEL 建好，
  // 运行时热切换会留下混合状态，所以这里 reload，而不是就地重建世界。
  if (pendingLevel.id !== LEVEL.id) {
    const target = { map: pendingLevel.id };
    sessionStorage.setItem('pendingStart', JSON.stringify(target));
    const q = new URLSearchParams(location.search);
    q.set('map', pendingLevel.id);
    location.href = location.pathname + '?' + q.toString();
    return;
  }
  
  // 从装备管理器读取玩家的唯一装备状态
  const loadoutData = loadoutManager.export();
  const playerMods = loadoutManager.getPlayerModifiers();
  loadout.setPistol(loadoutData.pistol, loadoutManager.getWeaponModifiers(loadoutData.pistol));
  loadout.setMaxPrimarySlots(1 + (playerMods.weaponSlots ?? 0));
  loadout.clearPrimaries();
  // 整备背包中的主武器实例是任务开局的真实弹药状态来源。
  // 仅读取 primary 槽，不碰手枪槽或手雷数量；风险实例仍由 beginRaid 统一记账。
  const equippedPrimaries = loadoutManager.getInventory()?.primary ?? [];
  equippedPrimaries.forEach((item, index) => {
    if (!item?.defId || index >= loadout.maxPrimarySlots) return;
    loadout.pickUpToSlot({
      weapon: item.defId,
      ammo: item.payload?.ammo,
      reserve: item.payload?.reserve,
    }, 0, index + 1);
  });
  // 批 5 统一 adapter：装备页/仓库/开局/结算看到同一批实例 —— 把局外装备页
  // 的原实例（instanceId + payload，含 reserve: Infinity/attachments）镜像进
  // 局内 equipment 视图。战斗数值真源仍是 Loadout.slots，此投影只负责一致
  // 视图（raidOrigin 标记保证它们不会被当成新战利品重复结算）。
  syncEquipmentFromLoadout(player.raidInventory, loadout, {
    armorId: playerMods.visualKit,
    attachments: loadoutData.attachments,
    instances: {
      pistol: loadoutManager.getInventory()?.pistol ?? null,
      armor: loadoutManager.getInventory()?.armor ?? null,
      primary: equippedPrimaries.slice(0, loadout.maxPrimarySlots),
    },
  });
  initializeLegacyGrenadeAdapter(loadoutData.grenade);
  player.rig.setGun(loadout.current.id);
  // 视觉代入手雷 id 也读 QuickUse 真源（新适配器已把 loadout 种子放进槽 0）；
  // game.nadeKind 只是只读兼容投影，不能作为独立真源再被读取。
  player.rig.setGrenade(
    player.raidInventory?.quickUse?.[getQuickUseSelectedIndex(player.raidInventory)]?.defId
      ?? loadoutData.grenade
  );
  // 护甲 id 即视觉身份：rig 的 ARMOR_KIT_COLORS 按它取专属配色（8 套共享几何、只差颜色）
  player.rig.setArmorKit(loadoutData.armor);
  player.loadoutModifiers = loadoutManager.getPlayerModifiers();
  player.armorMax = player.loadoutModifiers.armorMax;
  player.armor = player.armorMax;
  player.syncCarryCapacity();

  // 出击记账：写不进存档就当场阻止出击（成功/死亡语义必须可信）
  if (!beginRaid(loadoutData)) return;

  game.started = true;
  // 跳简报（R 重开）路径也会走到这里 —— 任务选择屏同样要关掉，
  // 否则游戏已经在跑了，选择屏还盖在上面挡视线挡点击。
  // 重开/重载后绝不能残留局内背包面板（若前一次开场前被误开）；
  // 容器会话一并清理 —— 新一局没有上一局开着的箱子。
  closeRaidInventory({ silent: true });
  closeContainerSession(player.raidInventory);
  hud.brief.style.display = 'none';
  if (hud.missions) hud.missions.style.display = 'none';
  if (hud.equipment) hideEquipment();  // 也要关掉装备面板
  // 小地图属于战斗 HUD：任务进行中才显示（简报阶段它会盖在面板边上很碍眼）
  if (hud.minimap) hud.minimap.classList.toggle('off', !minimapOn);
  updateMinimap();
  syncVitalsHud();
  syncCarryHud();
  // 简报是用户手势，正好在这里创建 AudioContext（浏览器要求手势触发）
  audio.init();
  // 指针锁定可能因为「缺少用户手势」而拒绝（比如 R 重开后的自动开始），
  // rejection 会变成未处理的 Promise 错误砸进 #err —— 吞掉，静默等待
  // 下一次真实点击自然完成锁定。
  if (canvas.requestPointerLock) {
    try { canvas.requestPointerLock()?.catch?.(() => {}); }
    catch { /* 无手势 / 冷却中，等下一次点击 */ }
  }
}
/**
 * 出击记账（SaveStore）：startRaid 立即把本局写入 pendingRaid（防刷新作弊），
 * 并在 stats.totalRaids 记账。局内携带物不直接写永久仓库 —— 成功撤离后由
 * settleRaid 一次性入库；死亡/刷新按放弃处理，风险物与携带物全部丢失。
 *
 * 契约（§16 首版结算保护）：存档不可写、损坏或配额不足时**禁止**开始有风险
 * 的任务 —— 写盘失败意味着成功后无法入库、死亡后无法判定，成功/死亡语义
 * 不可信。brought 为从仓库带入的风险物 instanceId：由整备背包收集
 * （loadoutManager.collectRiskInstanceIds，§4.3）—— 只有真实存在于
 * profile.stash 的实例才计入；保底装备（手枪/standard/flash）没有 stash
 * 实例，结构上不会进入风险链。收集在 startRaid 之前完成，因为 startRaid
 * 会把这些 instanceId 从 stash 移入 pendingRaid.riskedItems。
 * @returns {boolean} 成功开启 raid 账本（失败时已 toast 提示）
 */
function beginRaid(loadoutData) {
  let raidId;
  try {
    const brought = loadoutManager.collectRiskInstanceIds();
    raidId = saveStore.startRaid(LEVEL.id, D().id, loadoutData, brought);
  } catch (err) {
    console.error('[Main] startRaid threw:', err);
    raidId = null;
  }
  if (!raidId) {
    console.error('[Main] saveStore.startRaid 失败，阻止出击');
    toast('存档写入失败 · 已阻止出击', 2800);
    return false;
  }
  return true;
}

hud.briefGo.addEventListener('click', openEquipmentFromBrief);
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

  if (INPUT.cancel.includes(e.code)) {
    e.preventDefault();
    if (hud.equipment?.classList.contains('active')) {
      hud.equipment.classList.remove('active');
      openTaskBrief(briefPage);
    } else if (hud.brief.style.display !== 'none') {
      hud.brief.style.display = 'none';
      hud.missions.style.display = 'flex';
    }
    return;
  }

  if (e.code === 'Enter' || e.code === 'Space') {
    e.preventDefault();
    if (briefPage < BRIEF_PAGES - 1) showBriefPage(briefPage + 1);
    else openEquipmentFromBrief();
  }
  if (e.code === 'ArrowRight') showBriefPage(briefPage + 1);
  if (e.code === 'ArrowLeft') showBriefPage(briefPage - 1);
});

/**
 * 地图重载后，只要存在一次性 pendingStart 标记，就直接续接到 3D。
 * 失败时清掉标记，避免错误参数造成无限重载。
 */
const pendingStartKey = 'pendingStart';
let resumeStart = null;
try {
  resumeStart = JSON.parse(sessionStorage.getItem(pendingStartKey) || 'null');
} catch {
  sessionStorage.removeItem(pendingStartKey);
}
if (resumeStart) {
  const matches = resumeStart.map === LEVEL.id;
  sessionStorage.removeItem(pendingStartKey);
  if (matches) startMission();
  else toast('任务参数未能同步，请重新选择任务', 2200);
}

/** 死亡后按 R 重开继续跳过简报。 */
if (sessionStorage.getItem('skipBrief') === '1') {
  sessionStorage.removeItem('skipBrief');
  startMission();
}

// 选择屏渲染顺序：先建卡片，再定初始选中项（已解锁关卡）
buildMissionCards();
msIndex = Math.max(0, msCards.findIndex((c) => c.dataset.level === LEVEL.id));
paintMsSelection();

// 初始化中枢导航
initHubNav();

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

/** 统一处理 E 的门交互，避免阻挡检查出现分叉。 */
function toggleDoor(door) {
  if (!door) return;
  const actors = [
    { pos: player.pos, height: player.body.height, radius: PLAYER.width / 2 },
    ...enemies,
  ];
  if (!door.open || !door.blockedByActor(actors)) {
    const opened = door.toggle();
    navigation.invalidateDoors();
    audio.door(opened);
    toast(opened ? '门已打开' : '门已关闭', 900);
  } else {
    toast('门口有人，关不上', 900);
  }
}

/**
 * 顶部目标卡在两种任务状态间切换：清敌时显示人数，清场后持续指向庭院撤离。
 * 这不是短暂 toast，玩家走到出生庭院之前都会看到目标与剩余距离。
 */
function updateObjectiveHud(extractDistance = null) {
  if (game.extractReady) {
    const distance = extractDistance ?? Math.hypot(
      player.pos.x - SPAWN.x, player.pos.z - SPAWN.z
    );
    hud.objective?.classList.add('extracting');
    if (hud.objectiveLabel) hud.objectiveLabel.textContent = '撤离准备';
    hud.enemies.textContent = `前往庭院撤离 · ${Math.max(0, Math.ceil(distance))} m`;
    return;
  }

  hud.objective?.classList.remove('extracting');
  if (hud.objectiveLabel) hud.objectiveLabel.textContent = '携带物';
  hud.enemies.textContent = `${player.carryCount} / ${player.carryCap}`;
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
  // 死亡瞬间收起轮盘与局内背包（世界仍继续到镇头结束，
  // 不能留下悬浮的双环或只读面板盖住画面；死亡结算不得残留 overlay）。
  // 容器会话一并清理：已拿物随既有丢失规则处理，容器剩余物不凭空发放。
  quickWheel.close();
  closeRaidInventory({ silent: true });
  closeContainerSession(player.raidInventory);
  player.dead = true;
  player.rig.startDeath(0, 1);
  audio.death();
  game.deathHold = 1.6;
  // 判死瞬间强制同步 HUD，否则血条会停在最后一次 0.35s 采样的正数值上：
  // 下一帧进入死亡镇头分支（提前 return，跳过采样块）长达 1.6 秒，
  // 血条被冻结在残留宽度，玩家看到的是「血条没见底就判死」。
  syncVitalsHud();
  document.exitPointerLock?.();
}

combat.onKill = (enemy) => {
  game.killed++;
  audio.kill();
  /**
   * 只掉落所持武器（带备弹）。
   *
   * 曾经额外 30% 掉一个独立的青色弹药方块，但它是个 0.4 vox 的纯色立方体，
   * 落在尸体上就是一坨突兀的蓝块 —— 读作「这里有东西」，实际只是弹药，
   * 而武器掉落本身已经带了备弹。视觉噪音大于信息量，去掉。
   */
  pickups.dropWeapon(enemy.pos, enemy.weapon.spec.id,
    enemy.weapon.ammo, Math.floor(enemy.weapon.spec.reserve * 0.25) || 20);

  if (game.killed >= game.totalEnemies) {
    game.extractReady = true;
    extractMesh.visible = true;
    updateObjectiveHud();
    toast('全部目标已清除 · 前往庭院撤离', 4000);
  }
};

/**
 * 手雷爆炸的伤害结算。玩家和敌人走同一套规则：
 * 都按距离衰减、都需要视线、都会被墙挡住。
 */
// 敌人枪声：按距离衰减。远处的交火声是玩家判断「那边有人」的重要情报。
combat.onEnemyShot = (spec, dist) => audio.shoot(spec.sound ?? 'medium', dist);

/**
 * 子弹打到门：累计伤害，打烂后门洞永久畅通。
 * 网格被改动了，所以要重建受影响的区块（mesher 每帧末会跑 rebuildDirty）。
 */
combat.onDoorHit = (gx, gy, gz, dmg) => {
  const door = doors.atCell(gx, gz);
  if (!door) return;
  if (door.damage(dmg)) {
    navigation.invalidateDoors();
    audio.door(true);
    toast('门被打烂了', 900);
  }
};

grenades.onExplode = (pos, ownerIsPlayer, spec = GRENADE) => {
  const dist = Math.hypot(pos.x - player.pos.x, pos.z - player.pos.z);
  audio.explosion(dist);
  cam.kick(spec.shake * Math.max(0.2, 1 - dist / Math.max(1, spec.radius)));

  if ((spec.blindSec ?? 0) > 0) {
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
    // 'blast'：爆炸是全方向的，不吃盾兵的正面护盾判定 ——
    // 手雷永远能对盾兵造成全额伤害，这是「绕侧或用手雷」的落地方式。
    const killed = e.takeDamage(d, 'torso', _blastDir, 'blast');
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

/**
 * 结算评级：剩余有效血量（生命+护甲，归一到 100 分制）+ 命中率×50
 *      + max(0, 20−用时分钟)×2
 * 血量上限从 120 改成 100+200=300 之后必须归一化，否则满血通关直接爆表。
 */
function calculateGrade() {
  const hpScore = (player.totalHp / player.totalHpMax) * 100;
  const score = hpScore + combat.accuracy * 50 +
    Math.max(0, 20 - game.elapsedTime / 60) * 2;
  return score >= 120 ? 'S' : score >= 98 ? 'A' : score >= 72 ? 'B' : 'C';
}

/**
 * 任务层终局结果 → SaveStore 事务层 outcome 的适配器。
 *
 * 任务层按「won / loot」描述终局（loot=null 表示空手或死亡），SaveStore
 * 按「success / extracted / carriedLoot」判定三种结算分支：
 *   · won + 带物 → success & extracted：返还风险物 + 携带物入库（全灭奖励 ×1.25）
 *   · won + 空手 → success & !extracted：撤离成功但 0 收益（空手撤离）
 *   · !won       → success=false：死亡/放弃，风险物与携带物全部丢失
 */
function toSaveStoreOutcome(settle, clearBonus) {
  const carriedLoot = [];
  if (settle.loot?.materials) {
    for (const [materialId, quantity] of Object.entries(settle.loot.materials)) {
      carriedLoot.push({ kind: 'material', materialId, quantity });
    }
  }
  // 材料仍以既有聚合计数器结算；统一实例中的非材料（武器/护甲/手雷/
  // 消耗品/配件/蓝图）原样交给 SaveStore，避免任何新类型在成功撤离时静默丢失。
  for (const item of (settle.carriedItems ?? [])) {
    const kind = item?.slotKind ?? item?.kind ?? item?.type;
    if (item && kind && kind !== 'material') carriedLoot.push(item);
  }
  return {
    success: !!settle.won,
    extracted: !!settle.won && carriedLoot.length > 0,
    carriedLoot,
    enemiesKilled: settle.killed ?? 0,
    clearBonus: !!clearBonus,   // 全灭（点亮撤离点）奖励：材料 ×1.25
  };
}

function endGame(won) {
  // 终局瞬间收起轮盘与局内背包：结算横幅不能盖在残留的双环或面板下
  // （撤离判定时玩家可能正握着 Q 或开着 Tab）。close 不触发回调。
  // 容器会话清理：结算只读 player.carriedLoot 视图，容器剩余物不入结算。
  quickWheel.close();
  closeRaidInventory({ silent: true });
  closeContainerSession(player.raidInventory);
  if (game.over) return;
  game.over = true;
  game.won = won;
  game.endTime = performance.now() / 1000;
  game.elapsedTime = game.endTime - game.startTime;
  const secs = Math.round(game.elapsedTime);
  const mins = Math.floor(secs / 60);
  const acc = combat.accuracy;
  const grade = calculateGrade();

  // ── 携带物汇总：按 itemId 合并数量（结算面板与存档共用同一份数据）──
  const lootMaterials = {};
  const lootNames = {};
  for (const item of player.carriedLoot) {
    const kind = item?.slotKind ?? item?.kind ?? item?.type;
    const materialId = item?.materialId ?? item?.itemId ?? (kind === 'material' ? item?.defId : null);
    if (!materialId || kind !== 'material') continue;
    lootMaterials[materialId] =
      (lootMaterials[materialId] || 0) + (item.quantity || 1);
    if (!lootNames[materialId] && item.name) lootNames[materialId] = item.name;
  }
  const hasLoot = player.carriedLoot.length > 0;
  const lootChips = Object.entries(lootMaterials).map(([id, n]) =>
    `<span class="loot-chip${won ? '' : ' lost'}">${lootNames[id] ?? id} ×${n}</span>`
  ).join('');

  /**
   * 结算事务（SaveStore 契约）：
   *   · 成功带货撤离 → carriedLoot 一次性合并入永久仓库（材料按 materialId 累加）；
   *   · 空手撤离     → 成功但 0 收益；
   *   · 死亡         → 携带物不入库（本局收获随实例一起丢弃）。
   * settleRaid 内部自己防重复提交、读不到 pendingRaid 时返回 ok:false ——
   * 结算过程绝不允许炸掉结算面板，所以这里只告警不抛错。
   */
  const settlePayload = {
    won,
    killed: game.killed,
    time: game.elapsedTime,
    grade,
    loot: hasLoot ? { materials: lootMaterials } : null,
    // 统一实例原样传给 SaveStore；其中 material 已在上面按旧计数器聚合，
    // adapter 会忽略重复材料，只保留非 material 类型。
    carriedItems: player.carriedLoot,
    stats: {
      shots: combat.stats.shots,
      hits: combat.stats.hits,
      headshots: combat.stats.headshots,
    },
  };
  try {
    const settleResult = saveStore.settleRaid(
      toSaveStoreOutcome(settlePayload, game.extractReady)
    );
    if (!settleResult?.ok) {
      console.error('[Main] settleRaid 失败:', settleResult?.error ?? 'no result');
    }
  } catch (err) {
    console.warn('[Main] settleRaid failed:', err);
  }

  // 难度写进结算：固定单一「标准」难度（原三档已合并）
  const diffTag = `<b style="color:#${D().color.toString(16)}">${D().name}</b>`;
  if (won) {
    hud.bannerTitle.textContent = hasLoot ? '成功撤离 · 带回物品' : '空手撤离 · 无收益';
    hud.bannerTitle.className = 'win';
    hud.bannerBody.innerHTML =
      `难度 ${diffTag} · 用时 <b>${mins}:${String(secs % 60).padStart(2, '0')}</b><br>` +
      `带回物品 <b>${player.carryCount}</b> 件 · 价值 <b>${player.carryValue}</b>` +
      (hasLoot ? '' : ' · 空手撤离 0 收益') + ` · 击杀奖励 <b>${game.killed}</b>` +
      `<br>命中率 <b>${(acc * 100).toFixed(0)}%</b> · ` +
      `爆头 <b>${combat.stats.headshots}</b> · ` +
      `剩余 <b>${player.hp} HP</b> / 护甲 <b>${player.armor}</b>` +
      `<br>评级 <b class="grade">${grade}</b>` +
      `<br><span class="hint-key">按 R 重开 · 按 B 回到简报</span>`;
  } else {
    const lostPrimaryCount = [loadout.slots[1], loadout.slots[2]].filter(Boolean).length;
    const lostArmor = loadoutManager.armor !== 'standard';
    hud.bannerTitle.textContent = '任务失败 · 主武器与携带物已丢失';
    hud.bannerTitle.className = 'lose';
    hud.bannerBody.innerHTML =
      `难度 ${diffTag} · 已击杀 <b>${game.killed}/${game.totalEnemies}</b> 个目标<br>` +
      (hasLoot
        ? `携带物已丢失 <b>${player.carryCount}</b> 件 · 价值 <b>${player.carryValue}</b> · `
        : '') +
      `命中率 <b>${(acc * 100).toFixed(0)}%</b><br>` +
      `<span style="color:var(--threat)">已丢失：主武器×${lostPrimaryCount} · ${lostArmor ? '护甲' : '护甲（未装备）'} · 携带物</span><br>` +
      `<span style="color:var(--good)">保留：手枪 · 已解锁蓝图 · 仓库材料</span><br>` +
      `<span class="hint-key">按 R 整关重启 · 按 B 返回任务大厅</span>`;
    // 死亡后当前护甲随风险装备丢失；重载直接跳过整备时必须回到标准护甲，
    // 否则 sessionStorage 中的 dualist 会错误地再次授予槽2权限。
    if (lostArmor) loadoutManager.setArmor('standard');
  }
  if (hud.bannerLoot) {
    hud.bannerLoot.innerHTML = lootChips;
    hud.bannerLoot.style.display = lootChips ? 'flex' : 'none';
  }
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
let pendingWeaponSwap = null;
let swapChoiceTimeout = null;
let fireDebug = '–';
/**
 * 轮盘 / 背包面板期间按住的左键被标记到此；关闭后必须松开重按才能开火
 * （防穿透：Q 轮盘松开确认不自动开火、Tab 关闭背包不恢复自动开火）。
 */
let wheelHeldFire = false;

function closeWeaponSwapChoice() {
  if (swapChoiceTimeout) clearTimeout(swapChoiceTimeout);
  swapChoiceTimeout = null;
  pendingWeaponSwap = null;
  if (hud.weaponSwapChoice) hud.weaponSwapChoice.style.display = 'none';
}

function showWeaponSwapChoice(pickup) {
  if (!pickup || pendingWeaponSwap) return;
  pendingWeaponSwap = pickup;
  const first = loadout.slots[1]?.spec?.name ?? '空';
  const second = loadout.slots[2]?.spec?.name ?? '空';
  if (hud.swapSlot1) {
    const name = hud.swapSlot1.querySelector('#swap-slot1-name');
    if (name) name.textContent = first;
  }
  if (hud.swapSlot2) {
    const name = hud.swapSlot2.querySelector('#swap-slot2-name');
    if (name) name.textContent = second;
  }
  if (hud.weaponSwapChoice) hud.weaponSwapChoice.style.display = 'flex';
  document.exitPointerLock?.();
  swapChoiceTimeout = setTimeout(() => {
    closeWeaponSwapChoice();
    toast('已取消拾取', 1200);
  }, 3000);
}

function chooseWeaponSwapSlot(targetSlot) {
  if (!pendingWeaponSwap) return;
  const pickup = pendingWeaponSwap;
  const result = pickups.takeWeaponToSlot(pickup, loadout, player, performance.now() / 1000, targetSlot);
  if (result.ok) {
    audio.pickup();
    toast(`替换槽${targetSlot} · ${result.spec.name}`);
    nearWeapon = null;
    // 批 5.1：拾取/替换后把该槽武器镜像进局内 equipment 视图
    // （结算 / carriedLoot 同源；掉落物沿用同一 loot id）。
    mirrorPickedPrimaryWeapon(pickup, targetSlot);
  }
  closeWeaponSwapChoice();
  if (canvas.requestPointerLock) {
    try { canvas.requestPointerLock()?.catch?.(() => {}); } catch { /* 等待下一次点击 */ }
  }
}

hud.swapSlot1?.addEventListener('click', () => chooseWeaponSwapSlot(1));
hud.swapSlot2?.addEventListener('click', () => chooseWeaponSwapSlot(2));
hud.swapCancel?.addEventListener('click', closeWeaponSwapChoice);

/**
 * 局内拾取主武器 → raidInventory.equipment.primary 镜像（批 5.1 修复）。
 *
 * 真源不变：Loadout.slots 仍是战斗真源（拾取/替换/切枪都写在 Loadout）。
 * 这里在每次 pickup / replace 之后把对应槽的武器镜像成 ItemInstance
 * （instanceId + ammo/reserve/attachments）写进局内 equipment 视图——
 * 否则 getCarriedItems / carriedLoot / 结算看不到本局拾取的枪。
 *
 * 实例身份：
 *   · 拾取物（地面/敌人掉落）没有稳定 instanceId —— 首捡时生成唯一
 *     loot id 并固定在 pickup payload 上，替换/掉落路径沿用同一 id；
 *   · 被替换下来的原实例随 replaced 返回：原武器已被 pickups 内部掉在
 *     地上（items 末尾的新拾取物），把它的 instanceId 回写到掉落物
 *     payload，保证「捡起 / 再掉落 / 再捡起」仍是同一把枪；
 *   · 原实例是本局带入风险物（payload.raidOrigin='loadout'）时，返还
 *     仍由 pendingRaid.riskedItems 决定 —— 绝不重复入库、绝不丢失。
 * @param {object} pickup     被拾取的 Pickup 对象（payload 承载 loot id）
 * @param {number} slotIndex  拾取后的主武器槽（1|2）
 */
function mirrorPickedPrimaryWeapon(pickup, slotIndex) {
  if (!pickup || !player.raidInventory) return null;
  const payload = pickup.payload ?? (pickup.payload = {});
  const instanceId = payload.instanceId
    ?? (payload.instanceId = nextLootInstanceId());
  // 捡回「带入风险物掉落后重捡」时保留 raidOrigin 标记：该实例身份 = 风险
  // instanceId，归还由 pendingRaid.riskedItems 决定，不再作为本局收益入库。
  const riskedIds = saveStore.getPendingRaid()?.riskedItems ?? {};
  const res = mirrorPrimaryFromLoadout(
    player.raidInventory, loadout, slotIndex,
    { instanceId, raidOrigin: riskedIds[instanceId] ? 'loadout' : undefined }
  );
  if (!res?.ok) return res;
  // 被替换实例离开 equipment 视图 → 把同一身份回写到刚掉落的拾取物
  // （pickups 内部 dropWeapon 是同步执行的，掉落在 items 末尾），
  // 使得掉落 / 再拾取 / 结算全程一个 instanceId，不会出现双份入库。
  if (res.replaced) {
    const dropped = pickups.items[pickups.items.length - 1];
    if (dropped && dropped.kind === 'weapon' && dropped.payload
      && !dropped.payload.instanceId) {
      dropped.payload.instanceId = res.replaced.instanceId;
    }
  }
  return res;
}
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
    /**
     * 简报阶段也必须每帧消费输入。曾经这里提前 return，pressed / clicked /
     * 鼠标增量在整个简报期间不断累积 —— 开局第一帧把简报里按过的所有键
     * （翻页用的 Enter、方向键，甚至点卡片的鼠标）一次性全部触发：
     * 手电自己打开、手雷凭空扔出、镜头猛甩一截。「按一个键像按了全部」
     * 的观感就来自这里。
     */
    input.endFrame();
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
    lights.update(dt, player.pos.x, player.pos.y, player.pos.z);
    grenades.update(dt);
    renderer.render(scene, cam.cam);
    if (game.deathHold <= 0) endGame(false);
    input.endFrame();
    requestAnimationFrame(frame);
    return;
  }

  if (!game.over) {
    if (pendingWeaponSwap) {
      // 弹窗内保留 1/2 作为局部选槽快捷键；仍通过动作层读取，避免业务散落裸 code。
      if (input.justPressed('weaponSlot0')) chooseWeaponSwapSlot(1);
      else if (input.justPressed('weaponSlot1')) chooseWeaponSwapSlot(2);
      else if (input.justPressed('cancel')) {
        closeWeaponSwapChoice();
        toast('已取消拾取', 1200);
      } else {
        // 选择期间暂停战斗与移动，避免弹窗打开时仍可射击或被敌人推进状态。
        renderer.render(scene, cam.cam);
        input.endFrame();
        requestAnimationFrame(frame);
        return;
      }
    }

    // ── 局内背包面板：Tab 切换，Q 轮盘互斥，不暂停世界 ──────────────────
    // 打开/关闭只切换 game.inventoryOpen 与面板 DOM；世界照常推进，
    // 这里不写任何 `if (game.inventoryOpen) return` —— 面板打开时敌人会
    // 继续移动、门会关、容器会刷新、手雷仍会飞向落点、计时与撤离照常。
    // Esc 关闭沿 cancel 动作（与轮盘同一语义：取消当前模态而不是开枪）。
    // pendingWeaponSwap 在上面的分支里提前 return，所以换枪弹窗优先级
    // 高于面板 —— 面板打开时 E 被屏蔽，也不会反向打开换枪弹窗。
    if (input.justPressed('inventory')) {
      if (game.inventoryOpen) closeRaidInventory();
      else openRaidInventory();
    } else if (game.inventoryOpen && input.justPressed('cancel')) {
      closeRaidInventory();
    }

    // ── Quick Wheel：Q 按住打开，松开确认，仅执行一次 ────────────────────
    // 打开不暂停世界：敌人、门、计时、撤离、开火后的手雷飞行全部继续 tick，
    // 这里只屏蔽「玩家侧」动作（射击/瞄准/交互/翻滚等），避免输入穿透。
    // 确认时序只用 justPressed（打开）+ releasedAny（松开确认 + close），
    // 不在同帧重复判 releasedShort/releasedLong —— 两者是时长二选一，放开
    // 用 releasedAny 合并读法，确认/取消后 quickWheel.isOpen 立即为 false。
    // 背包面板打开时 Q 不可用（互斥；不会把 Q 吞进面板后再投雷）。
    if (!quickWheel.isOpen && !game.inventoryOpen && input.justPressed('quickWheel')) {
      quickWheel.openWith(quickUseWheelItems());
    }
    if (quickWheel.isOpen) {
      // 指针锁定下鼠标是增量：平滑累积成方向向量喂给轮盘；
      // nowMs 供中央取消的连续保持计时使用（与帧时间戳同基）
      quickWheel.updateFromMouse(input.mouseDX, input.mouseDY, nowMs);
      if (input.down('fire')) wheelHeldFire = true;   // 按住左键 = 穿透隐患，先标记
      if (input.justClicked(2) || input.justPressed('cancel')) {
        quickWheel.cancel();          // 右键 / Esc：取消且不消耗
      } else if (input.releasedAny('quickWheel')) {
        quickWheel.confirmSelection(); // 松开确认：onConfirm(index) 或 onCancel
      }
    }
    const wheelOpen = quickWheel.isOpen;
    // 面板打开时相机不接收鼠标增量（不旋转视角）；世界仍在 tick。
    const invOpen = game.inventoryOpen;

    if (!wheelOpen && !invOpen) {
      cam.addMouse(input.mouseDX, input.mouseDY);
      cam.aiming = input.down('aim') && !player.rolling;
    } else {
      cam.aiming = false;             // 轮盘 / 背包面板打开时禁止 ADS
    }

    // AudioContext 必须由用户手势创建，否则浏览器会把它挂成静音
    if (input.locked || input.down('fire') || input.down('aim')) audio.init();

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
    // V 键切换第一/第三人称；X 只切第三人称左右肩，不改变视角模式。
    if (input.justPressed('viewToggle')) {
      const fp = cam.toggleView();
      player.rig.setFirstPerson(fp);
      hud.view.textContent = fp ? '1ST' : '3RD';
      toast(fp ? '第一人称' : '第三人称', 1000);
    }
    if (input.justPressed('shoulder')) {
      const shoulder = cam.toggleShoulder();
      if (!cam.firstPerson) toast(shoulder > 0 ? '右肩视角' : '左肩视角', 800);
    }
    if (input.justPressed('debug')) {
      hud.stats.style.display = hud.stats.style.display === 'none' ? '' : 'none';
    }
    // 面板快捷键层：背包面板的 Tab/Esc 已在上方处理，这里只留未落地的地图占位。
    if (input.justPressed('map')) game.mapOpen = !game.mapOpen;
    // H 收起 / 展开小地图。想完全靠记路的人可以关掉它。
    if (input.justPressed('minimap')) {
      minimapOn = !minimapOn;
      hud.minimap.classList.toggle('off', !minimapOn);
      if (minimapOn) { mmHereId = undefined; updateMinimap(); }
    }

    // 武器切换与手雷在轮盘 / 背包面板打开期间屏蔽（避免乱切枪/误投）。
    if (!wheelOpen && !invOpen) {
      // 武器切换：数字键直达槽0/1/2，滚轮按可用且非空槽循环。
      if (input.justPressed('weaponSlot0')) loadout.switchTo(0, now);
      if (input.justPressed('weaponSlot1')) loadout.switchTo(1, now);
      if (input.justPressed('weaponSlot2')) loadout.switchTo(2, now);
      if (input.wheel !== 0) loadout.toggle(now);

      // ── G 过渡入口：投掷「当前选中 QuickUse 槽」的手雷 ──
      // 批 2 起 G 与 Q 轮盘共用同一真源：投掷成功才 consumeQuickUse 扣减，
      // game.nades 不再被任何扣减路径写入。
      if (input.justPressed('grenade')) {
        throwGrenadeFromQuickUse(getQuickUseSelectedIndex(player.raidInventory));
      }
    }

    // 轮盘打开只屏蔽翻滚；背包面板打开屏蔽全部战斗/移动/姿态输入
    // （移动、跳跃、蹲伏、翻滚、侧倾、交互），避免输入穿透到世界。
    player.update(dt,
      invOpen ? INVENTORY_PLAYER_INPUT : (wheelOpen ? WHEEL_PLAYER_INPUT : input),
      cam);
    setPlayerPosCache(player.pos);
    if (player.hitStun > 0) player.hitStun -= dt;
    // 脚步：按累积移动距离触发，慢走/蹲行会更轻更稀
    audio.updateFootsteps(player.pos, player.stance, player.body.onGround);

    // ── 射击 ──
    loadout.update(now, dt);
    const weapon = loadout.current;

    cam.update(dt, {
      x: player.pos.x, z: player.pos.z,
      feetY: player.pos.y, height: player.body.height,
      leanAmt: player.leanAmt,
      adsTime: weapon?.spec?.adsTime ?? 0.25,
    });

    // 枪灯跟随视角
    const { pos } = player.muzzle();
    cam.cam.getWorldDirection(_camDir);
    flashlight.update(pos, _camDir);
    const canAct = !loadout.switching && player.hitStun <= 0;
    // 左键一旦松开就解除拦截；轮盘 / 背包面板期间按住过就保持拦截到重按：
    // 松开重按口径与 Q 轮盘完全一致，模态期间的按住绝不穿透成开火。
    if (!input.down('fire')) wheelHeldFire = false;
    else if (wheelOpen || invOpen) wheelHeldFire = true;

    if (!wheelOpen && !invOpen && weapon && canAct && !player.rolling) {
      // 全自动按住连发；半自动必须逐次点击。
      const wantFire = !wheelHeldFire
        && (weapon.spec.auto ? input.down('fire') : input.justPressed('fire'));
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
      if (input.justPressed('reload')) weapon.startReload(now);
      if (weapon.isEmpty && weapon.canReload) weapon.startReload(now);
      if (!wasReloading && weapon.reloading) audio.reload();
    } else if (input.down('fire') || input.justPressed('fire')) {
      // 轮盘 / 背包面板打开时按下开火不会打出子弹；HUD 调试列区分原因
      fireDebug = wheelOpen ? 'WHEEL'
        : invOpen ? 'INVENTORY'
        : player.rolling ? 'ROLLING' : loadout.switching ? 'SWITCHING' : 'STUNNED';
    }

    // ── 敌人 ──
    // doors 传给敌人：搜房时会自己推门进出（见 Enemy.tryOpenDoor）
    const ctx = { player, flashlight, combat, enemies, doors };
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
    // 门交互统一走 E 短按；X 已迁移为左右肩视角。门在体素网格里是实心方块，
    // 开关会改动网格，所以下面统一调用 mesher.rebuildDirty() 重建受影响的区块。
    const nearDoor = doors.nearest(
      player.pos.x, player.pos.y + 1, player.pos.z, 2.2
    );
    doors.update(dt);

    // ── 掠夺容器（战利品箱）──
    lootContainers.update(dt, now);
    const nearLoot = lootContainers.nearest(
      player.pos.x, player.pos.y, player.pos.z
    );
    const nearOpenable = openableFurniture.nearest(
      player.pos.x, player.pos.y, player.pos.z
    );
    openableFurniture.update(dt);

    // ── 手雷 ──
    grenades.update(dt);

    // ── 拾取 ──
    nearWeapon = pickups.update(dt, player, loadout, now, (msg) => {
      audio.pickup();
      toast(msg);
    });
    // 交互在轮盘 / 背包面板打开期间屏蔽（E 释放不穿透成开门/搜刮）。
    if (!wheelOpen && !invOpen) {
      // 长按 E 达到阈值时拾取；槽位全满则仅打开选择框，不消耗地面物。
      if (nearWeapon && input.longPress('interact', 0.4)) {
        const result = pickups.takeWeaponAuto(nearWeapon, loadout, player, now);
        if (result.ok) {
          audio.pickup();
          toast(`拾取 ${result.spec.name}`);
          nearWeapon = null;
          // 批 5.1：pickUpAuto 落格后 active 就是目标槽 —— 镜像进局内
          // equipment 视图，结算 / carriedLoot 才看得到这把新枪。
          mirrorPickedPrimaryWeapon(nearWeapon, loadout.active);
        } else if (result.needChoice) {
          showWeaponSwapChoice(nearWeapon);
        }
      }
      // E 短按在释放时才交互，避免与长按拾取同时触发；门使用专用动作别名。
      if (input.releasedShort('interactDoor', 0.4)) {
        if (nearDoor) toggleDoor(nearDoor);
        else if (nearLoot) interactLootContainer(nearLoot);
        else if (nearOpenable) interactOpenableFurniture(nearOpenable);
      }
    }

    // ── 交互提示 ──
    // 背包 / 轮盘打开时 E 世界交互被屏蔽（INVENTORY_PLAYER_BLOCK / 门控），
    // 绝不显示「按 E 但按不动」的提示：背包打开改提示 Tab 关闭，轮盘打开隐藏。
    const hints = [];
    if (invOpen) {
      hints.push('<b>Tab</b> 关闭背包');
    } else if (!wheelOpen) {
      // 按 E 的对象遵循 Door > LootContainer > Furniture
      if (nearDoor) {
        hints.push(`<b>E</b> ${nearDoor.open ? '关门' : '开门'}`);
      }
      if (nearWeapon && !pendingWeaponSwap) {
        hints.push(`<b>长按 E</b> 拾取 ${WEAPONS[nearWeapon.payload.weapon]?.name ?? '武器'}`);
      }
      if (nearLoot && !nearDoor) {
        hints.push(
          `<b>E</b> ${nearLoot.opened ? '搜刮' : '打开'}${nearLoot.style.label}箱` +
          (nearLoot.opened && nearLoot.loot.length > 0
            ? ` · 剩 ${nearLoot.loot.length} 件` : '')
        );
      } else if (nearOpenable && !nearDoor && !nearLoot) {
        hints.push(`<b>E</b> ${nearOpenable.open ? '关闭' : '搜查'}${openableFurniture.label(nearOpenable)}`);
      }
    }
    hud.prompt.style.display = hints.length ? 'block' : 'none';
    if (hints.length) hud.prompt.innerHTML = hints.join('<br>');

    // ── 撤离判定 ──
    if (game.extractReady) {
      const d = Math.hypot(player.pos.x - SPAWN.x, player.pos.z - SPAWN.z);
      updateObjectiveHud(d);
      if (d < 1.6) endGame(true);
      extractMesh.material.opacity = 0.6 + Math.sin(now * 4) * 0.35;
    }
  } else if (input.justPressed('restart')) {
    // 立刻重开：跳过简报（已经读过一遍了，再看一遍是噪声）
    sessionStorage.setItem('skipBrief', '1');
    location.reload();
  } else if (input.justPressed('backToBrief')) {
    // 回到简报：重新读情报
    sessionStorage.removeItem('skipBrief');
    location.reload();
  }

  effects.update(dt);
  flashPool.update(dt);
  // 应急灯：闪烁 + 把有限的真光源分配给离玩家最近的几盏
  lights.update(dt, player.pos.x, player.pos.y, player.pos.z);
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

  updateWeaponHud(now);
  const alive = enemies.filter((e) => !e.dead).length;
  updateObjectiveHud();
  // 收尾提示（一次）：剩下的敌人全图亮标，玩家不会再找不到人、无法通关
  if (!game.revealed && alive > 0 && alive <= 3) {
    game.revealed = true;
    toast('剩余目标已暴露 · 肃清他们', 2600);
  }
  hud.dbgShots.textContent = String(combat.stats.shots);
  hud.dbgHits.textContent = String(combat.stats.hits);
  hud.dbgFire.textContent = fireDebug;
  hud.dbgKeys.textContent = String(input.keyEventCount);

  // 小地图每帧更新（只改一个 transform，开销可忽略）。
  // 不放进 0.35 秒采样块：那样箭头会一跳一跳，转身时尤其明显。
  try { updateMinimap(); } catch { /* 小地图绝不能把主循环带崩 */ }

  fpsAccum += dt; fpsFrames++;
  if (fpsAccum >= 0.35) {
    hud.fps.textContent = String(Math.round(fpsFrames / fpsAccum));
    fpsAccum = 0; fpsFrames = 0;
    hud.pos.textContent =
      `${player.pos.x.toFixed(1)} ${player.pos.y.toFixed(1)} ${player.pos.z.toFixed(1)}`;
    hud.stance.textContent =
      player.stance === 'crouch' ? 'CROUCH'
        : player.stance === 'slow' ? 'SLOW'
        : player.stance === 'sprint' ? 'SPRINT' : 'NORMAL';
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
function updateWeaponHud(now = performance.now() / 1000) {
  const entries = [
    { index: 0, root: hud.ammoSlotPistol, name: hud.weapon, ammo: hud.ammo,
      reserve: hud.ammoReserve, reload: hud.reload, bar: hud.reloadBar },
    { index: 1, root: hud.ammoSlot1, name: hud.weapon1, ammo: hud.ammo1,
      reserve: hud.ammoReserve1, reload: hud.reload1, bar: hud.reloadBar1 },
    { index: 2, root: hud.ammoSlot2, name: hud.weapon2, ammo: hud.ammo2,
      reserve: hud.ammoReserve2, reload: hud.reload2, bar: hud.reloadBar2 },
  ];
  for (const entry of entries) {
    const weapon = loadout.slots[entry.index];
    if (!entry.root) continue;
    const visible = entry.index === 0 || (entry.index <= loadout.maxPrimarySlots && !!weapon);
    entry.root.style.display = visible ? 'block' : 'none';
    entry.root.classList.toggle('active', loadout.active === entry.index);
    if (!weapon || !visible) continue;
    entry.name.textContent = weapon.spec.short;
    entry.name.style.color = `#${weapon.spec.color.toString(16).padStart(6, '0')}`;
    entry.ammo.textContent = String(weapon.ammo);
    entry.reserve.textContent = weapon.reserve === Infinity ? '∞' : String(weapon.reserve);
    if (weapon.reloading) {
      entry.reload.style.display = 'block';
      entry.bar.style.width = `${(weapon.reloadProgress(now) * 100).toFixed(0)}%`;
    } else {
      entry.reload.style.display = 'none';
    }
  }
  const current = loadout.current;
  if (current) player.rig.setGun(current.spec.id);
}

function syncVitalsHud() {
  hud.hpFill.style.width = `${(player.hp / player.hpMax) * 100}%`;
  hud.armorFill.style.width = `${(player.armor / player.armorMax) * 100}%`;
  hud.hpText.innerHTML = player.armor > 0
    ? `${player.hp} / ${player.hpMax} · <b>护甲 ${player.armor}</b>`
    : `${player.hp} / ${player.hpMax} · 护甲已破`;
  hud.hpBar.classList.toggle('low', player.lowHp && !player.dead);
  // 手雷 HUD 直读 QuickUse 真源（当前选中槽）；game.nades 只是只读兼容投影。
  const grenadeItem = player.raidInventory?.quickUse?.[getQuickUseSelectedIndex(player.raidInventory)];
  const grenadeQty = grenadeItem?.slotKind === 'grenade' ? (grenadeItem.quantity ?? 0) : 0;
  hud.nadeCount.textContent = String(grenadeQty);
  hud.nadeBox.classList.toggle('empty', grenadeQty === 0);
  if (hud.nadeKind) hud.nadeKind.textContent = grenadeItem?.name ?? '手雷';
  /**
   * 「剩余敌人」也在这里刷。它原来只在帧循环的 0.35 秒采样块里更新，
   * 而简报阶段那个块不执行 —— 玩家在简报界面看到的是 index.html 里的
   * 占位符「– / –」，一进游戏才突然跳出真数字。现在启动即为真值，
   * 且与 game.totalEnemies（= 实际生成的敌人数）同源。
   */
  updateObjectiveHud();
}
syncVitalsHud();

/**
 * 携带栏 HUD：数量 / 上限 / 总价值。任何战利品变动（开箱、搜刮）后立刻刷一次，
 * 不等 0.35 秒采样块 —— 搜刮是「一按一个结果」，反馈必须立即可见。
 */
function syncCarryHud() {
  if (!hud.carryCurrent) return;
  hud.carryCurrent.textContent = String(player.carryCount);
  if (hud.carryMax) hud.carryMax.textContent = String(player.carryCap);
  if (hud.carryValue) hud.carryValue.textContent = `价值 ${player.carryValue}`;
  hud.carryBox?.classList.toggle('full', player.carryFull);
}

/**
 * 交互核心：开箱 → 建立容器会话 → 打开并列面板（批 4）。
 * 第一次 E：container.open() 只生成一次战利品（重复调用返回同一份 loot），
 * openContainerSession 建立当前会话（items 与 container.loot 同一引用），
 * 随后打开同一个小背包面板进入「容器 + 装备 + 背包 + 快捷栏」并列模式。
 * 不再自动逐件塞入 carriedLoot：拿取由玩家在面板里逐件决定，
 * 装不下的留在箱内且不进入结算（应计数据必须在拿走那一刻才成立）。
 * 已打开未拿空的箱子再次按 E：重新建立/复用同一会话（不重新生成），
 * 玩家可以多次打开同一箱，直到拿空。
 */
function interactLootContainer(container) {
  if (!container) return;
  const session = openContainerSession(player.raidInventory, container);
  if (!session) {
    toast('无法打开容器', 1400);
    return;
  }
  // 本局已掉蓝图计入排除集：后续开的箱子不再掉同一张（避免局内重复掉落，
  // 结算端虽幂等去重，但不生成无效重复物本身就是掉落通道的职责）。
  for (const item of session.items) {
    if ((item?.slotKind ?? item?.kind) === 'blueprint') {
      blueprintDropExclude.add(item.blueprintId ?? item.defId);
    }
  }
  audio.pickup();
  openRaidInventory();
  syncCarryHud();
}

function interactOpenableFurniture(item) {
  const open = openableFurniture.toggle(item);
  toast(`${openableFurniture.label(item)}${open ? '已打开 · 已搜查' : '已关闭'}`, 900);
}

requestAnimationFrame(frame);

window.__game = {
  world, player, cam, flashlight, scene, renderer, mesher,
  enemies, combat, loadout, pickups, lootContainers, openableFurniture, game, effects, doors, lights,
  navigation, saveStore,
  quickWheel, raidInventoryView,
  throwGrenadeFromQuickUse,
  /** 批 3 接线急救包效果的回调注册表；未注册前 consumable 确认只提示不扣除。 */
  setOnUseConsumable: (fn) => { onUseConsumable = fn; },
};
