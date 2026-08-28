import * as THREE from 'three';
import { PALETTE, PLAYER } from '../config.js';
import { D } from '../difficulty.js';
import { WEAPONS } from './weapons.js';
import { buildGunModel, buildMedkitModel } from './gunmesh.js';

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

    if (kind === KIND.WEAPON) {
      this.mesh = buildGunModel(payload.weapon || 'pistol');
      this.mesh.rotation.x = 0.15;
    } else if (kind === KIND.MEDKIT) {
      this.mesh = buildMedkitModel();
    } else {
      this.mesh = new THREE.Mesh(BOX, new THREE.MeshLambertMaterial({ color }));
    }
    this.mesh.position.copy(this.pos);
    this.mesh.castShadow = false;
    scene.add(this.mesh);
    this.scene = scene;
  }

  update(dt, t) {
    if (this.taken) return;
    if (this.kind === KIND.WEAPON) {
      this.mesh.rotation.y += dt * 0.9;
      this.mesh.position.y = this.baseY + Math.sin(t * 1.6 + this.phase) * 0.04;
    } else {
      this.mesh.rotation.y += dt * 1.6;
      this.mesh.rotation.x += dt * 0.5;
      this.mesh.position.y = this.baseY + Math.sin(t * 2 + this.phase) * 0.09;
    }
  }

  take() {
    this.taken = true;
    this.scene.remove(this.mesh);
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
        // 上限与回复量都读难度/实例，不要硬编码 ——
        // 写死会导致医疗包把满血玩家「治」回另一个难度的上限。
        const heal = D().medkitHeal;
        if (player.hp < player.hpMax) {
          player.hp = Math.min(player.hpMax, player.hp + heal);
          p.take();
          onPickup?.(`医疗包 +${heal} HP`);
        }
      } else if (p.kind === KIND.AMMO) {
        /**
         * 弹药盒。addAmmo 返回 false 意味着「没有任何枪吃得下这些弹药」
         * —— 目前只有一种情况：玩家还没捡到主武器，身上只有无限备弹的手枪。
         *
         * 这时不消耗拾取物是对的（留着等玩家有枪了再来拿），但必须给
         * 反馈，否则玩家反复走过一个闪着青光的盒子、什么都没发生，
         * 只会以为是 bug。第一次撞上时提示一次就够。
         */
        const amt = p.payload.amount ?? 30;
        if (loadout.addAmmo(amt)) {
          p.take();
          onPickup?.(`弹药 +${amt}`);
        } else if (!p.warned) {
          p.warned = true;
          onPickup?.('弹药：需要先捡一把主武器');
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
