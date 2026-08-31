/**
 * 制作配方注册表（批 5 · 本项目数据表）
 *
 * 配方数值全部来自 ECONOMY-FINAL-RECALC.md（7 材料体系最终定案）：
 *   §2.2 护甲 7 条   §3.2 手雷 6 条   §4.8 武器 4 条
 *   §5.1/§5.2 附件 37 条（Tier 1/2/3 分档公式）  §6.1 急救包 1 条（无蓝图门票）
 *
 * 数据边界：
 *   - 只包含本项目 WEAPONS / ARMOR_TYPES / GRENADE_TYPES / ATTACHMENTS /
 *     LOOT_ITEMS 里的物品；截图里的 ARC 物品 / 货币 / 容量数字一律不入。
 *   - requiresBlueprint:true 的配方需要 profile.blueprints[blueprintId]
 *     作为门票；false（急救包）不需要任何蓝图，材料足够即可制作。
 *   - 附件配方的 id 遵循 unlock-checker 的配对命名 {weaponId}_{attachmentId}；
 *     output.defId 是 ATTACHMENTS 的附件 id，blueprintId 是配对蓝图 id。
 *
 * 形状（消费方：src/systems/stash-service.js craft() + src/ui/hub-nav.js）：
 *   {
 *     id,                     // 配方主键（附件 = 配对蓝图 id）
 *     name,                   // 展示名（从权威数据表读取）
 *     desc,                   // 一句话描述（展示）
 *     category,               // weapon | armor | grenade | attachment | consumable
 *     output: { slotKind, defId, quantity },   // 产物实例
 *     materials: [{ id, name, count }],        // 材料需求（LOOT_ITEMS id + 数量）
 *     requiresBlueprint: true|false,
 *     blueprintId,            // 蓝图门票 id（默认 = output.defId）
 *   }
 */

import { ATTACHMENTS } from '../systems/loadout-config.js';

const MAT_NAMES = {
  scrap: '废料',
  ammo: '弹药盒',
  medkit: '医疗包',
  metal: '金属零件',
  kevlar: '凯夫拉纤维',
  chemical: '化学试剂',
  optics: '光学组件',
};

/**
 * 材料成本（材料 id → 数量）。数值来源：
 *   武器 §4.8 · 护甲 §2.2 · 手雷 §3.2 · 附件 §5.1 三档 · 急救包 §6.1。
 */
const COSTS = {
  // 武器（§4.8 最终定案）
  smg: { metal: 32, scrap: 48 },
  shotgun: { metal: 40, scrap: 60, ammo: 160 },
  ar: { metal: 60, optics: 4, scrap: 80 },
  dmr: { metal: 80, optics: 6, scrap: 100 },
  // 护甲（§2.2 最终定案）
  ghost: { kevlar: 4, scrap: 20, metal: 2 },
  runner: { kevlar: 4, scrap: 25, metal: 3 },
  light: { kevlar: 5, scrap: 30, metal: 3 },
  chameleon: { kevlar: 5, scrap: 28, metal: 4, optics: 1 },
  carrier: { kevlar: 6, scrap: 32, metal: 5 },
  dualist: { kevlar: 7, scrap: 38, metal: 6, optics: 1 },
  heavy: { kevlar: 9, scrap: 45, metal: 8, optics: 1 },
  // 手雷（§3.2 最终定案）
  smoke: { chemical: 2, scrap: 12 },
  decoy: { chemical: 2, scrap: 15, metal: 1 },
  concussion: { chemical: 3, scrap: 18, metal: 1 },
  phosphorus: { chemical: 4, scrap: 20, metal: 2 },
  emp: { chemical: 4, scrap: 18, metal: 3, optics: 1 },
  he: { chemical: 5, scrap: 22, metal: 3, ammo: 40 },
  // 附件（§5.1 三档公式）
  'tier-1': { scrap: 12, metal: 4 },
  'tier-2': { metal: 8, scrap: 16, optics: 1 },
  'tier-3': { metal: 12, optics: 2, scrap: 20 },
  // 急救包（§6.1 · 无蓝图门票）
  first_aid: { medkit: 2, scrap: 5 },
};

