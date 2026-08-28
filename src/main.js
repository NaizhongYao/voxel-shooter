import * as THREE from 'three';
import { RENDER, LIGHT, PLAYER, WORLD, PALETTE, GRENADE, GRENADES, grenadeInventory } from './config.js';
import {
  DIFFICULTIES, DIFFICULTY_ORDER, resolveDifficulty, setDifficulty, D,
} from './difficulty.js';
import { buildLevel01, SPAWN, DOORS, MAIN_ENTRANCE, ROOMS, BUILDING } from './level/level01.js';
import { DoorManager } from './systems/doors.js';
import { ENEMY_SPAWNS, ENEMY_COUNT_BY_TIER, MEDKIT_SPAWNS, WEAPON_SPAWNS } from './level/spawns.js';
import { VoxelMesher } from './voxel/mesher.js';
import { Player } from './player/player.js';
import { OrbitFollowCamera } from './player/camera.js';
import { Flashlight, FlashPool, EnemyFlashlights } from './systems/flashlight.js';
import { Input } from './systems/input.js';
import { Loadout, WEAPONS } from './systems/weapons.js';
import { Effects } from './systems/effects.js';
import { Enemy, setPlayerPosCache, STATE } from './systems/enemy.js';
import { Combat } from './systems/combat.js';
import { PickupManager, KIND } from './systems/pickups.js';
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
  hint: $('hint'), hintCount: $('hint-count'), briefCount: $('brief-count'),
  nadeKind: $('nade-kind'), flashWhite: $('flash-white'), miniMap: $('mini-map'),
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
const world = buildLevel01();
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
  if (!q) return SPAWN;
  const n = q.split(',').map(Number);
  if (n.length < 2 || n.some((v) => !Number.isFinite(v))) return SPAWN;
  return { x: n[0], y: n.length > 2 ? n[2] : SPAWN.y, z: n[1] };
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
// 人数以 ENEMY_COUNT_BY_TIER 为准。
const activeSpawns = ENEMY_SPAWNS.filter((s) => s.tier <= D().enemyTier);
const enemies = activeSpawns.map((s) => {
  const e = new Enemy(world, s);
  scene.add(e.rig.root);
  return e;
});
player.blockers = enemies;

// 敌人手电：光源池按距离分配给最近的几个敌人（12 个真光源会拖死帧率）
const enemyLights = new EnemyFlashlights(scene);
// 头顶状态指示器：玩家判断「我被发现了吗」的唯一可靠信息源
const indicators = new EnemyIndicators(scene, enemies);

// 门：关闭时像墙一样挡光挡视线挡子弹（写进体素网格）
const doors = new DoorManager(scene, world, DOORS);
// 主入口默认敞开：玩家出生在庭院正对这两扇门，开局撞在关着的门上体验很差，
// 敞开的门同时也是「往这里走」的视觉引导。
doors.openAt(MAIN_ENTRANCE);
// 门改写了网格，需要重建一次几何
mesher.rebuildDirty();

const combat = new Combat(world, effects, flashPool, enemies);
const grenades = new GrenadeSystem(scene, world, effects, flashPool);
const audio = new Audio();
const pickups = new PickupManager(scene, world);
for (const m of MEDKIT_SPAWNS) pickups.add(KIND.MEDKIT, m, {});
for (const w of WEAPON_SPAWNS) pickups.add(KIND.WEAPON, w, { weapon: w.weapon });

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
};

// ── 任务简报 + 难度选择 ────────────────────────────────────────────────
/**
 * 难度卡片。点击即切换（重载页面），因为难度参数必须在创建玩家/敌人
 * 之前确定，运行时热切换会留下新旧混合的状态。
 */
function buildDifficultyCards() {
  hud.diffs.innerHTML = '';
  for (const id of DIFFICULTY_ORDER) {
    const d = DIFFICULTIES[id];
    const el = document.createElement('div');
    el.className = 'diff' + (d.id === D().id ? ' on' : '');
    const hex = `#${d.color.toString(16).padStart(6, '0')}`;
    el.innerHTML =
      `<div class="dn" style="color:${hex}">${d.name}</div>` +
      `<div class="ds">${d.subtitle}</div>` +
      `<div class="dd">${d.desc}</div>` +
      `<div class="dstat">生命 ${d.hpMax} · 护甲 ${d.armorMax} · ` +
      `手雷 ${d.grenades}<br>敌人 ${ENEMY_COUNT_BY_TIER[d.enemyTier]} 人 · ${d.enemyHp} HP · ` +
      `视野 ×${d.visionRangeMul} · 指示器 ${d.indicatorRange} vox</div>`;
    el.addEventListener('click', () => {
      if (d.id === D().id) return;
      // 保留 spawn 等其它调试参数，只替换 diff
      const q = new URLSearchParams(location.search);
      q.set('diff', d.id);
      location.search = q.toString();
    });
    hud.diffs.appendChild(el);
  }
  // 简报/点击进入提示里的敌人数量跟着当前难度走——「12」不再是硬编码的
  // 事实，是 D().enemyTier 对应的那个数字。
  const n = ENEMY_COUNT_BY_TIER[D().enemyTier];
  if (hud.hintCount) hud.hintCount.textContent = n;
  if (hud.briefCount) hud.briefCount.textContent = n;
}
buildDifficultyCards();

