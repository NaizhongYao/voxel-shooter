/**
 * hub-nav.js - 中枢导航与仓库/制作数据渲染
 *
 * 职责：
 * 1. 顶部中枢导航标签切换（现仅「任务」一个入口）
 * 2. 从 SaveStore / stash-service 读取数据并渲染仓库内容
 *    （挂载于装备整备「仓库」页签：材料/武器/护甲/手雷/配件/蓝图 +
 *    stash used/capacity + 待整理区 overflow）
 * 3. 渲染制作配方（真实配方注册表 CRAFTING_RECIPES，原子 craft 提交）
 * 4. 导出 refreshWarehouse / refreshCrafting 供 equipment.js 切页签时调用
 *
 * 数据边界：不做任何持久化写入 —— 制作走 stash-service.craft()（原子，
 * 材料扣除+实例创建+入仓全部成功才落盘，仓库满产物进 stashOverflow）。
 */

import { getSaveStore } from '../systems/save-store.js';
import { WEAPONS } from '../systems/weapons.js';
import { ARMOR_TYPES, GRENADE_TYPES, ATTACHMENTS } from '../systems/loadout-config.js';
import { LOOT_ITEMS } from '../data/loot-tables.js';
import { CRAFTING_RECIPES } from '../data/crafting-recipes.js';
import {
  getStashView,
  countStashInstances,
  craft,
  organizeOverflow,
  getRecipeState,
  stashKind,
  stashDefId,
} from '../systems/stash-service.js';
import {
  getEquippableWeapons,
  getEquippableArmors,
  getEquippableGrenades,
} from '../systems/unlock-checker.js';
// 护甲专属配色（8 套）。rig.js 已随主流程加载，这里只是引用其导出的颜色表。
import { ARMOR_KIT_COLORS } from '../player/rig.js';

/**
 * 数字色值 → #rrggbb（与 ui/loadout-art.js 的 HEX 同一约定）。
 * 字符串（如 GRENADE_TYPES 的 color 字段）原样透传。
 */
function hexOf(color, fallback = '#9aa7b8') {
  if (typeof color === 'string') return color;
  if (!Number.isFinite(color)) return fallback;
  return `#${color.toString(16).padStart(6, '0')}`;
}

/**
 * 仓库装备图标 —— 自绘 Unicode 几何符号（与材料区 ✚▣◪⬢◉ 同一美学，
 * 不用 emoji），颜色全部复用各权威数据源的现成配色：
 *
 *   武器：WEAPONS[id].color（游戏内枪械本体色）
 *   护甲：rig.js ARMOR_KIT_COLORS[id]（游戏内 8 套护甲唯一视觉差异就是颜色）
 *   手雷：GRENADE_TYPES[id].color（装备整备页同款展示色）
 *   配件：ATTACHMENTS[id].slot → 空槽类型几何符号（枪口▹ / 瞄具◎ / 弹匣▤ / 握把┧）
 */
const EQUIP_GLYPHS = {
  weapon: {
    pistol: '⌐▬',      // 转角握把 + 短枪管
    pistolFast: '¬▬',  // 前置转角 + 短枪管（快射枪机轮廓）
    smg: '┤▬',         // 弹匣竖线 + 枪管
    shotgun: '╪▬',     // 泵动双竖线 + 枪管
    ar: '┼▬',          // 中置机匣 + 枪管
    dmr: '╤▬',         // 顶置瞄具 + 枪管
  },
  armor: '▲',          // 三角 = 护甲轮廓（颜色区分 8 套）
  grenade: '●',        // 圆点 = 弹体（颜色区分 7 种）
  attachment: { muzzle: '▹', optic: '◎', magazine: '▤', grip: '┧' },
  blueprint: '◈',      // 菱形 = 蓝图门票
  overflow: '▦',       // 待整理区格纹
};

/** 材料图标（7 种，几何符号 —— 与制作页 rc-mat-ic 同体系）。 */
const MATERIAL_GLYPHS = {
  medkit: '✚', ammo: '▣', scrap: '◪', metal: '⬢', optics: '◉',
  kevlar: '⬡', chemical: '◧',
};

/** 附件图标：按 ATTACHMENTS[id].slot 取类型符号。 */
function attachmentGlyph(id) {
  const slot = ATTACHMENTS[id]?.slot;
  return EQUIP_GLYPHS.attachment[slot] ?? '▦';
}

