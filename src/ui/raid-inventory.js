/**
 * 局内背包面板（批 3 → 批 4 扩展）：UI 与数据分离，容器与玩家四栏并列。
 *
 * 与数据层的关系：
 *   - buildRaidInventoryModel() 是纯转换：Loadout.slots + player.raidInventory /
 *     player.inventory → 可渲染的视图模型（Equipment / Backpack / Quick Use /
 *     Container 四栏；无容器会话时容器栏是占位入口）。它不知道 DOM，Node 可直接测试。
 *   - renderRaidInventoryModel() 是纯渲染：视图模型 → HTML 字符串。所有槽位
 *     都有稳定 data 属性（data-raid-container="container|equipment|backpack|quickUse" /
 *     data-raid-slot / data-raid-group），空槽固定占位、不随内容重排；物品名强制省略号。
 *   - RaidInventoryView 是薄控制器：root 上只绑定一次 click 委托（事件委托），
 *     选中/详情/使用/放回背包/容器拿取全部走 raid-inventory 原子 API，绝不直接改数据。
 *
 * 面板语义（与 QuickWheel 同范式）：
 *   - 打开不暂停世界 —— 面板状态由 main.js 的 game.inventoryOpen 唯一持有，
 *     本模块不新增第二个游戏级暂停标志。
 *   - 装备栏只读：局内不可换甲/换枪，点击只显示详情或「局内装备不可更换」。
 *   - Quick Use 固定 5 槽：点击选中会同步 raidInventory.setQuickUseSelectedIndex
 *     （G / HUD 读同一个 getter），只同步索引、绝不复制实例。
 *   - 「使用」：手雷走 attemptGrenadeThrow（注入的 thrower 返回真值才扣减）；
 *     消耗品未接入效果前不伪造扣除。 「放回背包」：clearQuickUseSlot 原子回滚。
 *   - 容器栏：会话打开时显示本项目物品（名称/数量/堆叠/价值来自本项目数据），
 *     「拿取到背包」= transferItem 原子转移：背包满/类型不符时容器物品完整留在原处；
 *     「放入容器」= 背包→容器，容量满拒绝；quickUse→容器与装备方向明确只读拒绝。
 */

import {
  QUICK_USE_SLOT_COUNT,
  attemptGrenadeThrow,
  clearQuickUseSlot,
  setQuickUseSlot,
  getQuickUseSelectedIndex,
  setQuickUseSelectedIndex,
  transferItem,
  moveToSlot,
  splitStack,
  resolveSlot,
} from '../systems/raid-inventory.js';
import { ARMOR_TYPES } from '../systems/loadout-config.js';

export { QUICK_USE_SLOT_COUNT };

const DRAG_THRESHOLD_PX = 5;
const DRAGGABLE_CONTAINERS = new Set(['backpack', 'quickUse', 'container']);

function resolveSlotItem(raid, ref) {
  const loc = resolveSlot(raid, ref);
  return loc?.array?.[loc.index] ?? null;
}

/** 预览拖拽目标是否合法（不改数据，只预测结果）。 */
function previewMove(raid, from, to, splitting) {
  if (!raid || !from || !to) return { ok: false };
  const fromLoc = resolveSlot(raid, from);
  const toLoc = resolveSlot(raid, to);
  if (!fromLoc || !toLoc) return { ok: false };
  if (fromLoc.array === toLoc.array && fromLoc.index === toLoc.index) return { ok: false };
  const moving = fromLoc.array[fromLoc.index];
  if (!moving) return { ok: false };
  const target = toLoc.array[toLoc.index];
  if (!target) return { ok: true };   // 空格总是可以放
  const same = moving.defId === target.defId && moving.slotKind === target.slotKind;
  if (same && (target.stackMax ?? 1) > 1) return { ok: true };  // 可堆叠
  return { ok: !splitting };          // 互换只在整格拖拽时可用
}

function dragResultText(result) {
  if (result.merged) return `合并 ×${result.quantity}`;
  if (result.swapped) return '互换';
  if (result.split) return `拆分 ×${result.quantity}`;
  return result.moved ? '移动' : '';
}

// ─────────────────────────────────────────────────────────────────────────────
// 纯转换：数据 → 视图模型
// ─────────────────────────────────────────────────────────────────────────────

/** 单件物品的视图模型（readOnly 标记只表达「点击仅选中」的格子属性）。 */
function toItemVM(item) {
  if (!item) return null;
  return {
    slotKind: item.slotKind ?? item.kind ?? item.type ?? null,
    defId: item.defId ?? null,
    name: item.name ?? item.defId ?? '物品',
    quantity: Math.max(1, Number.isFinite(item.quantity) ? Math.floor(item.quantity) : 1),
    stackMax: item.stackMax ?? 1,
    value: Number.isFinite(item.value) ? item.value : 0,
    ammo: item.payload?.ammo ?? null,
    reserve: Number.isFinite(item.payload?.reserve) ? item.payload.reserve : null,
    reserveUnlimited: item.payload?.reserve === Infinity,
    instanceId: item.instanceId ?? null,
    tier: item.payload?.tier ?? item.tier ?? null,
    readOnly: true,
  };
}

/** Loadout 战斗真源的武器视图模型（slot 0 = 保底手枪，1/2 = 主武器）。 */
function weaponVM(weapon) {
  if (!weapon?.spec) return null;
  return {
    slotKind: 'weapon',
    defId: weapon.spec.id ?? null,
    name: weapon.spec.name ?? weapon.spec.id ?? '武器',
    quantity: 1,
    stackMax: 1,
    value: 0,
    ammo: Number.isFinite(weapon.ammo) ? weapon.ammo : null,
    reserve: Number.isFinite(weapon.reserve) ? weapon.reserve : null,
    reserveUnlimited: weapon.reserve === Infinity,
    instanceId: null,
    readOnly: true,
  };
}