function drawMiniMap() {
  const svg = hud.miniMap;
  if (!svg) return;
  const names = {
    bedroom: '卧室', northHall: '北走道', study: '书房',
    westStore: '西储', warehouse: '仓库', eastStore: '东储',
    corridor: '走廊', southHall: '南过道', living: '客厅', foyer: '门厅', kitchen: '厨房',
  };
  const fills = {
    foyer: '#3d4a3a', warehouse: '#2b3d4d', corridor: '#24303c',
    southHall: '#24303c', living: '#3a3344', kitchen: '#3a3a32',
    bedroom: '#3a3040', study: '#3a3040', westStore: '#32363c', eastStore: '#32363c',
    northHall: '#2c343c',
  };
  const flip = (z) => 64 - z;
  const wall = BUILDING;
  let html = `<rect x="0" y="0" width="64" height="70" fill="#0a0e14"/>`;
  html += `<rect x="1" y="${flip(63)}" width="62" height="14" fill="#151c24" stroke="#2a3440" stroke-width="0.3"/>`;
  html += `<rect x="${wall.x0 - 2}" y="${flip(wall.z1 + 2)}" width="${wall.x1 - wall.x0 + 4}" height="${wall.z1 - wall.z0 + 4}" fill="#1a222c"/>`;
  for (const [id, r] of Object.entries(ROOMS)) {
    const y = flip(r.z1);
    const h = r.z1 - r.z0;
    const cx = (r.x0 + r.x1) / 2;
    const cy = y + h / 2 + 0.6;
    html += `<rect data-room="${names[id]}" x="${r.x0}" y="${y}" width="${r.x1 - r.x0}" height="${h}" fill="${fills[id] || '#2d3a4a'}" stroke="#5a6a78" stroke-width="0.2"/>`;
    html += `<text x="${cx}" y="${cy}" text-anchor="middle" fill="#c5d0da" font-size="${id === 'corridor' || id === 'southHall' || id === 'northHall' ? 2.1 : 2.4}" font-family="Consolas,monospace">${names[id]}</text>`;
  }
  html += `<rect x="31" y="${flip(48)}" width="2" height="2" fill="#3fb96f"/>`;
  html += `<rect x="31" y="${flip(7)}" width="2" height="2" fill="#4cc9f0"/>`;
  html += `<rect x="5" y="${flip(21)}" width="2" height="2" fill="#4cc9f0"/>`;
  html += `<rect x="56" y="${flip(21)}" width="2" height="2" fill="#4cc9f0"/>`;
  html += `<circle cx="32.5" cy="${flip(58.5)}" r="1.4" fill="#f5a623" stroke="#fff" stroke-width="0.25"/>`;
  html += `<text x="32.5" y="${flip(52)}" text-anchor="middle" fill="#f5a623" font-size="2.3">你</text>`;
  html += `<text x="32" y="${flip(3)}" text-anchor="middle" fill="#4cc9f0" font-size="2.2">N 后门</text>`;
  html += `<text x="32" y="68.5" text-anchor="middle" fill="#8b93a3" font-size="2.1">S 南庭院</text>`;
  svg.innerHTML = html;
  svg.querySelectorAll('rect[data-room]').forEach((el) => {
    el.addEventListener('mouseenter', () => {
      const cap = document.getElementById('map-cap');
      if (cap) cap.textContent = el.getAttribute('data-room') + ' · 南门正对你，北墙是后门';
    });
  });
}
drawMiniMap();

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

function startMission() {
  if (game.started) return;
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
    // 头顶状态指示器：用相机位置做距离裁剪（第三人称下相机才是"眼睛"）
    indicators.update(cam.cam.position, now, dt);

    // ── 门 ──
    // E 键开关最近的门。门在体素网格里是实心方块，开关会改动网格，
    // 所以下面统一调用 mesher.rebuildDirty() 重建受影响的区块。
    const nearDoor = doors.nearest(
      player.pos.x, player.pos.y + 1, player.pos.z, 2.2
    );
    if (nearDoor && input.pressed.has('KeyE')) {
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
