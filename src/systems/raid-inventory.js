/**
 * 战局统一容器（批 0）。
 *
 * 这一层只定义可序列化的数据、放置和事务，不渲染 UI、不接管输入。
 * 运行时的四个容器是：
 *   - equipment: 护甲 / 保底手枪 / 主武器位（现阶段仍由 Loadout 战斗层权威）
 *   - backpack: 手雷格和杂项格（复用 inventory.js 的容量和堆叠规则）
 *   - quickUse: 固定 5 格，只容纳 grenade / consumable
 *   - openContainer: 当前打开容器的会话，持有其统一 ItemInstance 列表
 *
 * `quickUse` 是投掷/使用扣减的唯一真源（批 2 起）：投掷成功调用
 * consumeQuickUse() 原子扣减。game.nades/nadeKind 通过
 * syncLegacyGrenadeFromQuickUse() 只做「单向、只读兼容」投影，任何调用方
 * 都不得再向旧字段写入独立数量，避免两份可独立修改的真源并存。
 */

import {
  ItemInstance,
  autoPlace,
  canAccept,
  createInventory,
  effectiveArmorId,
} from './inventory.js';

export const QUICK_USE_SLOT_COUNT = 5;

/**
 * 打开容器会话的固定格子容量（批 4 · 本项目自定，不是截图里的 ARC 数值）。
 * 战利品箱每箱产出 1~3 件实例，12 格给玩家→容器回放留足余量；
 * 数值只在容器栏标题与容量判定中生效，不影响掉落表与物品数据。
 */
export const OPEN_CONTAINER_CAPACITY = 12;

const QUICK_USE_KINDS = new Set(['grenade', 'consumable']);
const BACKPACK_KINDS = new Set(['grenade', 'material', 'blueprint', 'consumable', 'attachment']);
let fragmentSequence = 0;

function nextFragmentId() {
  return `raid_fragment_${Date.now().toString(36)}_${(++fragmentSequence).toString(36)}`;
}

/**
 * 深拷贝（事务快照 / 回滚专用）。JSON.parse(JSON.stringify()) 会把
 * Infinity / NaN 抹成 null、把 undefined 属性整键丢弃，从而破坏
 * 「弹药 ∞ / 未定义字段」这类 payload 语义与逐字节回滚；
 * 这里优先用 structuredClone（Node 17+ / 现代浏览器原生保留
 * Infinity / undefined / NaN / 稀疏数组洞），不支持或数据含不可克隆
 * 引用时回退到手写递归拷贝。
 *
 * 快照刻意只取数据字段（openContainer 只拷 items 数据数组，容器对象
 * 保留在会话上），因此绝不递归复制 DOM / THREE 引用 —— 手写回退对
 * 非普通对象一律保留原引用。
 */
function clone(value) {
  if (value === undefined) return undefined;
  if (typeof structuredClone === 'function') {
    try {
      return structuredClone(value);
    } catch {
      // 数据里混入不可结构化克隆的引用（函数 / 符号等）时退入手写拷贝。
    }
  }
  return cloneValue(value, new Map());
}

function cloneValue(value, seen) {
  if (value === null || typeof value !== 'object') return value;
  if (seen.has(value)) return seen.get(value);
  if (value instanceof Date) return new Date(value.getTime());
  if (value instanceof RegExp) return new RegExp(value.source, value.flags);
  if (Array.isArray(value)) {
    const out = new Array(value.length);      // 保留稀疏数组洞（洞 ≠ null）
    seen.set(value, out);
    for (let i = 0; i < value.length; i++) {
      if (Object.prototype.hasOwnProperty.call(value, i)) {
        out[i] = cloneValue(value[i], seen);
      }
    }
    return out;
  }
  const proto = Object.getPrototypeOf(value);
  if (proto === Object.prototype || proto === null) {
    const out = {};
    seen.set(value, out);
    for (const key of Object.keys(value)) out[key] = cloneValue(value[key], seen);
    return out;
  }
  // 其它对象（DOM / THREE 引用等）：保留引用，不递归复制。
  return value;
}

function itemKind(item) {
  return item?.slotKind ?? item?.kind ?? item?.type ?? null;
}

function itemDefId(item, kind) {
  if (item?.defId) return item.defId;
  if (kind === 'material') return item?.materialId ?? item?.itemId;
  if (kind === 'blueprint') return item?.blueprintId ?? item?.targetId ?? item?.itemId;
  return item?.blueprintId ?? item?.itemId ?? item?.materialId;
}

/**
 * 旧 loot/stash 形状和已经统一的 ItemInstance 的唯一入口。
 * 不依赖 class，输出始终是可 JSON 序列化的扁平 ItemInstance。
 */