/** escapeHtml：物品名/描述来自数据表，仍统一转义避免脏 HTML。 */
function escapeHtml(value) {
  return String(value ?? '').replace(/[&<>"]/g, (c) => ({
    '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;',
  }[c]));
}

/**
 * 初始化中枢导航
 *
 * 顶部 .hub-tabs 现在只保留「任务」一个入口；仓库/制作已迁入装备整备
 * 面板（#equipment）的页签，由 equipment.js 在切页签时调用
 * refreshWarehouse / refreshCrafting。这里保留通用的 tab → page 切换
 * 机制，未来若顶部再加页签无需重写。
 */
export function initHubNav() {
  const tabs = document.querySelectorAll('.hub-tabs button');
  const pages = {
    missions: document.getElementById('missions-page'),
  };

  // 标签切换逻辑
  tabs.forEach(tab => {
    tab.addEventListener('click', () => {
      const targetTab = tab.dataset.tab;

      // 更新标签状态
      tabs.forEach(t => t.classList.toggle('active', t === tab));

      // 更新页面显示
      Object.entries(pages).forEach(([key, page]) => {
        if (page) {
          page.classList.toggle('active', key === targetTab);
        }
      });
    });
  });
}

/**
 * 刷新仓库内容（从 SaveStore 读取真实数据 + stash used/capacity + 待整理区）
 * 挂载点：装备整备面板「仓库」页签（见 equipment.js switchTab）
 */
export function refreshWarehouse() {
  const saveStore = getSaveStore();
  const profile = saveStore.getProfile();

  if (!profile) {
    console.warn('[HubNav] No profile data available');
    return;
  }

  const view = getStashView();

  // 渲染材料
  renderMaterials(profile);

  // 渲染武器（保底 + stash 实例）
  renderWeapons(profile, view);

  // 渲染护甲（保底 + stash 实例）
  renderArmors(profile, view);

  // 渲染手雷（保底 + stash 实例）
  renderGrenades(profile, view);

  // 渲染配件（stash 实例，按 pairing 蓝图显示）
  renderAttachments(view);

  // 渲染蓝图（profile.blueprints 解锁位）
  renderBlueprints(profile);

  // 渲染仓库容量占用 + 待整理区（overflow 单独显示，绝不混进占用）
  renderStashUsage(view);
}

/**
 * 渲染材料区（LOOT_ITEMS 唯一真源：名称/描述/稀有度）
 */
function renderMaterials(profile) {
  const container = document.getElementById('wh-materials');
  if (!container) return;

  const materials = profile.materials || {};
  const entries = Object.entries(materials);

  if (entries.length === 0) {
    container.innerHTML = '<div class="wh-empty">暂无材料</div>';
    return;
  }

  container.innerHTML = entries.map(([id, count]) => {
    const def = LOOT_ITEMS[id] ?? { id, name: id, description: '未知材料' };
    return `
      <div class="wh-item">
        <div class="icon">${MATERIAL_GLYPHS[id] ?? '?'}</div>
        <div class="name">${escapeHtml(def.name)}</div>
        <div class="count">×${count}</div>
        <div class="meta">${escapeHtml(def.description)}</div>
      </div>
    `;
  }).join('');
}

/**
 * 渲染武器区（保底武器 + stash 实例，可用性判定统一走 unlock-checker）
 */
function renderWeapons(profile, view) {
  const container = document.getElementById('wh-weapons');
  if (!container) return;

  const stash = profile.stash || {};
  const ownedWeapons = getEquippableWeapons();

  const displayWeapons = ownedWeapons.map(weaponId => {
    const spec = WEAPONS[weaponId];
    if (!spec) return '';

    const count = countStashInstances(stash, 'weapon', weaponId);
    const glyph = EQUIP_GLYPHS.weapon[weaponId] || EQUIP_GLYPHS.weapon.pistol;
    const color = hexOf(spec.color);
    const desc = `伤害 ${spec.damage} · 射速 ${spec.rof}/s · 弹匣 ${spec.mag}`;

    return `
      <div class="wh-item">
        <div class="icon" style="color:${color}">${glyph}</div>
        <div class="name">${escapeHtml(spec.name)}</div>
        <div class="count">${count > 0 ? `×${count}` : '已解锁'}</div>
        <div class="meta">${desc}</div>
      </div>
    `;
  });

  container.innerHTML = displayWeapons.join('') || '<div class="wh-empty">暂无武器</div>';
}

