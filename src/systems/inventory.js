/**
 * 背包数据层（批 1）：纯函数模块。零 DOM、零 three.js 依赖。
 *
 * 权威设计依据：INVENTORY-SYSTEM-DESIGN.md（v2）。
 * 本模块是局外整备与局内战斗共用的「背包单一真源」，全部是无状态纯函数，
 * 可以在 node 下直接测试，也为将来多人联机的权威端校验预留（§3.4/§5.6.2）。
 *
 * 导出清单（对应设计文档 §11 批 1 + 批 2 的纯数据部分）：
 *   ItemInstance()        §3.1/§3.2 统一物品实例工厂
 *   fromLootItem()        §3.3 旧形状战利品 → 新形状的机械映射
 *   slotLayout(armorId)   §2.2 四类槽位容量公式（唯一真源）
 *   grenadeStackMax()     §2.3 每种手雷的独立堆叠上限（count 真源 + 钳 ≥1）
 *   effectiveArmorId()    §2.5.2 护甲槽唯一读法（空槽 = standard）
 *   canAccept()           §2.1 类型隔离（拒绝时给出可读原因，§1 不变量 3）
 *   tryStack()            §4.2 两个物品实例能否合并堆叠
 *   autoPlace()           §6 拾取自动分配（同 defId 跨格堆叠 + 开新格）
 *   placeItem()           §12.3 addCarriedLoot 的语义等价物（不堆叠、按类放）
 *   clearLoot()           §9 清空本局战利品（不碰护甲槽 / 手枪位）
 *   createInventory()     §3.5 结构化容器构造器
 *   collectStashInstanceIds()  §4.3 收集「来自 profile.stash 的实例」= 风险物
 *   resizeInventory()     §4.1 换甲缩容/扩容重排，溢出物返回（不静默丢弃）
 *   pruneStaleStashItems()  §9.1 死亡后幽灵实例清理（护甲槽清空落回 standard）
 */

import { PLAYER } from '../config.js';
import { ARMOR_TYPES, GRENADE_TYPES } from './loadout-config.js';
import { WEAPONS } from './weapons.js';
import { LOOT_ITEMS } from '../data/loot-tables.js';

// ═══════════════════════════════════════════════════════════════════════════
// 容量公式（§2.2）
// ═══════════════════════════════════════════════════════════════════════════

/**
 * 单一真源。局外整备与局内战斗调用同一个函数。
 * 返回四类槽位的数量：
 *   pistol  恒 1（保底，锁定）
 *   armor   恒 1（专属槽，可空；§2.5）
 *   primary 1 + weaponSlots（dualist → 2）
 *   grenade 1 + grenadeSlots（能同时携带几种手雷；§2.3 钳 ≥1）
 *   misc    carryCap + carryCapBonus（carrier → 6；钳 ≥1）
 */
export function slotLayout(armorId) {
  const fx = ARMOR_TYPES[armorId]?.effects ?? {};
  return {
    pistol: 1,                                          // 恒定，保底
    armor: 1,                                           // 恒定，可空（§2.5）
    primary: 1 + (fx.weaponSlots ?? 0),                 // dualist → 2
    grenade: Math.max(1, 1 + (fx.grenadeSlots ?? 0)),   // v2：手雷「格子数」
    misc: Math.max(1, (PLAYER.carryCap ?? 4) + (fx.carryCapBonus ?? 0)),
  };
}

/**
 * 单种手雷的单格堆叠上限（§2.3）。
 * 真源是 GRENADE_TYPES[id].count（§2.3.1 裁决）；grenadeBonus 是
 * 「每格少带几颗」的护甲代价（dualist: -1），钳到 ≥1 —— 钳到 1 而不是 0：
 * 一个存在但装不了任何东西的格子是纯粹的 UI 噪声（§2.3.2）。
 */
export function grenadeStackMax(grenadeId, armorId) {
  const base = GRENADE_TYPES[grenadeId]?.count ?? 1;
  const bonus = ARMOR_TYPES[armorId]?.effects?.grenadeBonus ?? 0;
  return Math.max(1, base + bonus);
}

/**
 * 护甲槽的唯一读法（§2.5.2）。空槽落回保底，绝不返回 null（下游全都直接查表）。
 * standard 在架构上不是一件物品、是一条地板：它没有 instanceId，
 * 永远不会作为实例存在于任何格子里（§1 不变量 1）。
 */
