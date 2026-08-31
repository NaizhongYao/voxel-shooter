import * as THREE from 'three';
import { PLAYER } from '../config.js';
import { buildCharacter, ARMOR_KIT_COLORS } from '../systems/improved.js';
import { solveArm } from '../systems/kit.js';
import { buildGrenadeModel, disposeModel } from '../systems/gunmesh.js';

/**
 * Runtime facade for the improved merged-mesh character.
 *
 * improved.js owns static geometry and the initial hierarchy. This class keeps
 * the public rig contract used by the game: stable root, legacy aliases,
 * weapon/grenade replacement, first-person visibility, death animation, and
 * per-frame two-bone IK.
 */
export { ARMOR_KIT_COLORS };

const CHARACTER_KINDS = new Set([
  'player', 'sentry', 'patroller', 'ambusher', 'rusher', 'armored', 'shield',
]);

// These values match the arm dimensions in improved.js.
const ARM = {
  shoulderX: 0.22,
  shoulderY: 1.32,
  upper: 0.34,
  forearm: 0.42,
  handY: -0.42,
};

const RIG_LEAN_RAD = PLAYER.lean.angleDeg * Math.PI / 180;
const DEATH_RATE = 2.2;
const X_AXIS = new THREE.Vector3(1, 0, 0);

function resolveWeaponId(weapon) {
  return typeof weapon === 'string' ? weapon : weapon?.id ?? 'pistol';
}

function resolveArmorId(id) {
  return ARMOR_KIT_COLORS[id] !== undefined ? id : 'standard';
}

/** Preserve the old tone helper for the armor tests and UI callers. */
export function armorKitTones(armorId) {
  const id = resolveArmorId(armorId);
  const base = new THREE.Color(ARMOR_KIT_COLORS[id]);
  return {
    id,
    vest: base.getHex(),
    accent: base.clone().multiplyScalar(0.82).getHex(),
    helm: base.clone().multiplyScalar(0.62).getHex(),
  };
}

/** Detached compatibility nodes retain the old inspection/color contract. */
function compatibilityPart(name, color) {
  const mesh = new THREE.Mesh(
    new THREE.BoxGeometry(1, 1, 1),
    new THREE.MeshLambertMaterial({ color }),
  );
  mesh.name = name;
  return mesh;
}

function inferKind(kind, opts) {
  if (opts?.isPlayer || kind === 'player') return 'player';
  if (CHARACTER_KINDS.has(kind)) return kind;
  if (opts?.kit === 'shield') return 'shield';
  if (opts?.kit === 'armored' || opts?.armored) return 'armored';
  // Legacy enemy construction did not pass its archetype to the rig.
  return 'sentry';
}

/** Convert an improved weapon-local point into body-local coordinates. */
function localGunPoint(gunPivot, gun, point) {
  const offset = new THREE.Vector3(
    gun.position.x + point[0],
    gun.position.y + point[1],
    gun.position.z + point[2],
  );
  offset.applyAxisAngle(X_AXIS, gunPivot.rotation.x);
  return new THREE.Vector3().copy(gunPivot.position).add(offset);
}

export class Rig {
  /**
   * Supported constructor forms:
   *   new Rig('player', { armorId, weapon })
   *   new BlockyRig(PALETTE.player, { isPlayer, kit })
   */
  constructor(kindOrColor = 'player', opts = {}) {
    let kind = kindOrColor;
    let options = opts || {};
    if (typeof kindOrColor === 'number') {
      kind = options.kind ?? (options.isPlayer ? 'player' : undefined);
    } else if (kindOrColor && typeof kindOrColor === 'object') {
      options = kindOrColor;
      kind = options.kind ?? 'player';
    }

    this.kind = inferKind(kind, options);
    this.isPlayer = this.kind === 'player';
    this.root = new THREE.Group();
    this.root.name = this.isPlayer ? 'player-rig' : 'actor-rig';

    this.gunId = resolveWeaponId(
      options.weapon || (this.isPlayer ? 'pistol' : 'ar'),
    );
    this.armorKit = this.isPlayer ? resolveArmorId(options.armorId) : null;
    this._firstPerson = false;
    this.walkPhase = 0;
    this.recoil = 0;
    this.crouchAmt = 0;
    this.leanAmt = 0;
    this.deathAmt = 0;
    this.deathYaw = 0;
    this.nadeKind = 'flash';
    this.nade = null;
    this.lamp = null;
    this.fpHide = [];
    this.kitParts = [];
    this.armorShell = null;
    this.aimSolution = {
      left: { upper: 0, lower: 0 },
      right: { upper: 0, lower: 0 },
      grip: new THREE.Vector3(),
      support: new THREE.Vector3(),
      muzzle: new THREE.Vector3(),
      origin: new THREE.Vector3(),
    };

    if (this.isPlayer) {
      const tones = armorKitTones(this.armorKit);
      this.kitParts = [
        compatibilityPart('helmet', tones.helm),
        compatibilityPart('vest', tones.vest),
        compatibilityPart('pouchL', tones.accent),
        compatibilityPart('pouchR', tones.accent),
      ];
      this.fpHide.push(...this.kitParts);
    } else if (this.kind === 'armored' || this.kind === 'shield') {
      // improved.js contains the visible enemy armor. This detached alias is
      // retained because old callers inspect armorShell directly.
      this.armorShell = compatibilityPart(
        this.kind === 'shield' ? 'shieldPlate' : 'armorShell',
        0x39414a,
      );
      this.fpHide.push(this.armorShell);
    }

    this._rebuildCharacter();
    if (this.isPlayer) this.setGrenade('flash');
  }