/**
 * 渲染护甲区（保底 standard + stash 实例）
 */
function renderArmors(profile, view) {
  const container = document.getElementById('wh-armors');
  if (!container) return;

  const stash = profile.stash || {};
  const ownedArmors = getEquippableArmors();

  const displayArmors = ownedArmors.map(armorId => {
    const spec = ARMOR_TYPES[armorId];
    if (!spec) return '';

    const count = countStashInstances(stash, 'armor', armorId);
    const color = hexOf(ARMOR_KIT_COLORS[armorId], '#5e86c4');

    return `
      <div class="wh-item">
        <div class="icon" style="color:${color}">${EQUIP_GLYPHS.armor}</div>
        <div class="name">${escapeHtml(spec.name)}</div>
        <div class="count">${count > 0 ? `×${count}` : '已解锁'}</div>
        <div class="meta">${escapeHtml(spec.desc)}</div>
      </div>
    `;
  });

  container.innerHTML = displayArmors.join('') || '<div class="wh-empty">暂无护甲</div>';
}

/**
 * 渲染手雷区（保底 flash + stash 实例）
 */
function renderGrenades(profile, view) {
  const container = document.getElementById('wh-grenades');
  if (!container) return;

  const stash = profile.stash || {};
  const ownedGrenades = getEquippableGrenades();

  const displayGrenades = ownedGrenades.map(grenadeId => {
    const spec = GRENADE_TYPES[grenadeId];
    if (!spec) return '';

    const count = countStashInstances(stash, 'grenade', grenadeId);
    const color = hexOf(spec.color);

    return `
      <div class="wh-item">
        <div class="icon" style="color:${color}">${EQUIP_GLYPHS.grenade}</div>
        <div class="name">${escapeHtml(spec.name)}</div>
        <div class="count">${count > 0 ? `×${count}` : '已解锁'}</div>
        <div class="meta">${escapeHtml(spec.desc)}</div>
      </div>
    `;
  });

  container.innerHTML = displayGrenades.join('') || '<div class="wh-empty">暂无手雷</div>';
}

/**
 * 渲染配件区（stash 中的 attachment 实例；配对蓝图名/附件名从权威表读）
 */
function renderAttachments(view) {
  const container = document.getElementById('wh-attachments');
  if (!container) return;

  const seen = new Map();   // 配对蓝图 id → 实例数
  for (const item of view?.groups?.attachment ?? []) {
    const bp = item.blueprintId ?? item.defId;
    const key = bp ?? item.defId;
    if (!key) continue;
    seen.set(key, (seen.get(key) ?? 0) + 1);
  }

  if (seen.size === 0) {
    container.innerHTML = '<div class="wh-empty">暂无配件 · 在制作页消耗材料制作</div>';
    return;
  }

  container.innerHTML = [...seen.entries()].map(([bpId, count]) => {
    const sep = bpId.indexOf('_');
    const weaponId = sep >= 0 ? bpId.slice(0, sep) : bpId;
    const attachmentId = sep >= 0 ? bpId.slice(sep + 1) : bpId;
    const weapon = weaponId ? WEAPONS[weaponId] : null;
    const att = ATTACHMENTS[attachmentId];
    const label = att?.name ?? attachmentId;
    const where = weapon ? `用于 ${weapon.name}` : '';
    return `
      <div class="wh-item">
        <div class="icon">${attachmentGlyph(attachmentId)}</div>
        <div class="name">${escapeHtml(label)}</div>
        <div class="count">×${count}</div>
        <div class="meta">${where}${att?.desc ? ` · ${escapeHtml(att.desc)}` : ''}</div>
      </div>
    `;
  }).join('');
}