/** 原始候选蓝本（名称/描述/材料种类）；材料数量由 COSTS 统一补全。 */
const RAW = [
  // ── 武器（§4.8）──
  { id: 'smg', name: 'MP7 冲锋枪', desc: '高射速入门主武器 · 2 局可得', category: 'weapon', mats: ['metal', 'scrap'] },
  { id: 'shotgun', name: 'M870 霰弹枪', desc: '贴脸一枪终止 · 弹药大户', category: 'weapon', mats: ['metal', 'scrap', 'ammo'] },
  { id: 'ar', name: 'AR-15 突击步枪', desc: '全距通用主力步枪', category: 'weapon', mats: ['metal', 'optics', 'scrap'] },
  { id: 'dmr', name: 'DMR 精准步枪', desc: '远距精准射击 · 顶级武器', category: 'weapon', mats: ['metal', 'optics', 'scrap'] },
  // ── 护甲（§2.2）──
  { id: 'ghost', name: '幽灵作战服', desc: '极致静默与隐蔽 · 护甲最薄', category: 'armor', mats: ['kevlar', 'scrap', 'metal'] },
  { id: 'runner', name: '斥候轻装', desc: '轻装疾行 · 撤离速度优先', category: 'armor', mats: ['kevlar', 'scrap', 'metal'] },
  { id: 'light', name: '幽影软甲', desc: '轻型凯夫拉背心 · 适合潜行', category: 'armor', mats: ['kevlar', 'scrap', 'metal'] },
  { id: 'chameleon', name: '光学迷彩服', desc: '大幅削弱光照暴露', category: 'armor', mats: ['kevlar', 'scrap', 'metal', 'optics'] },
  { id: 'carrier', name: '携行装具', desc: '携带栏上限 +2', category: 'armor', mats: ['kevlar', 'scrap', 'metal'] },
  { id: 'dualist', name: '双枪战术甲', desc: '双主武器挂载具（牺牲手雷上限）', category: 'armor', mats: ['kevlar', 'scrap', 'metal', 'optics'] },
  { id: 'heavy', name: '重型防弹板', desc: '护甲封顶件 · 重大投资', category: 'armor', mats: ['kevlar', 'scrap', 'metal', 'optics'] },
  // ── 手雷（§3.2）──
  { id: 'smoke', name: '烟雾弹', desc: '遮蔽敌人视线 · 极安静', category: 'grenade', mats: ['chemical', 'scrap'] },
  { id: 'decoy', name: '诱饵弹', desc: '落点噪音脉冲引开敌人', category: 'grenade', mats: ['chemical', 'scrap', 'metal'] },
  { id: 'concussion', name: '震撼弹', desc: '眩晕敌人 5 秒 · 无伤', category: 'grenade', mats: ['chemical', 'scrap', 'metal'] },
  { id: 'phosphorus', name: '白磷弹', desc: '燃烧区域伤害 · 高自伤', category: 'grenade', mats: ['chemical', 'scrap', 'metal'] },
  { id: 'emp', name: '电磁脉冲弹', desc: '灭灯半径 18 · 无伤', category: 'grenade', mats: ['chemical', 'scrap', 'metal', 'optics'] },
  { id: 'he', name: '高爆弹', desc: '高伤害 AOE · 高噪音', category: 'grenade', mats: ['chemical', 'scrap', 'metal', 'ammo'] },
  // ── 急救包（§6.1 · 无蓝图门票）──
  { id: 'first_aid', name: '急救包', desc: '恢复 50 HP · 无需蓝图门票', category: 'consumable', mats: ['medkit', 'scrap'], requiresBlueprint: false },
];

/**
 * 附件配对蓝图（§5.2：weaponId_attachmentId → 档位 cost 键）。
 * Tier 1：scrap×12 + metal×4（14 件）· Tier 2：metal×8 + scrap×16 + optics×1（18 件）
 * Tier 3：metal×12 + optics×2 + scrap×20（5 件）
 */