  _rebuildCharacter() {
    const oldModel = this.mesh;
    // The grenade is part of the old model tree and is released with it.
    // Callers capture nadeKind before rebuilding and attach a fresh instance.
    this.nade = null;
    if (oldModel) {
      this.root.remove(oldModel);
      disposeModel(oldModel);
    }
    // Hand markers, gun lamp, grenade, and the old model all belong to the
    // previous hierarchy. Keep only long-lived compatibility nodes here.
    this.fpHide = this.fpHide.filter((item) => item === this.armorShell || this.kitParts.includes(item));

    const model = buildCharacter(this.kind, {
      armorId: this.armorKit ?? undefined,
      weapon: this.gunId,
    });
    model.name = `character-${this.kind}`;
    this.root.add(model);
    this.mesh = model;
    this._bindModel(model);
    this._createLamp();
    this._applyRecoil();
    this._solveArms();
    this.setFirstPerson(this._firstPerson);
  }

  _bindModel(model) {
    const data = model.userData || {};
    this.body = model.children.find((child) => child.isGroup) || model;
    this.body.name = 'body';
    this.torso = this.body.children[0] || this.body;
    this.torso.name = 'torso';
    this.headPivot = data.headPivot || this.body.children[1];
    this.head = this.headPivot?.children[0] || this.headPivot || this.body;
    if (this.head) this.head.name = 'head';

    this.arms = data.arms || [];
    this.armL = this.arms[0]?.shoulderPivot || new THREE.Group();
    this.armR = this.arms[1]?.shoulderPivot || new THREE.Group();
    this.leftArm = this.armL;
    this.rightArm = this.armR;
    this.leftElbow = this.arms[0]?.elbow || this.armL;
    this.rightElbow = this.arms[1]?.elbow || this.armR;
    this.leftHand = this._addHandMarker(this.leftElbow, 'leftHand');
    this.rightHand = this._addHandMarker(this.rightElbow, 'rightHand');
    this.handL = this.leftHand;
    this.handR = this.rightHand;

    this.legs = data.legs || [];
    this.legL = this.legs[0] || new THREE.Group();
    this.legR = this.legs[1] || new THREE.Group();
    this.leftLeg = this.legL;
    this.rightLeg = this.legR;

    this.gun = data.gun || this.body;
    this.weapon = this.gun;
    this.gunPivot = data.gunPivot || this.body;
    this.weaponPivot = this.gunPivot;
    this.muzzle = this._ensureMuzzle(this.gun);
    this.root.userData = {
      ...data,
      model,
      body: this.body,
      torso: this.torso,
      head: this.head,
      muzzle: this.muzzle,
    };
  }

  _addHandMarker(elbow, name) {
    const marker = new THREE.Object3D();
    marker.name = name;
    marker.position.set(0, ARM.handY, 0);
    elbow.add(marker);
    return marker;
  }

  _ensureMuzzle(gun) {
    let muzzle = gun.userData?.muzzle;
    if (!muzzle) {
      muzzle = new THREE.Object3D();
      muzzle.name = 'muzzle';
      const z = Number.isFinite(gun.userData?.muzzleZ)
        ? gun.userData.muzzleZ : -0.44;
      muzzle.position.set(0, 0.05, z);
      gun.add(muzzle);
      gun.userData.muzzle = muzzle;
    }
    return muzzle;
  }

  _createLamp() {
    this.lamp = new THREE.Mesh(
      new THREE.BoxGeometry(1, 1, 1),
      new THREE.MeshBasicMaterial({ color: 0xffe2b0 }),
    );
    this.lamp.name = 'weapon-lamp';
    this.lamp.scale.set(0.13, 0.13, 0.13);
    const z = Number.isFinite(this.gun.userData?.muzzleZ)
      ? this.gun.userData.muzzleZ : -0.44;
    this.lamp.position.set(0, 0.08, z + 0.08);
    this.lamp.visible = false;
    this.gunPivot.add(this.lamp);
  }

