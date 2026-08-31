/**
 * 战利品定义与生成逻辑（数据层，不依赖 three）。
 *
 * 契约（与 save-store.js 的 settleRaid 对齐）：
 *   每件物品实例是
 *   { lootId, itemId, kind:'material', materialId, name, quantity, value, tier }
 *   —— itemId / materialId 必须落在仓库材料的 id 集
 *   （scrap/ammo/medkit/metal/kevlar/chemical/optics）里：main.js 结算面板按 itemId 聚合，
 *   settleRaid 按 materialId 入库（DECISIONS 2026-08-29「提取式掠夺 loop」）。
 *
 * 稀有度规则（DECISIONS 2026-08-29 条）：
 *   · 箱子按房间风险分稀有度（low/med/high），越深/越偏的箱子价值越高；
 *   · 升档概率固定 0.15（原困难档值）：单一难度下不再随难度浮动 ——
 *     每一掷都有 15% 概率从当前档池升到上一档池，低稀有度箱子也有
 *     小概率出好货，但高稀有度箱子整体仍然更好。
 *   · 先不做随机词条：物品就是固定的几种材料，随机只发生在「数量与出现率」。
 *
 * 蓝图掉落（批 3 缺口修复 · 独立奖励通道）：
 *   · 蓝图是材料池之外的独立 roll（每个容器最多 1 张），低稀有度箱结构性
 *     不掉（low=0），med 5% / high 15%（BLUEPRINT_DROP_CHANCE）；
 *   · 蓝图池 = crafting-recipes.js 中 requiresBlueprint:true 的全部配方 id
 *     （54 条 = 武器 4 + 护甲 7 + 手雷 6 + 配件 37；first_aid 无门票不入池）；
 *   · 优先掉「尚未拥有」的蓝图：options.excludeBlueprints 可为数组或函数
 *     （容器层不依赖存档单例，由 main.js 注入函数），重复/已拥有直接不生成；
 *   · 蓝图 loot 是统一 ItemInstance 形状（slotKind:'blueprint'）：
 *     { slotKind, defId, blueprintId, name, quantity:1, stackMax:1, value:0,
 *       payload:{ targetType, targetId } } —— 可进玩家 misc/背包，不混入 QuickUse。
 */

import { CRAFTING_RECIPES } from './crafting-recipes.js';

// ── 物品定义 ──────────────────────────────────────────────────────────────
/** 物品目录。id 同时是仓库材料 id；quantity 是 [min, max] 掷骰范围。 */
export const LOOT_ITEMS = {
  // 低级材料
  scrap: {
    id: 'scrap',
    name: '废料',
    tier: 'low',
    value: 5,
    quantity: [1, 3],
    description: '基础制作材料',
  },
  ammo: {
    id: 'ammo',
    name: '弹药盒',
    tier: 'low',
    value: 5,
    quantity: [10, 30],
    description: '备用弹药补给',
  },
  // 中级材料
  medkit: {
    id: 'medkit',
    name: '医疗包',
    tier: 'med',
    value: 15,
    quantity: [1, 1],
    description: '紧急医疗用品',
  },
  metal: {
    id: 'metal',
    name: '金属零件',
    tier: 'med',
    value: 20,
    quantity: [1, 2],
    description: '精密机械部件',
  },
  // ── 中级材料（护甲 / 手雷专属主料，新增）──
  kevlar: {
    id: 'kevlar',
    name: '凯夫拉纤维',
    tier: 'med',
    value: 25,
    quantity: [1, 2],
    description: '高强度防弹纤维，护甲制作核心材料',
  },
  chemical: {
    id: 'chemical',
    name: '化学试剂',
    tier: 'med',
    value: 20,
    quantity: [1, 2],
    description: '不稳定化合物，手雷制作核心材料',
  },
  // 高级材料
  optics: {
    id: 'optics',
    name: '光学组件',
    tier: 'high',
    value: 50,
    quantity: [1, 1],
    description: '高精度光学元件',
  },
};

