/**
 * SaveStore · 存档系统核心模块
 * 
 * 职责：
 * 1. 管理 localStorage 中的 ProfileData（局外仓库、材料、蓝图、装备配置、统计）
 * 2. 管理 pendingRaid（防止刷新绕过死亡损失）
 * 3. 提供出击、结算、更新的事务接口
 * 4. 校验、版本化、容错和重置
 * 
 * 数据边界：
 * - ProfileData: 永久进度，localStorage 持久化
 * - RaidData: 本局状态，仅内存，不自动写盘
 * - pendingRaid: 出击日志，防刷新作弊
 * 
 * 契约来源：protocol-clearance-project-plan.html § 08
 */

const STORAGE_KEY_PROFILE = 'protocol_clearance_profile';
const STORAGE_KEY_PENDING = 'protocol_clearance_pending_raid';
// v2 formalizes ItemInstance/raid container persistence while retaining the v1
// fields and values. v3 (batch 5) is the same data shape with an explicit
// version bit: out-of-raid equipping stays derived, so nothing new is persisted
// beyond stash/stashOverflow/materials/blueprints/loadout. Migration is
// intentionally additive and idempotent for v1 → v2 → v3.
const SCHEMA_VERSION = 3;
const CONTENT_VERSION = 1;

/**
 * JSON 可逆的 Infinity 哨兵（批 5.1）。
 *
 * JSON.stringify 会把 `payload.reserve: Infinity` 写成 null，破坏「武器
 * 备弹 ∞」语义；这里在**写盘边界**（profile / pendingRaid）用哨兵字符串
 * 只替换 Infinity 本身，NaN / undefined / 其它值全部保持 JSON 原生行为，
 * 因此旧存档与既有字段不受影响。读档边界（parseProfile / pending 解析）
 * 把哨兵还原为 Infinity —— 往返可逆；哨兵是带项目前缀的 ASCII 字符串，
 * 与真实物品数据的任何数值/名称都不冲突。
 */
const INFINITY_SENTINEL = '__protocol_clearance_infinity__';

/** JSON.stringify 的可逆包装：仅把 Infinity 序列化为哨兵。 */
export function serializeJson(value) {
  return JSON.stringify(value, (_key, val) => (val === Infinity ? INFINITY_SENTINEL : val));
}

/** JSON.parse 的可逆包装：仅把哨兵还原为 Infinity。 */
export function deserializeJson(raw) {
  return JSON.parse(raw, (_key, val) => (val === INFINITY_SENTINEL ? Infinity : val));
}

// 默认仓库容量
const DEFAULT_STASH_CAPACITY = 24;

/**
 * 创建默认档案
 */
function createDefaultProfile() {
  return {
    schemaVersion: SCHEMA_VERSION,
    contentVersion: CONTENT_VERSION,
    profileId: generateProfileId(),
    createdAt: Date.now(),
    updatedAt: Date.now(),
    
    // 仓库物品（instanceId -> ItemInstance / legacy item）
    stash: {},
    stashCapacity: DEFAULT_STASH_CAPACITY,
    // 容量不足时明确保留的待整理物品，不属于战局 Safe Pocket，也不参与带入。
    // 后续仓库 UI 会显示并允许整理；这里首先保证任何结算物不静默消失。
    stashOverflow: {},
    
    // 材料（materialId -> count）
    materials: {},
    
    // 蓝图/配方（blueprintId -> unlocked）
    blueprints: {},
    
    // 装备配置（当前整备方案）
    loadout: {
      pistol: 'pistol',           // 手枪型号
      attachments: {},            // 配件配置
      armor: 'standard',          // 护甲类型
      grenade: 'flash',           // 手雷类型
    },
    
    // 统计数据
    stats: {
      totalRaids: 0,
      successfulExtractions: 0,
      deaths: 0,
      enemiesKilled: 0,
      itemsExtracted: 0,
      materialsGained: 0,
    },
    
    // 设置（暂未使用）
    settings: {},
    // 已应用结算的持久化去重键。只保留最近记录，防止 interrupted settlement
    // 在重启恢复或重复调用时再发一次物品。
    settledRaidIds: [],
  };
}

