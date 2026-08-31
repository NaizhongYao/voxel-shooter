/**
 * 局外统一容器服务（批 5）。
 *
 * 职责：仓库（profile.stash / stashOverflow / materials / blueprints）与
 * 局外装备背包（loadoutManager.getInventory()）之间的全部读写入口。
 *
 * 数据边界与事务语义：
 *   - SaveStore 是持久化唯一写入点（localStorage），本模块绝不直接写 storage；
 *   - 局外装备背包是「四字段配置 + profile.stash」的派生视图：实例从未离开
 *     stash，直到 startRaid() 把风险物原子移入 pendingRaid.riskedItems ——
 *     因此「退回仓库」= 离开背包槽位，不需要任何 stash 写入；
 *   - 保底装备（手枪 / standard 护甲 / flash 手雷）没有 stash 实例，结构上
 *     无法被移动或删除（§1 不变量 1）；
 *   - craft() 是唯一「扣材料 + 创建实例 + 入仓」三件事的原子入口：任一环节
 *     失败（含材料不足 / 无蓝图 / 写盘失败）都整体回滚；仓库满时产物进入
 *     stashOverflow 并随返回值明确列出（不静默丢）；
 *   - 实例身份不变量：同一 instanceId 只允许存在一份（背包格或 stash，
 *     二选一），移动永远走「对象引用搬运 + 快照回滚」，绝不复制。
 *
 * 消费方：src/ui/equipment.js（拖拽提交 / 卸下全部）、src/ui/hub-nav.js
 * （仓库与制作页签渲染）、src/main.js（startMission 的局内 equipment 镜像）。
 */

import { getSaveStore } from './save-store.js';
import { loadoutManager } from './loadout-manager.js';
import {
  ItemInstance,
  autoPlace,
  canAccept,
  resizeInventory,
} from './inventory.js';
import { normalizeItemInstance } from './raid-inventory.js';
import { CRAFTING_RECIPES } from '../data/crafting-recipes.js';
import { ATTACHMENTS } from './loadout-config.js';

// ═══════════════════════════════════════════════════════════════════════════
// 快照 / 克隆（保留 Infinity / undefined —— JSON 会把 payload.reserve: Infinity
// 抹成 null，破坏「武器备弹 ∞」语义；与 raid-inventory.js 的 clone 同约定）
// ═══════════════════════════════════════════════════════════════════════════

export function deepClone(value) {
  if (value === undefined) return undefined;
  if (typeof structuredClone === 'function') {
    try { return structuredClone(value); } catch { /* 回退手写 */ }
  }
  return cloneValue(value, new Map());
}

function cloneValue(value, seen) {
  if (value === null || typeof value !== 'object') return value;
  if (seen.has(value)) return seen.get(value);
  if (Array.isArray(value)) {
    const out = new Array(value.length);
    seen.set(value, out);
    for (let i = 0; i < value.length; i++) {
      if (Object.prototype.hasOwnProperty.call(value, i)) {
        out[i] = cloneValue(value[i], seen);
      }
    }
    return out;
  }
  const out = {};
  seen.set(value, out);
  for (const key of Object.keys(value)) out[key] = cloneValue(value[key], seen);
  return out;
}

// ═══════════════════════════════════════════════════════════════════════════
// 仓库视图（只读）
// ═══════════════════════════════════════════════════════════════════════════

/** stash 条目的槽类（兼容两代形状：slotKind || kind || type）。 */
export function stashKind(item) {
  return item?.slotKind ?? item?.kind ?? item?.type ?? null;
}

/** stash 条目的定义 id（兼容两代形状：defId || blueprintId）。 */
export function stashDefId(item) {
  if (item?.defId) return item.defId;
  const kind = stashKind(item);
  if (kind === 'material') return item?.materialId ?? item?.itemId;
  if (kind === 'blueprint') return item?.blueprintId ?? item?.targetId;
  return item?.blueprintId ?? item?.materialId ?? item?.itemId;
}

