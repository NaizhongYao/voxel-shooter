/**
 * 装备整备面板交互逻辑
 * 
 * 负责：
 * 1. 渲染枪械、防护、手榴弹选项
 * 2. 处理标签切换（枪械/防护/手榴弹/仓库/制作）
 * 3. 处理枪械部件的展开/收起
 * 4. 同步更新角色属性和装备摘要
 * 5. 连接到主流程（任务选择 → 简报 → 装备整备）
 * 6. 切到「仓库/制作」页签时触发 hub-nav.js 的数据刷新
 */

import { loadoutManager } from '../systems/loadout-manager.js';
import * as UnlockChecker from '../systems/unlock-checker.js';
import { WEAPONS } from '../systems/weapons.js';
import {
  ATTACHMENTS,
  ATTACHMENT_SLOT,
  WEAPON_SLOTS,
  ARMOR_TYPES,
  GRENADE_TYPES,
} from '../systems/loadout-config.js';
import {
  slotLayout,
  grenadeStackMax,
  ItemInstance,
  autoPlace,
  canAccept,
  tryStack,
  resizeInventory,
  pruneStaleStashItems,
} from '../systems/inventory.js';
import { normalizeItemInstance } from '../systems/raid-inventory.js';
import { unloadBackpack } from '../systems/stash-service.js';
import { initEquipmentPreview, updateRigArmor } from './equipment-preview.js';
import { gunGlyph, grenadeGlyph } from './loadout-art.js';
// 仓库/制作数据渲染在 hub-nav.js（本文件只负责「什么时机调用」，不重复渲染逻辑）
import { refreshWarehouse, refreshCrafting } from './hub-nav.js';

let currentTab = 'weapon';
let selectedWeaponForDetail = null;

function notifyLoadoutChanged() {
  window.dispatchEvent(new CustomEvent('loadout-changed'));
}

/**
 * 初始化装备面板
 */
export function initEquipmentUI() {
  const equipmentPanel = document.getElementById('equipment');
  if (!equipmentPanel) return;

  // 初始化 3D 预览
  initEquipmentPreview();
  updateRigArmor(loadoutManager.armor);

  // 标签切换
  document.querySelectorAll('.eq-tab').forEach(tab => {
    tab.addEventListener('click', () => {
      const tabName = tab.dataset.tab;
      switchTab(tabName);
    });
  });

  // 返回任务简报
  document.getElementById('eq-back')?.addEventListener('click', () => {
    // 面板关闭也是同步点之一：把本次整理写回四字段配置（不重建背包）。
    loadoutManager.syncLoadoutFromInventory();
    hideEquipment();
    window.dispatchEvent(new CustomEvent('equipment-back-brief'));
  });

  // 装备确认后直接开始 3D 任务
  document.getElementById('eq-continue')?.addEventListener('click', () => {
    // 确认出击前把整备背包写回四字段配置（§4.3 / 批 2b-1 两个同步点之一）。
    // syncLoadoutFromInventory 只写配置并落盘、不重建背包，用户刚整理的
    // primary/misc 槽位保持原样，beginRaid 随后按缓存背包收集风险物。
    loadoutManager.syncLoadoutFromInventory();
    window.dispatchEvent(new CustomEvent('equipment-start'));
  });

  // 携带背包的点击卸下（批 2b-2；批 2c-1 的指针状态机在同一容器上做一次委托）。
  // 事件委托绑在 #eq-inventory 上一次 —— renderInventoryGrid 会整块重建
  // .eq-inv-body，逐格绑监听会在每次重绘后失效。
  document.getElementById('eq-inventory')?.addEventListener('click', (event) => {
    // 拖拽（超 6px 阈值）结束后浏览器合成的 click 必须吞掉——否则「拖完松手
    // 落在源格上」会被误判成点击卸下，破坏 §9.4.3「拖拽期间数据不移动」。
    if (suppressClick) { suppressClick = false; return; }
    const slot = event.target.closest('.eq-inv-slot');
    if (!slot || !slot.dataset.slot) return;
    const key = slot.dataset.slot;
    if (key === 'pistol') return;                          // 锁定槽，不可卸
    if (key === 'armor') { removeInventoryCell('armor'); return; }
    const m = key.match(/^(\w+)-(\d+)$/);
    if (m) removeInventoryCell(m[1], Number(m[2]));
  });

  // 批 2c-1：指针拖拽状态机（一次委托，见下方「拖拽指针状态机」小节）。
  bindInventoryDragDelegation();

  // 批 5：「卸下全部到仓库」按钮（清空护甲/主武器/手雷/杂项，手枪位锁定）。
  // 只影响局外装备背包（+ 四字段配置同步），绝不触碰本局 RaidData。
  if (!unloadButtonBound) {
    unloadButtonBound = true;
    document.getElementById('eq-inv-unload')?.addEventListener('click', () => {
      const res = unloadBackpack();
      showToast(
        res.overflow.length > 0
          ? `已全部卸下 · ${res.overflow.length} 件缩容溢出已退回仓库`
          : res.moved.length > 0 ? `已卸下 ${res.moved.length} 件到仓库` : '背包已空'
      );
      refreshAfterEdit({ armorChanged: true });
    });
  }

  // 批 5：stash-service 制作/整理完成后的统一刷新（只绑定一次）；
  // 仓库页/制作页的写入成功后要刷新携带背包与装备卡（是否可装备/已携带）。
  if (!inventoryEditedBound) {
    inventoryEditedBound = true;
    window.addEventListener('inventory-edited', () => {
      refreshAfterEdit({ armorChanged: true });
    });
  }

  // 初始渲染
  renderInventoryGrid();
  renderWeapons();
  renderArmor();
  renderGrenades();
  updateSummary();
  updateTendencies();
}

/**
 * 显示装备面板
 */
export function showEquipment() {
  const equipmentPanel = document.getElementById('equipment');
  if (!equipmentPanel) return;
  
  equipmentPanel.classList.add('active');
  // display:none → flex 的重排要等浏览器完成布局后才能读到真实 canvas 尺寸。
  // 同步派发 resize 事件会读到旧值（0），预览相机比例会被锁死成错误值；
  // 与 equipment-preview 的 animatePreview 一样，用 requestAnimationFrame
  // 延迟一帧再通知（rAF 回调执行时本帧布局已计算完成）。
  requestAnimationFrame(() => {
    window.dispatchEvent(new CustomEvent('equipment-preview-resize'));
  });
  
  // 打开时先清理整备背包缓存里的幽灵：上一局死亡/结算可能已销毁 stash
  // 实例（§9.1）。pruneStaleStashItems 保留仍有实例的槽位、清掉幽灵，
  // 护甲槽变化时自动缩容并把溢出物退回可用源；随后写回四字段配置，
  // 让右侧摘要（读配置）与背包（读 inventory）一致。
  const overflow = pruneStaleStashItems(
    loadoutManager.getInventory(),
    loadoutManager.getStash()
  );
  loadoutManager.syncLoadoutFromInventory();
  if (overflow.length > 0) showToast(overflowToastMessage(overflow.length));
  
  // 重新渲染当前装备状态
  updateRigArmor(loadoutManager.armor);   // 幽灵清理可能使护甲落回 standard，同步 3D 预览
  renderInventoryGrid();
  renderWeapons();
  renderArmor();
  renderGrenades();
  updateSummary();
  updateTendencies();
  
  // 仓库/制作页签的数据来自 SaveStore，可能在上次离开后变化：
  // 面板重新打开时，若停在这两个页签上就顺带刷新一次。
  if (currentTab === 'warehouse') refreshWarehouse();
  if (currentTab === 'crafting') refreshCrafting();
  
  // 如果之前在查看枪械详情，重新展开
  if (selectedWeaponForDetail) {
    showWeaponDetail(selectedWeaponForDetail);
  }
}