/**
 * 生成唯一档案 ID
 */
function generateProfileId() {
  return `profile_${Date.now()}_${Math.random().toString(36).substring(2, 9)}`;
}

/**
 * 生成唯一任务 ID
 */
function generateRaidId() {
  return `raid_${Date.now()}_${Math.random().toString(36).substring(2, 9)}`;
}

/**
 * 解析 JSON 存档
 */
function parseProfile(raw) {
  try {
    const data = deserializeJson(raw);
    return { ok: true, data };
  } catch (err) {
    return { ok: false, error: `JSON parse failed: ${err.message}` };
  }
}

/**
 * 校验档案数据完整性
 */
function validateProfile(data) {
  const errors = [];
  
  // 必须字段
  if (!data.schemaVersion) errors.push('missing schemaVersion');
  if (!data.profileId) errors.push('missing profileId');
  if (!data.createdAt) errors.push('missing createdAt');
  if (!data.updatedAt) errors.push('missing updatedAt');
  
  // 版本检查
  if (data.schemaVersion > SCHEMA_VERSION) {
    errors.push(`schemaVersion ${data.schemaVersion} > current ${SCHEMA_VERSION}`);
  }
  
  // 数据结构
  if (typeof data.stash !== 'object') errors.push('stash must be object');
  if (typeof data.materials !== 'object') errors.push('materials must be object');
  if (typeof data.blueprints !== 'object') errors.push('blueprints must be object');
  if (typeof data.loadout !== 'object') errors.push('loadout must be object');
  if (typeof data.stats !== 'object') errors.push('stats must be object');
  
  // 材料数量校验
  if (!validateMaterials(data.materials)) {
    errors.push('materials contain invalid values');
  }
  
  return { ok: errors.length === 0, errors };
}

/**
 * 校验材料数据（非负整数）
 */
function validateMaterials(materials) {
  for (const [id, count] of Object.entries(materials)) {
    if (!Number.isInteger(count) || count < 0) return false;
    if (count > 999999) return false; // 防止溢出
  }
  return true;
}

/**
 * 深拷贝（结算 / 迁移 / 回滚专用）。JSON 往返会把 Infinity / NaN 抹成 null、
 * 把 undefined 属性整键丢弃，从而破坏「武器备弹 ∞（payload.reserve:
 * Infinity）」这类 payload 语义与逐字节回滚 —— 这里优先用 structuredClone
 * （Node 17+ / 现代浏览器原生保留 Infinity / undefined），不支持时回退 JSON。
 */
function cloneData(value) {
  if (value === undefined) return undefined;
  if (typeof structuredClone === 'function') {
    try { return structuredClone(value); } catch { /* 数据含不可克隆引用时回退 */ }
  }
  return value === null ? null : JSON.parse(JSON.stringify(value));
}

function storedKind(item) {
  return item?.slotKind ?? item?.kind ?? item?.type ?? null;
}

function storedDefId(item) {
  const kind = storedKind(item);
  if (item?.defId) return item.defId;
  if (kind === 'material') return item?.materialId ?? item?.itemId;
  if (kind === 'blueprint') return item?.blueprintId ?? item?.targetId;
  return item?.blueprintId ?? item?.itemId ?? item?.materialId;
}

function makeStashId() {
  return `stash_${Date.now().toString(36)}_${Math.random().toString(36).slice(2, 9)}`;
}