// ── 掉落池（加权）─────────────────────────────────────────────────────────
/** 每个稀有度一档池；权重只影响「池内抽谁」，数量由生成逻辑掷骰。 */
export const LOOT_POOLS = {
  low:  [['scrap', 5], ['ammo', 3]],
  med:  [['scrap', 3], ['ammo', 2], ['medkit', 3], ['metal', 3], ['kevlar', 2], ['chemical', 2]],
  high: [['metal', 2], ['medkit', 1], ['optics', 2], ['kevlar', 2], ['chemical', 1]],
};

/** 升档方向：低 → 中 → 高 */
const TIER_UP = { low: 'med', med: 'high' };
/**
 * 每掷一次，从「当前档池」升到「上一档池」的概率。
 * 单一难度（原三档合并）下固定为原困难档的 0.15 —— 掉落表三关共用，
 * 不再按难度下标取不同值（DECISIONS 2026-08-29 第 5 条 + §7.5 难度合并）。
 */
export const DIFF_UPGRADE_CHANCE = 0.15;

// ── 蓝图掉落（独立奖励通道 / 批 3 缺口修复）──────────────────────────────
/**
 * 每个容器独立判一次「掉不掉蓝图」的概率。蓝图是材料池之外的额外通道，
 * 不挤占任何材料掷骰 —— low 结构性不掉（0），med 5%，high 15%
 * （BLUEPRINT-SYSTEM-FINAL-DECISION.md §8 批 3 推荐：high 0.15 / med 0.05）。
 * options.blueprintChance 可覆盖（测试用），但 low 恒为 0（结构门）。
 */
export const BLUEPRINT_DROP_CHANCE = { low: 0, med: 0.05, high: 0.15 };

/**
 * 蓝图索引（blueprintId → 展示定义）。数据源唯一：crafting-recipes.js 里
 * requiresBlueprint:true 的配方（附件配方 key = 配对蓝图 id）。
 *   targetType = recipe.category（weapon/armor/grenade/attachment）
 *   targetId   = recipe.output.defId（制作产物 id；附件 = 附件 id）
 *   name       = recipe.name（蓝图展示名）
 */
export const BLUEPRINT_INDEX = (() => {
  const index = {};
  for (const [key, recipe] of Object.entries(CRAFTING_RECIPES)) {
    if (!recipe.requiresBlueprint) continue;
    const blueprintId = recipe.blueprintId ?? key;
    index[blueprintId] = {
      blueprintId,
      targetType: recipe.category,
      targetId: recipe.output.defId ?? recipe.blueprintId ?? blueprintId,
      name: recipe.name ?? blueprintId,
      desc: recipe.desc ?? '',
    };
  }
  return index;
})();

/** 全部可掉蓝图的 id 池（54 条 = 武器 4 + 护甲 7 + 手雷 6 + 配件 37）。 */
export const BLUEPRINT_POOL_IDS = Object.keys(BLUEPRINT_INDEX);

let lootIdCounter = 1;

/**
 * 按稀有度生成一箱战利品。
 * 单档 API 保持兼容（无 diffIndex）：材料规则与旧版本逐掷一致，蓝图只在
 * 材料掷骰结束后追加独立 roll（不放蓝图时返回值与旧版本完全一致）。
 *
 * @param {string} tier    'low' | 'med' | 'high'
 * @param {object} [options]
 * @param {Function} [options.rng]     可注入随机源（测试用），默认 Math.random
 * @param {number} [options.blueprintChance] 蓝图概率覆盖（low 恒 0）
 * @param {string[]|Function} [options.excludeBlueprints] 已拥有/已掉蓝图排除
 * @param {string[]} [options.blueprintPool] 蓝图池覆盖（默认 BLUEPRINT_POOL_IDS）
 * @returns {Array} 物品实例列表（每件独立占携带栏 1 格；蓝图最多 1 张）
 */