export function normalizeItemInstance(item, context = {}) {
  if (!item || typeof item !== 'object') return null;

  const kind = itemKind(item);
  const defId = itemDefId(item, kind);
  if (!kind || !defId) return null;

  const instanceId = item.instanceId ?? item.lootId ?? context.instanceId;
  const payload = {
    ...(item.payload ?? {}),
  };
  if (kind === 'material' && payload.tier === undefined) payload.tier = item.tier ?? null;
  if (kind === 'blueprint') {
    payload.targetType ??= item.targetType ?? null;
    payload.targetId ??= item.targetId ?? item.blueprintId ?? defId;
  }

  const normalized = ItemInstance(kind, defId, {
    ...(instanceId ? { instanceId } : {}),
    name: item.name ?? defId,
    quantity: Math.max(1, Number.isFinite(item.quantity) ? Math.floor(item.quantity) : 1),
    ...(item.stackMax !== undefined ? { stackMax: Math.max(1, Math.floor(item.stackMax)) } : {}),
    value: Number.isFinite(item.value) ? item.value : 0,
    payload,
  });

  // 旧 API 仍会读取这几个字段；统一容器不把它们作为真源，但保留只读兼容数据。
  if (kind === 'material') {
    normalized.itemId = defId;
    normalized.materialId = defId;
    normalized.kind = 'material';
  } else if (kind === 'blueprint') {
    normalized.blueprintId = item.blueprintId ?? defId;
    normalized.kind = 'blueprint';
  }
  return normalized;
}

function ensureArray(value, length) {
  const result = Array.isArray(value) ? value : [];
  while (result.length < length) result.push(null);
  if (result.length > length) result.length = length;
  return result;
}

function createEquipment(options = {}) {
  const source = options.equipment ?? {};
  return {
    armor: source.armor ?? options.armor ?? null,
    pistol: source.pistol ?? options.pistol ?? null,
    primary: Array.isArray(source.primary ?? options.primary)
      ? (source.primary ?? options.primary)
      : [],
  };
}

/**
 * 创建四容器根对象。传 legacyInventory 时各数组会直接复用旧结构的引用，
 * 因而 player.inventory 和 raidInventory 不会变成两个可独立修改的真源。
 */
export function createRaidInventory(options = {}) {
  const legacy = options.legacyInventory ?? null;
  const equipment = legacy
    ? {
        get armor() { return legacy.armor ?? null; },
        set armor(value) { legacy.armor = value; },
        get pistol() { return legacy.pistol ?? null; },
        set pistol(value) { legacy.pistol = value; },
        primary: legacy.primary ?? [],
      }
    : createEquipment(options);
  const fallback = createInventory({ armor: equipment.armor ?? null });
  const backpackSource = options.backpack ?? {};
  const backpack = {
    grenade: legacy?.grenade ?? backpackSource.grenade ?? fallback.grenade,
    misc: legacy?.misc ?? backpackSource.misc ?? fallback.misc,
  };

  const quickUse = ensureArray(options.quickUse ?? [], QUICK_USE_SLOT_COUNT);
  const inventory = {
    equipment,
    backpack,
    quickUse,
    openContainer: options.openContainer ?? null,
    get armorId() { return this.equipment.armor?.defId ?? 'standard'; },
  };

  // 明确的尺寸对齐；只补空，不主动移动已有数据，缩容由 inventory.js 的 resizeInventory 负责。
  if (!legacy) {
    const layout = createInventory({ armor: equipment.armor ?? null });
    if (!backpack.grenade.length) backpack.grenade = layout.grenade;
    if (!backpack.misc.length) backpack.misc = layout.misc;
  }
  return inventory;
}

/** 将 raid 根对象投影为 inventory.js 可消费的结构；数组均共享引用。 */
function asLegacyInventory(raidInventory) {
  return {
    armor: raidInventory.equipment.armor,
    pistol: raidInventory.equipment.pistol,
    primary: raidInventory.equipment.primary,
    grenade: raidInventory.backpack.grenade,
    misc: raidInventory.backpack.misc,
    get armorId() { return effectiveArmorId(this); },
  };
}

/**
 * Loadout → Equipment 的唯一单向同步入口（批 5 在 main.js startMission 调用）。
 * 战斗 Loadout 仍是主武器/弹药真源（不破坏双主武器流程），这里把同一份实例
 * 镜像进局内 equipment 视图：带 raidOrigin 标记，所以不会被 getCarriedItems
 * 当成新战利品再次结算；风险归属仍由 pendingRaid.riskedItems 决定。
 *
 * 批 5 扩展：传 options.instances = { pistol, primary: ItemInstance[] } 时，
 * 直接沿用局外装备页/仓库里的原实例（保留 instanceId + payload —— 尤其
 * payload.reserve: Infinity 与 attachments），而不是重建新实例 —— 保证
 * 装备页 / 仓库 / 开局 / 结算看到的是同一个实例（实例身份不变量）。
 * loadout（Loadout.slots）仍是战斗数值真源，该投影只负责一致视图。
 */