function armorName(armorId) {
  return ARMOR_TYPES[armorId]?.name ?? '标准战术背心';
}

/** 固定 5 格 Quick Use；格子数量永远恒定，空槽是显式 null 占位。 */
function quickUseSlots(raid) {
  const slots = raid?.quickUse ?? [];
  const out = [];
  for (let i = 0; i < QUICK_USE_SLOT_COUNT; i++) out.push(toItemVM(slots[i] ?? null));
  return out;
}

/** 背包格 = 手雷格 + 杂项格（定长稀疏数组，格子索引稳定不随内容重排）。
 *  显式 for 循环而不是 map：稀疏数组的洞也必须占位，容量不能漂移。 */
function backpackSlots(backpack) {
  const groups = [
    ['grenade', backpack?.grenade],
    ['misc', backpack?.misc],
  ];
  const entries = [];
  for (const [group, array] of groups) {
    const list = Array.isArray(array) ? array : [];
    for (let i = 0; i < list.length; i++) {
      entries.push({ item: toItemVM(list[i]), group, index: i });
    }
  }
  return entries;
}

function countUsed(slots) {
  return slots.filter((entry) => entry?.item && (entry.item.quantity ?? 1) > 0).length;
}

/**
 * 纯模型转换：把 Loadout.slots（武器战斗真源）+ player.raidInventory /
 * player.inventory 转成 Equipment / Backpack / Quick Use / Container 并列视图模型。
 *
 * 护甲 id 解析顺序：raidInventory.equipment.armor 实例（若已同步）→
 * options.armorId（字符串或函数）→ player.loadoutModifiers.visualKit → standard。
 *
 * 容器栏（批 4）：raidInventory.openContainer 会话存在时渲染真实容器格
 * （本项目物品名/数量/堆叠/价值，容量 = 会话 capacity），否则保留占位入口。
 *
 * @param {object} player                    带 raidInventory / inventory / loadoutModifiers
 * @param {object} loadout                   Loadout 实例（slots 是武器真源）
 * @param {object} [options]                 { armorId }
 * @returns {{equipment, backpack, quickUse, container}}
 */
export function buildRaidInventoryModel(player, loadout, options = {}) {
  const raid = player?.raidInventory ?? null;
  const backpack = raid?.backpack ?? player?.inventory ?? {};
  const equipment = raid?.equipment ?? {};
  const armorItem = equipment.armor ?? player?.inventory?.armor ?? null;

  const armorIdOption = typeof options.armorId === 'function'
    ? options.armorId()
    : options.armorId;
  const wornArmorId = armorItem?.defId
    ?? armorIdOption
    ?? player?.loadoutModifiers?.visualKit
    ?? 'standard';

  const slots = loadout?.slots ?? [];
  const equipmentSlots = [];
  for (let i = 0; i < 3; i++) {
    const vm = weaponVM(slots[i]);
    equipmentSlots.push(vm ?? null);
  }

  const backpackEntries = backpackSlots(backpack);
  const quickEntries = quickUseSlots(raid);

  // 容器栏：会话已建立时渲染真实容器格（固定 capacity 格，空槽显式占位）。
  const session = raid?.openContainer ?? null;
  const container = session?.items
    ? {
        id: session.id ?? null,
        label: session.label ?? '物资箱',
        opened: true,
        slots: containerSlots(session),
        used: session.items.length,
        capacity: session.capacity,
        selected: session.selected ?? null,
      }
    : {
        placeholder: true,
        placeholderText: '靠近战利品箱按 E · 打开后在此拿取',
      };

  return {
    equipment: {
      armor: armorItem
        ? toItemVM(armorItem)
        : {
            slotKind: 'armor',
            defId: wornArmorId,
            name: armorName(wornArmorId),
            quantity: 1,
            stackMax: 1,
            value: 0,
            ammo: null,
            reserve: null,
            reserveUnlimited: false,
            instanceId: null,
            readOnly: true,
          },
      slots: equipmentSlots,
      readOnlyNote: '局内装备不可更换',
    },
    backpack: {
      slots: backpackEntries,
      used: countUsed(backpackEntries),
      capacity: backpackEntries.length,
      readOnlyNote: '背包物品 · 打开战利品箱后可放入容器（装备位不可转移）',
    },
    quickUse: {
      slots: quickEntries,
      used: countUsed(quickEntries.map((entry) => ({ item: entry }))),
      capacity: QUICK_USE_SLOT_COUNT,
      selectedIndex: getQuickUseSelectedIndex(raid),
    },
    container,
  };
}

/** 容器会话 → 固定 capacity 格（定长稀疏数组，空格显式占位不重排）。 */
function containerSlots(session) {
  const list = Array.isArray(session.items) ? session.items : [];
  const capacity = Math.max(1, Number.isFinite(session.capacity) ? session.capacity : 1);
  const out = [];
  for (let i = 0; i < capacity; i++) out.push(toItemVM(list[i] ?? null));
  return out;
}

// ─────────────────────────────────────────────────────────────────────────────
// 纯渲染：视图模型 → HTML 字符串
// ─────────────────────────────────────────────────────────────────────────────

function escapeHtml(value) {
  return String(value ?? '')
    .replaceAll('&', '&amp;')
    .replaceAll('<', '&lt;')
    .replaceAll('>', '&gt;')
    .replaceAll('"', '&quot;');
}

/** 物品类型的玩家语义名（详情栏与格子标题共用，不暴露内部 kind）。 */
export const KIND_LABELS = {
  material: '材料', blueprint: '蓝图', weapon: '武器', armor: '护甲',
  grenade: '投掷物', consumable: '消耗品', attachment: '配件',
};
const TIER_LABELS = { low: '普通', med: '军用', high: '稀有' };

