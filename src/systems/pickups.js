import * as THREE from 'three';
import { PALETTE } from '../config.js';
import { WEAPONS } from './weapons.js';

/**
 * 掉落物：缓慢自转 + 上下浮动的 0.4 vox 小方块。
 * 自转让它在黑暗中被手电扫到时「闪一下」——免费且高效的引导。
 *
 * 颜色：琥珀=武器 · 青=弹药 · 绿=医疗 · 紫=DMR
 */

const BOX = new THREE.BoxGeometry(0.4, 0.4, 0.4);

export const KIND = { WEAPON: 'weapon', AMMO: 'ammo', MEDKIT: 'medkit' };

export class Pickup {
  constructor(scene, kind, pos, payload = {}) {
    this.kind = kind;
    this.payload = payload;
    this.pos = new THREE.Vector3(pos.x, pos.y, pos.z);
    this.baseY = this.pos.y;
    this.taken = false;
    this.phase = Math.random() * Math.PI * 2;

    const color =
      kind === KIND.MEDKIT ? PALETTE.good :
      kind === KIND.AMMO   ? PALETTE.cyan :
      payload.weapon === 'dmr' ? PALETTE.purple : PALETTE.amber;

    // MeshBasic：掉落物在全黑房间里也要能被看到一点点，否则玩家永远找不到
    this.mesh = new THREE.Mesh(BOX, new THREE.MeshLambertMaterial({
      color, emissive: color,
    }));
    this.mesh.material = new THREE.MeshLambertMaterial({ color });
    this.mesh.position.copy(this.pos);
    this.mesh.castShadow = false;
    scene.add(this.mesh);
    this.scene = scene;
  }

  update(dt, t) {
    if (this.taken) return;
    this.mesh.rotation.y += dt * 1.6;
    this.mesh.rotation.x += dt * 0.5;
    this.mesh.position.y = this.baseY + Math.sin(t * 2 + this.phase) * 0.09;
  }

  take() {
    this.taken = true;
    this.scene.remove(this.mesh);
    this.mesh.material.dispose();
  }
}

export class PickupManager {
  constructor(scene, world) {
    this.scene = scene;
    this.world = world;
    this.items = [];
    this.t = 0;
  }

  add(kind, pos, payload) {
    const p = new Pickup(this.scene, kind, pos, payload);
    this.items.push(p);
    return p;
  }

  dropWeapon(pos, weaponId, ammo, reserve) {
    // 落在地面上，避免浮空
    const surf = this.world.highestSurfaceUnder(
      pos.x - 0.2, pos.z - 0.2, pos.x + 0.2, pos.z + 0.2, pos.y + 1, pos.y - 3
    );
    const y = (Number.isFinite(surf) ? surf : pos.y) + 0.35;
    return this.add(KIND.WEAPON, { x: pos.x, y, z: pos.z },
      { weapon: weaponId, ammo, reserve });
  }

  dropAmmo(pos, amount) {
    const surf = this.world.highestSurfaceUnder(
      pos.x - 0.2, pos.z - 0.2, pos.x + 0.2, pos.z + 0.2, pos.y + 1, pos.y - 3
    );
    const y = (Number.isFinite(surf) ? surf : pos.y) + 0.35;
    return this.add(KIND.AMMO, { x: pos.x, y, z: pos.z }, { amount });
  }

  /**
   * 检查拾取。武器需要按键（避免误换枪），弹药与医疗自动拾取。
   * @returns {Pickup|null} 需要按键确认的武器（玩家站在上面时）
   */
  update(dt, player, loadout, now, onPickup) {
    this.t += dt;
    let nearWeapon = null;

    for (const p of this.items) {
      if (p.taken) continue;
      p.update(dt, this.t);

      const d = Math.hypot(
        p.pos.x - player.pos.x,
        p.baseY - (player.pos.y + 0.5),
        p.pos.z - player.pos.z
      );
      if (d > 1.2) continue;

      if (p.kind === KIND.MEDKIT) {
        if (player.hp < 60) {
          player.hp = Math.min(60, player.hp + 30);
          p.take();
          onPickup?.('医疗包 +30 HP');
        }
      } else if (p.kind === KIND.AMMO) {
        if (loadout.addAmmo(p.payload.amount ?? 30)) {
          p.take();
          onPickup?.(`弹药 +${p.payload.amount ?? 30}`);
        }
      } else if (p.kind === KIND.WEAPON) {
        nearWeapon = p;
      }
    }

    this.items = this.items.filter((p) => !p.taken);
    return nearWeapon;
  }

  /** 玩家按 R 拾取武器；旧主武器掉在脚下 */
  takeWeapon(pickup, loadout, player, now) {
    const spec = WEAPONS[pickup.payload.weapon];
    if (!spec) return null;
    const old = loadout.pickUp(
      spec, pickup.payload.ammo ?? spec.mag,
      pickup.payload.reserve ?? spec.reserve, now
    );
    pickup.take();
    if (old) {
      this.dropWeapon(player.pos, old.spec.id, old.ammo, old.reserve);
    }
    return spec;
  }
}