export function effectiveArmorId(inventory) {
  return inventory?.armor?.defId ?? 'standard';
}

// ═══════════════════════════════════════════════════════════════════════════
// 物品实例（§3.1 / §3.2）
// ═══════════════════════════════════════════════════════════════════════════

let _instanceSeq = 0;
let _fragmentSeq = 0;

/**
 * 跨格拆分时的分格实例 id（§6「大数量拆分」边界修复）。
 * 前缀与 raid-inventory.js 的 raid_fragment_* 刻意不同，保证两个模块
 * 独立生成的 fragment id 永不碰撞；同一次 autoPlace 内的多格各自唯一。
 */
function _nextFragmentId() {
  return `inv_fragment_${Date.now().toString(36)}_${(++_fragmentSeq).toString(36)}`;
}

/**
 * 格子物品实例工厂。七个公共字段 + 一个 payload 子对象，类型差异全收进 payload。
 *
 * @param {string} slotKind  weapon|armor|grenade|material|blueprint|consumable|attachment
 * @param {string} defId     定义表主键（weapon→WEAPONS、armor→ARMOR_TYPES、
 *                           grenade→GRENADE_TYPES、material→LOOT_ITEMS；
 *                           blueprint/consumable 的注册表批 3 才落地，字段靠 overrides 传）
 * @param {object} [overrides] 覆盖公共字段 / payload（instanceId、name、quantity、
 *                             stackMax、value、payload、armorId…）
 */
export function ItemInstance(slotKind, defId, overrides = {}) {
  const base = {
    instanceId:
      overrides.instanceId ??
      `inst_${Date.now().toString(36)}_${(++_instanceSeq).toString(36)}`,
    slotKind,
    defId,
    name: defId ?? '',
    quantity: 1,     // 堆叠数量。不可堆叠类型恒为 1
    stackMax: 1,     // 堆叠上限。1 = 不可堆叠
    value: 0,        // 单件价值。总价 = value × quantity
    payload: {},
  };

  switch (slotKind) {
    case 'weapon': {
      const spec = WEAPONS[defId];
      base.name = spec?.name ?? defId;
      // payload.attachments 与 loadoutManager.attachments[weaponId] 形状故意一致
      // （{muzzle,optic,magazine,grip}），getWeaponModifiers 可零改动接受（§3.3）。
      base.payload = {
        attachments: { muzzle: null, optic: null, magazine: null, grip: null },
        ammo: spec?.mag ?? null,
        reserve: spec?.reserve ?? null,
      };
      break;
    }
    case 'armor': {
      const spec = ARMOR_TYPES[defId];
      base.name = spec?.name ?? defId;
      break;                       // payload 恒 {}（§3.2）
    }
    case 'grenade': {
      const spec = GRENADE_TYPES[defId];
      base.name = spec?.name ?? defId;
      // 堆叠上限按「护甲 × 手雷种类」现算（§2.3.1）。autoPlace 落格时还会按
      // 当前护甲重算一次（§6），这里默认按 standard 算，作为创建时的初始值。
      base.stackMax = grenadeStackMax(defId, overrides.armorId ?? 'standard');
      break;
    }
    case 'material': {
      const spec = LOOT_ITEMS[defId];
      base.name = spec?.name ?? defId;
      base.value = spec?.value ?? 0;
      base.stackMax = spec?.stackMax ?? 20;   // §7.3：留 LOOT_ITEMS[id].stackMax 读取形状
      base.payload = { tier: spec?.tier ?? null };
      break;
    }
    case 'blueprint':
      base.stackMax = 1;                       // 蓝图恒 1（§3.3）
      base.payload = { targetType: null, targetId: null };
      break;
    case 'consumable':
      base.stackMax = 3;                       // 急救包最多叠 3（§3.2）
      base.payload = { healMult: 1.0 };
      break;
    case 'attachment':
      base.stackMax = 1;
      base.payload = { compatibleWeapons: [] };
      break;
    default:
      // 未知类型仍产出合法形状（堆叠默认 1），由 canAccept 在落格时兜底拒绝。
      break;
  }

  return {
    ...base,
    ...overrides,
    payload: { ...base.payload, ...(overrides.payload ?? {}) },
  };
}