  _targetPoints() {
    const grip = this.gun.userData?.gripLocal || [0, -0.10, 0.09];
    const support = this.gun.userData?.supportLocal || [0, -0.07, -0.05];
    return {
      grip: localGunPoint(this.gunPivot, this.gun, grip),
      support: localGunPoint(this.gunPivot, this.gun, support),
    };
  }

  /** Solve both arms in body-local coordinates with the shared IK helper. */
  _solveArms() {
    if (!this.arms?.length || !this.gunPivot || !this.gun) return;
    const targets = this._targetPoints();
    const solutions = [];

    for (const [index, arm] of this.arms.entries()) {
      const side = index === 0 ? -1 : 1;
      const shoulder = new THREE.Vector3(
        side * ARM.shoulderX, ARM.shoulderY, 0,
      );
      const target = index === 0 ? targets.support : targets.grip;
      const dx = target.x - shoulder.x;
      const dy = target.y - shoulder.y;
      const dz = target.z - shoulder.z;
      const horizontal = Math.hypot(dx, dz);
      const yaw = Math.atan2(-dx, -dz);
      const solution = solveArm(
        { y: 0, z: 0 },
        { y: dy, z: -horizontal },
        ARM.upper,
        ARM.forearm,
      );
      arm.shoulderPivot.rotation.order = 'YXZ';
      arm.shoulderPivot.rotation.y = yaw;
      arm.shoulderPivot.rotation.x = solution.upper;
      arm.elbow.rotation.x = solution.lower;
      solutions[index] = solution;
    }

    this.gun.updateWorldMatrix(true, false);
    const worldGrip = this.gun.localToWorld(new THREE.Vector3(
      ...(this.gun.userData?.gripLocal || [0, -0.10, 0.09]),
    ));
    const worldSupport = this.gun.localToWorld(new THREE.Vector3(
      ...(this.gun.userData?.supportLocal || [0, -0.07, -0.05]),
    ));
    const worldMuzzle = this.muzzle.getWorldPosition(new THREE.Vector3());
    this.aimSolution = {
      left: { ...solutions[0] },
      right: { ...solutions[1] },
      grip: worldGrip,
      support: worldSupport,
      muzzle: worldMuzzle,
      origin: worldMuzzle.clone(),
    };
  }

  _applyRecoil() {
    if (this.gun) this.gun.position.z = this.recoil * 0.22;
  }

  /** Supports update(dt, state) and update(now, dt, state). */
  update(first, second, third) {
    const oldSignature = third === undefined && typeof second === 'object';
    const dt = oldSignature ? Number(first) || 0 : Number(second) || 0;
    const state = (oldSignature ? second : third) || {};
    const {
      speed = 0,
      yaw = this.root.rotation.y,
      pitch = 0,
      crouchAmt = 0,
      leanAmt = 0,
      aiming = false,
    } = state;

    if (this.deathAmt > 0) {
      this.root.rotation.y = yaw;
      this.updateDeath(dt);
      return;
    }

    this.root.rotation.y = yaw;
    this.crouchAmt = crouchAmt;
    const sy = 1 - crouchAmt * (1 - PLAYER.crouchHeight / PLAYER.height);
    this.body.scale.set(1, sy, 1);

    this.leanAmt = leanAmt;
    this._applyLean(leanAmt);
    this.headPivot.rotation.x = THREE.MathUtils.clamp(pitch, -0.9, 0.7);
    this.gunPivot.rotation.x = THREE.MathUtils.clamp(pitch, -1.1, 0.9);
    this._solveArms();

    const moving = speed > 0.05;
    if (moving) this.walkPhase += dt * speed * 2.0 * Math.PI;
    else this.walkPhase += dt * 6;
    const amp = moving ? Math.min(0.45, speed / PLAYER.speed * 0.45) : 0;
    const swing = Math.sin(this.walkPhase) * amp;
    this.legL.rotation.x = swing;
    this.legR.rotation.x = -swing;
    this.torso.rotation.x = moving ? -0.06 - amp * 0.04 : 0;

    if (this.recoil > 0) {
      this.recoil = Math.max(0, this.recoil - dt * 7);
      this._applyRecoil();
      this._solveArms();
    }

    // Keep the explicit state parameter in the compatibility contract.
    void aiming;
  }

  _applyLean(amount) {
    const lean = THREE.MathUtils.clamp(amount, -1, 1);
    this.body.rotation.z = -lean * RIG_LEAN_RAD;
    this.body.position.x = lean * PLAYER.lean.offset * 0.6;
  }

  kick(amount = 1) {
    this.recoil = Math.min(1, this.recoil + amount);
  }