function collectEntries(map) {
  const out = [];
  for (const [key, item] of Object.entries(map ?? {})) {
    if (!item || typeof item !== 'object') continue;
    out.push({
      instanceId: item.instanceId ?? key,
      group: stashKind(item),
      defId: stashDefId(item),
      ...deepClone(item),
    });
  }
  return out;
}

/**
 * 仓库总览：占用 / 容量 / 待整理(overflow) / 按类别分组。
 * 材料与蓝图是计数与解锁位（§7.2），不占仓库容量，单独返回。
 */
export function getStashView() {
  const store = getSaveStore();
  const profile = store.getProfile();
  if (!profile) return null;

  const groups = {
    weapon: [], armor: [], grenade: [], attachment: [],
    blueprint: [], consumable: [], material: [], unknown: [],
  };
  const entries = collectEntries(profile.stash);
  const used = entries.length;
  for (const entry of entries) {
    (groups[entry.group] ?? groups.unknown).push(entry);
  }
  const overflow = collectEntries(profile.stashOverflow);
  return {
    used,
    capacity: profile.stashCapacity ?? 24,
    available: Math.max(0, (profile.stashCapacity ?? 24) - used),
    overflowCount: overflow.length,
    overflow,
    groups,
    materials: { ...(profile.materials ?? {}) },
    blueprints: { ...(profile.blueprints ?? {}) },
  };
}

/** 仓库某类别 + 定义 id 的实例数量（展示 ×N）。 */
export function countStashInstances(stash, kind, defId) {
  let n = 0;
  for (const item of Object.values(stash ?? {})) {
    if (stashKind(item) === kind && stashDefId(item) === defId) n++;
  }
  return n;
}

// ═══════════════════════════════════════════════════════════════════════════
// 装备背包槽位工具
// ═══════════════════════════════════════════════════════════════════════════

/** 背包槽位（armor 用单槽对象；其余用定长稀疏数组，越界 = 布局外 = 无效）。 */
function slotRef(inv, group, index = 0) {
  if (group === 'armor') return { group, index: 0, get: () => inv.armor, set: (v) => { inv.armor = v; } };
  if (!Array.isArray(inv[group]) || index < 0 || index >= inv[group].length) return null;
  return {
    group,
    index,
    get: () => inv[group][index] ?? null,
    set: (v) => { inv[group][index] = v; },
  };
}

/** 实例是否已在装备背包某格（按 instanceId）。 */
function findPlacedSlot(inv, instanceId) {
  const check = (item, group, index) =>
    (item?.instanceId && item.instanceId === instanceId)
      ? { group, index, item }
      : null;
  let hit = check(inv.armor, 'armor', 0);
  for (const group of ['primary', 'grenade', 'misc']) {
    const arr = inv[group];
    if (!Array.isArray(arr)) continue;
    for (let i = 0; i < arr.length; i++) {
      hit = hit ?? check(arr[i], group, i);
    }
  }
  return hit ?? null;
}

/** 装备背包快照（深拷贝，保留 Infinity）。 */
export function snapshotInventory(inv) {
  if (!inv) return null;
  return deepClone({
    armor: inv.armor,
    pistol: inv.pistol,
    primary: inv.primary,
    grenade: inv.grenade,
    misc: inv.misc,
  });
}

/** 从事务快照恢复装备背包（数组引用原地替换）。 */
export function restoreInventory(inv, snap) {
  if (!inv || !snap) return;
  inv.armor = snap.armor;
  inv.pistol = snap.pistol;
  for (const key of ['primary', 'grenade', 'misc']) {
    if (!Array.isArray(inv[key])) continue;
    inv[key].splice(0, inv[key].length, ...(snap[key] ?? []));
  }
}

/** 保底装备判定（与 inventory.js 内部 `_isDefaultGear` 同规则，这里按实例判）。 */
function isDefaultGear(item) {
  if (!item) return false;
  const kind = item.slotKind ?? item.kind ?? item.type;
  if (kind === 'weapon') return item.defId === 'pistol' || item.defId === 'pistolFast';
  if (kind === 'armor') return item.defId === 'standard' || !item.instanceId;
  if (kind === 'grenade') return item.defId === 'flash';
  return false;
}