export function syncEquipmentFromLoadout(raidInventory, loadout, options = {}) {
  if (!raidInventory?.equipment || !loadout?.slots) {
    return { ok: false, reason: '缺少 Equipment 或 Loadout' };
  }
  const armorId = options.armorId ?? 'standard';
  const attachments = options.attachments ?? {};
  const instances = options.instances ?? {};
  const makeWeapon = (weapon, source = null) => {
    if (source) {
      // 沿用局外原实例：instanceId + payload（attachments/ammo/reserve 含
      // Infinity）+ 旧形状字段原样保留，只附加 raidOrigin 排除标记。
      return { ...clone(source), payload: { ...clone(source.payload ?? {}), raidOrigin: 'loadout' } };
    }
    return ItemInstance('weapon', weapon.id, {
      payload: {
        attachments: clone(attachments[weapon.id] ?? {}),
        ammo: weapon.ammo,
        reserve: weapon.reserve,
        raidOrigin: 'loadout',
      },
    });
  };

  const pistol = loadout.slots[0];
  raidInventory.equipment.pistol = pistol
    ? makeWeapon(pistol, instances.pistol ?? null) : null;
  raidInventory.equipment.armor = armorId === 'standard'
    ? null
    : {
        ...(instances.armor
          ? clone(instances.armor)
          : ItemInstance('armor', armorId, {})),
        payload: { ...(instances.armor ? clone(instances.armor.payload ?? {}) : {}), raidOrigin: 'loadout' },
      };

  const desired = Math.max(0, Math.min(2, Number(loadout.maxPrimarySlots) || 0));
  const primary = raidInventory.equipment.primary;
  while (primary.length < desired) primary.push(null);
  if (primary.length > desired) primary.length = desired;
  for (let i = 0; i < desired; i++) {
    const weapon = loadout.slots[i + 1];
    primary[i] = weapon ? makeWeapon(weapon, instances.primary?.[i] ?? null) : null;
  }
  return { ok: true, equipment: raidInventory.equipment };
}

/**
 * 局内拾取武器/掉落物的唯一 loot instance id（批 5.1）。拾取物本体
 * （ground pickup 的 {weapon, ammo, reserve}）没有稳定 id；第一次拾取时
 * 生成并固定在 pickup payload 上，替换/掉落路径沿用同一 id —— 保证
 * 同一把枪在「捡回 / 再掉落 / 结算」全程身份一致，绝不重复入库。
 * 前缀与 inv_fragment_* / raid_fragment_* 刻意不同。
 */
let lootInstanceSequence = 0;
export function nextLootInstanceId() {
  return `raid_loot_${Date.now().toString(36)}_${(++lootInstanceSequence).toString(36)}`;
}

/**
 * 局内拾取主武器 → 局内 equipment 视图的**唯一镜像入口**（批 5.1 修复）。
 *
 * 真源约定：Loadout.slots 仍是战斗数值真源（本局拾取/替换/切枪都写在
 * Loadout），本函数只在每次 pickup / replace 之后把对应槽（1|2）的
 * WeaponInstance 镜像成 ItemInstance 写入 raidInventory.equipment.primary：
 *   · 保留 instanceId（options.instanceId = 拾取物 payload 的 loot id；
 *     未传时生成唯一 id）与 ammo / reserve（含 Infinity）/ attachments；
 *   · 不写 payload.raidOrigin —— 新拾取武器是**本局新战利品**，参与
 *     getCarriedItems 与成功撤离/死亡处理（成功入库、死亡随携带物丢弃）；
 *   · 返回 replaced：被替换下来的原实例（带原 instanceId）。若原实例是
 *     本局带入风险物（raidOrigin: 'loadout'），它的返还仍由
 *     pendingRaid.riskedItems 决定（绝不重复入库、绝不丢失）；若原实例是
 *     局内拾取的战利品，调用方把 replaced.instanceId 回写到掉落物 payload，
 *     掉落/再拾取仍是同一把枪（身份一致）。
 *   · options.raidOrigin：捡回「带入风险物 drop 后重捡」时用它标记
 *     （'loadout'），保证该实例继续被排除在 carriedLoot 之外（归还路径
 *     仍是 riskedItems），不出现「同 id 又入库一次」的双份风险。
 *
 * @param {object} raidInventory  战局容器（equipment.primary 被写回）
 * @param {object} loadout       Loadout 实例（slots 是战斗真源）
 * @param {number} slotIndex     1（主武器 1）或 2（主武器 2）
 * @param {object} [options]     { instanceId, raidOrigin }
 * @returns {{ok: boolean, item?: object|null, replaced?: object|null, reason?: string}}
 */