function settlementItem(raw) {
  if (!raw || typeof raw !== 'object') return null;
  const kind = storedKind(raw);
  const defId = storedDefId(raw);
  if (!kind || !defId) return null;
  // Keep old public fields while producing the v2 flat instance shape where possible.
  const item = {
    ...cloneData(raw),
    instanceId: raw.instanceId ?? raw.lootId ?? makeStashId(),
    slotKind: raw.slotKind ?? kind,
    defId: raw.defId ?? defId,
    name: raw.name ?? defId,
    quantity: Math.max(1, Number.isFinite(raw.quantity) ? Math.floor(raw.quantity) : 1),
    stackMax: Math.max(1, Number.isFinite(raw.stackMax) ? Math.floor(raw.stackMax) : 1),
    value: Number.isFinite(raw.value) ? raw.value : 0,
    payload: { ...(raw.payload ?? {}) },
  };
  if (kind === 'material') {
    item.kind = 'material';
    item.itemId ??= item.defId;
    item.materialId ??= item.defId;
  }
  if (kind === 'blueprint') item.blueprintId ??= item.defId;
  return item;
}

/**
 * SaveStore 类 - 存档管理器
 */
export class SaveStore {
  constructor() {
    this.profile = null;
    this.pendingRaid = null;
    this.lastSavedRaidId = null;
  }
  
  /**
   * 初始化：读取 localStorage，校验，处理 pendingRaid
   * @returns {object} { ok, profile, warning }
   */
  init() {
    // 1. 读取档案
    const rawProfile = localStorage.getItem(STORAGE_KEY_PROFILE);
    
    if (!rawProfile) {
      // 首次启动，创建新档案
      this.profile = createDefaultProfile();
      this.saveProfile();
      return { ok: true, profile: this.profile, warning: null };
    }
    
    // 2. 解析档案
    const parsed = parseProfile(rawProfile);
    if (!parsed.ok) {
      return {
        ok: false,
        error: `Profile corrupted: ${parsed.error}`,
        canRecover: false,
      };
    }
    
    // 3. 校验档案
    const validated = validateProfile(parsed.data);
    if (!validated.ok) {
      return {
        ok: false,
        error: `Profile validation failed: ${validated.errors.join(', ')}`,
        canRecover: false,
      };
    }
    
    // 4. v1 → v2 只做加法迁移：旧 stash/materials/loadout/stats 等字段原样保留，
    //    新字段补默认。重复 init 会得到同一档案，不会生成或复制任何实例。
    const sourceVersion = parsed.data.schemaVersion;
    this.profile = this._migrateProfile(parsed.data);
    let warning = sourceVersion < SCHEMA_VERSION
      ? `Profile migrated from schema v${sourceVersion} to v${SCHEMA_VERSION}.`
      : null;
    if (sourceVersion < SCHEMA_VERSION && !this.saveProfile()) {
      return { ok: false, error: 'Profile migration could not be saved', canRecover: false };
    }
    
    // 5. 检查 pendingRaid
    const rawPending = localStorage.getItem(STORAGE_KEY_PENDING);
    
    if (rawPending) {
      try {
        const pending = deserializeJson(rawPending);
        
        if (pending.status === 'active') {
          // 任务中异常退出，按放弃/阵亡处理
          warning = `Unfinished raid detected (${pending.raidId}). Risk items lost.`;
          this._settlePendingAsAbandoned(pending);
          this.saveProfile();
        } else if (pending.status === 'settling') {
          // 结算过程中崩溃，应用固定结算；settledRaidIds 使恢复幂等。
          warning = `Settlement interrupted (${pending.raidId}). Applying saved result.`;
          this._applySettlement(pending.settlement, pending);
          this.saveProfile();
        }
        
        // 清除 pending
        localStorage.removeItem(STORAGE_KEY_PENDING);
      } catch (err) {
        warning = `Pending raid corrupted, cleared: ${err.message}`;
        localStorage.removeItem(STORAGE_KEY_PENDING);
      }
    }
    
    return { ok: true, profile: this.profile, warning };
  }
  