  setGun(weaponId = 'pistol') {
    const id = resolveWeaponId(weaponId);
    if (this.gunId === id && this.gun) return;
    const lampOn = this.lamp?.visible ?? false;
    const nadeKind = this.nade ? this.nadeKind : null;
    this.gunId = id;
    this._rebuildCharacter();
    this.setLampOn(lampOn);
    if (nadeKind) this._attachGrenade(nadeKind);
  }

  setArmorKit(armorId = 'standard') {
    const tones = armorKitTones(armorId);
    this.armorKit = tones.id;
    for (const mesh of this.kitParts) {
      if (mesh.name === 'vest') mesh.material.color.setHex(tones.vest);
      else if (mesh.name === 'pouchL' || mesh.name === 'pouchR') {
        mesh.material.color.setHex(tones.accent);
      } else if (mesh.name === 'helmet') {
        mesh.material.color.setHex(tones.helm);
      }
    }

    if (this.isPlayer) {
      const lampOn = this.lamp?.visible ?? false;
      const nadeKind = this.nade ? this.nadeKind : null;
      this._rebuildCharacter();
      this.setLampOn(lampOn);
      if (nadeKind) this._attachGrenade(nadeKind);
    }
  }

  _attachGrenade(kind = 'flash') {
    if (!this.body) return;
    this.nadeKind = kind === 'he' ? 'he' : 'flash';
    this.nade = buildGrenadeModel(this.nadeKind);
    this.nade.position.set(-0.42, 1.12, 0.14);
    this.nade.rotation.z = 0.18;
    this.body.add(this.nade);
    if (!this.fpHide.includes(this.nade)) this.fpHide.push(this.nade);
  }

  setGrenade(kind = 'flash') {
    const id = kind === 'he' ? 'he' : 'flash';
    if (this.nadeKind === id && this.nade) return;
    if (this.nade) {
      this.body.remove(this.nade);
      disposeModel(this.nade);
      const at = this.fpHide.indexOf(this.nade);
      if (at >= 0) this.fpHide.splice(at, 1);
      this.nade = null;
    }
    this._attachGrenade(id);
  }

  setVisible(visible) {
    this.root.visible = visible;
  }

  setLampOn(on) {
    if (this.lamp) this.lamp.visible = !!on;
  }

  setFirstPerson(on) {
    this._firstPerson = !!on;
    if (this.head) this.head.visible = !on;
    if (this.torso) this.torso.visible = !on;
    if (this.legL) this.legL.visible = !on;
    if (this.legR) this.legR.visible = !on;
    for (const item of this.fpHide) item.visible = !on;
    for (const object of [this.armL, this.armR, this.gun]) {
      object?.traverse?.((child) => {
        if (child.isMesh) child.castShadow = !on;
      });
    }
  }

  startDeath(dirX = 0, dirZ = 1) {
    if (this.deathAmt > 0) return;
    this.deathYaw = Math.atan2(dirX, dirZ);
    this.deathAmt = 1e-4;
    this.setLampOn(false);
  }

  fall(dirX = 0, dirZ = 1) {
    this.startDeath(dirX, dirZ);
  }

  leanLeft(amount = 1) {
    this.leanAmt = -Math.abs(amount);
    this._applyLean(this.leanAmt);
  }

  leanRight(amount = 1) {
    this.leanAmt = Math.abs(amount);
    this._applyLean(this.leanAmt);
  }

  updateDeath(dt) {
    if (this.deathAmt <= 0) return false;
    this.deathAmt = Math.min(1, this.deathAmt + dt * DEATH_RATE);
    const t = 1 - (1 - this.deathAmt) * (1 - this.deathAmt);
    this.body.rotation.set(0, 0, 0);
    this.body.rotation.x = t * Math.PI / 2 * Math.cos(this.deathYaw);
    this.body.rotation.z = t * Math.PI / 2 * -Math.sin(this.deathYaw);
    this.body.position.set(0, -t * 0.12, 0);
    this.body.scale.set(1, 1, 1);

    const limp = t * 0.9;
    this.armL.rotation.x = -1.15 + limp * 1.5;
    this.armR.rotation.x = -1.15 + limp * 1.5;
    this.armL.rotation.z = -limp * 0.6;
    this.armR.rotation.z = limp * 0.6;
    this.legL.rotation.x = limp * 0.35;
    this.legR.rotation.x = -limp * 0.25;
    this.headPivot.rotation.x = limp * 0.7;
    this.gunPivot.rotation.x = limp * 1.2;
    return this.deathAmt >= 1;
  }

  muzzleWorld(outPos, outDir) {
    this.muzzle.getWorldPosition(outPos);
    this.muzzle.getWorldDirection(outDir);
    outDir.negate();
    return outPos;
  }
}

/** Build the compatibility facade around improved.buildCharacter(). */
export function buildRig(kind = 'player', opts = {}) {
  return new Rig(kind, opts);
}

// Existing callers import BlockyRig; keep it as the same constructor.
export { Rig as BlockyRig };
