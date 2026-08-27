import * as THREE from 'three';
import { RENDER, LIGHT, PLAYER, WORLD, PALETTE } from './config.js';
import { buildLevel01, SPAWN } from './level/level01.js';
import { ENEMY_SPAWNS, MEDKIT_SPAWNS, WEAPON_SPAWNS } from './level/spawns.js';
import { VoxelMesher } from './voxel/mesher.js';
import { Player } from './player/player.js';
import { OrbitFollowCamera } from './player/camera.js';
import { Flashlight, FlashPool } from './systems/flashlight.js';
import { Input } from './systems/input.js';
import { Loadout, WEAPONS } from './systems/weapons.js';
import { Effects } from './systems/effects.js';
import { Enemy, setPlayerPosCache, STATE } from './systems/enemy.js';
import { Combat } from './systems/combat.js';
import { PickupManager, KIND } from './systems/pickups.js';

const canvas = document.getElementById('game');
const $ = (id) => document.getElementById(id);
const hud = {
  fps: $('fps'), pos: $('pos'), stance: $('stance'), light: $('light'),
  hpFill: $('hp-fill'), hpText: $('hp-text'),
  ammo: $('ammo'), ammoReserve: $('ammo-reserve'), weapon: $('weapon-name'),
  enemies: $('enemy-count'), crosshair: $('crosshair'),
  reload: $('reload'), reloadBar: $('reload-bar'),
  toast: $('toast'), damage: $('damage-flash'),
  dbgShots: $('dbg-shots'), dbgHits: $('dbg-hits'), dbgFire: $('dbg-fire'),
  banner: $('banner'), bannerTitle: $('banner-title'), bannerBody: $('banner-body'),
  prompt: $('prompt'), stats: $('stats'), boot: $('boot'),
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
const player = new Player(world, SPAWN);
scene.add(player.rig.root);

const cam = new OrbitFollowCamera(world);
cam.resize(window.innerWidth, window.innerHeight);

const flashlight = new Flashlight(scene, world);
const flashPool = new FlashPool(scene);
const effects = new Effects(scene, world);
const input = new Input(canvas);
const loadout = new Loadout();

const enemies = ENEMY_SPAWNS.map((s) => {
  const e = new Enemy(world, s);
  scene.add(e.rig.root);
  return e;
});

const combat = new Combat(world, effects, flashPool, enemies);
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
};

// 撤离点：12/12 后在出生点亮起绿色方块
const extractMesh = new THREE.Mesh(
  new THREE.BoxGeometry(1.6, 0.12, 1.6),
  new THREE.MeshBasicMaterial({ color: PALETTE.good })
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
  if (game.over) return;
  player.hp = Math.max(0, player.hp - dmg);
  game.damageFlash = 1;
  cam.kick(0.4);
  // 受击：准星大幅扩散（无无敌帧，被打中基本还不了手）
  player.hitStun = 0.3;
  if (player.hp <= 0) endGame(false);
};