/** 按类型给出 24×16 线框图标：本项目自绘，不使用参考游戏资产。 */
const KIND_ICONS = {
  material: '<rect x="4" y="5" width="16" height="9" rx="1"/><path d="M4 9h16M10 5v9"/>',
  blueprint: '<rect x="3" y="2" width="18" height="12" rx="1"/><path d="M6 11l4-5 3 3 2-2 3 4"/>',
  weapon: '<path d="M2 7h15l3-2v4h-6l-1 5h-3l1-5H2z"/>',
  armor: '<path d="M12 2l7 3v4c0 3-3 5-7 6-4-1-7-3-7-6V5z"/>',
  grenade: '<circle cx="11" cy="10" r="5"/><path d="M13 5l3-2h3"/>',
  consumable: '<rect x="5" y="3" width="14" height="11" rx="2"/><path d="M12 6v5M9.5 8.5h5"/>',
  attachment: '<circle cx="12" cy="8" r="5"/><circle cx="12" cy="8" r="1.5"/>',
};
function kindIcon(kind) {
  const body = KIND_ICONS[kind] ?? KIND_ICONS.material;
  return `<span class="raid-cell-icon" aria-hidden="true"><svg viewBox="0 0 24 16" fill="none" stroke="currentColor" stroke-width="1.4" stroke-linejoin="round">${body}</svg></span>`;
}

/** 槽位 view model → 格子 HTML。slotKey 是稳定槽位 id（'armor' / '0'..'N'）。 */
export function cellHtml(container, slotKey, vm, options = {}) {
  const group = options.group ? ` data-raid-group="${escapeHtml(options.group)}"` : '';
  const instance = vm?.instanceId ? ` data-instance-id="${escapeHtml(vm.instanceId)}"` : '';
  const readonly = ' data-raid-readonly="true"';
  const selected = options.selected ? ' selected' : '';
  const empty = vm ? '' : ' empty';
  if (!vm) {
    return `<div class="raid-cell${empty}" data-raid-container="${container}"` +
      ` data-raid-slot="${escapeHtml(slotKey)}"${group}${instance}${readonly}></div>`;
  }
  // 武器/护甲都是单件装备位：×1 是噪声，不显示；可堆叠物品才显示 ×N。
  const qty = vm.slotKind === 'weapon' || vm.slotKind === 'armor'
    ? ''
    : `×${vm.quantity ?? 1}`;
  const sub = vm.slotKind === 'weapon'
    ? `弹药 ${vm.ammo ?? '—'}/${vm.reserveUnlimited ? '∞' : (vm.reserve ?? '—')}`
    : `价值 ${(vm.value ?? 0) * (vm.quantity ?? 1)}`;
  const tierAttr = vm.tier && TIER_LABELS[vm.tier] ? ` data-tier="${escapeHtml(vm.tier)}"` : '';
  const kindAttr = vm.slotKind ? ` data-kind="${escapeHtml(vm.slotKind)}"` : '';
  return `<div class="raid-cell${selected}" data-raid-container="${container}"` +
    ` data-raid-slot="${escapeHtml(slotKey)}"${group}${instance}${readonly}${tierAttr}${kindAttr}` +
    ` title="${escapeHtml(vm.name)} · ${escapeHtml(sub)}">` +
    kindIcon(vm.slotKind) +
    `<span class="raid-cell-name">${escapeHtml(vm.name)}</span>` +
    `<span class="raid-cell-qty">${escapeHtml(qty)}</span>` +
    `<span class="raid-cell-sub">${escapeHtml(sub)}</span>` +
    `</div>`;
}

/** 装备格的稳定槽位 key：armor / 0 / 1 / 2（0=手枪，1/2=主武器）。 */
function equipmentCellHtml(model, options) {
  const selected = options.selected;
  const rows = [
    { key: 'armor', vm: model.equipment.armor, label: '护甲' },
    { key: '0', vm: model.equipment.slots[0], label: '手枪' },
    { key: '1', vm: model.equipment.slots[1], label: '主武器 1' },
    { key: '2', vm: model.equipment.slots[2], label: '主武器 2' },
  ];
  return rows.map((row) => {
    const isSel = selected?.container === 'equipment' && selected?.slotKey === row.key;
    return `<div class="raid-cell-tag">${row.label}</div>` +
      cellHtml('equipment', row.key, row.vm, { selected: isSel });
  }).join('');
}

function detailChip(model, item, note) {
  const kind = (KIND_LABELS[item?.slotKind] ?? item?.slotKind ?? '—')
    + (item?.tier && TIER_LABELS[item.tier] ? ` · ${TIER_LABELS[item.tier]}` : '');
  // 武器显示弹药、护甲是单件装备位（数量恒 1 是噪声），其余才显示 ×N/堆叠上限。
  const qty = item?.slotKind === 'weapon'
    ? '弹药 ' + (item.ammo ?? '—') + ' / ' + (item.reserveUnlimited ? '∞' : (item.reserve ?? '—'))
    : item?.slotKind === 'armor'
      ? '单件价值 ' + (item?.value ?? 0)
      : '数量 ×' + (item?.quantity ?? 1) + ' · 堆叠上限 ' + (item?.stackMax ?? 1) +
        ' · 单件价值 ' + (item?.value ?? 0);
  return `<span class="raid-detail-line">类型 ${escapeHtml(kind)} · ${escapeHtml(qty)}</span>` +
    `<span class="raid-detail-note">${escapeHtml(note)}</span>`;
}

/** 可拆分堆叠的数量滑块（数量 ≥2 才出现）。默认值 = 一半。 */
function splitControlHtml(vm) {
  if (!vm || (vm.quantity ?? 1) < 2) return '';
  const half = Math.floor(vm.quantity / 2);
  return `<div class="raid-split-control">` +
    `<label>拆分 <span data-raid-split-value>×${half}</span></label>` +
    `<input type="range" data-raid-split-input min="1" max="${vm.quantity - 1}" value="${half}" aria-label="拆分数量">` +
    `<button type="button" data-raid-action="split">拆分</button>` +
    `</div>`;
}

/**
 * 根据选中槽位渲染详情区 HTML。返回 { html, container, index } 供控制器判断动作。
 */
