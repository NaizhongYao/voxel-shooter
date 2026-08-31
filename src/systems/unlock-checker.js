/**
 * Unlock Checker - 装备可用性判定唯一入口
 * 
 * "这件装备现在能不能选/装"的唯一裁决点。调用方不需要分辨两条路径：
 * 
 * 1. 保底装备（无限供应，永远可用，不查 profile）：
 *    - 手枪 pistol / pistolFast
 *    - 护甲 standard
 *    - 手雷 flash
 *    - 例外：pistol_suppressor1（M19 消音的出厂自带消音器），永久可用
 * 2. 实例路径：其余武器/护甲/手雷/配件，必须已在 profile.stash 中存在
 *    "已制作实例"才能用。
 * 
 * 设计依据：
 * - BLUEPRINT-ARCHITECTURE.md §1.1-§1.3 / §7（Unlock Checker Design）
 * - BLUEPRINT-SYSTEM-FINAL-DECISION.md（裁决冲突时以此为准）
 * - 保底清单：pistol/pistolFast/standard/flash（§1.2 + 裁决 §2/§3）
 * 
 * stash 实例形状契约（制作系统后续批次落地，本轮 stash 为空是预期状态）：
 *   { instanceId, type: 'weapon'|'armor'|'grenade'|'attachment', blueprintId, ... }
 *   - 来源：BLUEPRINT-ARCHITECTURE.md §1.6 "Item instance shape"
 *   - 配件实例的 blueprintId 遵循命名约定 {weaponId}_{attachmentId}
 *     （§1.4，如 pistol_suppressor1）
 *   - 存量测试里的 { type, name } 占位条目没有 blueprintId，不会误判为可用
 * 
 * 依赖图（单向无环）：
 *   save-store（纯数据层）← unlock-checker ← loadout-manager / ui/equipment
 *   unlock-checker 还依赖 loadout-config / weapons（纯数据表，无反向依赖）
 */

import { getSaveStore } from './save-store.js';
import { ATTACHMENTS, ARMOR_TYPES, GRENADE_TYPES } from './loadout-config.js';
import { WEAPONS } from './weapons.js';

// ─────────────────────────────────────────────────────────────────────────────
// Default Kit (Infinite Supply)
// ─────────────────────────────────────────────────────────────────────────────

const DEFAULT_WEAPONS = new Set(['pistol', 'pistolFast']);
const DEFAULT_ARMORS = new Set(['standard']);
const DEFAULT_GRENADES = new Set(['flash']);

// ─────────────────────────────────────────────────────────────────────────────
// 内部辅助
// ─────────────────────────────────────────────────────────────────────────────

/**
 * 读取当前档案的 stash 实例数组（只读）。
 * 档案未初始化或 stash 缺失时返回空数组（判定为不可用，绝不抛错）。
 */
function getStashItems() {
  const store = getSaveStore();
  const profile = store.getProfile();
  if (!profile || !profile.stash) return [];
  return Object.values(profile.stash).filter(
    (item) => item && typeof item === 'object'
  );
}

/**
 * stash 中是否存在指定类型 + 蓝图 ID 的实例。
 * 兼容两代 shape：unlock-checker 旧契约 { type, blueprintId } 与
 * ItemInstance 新形状 { slotKind, defId }（制作系统产出的成品同时携带
 * 两组字段，普通拾取/结算入库的实例可能只带新形状 —— 两种都认）。
 * 注意 blueprintId 优先于 defId：配件实例的 defId 是附件 id
 * （如 redDot），配对蓝图 id 是 ar_redDot —— 判定只能按配对蓝图匹配。
 */
function hasInstanceInStash(kind, blueprintId) {
  return getStashItems().some((item) => {
    const itemKind = item.slotKind ?? item.type;
    const itemBlueprint = item.blueprintId ?? item.defId;
    return itemKind === kind && itemBlueprint === blueprintId;
  });
}

// ─────────────────────────────────────────────────────────────────────────────
// Public API
// ─────────────────────────────────────────────────────────────────────────────