combat.onKill = (enemy) => {
  game.killed++;
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

function endGame(won) {
  if (game.over) return;
  game.over = true;
  game.won = won;
  game.endTime = performance.now() / 1000;
  const secs = Math.round(game.endTime - game.startTime);
  const mins = Math.floor(secs / 60);
  const acc = combat.accuracy;

  // 评级公式（GDD 04 章）：剩余HP + 命中率×50 + max(0,20−用时分钟)×2
  const score = player.hp + acc * 50 + Math.max(0, 20 - secs / 60) * 2;
  const grade = score >= 110 ? 'S' : score >= 90 ? 'A' : score >= 65 ? 'B' : 'C';

  hud.bannerTitle.textContent = won ? '任务完成' : '任务失败';
  hud.bannerTitle.className = won ? 'win' : 'lose';
  hud.bannerBody.innerHTML = won
    ? `用时 <b>${mins}:${String(secs % 60).padStart(2, '0')}</b> · ` +
      `命中率 <b>${(acc * 100).toFixed(0)}%</b> · ` +
      `爆头 <b>${combat.stats.headshots}</b> · ` +
      `剩余 <b>${player.hp}/${PLAYER.hpMax} HP</b><br>评级 <b class="grade">${grade}</b>` +
      `<br><span class="hint-key">按 R 重开</span>`
    : `已清除 <b>${game.killed}/${game.totalEnemies}</b> · ` +
      `命中率 <b>${(acc * 100).toFixed(0)}%</b><br>` +
      `<span class="hint-key">按 R 整关重启</span>`;
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
player.hitStun = 0;

function frame(nowMs) {
  const dt = Math.min(0.05, (nowMs - last) / 1000);
  last = nowMs;
  const now = nowMs / 1000;

  if (!game.over) {
    cam.addMouse(input.mouseDX, input.mouseDY);
    cam.aiming = input.buttons.has(2);

    if (input.justPressed('flashlight')) {
      const on = flashlight.toggle();
      hud.light.textContent = on ? 'ON' : 'OFF';
      hud.light.className = on ? 'v on' : 'v off';
    }
    if (input.justPressed('debug')) {
      hud.stats.style.display = hud.stats.style.display === 'none' ? '' : 'none';
    }

    // 武器切换
    if (input.pressed.has('Digit1')) loadout.switchTo(0, now);
    if (input.pressed.has('Digit2')) loadout.switchTo(1, now);
    if (input.wheel !== 0) loadout.toggle(now);

    player.update(dt, input, cam);
    setPlayerPosCache(player.pos);
    if (player.hitStun > 0) player.hitStun -= dt;

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
        // 开不出枪时把原因写到 HUD，便于定位（阻挡 / 冷却 / 换弹 / 空仓）
        fireDebug = ok ? 'FIRED'
          : weapon.reloading ? 'RELOADING'
          : weapon.isEmpty ? 'EMPTY'
          : player.aimSolution(cam).blocked ? 'BLOCKED'
          : 'COOLDOWN';
      }
      if (input.pressed.has('KeyR')) weapon.startReload(now);
      if (weapon.isEmpty && weapon.canReload) weapon.startReload(now);
    } else if (input.buttons.has(0) || input.justClicked(0)) {
      fireDebug = loadout.switching ? 'SWITCHING' : 'STUNNED';
    }

    // ── 敌人 ──
    const ctx = { player, flashlight, combat, enemies };
    for (const e of enemies) e.update(dt, now, ctx);

    // ── 拾取 ──
    nearWeapon = pickups.update(dt, player, loadout, now, toast);
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
    if (w.reloading) {
      hud.reload.style.display = 'block';
      hud.reloadBar.style.width = `${(w.reloadProgress(now) * 100).toFixed(0)}%`;
    } else {
      hud.reload.style.display = 'none';
    }
  }
  hud.enemies.textContent = `${game.totalEnemies - game.killed} / ${game.totalEnemies}`;
  hud.dbgShots.textContent = String(combat.stats.shots);
  hud.dbgHits.textContent = String(combat.stats.hits);
  hud.dbgFire.textContent = fireDebug;

  fpsAccum += dt; fpsFrames++;
  if (fpsAccum >= 0.35) {
    hud.fps.textContent = String(Math.round(fpsFrames / fpsAccum));
    fpsAccum = 0; fpsFrames = 0;
    hud.pos.textContent =
      `${player.pos.x.toFixed(1)} ${player.pos.y.toFixed(1)} ${player.pos.z.toFixed(1)}`;
    hud.stance.textContent =
      player.stance === 'crouch' ? 'CROUCH' : player.stance === 'slow' ? 'SLOW' : 'NORMAL';
    hud.hpFill.style.width = `${(player.hp / PLAYER.hpMax) * 100}%`;
    hud.hpText.textContent = `${player.hp} / ${PLAYER.hpMax}`;
  }

  input.endFrame();
  requestAnimationFrame(frame);
}

hud.boot.innerHTML =
  `世界 ${WORLD.SX}×${WORLD.SY}×${WORLD.SZ} · 可见面 ${meshStats.faces.toLocaleString()} · ` +
  `draw ${meshStats.draws} · 敌人 ${enemies.length}`;

requestAnimationFrame(frame);

window.__game = {
  world, player, cam, flashlight, scene, renderer, mesher,
  enemies, combat, loadout, pickups, game, effects,
};