/**
 * 隐藏装备面板
 */
export function hideEquipment() {
  const equipmentPanel = document.getElementById('equipment');
  if (!equipmentPanel) return;
  cancelInventoryDrag();   // 面板关闭 = 取消进行中的拖拽（§5.7 / §9.4.3：数据从未移动）
  equipmentPanel.classList.remove('active');
}

// ═══════════════════════════════════════════════════════════════════════
// 携带背包（#eq-inventory）真实渲染与点击放置（批 2b-2）
//
// 数据源：loadoutManager.getInventory()（批 2b-1 的局外整备背包）+
// inventory.js 的 slotLayout() / grenadeStackMax()（§2.2 容量唯一真源）。
// 点击语义（INVENTORY-SYSTEM-DESIGN.md §2.5 / §4.1-§4.4）：
//   - stash 真实实例 / 保底项点击 → autoPlace 进第一个合法空槽
//     （同种手雷优先堆叠，§2.3.2）；
//   - 护甲卡片 → 放入专属护甲槽；空槽 = 视为 standard（§2.5.2）；
//   - 换甲缩容（carrier→standard 的 misc、dualist→standard 的第二主武器、
//     grenadeBonus 变化的超量手雷）由 resizeInventory 统一重排，溢出物
//     离开背包槽、恢复为可用源，并提示「N 件物品已退回仓库」（§4.1）；
//   - 点击背包中的已占槽 = 卸下（批 2c-1 拖拽状态机接入后，点击仍是
//     反向操作的无障碍保底路径；拖拽的视觉层见下文「拖拽状态机」）。
//
// 关键约束：所有编辑直接改 inventory 对象（getInventory() 的同一引用），
// 不调用 setArmor/setGrenade/setPistol 等会置空 _inventory 缓存、重建背包
// 的 setter —— 那会覆盖玩家刚整理的 primary/misc 槽位。编辑后统一
// syncLoadoutFromInventory() 写回四字段配置（该函数只写配置、不重建背包）。
//
// 整备期间实例始终留在 profile.stash，出击时由 startRaid 原子地移走风险物
// （§4.3）——因此「退回仓库」不需要任何 SaveStore 写入：溢出物离开背包槽
// 即恢复为可用源（可用源 = 在 stash 且未放入背包的实例，按 instanceId 识别）。
// ═══════════════════════════════════════════════════════════════════════

/**
 * 缩容溢出的提示文案（设计 §4.1 固定文案）。
 * @param {number} n 溢出件数
 */
export function overflowToastMessage(n) {
  return `${n} 件物品已退回仓库`;
}

/** 轻量 toast：复用 #toast（与 hub-nav 同一挂载点）。无 DOM 时静默（node 测试）。 */
function showToast(msg, ms = 2200) {
  if (typeof document === 'undefined') return;
  const el = document.getElementById('toast');
  if (!el) return;
  el.textContent = msg;
  el.style.opacity = '1';
  clearTimeout(showToast._t);
  showToast._t = setTimeout(() => { el.style.opacity = '0'; }, ms);
}

/** 实例是否已放入整备背包（按 instanceId 识别，§4.3）。 */
function isInstancePlaced(inv, instanceId) {
  if (!instanceId) return false;
  if (inv.armor?.instanceId === instanceId) return true;
  for (const arr of [inv.primary, inv.grenade, inv.misc]) {
    if (!arr) continue;
    if (arr.some((s) => s?.instanceId === instanceId)) return true;
  }
  return false;
}

/**
 * 在 stash 中找一个「类型 + 定义 id」匹配、且尚未放入背包的真实实例。
 * 兼容两代 stash 形状（{ type, blueprintId } 与 { slotKind, defId }），
 * instanceId 以 stash 键为准。未制作 / 已携带都返回 null ——
 * 绝不为非保底装备伪造实例（§2.5.2 / §4.3）。
 */
function findAvailableStashInstance(kind, defId) {
  const inv = loadoutManager.getInventory();
  const stash = loadoutManager.getStash();
  for (const [key, item] of Object.entries(stash)) {
    if (!item || typeof item !== 'object') continue;
    const itemKind = item.slotKind ?? item.kind ?? item.type;
    const itemDefId = item.defId ?? item.blueprintId;
    if (itemKind !== kind || itemDefId !== defId) continue;
    const instanceId = item.instanceId ?? key;
    if (isInstancePlaced(inv, instanceId)) continue;
    return { ...item, instanceId };
  }
  return null;
}

/** 编辑后统一收尾：刷新背包 / 摘要 / 卡片状态（全部 DOM 守卫，node 下安全）。 */
function refreshAfterEdit({ armorChanged = false } = {}) {
  renderInventoryGrid();
  updateSummary();
  updateTendencies();
  if (armorChanged) {
    renderArmor();
    updateRigArmor(loadoutManager.armor);
  }
  renderWeapons();
  renderGrenades();
}

/**
 * 护甲卡片点击 → 放入专属护甲槽（standard = 空槽，§2.5.2）。
 * 换甲缩容由 resizeInventory 统一重排（misc 截断 / 第二主武器 / 手雷
 * 超量跨格再分配），溢出物离开背包槽、恢复为可用源（仍在 profile.stash）。
 * 已装备同一件护甲时幂等返回。
 * @returns {{ok: boolean, overflow: object[]}} overflow = 退回可用源的溢出物
 */
export function equipArmorCard(armorId) {
  const inv = loadoutManager.getInventory();

  // 已装备同一件护甲 → 幂等，不重复操作
  if (inv.armor && inv.armor.defId === armorId) return { ok: true, overflow: [] };

  let nextArmor = null;
  if (armorId !== 'standard') {
    const inst = findAvailableStashInstance('armor', armorId);
    if (!inst) {
      showToast('未制作 · 无法装备');
      return { ok: false, overflow: [] };
    }
    // 批 5：保留实例原貌（instanceId 对齐 stash 键；payload 现存原样传递）。
    nextArmor = normalizeItemInstance(inst)
      ?? ItemInstance('armor', armorId, { instanceId: inst.instanceId });
  }

  inv.armor = nextArmor;   // 旧护甲自动恢复为可用源（一直在 stash 里，无需写入）
  const overflow = resizeInventory(inv, inv.armorId);
  loadoutManager.syncLoadoutFromInventory();
  if (overflow.length > 0) showToast(overflowToastMessage(overflow.length));
  refreshAfterEdit({ armorChanged: true });
  return { ok: true, overflow };
}

/**
 * 主武器卡片点击（stash 真实实例）→ 放进第一个空主武器格。
 * 未制作 / 已携带 / 槽位全满都失败并提示，绝不伪造实例。
 * @returns {{ok: boolean, placed: number, remaining: number}}
 */