export function detailHtml(model, selected) {
  if (!selected) {
    return {
      html: `<div class="raid-detail"><span class="raid-detail-note">点击槽位查看详情 · 装备栏只读</span></div>`,
    };
  }
  if (selected.container === 'equipment') {
    const row = selected.slotKey === 'armor'
      ? { vm: model.equipment.armor }
      : { vm: model.equipment.slots[Number(selected.slotKey)] ?? null };
    // 槽位标签用玩家语义，绝不暴露「装备槽 0」这类内部 key。
    const label = EQUIPMENT_SLOT_LABELS[selected.slotKey] ?? `装备槽 ${selected.slotKey}`;
    return {
      html: `<div class="raid-detail" data-raid-selected="equipment:${escapeHtml(selected.slotKey)}">` +
        `<b class="raid-detail-name">${label} · ${escapeHtml(row.vm?.name ?? '空')}</b>` +
        detailChip(model, row.vm, model.equipment.readOnlyNote) +
        `</div>`,
    };
  }
  if (selected.container === 'quickUse') {
    const vm = model.quickUse.slots[selected.index] ?? null;
    const actions = vm
      ? `<div class="raid-detail-actions">` +
        `<button type="button" data-raid-action="use">使用</button>` +
        `<button type="button" data-raid-action="discard">放回背包</button>` +
        `</div>`
      : '';
    return {
      html: `<div class="raid-detail" data-raid-selected="quickUse:${selected.index}">` +
        `<b class="raid-detail-name">${escapeHtml(vm?.name ?? '空槽')}</b>` +
        detailChip(model, vm, vm ? '快捷栏物品 · 使用或放回背包' : '快捷栏未放入物品') +
        splitControlHtml(vm) +
        actions +
        `</div>`,
      container: 'quickUse',
      index: selected.index,
    };
  }
  // 容器栏：固定格 + 拿取到背包（原子转移；容量不足完整回滚，不半转移）
  if (selected.container === 'container') {
    const vm = model.container.opened ? model.container.slots[selected.index] ?? null : null;
    const actions = vm
      ? `<div class="raid-detail-actions">` +
        `<button type="button" data-raid-action="quick-move">拿取到背包</button>` +
        `<button type="button" data-raid-action="take-all">全部拿取</button>` +
        `</div>`
      : '';
    return {
      html: `<div class="raid-detail" data-raid-selected="container:${escapeHtml(selected.slotKey)}">` +
        `<b class="raid-detail-name">${escapeHtml(vm?.name ?? '容器空槽')}</b>` +
        detailChip(model, vm, model.container.opened
          ? (vm ? '容器物品 · 拿取成功后才计入携带物' : '容器空格 · 拿走或回放物品后落位')
          : model.container.placeholderText) +
        splitControlHtml(vm) +
        actions +
        `</div>`,
      container: 'container',
      index: selected.index,
    };
  }
  // 背包：会话打开时提供「放入容器」（装备/快捷栏方向保持只读拒绝）
  const vm = selected.container === 'backpack'
    ? model.backpack.slots[selected.index]?.item ?? null
    : null;
  const canQuick = vm && (vm.slotKind === 'grenade' || vm.slotKind === 'consumable');
  const splitControl = splitControlHtml(vm);
  const backpackButtons = [
    canQuick ? `<button type="button" data-raid-action="to-quickuse">放入快捷栏</button>` : '',
    vm && model.container.opened ? `<button type="button" data-raid-action="to-container">放入容器</button>` : '',
  ].join('');
  const backpackActions = backpackButtons
    ? `<div class="raid-detail-actions">${backpackButtons}</div>`
    : '';
  const note = selected.container === 'backpack'
    ? (model.container.opened
        ? '背包物品 · 可放入打开的容器（装备位物品不可转移）'
        : model.backpack.readOnlyNote)
    : model.container.placeholderText;
  return {
    html: `<div class="raid-detail" data-raid-selected="${escapeHtml(selected.container)}:${escapeHtml(selected.slotKey)}">` +
      `<b class="raid-detail-name">${escapeHtml(vm?.name ?? '背包格')}</b>` +
      detailChip(model, vm, note) +
      splitControl +
      backpackActions +
      `</div>`,
  };
}

/**
 * 渲染面板内部 HTML（不含根节点；根节点的 open 类由控制器维护）。
 * 三栏/四栏并列：Equipment（只读）| Backpack（固定格）| Quick Use（固定 5 格）|
 * 容器占位入口。所有槽位带稳定 data-raid-container/data-raid-slot。
 *
 * @param {object} model     buildRaidInventoryModel 的返回值
 * @param {object} [options] { selected: {container, slotKey, index} | null, hints }
 * @returns {string}
 */