/** 蓝图名：优先本项目数据表（weapon/armor/grenade/attachment）。 */
function blueprintName(bpId) {
  const weapon = WEAPONS[bpId];
  if (weapon) return { name: weapon.name, kind: '武器' };
  const armor = ARMOR_TYPES[bpId];
  if (armor) return { name: armor.name, kind: '护甲' };
  const grenade = GRENADE_TYPES[bpId];
  if (grenade) return { name: grenade.name, kind: '手雷' };
  const sep = bpId.indexOf('_');
  if (sep >= 0) {
    const weaponId = bpId.slice(0, sep);
    const attachmentId = bpId.slice(sep + 1);
    const w = WEAPONS[weaponId];
    const a = ATTACHMENTS[attachmentId];
    if (a) return { name: `${w?.name ?? weaponId} · ${a.name}`, kind: '配件' };
  }
  return { name: bpId, kind: '蓝图' };
}

/**
 * 渲染蓝图区（profile.blueprints 解锁位 = 制作门票；永久布尔位，不占格）
 */
function renderBlueprints(profile) {
  const container = document.getElementById('wh-blueprints');
  if (!container) return;

  const entries = Object.entries(profile.blueprints ?? {});
  if (entries.length === 0) {
    container.innerHTML = '<div class="wh-empty">暂无蓝图 · 从任务中带回蓝图解锁制作</div>';
    return;
  }

  container.innerHTML = entries.map(([bpId, unlocked]) => {
    const info = blueprintName(bpId);
    const color = bpId.includes('_') ? hexOf(ATTACHMENTS[bpId.slice(bpId.indexOf('_') + 1)]?.color, '#4cc9f0') : '#4cc9f0';
    return `
      <div class="wh-item">
        <div class="icon" style="color:${color}">${EQUIP_GLYPHS.blueprint}</div>
        <div class="name">${escapeHtml(info.name)}</div>
        <div class="count">${unlocked ? '已解锁' : '未解锁'}</div>
        <div class="meta">${info.kind} · 制作门票</div>
      </div>
    `;
  }).join('');
}

/**
 * 待整理区「整理待整理物」按钮（批 5.1）：
 * 点击走 stash-service.organizeOverflow()（原子：容量允许的实例移回仓库，
 * 剩余继续保留待整理区，写盘失败整体回滚），完成后立即刷新仓库视图。
 * 只在有待整理物时显示；不改变默认容量，也不引入任何扩容。
 */
function syncOverflowOrganizeButton(count) {
  const section = document.getElementById('wh-overflow-section');
  if (!section) return;
  let btn = section.querySelector('.wh-organize-btn');
  if (count <= 0) {
    if (btn) btn.style.display = 'none';
    return;
  }
  if (!btn) {
    btn = document.createElement('button');
    btn.type = 'button';
    btn.className = 'wh-organize-btn';
    btn.textContent = '整理待整理物';
    btn.setAttribute('aria-label', '把仓库容量允许的待整理物品移回仓库');
    btn.style.cssText =
      'display:block;margin:0 0 10px;padding:6px 14px;font:inherit;font-size:.66rem;'
      + 'letter-spacing:.14em;color:#7fd8a8;background:rgba(127,216,168,.08);'
      + 'border:1px solid rgba(127,216,168,.35);border-radius:4px;cursor:pointer;';
    btn.addEventListener('click', () => {
      const res = organizeOverflow();
      if (!res.ok) {
        showToast(res.reason || '整理失败 · 状态未改变');
        return;
      }
      if (res.movedCount === 0 && res.remainingCount === 0) {
        showToast('待整理区为空');
      } else if (res.movedCount > 0) {
        showToast(res.remainingCount > 0
          ? `已整理 ${res.movedCount} 件移入仓库 · ${res.remainingCount} 件仍待整理`
          : `已整理 ${res.movedCount} 件移入仓库`);
      } else {
        showToast(`仓库已满 · ${res.remainingCount} 件仍留在待整理区`);
      }
      redirectToRefreshWarehouse();
    });
    const grid = section.querySelector('.warehouse-grid');
    if (grid) section.insertBefore(btn, grid);
    else section.appendChild(btn);
  } else {
    btn.style.display = '';
  }
}

/** 整理按钮成功后的本地刷新（organizeOverflow 已派发 inventory-edited）。 */
function redirectToRefreshWarehouse() {
  refreshWarehouse();
}

/**
 * 渲染仓库容量占用（stash used/capacity）+ 待整理区（overflow 单独显示）。
 * 材料与蓝图是计数/解锁位，不占仓库容量（INVENTORY-SYSTEM-DESIGN.md §7.2）。
 */