export function placePrimaryWeapon(defId) {
  const inv = loadoutManager.getInventory();
  const spec = WEAPONS[defId];
  if (!spec || spec.slot === 1) return { ok: false, placed: 0, remaining: 0 };

  const inst = findAvailableStashInstance('weapon', defId);
  if (!inst) {
    showToast('未制作 · 无法携带');
    return { ok: false, placed: 0, remaining: 0 };
  }
  // 批 5：保留 inventory 里带出的 payload（attachments / ammo / reserve，
  // reserve 可能是 Infinity —— 开局 startMission 读 payload.reserve 建
  // WeaponInstance，丢了这个「备弹 ∞」就没了）与 quantity/stackMax 原值。
  const item = normalizeItemInstance(inst)
    ?? ItemInstance('weapon', defId, { instanceId: inst.instanceId });
  const res = autoPlace(inv, item);
  if (res.placed > 0) {
    loadoutManager.syncLoadoutFromInventory();
    refreshAfterEdit();
    return { ok: true, ...res };
  }
  showToast('主武器位已满', 2200);
  return { ok: false, ...res };
}

/**
 * 手雷卡片点击（保底 flash 或 stash 真实实例）→ autoPlace：
 * 已有同类手雷优先堆叠（§2.3.2 / §6 第 2 步），堆不下开新格，
 * 无空格时提示（§4.2 拒绝文案）。flash 是保底地板，不需要 stash 实例。
 * @returns {{ok: boolean, placed: number, remaining: number}}
 */
export function placeGrenadeCard(defId) {
  const inv = loadoutManager.getInventory();
  const stackMax = grenadeStackMax(defId, inv.armorId);
  const qty = Math.min(GRENADE_TYPES[defId]?.count ?? 1, stackMax);

  let stashInst = null;
  if (defId !== 'flash') {
    stashInst = findAvailableStashInstance('grenade', defId);
    if (!stashInst) {
      showToast('未制作 · 无法携带');
      return { ok: false, placed: 0, remaining: 0 };
    }
  }

  // 批 5：非保底手雷沿用真实实例（保留 payload/instanceId），数量/上限按护甲现算。
  const item = stashInst
    ? {
        ...(normalizeItemInstance(stashInst) ?? ItemInstance('grenade', defId, { instanceId: stashInst.instanceId })),
        quantity: qty,
        stackMax,
      }
    : ItemInstance('grenade', defId, { quantity: qty, stackMax });
  const res = autoPlace(inv, item);
  if (res.placed > 0) {
    loadoutManager.syncLoadoutFromInventory();
    refreshAfterEdit();
    if (res.remaining > 0) showToast('手雷格已满 · 需要更多手雷格', 2400);
    return { ok: true, ...res };
  }
  showToast('手雷格已满 · 需要更多手雷格', 2400);
  return { ok: false, ...res };
}

/**
 * 点击背包中的已占槽 → 卸下（本批无拖拽，反向操作的唯一入口）。
 * 护甲卸下 = 空槽 = 视为 standard（§2.5.2），缩容溢出同样退回可用源并提示。
 * @param {string} group 'armor' | 'primary' | 'grenade' | 'misc'
 * @param {number} [index] 数组槽的索引（护甲槽不需要）
 * @returns {boolean} 是否有物品被卸下
 */
export function removeInventoryCell(group, index = 0) {
  const inv = loadoutManager.getInventory();

  if (group === 'armor') {
    if (!inv.armor) return false;
    inv.armor = null;
    const overflow = resizeInventory(inv, inv.armorId);
    loadoutManager.syncLoadoutFromInventory();
    if (overflow.length > 0) showToast(overflowToastMessage(overflow.length));
    refreshAfterEdit({ armorChanged: true });
    return true;
  }

  const arr = inv[group];
  if (!Array.isArray(arr) || !arr[index]) return false;
  arr[index] = null;
  loadoutManager.syncLoadoutFromInventory();
  refreshAfterEdit();
  return true;
}

/**
 * 手枪卡片点击 → 保底手枪槽（锁定槽，恒非空）。
 * 直接改 inventory.pistol，不用 setPistol（那会置空 _inventory 缓存、
 * 重建背包，丢掉用户刚放置的主武器/杂项）。
 * @returns {boolean} 是否切换成功
 */
export function selectPistol(id) {
  const spec = WEAPONS[id];
  if (!spec || spec.slot !== 1) return false;
  const inv = loadoutManager.getInventory();
  const atts = loadoutManager.attachments?.[id]
    ?? { muzzle: null, optic: null, magazine: null, grip: null };
  inv.pistol = ItemInstance('weapon', id, {
    payload: { attachments: JSON.parse(JSON.stringify(atts)) },
  });
  loadoutManager.syncLoadoutFromInventory();
  refreshAfterEdit();
  return true;
}

/**
 * 在「会重建背包缓存」的配置操作（installAttachment 等）前后保护用户已
 * 整理的背包：快照 primary/grenade/misc → 执行操作 → 恢复槽位。恢复后经
 * pruneStaleStashItems 过滤已不在 stash 的幽灵（§9.1）并处理缩容溢出，
 * 与 showEquipment 的刷新走同一条收口。
 * @returns {object[]} 缩容溢出的物品
 */
export function withPreservedInventory(fn) {
  const prev = loadoutManager.getInventory();
  const snapshot = {
    primary: prev.primary.map((s) => s),
    grenade: prev.grenade.map((s) => s),
    misc: prev.misc.map((s) => s),
  };
  fn();
  const inv = loadoutManager.getInventory();   // 可能已按配置重建（primary/misc 清空）
  inv.primary = snapshot.primary;
  inv.grenade = snapshot.grenade;
  inv.misc = snapshot.misc;
  const overflow = pruneStaleStashItems(inv, loadoutManager.getStash());
  loadoutManager.syncLoadoutFromInventory();
  if (overflow.length > 0) showToast(overflowToastMessage(overflow.length));
  renderInventoryGrid();
  return overflow;
}

/**
 * 渲染 #eq-inventory（中栏携带背包）。
 * 数据源 = loadoutManager.getInventory() + slotLayout(inv.armorId)。
 * 稳定契约（供 2c 拖拽接入）：每个槽位带 data-slot（armor / pistol /
 * primary-i / grenade-i / misc-i），数组组容器带 data-slot-group；
 * 不生成任何 id（避免 ui.test 的孤立 id 检查）。
 * @returns {string} 背包 body 的 HTML（无 DOM 时只返回、不写入，node 可测）
 */