export function renderRaidInventoryModel(model, options = {}) {
  const selected = options.selected ?? null;
  const selMatch = (container, slotKey) =>
    selected && selected.container === container && selected.slotKey === String(slotKey);

  const backpackCells = model.backpack.slots.map((entry, i) => {
    if (!entry) return cellHtml('backpack', String(i), null, { selected: false });
    return cellHtml('backpack', String(i), entry.item, {
      group: entry.group,
      selected: selMatch('backpack', i),
    });
  }).join('');

  const quickCells = model.quickUse.slots.map((vm, i) =>
    cellHtml('quickUse', String(i), vm, { selected: selMatch('quickUse', i) })
  ).join('');

  const containerCells = model.container.opened
    ? model.container.slots.map((vm, i) =>
        cellHtml('container', String(i), vm, {
          group: 'container',
          selected: selMatch('container', i),
        })
      ).join('')
    : `<div class="raid-cell empty raid-cell-placeholder" data-raid-container="container"` +
      ` data-raid-slot="0" data-raid-readonly="true">` +
      `<span class="raid-cell-name">${escapeHtml(model.container.placeholderText)}</span>` +
      `</div>`;

  const detail = detailHtml(model, selected);

  const closeButton =
    `<button type="button" class="raid-close-btn" data-raid-action="close-panel">` +
    `关闭 <span class="raid-close-hint">Tab / Esc</span></button>`;
  const defaultHints = model.container.opened
    ? `<b>Tab</b> / <b>Esc</b> 关闭 · <b>拖拽</b>移动/合并/互换 · <b>Ctrl+拖</b>拆一半 · <b>双击</b>快速转移 · <b>F</b> 全部拿取`
    : '<b>Tab</b> / <b>Esc</b> 关闭 · <b>拖拽</b>移动/合并/互换 · <b>Ctrl+拖</b>拆一半 · <b>双击</b>放入快捷栏';
  const hints = options.hints ?? defaultHints;

  return (
    `<div class="raid-cols">` +
    `<section class="raid-col" data-raid-column="equipment">` +
    `<h3 class="raid-col-title">装备 <em>EQUIPMENT</em></h3>` +
    `<div class="raid-cells raid-cells-equipment">${equipmentCellHtml(model, { selected })}</div>` +
    `</section>` +
    `<section class="raid-col" data-raid-column="backpack">` +
    `<h3 class="raid-col-title">背包 <span class="raid-count">${model.backpack.used} / ${model.backpack.capacity}</span></h3>` +
    `<div class="raid-cells">${backpackCells}</div>` +
    `</section>` +
    `<section class="raid-col" data-raid-column="quickUse">` +
    `<h3 class="raid-col-title">快捷栏 <span class="raid-count">${model.quickUse.used} / ${model.quickUse.capacity}</span></h3>` +
    `<div class="raid-cells raid-cells-quick">${quickCells}</div>` +
    `</section>` +
    `<section class="raid-col raid-col-container" data-raid-column="container">` +
    `<h3 class="raid-col-title">容器 ` +
    (model.container.opened
      ? `<em>${escapeHtml(model.container.label)}</em>` +
        `<span class="raid-count">${model.container.used} / ${model.container.capacity}</span>`
      : '<em>PLACEHOLDER</em>') +
    `</h3>` +
    `<div class="raid-cells">${containerCells}</div>` +
    `</section>` +
    `</div>` +
    detail.html +
    `<div class="raid-hints">${closeButton}<span>${hints}</span></div>`
  );
}

// ─────────────────────────────────────────────────────────────────────────────
// 薄控制器：一次 click 事件委托 + 原子数据操作
// ─────────────────────────────────────────────────────────────────────────────

const EQUIPMENT_ADVICE = '局内装备不可更换';

/** 装备详情区的玩家语义标签（内部 slotKey → 展示名）。 */
const EQUIPMENT_SLOT_LABELS = {
  armor: '护甲',
  0: '手枪',
  1: '主武器 1',
  2: '主武器 2',
};

export class RaidInventoryView {
  /**
   * @param {object} player   带 raidInventory / inventory
   * @param {object} loadout  Loadout（slots 武器真源）
   * @param {object} [options]
   *   root             #raid-inventory 节点（可为 null：无 DOM 模式）
   *   armorId          字符串或 () => string，覆盖护甲 id 解析
   *   throwGrenadeItem (item) => boolean 真实投掷器；假值/异常绝不扣减
   *   useConsumable    (item, index) => {ok,...} 消耗品效果，未接入则不扣减
   *   onActionResult   (result) => void 每次 handleAction 后回调（toast/音效）
   */
  constructor(player, loadout, options = {}) {
    this.player = player;
    this.loadout = loadout;
    this.options = options;
    this.root = options.root ?? null;
    this.selected = null;      // { container, slotKey, index } | null
    this.isOpen = false;
    this._bound = false;
    this.bindOnce();
    this.refresh();
  }

  /** DOM 事件委托只绑定一次：所有点击都在 root 上分发，绝不每帧重复绑定。 */
  bindOnce() {
    if (this._bound || !this.root) return;
    this._bound = true;
    this.root.addEventListener('click', (event) => this.onClick(event));
    this.root.addEventListener('dblclick', (event) => this.onQuickMove(event));
    this.root.addEventListener('contextmenu', (event) => {
      event.preventDefault?.();
      this.onQuickMove(event);
    });
    this.root.addEventListener('pointerdown', (event) => this.onPointerDown(event));
    this.root.addEventListener('pointermove', (event) => this.onPointerMove(event));
    this.root.addEventListener('pointerup', (event) => this.onPointerUp(event));
    this.root.addEventListener('pointercancel', () => this.cancelDrag());
    this.root.addEventListener('lostpointercapture', () => this.cancelDrag());
    this.root.addEventListener('input', (event) => this.onSplitInput(event));
    if (typeof window !== 'undefined') window.addEventListener('blur', () => this.cancelDrag());
  }

  // ── 拖拽（指针事件委托）────────────────────────────────────────────────
  // 拖拽期间数据完全不动：只有松手且目标合法时才调用 moveToSlot 原子提交。
  // Ctrl+拖拽 = 拆一半（ARC 的 Split Stack；Alt 在本项目是翻滚、浏览器也会抢）。
  // 装备栏只读，不能作为拖拽来源或目标。

  /** 物品格 DOM → 数据地址；装备格、容器占位格返回 null。 */
  cellRef(cell) {
    const container = cell?.dataset?.raidContainer;
    if (!DRAGGABLE_CONTAINERS.has(container)) return null;
    if (cell.classList?.contains('raid-cell-placeholder')) return null;
    const index = Number.parseInt(cell.dataset.raidSlot, 10);
    return Number.isInteger(index) ? { container, index } : null;
  }