  /**
   * v1 → v3 档案迁移。这里不"修复"未知内容，也不重发任何物品：保留既有
   * stash 键和值，唯一写入是新 schemaVersion 与 v2 起的空 stashOverflow 容器。
   * 幂等：对任意 version < SCHEMA_VERSION 的输入重复 init 得到同一档案，
   * 不会生成或复制任何实例（v1 旧 shape 由 startRaid/loadout adapter 按
   * 字典键处理，不在迁移时改写旧物品对象 —— 不引入 Safe Pocket）。
   */
  _migrateProfile(data) {
    const defaults = createDefaultProfile();
    const profile = {
      ...defaults,
      ...data,
      schemaVersion: SCHEMA_VERSION,
      contentVersion: data.contentVersion ?? CONTENT_VERSION,
      stash: data.stash || {},
      stashCapacity: Number.isInteger(data.stashCapacity) && data.stashCapacity >= 0
        ? data.stashCapacity : DEFAULT_STASH_CAPACITY,
      stashOverflow: data.stashOverflow || {},
      materials: data.materials || {},
      blueprints: data.blueprints || {},
      loadout: { ...defaults.loadout, ...(data.loadout || {}) },
      stats: { ...defaults.stats, ...(data.stats || {}) },
      settings: data.settings || {},
      settledRaidIds: Array.isArray(data.settledRaidIds) ? data.settledRaidIds : [],
    };

    return profile;
  }

  // 旧的私有名保留给可能的调用方；迁移逻辑是唯一实现。
  _mergeDefaults(data) { return this._migrateProfile(data); }
  
  /**
   * 保存档案到 localStorage
   */
  saveProfile() {
    if (!this.profile) return false;
    
    this.profile.updatedAt = Date.now();
    
    try {
      const raw = serializeJson(this.profile);
      localStorage.setItem(STORAGE_KEY_PROFILE, raw);
      return true;
    } catch (err) {
      console.error('[SaveStore] Failed to save profile:', err);
      return false;
    }
  }
  
  /**
   * 更新装备配置
   */
  updateLoadout(loadout) {
    if (!this.profile) return false;
    this.profile.loadout = { ...this.profile.loadout, ...loadout };
    return this.saveProfile();
  }
  
  /**
   * 更新材料数量（delta 可正可负）
   */
  updateMaterial(materialId, delta) {
    if (!this.profile) return false;
    
    const current = this.profile.materials[materialId] || 0;
    const next = current + delta;
    
    if (next < 0) return false; // 材料不足
    
    if (next === 0) {
      delete this.profile.materials[materialId];
    } else {
      this.profile.materials[materialId] = next;
    }
    
    return this.saveProfile();
  }

  /** 仓库实际占用格数。材料/蓝图是计数或解锁位，不占此容量。 */
  getStashUsage() {
    return this.profile ? Object.keys(this.profile.stash).length : 0;
  }

  /**
   * 仅试算，不写状态。重复 instanceId 已存在时不额外占格，便于安全重放结算。
   */
  canStore(items = []) {
    if (!this.profile) return { ok: false, reason: 'No profile', capacity: 0, used: 0, required: 0 };
    const list = Array.isArray(items) ? items : [items];
    const seen = new Set(Object.keys(this.profile.stash));
    let required = 0;
    for (const raw of list) {
      if (!raw || typeof raw !== 'object') continue;
      const id = raw.instanceId;
      if (id && seen.has(id)) continue;
      if (id) seen.add(id);
      required++;
    }
    const used = this.getStashUsage();
    const capacity = this.profile.stashCapacity;
    return {
      ok: used + required <= capacity,
      capacity,
      used,
      required,
      available: Math.max(0, capacity - used),
    };
  }