export function mirrorPrimaryFromLoadout(raidInventory, loadout, slotIndex, options = {}) {
  if (!raidInventory?.equipment || !loadout?.slots) {
    return { ok: false, reason: '缺少 Equipment 或 Loadout' };
  }
  const idx = Math.floor(Number(slotIndex));
  if (idx !== 1 && idx !== 2) {
    return { ok: false, reason: `未知主武器槽：${slotIndex}` };
  }
  if (idx === 2 && Math.floor(Number(loadout.maxPrimarySlots) || 1) < 2) {
    return { ok: false, reason: '主武器槽 2 未解锁' };
  }
  const weapon = loadout.slots[idx];
  const primary = raidInventory.equipment.primary;
  while (primary.length < 2) primary.push(null);
  if (primary.length > 2) primary.length = 2;
  const previous = primary[idx - 1];
  if (!weapon) {
    primary[idx - 1] = null;
    return { ok: true, item: null, replaced: previous ?? null };
  }
  const spec = weapon.spec ?? {};
  const instanceId = options.instanceId ?? nextLootInstanceId();
  const priorAttachments = previous?.defId === spec.id
    ? previous?.payload?.attachments
    : undefined;
  const payload = {
    attachments: priorAttachments ? clone(priorAttachments) : {},
    ammo: weapon.ammo,
    reserve: weapon.reserve,
  };
  if (options.raidOrigin) payload.raidOrigin = options.raidOrigin;
  primary[idx - 1] = ItemInstance('weapon', spec.id, {
    instanceId,
    name: spec.name ?? spec.id,
    quantity: 1,
    stackMax: 1,
    value: 0,
    payload,
  });
  return { ok: true, item: primary[idx - 1], replaced: previous ?? null };
}

function findInArrays(arrays, itemOrId) {
  const id = typeof itemOrId === 'string' ? itemOrId : itemOrId?.instanceId;
  for (const [container, array] of arrays) {
    if (!Array.isArray(array)) continue;
    for (let index = 0; index < array.length; index++) {
      const item = array[index];
      if (!item) continue;
      if (item === itemOrId || (id && item.instanceId === id)) {
        return { container, array, index, item };
      }
    }
  }
  return null;
}

function removeLocation(location) {
  if (!location) return null;
  if (location.array === undefined) return null;
  const [item] = location.array.splice(location.index, 1);
  if (location.fixed) location.array.splice(location.index, 0, null);
  return item;
}

function quickUseLocation(raidInventory, itemOrId) {
  const found = findInArrays([['quickUse', raidInventory.quickUse]], itemOrId);
  return found ? { ...found, fixed: true } : null;
}

function backpackLocation(raidInventory, itemOrId) {
  const found = findInArrays([
    ['grenade', raidInventory.backpack.grenade],
    ['misc', raidInventory.backpack.misc],
  ], itemOrId);
  return found ? { ...found, fixed: true } : null;
}

function containerLocation(raidInventory, itemOrId) {
  const items = raidInventory.openContainer?.items;
  return findInArrays([['container', items]], itemOrId);
}

function allLocations(raidInventory, itemOrId) {
  return [
    backpackLocation(raidInventory, itemOrId),
    quickUseLocation(raidInventory, itemOrId),
    containerLocation(raidInventory, itemOrId),
  ].filter(Boolean);
}

/**
 * 放进背包，完全复用 inventory.js 的类型隔离、跨格堆叠和容量语义。
 * remaining 是未放入的 ItemInstance（或 null），而不是被静默抹掉的数量。
 */
export function placeIntoBackpack(raidInventory, item) {
  if (!raidInventory || !item) {
    return { placed: 0, remaining: normalizeItemInstance(item), reason: '缺少背包或物品' };
  }
  const normalized = normalizeItemInstance(item);
  if (!normalized) return { placed: 0, remaining: null, reason: '无法识别物品形状' };
  if (!BACKPACK_KINDS.has(normalized.slotKind)) {
    return {
      placed: 0,
      remaining: normalized,
      reason: normalized.slotKind === 'weapon' || normalized.slotKind === 'armor'
        ? '武器和护甲只能放入装备位，不能放入背包'
        : `背包不接受 ${normalized.slotKind}`,
    };
  }

  const probeSlot = normalized.slotKind === 'grenade' ? 'grenade' : 'misc';
  const accepted = canAccept(probeSlot, normalized);
  if (!accepted.ok) return { placed: 0, remaining: normalized, reason: accepted.reason };

  const result = autoPlace(asLegacyInventory(raidInventory), normalized);
  return {
    placed: result.placed,
    // 一个原实例被拆入多格时，剩余部分必须换新 instanceId，避免后续 QuickUse /
    // stash 同时出现两个相同实例 id。quantity=0 时没有剩余对象。
    remaining: result.remaining > 0
      ? { ...normalized, instanceId: result.placed > 0 ? nextFragmentId() : normalized.instanceId, quantity: result.remaining }
      : null,
    reason: result.remaining > 0 ? '背包对应类型的格子容量不足' : null,
  };
}