export function renderInventoryGrid() {
  // 重绘会整块重建 .eq-inv-body（源槽失效 → 指针捕获丢失）。
  // 拖拽进行中遇到外部重绘（§6 背包打开时被外部修改）一律取消拖拽——
  // 数据从未移动，取消即无事可恢复（§9.4.3）。
  cancelInventoryDrag();
  const inv = loadoutManager.getInventory();
  const layout = slotLayout(inv.armorId);

  const cellHtml = (item, placeholder = '空') => {
    if (!item) return `<span class="eq-inv-slot-placeholder">${placeholder}</span>`;
    const qty = item.stackMax > 1
      ? `<span class="eq-inv-item-qty">×${item.quantity}/${item.stackMax}</span>`
      : '';
    return `<span class="eq-inv-item"><span class="eq-inv-item-name">${item.name || item.defId}</span>${qty}</span>`;
  };

  const rows = [];

  // 护甲专属槽：容量恒 1、可空；空 = 视为 standard（§2.5.2 占位文案）
  rows.push(`
    <div class="eq-inv-row">
      <div class="eq-inv-label">护甲</div>
      <div class="eq-inv-slot eq-inv-slot-armor${inv.armor ? ' filled' : ''}" data-slot="armor"${inv.armor ? ' title="点击卸下"' : ''}>
        ${cellHtml(inv.armor, '未装备 · 视为标准战术背心')}
      </div>
    </div>`);

  // 手枪位：恒非空保底（§1 不变量 1），不作为风险实例
  rows.push(`
    <div class="eq-inv-row">
      <div class="eq-inv-label">手枪</div>
      <div class="eq-inv-slot eq-inv-slot-pistol eq-inv-slot-locked filled" data-slot="pistol">
        <span class="eq-inv-item"><span class="eq-inv-item-name">${inv.pistol?.name || WEAPONS.pistol.name}（保底）</span></span>
      </div>
    </div>`);

  // 主武器 / 手雷 / 杂项：数量由当前护甲布局决定（§2.2）
  const groupRow = (label, group, count, itemAt) => `
    <div class="eq-inv-row">
      <div class="eq-inv-label">${label}</div>
      <div class="eq-inv-slot-group" data-slot-group="${group}">
        ${Array.from({ length: count }, (_, i) => {
          const item = itemAt(i);
          return `<div class="eq-inv-slot${item ? ' filled' : ''}" data-slot="${group}-${i}"${item ? ' title="点击卸下"' : ''}>${cellHtml(item)}</div>`;
        }).join('')}
      </div>
    </div>`;

  rows.push(groupRow('主武器', 'primary', layout.primary, (i) => inv.primary[i]));
  rows.push(groupRow('手雷', 'grenade', layout.grenade, (i) => inv.grenade[i]));
  rows.push(groupRow('杂项', 'misc', layout.misc, (i) => inv.misc[i]));

  const html = rows.join('');

  if (typeof document !== 'undefined') {
    const panel = document.getElementById('eq-inventory');
    if (panel) {
      const body = panel.querySelector('.eq-inv-body');
      if (body) body.innerHTML = html;
      const sub = panel.querySelector('.eq-inv-head .sub');
      if (sub) {
        const total = layout.primary + layout.grenade + layout.misc;
        sub.textContent = `${inv.armorId.toUpperCase()} · ${total} SLOTS`;
      }
    }
  }
  return html;
}

// ═══════════════════════════════════════════════════════════════════════════
// 批 2c-1：局外背包拖拽——Pointer Events 状态机（纯视觉层 · 数据不移动 §9.4.3）
//
// 硬约束（INVENTORY-SYSTEM-DESIGN.md）：
//   - 拖拽期间物品必须留在原格子里：源槽只做视觉「提起」（.dragging 半透明 +
//     跟随光标的 .inv-drag-ghost）；绝不 splice inventory、不写 stash、不调
//     syncLoadoutFromInventory()、不创建/删除任何物品实例（§9.4.3 比 §5.7 更强）。
//     因此「取消 / 拖出面板外松手」= 什么都不做，结构上零丢货。
//   - 6px 移动阈值区分点击与拖拽（§4.4「点击与拖拽必须都保留」）：阈值内松手 →
//     浏览器正常合成 click → 交给上方批 2b-2 的点击委托（只触发一次）；拖拽结束
//     后由 suppressClick 一次性吞掉合成 click，防「拖完落在源格」被误判为卸下。
//   - 目标识别只用 canAccept/tryStack 只读纯函数做预览（四色反馈 + 同种已满的
//     空格候选），本批只记录/预览，不提交目标槽数据（2c-2 才真正移动）。
//   - 委托一次绑定在 #eq-inventory（renderInventoryGrid 逐格重建槽位也不失效）；
//     Escape / window blur / 面板关闭（hideEquipment）都是同一取消路径。
// ═══════════════════════════════════════════════════════════════════════════

/** 区分点击与拖拽的移动阈值（px）。 */
const DRAG_THRESHOLD_PX = 6;

/** 目标预览类集合（§4.2 四种反馈 + 同种已满的空格候选）。 */
const DROP_PREVIEW_CLASSES = ['drop-ok', 'drop-swap', 'drop-stack', 'drop-bad', 'drop-candidate'];

/** 当前拖拽会话（模块级单例，同一时刻只能有一个拖拽）。*/
let drag = null;
/** 拖拽结束后浏览器合成的 click 需要吞掉（一次性标记）。 */
let suppressClick = false;
/** #eq-inventory 面板引用（委托与 pointer capture 的目标容器）。 */
let dragPanel = null;
/** 委托已绑定标记：initEquipmentUI 只允许执行一次绑定（要求：不重复注册）。 */
let dragDelegationBound = false;
/** 「卸下全部」按钮只绑一次（initEquipmentUI 多次调用不累计监听）。 */
let unloadButtonBound = false;
/** 「inventory-edited」全局监听只绑一次（stash-service 写入后的刷新收口）。 */
let inventoryEditedBound = false;

/** data-slot → 当前背包实例（只读）。pistol / 未知 key → null。 */
function itemAtSlot(key) {
  const inv = loadoutManager.getInventory();
  if (key === 'armor') return inv.armor;
  const m = /^(\w+)-(\d+)$/.exec(key);
  if (!m) return null;
  return (inv[m[1]] && inv[m[1]][Number(m[2])]) || null;
}

/** 该槽能否作为拖拽源：锁定槽（手枪）/ 空格不行。 */
function isDraggableSlot(slot, key) {
  if (key === 'pistol' || slot.classList.contains('eq-inv-slot-locked')) return false;
  if (!slot.classList.contains('filled')) return false;
  return itemAtSlot(key) !== null;
}

/**
 * 目标预览判定（§4.2，只读纯函数）。返回 { kind, el?, n? }：
 *   drop-ok       类型匹配 + 目标空
 *   drop-swap     类型匹配 + 目标已占（不同种 / 不可堆叠）→ 2c-2 走交换
 *   drop-stack    同类且目标格有余量 → 2c-2 走堆叠（n = 可吸收数量）
 *   drop-bad      类型不匹配 / 锁定槽
 *   drop-candidate 同种但已满 → 同组第一个空格做候选（§4.2 最后一行）
 */
function classifyDrop(targetSlot, targetKey, item) {
  if (targetSlot.classList.contains('eq-inv-slot-locked')) return { kind: 'drop-bad' };
  const m = /^(\w+)-(\d+)$/.exec(targetKey);
  const group = m ? m[1] : targetKey;
  if (!canAccept(group, item).ok) return { kind: 'drop-bad' };
  const targetItem = itemAtSlot(targetKey);
  if (targetItem) {
    const stack = tryStack(targetItem, item);
    if (stack > 0) return { kind: 'drop-stack', n: stack };
    if (targetItem.defId === item.defId) {
      // 同种但已满：找同组第一个空格，预览为候选（无空格则按普通交换预览）。
      const arr = loadoutManager.getInventory()[group];
      const emptyIndex = Array.isArray(arr) ? arr.findIndex((s) => s === null) : -1;
      const el = emptyIndex >= 0
        ? dragPanel?.querySelector?.(`[data-slot="${group}-${emptyIndex}"]`) ?? null
        : null;
      if (el) return { kind: 'drop-candidate', el };
    }
    return { kind: 'drop-swap' };
  }
  return { kind: 'drop-ok' };
}

/** 清掉上一次目标槽的 drop-* 预览类与堆叠角标（只改样式）。 */
function clearDropPreview(session = drag) {
  if (!session?.previewEl) return;
  for (const c of DROP_PREVIEW_CLASSES) session.previewEl.classList.remove(c);
  session.previewEl.style.removeProperty?.('--stack-n');
  session.previewEl = null;
}

/** 应用目标预览（只改样式类，不移动任何数据）。 */
function setDropPreview(el, cls, stackN) {
  if (!drag) return;
  drag.previewEl = el;
  el.classList.add(cls);
  if (stackN != null) el.style.setProperty?.('--stack-n', `+${stackN}`);
}