  /**
   * 向仓库增加统一实例。容量不足的条目写入 stashOverflow 并完整返回，而不是
   * 覆盖/删除；调用者可把结果展示给玩家。传 persist:false 用于结算大事务。
   */
  addStashItems(items = [], { persist = true } = {}) {
    if (!this.profile) return { ok: false, reason: 'No profile', added: [], overflow: [] };
    const before = cloneData(this.profile);
    const list = Array.isArray(items) ? items : [items];
    const added = [];
    const overflow = [];
    const capacity = this.profile.stashCapacity;

    for (const raw of list) {
      if (!raw || typeof raw !== 'object') continue;
      const item = cloneData(raw);
      let id = item.instanceId || makeStashId();
      // 同 id 且同一条已经存在是幂等重放；不同来物绝不覆盖。overflow 也算
      // 已接收，避免 settling 恢复时把同一个实例再复制一份。
      // 比较走 serializeJson：reserve: Infinity 与 reserve: null 是两个
      // 不同实例，不能因 JSON 原生把 Infinity 抹成 null 而误判等值。
      const existing = this.profile.stash[id] ?? this.profile.stashOverflow[id];
      if (existing) {
        if (serializeJson(existing) === serializeJson(item)) {
          added.push(existing);
          continue;
        }
        do { id = makeStashId(); } while (this.profile.stash[id] || this.profile.stashOverflow[id]);
      }
      item.instanceId = id;
      if (this.getStashUsage() < capacity) {
        this.profile.stash[id] = item;
        added.push(item);
      } else {
        while (this.profile.stashOverflow[id] || this.profile.stash[id]) id = makeStashId();
        item.instanceId = id;
        this.profile.stashOverflow[id] = item;
        overflow.push(item);
      }
    }

    if (persist && !this.saveProfile()) {
      this.profile = before;
      return { ok: false, reason: 'Failed to save stash changes', added: [], overflow: list };
    }
    return {
      ok: overflow.length === 0,
      reason: overflow.length ? 'Stash capacity reached; items retained in overflow' : null,
      added,
      overflow,
      capacity,
      used: this.getStashUsage(),
    };
  }
  
  /**
   * 开始任务：预留风险物，写入 pendingRaid
   * @param {string} levelId - 关卡 ID
   * @param {string} difficulty - 难度标识。单一难度下恒为 'standard'，
   *   存档结构保留该字段以便历史档案兼容，不再有动态选择。
   * @param {object} loadout - 装备配置
   * @param {array} brought - 带入的风险物品 instanceId[]
   * @returns {string|null} raidId
   */
  startRaid(levelId, difficulty, loadout, brought = []) {
    if (!this.profile || this.pendingRaid) return null;

    const raidId = generateRaidId();
    const profileBefore = cloneData(this.profile);
    const riskedItems = {};
    for (const instanceId of new Set(Array.isArray(brought) ? brought : [])) {
      if (this.profile.stash[instanceId]) {
        const item = cloneData(this.profile.stash[instanceId]);
        item.instanceId ??= instanceId;
        riskedItems[instanceId] = item;
        delete this.profile.stash[instanceId]; // stash → pendingRaid 的唯一转移点
      }
    }

    const pending = {
      raidId,
      levelId,
      difficulty,
      loadout: cloneData(loadout ?? {}),
      riskedItems,
      status: 'active',
      startedAt: Date.now(),
    };

    try {
      // 先持久化 pending，刷新立即按放弃处理；失败则恢复仓库，不能吞风险物。
      localStorage.setItem(STORAGE_KEY_PENDING, serializeJson(pending));
      this.profile.stats.totalRaids++;
      if (!this.saveProfile()) throw new Error('Failed to save profile after starting raid');
    } catch (err) {
      this.profile = profileBefore;
      localStorage.removeItem(STORAGE_KEY_PENDING);
      console.error('[SaveStore] Failed to start raid transaction:', err);
      return null;
    }

    this.pendingRaid = pending;
    return raidId;
  }
  
  /**
   * 设置 pendingRaid 状态（用于测试）
   */
  setPendingStatus(status) {
    if (!this.pendingRaid) return false;
    this.pendingRaid.status = status;
    try {
      localStorage.setItem(STORAGE_KEY_PENDING, serializeJson(this.pendingRaid));
      return true;
    } catch (err) {
      return false;
    }
  }
  