  onPointerDown(event) {
    if (this.drag || event.button !== 0 || event.isPrimary === false) return;
    const cell = event.target?.closest?.('.raid-cell[data-raid-container]');
    if (!cell || cell.classList.contains('empty')) return;
    const ref = this.cellRef(cell);
    if (!ref) return;
    const item = resolveSlotItem(this.player?.raidInventory, ref);
    if (!item) return;
    this.drag = {
      pointerId: event.pointerId,
      sourceEl: cell,
      from: ref,
      item,
      split: !!(event.ctrlKey || event.metaKey) && (item.quantity ?? 1) > 1,
      startX: event.clientX,
      startY: event.clientY,
      started: false,
      targetEl: null,
      ghost: null,
    };
  }

  onPointerMove(event) {
    const d = this.drag;
    if (!d || d.pointerId !== event.pointerId) return;
    if (!d.started) {
      if (Math.hypot(event.clientX - d.startX, event.clientY - d.startY) < DRAG_THRESHOLD_PX) return;
      d.started = true;
      d.sourceEl.classList.add('dragging');
      d.ghost = this.createGhost(d);
      try { this.root.setPointerCapture?.(event.pointerId); } catch { /* 指针已失效 */ }
    }
    event.preventDefault?.();
    if (d.ghost) {
      d.ghost.style.left = `${event.clientX}px`;
      d.ghost.style.top = `${event.clientY}px`;
    }
    this.updateDropTarget(event.clientX, event.clientY);
  }

  onPointerUp(event) {
    const d = this.drag;
    if (!d || d.pointerId !== event.pointerId) return;
    const target = d.started ? d.targetEl : null;
    const started = d.started;
    this.cancelDrag();
    if (!started) return;              // 没越过阈值 = 普通点击，交给 click 处理
    // 拖拽松手后浏览器可能紧跟一个合成 click（也可能没有）：只吞 250ms 内的那一次，
    // 否则会把玩家之后真正的点击吃掉
    this._suppressClickUntil = Date.now() + 250;
    const to = target ? this.cellRef(target) : null;
    if (!to) return;
    const quantity = d.split ? Math.floor((d.item.quantity ?? 1) / 2) : undefined;
    if (this.options.remoteAction?.()) {
      this.options.remoteAction('drag', null, { from: d.from, to, quantity, instanceId: d.item.instanceId });
      return;
    }
    const result = moveToSlot(this.player?.raidInventory, d.from, to,
      quantity === undefined ? {} : { quantity });
    if (result?.ok) {
      this.selected = null;
      this.refresh();
    }
    this.options.onActionResult?.(result?.ok
      ? { ...result, dragged: true, reason: dragResultText(result) }
      : result);
  }

  /** 按指针位置找目标格，并给出可放 / 不可放的预览。 */
  updateDropTarget(x, y) {
    const d = this.drag;
    const doc = this.root?.ownerDocument;
    const hit = doc?.elementFromPoint?.(x, y)?.closest?.('.raid-cell[data-raid-container]') ?? null;
    if (hit === d.targetEl) return;
    d.targetEl?.classList.remove('drop-ok', 'drop-bad');
    d.targetEl = hit;
    if (!hit || hit === d.sourceEl) return;
    const to = this.cellRef(hit);
    const verdict = to ? previewMove(this.player?.raidInventory, d.from, to, d.split) : { ok: false };
    hit.classList.add(verdict.ok ? 'drop-ok' : 'drop-bad');
  }

  createGhost(d) {
    const doc = this.root?.ownerDocument;
    if (!doc?.body) return null;
    const ghost = doc.createElement('div');
    ghost.className = 'raid-drag-ghost';
    ghost.innerHTML = d.sourceEl.innerHTML;
    if (d.split) {
      const half = Math.floor((d.item.quantity ?? 1) / 2);
      ghost.insertAdjacentHTML('beforeend', `<span class="raid-ghost-split">拆分 ×${half}</span>`);
    }
    doc.body.appendChild(ghost);
    return ghost;
  }

  /** 取消拖拽：只清视觉层（数据从未移动）。面板关闭 / 失焦 / 指针取消共用。 */
  cancelDrag() {
    const d = this.drag;
    if (!d) return;
    this.drag = null;
    d.sourceEl?.classList.remove('dragging');
    d.targetEl?.classList.remove('drop-ok', 'drop-bad');
    d.ghost?.remove();
    try { this.root?.releasePointerCapture?.(d.pointerId); } catch { /* 已释放 */ }
  }

  // ── 拆分面板（详情栏里的数量滑块）─────────────────────────────────────

  onSplitInput(event) {
    const el = event.target;
    if (!el?.matches?.('[data-raid-split-input]')) return;
    this.splitAmount = Number.parseInt(el.value, 10);
    const label = this.root?.querySelector?.('[data-raid-split-value]');
    if (label) label.textContent = `×${this.splitAmount}`;
  }

  /**
   * ARC 式快速转移：双击 / 右键 / Shift+点击 按所在栏选择唯一合理去向 ——
   * 容器→背包、背包→容器（容器打开时）或快捷栏（投掷物/消耗品）、快捷栏→背包。
   * 仍然只走原子 API，失败时什么都不动。
   */
  onQuickMove(event) {
    const target = event?.target;
    const cell = typeof target?.closest === 'function'
      ? target.closest('.raid-cell[data-raid-container]') : null;
    if (!cell || cell.classList?.contains('empty')) return null;
    if (!this.select(cell.dataset.raidContainer, cell.dataset.raidSlot)) return null;
    const result = this.handleAction(this.quickMoveAction());
    this.options.onActionResult?.(result);
    return result;
  }

  /** 当前选中格的默认快速转移动作。 */
  quickMoveAction() {
    const sel = this.selected;
    if (!sel) return null;
    if (sel.container === 'container') return 'quick-move';
    if (sel.container === 'quickUse') return 'discard';
    if (sel.container === 'backpack') {
      if (this.player?.raidInventory?.openContainer?.items) return 'to-container';
      return 'to-quickuse';
    }
    return null;
  }