/** 依据指针位置的 elementFromPoint 更新目标预览。 */
function updateDropPreview(x, y) {
  if (!drag || typeof document.elementFromPoint !== 'function') return;
  clearDropPreview();
  const hit = document.elementFromPoint(x, y);
  const target = hit && typeof hit.closest === 'function' ? hit.closest('.eq-inv-slot') : null;
  if (!target || target === drag.sourceEl || drag.sourceEl.contains?.(target)) {
    drag.targetEl = null;
    drag.commitKey = null;
    return;
  }
  const verdict = classifyDrop(target, target.dataset.slot || '', drag.sourceItem);
  drag.targetEl = target;                          // 提交时优先用候选格
  if (verdict.kind === 'drop-candidate' && verdict.el) {
    setDropPreview(verdict.el, 'drop-candidate');
    drag.commitKey = verdict.el.dataset?.slot ?? null;
  } else {
    setDropPreview(target, verdict.kind, verdict.n);
    drag.commitKey = target.dataset.slot ?? null;
  }
}

/** 创建纯视觉拖拽影子（复制源槽的 DOM 内容）。无 DOM / body 时返回 null（node 安全）。 */
function createGhost(sourceEl) {
  if (!document.body || typeof document.createElement !== 'function') return null;
  const ghost = document.createElement('div');
  ghost.className = 'inv-drag-ghost';
  ghost.innerHTML = sourceEl.innerHTML;           // 复制的是视觉层，不是物品对象
  document.body.appendChild(ghost);
  return ghost;
}

/** 影子跟随指针（client 坐标；用 translate(-50%,-50%) 居中于指针）。 */
function moveGhost(ghost, x, y) {
  if (!ghost) return;
  ghost.style.left = `${x}px`;
  ghost.style.top = `${y}px`;
}

/**
 * 结束/取消拖拽：清理状态与视觉层。数据从未移动，无需恢复任何东西（§9.4.3）。
 * @param {boolean} markClick 是否吞掉紧随其后的合成 click（仅正常 pointerup 需要）
 */
function endDrag(markClick = false) {
  const d = drag;
  if (!d) return;
  drag = null;                                    // 先清状态：lostpointercapture 重入守卫
  clearDropPreview(d);
  d.sourceEl?.classList?.remove('dragging');
  document.body?.classList?.remove('eq-dragging');
  d.ghostEl?.remove?.();
  if (d.captureEl) {
    try { d.captureEl.releasePointerCapture?.(d.pointerId); } catch { /* 捕获已失效 */ }
  }
  if (markClick) suppressClick = true;
}

/** 取消进行中的拖拽（面板关闭 / Escape / blur / 重绘共用）。 */
export function cancelInventoryDrag() {
  if (drag) {
    suppressClick = false;
    endDrag(false);
  }
}

/**
 * 在 #eq-inventory 上绑定一次指针拖拽委托（initEquipmentUI 调用一次；
 * bindInventoryDragDelegation 内部有防重复标记，多次调用/重绘都不累计监听）。
 */
function bindInventoryDragDelegation() {
  if (dragDelegationBound) return;
  const panel = document.getElementById('eq-inventory');
  if (!panel) return;
  dragDelegationBound = true;
  dragPanel = panel;
  panel.addEventListener('pointerdown', onDragPointerDown);
  panel.addEventListener('pointermove', onDragPointerMove);
  panel.addEventListener('pointerup', onDragPointerUp);
  panel.addEventListener('pointercancel', onDragPointerCancel);
  panel.addEventListener('lostpointercapture', onLostPointerCapture);
  document.addEventListener('keydown', onDragKeyDown);   // Escape 取消拖拽
  window.addEventListener('blur', onDragBlur);            // 窗口失焦取消拖拽
}

function onDragPointerDown(e) {
  suppressClick = false;                        // 新手势：清掉上一次拖拽的吞点击标记
  if (drag || e.isPrimary === false || e.button !== 0) return;
  const slot = e.target?.closest?.('.eq-inv-slot');
  if (!slot) return;
  const key = slot.dataset.slot;
  if (!key || !isDraggableSlot(slot, key)) return;
  drag = {
    pointerId: e.pointerId,
    sourceEl: slot,
    sourceKey: key,
    sourceItem: itemAtSlot(key),                // 只读引用——拖拽期间数据绝不移动（§9.4.3）
    startX: e.clientX,
    startY: e.clientY,
    started: false,                             // 超过 DRAG_THRESHOLD_PX 才置 true
    targetEl: null,                             // 当前悬停目标（预览/记录用）
    commitKey: null,                            // 提交目标槽（候选空格时覆盖 targetEl）
    previewEl: null,                            // 当前带 drop-* 预览的槽
    ghostEl: null,
    captureEl: dragPanel,
  };
}

function onDragPointerMove(e) {
  if (!drag || drag.pointerId !== e.pointerId) return;
  if (!drag.started) {
    const dx = e.clientX - drag.startX;
    const dy = e.clientY - drag.startY;
    if (Math.hypot(dx, dy) < DRAG_THRESHOLD_PX) return;   // 阈值内 = 点击，交给批 2b-2
    // 越过阈值：正式进入拖拽（视觉提起 + 影子 + 指针捕获）
    drag.started = true;
    drag.sourceEl.classList.add('dragging');
    document.body?.classList?.add('eq-dragging');          // 容器状态类（光标 grabbing）
    drag.ghostEl = createGhost(drag.sourceEl);
    moveGhost(drag.ghostEl, e.clientX, e.clientY);
    try { drag.captureEl?.setPointerCapture?.(e.pointerId); } catch { /* 指针已失效 */ }
    e.preventDefault?.();                          // 防拖拽过程触发文本选择
    return;
  }
  moveGhost(drag.ghostEl, e.clientX, e.clientY);
  updateDropPreview(e.clientX, e.clientY);
}

function onDragPointerUp(e) {
  if (!drag || drag.pointerId !== e.pointerId) return;
  const started = drag.started;
  const session = { ...drag };                     // endDrag 会清 drag，先拷贝会话
  endDrag(started);
  if (!started) return;                            // 阈值内 = 点击，交给批 2b-2
  // 批 5（2c-2 完成）：在合法目标上松手 → 原子提交（移动/交换/堆叠）；
  // 无目标 / 非法目标 → 数据从未移动，无事可提交。
  const result = commitDragTo(session);
  if (!result.ok && result.reason) showToast(result.reason);
}

function onDragPointerCancel(e) {
  if (!drag || drag.pointerId !== e.pointerId) return;
  endDrag(false);                    // 取消：数据从未移动，无事可恢复
}

function onLostPointerCapture(e) {
  if (!drag || drag.pointerId !== e.pointerId) return;
  endDrag(false);                    // 源槽被重绘移除 / 系统取消捕获 → 一并取消
}

function onDragKeyDown(e) {
  if (drag && (e.key === 'Escape' || e.code === 'Escape')) endDrag(false);
}

function onDragBlur() {
  if (drag) endDrag(false);
}