function assertQuickUseItem(item) {
  if (!item) return { ok: false, reason: '空物品不能放入 QuickUse' };
  if (!QUICK_USE_KINDS.has(item.slotKind)) {
    return { ok: false, reason: 'QuickUse 只接受手雷或消耗品' };
  }
  return { ok: true };
}

/**
 * 将背包中的整组物品明确移动到一个固定 QuickUse 槽。它不复制对象；目标已占时
 * 默认拒绝，避免把已有物品覆盖丢失。容器转移内部可传 allowExternal，由事务负责
 * 在同一快照内先从来源取走再放入。
 */
export function setQuickUseSlot(raidInventory, index, item, options = {}) {
  if (!raidInventory || !Number.isInteger(index) || index < 0 || index >= QUICK_USE_SLOT_COUNT) {
    return { ok: false, reason: 'QuickUse 槽位索引无效' };
  }
  const sourceQuick = quickUseLocation(raidInventory, item);
  const sourceBackpack = backpackLocation(raidInventory, item);
  // 背包来源保留原对象引用，保证这里是移动而不是 clone；外部来源才规范化。
  const moving = sourceQuick?.item ?? sourceBackpack?.item ?? normalizeItemInstance(item);
  const accepted = assertQuickUseItem(moving);
  if (!accepted.ok) return accepted;

  const target = raidInventory.quickUse[index];
  if (target && target !== moving && target.instanceId !== moving.instanceId) {
    return { ok: false, reason: '目标 QuickUse 槽已被占用' };
  }

  // 同一 instanceId 已在别的槽中，绝不让两个槽引用它。
  const duplicate = quickUseLocation(raidInventory, moving.instanceId);
  if (duplicate && duplicate.index !== index && !sourceQuick) {
    return { ok: false, reason: '同一实例不能同时引用到多个 QuickUse 槽' };
  }

  if (sourceQuick) {
    if (sourceQuick.index === index) return { ok: true, moved: false, item: sourceQuick.item };
    if (target) return { ok: false, reason: '目标 QuickUse 槽已被占用' };
    raidInventory.quickUse[sourceQuick.index] = null;
    raidInventory.quickUse[index] = sourceQuick.item;
    return { ok: true, moved: true, item: sourceQuick.item };
  }

  if (!sourceBackpack && !options.allowExternal) {
    return { ok: false, reason: 'QuickUse 物品必须从背包明确移入' };
  }
  if (sourceBackpack) sourceBackpack.array[sourceBackpack.index] = null;
  raidInventory.quickUse[index] = moving;
  return { ok: true, moved: true, item: moving };
}

/**
 * 清空 QuickUse 槽时先把物品完整放回背包。背包装不下时不改变任何状态，绝不丢失。
 */
export function clearQuickUseSlot(raidInventory, index) {
  if (!raidInventory || !Number.isInteger(index) || index < 0 || index >= QUICK_USE_SLOT_COUNT) {
    return { ok: false, reason: 'QuickUse 槽位索引无效' };
  }
  const item = raidInventory.quickUse[index];
  if (!item) return { ok: true, cleared: false, item: null };
  const snapshot = snapshotRaidInventory(raidInventory);
  const placed = placeIntoBackpack(raidInventory, item);
  if (placed.remaining) {
    restoreRaidInventory(raidInventory, snapshot);
    return { ok: false, reason: placed.reason, item };
  }
  raidInventory.quickUse[index] = null;
  return { ok: true, cleared: true, item };
}