  /**
   * 结算任务
   * @param {object} outcome
   *   - success: boolean
   *   - extracted: boolean
   *   - carriedLoot: array of { lootId, kind, materialId?, quality?, value? }
   *   - enemiesKilled: number
   *   - clearBonus: boolean
   */
  settleRaid(outcome = {}) {
    if (!this.profile || !this.pendingRaid) return { ok: false, error: 'No pending raid' };

    const raidId = this.pendingRaid.raidId;
    if (this.lastSavedRaidId === raidId || this.profile.settledRaidIds?.includes(raidId)) {
      return { ok: false, error: 'Raid already settled', duplicate: true };
    }

    // 先把固定结算写入 pending，随后才改 profile；刷新恢复可以安全重放该结果。
    const settlement = this._generateSettlement(outcome);
    this.pendingRaid.status = 'settling';
    this.pendingRaid.settlement = settlement;
    try {
      localStorage.setItem(STORAGE_KEY_PENDING, serializeJson(this.pendingRaid));
    } catch (err) {
      return { ok: false, error: 'Failed to save settlement' };
    }

    this._applySettlement(settlement, this.pendingRaid);
    // 先落 profile（含 settledRaidIds），再删 pending；两次写之间刷新会由 init()
    // 幂等重放，绝不会出现「pending 已删、档案尚未保存」而吞结算物。
    if (!this.saveProfile()) return { ok: false, error: 'Failed to save settled profile', settlement };
    this.pendingRaid = null;
    this.lastSavedRaidId = raidId;
    localStorage.removeItem(STORAGE_KEY_PENDING);
    return { ok: true, settlement };
  }

  /**
   * 生成固定、可重放的结算结果。旧 carriedLoot 的 kind/materialId 形状和
   * v2 ItemInstance 的 slotKind/defId 形状同时接受；未识别物品会进 droppedItems，
   * 但不会被悄悄吞掉。
   */
  _generateSettlement(outcome = {}) {
    const pending = this.pendingRaid;
    const settlement = {
      raidId: pending?.raidId ?? null,
      success: !!outcome.success,
      extracted: !!outcome.extracted,
      returnedItems: [],
      gainedMaterials: {},
      gainedBlueprints: [],
      gainedItems: [],
      droppedItems: [],
      lostItems: [],
      overflowItems: [],
      stats: {},
    };

    if (outcome.success && outcome.extracted) {
      settlement.returnedItems = Object.keys(pending?.riskedItems ?? {});
      for (const raw of (outcome.carriedLoot || [])) {
        const loot = settlementItem(raw);
        if (!loot) {
          settlement.droppedItems.push(cloneData(raw));
          continue;
        }
        // 带入风险实例已经走 returnedItems；即使运行时携带视图同时枚举到它，
        // 也不能再作为本局新收益入库一次。
        if (loot.instanceId && pending?.riskedItems?.[loot.instanceId]) continue;
        const kind = storedKind(loot);
        if (kind === 'material' && (loot.materialId || loot.defId)) {
          const id = loot.materialId ?? loot.defId;
          settlement.gainedMaterials[id] = (settlement.gainedMaterials[id] || 0) + loot.quantity;
        } else if (kind === 'blueprint' && (loot.blueprintId || loot.defId)) {
          settlement.gainedBlueprints.push(loot.blueprintId ?? loot.defId);
        } else if (['weapon', 'armor', 'grenade', 'consumable', 'attachment'].includes(kind)) {
          settlement.gainedItems.push(loot);
        } else {
          settlement.droppedItems.push(loot);
        }
      }

      if (outcome.clearBonus) {
        for (const matId in settlement.gainedMaterials) {
          settlement.gainedMaterials[matId] = Math.floor(settlement.gainedMaterials[matId] * 1.25);
        }
      }
      settlement.stats.extracted = true;
      settlement.stats.extractedWithLoot = true;
    } else if (outcome.success && !outcome.extracted) {
      settlement.returnedItems = Object.keys(pending?.riskedItems ?? {});
      settlement.stats.extracted = true;
      settlement.stats.extractedWithLoot = false;
    } else {
      settlement.lostItems = Object.keys(pending?.riskedItems ?? {});
      settlement.stats.died = true;
    }

    settlement.stats.enemiesKilled = outcome.enemiesKilled || 0;
    return settlement;
  }