export function generateLoot(tier, options = {}) {
  const rng = options.rng ?? Math.random;
  const items = [];

  const rollFromPool = () => {
    // 每掷一次有固定 0.15 概率升到上一档池（低稀有度箱也有小概率出好货）
    let t = tier;
    if (t !== 'high' && TIER_UP[t] && rng() < DIFF_UPGRADE_CHANCE) {
      t = TIER_UP[t];
    }
    const id = pickFromPool(rng, t);
    const item = createLootItem(id, { rng });
    if (item) items.push(item);
  };

  switch (tier) {
    case 'low':
      // 低级箱：1-2 次低级池掷骰（小概率升档）
      rollFromPool();
      if (rng() < 0.5) rollFromPool();
      break;

    case 'med':
      // 中级箱：2 次中级池掷骰，保底 1 件
      rollFromPool();
      rollFromPool();
      // 高级材料相对稀有，给 30% 的第三次掷骰
      if (rng() < 0.3) rollFromPool();
      break;

    case 'high':
      // 高级箱：保底 1 件高级池出货，再加 1-2 次
      rollFromPool();
      if (rng() < 0.5) rollFromPool();
      rollFromPool();
      break;

    default:
      console.warn(`Unknown loot tier: ${tier}`);
      items.push(createLootItem('scrap', { rng }));
  }

  // 蓝图：独立奖励通道 —— 在所有材料掷骰结束后才单独判定，绝不挤占
  // 材料池的权重/次数。重复或已拥有蓝图直接不生成（rollBlueprintDrop 内排除）。
  const blueprint = rollBlueprintDrop(tier, { ...options, rng });
  if (blueprint) items.push(blueprint);

  return items.filter(Boolean);
}

/**
 * 计算蓝图判定概率：options.blueprintChance 显式覆盖时用它（测试用），
 * 否则用 BLUEPRINT_DROP_CHANCE[tier]。low 是结构性 0 —— 参数也抬不起来。
 * @param {string} tier
 * @param {object} [options]
 * @returns {number}
 */
export function resolveBlueprintChance(tier, options = {}) {
  if (tier === 'low') return 0;                      // 低档箱结构性不掉蓝图
  const override = options.blueprintChance;
  if (typeof override === 'number' && Number.isFinite(override)) {
    return Math.max(0, Math.min(1, override));
  }
  return BLUEPRINT_DROP_CHANCE[tier] ?? 0;
}

/**
 * 蓝图 roll（独立通道）：先判概率（rng < chance 才掉），再从「未排除」的
 * 蓝图池里均匀抽一张。所有候选都被排除（全拥有 / 本局已全掉）→ 不生成，
 * 绝不让玩家拿到无效重复物。
 *
 * @param {string} tier - 'low' | 'med' | 'high'
 * @param {object} [options]
 * @param {Function} [options.rng]
 * @param {number} [options.blueprintChance]  覆盖默认概率（low 仍恒 0）
 * @param {string[]|Function} [options.excludeBlueprints]
 *   已拥有/已掉蓝图 id 数组；函数在判定时求值（容器层不依赖存档单例，
 *   main.js 注入 () => ownedIds）。默认 []。
 * @param {string[]} [options.blueprintPool] 覆盖默认池（BLUEPRINT_POOL_IDS）
 * @returns {object|null} 蓝图 ItemInstance；不掉时 null
 */