/**
 * 检查一件装备是否可用（保底装备或已制作实例）
 * @param {string} kind - 'weapon' | 'armor' | 'grenade' | 'attachment'
 * @param {string} id - 装备 ID（配件的 attachmentId，如 'suppressor1'）
 * @param {string} [weaponId] - 配件必须提供：挂在哪把武器上（配对蓝图 weaponId_attachmentId）
 * @returns {boolean}
 */
export function isEquippable(kind, id, weaponId = null) {
  // 保底路径：无限供应，永远可用
  if (kind === 'weapon' && DEFAULT_WEAPONS.has(id)) return true;
  if (kind === 'armor' && DEFAULT_ARMORS.has(id)) return true;
  if (kind === 'grenade' && DEFAULT_GRENADES.has(id)) return true;

  // 保底例外：pistol_suppressor1 是 M19 消音的出厂自带消音器（DEFAULT_LOADOUT
  // 预装 muzzle: 'suppressor1'），与 pistol 本身同属保底包，不查 stash。
  // 仅精确限定 pistol + suppressor1 这一个组合，不扩大化到其他武器/配件。
  if (kind === 'attachment' && id === 'suppressor1' && weaponId === 'pistol') return true;

  // 实例路径：检查 stash 中已制作实例
  if (kind === 'attachment') {
    // 配件蓝图按 (武器, 配件) 配对，缺 weaponId 无法判定
    if (!weaponId) return false;
    const blueprintId = `${weaponId}_${id}`;
    return hasInstanceInStash('attachment', blueprintId);
  }

  // weapon / armor / grenade：按类型 + 蓝图 ID 匹配
  return hasInstanceInStash(kind, id);
}

/**
 * 所有可装备武器（保底 + stash 实例，去重）
 */
export function getEquippableWeapons() {
  const result = [...DEFAULT_WEAPONS];
  for (const item of getStashItems()) {
    const id = item.defId ?? item.blueprintId;
    if ((item.slotKind ?? item.type) === 'weapon' && WEAPONS[id]) {
      result.push(id);
    }
  }
  return [...new Set(result)];
}

/**
 * 所有可装备护甲（保底 + stash 实例，去重）
 */
export function getEquippableArmors() {
  const result = [...DEFAULT_ARMORS];
  for (const item of getStashItems()) {
    const id = item.defId ?? item.blueprintId;
    if ((item.slotKind ?? item.type) === 'armor' && ARMOR_TYPES[id]) {
      result.push(id);
    }
  }
  return [...new Set(result)];
}

/**
 * 所有可装备手雷（保底 + stash 实例，去重）
 */
export function getEquippableGrenades() {
  const result = [...DEFAULT_GRENADES];
  for (const item of getStashItems()) {
    const id = item.defId ?? item.blueprintId;
    if ((item.slotKind ?? item.type) === 'grenade' && GRENADE_TYPES[id]) {
      result.push(id);
    }
  }
  return [...new Set(result)];
}

/**
 * 指定武器 + 槽位下可装备的配件对象列表
 * @param {string} weaponId
 * @param {string} slotType - muzzle/optic/magazine/grip
 * @returns {object[]} 已过滤的配件定义对象
 */
export function getEquippableAttachments(weaponId, slotType) {
  return Object.values(ATTACHMENTS).filter((att) => {
    if (att.slot !== slotType) return false;
    if (att.compatibleWeapons.length > 0 && !att.compatibleWeapons.includes(weaponId)) {
      return false;
    }
    return isEquippable('attachment', att.id, weaponId);
  });
}

/**
 * 是否拥有某蓝图（制作门票，与"能不能装备"是两回事）
 * @param {string} blueprintId
 * @returns {boolean}
 */
export function hasBlueprint(blueprintId) {
  const store = getSaveStore();
  const profile = store.getProfile();
  return profile?.blueprints?.[blueprintId] === true;
}

/**
 * 已拥有的全部蓝图 ID
 * @returns {string[]}
 */
export function getOwnedBlueprints() {
  const store = getSaveStore();
  const profile = store.getProfile();
  return Object.keys(profile?.blueprints ?? {});
}