// ═══════════════════════════════════════════════════════════════════════════
// 批 5（2c-2 完成）：拖拽数据提交 —— 原子、单实例、回滚友好
//
// 提交语义（INVENTORY-SYSTEM-DESIGN.md §4.2「同种已满 → 空格候选」/§4.1）：
//   - 空目标 + canAccept 通过 → 移动（对象引用搬运，不复制实例）；
//   - 同种可堆叠（tryStack > 0）→ 合并数量，源格清空（不新增 instanceId）；
//   - 同种已满 → 预览已把候选空格记录为 commitKey → 落到候选空格；
//   - 已占异种（或不可堆叠）→ 交换（双向 canAccept 校验，任一拒绝即取消）；
//   - drop-bad / 无目标 / 同一格 → 不改变任何数据（拖拽本就是纯视觉层，
//     §9.4.3：取消即无事可恢复）。
// 提交后统一 syncLoadoutFromInventory()（写回四字段配置）+ 通知。
// ═══════════════════════════════════════════════════════════════════════════

/** 'armor' | 'primary-1' → { group, index }；非法返回 null。 */
function parseSlotKey(key) {
  if (!key) return null;
  if (key === 'armor') return { group: 'armor', index: 0 };
  const m = /^(\w+)-(\d+)$/.exec(key);
  if (!m) return null;
  return { group: m[1], index: Number(m[2]) };
}

/**
 * 提交一次拖拽结果（pointerup / node 测试均可直接调用）。
 * @param {{sourceKey: string, commitKey?: string|null}} session
 * @returns {{ok: boolean, action?: 'move'|'swap'|'stack', n?: number, reason?: string}}
 */
export function commitDragTo(session) {
  const inv = loadoutManager.getInventory();
  const src = parseSlotKey(session?.sourceKey);
  if (!src) return { ok: false, reason: '未知源槽' };
  const tgt = parseSlotKey(session?.commitKey ?? null);
  if (!tgt) return { ok: false, reason: null };                     // 无目标 = 取消
  if (src.group === tgt.group && src.index === tgt.index) return { ok: false, reason: null };

  const get = (p) => (p.group === 'armor' ? inv.armor : inv[p.group]?.[p.index] ?? null);
  const set = (p, v) => {
    if (p.group === 'armor') inv.armor = v;
    else if (Array.isArray(inv[p.group])) inv[p.group][p.index] = v;
  };

  const moving = get(src);
  if (!moving) return { ok: false, reason: null };
  if (tgt.group === 'pistol') return { ok: false, reason: '手枪位为保底锁定槽' };
  const accepted = canAccept(tgt.group, moving);
  if (!accepted.ok) return { ok: false, reason: accepted.reason };

  const targetItem = get(tgt);
  if (targetItem && targetItem !== moving) {
    const stack = tryStack(targetItem, moving);
    if (stack > 0) {
      targetItem.quantity = (targetItem.quantity ?? 1) + stack;
      moving.quantity = Math.max(0, (moving.quantity ?? 1) - stack);
      if (moving.quantity <= 0) set(src, null);
      afterDragCommit();
      return { ok: true, action: 'stack', n: stack };
    }
    // 已占异种 / 不可堆叠 → 交换；双向类型校验，任一拒绝保持原状。
    const back = canAccept(src.group, targetItem);
    if (!back.ok) return { ok: false, reason: back.reason };
    set(src, targetItem);
    set(tgt, moving);
    afterDragCommit();
    return { ok: true, action: 'swap' };
  }

  set(tgt, moving);
  set(src, null);
  afterDragCommit();
  return { ok: true, action: 'move' };
}

/** 提交后的统一收口：写回四字段配置 + 刷新背包/摘要/卡片 + 通知。 */
function afterDragCommit() {
  loadoutManager.syncLoadoutFromInventory();
  refreshAfterEdit();
  notifyLoadoutChanged();
}

/**
 * 切换标签
 */
function switchTab(tabName) {
  currentTab = tabName;
  
  // 更新标签激活状态
  document.querySelectorAll('.eq-tab').forEach(tab => {
    if (tab.dataset.tab === tabName) {
      tab.classList.add('active');
    } else {
      tab.classList.remove('active');
    }
  });
  
  // 显示/隐藏对应内容
  document.querySelectorAll('.eq-tab-content').forEach(content => {
    content.style.display = 'none';
  });
  
  const targetContent = document.getElementById(`eq-${tabName}-content`);
  if (targetContent) {
    targetContent.style.display = 'block';
  }
  
  // 仓库/制作页签：切过去时从 SaveStore 重新拉取数据。
  // 渲染逻辑在 hub-nav.js，这里只负责触发时机。
  if (tabName === 'warehouse') {
    refreshWarehouse();
  }
  if (tabName === 'crafting') {
    refreshCrafting();
  }
  
  // 如果切换到枪械标签，且之前在查看详情，保持详情展开
  if (tabName === 'weapon' && selectedWeaponForDetail) {
    showWeaponDetail(selectedWeaponForDetail);
  }
  
  // 任何页签切换都同步刷新中栏携带背包（点击/刷新同步，批 2b-2 要求 5）。
  renderInventoryGrid();
}

/**
 * 渲染枪械列表（保底手枪 + stash 已制作的主武器实例）
 */
function renderWeapons() {
  const grid = document.getElementById('eq-weapon-grid');
  if (!grid) return;
  
  grid.innerHTML = '';

  const modifiers = loadoutManager.getPlayerModifiers();
  const maxPrimarySlots = Math.max(1, 1 + (modifiers.weaponSlots ?? 0));
  const hint = document.createElement('div');
  hint.className = 'eq-weapon-hint-global';
  hint.innerHTML = maxPrimarySlots >= 2
    ? `<strong>当前护甲支持双主武器</strong> · ${loadoutManager.armor}`
    : `<span>当前护甲仅支持单主武器</span> · 切换到双槽护甲解锁槽 2`;
  grid.appendChild(hint);

  // 保底手枪始终显示；主武器卡片来自仓库真实实例。
  const pistols = [
    { id: 'pistol', spec: WEAPONS.pistol },
    { id: 'pistolFast', spec: WEAPONS.pistolFast },
  ];
  
  pistols.forEach(({ id, spec }) => {
    const card = document.createElement('div');
    card.className = 'eq-weapon-card';
    if (loadoutManager.pistol === id) {
      card.classList.add('selected');
    }
    
    card.innerHTML = `
      <div class="eq-card-topline"><span class="eq-code">${spec.short}</span><span class="eq-state">${loadoutManager.pistol === id ? '已装备' : '可用'}</span></div>
      <div class="eq-weapon-art">${gunGlyph(id, spec.color)}</div>
      <h4>${spec.name}</h4>
      <div class="eq-weapon-stats">
        <div class="eq-weapon-stat"><span class="k">伤害</span><span class="v">${spec.damage}</span></div>
        <div class="eq-weapon-stat"><span class="k">射速</span><span class="v">${spec.rof}/s</span></div>
        <div class="eq-weapon-stat"><span class="k">噪音</span><span class="v">${spec.noise}</span></div>
        <div class="eq-weapon-stat"><span class="k">精度</span><span class="v">${spec.spread.toFixed(1)}°</span></div>
      </div>
      <div class="eq-weapon-hint">点击查看枪械部件</div>
    `;
    
    card.addEventListener('click', () => {
      // 保底手枪：直接改背包手枪槽（selectPistol 不用 setPistol，
      // 避免重建背包缓存、丢掉已放置的主武器/杂项）
      selectPistol(id);
      selectedWeaponForDetail = id;
      showWeaponDetail(id);
      updateSummary();
      updateTendencies();
      notifyLoadoutChanged();
    });
    
    grid.appendChild(card);
  });

  // 主武器卡片：stash 已制作实例（slot !== 1）。点击 = 放进第一个空主武器格
  // （§4.4：卡片从「点击=装备」变成「点击=装进背包」）。
  const stash = loadoutManager.getStash();
  const placedIds = new Set(
    loadoutManager.getInventory().primary.filter(Boolean).map((s) => s.instanceId)
  );
  const seen = new Set();
  const primaryEntries = [];
  for (const [key, item] of Object.entries(stash)) {
    if (!item || typeof item !== 'object') continue;
    const kind = item.slotKind ?? item.kind ?? item.type;
    const defId = item.defId ?? item.blueprintId;
    const spec = WEAPONS[defId];
    if (kind !== 'weapon' || !spec || spec.slot === 1 || seen.has(defId)) continue;
    seen.add(defId);
    primaryEntries.push({ id: defId, spec, instanceId: item.instanceId ?? key });
  }

  primaryEntries.forEach(({ id, spec, instanceId }) => {
    const placed = placedIds.has(instanceId);
    const card = document.createElement('div');
    card.className = 'eq-weapon-card';
    if (placed) card.classList.add('selected');

    card.innerHTML = `
      <div class="eq-card-topline"><span class="eq-code">${spec.short}</span><span class="eq-state">${placed ? '已携带' : '可用'}</span></div>
      <div class="eq-weapon-art">${gunGlyph(id, spec.color)}</div>
      <h4>${spec.name}</h4>
      <div class="eq-weapon-stats">
        <div class="eq-weapon-stat"><span class="k">伤害</span><span class="v">${spec.damage}</span></div>
        <div class="eq-weapon-stat"><span class="k">射速</span><span class="v">${spec.rof}/s</span></div>
        <div class="eq-weapon-stat"><span class="k">噪音</span><span class="v">${spec.noise}</span></div>
        <div class="eq-weapon-stat"><span class="k">精度</span><span class="v">${spec.spread.toFixed(1)}°</span></div>
      </div>
      <div class="eq-weapon-hint">点击装入主武器格</div>
    `;

    card.addEventListener('click', () => {
      placePrimaryWeapon(id);
      notifyLoadoutChanged();
    });

    grid.appendChild(card);
  });
}