// ═══════════════════════════════════════════════════════════════════════════
// 背包 → 仓库（卸下 / 快速移入）
// ═══════════════════════════════════════════════════════════════════════════

/**
 * 把指定实例从装备背包卸下（恢复到仓库可用源）。
 * 按 instanceId 识别；同一实例只允许出现在一处，绝不复制。
 * 容量说明：本函数只移动「本来就已入 stash 的实例」，因此不产生新的
 * 容量占用；任何不在 stash 的实例（快照回滚保护下）也不会被写入。
 *
 * @param {Array<object|string>} items 实例对象或 instanceId
 * @returns {{ok: boolean, moved: object[], touched: boolean, reason?: string}}
 */
export function quickMoveToStash(items) {
  const list = Array.isArray(items) ? items : [items];
  const inv = loadoutManager.getInventory();
  const snap = snapshotInventory(inv);
  const moved = [];
  let overflow = [];
  let touched = false;

  for (const raw of list) {
    const id = typeof raw === 'string' ? raw : raw?.instanceId;
    const item = raw && typeof raw === 'object' ? raw : null;
    if (!id && !item) continue;

    // 保底手枪槽锁定：item 就是手枪槽实例时明确拒绝（无 instanceId 可查）。
    if (inv.pistol && item && inv.pistol === item) {
      restoreInventory(inv, snap);
      return { ok: false, reason: '保底手枪槽锁定 · 不可卸下', moved: [], touched };
    }

    let placed;
    if (id) placed = findPlacedSlot(inv, id);
    else placed = findPlacedSlot(inv, item?.instanceId);

    // 未在背包中：若是真实 stash 实例（如从仓库直接调用），保证仍在仓库即可。
    if (!placed) {
      if (id && !isDefaultGear(item)) {
        const stashItem = findStashItem(id);
        if (stashItem && !isDefaultGear(stashItem)) touched = true;   // 已在仓库，无需写入
      }
      continue;
    }

    const moving = placed.item;
    if (placed.group === 'pistol') {
      restoreInventory(inv, snap);
      return { ok: false, reason: '保底手枪槽锁定 · 不可卸下', moved: [], touched };
    }
    if (!isDefaultGear(moving)) {
      // 顺手守卫：若该实例真的不在 stash（理论上不应该），原子补回仓库，
      // 容量不足时返回 overflow 而不是静默删除。只在确实改过槽位时回滚
      // （本函数移动的是「已在仓库的实例」，正常情况下无需写入）。
      const res = ensureInStash(moving);
      if (res.overflow.length > 0) {
        if (touched) restoreInventory(inv, snap);
        return {
          ok: false,
          reason: '仓库已满 · 无法接管移出物品',
          moved: [],
          overflow: res.overflow,
          touched,
        };
      }
    }
    if (placed.group === 'armor') {
      /**
       * 卸甲缩容（批 5.1 修复）：护甲槽清空 → 落回 standard 地板（§2.5.2）。
       * 缩容必须按**清空后的** inv.armorId（= 'standard'）重排 —— 旧实现先
       * 取旧 armorId（dualist）再清空，resizeInventory 按 dualist 布局重排，
       * 第二主武器槽残留成「不可见但会被带入/丢失」的风险实例。
       * 所有溢出实例（第二主武器 / 超量手雷 / misc 截断）逐一确保回到
       * 仓库可用源；容量不足时明确返回 overflow 并整体回滚，绝不静默丢失。
       */
      inv.armor = null;
      const overflowItems = resizeInventory(inv, inv.armorId);
      if (overflowItems.length > 0) {
        for (const overflowItem of overflowItems) {
          const res = ensureInStash(overflowItem);
          if (res.overflow.length > 0) {
            restoreInventory(inv, snap);
            return {
              ok: false,
              reason: '仓库已满 · 无法接管缩容溢出物品',
              moved: [],
              overflow: res.overflow,
              touched,
            };
          }
        }
        moved.push(...overflowItems);
      } else {
        moved.push(moving);
      }
    } else {
      // 保底项（flash）：离开槽位后由 sync 落回保底地板，不在仓库留副本。
      placedRefTo(inv, placed).set(null);
      moved.push(moving);
    }
    touched = true;
  }

  if (touched) {
    loadoutManager.syncLoadoutFromInventory();
    afterInventoryEdit();
  }
  return { ok: true, moved, overflow, touched };
}