  /**
   * 应用结算结果。pending 参数用于重启时恢复 settling 记录；每个 raidId 只允许
   * 应用一次。非材料物品走真实 stash 容量检查，超出部分写入 stashOverflow 并在
   * settlement.overflowItems 返回，绝不静默丢失。
   */
  _applySettlement(settlement, pending = this.pendingRaid) {
    if (!this.profile || !settlement) return { ok: false, reason: 'Missing settlement' };
    const raidId = settlement.raidId ?? pending?.raidId ?? null;
    if (raidId && this.profile.settledRaidIds?.includes(raidId)) {
      return { ok: true, duplicate: true };
    }

    const returned = [];
    for (const instanceId of settlement.returnedItems ?? []) {
      const item = pending?.riskedItems?.[instanceId];
      if (item) returned.push({ ...item, instanceId: item.instanceId ?? instanceId });
    }
    const stashResult = this.addStashItems(
      [...returned, ...(settlement.gainedItems ?? [])], { persist: false }
    );
    settlement.overflowItems = stashResult.overflow ?? [];

    for (const [matId, count] of Object.entries(settlement.gainedMaterials ?? {})) {
      this.profile.materials[matId] = (this.profile.materials[matId] || 0) + count;
    }
    for (const bpId of new Set(settlement.gainedBlueprints ?? [])) {
      this.profile.blueprints[bpId] = true;
    }

    if (settlement.stats?.extracted) {
      this.profile.stats.successfulExtractions++;
      this.profile.stats.itemsExtracted += (settlement.returnedItems?.length ?? 0)
        + Object.keys(settlement.gainedMaterials ?? {}).length
        + (settlement.gainedItems?.length ?? 0);
      this.profile.stats.materialsGained += Object.values(settlement.gainedMaterials ?? {})
        .reduce((sum, value) => sum + value, 0);
    }
    if (settlement.stats?.died) this.profile.stats.deaths++;
    this.profile.stats.enemiesKilled += settlement.stats?.enemiesKilled || 0;
    if (raidId) {
      this.profile.settledRaidIds ??= [];
      if (!this.profile.settledRaidIds.includes(raidId)) this.profile.settledRaidIds.push(raidId);
      if (this.profile.settledRaidIds.length > 32) this.profile.settledRaidIds.splice(0, this.profile.settledRaidIds.length - 32);
    }
    return { ok: true, overflow: settlement.overflowItems };
  }
  
  /**
   * 处理未结算任务（按放弃/阵亡）
   */
  _settlePendingAsAbandoned(pending) {
    // 正常路径中风险物已在 startRaid 时移出 stash；但若浏览器恰好在
    // pending 写入与 profile 写入之间崩溃，旧 profile 仍可能保留它们。
    // 用 pending 快照补删，确保刷新始终按放弃而不是意外返还风险物。
    for (const instanceId of Object.keys(pending?.riskedItems ?? {})) {
      delete this.profile.stash[instanceId];
    }
    this.profile.stats.deaths++;
  }
  
  /**
   * 重置存档
   */
  reset() {
    this.profile = createDefaultProfile();
    this.pendingRaid = null;
    this.lastSavedRaidId = null;
    
    localStorage.removeItem(STORAGE_KEY_PROFILE);
    localStorage.removeItem(STORAGE_KEY_PENDING);
    
    this.saveProfile();
  }
  
  /**
   * 获取当前档案（只读）。用 cloneData（structuredClone 优先）而不是
   * JSON 往返：JSON 会把 payload.reserve: Infinity 抹成 null（§3.2 武器
   * 备弹 ∞ 语义），不能让读取路径悄悄破坏实例 payload。
   */
  getProfile() {
    return this.profile ? cloneData(this.profile) : null;
  }
  
  /**
   * 获取 pendingRaid（只读）
   */
  getPendingRaid() {
    return this.pendingRaid ? cloneData(this.pendingRaid) : null;
  }
}

// 单例
let instance = null;

export function getSaveStore() {
  if (!instance) {
    instance = new SaveStore();
  }
  return instance;
}

// 测试辅助：重置单例
export function _resetSingleton() {
  instance = null;
}