/**
 * 显示枪械详情（部件配置）
 */
function showWeaponDetail(weaponId) {
  const grid = document.getElementById('eq-weapon-grid');
  const detail = document.getElementById('eq-weapon-detail');
  if (!grid || !detail) return;
  
  grid.style.display = 'none';
  detail.style.display = 'block';
  
  const spec = WEAPONS[weaponId];
  const attachments = loadoutManager.getPistolAttachments();
  const slots = WEAPON_SLOTS[weaponId] || [];
  
  detail.innerHTML = `
    <div class="eq-weapon-detail-head">
      <h4>${spec.name} · 部件配置</h4>
      <div class="eq-weapon-detail-back">← 返回枪械选择</div>
    </div>
    
    <div class="eq-slots">
      ${slots.map((slotType, idx) => {
        if (!slotType) return '';
        const slotLabel = {
          muzzle: '枪口',
          optic: '瞄具',
          magazine: '弹匣',
          grip: '握把',
        }[slotType] || slotType;
        
        const currentAttachment = attachments[slotType];
        const currentName = currentAttachment ? ATTACHMENTS[currentAttachment]?.name : '未安装';
        const isEmpty = !currentAttachment;
        
        return `
          <div class="eq-slot">
            <div class="eq-slot-label">${slotLabel}</div>
            <div class="eq-slot-current ${isEmpty ? 'empty' : ''}">${currentName}</div>
          </div>
        `;
      }).join('')}
    </div>
    
    <div class="eq-attachments">
      <h5>可用部件</h5>
      <div id="eq-attachments-list"></div>
    </div>
  `;
  
  // 返回按钮
  detail.querySelector('.eq-weapon-detail-back')?.addEventListener('click', () => {
    selectedWeaponForDetail = null;
    detail.style.display = 'none';
    grid.style.display = 'grid';
    renderWeapons();
  });
  
  // 渲染每个槽位的可用部件
  renderAttachmentsList(weaponId);
}

/**
 * 渲染可用部件列表
 */
function renderAttachmentsList(weaponId) {
  const list = document.getElementById('eq-attachments-list');
  if (!list) return;
  
  list.innerHTML = '';
  
  const slots = WEAPON_SLOTS[weaponId] || [];
  const currentAttachments = loadoutManager.getPistolAttachments();
  
  slots.forEach(slotType => {
    if (!slotType) return;
    
    const available = loadoutManager.getAvailableAttachments(slotType);
    
    available.forEach(att => {
      const isInstalled = currentAttachments[slotType] === att.id;
      
      const div = document.createElement('div');
      div.className = 'eq-attachment';
      
      div.innerHTML = `
        <div class="eq-attachment-info">
          <h6>${att.name}</h6>
          <p>${att.desc}</p>
        </div>
        <button class="eq-attachment-btn ${isInstalled ? 'installed' : ''}">${isInstalled ? '已安装' : '安装'}</button>
      `;
      
      const btn = div.querySelector('.eq-attachment-btn');
      if (!isInstalled) {
        btn.addEventListener('click', () => {
          // installAttachment 会置空背包缓存 → 重建时清掉已放置的
          // primary/misc 槽位。用 withPreservedInventory 包一层，
          // 装部件的同时保住用户刚整理的背包。
          withPreservedInventory(() => loadoutManager.installAttachment(slotType, att.id));
          showWeaponDetail(weaponId);
          updateSummary();
          updateTendencies();
          notifyLoadoutChanged();
        });
      }
      
      list.appendChild(div);
    });
  });
}

/**
 * 渲染防护装备
 */
function renderArmor() {
  const grid = document.getElementById('eq-armor-grid');
  if (!grid) return;
  
  grid.innerHTML = '';
  
  Object.values(ARMOR_TYPES).forEach(armor => {
    if (!UnlockChecker.isEquippable('armor', armor.id)) return;
    
    const card = document.createElement('div');
    card.className = 'eq-armor-card';
    if (loadoutManager.armor === armor.id) {
      card.classList.add('selected');
    }
    
    const effects = armor.effects;
    
    const weaponSlotBadge = (effects.weaponSlots ?? 0) > 0
      ? '<div class="eq-badge eq-weapon-slot-badge">双主武器</div>' : '';
    card.innerHTML = `
      ${weaponSlotBadge}
      <div class="eq-armor-figure"><span class="armor-head"></span><span class="armor-body"></span><span class="armor-shoulder left"></span><span class="armor-shoulder right"></span></div>
      <div class="eq-card-topline"><span class="eq-code">${armor.id.toUpperCase()}</span><span class="eq-state">${loadoutManager.armor === armor.id ? '已装备' : '可用'}</span></div>
      <h4>${armor.name}</h4>
      <div class="en">${armor.nameEn}</div>
      <p>${armor.desc}</p>
      <div class="eq-armor-effects">
        <div class="eq-armor-effect"><span class="k">护甲</span><span class="v">${effects.armorMax}</span></div>
        <div class="eq-armor-effect"><span class="k">速度</span><span class="v">${(effects.moveSpeedMult * 100).toFixed(0)}%</span></div>
        <div class="eq-armor-effect"><span class="k">噪音</span><span class="v">${(effects.noiseRadiusMult * 100).toFixed(0)}%</span></div>
        <div class="eq-armor-effect"><span class="k">探测</span><span class="v">${(effects.detectionMult * 100).toFixed(0)}%</span></div>
        ${(effects.weaponSlots ?? 0) > 0 ? `<div class="eq-armor-effect"><span class="k">武器槽</span><span class="v">+${effects.weaponSlots}</span></div>` : ''}
        ${effects.carryCapBonus ? `<div class="eq-armor-effect"><span class="k">携带</span><span class="v">+${effects.carryCapBonus}</span></div>` : ''}
        ${effects.litExposureMul != null && effects.litExposureMul !== 1 ? `<div class="eq-armor-effect"><span class="k">光照</span><span class="v">${(effects.litExposureMul * 100).toFixed(0)}%</span></div>` : ''}
        ${effects.grenadeBonus ? `<div class="eq-armor-effect"><span class="k">手雷</span><span class="v">${effects.grenadeBonus > 0 ? '+' : ''}${effects.grenadeBonus}</span></div>` : ''}
      </div>
    `;
    
    card.addEventListener('click', () => {
      // 点击 = 把该护甲实例放进专属护甲槽（standard = 空槽语义）。
      // equipArmorCard 内部处理换甲缩容与溢出退回，不用 setArmor。
      equipArmorCard(armor.id);
      notifyLoadoutChanged();
    });
    
    grid.appendChild(card);
  });
}