function placedRefTo(inv, placed) {
  return slotRef(inv, placed.group, placed.index);
}

/** 按 instanceId 在 stash 中找一个实例（现代/旧形状均可）。 */
export function findStashItem(instanceId) {
  const store = getSaveStore();
  const profile = store.getProfile();
  const raw = profile?.stash?.[instanceId];
  if (!raw) return null;
  return { ...deepClone(raw), instanceId: raw.instanceId ?? instanceId };
}

/** 确保实例在 stash：已在则什么都不做；不在则原子写入（容量满 → overflow）。 */
function ensureInStash(item) {
  const store = getSaveStore();
  const profile = store.getProfile();
  if (!profile || !item?.instanceId) return { added: [], overflow: [] };
  if (profile.stash[item.instanceId] || profile.stashOverflow[item.instanceId]) {
    return { added: [], overflow: [] };
  }
  return store.addStashItems([item]);
}

/**
 * 卸下全部（装备页「卸下全部到仓库」按钮）：
 * 清空护甲 / 主武器 / 手雷 / 杂项槽（手枪位锁定保留），
 * 需要缩容时走 resizeInventory，溢出物仍留在仓库可用源并随返回值列出。
 * 不触碰 RaidData —— 局外整备与局内战局是两个对象。
 * @returns {{ok: boolean, moved: object[], overflow: object[]}}
 */
export function unloadBackpack() {
  const inv = loadoutManager.getInventory();
  const snap = snapshotInventory(inv);
  const moved = [];
  const overflow = [];

  if (inv.armor) {
    // 手雷格里的保底 flash 与真实实例都卸下；护甲先卸（决定槽位布局）。
    moved.push(inv.armor);
    inv.armor = null;
  }
  for (const group of ['primary', 'grenade', 'misc']) {
    const arr = inv[group];
    if (!Array.isArray(arr)) continue;
    for (let i = 0; i < arr.length; i++) {
      if (arr[i] === null) continue;
      // 保底 flash 也是「卸下」语义：空槽落回保底地板，不留副件。
      moved.push(arr[i]);
      arr[i] = null;
    }
  }
  // 批 5.1：按清空后的 inv.armorId 缩容；溢出实例（dualist 第二主武器 /
  // grenadeBonus 超量手雷 / misc 截断）逐一确保回到仓库可用源，容量不足
  // 时整体回滚并明确返回 overflow —— 绝不静默丢失。
  const fromShrink = resizeInventory(inv, inv.armorId);
  for (const overflowItem of fromShrink) {
    const res = ensureInStash(overflowItem);
    if (res.overflow.length > 0) {
      restoreInventory(inv, snap);
      return { ok: false, reason: '仓库已满 · 无法接管缩容溢出物品', moved: [], overflow: res.overflow };
    }
  }
  overflow.push(...fromShrink);

  loadoutManager.syncLoadoutFromInventory();
  afterInventoryEdit();
  return { ok: true, moved, overflow };
}

// ═══════════════════════════════════════════════════════════════════════════
// 仓库 → 背包（快速移入指定格 / 自动放）
// ═══════════════════════════════════════════════════════════════════════════

/**
 * 从仓库把指定实例移入装备背包（与 Equipment/Backpack 格子转移共用
 * ItemInstance + 事务语义：快照回滚，不复制实例）。
 *
 * @param {string} instanceId  stash 键
 * @param {'equip-auto'|'unload'|object} target
 *   'equip-auto' → 按类型自动放入第一个合法格（autoPlace）；
 *   'unload'     → 从装备背包任意格卸下（逆操作）；
 *   {group,index} → 指定格（group: armor|primary|grenade|misc）。
 * @returns {{ok:boolean, item?:object, overflow?:object[], reason?:string}}
 */
