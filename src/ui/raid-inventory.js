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
  getQuickUseSelectedIndex,
  setQuickUseSelectedIndex,
  transferItem,
} from '../systems/raid-inventory.js';
import { ARMOR_TYPES } from '../systems/loadout-config.js';

export { QUICK_USE_SLOT_COUNT };

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
  return `<div class="raid-cell${selected}" data-raid-container="${container}"` +
    ` data-raid-slot="${escapeHtml(slotKey)}"${group}${instance}${readonly}` +
    ` title="${escapeHtml(vm.name)} · ${escapeHtml(sub)}">` +
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
  const kind = item?.slotKind ?? '—';
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
        `</div>`
      : '';
    return {
      html: `<div class="raid-detail" data-raid-selected="container:${escapeHtml(selected.slotKey)}">` +
        `<b class="raid-detail-name">${escapeHtml(vm?.name ?? '容器空槽')}</b>` +
        detailChip(model, vm, model.container.opened
          ? (vm ? '容器物品 · 拿取成功后才计入携带物' : '容器空格 · 拿走或回放物品后落位')
          : model.container.placeholderText) +
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
  const backpackActions = vm && model.container.opened
    ? `<div class="raid-detail-actions">` +
      `<button type="button" data-raid-action="to-container">放入容器</button>` +
      `</div>`
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
    ? `<b>Tab</b> / <b>Esc</b> 关闭 · 点击容器物品选中后「拿取到背包」 · 局内装备不可更换`
    : '<b>Tab</b> / <b>Esc</b> 关闭 · 点击槽位查看详情 · 局内装备不可更换';
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
  }

  onClick(event) {
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
    if (cell) this.select(cell.dataset.raidContainer, cell.dataset.raidSlot);
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
   * 面板操作。所有改写都必须走 raid-inventory 原子 API，失败完整回滚：
   *   close-panel 关闭面板（onCloseRequest → main.js 收口，无回调时本地 close）
   *   quick-move  容器格 → 背包（transferItem 原子转移；容器满/背包满不丢物）
   *   to-container 背包格 → 打开的容器（容量判定由 transferItem 负责）
   *   use         quickUse 手雷 → attemptGrenadeThrow（thrower 返回真值才扣减）
   *   use         quickUse 消耗品 → options.useConsumable（未接入不扣减）
   *   discard     quickUse 槽 → clearQuickUseSlot（放回背包，失败完整回滚）
   *   equipment   只读拒绝；quickUse → 容器方向明确拒绝（快捷栏是投掷唯一真源）。
   */
  handleAction(action) {
    // 关闭按钮不依赖选中槽：任何时候都可收起面板。
    if (action === 'close-panel') {
      if (typeof this.options.onCloseRequest === 'function') this.options.onCloseRequest();
      else this.close();
      return { ok: true, closed: true };
    }
    const sel = this.selected;
    if (!sel) return { ok: false, reason: '未选中物品' };
    const raid = this.player?.raidInventory ?? null;

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
      if (action !== 'to-container') {
        return { ok: false, reason: '背包仅支持「放入容器」' };
      }
      const vm = buildRaidInventoryModel(this.player, this.loadout, this.options)
        .backpack.slots[sel.index]?.item ?? null;
      if (!vm) return { ok: false, reason: '背包该格没有物品' };
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
    this.isOpen = false;
    this.selected = null;
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