/**
 * 创建或刷新当前容器会话（批 4 会话唯一状态）。
 * items 与 LootContainer.loot 是**同一个数组引用**（不是副本），所以
 * 容器面板里的转移会直接反映到箱子本身；重复对同一个容器调用只会
 * 重建会话外壳，items 仍是同一份战利品 —— 绝不重新生成。
 *
 * 会话形状：
 *   { id, container, items, capacity, label, selected }
 *   · id       稳定容器 id（LootContainer.id），面板/选中状态按它识别
 *   · container 运行时引用（THREE 对象，snapshot/restore 刻意不克隆）
 *   · items    与容器 loot 同引用的 ItemInstance 数组
 *   · capacity 本项目固定格子容量（OPEN_CONTAINER_CAPACITY）
 *   · label    本项目稀有度文案（普通/军用/稀有 + 「箱」）
 *   · selected 会话内上次选中的容器槽索引（UI 同步，非存档字段）
 */
export function openContainerSession(raidInventory, container, options = {}) {
  if (!raidInventory || !container) return null;
  const rawItems = typeof container.open === 'function' ? container.open() : container.loot;
  const items = Array.isArray(rawItems) ? rawItems : [];
  for (let i = 0; i < items.length; i++) items[i] = normalizeItemInstance(items[i]);
  const pos = container.pos ?? {};
  const id = options.id ?? container.id
    ?? `loot_${String(pos.x ?? 0).replace('.', '_')},${String(pos.z ?? 0).replace('.', '_')}`;
  const capacity = Number.isFinite(options.capacity)
    ? Math.max(1, Math.floor(options.capacity))
    : OPEN_CONTAINER_CAPACITY;
  raidInventory.openContainer = {
    id,
    container,
    items,
    capacity,
    label: container.style?.label ? `${container.style.label}箱` : (container.label ?? '物资箱'),
    selected: null,
  };
  return raidInventory.openContainer;
}

/** 关闭当前容器会话（面板关闭≠清会话；死亡/撤离/刷新才真正清理）。 */
export function closeContainerSession(raidInventory) {
  if (raidInventory) raidInventory.openContainer = null;
}

/** 事务快照：仅数据字段，刻意不克隆 THREE 容器对象。 */
export function snapshotRaidInventory(raidInventory) {
  if (!raidInventory) return null;
  return {
    equipment: clone(raidInventory.equipment),
    backpack: clone(raidInventory.backpack),
    quickUse: clone(raidInventory.quickUse),
    openContainer: raidInventory.openContainer
      ? { items: clone(raidInventory.openContainer.items) }
      : null,
  };
}

function replaceArray(target, source) {
  target.splice(0, target.length, ...(source ?? []));
}

/**
 * 从事务快照恢复。数组原地替换，确保 player.inventory 的旧引用不会失效。
 */
export function restoreRaidInventory(raidInventory, snapshot) {
  if (!raidInventory || !snapshot) return false;
  raidInventory.equipment.armor = snapshot.equipment.armor;
  raidInventory.equipment.pistol = snapshot.equipment.pistol;
  replaceArray(raidInventory.equipment.primary, snapshot.equipment.primary);
  replaceArray(raidInventory.backpack.grenade, snapshot.backpack.grenade);
  replaceArray(raidInventory.backpack.misc, snapshot.backpack.misc);
  replaceArray(raidInventory.quickUse, snapshot.quickUse);
  if (raidInventory.openContainer && snapshot.openContainer) {
    replaceArray(raidInventory.openContainer.items, snapshot.openContainer.items);
  } else if (!snapshot.openContainer) {
    raidInventory.openContainer = null;
  }
  return true;
}

function sourceLocation(raidInventory, source, selector) {
  if (source === 'backpack') return backpackLocation(raidInventory, selector);
  if (source === 'quickUse') {
    if (Number.isInteger(selector)) {
      const item = raidInventory.quickUse[selector];
      return item ? { container: 'quickUse', array: raidInventory.quickUse, index: selector, item, fixed: true } : null;
    }
    return quickUseLocation(raidInventory, selector);
  }
  if (source === 'container') return containerLocation(raidInventory, selector);
  return null;
}

/**
 * 原子转移：先快照，任何类型拒绝、容量不足或目标占用均完整回滚。
 * 支持容器并列面板的方向：container → backpack / quickUse、backpack → container。
 * 明确拒绝：quickUse → container（快捷栏是投掷/使用唯一真源，不做回放）、
 * equipment → 任何方向（装备位只读，itemKind 检查兜底）。
 * options.index 指定 QuickUse 目标槽；容器目标按会话容量判定，满则拒绝。
 */