export function moveStashItem(instanceId, target = 'equip-auto') {
  const inst = findStashItem(instanceId);
  if (!inst) return { ok: false, reason: '仓库中没有该实例' };
  const item = normalizeItemInstance(inst, { instanceId });
  if (!item) return { ok: false, reason: '实例形状无法识别' };
  if (isDefaultGear(item)) {
    return { ok: false, reason: '保底装备不能被移动或删除（无 stash 实例）' };
  }
  const inv = loadoutManager.getInventory();
  const snap = snapshotInventory(inv);

  if (target === 'unload' || target === 'stash') {
    const placed = findPlacedSlot(inv, instanceId);
    if (!placed) {
      restoreInventory(inv, snap);
      return { ok: false, reason: '该实例不在装备背包中' };
    }
    if (placed.group === 'pistol') {
      restoreInventory(inv, snap);
      return { ok: false, reason: '保底手枪槽锁定 · 不可卸下' };
    }
    if (placed.group === 'armor') {
      // 批 5.1：按清空后的 inv.armorId 缩容；溢出实例逐一确保回到仓库
      // 可用源，容量不足时明确回滚并返回 overflow，绝不静默丢失。
      inv.armor = null;
      const overflow = resizeInventory(inv, inv.armorId);
      for (const overflowItem of overflow) {
        const res = ensureInStash(overflowItem);
        if (res.overflow.length > 0) {
          restoreInventory(inv, snap);
          return {
            ok: false,
            reason: '仓库已满 · 无法接管缩容溢出物品',
            overflow: res.overflow,
          };
        }
      }
      loadoutManager.syncLoadoutFromInventory();
      afterInventoryEdit();
      return { ok: true, item, overflow };
    }
    placedRefTo(inv, placed).set(null);
    loadoutManager.syncLoadoutFromInventory();
    afterInventoryEdit();
    return { ok: true, item, overflow: [] };
  }

  // 实例身份不变量：同一 instanceId 只允许在装备背包出现一次。
  if (findPlacedSlot(inv, instanceId)) {
    restoreInventory(inv, snap);
    return { ok: false, reason: '该实例已在装备背包中（不重复放置）' };
  }

  // 指定格 / 自动放
  let result;
  if (target === 'equip-auto') {
    result = autoPlace(inv, item);
  } else {
    const { group, index } = target ?? {};
    const ref = slotRef(inv, group, index);
    if (!ref) {
      restoreInventory(inv, snap);
      return { ok: false, reason: `未知槽位：${group}` };
    }
    const accepted = canAccept(group, item);
    if (!accepted.ok) {
      restoreInventory(inv, snap);
      return { ok: false, reason: accepted.reason };
    }
    if (ref.get()) {
      restoreInventory(inv, snap);
      return { ok: false, reason: '目标格已占用' };
    }
    ref.set(item);
    result = { placed: 1, remaining: 0 };
  }

  if (!result || result.placed <= 0) {
    restoreInventory(inv, snap);
    return { ok: false, reason: '装备背包没有可用的合法槽位' };
  }
  // 护甲入槽 → 触发缩容重排（溢出物仍在 stash 可用源，随返回值提示）。
  let overflow = [];
  const placed = findPlacedSlot(inv, instanceId);
  if (placed?.group === 'armor') {
    overflow = resizeInventory(inv, inv.armorId);
  }
  loadoutManager.syncLoadoutFromInventory();
  afterInventoryEdit();
  return { ok: true, item, overflow };
}

// ═══════════════════════════════════════════════════════════════════════════
// 制作（原子：检查 → 扣材料 → 建实例 → 入仓）
// ═══════════════════════════════════════════════════════════════════════════