/**
 * 渲染手榴弹
 */
function renderGrenades() {
  const grid = document.getElementById('eq-grenade-grid');
  if (!grid) return;
  
  grid.innerHTML = '';
  
  Object.values(GRENADE_TYPES).forEach(grenade => {
    if (!UnlockChecker.isEquippable('grenade', grenade.id)) return;
    
    const card = document.createElement('div');
    card.className = 'eq-grenade-card';
    card.style.borderColor = grenade.color;
    
    if (loadoutManager.grenade === grenade.id) {
      card.classList.add('selected');
    }
    
    card.innerHTML = `
      <div class="eq-grenade-art">${grenadeGlyph(grenade.id)}</div>
      <div class="eq-card-topline"><span class="eq-code">${grenade.id === 'he' ? 'FRAG' : 'FLASH'}</span><span class="eq-state">${loadoutManager.grenade === grenade.id ? '已装备' : '可用'}</span></div>
      <h4 style="color:${grenade.color}">${grenade.name}</h4>
      <div class="en">${grenade.nameEn}</div>
      <div class="count" style="color:${grenade.color}">×${grenade.count}</div>
      <p style="color:${grenade.color}">${grenade.desc}</p>
    `;
    
    card.addEventListener('click', () => {
      // 点击 = 放进第一个合法手雷格（同种手雷优先堆叠）。
      // placeGrenadeCard 内部处理堆叠/开新格/拒绝提示，不用 setGrenade。
      placeGrenadeCard(grenade.id);
      notifyLoadoutChanged();
    });
    
    grid.appendChild(card);
  });
}

/**
 * 更新装备摘要
 */
function updateSummary() {
  const summary = loadoutManager.getSummary();
  
  // 主武器与槽位能力提示
  const playerMods = loadoutManager.getPlayerModifiers();
  const maxPrimarySlots = Math.max(1, 1 + (playerMods.weaponSlots ?? 0));
  const weaponSection = document.querySelector?.('.eq-summary-section[data-summary-tab="weapon"]');
  const weaponHeading = weaponSection?.querySelector?.('h4 span');
  if (weaponHeading) weaponHeading.textContent = `WEAPONS / 0${maxPrimarySlots + 1}`;
  let primaryHint = document.getElementById('eq-sum-primary-hint');
  if (!primaryHint && weaponSection) {
    primaryHint = document.createElement('div');
    primaryHint.id = 'eq-sum-primary-hint';
    primaryHint.className = 'eq-summary-slot-hint';
    weaponSection.insertBefore(primaryHint, weaponSection.querySelector('.eq-summary-item'));
  }
  if (primaryHint) {
    primaryHint.textContent = maxPrimarySlots >= 2
      ? '当前护甲支持双主武器 · 槽 1 / 槽 2 任务中拾取'
      : '当前护甲仅支持单主武器 · 槽 1 任务中拾取';
  }

  // 主武器
  const weaponEl = document.getElementById('eq-sum-weapon');
  const attachmentsEl = document.getElementById('eq-sum-attachments');
  if (weaponEl && attachmentsEl) {
    const spec = WEAPONS[summary.pistol.id];
    weaponEl.textContent = spec?.name || summary.pistol.id;
    const weaponArt = document.getElementById('eq-sum-weapon-art');
    if (weaponArt && spec) weaponArt.innerHTML = gunGlyph(spec.id, spec.color);
    
    const attList = Object.entries(summary.pistol.attachments)
      .filter(([_, att]) => att)
      .map(([slot, att]) => att.name);
    
    if (attList.length > 0) {
      attachmentsEl.textContent = '部件：' + attList.join(' · ');
    } else {
      attachmentsEl.textContent = '无部件';
    }
  }
  
  // 防护装备
  const armorEl = document.getElementById('eq-sum-armor');
  const armorEffectsEl = document.getElementById('eq-sum-armor-effects');
  if (armorEl && armorEffectsEl && summary.armor) {
    armorEl.textContent = summary.armor.name;
    const fx = summary.armor.effects;
    const extras = [];
    if (fx.carryCapBonus) extras.push(`携带 +${fx.carryCapBonus}`);
    if (fx.litExposureMul != null && fx.litExposureMul !== 1) extras.push(`光照 ${(fx.litExposureMul * 100).toFixed(0)}%`);
    if (fx.grenadeBonus) extras.push(`手雷 ${fx.grenadeBonus > 0 ? '+' : ''}${fx.grenadeBonus}`);
    armorEffectsEl.textContent = extras.length
      ? `${summary.armor.desc} · 护甲 ${fx.armorMax} · ${extras.join(' · ')}`
      : `${summary.armor.desc} · 护甲 ${fx.armorMax}`;
  }
  
  // 手榴弹
  const grenadeEl = document.getElementById('eq-sum-grenade');
  if (grenadeEl && summary.grenade) {
    grenadeEl.textContent = `${summary.grenade.name} ×${summary.grenade.count}`;
    const grenadeArt = document.querySelector('.eq-summary-section[data-summary-tab="grenade"] .grenade-art');
    if (grenadeArt) grenadeArt.innerHTML = grenadeGlyph(summary.grenade.id);
  }
  
  // 更新左侧角色属性
  const hpEl = document.getElementById('eq-hp');
  const armorValEl = document.getElementById('eq-armor');
  if (hpEl) hpEl.textContent = playerMods.hpMax;
  if (armorValEl) armorValEl.textContent = playerMods.armorMax;
}

/**
 * 更新属性倾向条
 */
function updateTendencies() {
  const tendencies = loadoutManager.calculateTendencies();
  
  const update = (id, value) => {
    const fill = document.getElementById(id);
    const val = document.getElementById(id + '-val');
    if (fill) fill.style.width = `${value}%`;
    if (val) val.textContent = value;
  };
  
  update('eq-tend-stealth', tendencies.stealth);
  update('eq-tend-defense', tendencies.defense);
  update('eq-tend-mobility', tendencies.mobility);
  update('eq-tend-noise', tendencies.noise);
}

document.addEventListener('click', (event) => {
  const section = event.target.closest('.eq-summary-section[data-summary-tab]');
  if (section && isEquipmentActive()) switchTab(section.dataset.summaryTab);
});

function isEquipmentActive() {
  return document.getElementById('equipment')?.classList.contains('active');
}