export function transferItem(raidInventory, source, target, selector, options = {}) {
  if (!raidInventory) return { ok: false, reason: '缺少战局容器' };
  const snapshot = snapshotRaidInventory(raidInventory);
  const from = sourceLocation(raidInventory, source, selector);
  if (!from?.item) return { ok: false, reason: '来源中找不到物品' };

  const moving = from.item;
  if (target === 'quickUse') {
    const quickCheck = assertQuickUseItem(moving);
    if (!quickCheck.ok) return quickCheck;
  }
  if (target === 'backpack' && !BACKPACK_KINDS.has(itemKind(moving))) {
    return { ok: false, reason: '该物品不能放入背包' };
  }
  if (target === 'container') {
    const session = raidInventory.openContainer;
    if (!session?.items) return { ok: false, reason: '没有打开的容器会话' };
    if (source === 'quickUse') {
      return { ok: false, reason: '快捷栏物品不能放回容器' };
    }
    // 同一容器会话内自转移：来源就是目标 —— 安全 no-op（不复制、不占容量），
    // 且必须先于容量/实例重复检查，否则满箱自转移会被「容器已满」误拒、
    // 本会话物品会被「同一实例不能同时存在于容器与背包」误拒（旧死分支）。
    if (from.container === 'container') {
      return { ok: true, moved: false, item: moving, source, target };
    }
    if (session.items.length >= session.capacity) {
      return { ok: false, reason: `容器已满 · ${session.capacity} 格全部占用` };
    }
    // 实例身份不变量：同一 instanceId 绝不能同时在容器与背包两处
    // （来源已在会话外；同一实例两处并存才拒绝）。
    if (session.items.some((it) => it && it.instanceId === moving.instanceId)) {
      return { ok: false, reason: '同一实例不能同时存在于容器与背包' };
    }
  }

  // 先从来源取走，再做完整试算；任一剩余量即视为失败并恢复（不半转移）。
  if (from.fixed) from.array[from.index] = null;
  else from.array.splice(from.index, 1);

  let result;
  if (target === 'backpack') {
    result = placeIntoBackpack(raidInventory, moving);
    if (result.remaining) {
      restoreRaidInventory(raidInventory, snapshot);
      return { ok: false, reason: result.reason, remaining: result.remaining };
    }
  } else if (target === 'quickUse') {
    result = setQuickUseSlot(raidInventory, options.index ?? 0, moving, { allowExternal: true });
    if (!result.ok) {
      restoreRaidInventory(raidInventory, snapshot);
      return result;
    }
  } else if (target === 'container') {
    // 前置检查已确认容量与实例身份；来源（背包）物品直接入容器一格。
    raidInventory.openContainer.items.push(moving);
    result = { ok: true };
  } else {
    restoreRaidInventory(raidInventory, snapshot);
    return { ok: false, reason: `未知目标容器：${target}` };
  }
  return { ok: true, item: moving, source, target };
}

function isBaseLoadoutItem(item) {
  return item?.payload?.raidOrigin === 'loadout';
}

/**
 * 本局可结算战利品：兼容旧 player.carriedLoot，仍包含主武器拾取区；不包含
 * armor/pistol 两个装备位。已带入装备的返还仍由 pendingRaid.riskedItems 决定。
 */
export function getCarriedItems(raidInventory) {
  if (!raidInventory) return [];
  return [
    ...(raidInventory.equipment.primary ?? []),
    ...(raidInventory.backpack.grenade ?? []),
    ...(raidInventory.backpack.misc ?? []),
    ...(raidInventory.quickUse ?? []),
  ].filter((item) => item && !isBaseLoadoutItem(item));
}

/**
 * 本局风险实例。可传 stash 时只返回真正来自档案 stash 的条目，防止局内掉落被误记。
 */
export function getRiskedItems(raidInventory, stash = null) {
  if (!raidInventory) return [];
  const items = [
    raidInventory.equipment.armor,
    ...(raidInventory.equipment.primary ?? []),
    ...(raidInventory.backpack.grenade ?? []),
    ...(raidInventory.backpack.misc ?? []),
    ...(raidInventory.quickUse ?? []),
  ].filter(Boolean).filter((item) => !isBaseLoadoutItem(item));
  const seen = new Set();
  return items.filter((item) => {
    const id = item.instanceId;
    if (!id || seen.has(id)) return false;
    if (stash && !stash[id]) return false;
    seen.add(id);
    return true;
  });
}

/**
 * 批 0 过渡 adapter：把 QuickUse 指定格一次性投影到旧投掷字段。
 * 后续批 2 会让投掷直接消费 quickUse，届时应删除这个函数和旧 game 字段写入。
 */
export function syncLegacyGrenadeFromQuickUse(game, raidInventory, index = 0) {
  const item = raidInventory?.quickUse?.[index];
  if (!game) return { ok: false, reason: '缺少 game 状态' };
  if (!item || item.slotKind !== 'grenade') {
    game.nades = 0;
    game.nadeKind = null;
    return { ok: true, nades: 0, nadeKind: null };
  }
  game.nades = Math.max(0, item.quantity ?? 0);
  game.nadeKind = item.defId;
  return { ok: true, nades: game.nades, nadeKind: game.nadeKind };
}