export function rollBlueprintDrop(tier, options = {}) {
  const rng = options.rng ?? Math.random;
  const chance = resolveBlueprintChance(tier, options);
  if (!(chance > 0)) return null;                    // low / 概率 0：不消费 rng
  if (rng() >= chance) return null;

  const pool = options.blueprintPool ?? BLUEPRINT_POOL_IDS;
  const excludeRaw = options.excludeBlueprints;
  const exclude = typeof excludeRaw === 'function' ? excludeRaw() : excludeRaw;
  const excluded = new Set(Array.isArray(exclude) ? exclude : []);
  const candidates = pool.filter((id) => BLUEPRINT_INDEX[id] && !excluded.has(id));
  if (candidates.length === 0) return null;          // 全排除 → 不生成（无无效重复）

  const id = candidates[Math.floor(rng() * candidates.length)];
  return createBlueprintItem(id);
}

/**
 * 创建蓝图 loot 实例（统一 ItemInstance 形状 + 旧形状兼容字段）。
 * 蓝图「门票」价值为 0（它不是材料/成品，制作价值由 unlock 带来）；
 * 数量恒 1、不可堆叠（stackMax 1）。
 * @param {string} blueprintId - BLUEPRINT_INDEX 的键
 * @returns {object|null} 未知蓝图 id 返回 null
 */
export function createBlueprintItem(blueprintId, options = {}) {
  const meta = BLUEPRINT_INDEX[blueprintId];
  if (!meta) {
    console.error(`Unknown blueprint: ${blueprintId}`);
    return null;
  }
  return {
    lootId: options.lootId ?? `loot_${lootIdCounter++}`,
    slotKind: 'blueprint',            // 统一容器形状
    kind: 'blueprint',                // 旧字段兼容（settleRaid 按 kind 归类）
    defId: meta.blueprintId,          // 统一容器识别主键
    blueprintId: meta.blueprintId,    // 旧形状识别（unlock/结算按它写解锁位）
    name: meta.name,
    quantity: 1,
    stackMax: 1,
    value: 0,                         // 蓝图不携带经济价值（价值来自解锁）
    tier: 'blueprint',
    description: meta.desc,
    targetType: meta.targetType,      // 兼容便利字段（payload 是主字段）
    targetId: meta.targetId,
    payload: { targetType: meta.targetType, targetId: meta.targetId },
  };
}

/**
 * 从加权池里抽一个物品 id。
 * 加权写法：所有权重相加 → rng() × 总权重落进区间 → 逐项减到 <=0。
 */
function pickFromPool(rng, tier) {
  const pool = LOOT_POOLS[tier] ?? LOOT_POOLS.low;
  let total = 0;
  for (const [, w] of pool) total += w;
  let r = rng() * total;
  for (const [id, w] of pool) {
    r -= w;
    if (r <= 0) return id;
  }
  return pool[0][0];
}

/**
 * 创建一件战利品实例。
 * 每一件独立拿一个 lootId —— 它们是「占 1 格携带栏」的独立个体，
 * 不是可无限叠加的同种材料数字。
 * @param {string} itemId - LOOT_ITEMS 的 id
 * @returns {object|null} 物品实例；未知 id 返回 null
 */
export function createLootItem(itemId, options = {}) {
  const rng = options.rng ?? Math.random;
  const template = LOOT_ITEMS[itemId];
  if (!template) {
    console.error(`Unknown loot item: ${itemId}`);
    return null;
  }
  const [min, max] = template.quantity;
  const quantity = min + Math.floor(rng() * (max - min + 1));

  return {
    lootId: `loot_${lootIdCounter++}`,
    itemId: template.id,              // 材料 id（结算面板按它聚合显示）
    kind: 'material',                 // save-store 结算契约：按材料入库
    materialId: template.id,          // 与 itemId 同值：settleRaid 按它入库
    name: template.name,
    quantity,
    value: template.value,            // 单件价值；总价 = value × quantity
    tier: template.tier,
    description: template.description,
  };
}

/**
 * 重置战利品 ID 计数器（新任务开始时调用）。
 * lootId 只在一局内唯一；跨局只要重新计数即可,
 * 结算也只看 materialId/quantity，不依赖 lootId 的全局唯一性。
 */
export function resetLootIdCounter() {
  lootIdCounter = 1;
}