  onClick(event) {
    if (this._suppressClickUntil && Date.now() < this._suppressClickUntil) {
      this._suppressClickUntil = 0;
      return;
    }
    const target = event?.target;
    const finder = target?.closest;
    if (typeof finder !== 'function') return;
    const actionEl = finder.call(target, '[data-raid-action]');
    if (actionEl?.dataset?.raidAction) {
      const result = this.handleAction(actionEl.dataset.raidAction);
      this.options.onActionResult?.(result);
      return;
    }
    const cell = finder.call(target, '.raid-cell[data-raid-container]');
    if (!cell) return;
    if (event?.shiftKey) { this.onQuickMove(event); return; }
    this.select(cell.dataset.raidContainer, cell.dataset.raidSlot);
  }

  /**
   * 选中槽位。quick 容器只在「槽里有物品」时才同步
   * setQuickUseSelectedIndex（G / HUD 读同一 getter）；点空槽只显示/选中
   * 详情，绝不把当前有效索引指向空槽 —— 与 Q 轮盘「有效确认才同步」语义
   * 一致（空槽确认不改变 getQuickUseSelectedIndex）。只同步索引，
   * 绝不复制、移动实例对象。
   */
  select(container, slotKey) {
    if (!container || slotKey === undefined) return false;
    if (container === 'quickUse') {
      const index = Number.parseInt(slotKey, 10);
      if (!Number.isInteger(index) || index < 0 || index >= QUICK_USE_SLOT_COUNT) return false;
      const item = this.player?.raidInventory?.quickUse?.[index] ?? null;
      if (item) {
        const ok = setQuickUseSelectedIndex(this.player?.raidInventory ?? null, index);
        if (!ok) return false;
      }
      this.selected = { container, slotKey: String(index), index };
    } else {
      const index = Number.isInteger(Number.parseInt(slotKey, 10))
        ? Number.parseInt(slotKey, 10)
        : null;
      // 容器槽只认会话容量内的合法索引；选中槽同步会话 selected（会话状态）。
      if (container === 'container') {
        const session = this.player?.raidInventory?.openContainer ?? null;
        const capacity = session?.capacity;
        if (!session || !Number.isInteger(index) || index < 0 || index >= capacity) {
          return false;
        }
        if (session) session.selected = index;
      }
      this.selected = { container, slotKey: String(slotKey), index };
    }
    this.refresh();
    return true;
  }

  /**
   * 面板操作。所有改写都必须走 raid-inventory 原子 API,失败完整回滚:
   *   close-panel 关闭面板(onCloseRequest → main.js 收口,无回调时本地 close)
   *   quick-move  容器格 → 背包(transferItem 原子转移;容器满/背包满不丢物)
   *   to-container 背包格 → 打开的容器(容量判定由 transferItem 负责)
   *   to-quickuse 背包格 → 快捷栏第一个空格
   *   use         quickUse 手雷 → attemptGrenadeThrow(thrower 返回真值才扣减)
   *   use         quickUse 消耗品 → options.useConsumable(未接入不扣减)
   *   discard     quickUse 槽 → clearQuickUseSlot(放回背包,失败完整回滚)
   *   split       当前选中格 → splitStack 拆分到同组第一个空格
   *   equipment   只读拒绝;quickUse → 容器方向明确拒绝(快捷栏是投掷唯一真源)。
   */
  handleAction(action) {
    // 关闭按钮不依赖选中槽:任何时候都可收起面板。
    if (action === 'close-panel') {
      if (typeof this.options.onCloseRequest === 'function') this.options.onCloseRequest();
      else this.close();
      return { ok: true, closed: true };
    }
    if (this.options.remoteAction?.()) {
      const item = this.getSelectedItem();
      return this.options.remoteAction(action, this.selected, {
        quantity: this.splitAmount ?? Math.floor((item?.quantity ?? 1) / 2),
      });
    }
    const raid = this.player?.raidInventory ?? null;
    if (action === 'take-all') return this.takeAll();
    if (action === 'split') return this.split();
    const sel = this.selected;
    if (!sel) return { ok: false, reason: '未选中物品' };

    if (sel.container === 'container') {
      if (action !== 'quick-move') {
        return { ok: false, reason: '容器栏仅支持「拿取到背包」' };
      }
      const item = raid?.openContainer?.items?.[sel.index] ?? null;
      if (!item) return { ok: false, reason: '容器该格没有物品' };
      const result = transferItem(raid, 'container', 'backpack', item);
      if (result?.ok) this._afterMutation();
      return result;
    }

    if (sel.container === 'backpack') {
      const vm = buildRaidInventoryModel(this.player, this.loadout, this.options)
        .backpack.slots[sel.index]?.item ?? null;
      if (!vm) return { ok: false, reason: '背包该格没有物品' };
      if (action === 'to-quickuse') {
        const quick = raid?.quickUse ?? [];
        const free = quick.findIndex((it) => !it);
        if (free < 0) return { ok: false, reason: '快捷栏已满 · 先放回一件' };
        const result = setQuickUseSlot(raid, free, vm.instanceId);
        if (result?.ok) this._afterMutation();
        return result;
      }
      if (action !== 'to-container') {
        return { ok: false, reason: '背包仅支持「放入容器 / 快捷栏」' };
      }
      const result = transferItem(raid, 'backpack', 'container', vm.instanceId);
      if (result?.ok) this._afterMutation();
      return result;
    }

    if (sel.container !== 'quickUse') {
      return {
        ok: false,
        reason: sel.container === 'equipment'
          ? EQUIPMENT_ADVICE
          : '本批该区域只读',
      };
    }
    const item = raid?.quickUse?.[sel.index] ?? null;
    if (!item) return { ok: false, reason: '快捷栏槽位为空' };

    let result;
    if (action === 'use') {
      if (item.slotKind === 'grenade') {
        const thrower = typeof this.options.throwGrenadeItem === 'function'
          ? this.options.throwGrenadeItem
          : () => false;
        result = attemptGrenadeThrow(raid, sel.index, thrower);
      } else if (typeof this.options.useConsumable === 'function') {
        result = this.options.useConsumable(item, sel.index) ?? { ok: false, reason: '使用失败' };
      } else {
        return { ok: false, reason: '效果未接入 · 未消耗数量' };
      }
    } else if (action === 'discard') {
      result = clearQuickUseSlot(raid, sel.index);
    } else {
      return { ok: false, reason: `未知操作 ${action}` };
    }
    if (result?.ok) this._afterMutation();
    return result;
  }