/** 为开局 loadout 种子填充固定槽；不是背包复制路径，显式标记为非结算战利品。 */
export function seedQuickUseGrenade(raidInventory, grenadeId, quantity, index = 0) {
  if (!raidInventory || !Number.isInteger(index) || index < 0 || index >= QUICK_USE_SLOT_COUNT) {
    return { ok: false, reason: 'QuickUse 槽位索引无效' };
  }
  const seeded = ItemInstance('grenade', grenadeId, {
    quantity: Math.max(0, Math.floor(quantity ?? 0)),
    stackMax: Math.max(1, Math.floor(quantity ?? 1)),
    payload: { raidOrigin: 'loadout' },
  });
  raidInventory.quickUse[index] = seeded.quantity > 0 ? seeded : null;
  return { ok: true, item: raidInventory.quickUse[index] };
}

/**
 * 当前选中的 QuickUse 槽 index（轮盘高亮、G 投掷、HUD 共用）。
 * 这是会话状态不是存档字段：snapshot/restore 不包含它，事务回滚不影响选择。
 */
export function getQuickUseSelectedIndex(raidInventory) {
  const index = raidInventory?.quickUseSelected;
  if (!Number.isInteger(index)) return 0;
  return Math.max(0, Math.min(QUICK_USE_SLOT_COUNT - 1, index));
}

/** 设置当前选中的 QuickUse 槽 index。越界或非法输入返回 false 且不修改状态。 */
export function setQuickUseSelectedIndex(raidInventory, index) {
  if (!raidInventory || !Number.isInteger(index) || index < 0 || index >= QUICK_USE_SLOT_COUNT) {
    return false;
  }
  raidInventory.quickUseSelected = index;
  return true;
}

/**
 * 原子扣减 QuickUse 槽：失败（无物品 / 数量不足 / 槽位非法）不改变任何状态。
 * 消耗后数量归零立即置空该槽；返回 consumed/item/remaining 供 HUD 与文案使用。
 */
export function consumeQuickUse(raidInventory, index, quantity = 1) {
  if (!raidInventory) return { ok: false, reason: '缺少战局容器' };
  if (!Number.isInteger(index) || index < 0 || index >= QUICK_USE_SLOT_COUNT) {
    return { ok: false, reason: 'QuickUse 槽位索引无效' };
  }
  const item = raidInventory.quickUse[index];
  if (!item) return { ok: false, reason: '槽位为空', item: null, consumed: 0, remaining: 0 };
  const want = Math.max(1, Math.floor(Number.isFinite(quantity) ? quantity : 1));
  const have = Math.max(0, Math.floor(item.quantity ?? 1));
  if (have < want) return { ok: false, reason: '数量不足', item, consumed: 0, remaining: have };
  const remaining = have - want;
  if (remaining <= 0) raidInventory.quickUse[index] = null;
  else item.quantity = remaining;
  return { ok: true, consumed: want, remaining, item: remaining > 0 ? item : null };
}

/**
 * 当前选中槽（或指定槽）的手雷实例。不是手雷 / 空槽返回 null ——
 * 调用方（G 键、轮盘确认）投掷成功后必须走 consumeQuickUse 扣减，
 * game.nades/nadeKind 只是兼容只读投影，不得再作为扣减真源。
 */
export function getQuickUseGrenade(raidInventory, index = getQuickUseSelectedIndex(raidInventory)) {
  if (!raidInventory || !Number.isInteger(index) || index < 0 || index >= QUICK_USE_SLOT_COUNT) {
    return null;
  }
  const item = raidInventory.quickUse[index];
  if (item?.slotKind !== 'grenade' || (item.quantity ?? 1) <= 0) return null;
  return { index, item };
}

/**
 * 投掷结算序列（main.js G 键 / Q 轮盘确认共用）：读取手雷 → 执行注入的
 * thrower（真正投掷、可能抛异常）→ 只有投掷成功才 consumeQuickUse。
 * 任何失败（空槽、投掷器抛异常、返回假值）都不改变 QuickUse 数量。
 * thrower 收到手雷实例；返回真值 = 投掷成功。
 */
export function attemptGrenadeThrow(raidInventory, index, thrower) {
  const info = getQuickUseGrenade(raidInventory, index);
  if (!info) return { ok: false, reason: 'no-grenade' };
  let thrown = false;
  try {
    thrown = typeof thrower === 'function' && thrower(info.item);
  } catch {
    return { ok: false, reason: 'throw-failed' };
  }
  if (!thrown) return { ok: false, reason: 'throw-failed', item: info.item };
  return consumeQuickUse(raidInventory, info.index);
}