function renderStashUsage(view) {
  const bar = document.getElementById('wh-usage-bar');
  const text = document.getElementById('wh-usage-text');
  if (!bar && !text) return;

  const used = view?.used ?? 0;
  const capacity = view?.capacity ?? 24;
  const overflowCount = view?.overflowCount ?? 0;
  const pct = capacity > 0 ? Math.min(100, Math.round((used / capacity) * 100)) : 0;

  if (text) {
    text.textContent = `仓库 ${used}/${capacity} · 待整理 ${overflowCount}`;
  }
  if (bar) {
    bar.style.width = `${pct}%`;
    bar.classList.toggle('full', used >= capacity);
  }

  // 待整理区：overflow 条目完整列出（不混进占用，不静默丢）
  const overflowWrap = document.getElementById('wh-overflow');
  if (!overflowWrap) return;
  syncOverflowOrganizeButton(overflowCount);
  const overflow = view?.overflow ?? [];
  if (overflow.length === 0) {
    overflowWrap.innerHTML = '<div class="wh-empty">待整理区为空 · 撤离时仓库已满的物品会保留在这里</div>';
    return;
  }
  overflowWrap.innerHTML = overflow.map((item) => {
    const kind = stashKind(item);
    const defId = stashDefId(item);
    const name = itemNameFor(kind, defId, item);
    const glyph = kindGlyphFor(kind, defId);
    const color = kindColorFor(kind, defId);
    return `
      <div class="wh-item wh-overflow-item">
        <div class="icon" style="color:${color}">${glyph}</div>
        <div class="name">${escapeHtml(name)}</div>
        <div class="count">待整理</div>
        <div class="meta">${escapeHtml(kind ?? '未知')} · 仓库已满时保留</div>
      </div>
    `;
  }).join('');
}

/** 类别 × defId → 展示名（优先权威数据表）。 */
function itemNameFor(kind, defId, item) {
  if (item?.name) return item.name;
  if (kind === 'weapon') return WEAPONS[defId]?.name ?? defId;
  if (kind === 'armor') return ARMOR_TYPES[defId]?.name ?? defId;
  if (kind === 'grenade') return GRENADE_TYPES[defId]?.name ?? defId;
  if (kind === 'attachment') return ATTACHMENTS[defId]?.name ?? defId;
  if (kind === 'material') return LOOT_ITEMS[defId]?.name ?? defId;
  return defId;
}

/** 类别 × defId → 图标。 */
function kindGlyphFor(kind, defId) {
  if (kind === 'weapon') return EQUIP_GLYPHS.weapon[defId] ?? '⌐▬';
  if (kind === 'armor') return EQUIP_GLYPHS.armor;
  if (kind === 'grenade') return EQUIP_GLYPHS.grenade;
  if (kind === 'attachment') return attachmentGlyph(defId);
  if (kind === 'material') return MATERIAL_GLYPHS[defId] ?? '?';
  return EQUIP_GLYPHS.overflow;
}

/** 类别 × defId → 颜色。 */
function kindColorFor(kind, defId) {
  if (kind === 'weapon') return hexOf(WEAPONS[defId]?.color);
  if (kind === 'armor') return hexOf(ARMOR_KIT_COLORS[defId], '#5e86c4');
  if (kind === 'grenade') return hexOf(GRENADE_TYPES[defId]?.color);
  if (kind === 'attachment') return hexOf(ATTACHMENTS[defId]?.color ?? ATTACHMENTS[defId]?.effects?.noise, '#4cc9f0');
  return '#9aa7b8';
}

/**
 * 刷新制作内容（真实配方注册表 → 三态卡片；点击走 stash-service.craft 原子提交）
 * 挂载点：装备整备面板「制作」页签（见 equipment.js switchTab）
 */