  /**
   * 拆分堆叠：读当前选中格的 splitAmount（通过滑块/输入框设置），
   * 调用 splitStack 原子拆分到同组第一个空格。
   */
  split() {
    const sel = this.selected;
    if (!sel) return { ok: false, reason: '未选中物品' };
    const raid = this.player?.raidInventory ?? null;
    const ref = { container: sel.container, index: sel.index };
    const item = resolveSlotItem(raid, ref);
    if (!item) return { ok: false, reason: '该格没有物品' };
    if ((item.quantity ?? 1) <= 1) return { ok: false, reason: '数量不足 · 无法拆分' };
    const quantity = Number.isInteger(this.splitAmount) && this.splitAmount > 0
      ? Math.min(this.splitAmount, item.quantity - 1)
      : Math.floor(item.quantity / 2);
    const result = splitStack(raid, ref, quantity);
    if (result?.ok) {
      this.splitAmount = null;
      this._afterMutation();
    }
    return result;
  }

  /**
   * 全部拿取：按容器顺序逐件原子转移，装不下的留在箱里并汇报件数。
   * 每件独立成败 —— 背包满只会停在「剩 N 件」，不会把前面成功的回滚掉。
   */
  takeAll() {
    const raid = this.player?.raidInventory ?? null;
    const items = raid?.openContainer?.items;
    if (!Array.isArray(items) || items.length === 0) return { ok: false, reason: '容器里没有物品' };
    let moved = 0;
    let lastReason = null;
    for (const item of [...items]) {
      if (!item) continue;
      const result = transferItem(raid, 'container', 'backpack', item);
      if (result?.ok) moved++;
      else lastReason = result?.reason ?? lastReason;
    }
    this.selected = null;
    this.refresh();
    const left = raid.openContainer.items.filter(Boolean).length;
    if (moved === 0) return { ok: false, reason: lastReason ?? '背包已满' };
    return { ok: true, moved, left, reason: left ? `已拿取 ${moved} 件 · 剩 ${left} 件装不下` : `已拿取 ${moved} 件` };
  }

  _afterMutation() {
    // 转移/使用后槽位可能被置空：清掉指向空槽的选中，避免详情停在残留实例上。
    const sel = this.selected;
    if (sel) {
      const raid = this.player?.raidInventory ?? null;
      let empties = false;
      if (sel.container === 'quickUse') {
        empties = !raid?.quickUse?.[sel.index];
      } else if (sel.container === 'container') {
        empties = !(raid?.openContainer?.items?.[sel.index] ?? null);
      } else if (sel.container === 'backpack') {
        const model = buildRaidInventoryModel(this.player, this.loadout, this.options);
        empties = !model.backpack.slots[sel.index]?.item;
      }
      if (empties) this.selected = null;
    }
    this.refresh();
  }

  /** 把最新模型刷进 DOM；无 root 时只更新内部状态（Node 测试模式）。 */
  refresh() {
    const model = buildRaidInventoryModel(this.player, this.loadout, this.options);
    this.lastHtml = renderRaidInventoryModel(model, { selected: this.selected });
    if (this.root) this.root.innerHTML = this.lastHtml;
    return this.lastHtml;
  }

  open() {
    this.isOpen = true;
    if (this.root?.classList) this.root.classList.add('open');
    this.setAriaHidden(false);
    this.refresh();
    this.tryFocusPanel();
    return true;
  }

  close() {
    this.cancelDrag();
    this.isOpen = false;
    this.selected = null;
    this.splitAmount = null;
    if (this.root?.classList) this.root.classList.remove('open');
    this.setAriaHidden(true);
    return true;
  }

  /** open/close 同步 aria-hidden：打开时对辅助技术可见，关闭恢复隐藏。 */
  setAriaHidden(hidden) {
    if (this.root?.setAttribute) this.root.setAttribute('aria-hidden', String(hidden));
  }

  /**
   * 打开时把焦点放到面板根（DOM 需要 tabindex=-1 才能程序化聚焦）。
   * 刻意不 focus 画布：关闭后焦点由指针锁定流程接管，键盘不会沉进画布。
   */
  tryFocusPanel() {
    if (typeof this.root?.focus !== 'function') return;
    try { this.root.focus({ preventScroll: true }); } catch { /* 无焦点也能操作 */ }
  }

  toggle() {
    return this.isOpen ? this.close() : this.open();
  }

  /** 当前选中槽的视图模型（无选中返回 null）。 */
  getSelectedItem() {
    if (!this.selected) return null;
    const raid = this.player?.raidInventory ?? null;
    if (this.selected.container === 'quickUse') {
      return raid?.quickUse?.[this.selected.index] ?? null;
    }
    if (this.selected.container === 'container') {
      return raid?.openContainer?.items?.[this.selected.index] ?? null;
    }
    const model = buildRaidInventoryModel(this.player, this.loadout, this.options);
    if (this.selected.container === 'backpack') {
      return model.backpack.slots[this.selected.index]?.item ?? null;
    }
    if (this.selected.container === 'equipment') {
      if (this.selected.slotKey === 'armor') return model.equipment.armor;
      return model.equipment.slots[Number(this.selected.slotKey)] ?? null;
    }
    return null;
  }
}

/** 工厂：与 main.js 接线用的等价适配器（player + Loadout → 面板控制器）。 */
export function createRaidInventoryView(player, loadout, options = {}) {
  return new RaidInventoryView(player, loadout, options);
}