/**
 * 旧形状战利品 → 新形状实例的机械映射（§3.3）。
 * 现在：{ lootId, itemId, kind:'material', materialId, name, quantity, value, tier }
 * → 新：{ instanceId, slotKind:'material', defId, name, quantity, stackMax:20,
 *        value, payload:{tier} }
 */
export function fromLootItem(loot) {
  if (!loot) return null;
  return ItemInstance('material', loot.itemId ?? loot.materialId, {
    instanceId: loot.lootId,
    name: loot.name ?? loot.itemId ?? loot.materialId,
    quantity: loot.quantity ?? 1,
    value: loot.value ?? 0,
    payload: { tier: loot.tier ?? null },
  });
}

// ═══════════════════════════════════════════════════════════════════════════
// 类型隔离与堆叠（§2.1 / §4.2）
// ═══════════════════════════════════════════════════════════════════════════

/**
 * 物品的槽类归属。slotKind 是旧字段 kind 的超集重命名（§3.3），
 * 这里同时认两种写法，让旧形状的战利品对象也能直接进新容器。
 */
function _itemKind(item) {
  return item?.slotKind ?? item?.kind ?? null;
}

/**
 * 类型隔离判定（§1 不变量 3）。只判「槽类 vs 物品类型」，
 * 不管堆叠（同种不同种的堆叠问题归 tryStack，见 §4.2）。
 *
 * @param {string} slotKind 槽类代号：pistol|armor|primary|grenade|misc
 * @param {object} item
 * @returns {{ok: boolean, reason?: string}} 拒绝时必须带可读原因，不静默失败。
 */
export function canAccept(slotKind, item) {
  if (!item) return { ok: false, reason: '空物品' };
  const kind = _itemKind(item);
  switch (slotKind) {
    case 'pistol':
      if (kind === 'weapon' && (WEAPONS[item.defId]?.slot ?? 0) === 1) {
        return { ok: true };
      }
      return { ok: false, reason: '手枪位只收手枪（slot 1 武器）' };
    case 'primary':
      if (kind !== 'weapon') return { ok: false, reason: '主武器位只收主武器' };
      if ((WEAPONS[item.defId]?.slot ?? 0) === 1) {
        return { ok: false, reason: '主武器位不收手枪（槽位锁定）' };
      }
      return { ok: true };
    case 'armor':
      if (kind === 'armor') return { ok: true };
      return { ok: false, reason: '护甲槽只能放护甲' };
    case 'grenade':
      if (kind === 'grenade') return { ok: true };
      return { ok: false, reason: '手雷格只能放手雷' };
    case 'misc':
      if (kind === 'material' || kind === 'blueprint'
        || kind === 'consumable' || kind === 'attachment') {
        return { ok: true };
      }
      return { ok: false, reason: '杂项格只收材料 / 蓝图 / 消耗品 / 配件' };
    default:
      return { ok: false, reason: `未知槽位类型：${slotKind}` };
  }
}

/**
 * 两个物品实例能否合并堆叠。
 * 规则（§2.3.2 / §6 第 2 步）：同 defId 且目标格有余量才可堆；
 * 「同 defId」这个条件天然实现「不同种手雷不共格」——手雷与材料走完全同一段代码。
 *
 * @returns {number} a 能吸收的 b 数量；0 = 拒绝（不同种 / 满格 / 不可堆叠）。
 */
export function tryStack(a, b) {
  if (!a || !b) return 0;
  if (_itemKind(a) !== _itemKind(b) || a.defId !== b.defId) return 0;
  const max = a.stackMax ?? 1;
  if (max <= 1) return 0;
  const room = max - (a.quantity ?? 1);
  if (room <= 0) return 0;
  return Math.min(room, b.quantity ?? 1);
}

// ═══════════════════════════════════════════════════════════════════════════
// 容器与放置（§3.5 / §6 / §12.3）
// ═══════════════════════════════════════════════════════════════════════════

/** 护甲是单槽（容量恒 1），不是数组 —— 用它做 sentinel 区分两类容器。 */
const ARMOR_SLOT = Symbol('armor');

/** 按物品槽类选目标容器。未知类型返回 null（无处可放）。 */
function _slotsFor(inventory, kind) {
  switch (kind) {
    case 'weapon': return inventory.primary;
    case 'grenade': return inventory.grenade;
    case 'material':
    case 'blueprint':
    case 'consumable':
    case 'attachment':
      return inventory.misc;
    case 'armor': return ARMOR_SLOT;
    default: return null;
  }
}