/** 配方产物实例（ItemInstance + 旧形状兼容字段 type/blueprintId）。 */
export function createCraftInstance(recipe, overrides = {}) {
  const { slotKind, defId, quantity } = recipe.output;
  const payload = {};
  if (slotKind === 'attachment') {
    payload.compatibleWeapons = ATTACHMENTS[defId]?.compatibleWeapons ?? [];
  }
  const item = ItemInstance(slotKind, defId, {
    quantity: Math.max(1, quantity ?? 1),
    name: recipe.name,
    payload,
    ...overrides,
  });
  // 旧形状兼容：unlock-checker 按 item.type + item.blueprintId 识别成品实例
  // （{type:'weapon', blueprintId:'smg'} 与 ItemInstance 的 slotKind/defId 并存）。
  return {
    ...item,
    type: slotKind,
    blueprintId: recipe.blueprintId ?? defId,
    ...(slotKind === 'consumable' ? { kind: 'consumable' } : {}),
  };
}

/**
 * 原子制作：材料不足 / 缺蓝图门票 / 未知配方 → 不写任何状态；
 * 扣材料后任何写入失败 → 恢复材料与原 stash 状态（快照回滚）；
 * 仓库满 → 产物进入 stashOverflow（明确返回，不静默丢）。
 *
 * @param {string} recipeId CRAFTING_RECIPES 的键
 * @returns {{ok:boolean, item?:object, overflow?:object[], reason?:string}}
 */
export function craft(recipeId) {
  const store = getSaveStore();
  const recipe = CRAFTING_RECIPES[recipeId];
  if (!recipe) return { ok: false, reason: '未知配方' };
  const profile = store.getProfile();
  if (!profile) return { ok: false, reason: '档案未加载' };

  const blueprintId = recipe.blueprintId ?? recipe.output.defId;
  if (recipe.requiresBlueprint && profile.blueprints?.[blueprintId] !== true) {
    return { ok: false, reason: '未解锁 · 需要蓝图门票' };
  }
  for (const m of recipe.materials) {
    const have = profile.materials?.[m.id] ?? 0;
    if (have < m.count) {
      return { ok: false, reason: `材料不足 · ${m.name} 缺 ${m.count - have}` };
    }
  }

  // 快照（保留 Infinity/undefined）→ 扣材料 → 入仓；任一失败整体回滚。
  const before = deepClone(profile);
  for (const m of recipe.materials) {
    if (!store.updateMaterial(m.id, -m.count)) {
      restoreProfile(store, before);
      return { ok: false, reason: '材料扣除失败' };
    }
  }
  const output = createCraftInstance(recipe);
  const res = store.addStashItems([output]);
  if (!res.ok && res.reason?.startsWith('Stash capacity')) {
    // 建档成功但容量满：产物明确进 stashOverflow，玩家可在仓库看到并整理
    //（绝不静默丢）；注意与「写盘失败」（reason 不同）严格区分。
    afterInventoryEdit();
    return {
      ok: true,
      capacityFull: true,
      item: res.overflow[0],
      overflow: res.overflow,
      reason: '制作成功 · 仓库已满 · 产物进入待整理区',
    };
  }
  if (!res.ok || res.added.length === 0) {
    restoreProfile(store, before);
    return { ok: false, reason: '仓库写入失败 · 已回滚材料' };
  }
  afterInventoryEdit();
  return { ok: true, capacityFull: false, item: res.added[0], overflow: [] };
}

function restoreProfile(store, snapshot) {
  store.profile = snapshot;
  store.saveProfile();
}

// ═══════════════════════════════════════════════════════════════════════════
// 待整理区（stashOverflow）整理（批 5.1）
// ═══════════════════════════════════════════════════════════════════════════

/**
 * 把待整理区（stashOverflow）中**容量允许**的实例原子移回仓库（stash），
 * 剩余继续保留待整理区。实例身份不变（stashOverflow 键 = instanceId），
 * 绝不复制、绝不删除；任一写盘失败整体回滚。
 * 不改变默认容量，也不引入任何扩容。
 *
 * @returns {{ok: boolean, moved: object[], remaining: object[],
 *            movedCount: number, remainingCount: number, reason?: string}}
 */