export function refreshCrafting() {
  const container = document.getElementById('crafting-recipes');
  if (!container) return;

  const saveStore = getSaveStore();
  const profile = saveStore.getProfile();

  if (!profile) {
    container.innerHTML = '<div class="wh-empty">档案未加载</div>';
    return;
  }

  // 材料小图标：与仓库材料卡 renderMaterials 的图标一一对应，保证全系统图标统一
  const materialIcons = MATERIAL_GLYPHS;

  const recipes = Object.values(CRAFTING_RECIPES);

  container.innerHTML = recipes.map((recipe) => {
    const state = getRecipeState(recipe.id);
    if (!state) return '';
    const { materials, allSufficient, blueprintOwned } = state;

    const cardState = !blueprintOwned ? 'st-locked'
                    : !allSufficient ? 'st-insufficient'
                    : 'st-ready';
    const statusText = !blueprintOwned ? '未解锁 · 需蓝图'
                     : !allSufficient ? '材料不足'
                     : '可制作';

    // 材料需求可视化：小标签 = 迷你图标 + 名称 + 已有/需要
    const materialsHtml = materials.length === 0
      ? '<div class="rc-mat-none">无需材料</div>'
      : materials.map(mat => `
        <div class="rc-mat ${mat.sufficient ? 'ok' : 'lacking'}">
          <span class="rc-mat-ic">${materialIcons[mat.id] || '?'}</span>
          <span class="rc-mat-nm">${escapeHtml(mat.name || mat.id)}</span>
          <span class="rc-mat-nu"><b>${mat.have}</b><em>/${mat.count}</em></span>
        </div>
      `).join('');

    return `
      <div class="recipe-card ${cardState}" data-recipe="${escapeHtml(recipe.id)}">
        <span class="rc-badge">${statusText}</span>
        <div class="rc-head">
          <div class="rc-icon">${recipeIcon(recipe)}</div>
          <div class="rc-titles">
            <div class="rc-name">${escapeHtml(recipe.name)}</div>
            <div class="rc-kind">${recipeKindLabel(recipe)}</div>
          </div>
        </div>
        <div class="rc-desc">${escapeHtml(recipe.desc)}</div>
        <div class="rc-mats">${materialsHtml}</div>
        <button class="recipe-btn" ${state.craftable ? '' : 'disabled'}>
          制作
        </button>
      </div>
    `;
  }).join('');

  // 绑定制作按钮事件：每张卡独立 data-recipe，点击 → 原子 craft（内部回滚保护）。
  container.querySelectorAll('.recipe-btn').forEach((btn) => {
    btn.addEventListener('click', () => {
      if (btn.disabled) return;
      const card = btn.closest('.recipe-card');
      const recipeId = card?.dataset?.recipe;
      if (!recipeId) return;
      const result = craft(recipeId);
      if (result.ok) {
        showToast(result.capacityFull ? result.reason : `制作成功 · ${CRAFTING_RECIPES[recipeId].name} 已入仓库`);
        // 成功刷新：材料/仓库/制作卡三态都要更新（一次刷新，不重复生成监听器）。
        refreshWarehouse();
        refreshCrafting();
      } else {
        showToast(result.reason || '制作失败 · 状态未改变');
        refreshCrafting();   // 失败也可能因蓝图/材料变化，同步三态
      }
    });
  });
}

/** 配方产出图标（与仓库 EQUIP_GLYPHS 同一体系；急救包用几何符号）。 */
function recipeIcon(recipe) {
  const { slotKind, defId } = recipe.output;
  if (slotKind === 'weapon') return EQUIP_GLYPHS.weapon[defId] ?? '⌐▬';
  if (slotKind === 'armor') return EQUIP_GLYPHS.armor;
  if (slotKind === 'grenade') return EQUIP_GLYPHS.grenade;
  if (slotKind === 'attachment') return attachmentGlyph(defId);
  if (slotKind === 'consumable') return '✚';     // 急救包：医疗体系几何符号
  return '◇';
}

/** 配方类别文案。 */
function recipeKindLabel(recipe) {
  const labels = {
    weapon: '武器 · WEAPON',
    armor: '护甲 · ARMOR',
    grenade: '手雷 · GRENADE',
    attachment: '配件 · ATTACHMENT',
    consumable: '消耗品 · CONSUMABLE',
  };
  return labels[recipe.category] ?? '制作';
}

/**
 * 显示 toast 提示
 */
function showToast(msg) {
  const toast = document.getElementById('toast');
  if (!toast) return;

  toast.textContent = msg;
  toast.style.opacity = '1';

  setTimeout(() => {
    toast.style.opacity = '0';
  }, 1800);
}