/** 物品的堆叠上限：手雷按「护甲 × 种类」现算，其余用实例自带的 stackMax（§6）。 */
function _stackMaxOf(item, armorId) {
  if (_itemKind(item) === 'grenade') return grenadeStackMax(item.defId, armorId);
  return item?.stackMax ?? 1;
}

/**
 * §3.5 的结构化容器构造器。
 * primary / grenade / misc 是定长稀疏数组（null = 空格）——格子索引必须稳定，
 * 这是拖拽的前提（§3.5）。armorId 是派生 getter 而不是存储字段：
 * 护甲槽是唯一真源，从结构上杜绝「槽空但仍有 280 甲」的双份数据撕裂（§13-R3）。
 *
 * @param {object} [options]
 * @param {object|null} [options.armor] 初始护甲实例；null = 视为 standard（§2.5.2）
 */
export function createInventory(options = {}) {
  const armor = options.armor ?? null;
  const layout = slotLayout(armor?.defId ?? 'standard');
  return {
    armor,                                            // 专属护甲槽。null = standard
    pistol: null,                                     // 保底手枪位：批 4 由 Loadout 接线（§6）
    primary: new Array(layout.primary).fill(null),
    grenade: new Array(layout.grenade).fill(null),
    misc: new Array(layout.misc).fill(null),
    get armorId() { return this.armor?.defId ?? 'standard'; },
  };
}

/**
 * 拾取自动分配（§6）。纯函数（会就地写入 inventory，这是它的职责）。
 *
 * 算法：
 *   1. 按 item 的槽类选定目标容器（armor 走单槽；已占则不自动放，等玩家手动换）；
 *   2. 可堆叠（stackMax > 1）：先扫同 defId 且未满的格子逐格填满（跨格溢出）；
 *   3. 仍有剩余：找 null 空格开新格（新格 stackMax 同样按 defId 现算）；
 *   4. 无空格：剩余原样返回，调用方按 remaining 决定留多少在箱里（绝不静默丢弃）。
 *
 * @returns {{placed: number, remaining: number}} 单位按 quantity 计。
 */
export function autoPlace(inventory, item) {
  if (!inventory || !item) return { placed: 0, remaining: 0 };
  const qty = Math.max(0, item.quantity ?? 1);
  if (qty === 0) return { placed: 0, remaining: 0 };

  const armorId = effectiveArmorId(inventory);
  const stackMax = _stackMaxOf(item, armorId);
  const container = _slotsFor(inventory, _itemKind(item));
  if (container === null) return { placed: 0, remaining: qty };

  // 护甲：单槽。已占则不自动放（§6 第 1 步）。
  if (container === ARMOR_SLOT) {
    if (!inventory.armor) {
      inventory.armor = item;
      return { placed: qty, remaining: 0 };
    }
    return { placed: 0, remaining: qty };
  }

  let placed = 0;
  let remaining = qty;

  if (stackMax > 1) {
    // 第 2 步：同 defId 的格子逐格填满。「同 defId」天然实现不同种手雷不共格。
    for (const slot of container) {
      if (remaining <= 0) break;
      if (!slot || slot.defId !== item.defId) continue;
      const sm = _stackMaxOf(slot, armorId);
      const room = sm - (slot.quantity ?? 1);
      if (room <= 0) continue;
      const take = Math.min(room, remaining);
      slot.quantity += take;
      slot.stackMax = sm;
      remaining -= take;
      placed += take;
    }
    // 第 3 步：开新格（新格的 stackMax 同样按 defId 现算，§6）。
    // 大数量拆入多格时，只有第一个新格保留原 instanceId，其余每格生成
    // 唯一 fragment id —— 同一 instanceId 绝不允许同时存在多个背包格
    // （§1 不变量 2/§4.3 的实例身份语义；第一格保留原实例是既有约定）。
    let newCells = 0;
    for (let i = 0; i < container.length; i++) {
      if (remaining <= 0) break;
      if (container[i] !== null) continue;
      const take = Math.min(stackMax, remaining);
      container[i] = newCells === 0
        ? { ...item, quantity: take, stackMax }
        : { ...item, quantity: take, stackMax, instanceId: _nextFragmentId() };
      newCells++;
      remaining -= take;
      placed += take;
    }
  } else {
    // 不可堆叠（stackMax ≤ 1）：一单位一格。qty > 1 时逐格放——
    // 例如 he 的 count=1，带 2 颗需要 2 个手雷格（每格独立上限，§2.3）。
    // 同样只有第一格保留原 instanceId，其余逐格生成唯一 fragment id。
    let placedCopies = 0;
    for (let i = 0; i < container.length; i++) {
      if (remaining <= 0) break;
      if (container[i] !== null) continue;
      if (remaining === qty && qty === 1) {
        container[i] = item;        // 常规快路径：放原实例引用，不做无谓复制
        placed = 1;
      } else {
        container[i] = placedCopies === 0
          ? { ...item, quantity: 1, stackMax }
          : { ...item, quantity: 1, stackMax, instanceId: _nextFragmentId() };
        placedCopies++;
        placed += 1;
      }
      remaining -= 1;
    }
  }

  return { placed, remaining };
}