const ATTACHMENT_BLUEPRINTS = {
  'pistol_tacticalGrip': 'tier-1',
  'pistol_extendedMag': 'tier-1',
  'pistol_quickMag': 'tier-1',
  'pistolFast_tacticalGrip': 'tier-1',
  'pistolFast_extendedMag': 'tier-1',
  'pistolFast_quickMag': 'tier-1',
  'smg_tacticalGrip': 'tier-1',
  'smg_verticalGrip': 'tier-1',
  'smg_extendedMag': 'tier-1',
  'smg_quickMag': 'tier-1',
  'ar_tacticalGrip': 'tier-1',
  'ar_verticalGrip': 'tier-1',
  'ar_extendedMag': 'tier-1',
  'ar_quickMag': 'tier-1',
  'pistol_suppressor1': 'tier-2',
  'pistol_redDot': 'tier-2',
  'pistolFast_suppressor1': 'tier-2',
  'pistolFast_compensator': 'tier-2',
  'pistolFast_redDot': 'tier-2',
  'smg_suppressor1': 'tier-2',
  'smg_compensator': 'tier-2',
  'smg_redDot': 'tier-2',
  'smg_holo': 'tier-2',
  'ar_suppressor1': 'tier-2',
  'ar_compensator': 'tier-2',
  'ar_flashHider': 'tier-2',
  'ar_redDot': 'tier-2',
  'ar_holo': 'tier-2',
  'dmr_flashHider': 'tier-2',
  'shotgun_choke': 'tier-2',
  'shotgun_ghostRing': 'tier-2',
  'shotgun_pumpGrip': 'tier-2',
  'ar_scope2x': 'tier-3',
  'ar_precisionStock': 'tier-3',
  'dmr_scope2x': 'tier-3',
  'dmr_quickMag': 'tier-3',
  'dmr_precisionStock': 'tier-3',
};

// 附件产物的展示描述（§5.4 提及的定位词；其余配件用通用文案）
const ATTACHMENT_DESC = {
  choke: '霰弹枪枪口喉缩 · 收束弹丸',
  ghostRing: '超大孔径环状照门 · 贴脸瞬瞄',
  pumpGrip: '战术泵动握把 · 抑制后坐',
};

function finishRecipe(raw) {
  const cost = COSTS[raw.costKey] ?? COSTS[raw.id] ?? {};
  const mats = (raw.mats ?? []).map((id) => ({
    id,
    name: MAT_NAMES[id] ?? id,
    count: cost[id] ?? 1,
  }));
  return {
    id: raw.id,
    name: raw.name,
    desc: raw.desc,
    category: raw.category,
    output: { slotKind: raw.slotKind, defId: raw.defId, quantity: 1 },
    materials: mats,
    requiresBlueprint: raw.requiresBlueprint ?? true,
    blueprintId: raw.blueprintId ?? raw.defId,
  };
}

function assemble() {
  const out = {};
  for (const raw of RAW) {
    out[raw.id] = finishRecipe({
      ...raw,
      slotKind: raw.category,       // weapon/armor/grenade/consumable 槽类 = 类别
      defId: raw.id,
    });
  }
  for (const [blueprintId, costKey] of Object.entries(ATTACHMENT_BLUEPRINTS)) {
    const sep = blueprintId.indexOf('_');
    const attachmentId = blueprintId.slice(sep + 1);
    out[blueprintId] = finishRecipe({
      id: blueprintId,
      name: ATTACHMENTS[attachmentId]?.name ?? attachmentId,
      desc: ATTACHMENT_DESC[attachmentId]
        ?? (ATTACHMENTS[attachmentId]?.desc ?? '配对蓝图成品'),
      category: 'attachment',
      slotKind: 'attachment',
      defId: attachmentId,
      mats: Object.keys(COSTS[costKey]),
      costKey,
      blueprintId,
    });
  }
  return out;
}

/** 全部配方（id → 配方对象）。常量注册表，模块加载时构建一次。 */
export const CRAFTING_RECIPES = assemble();

/** 配方数量（附件 37 + 武器 4 + 护甲 7 + 手雷 6 + 急救包 1 = 55）。 */
export const CRAFTING_RECIPE_COUNT = Object.keys(CRAFTING_RECIPES).length;