export function organizeOverflow() {
  const store = getSaveStore();
  const profile = store.profile;
  if (!profile) {
    return { ok: false, reason: '档案未加载', moved: [], remaining: [], movedCount: 0, remainingCount: 0 };
  }
  const entries = Object.entries(profile.stashOverflow ?? {})
    .filter(([, item]) => item && typeof item === 'object');
  if (entries.length === 0) {
    return { ok: true, moved: [], remaining: [], movedCount: 0, remainingCount: 0 };
  }

  const before = deepClone(profile);
  const capacity = profile.stashCapacity ?? 24;
  const stashUsed = () => Object.keys(profile.stash).length;
  const moved = [];
  const remaining = [];
  for (const [key, item] of entries) {
    if (stashUsed() < capacity) {
      delete profile.stashOverflow[key];
      profile.stash[key] = item;
      moved.push(item);
    } else {
      remaining.push(item);
    }
  }
  if (!store.saveProfile()) {
    store.profile = before;
    return {
      ok: false,
      reason: '整理写入失败 · 状态已回滚',
      moved: [], remaining,
      movedCount: 0, remainingCount: remaining.length,
    };
  }
  afterInventoryEdit();
  return {
    ok: true,
    moved, remaining,
    movedCount: moved.length, remainingCount: remaining.length,
  };
}

/**
 * 单件原子回移：把指定 instanceId 的待整理实例移回仓库。
 * 容量不足 / 不在待整理区 → 明确返回，绝不改写任何状态。
 * @param {string} instanceId
 * @returns {{ok: boolean, item?: object, reason?: string}}
 */
export function moveOverflowToStash(instanceId) {
  const store = getSaveStore();
  const profile = store.profile;
  if (!profile) return { ok: false, reason: '档案未加载' };
  const item = profile.stashOverflow?.[instanceId];
  if (!item) return { ok: false, reason: '待整理区没有该实例' };
  if (Object.keys(profile.stash).length >= (profile.stashCapacity ?? 24)) {
    return { ok: false, reason: '仓库已满 · 该实例仍留在待整理区', item };
  }
  const before = deepClone(profile);
  delete profile.stashOverflow[instanceId];
  profile.stash[instanceId] = item;
  if (!store.saveProfile()) {
    store.profile = before;
    return { ok: false, reason: '移动写入失败 · 状态已回滚' };
  }
  afterInventoryEdit();
  return { ok: true, item };
}

/** 配方渲染状态（hub-nav 制作页三态）。 */
export function getRecipeState(recipeId) {
  const store = getSaveStore();
  const profile = store.getProfile();
  const recipe = CRAFTING_RECIPES[recipeId];
  if (!recipe) return null;
  const materials = (recipe.materials ?? []).map((m) => ({
    ...m,
    have: profile?.materials?.[m.id] ?? 0,
    sufficient: (profile?.materials?.[m.id] ?? 0) >= m.count,
  }));
  const allSufficient = materials.every((m) => m.sufficient);
  const blueprintOwned = !recipe.requiresBlueprint
    || profile?.blueprints?.[recipe.blueprintId] === true;
  return {
    recipe,
    materials,
    allSufficient,
    blueprintOwned,
    craftable: allSufficient && blueprintOwned,
    state: blueprintOwned ? (allSufficient ? 'ready' : 'insufficient') : 'locked',
  };
}

// ═══════════════════════════════════════════════════════════════════════════
// 编辑收口
// ═══════════════════════════════════════════════════════════════════════════

/** 编辑后统一通知（loadout-changed 由 main.js 监听刷新简报/摘要）。 */
function afterInventoryEdit() {
  if (typeof window === 'undefined' || typeof window.dispatchEvent !== 'function') return;
  try {
    window.dispatchEvent(new CustomEvent('inventory-edited'));
    window.dispatchEvent(new CustomEvent('loadout-changed'));
  } catch { /* 无 CustomEvent 构造器（node 裸环境）时静默 */ }
}