/**
 * `player.addCarriedLoot` 的语义等价物（§12.3）：**不堆叠**、按类别放进
 * 第一个空格，返回是否放下。容量判断按目标类别 —— 手雷格满不代表杂项格满
 * （§12.3 语义变化 1），所以返回值依赖 item 的槽类。
 */
export function placeItem(inventory, item) {
  if (!inventory || !item) return false;
  const container = _slotsFor(inventory, _itemKind(item));
  if (container === null) return false;
  if (container === ARMOR_SLOT) {
    if (!inventory.armor) { inventory.armor = item; return true; }
    return false;
  }
  const free = container.indexOf(null);
  if (free === -1) return false;
  container[free] = item;
  return true;
}

/**
 * 清空本局战利品（死亡 / 放弃结算时的既有 API 语义，§9.1）。
 * 护甲槽是装备位、手枪位是保底（§1 不变量 1），都不属于「本局战利品」，不清。
 */
export function clearLoot(inventory) {
  if (!inventory) return;
  inventory.primary.fill(null);
  inventory.grenade.fill(null);
  inventory.misc.fill(null);
}

// ═══════════════════════════════════════════════════════════════════════════
// 批 2：局外整备的容器操作（§4.1 缩容溢出 / §4.3 brought 收集 / 幽灵清理）
// ═══════════════════════════════════════════════════════════════════════════

/** 保底装备：没有 stash 实例也能存在、死亡不丢（§1 不变量 1）。 */
function _isDefaultGear(item) {
  if (!item) return false;
  const kind = _itemKind(item);
  if (kind === 'weapon') return (WEAPONS[item.defId]?.slot ?? 0) === 1;   // 手枪
  if (kind === 'armor') return item.defId === 'standard';                 // standard 地板
  if (kind === 'grenade') return item.defId === 'flash';                  // 默认闪光
  return false;
}

/**
 * 收集「来自 profile.stash 的实例」的 instanceId（§4.3）。
 * 只有 instanceId 确实存在于 stash 里的实例才计入 —— 保底装备（卡片即时
 * 生成的实例）不在 stash 中，被自动排除；手枪（slot 1 武器）与 standard
 * 护甲是保底地板（§2.5.2），即使出现也跳过，结构上不可能进 brought。
 *
 * @param {object} inventory 局外整备背包（createInventory 形状）
 * @param {object} stash     profile.stash（instanceId → item）
 * @returns {string[]} 本局风险物 instanceId 列表
 */
export function collectStashInstanceIds(inventory, stash) {
  if (!inventory || !stash) return [];
  const ids = [];
  const consider = (item) => {
    if (!item) return;
    if (_isDefaultGear(item)) return;
    if (stash[item.instanceId]) ids.push(item.instanceId);
  };
  consider(inventory.armor);   // 非 standard 的护甲实例是风险物（§2.1）
  for (const arr of [inventory.primary, inventory.grenade, inventory.misc]) {
    if (!arr) continue;
    for (const item of arr) consider(item);
  }
  return ids;
}

/**
 * 换甲后的容器重排（§4.1「换护甲导致缩容」）。就地调整 primary / grenade /
 * misc 的定长稀疏数组长度，并重算每个手雷格的堆叠上限（grenadeBonus 变化）。
 *
 * 放不下的物品收集进返回值（不静默丢弃，§1 不变量 4）：调用方负责退回仓库
 * 源列表并提示。手雷格超量部分先尝试跨格塞进同 defId 的其它格（复用 §6
 * autoPlace 第 2 步的规则），塞不下才退回。
 *
 * @param {object} inventory   就地修改的容器
 * @param {string} newArmorId  新的生效护甲 id
 * @returns {object[]} 溢出物实例数组（数量超限的手雷按件拆出独立实例）
 */
export function resizeInventory(inventory, newArmorId) {
  if (!inventory) return [];
  const layout = slotLayout(newArmorId);
  const overflow = [];

  // primary / misc：长度截断（超出部分整体退回）或补齐 null（扩容）。
  for (const key of ['primary', 'misc']) {
    const arr = inventory[key];
    if (!Array.isArray(arr)) continue;
    if (arr.length > layout[key]) {
      for (let i = layout[key]; i < arr.length; i++) {
        if (arr[i]) overflow.push(arr[i]);
      }
      arr.length = layout[key];
    } else {
      while (arr.length < layout[key]) arr.push(null);
    }
  }

  // grenade：长度截断/补齐 + 每格堆叠上限重算（grenadeBonus 变化）。
  const garr = inventory.grenade;
  if (Array.isArray(garr)) {
    if (garr.length > layout.grenade) {
      for (let i = layout.grenade; i < garr.length; i++) {
        if (garr[i]) overflow.push(garr[i]);
      }
      garr.length = layout.grenade;
    } else {
      while (garr.length < layout.grenade) garr.push(null);
    }

    for (let i = 0; i < garr.length; i++) {
      const slot = garr[i];
      if (!slot || _itemKind(slot) !== 'grenade') continue;
      const sm = grenadeStackMax(slot.defId, newArmorId);
      slot.stackMax = sm;
      const qty = slot.quantity ?? 1;
      if (qty > sm) {
        const excess = qty - sm;
        slot.quantity = sm;
        // 跨格溢出：先塞同 defId 的其它格（§4.1 明确要求复用 autoPlace 第 2 步）。
        let remaining = excess;
        for (let j = 0; j < garr.length && remaining > 0; j++) {
          if (j === i || !garr[j] || garr[j].defId !== slot.defId) continue;
          const room = grenadeStackMax(garr[j].defId, newArmorId) - (garr[j].quantity ?? 1);
          if (room <= 0) continue;
          const take = Math.min(room, remaining);
          garr[j].quantity += take;
          remaining -= take;
        }
        if (remaining > 0) {
          overflow.push({ ...slot, quantity: remaining, stackMax: sm });
        }
      }
    }
  }

  return overflow;
}

/**
 * 局外整备背包的幽灵清理：非保底物品若其 instanceId 已不在 stash 中
 * （上一局死亡/放弃被 settleRaid 销毁，§9.1），就是幽灵残留 —— 清出整备背包，
 * 护甲槽清空 = 落回 standard 地板（§2.5.2）。保底装备（手枪/standard/flash）
 * 没有 stash 实例也能合法存在，永不清理。
 *
 * 若护甲槽因此发生变化，会走 resizeInventory 做缩容，溢出物随返回值交给调用方。
 *
 * @param {object} inventory 局外整备背包（就地修改）
 * @param {object} stash     profile.stash（instanceId → item）
 * @returns {object[]} 缩容溢出的物品（多数情况下为空数组）
 */
export function pruneStaleStashItems(inventory, stash) {
  if (!inventory) return [];
  const keep = (item) => !item || _isDefaultGear(item) || !!stash?.[item.instanceId];

  const armorBefore = inventory.armor?.defId ?? 'standard';
  if (inventory.armor && !keep(inventory.armor)) inventory.armor = null;

  for (const arr of [inventory.primary, inventory.grenade, inventory.misc]) {
    if (!Array.isArray(arr)) continue;
    for (let i = 0; i < arr.length; i++) {
      if (arr[i] && !keep(arr[i])) arr[i] = null;
    }
  }

  const armorAfter = inventory.armor?.defId ?? 'standard';
  if (armorAfter !== armorBefore) {
    return resizeInventory(inventory, armorAfter);
  }
  return [];
}
