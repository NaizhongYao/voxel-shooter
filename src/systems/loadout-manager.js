/**
 * 装备状态管理器
 * 
 * 负责：
 * 1. 保存玩家当前的装备选择（枪械、部件、防护、手榴弹）
 * 2. 计算装备带来的综合属性变化
 * 3. 提供接口供 UI 和游戏实例读取
 * 4. 通过 sessionStorage 在页面重载后保持装备状态
 * 5. （批 2b-1）维护「局外整备 inventory」状态层：由四字段配置 + profile.stash
 *    派生的结构化背包视图（INVENTORY-SYSTEM-DESIGN.md §3.5 / §4.3），
 *    独立于 player.inventory 战局背包，供后续整备渲染与 beginRaid 风险物收集使用
 */

import {
  ATTACHMENTS,
  ATTACHMENT_SLOT,
  WEAPON_SLOTS,
  ARMOR_TYPES,
  GRENADE_TYPES,
  DEFAULT_LOADOUT,
} from './loadout-config.js';
import { WEAPONS } from './weapons.js';
import * as UnlockChecker from './unlock-checker.js';
import { getSaveStore } from './save-store.js';
import {
  createInventory,
  collectStashInstanceIds,
  grenadeStackMax,
  ItemInstance,
} from './inventory.js';

const WEAPONS_SUPPORTED = new Set(['pistol', 'pistolFast']);
const normalizeGrenadeId = (id) => id === 'frag' ? 'he' : (id === 'he' ? 'he' : 'flash');

/**
 * 装备管理器单例
 */
class LoadoutManager {
  constructor() {
    this.reset();
    this.loadFromStorage();
  }

  /**
   * 重置为默认装备
   */
  reset() {
    this.pistol = DEFAULT_LOADOUT.pistol;
    this.attachments = JSON.parse(JSON.stringify(DEFAULT_LOADOUT.attachments));
    this.armor = DEFAULT_LOADOUT.armor;
    this.grenade = DEFAULT_LOADOUT.grenade;
    this._inventory = null;   // 局外整备背包缓存（惰性派生，配置变更即失效）
  }

  /**
   * 设置手枪型号
   */
  setPistol(pistolId) {
    if (!pistolId || !WEAPONS_SUPPORTED.has(pistolId) || !WEAPONS[pistolId]) return false;
    this.pistol = pistolId;
    
    // 如果这把枪还没有部件配置，初始化空槽位
    if (!this.attachments[pistolId]) {
      this.attachments[pistolId] = {
        muzzle: null,
        optic: null,
        magazine: null,
        grip: null,
      };
    }
    
    this._inventory = null;
    this.saveToStorage();
    return true;
  }

  /**
   * 获取当前手枪的部件配置
   */
  getPistolAttachments() {
    return this.attachments[this.pistol] || {};
  }

  /**
   * 安装部件到当前手枪
   * 
   * @param {string} slotType - 插槽类型 (muzzle/optic/magazine/grip)
   * @param {string} attachmentId - 部件 ID，传 null 则卸下该槽位
   */
  installAttachment(slotType, attachmentId) {
    if (!this.attachments[this.pistol]) {
      this.attachments[this.pistol] = {
        muzzle: null,
        optic: null,
        magazine: null,
        grip: null,
      };
    }

    // 卸下部件
    if (!attachmentId) {
      this.attachments[this.pistol][slotType] = null;
      this._inventory = null;
      this.saveToStorage();
      return true;
    }

    // 检查部件是否存在
    const attachment = ATTACHMENTS[attachmentId];
    if (!attachment) return false;

    // 检查部件是否兼容当前枪械
    if (attachment.slot !== slotType) return false;
    if (attachment.compatibleWeapons.length > 0 &&
        !attachment.compatibleWeapons.includes(this.pistol)) {
      return false;
    }

    // 检查部件是否可用（配对蓝图实例：{当前手枪}_{部件id}）
    if (!UnlockChecker.isEquippable('attachment', attachmentId, this.pistol)) return false;

    // 安装部件
    this.attachments[this.pistol][slotType] = attachmentId;
    this._inventory = null;
    this.saveToStorage();
    return true;
  }

  /**
   * 设置防护装备
   */
  setArmor(armorId) {
    const armor = ARMOR_TYPES[armorId];
    if (!armor || !UnlockChecker.isEquippable('armor', armorId)) return false;
    this.armor = armorId;
    this._inventory = null;
    this.saveToStorage();
    return true;
  }

  /**
   * 设置手榴弹类型
   */
  setGrenade(grenadeId) {
    const id = normalizeGrenadeId(grenadeId);
    const grenade = GRENADE_TYPES[id];
    if (!grenade || !UnlockChecker.isEquippable('grenade', id)) return false;
    this.grenade = id;
    this._inventory = null;
    this.saveToStorage();
    return true;
  }

  /**
   * 计算当前装备的综合属性倾向
   * 
   * 返回四个维度的评分（0-100）：
   * - stealth: 潜行倾向
   * - defense: 防御倾向
   * - mobility: 机动倾向
   * - noise: 噪音水平
   */
  calculateTendencies() {
    let stealth = 50;
    let defense = 50;
    let mobility = 50;
    let noise = 50;

    // 1. 防护装备的影响
    const armorData = ARMOR_TYPES[this.armor];
    if (armorData) {
      const effects = armorData.effects;
      
      // 护甲上限影响防御
      if (effects.armorMax) {
        defense += (effects.armorMax - 200) / 200 * 30;
      }
      
      // 移动速度影响机动
      if (effects.moveSpeedMult) {
        mobility += (effects.moveSpeedMult - 1.0) * 100;
      }
      
      // 噪音半径影响潜行和噪音
      if (effects.noiseRadiusMult) {
        const noiseDelta = (1.0 - effects.noiseRadiusMult) * 40;
        stealth += noiseDelta;
        noise -= noiseDelta;
      }
      
      // 探测倍率影响潜行
      if (effects.detectionMult) {
        stealth += (1.0 - effects.detectionMult) * 30;
      }
    }

    // 2. 枪械部件的影响
    const pistolAttachments = this.getPistolAttachments();
    Object.values(pistolAttachments).forEach(attachmentId => {
      if (!attachmentId) return;
      const attachment = ATTACHMENTS[attachmentId];
      if (!attachment) return;

      const effects = attachment.effects;
      
      // 消音器大幅提升潜行，降低噪音
      if (effects.noise) {
        const noiseDelta = -effects.noise;
        stealth += noiseDelta * 1.2;
        noise -= noiseDelta * 1.2;
      }
      
      // 精度类部件略微提升防御（更稳定的火力输出）
      if (effects.spread && effects.spread < 0) {
        defense += Math.abs(effects.spread) * 3;
      }
      
      // 扩容弹匣提升防御
      if (effects.magCapacity && effects.magCapacity > 0) {
        defense += effects.magCapacity * 1.5;
      }
      
      // 后坐力控制提升防御
      if (effects.recoilMult && effects.recoilMult < 0) {
        defense += Math.abs(effects.recoilMult) * 25;
      }
      
      // 移动速度影响机动
      if (effects.moveSpeedMult) {
        mobility += (effects.moveSpeedMult - 1.0) * 100;
      }
    });

    // 3. 手榴弹的影响
    if (this.grenade === 'flash') {
      stealth += 10;  // 闪光弹不杀人，相对更隐蔽
      noise -= 5;
    } else if (this.grenade === 'he') {
      defense += 15;  // 高爆弹更适合正面清房
      noise += 10;
    }

    // 钳制到 0-100
    return {
      stealth: Math.max(0, Math.min(100, Math.round(stealth))),
      defense: Math.max(0, Math.min(100, Math.round(defense))),
      mobility: Math.max(0, Math.min(100, Math.round(mobility))),
      noise: Math.max(0, Math.min(100, Math.round(noise))),
    };
  }

  /**
   * 获取当前装备对枪械数值的修正
   * 
   * 返回一个修正对象，用于在创建 WeaponInstance 时应用。
   */
  getWeaponModifiers(weaponId) {
    const modifiers = {
      damage: 0,
      rof: 0,
      spread: 0,
      mag: 0,
      reload: 0,
      range: 0,
      noise: 0,
      recoilKickMult: 1.0,
      recoilClimbMult: 1.0,
      recoilShakeMult: 1.0,
      muzzleFlashMult: 1.0,
      adsTimeMult: 1.0,
      switchTimeMult: 1.0,
    };

    const attachments = this.attachments[weaponId];
    if (!attachments) return modifiers;

    Object.values(attachments).forEach(attachmentId => {
      if (!attachmentId) return;
      const attachment = ATTACHMENTS[attachmentId];
      if (!attachment) return;

      const effects = attachment.effects;

      // 绝对值修正
      if (effects.noise !== undefined) modifiers.noise += effects.noise;
      if (effects.range !== undefined) modifiers.range += effects.range;
      if (effects.spread !== undefined) modifiers.spread += effects.spread;
      if (effects.magCapacity !== undefined) modifiers.mag += effects.magCapacity;

      // 乘法修正
      if (effects.recoilMult !== undefined) {
        const mult = 1.0 + effects.recoilMult;
        modifiers.recoilKickMult *= mult;
        modifiers.recoilClimbMult *= mult;
        modifiers.recoilShakeMult *= mult;
      }
      
      if (effects.reloadTimeMult !== undefined) {
        modifiers.reload += effects.reloadTimeMult;
      }
      
      if (effects.muzzleFlashMult !== undefined) {
        modifiers.muzzleFlashMult *= (1.0 + effects.muzzleFlashMult);
      }
      
      if (effects.adsTimeMult !== undefined) {
        modifiers.adsTimeMult *= (1.0 + effects.adsTimeMult);
      }
      
      if (effects.switchTimeMult !== undefined) {
        modifiers.switchTimeMult *= (1.0 + effects.switchTimeMult);
      }
      
      if (effects.moveSpeedMult !== undefined) {
        // 部件对移动速度的影响会传递到玩家属性
        // 这里先记录，后续 getPlayerModifiers 会汇总
      }
    });

    return modifiers;
  }

  /**
   * 获取当前装备对玩家属性的修正
   * 
   * 返回一个修正对象，用于在创建 Player 时应用。
   */
  getPlayerModifiers() {
    const modifiers = {
      hpMax: 100,
      armorMax: 200,
      moveSpeedMult: 1.0,
      noiseRadiusMult: 1.0,
      detectionMult: 1.0,
      // 护甲 id 同时是 rig 配色表（rig.js ARMOR_KIT_COLORS）的键：
      // 视觉身份直接跟随装备本身，不再有独立的 visualKit 翻译字段。
      visualKit: 'standard',
      carryCapBonus: 0,     // carrier：携带栏格数加成（加到 PLAYER.carryCap）
      litExposureMul: 1.0,  // chameleon：光照暴露倍率（只乘「灯下/开灯」那一项）
      weaponSlots: 0,        // dualist：额外主武器槽（武器系统只消费此字段）
      grenadeBonus: 0,      // dualist：手雷基数加减（允许负数，调用方钳 ≥0）
    };

    // 防护装备的影响
    const armorData = ARMOR_TYPES[this.armor];
    if (armorData && armorData.effects) {
      const effects = armorData.effects;
      if (effects.armorMax !== undefined) modifiers.armorMax = effects.armorMax;
      if (effects.moveSpeedMult !== undefined) modifiers.moveSpeedMult *= effects.moveSpeedMult;
      if (effects.noiseRadiusMult !== undefined) modifiers.noiseRadiusMult *= effects.noiseRadiusMult;
      if (effects.detectionMult !== undefined) modifiers.detectionMult *= effects.detectionMult;
      if (effects.carryCapBonus !== undefined) modifiers.carryCapBonus += effects.carryCapBonus;
      if (effects.litExposureMul !== undefined) modifiers.litExposureMul *= effects.litExposureMul;
      if (effects.weaponSlots !== undefined) modifiers.weaponSlots += effects.weaponSlots;
      if (effects.grenadeBonus !== undefined) modifiers.grenadeBonus += effects.grenadeBonus;
      // visualKit 的值就是护甲 id，rig.setArmorKit 按它查 ARMOR_KIT_COLORS
      modifiers.visualKit = this.armor;
    }

    // 枪械部件中可能也有移动速度影响
    const pistolAttachments = this.getPistolAttachments();
    Object.values(pistolAttachments).forEach(attachmentId => {
      if (!attachmentId) return;
      const attachment = ATTACHMENTS[attachmentId];
      if (!attachment || !attachment.effects) return;
      
      if (attachment.effects.moveSpeedMult !== undefined) {
        modifiers.moveSpeedMult *= attachment.effects.moveSpeedMult;
      }
    });

    return modifiers;
  }

  /**
   * 获取可用部件列表（筛选当前枪械兼容且已解锁的）
   */
  getAvailableAttachments(slotType) {
    return Object.values(ATTACHMENTS).filter(att => {
      if (att.slot !== slotType) return false;
      if (!UnlockChecker.isEquippable('attachment', att.id, this.pistol)) return false;
      if (att.compatibleWeapons.length === 0) return true;
      return att.compatibleWeapons.includes(this.pistol);
    });
  }

  /**
   * 导出为简洁对象（用于传递给游戏实例）
   */
  export() {
    return {
      pistol: this.pistol,
      attachments: JSON.parse(JSON.stringify(this.attachments)),
      armor: this.armor,
      grenade: this.grenade,
    };
  }

  /**
   * 从简洁对象导入
   */
  import(data) {
    if (data.pistol && WEAPONS_SUPPORTED.has(data.pistol)) this.pistol = data.pistol;
    if (data.attachments) this.attachments = JSON.parse(JSON.stringify(data.attachments));
    if (data.armor && ARMOR_TYPES[data.armor]) this.armor = data.armor;
    if (data.grenade) this.grenade = normalizeGrenadeId(data.grenade);
    this._inventory = null;
    this.saveToStorage();
  }

  /**
   * 保存到 sessionStorage
   */
  saveToStorage() {
    try {
      sessionStorage.setItem('zcode_loadout', JSON.stringify(this.export()));
    } catch (e) {
      console.warn('Failed to save loadout to sessionStorage:', e);
    }
  }

  /**
   * 从 sessionStorage 加载
   */
  loadFromStorage() {
    try {
      const saved = sessionStorage.getItem('zcode_loadout');
      if (saved) {
        this.import(JSON.parse(saved));
        return;
      }
      const legacy = sessionStorage.getItem('loadoutChoice');
      if (!legacy) return;
      const data = JSON.parse(legacy);
      const pistol = data.pistol === 'pistolFast' ? 'pistolFast' : 'pistol';
      this.pistol = pistol;
      this.grenade = normalizeGrenadeId(data.nade);
      this._inventory = null;
      this.saveToStorage();
    } catch (e) {
      console.warn('Failed to load loadout from sessionStorage:', e);
    }
  }

  // ═══════════════════════════════════════════════════════════════════════
  // 局外整备 inventory 状态层（批 2b-1 · INVENTORY-SYSTEM-DESIGN.md §3.5 / §4.3）
  //
  // 这是「出击前整备计划」的结构化视图，由 loadout 四字段配置 + profile.stash
  // 派生，与玩家战局背包（player.inventory）是两个对象。两个同步点：
  //   syncInventoryFromLoadout()  ← 配置变化 / 打开整备面板时重建视图
  //   syncLoadoutFromInventory()  ← 确认出击 / 面板关闭时写回四字段配置
  // 保底规则（§1 不变量 1 / §2.5.2）：pistol / standard / flash 不需要 stash
  // 实例；非保底装备只有真实 stash 实例才可进入整备背包。standard 的表达形式
  // 是护甲槽为空（armor === null），它没有 instanceId，结构上不可能成为风险物。
  //
  // 持久化策略：整备背包不进 sessionStorage —— 它完全由四字段配置（已持久化）
  // 与 profile.stash（localStorage）可恢复派生，因此 export()/saveToStorage()
  // 的字段契约保持不变，也不会把整个 stash 复制进 sessionStorage。
  // ═══════════════════════════════════════════════════════════════════════

  /**
   * 仓库只读视图（profile.stash，instanceId → item）。
   * 档案未初始化 / stash 缺失时返回空对象，绝不抛错。
   */
  getStash() {
    const store = getSaveStore();
    const profile = store.getProfile();
    if (!profile || typeof profile.stash !== 'object') return {};
    return profile.stash;
  }

  /**
   * 在 stash 中查找「类型 + 定义 id」匹配的真实实例（§4.3 风险物链路）。
   * 兼容两代 stash 形状：unlock-checker 契约 { instanceId, type, blueprintId }
   * 与设计 §3.1 的 ItemInstance 形状 { instanceId, slotKind, defId }。
   * instanceId 以 stash 键为准 —— startRaid / settleRaid 按键删除与返还。
   *
   * @param {object} stash profile.stash（instanceId → item）
   * @param {string} kind  'weapon' | 'armor' | 'grenade'
   * @param {string} defId 定义表主键
   * @returns {object|null} 实例浅拷贝（instanceId 已对齐 stash 键）；无匹配返回 null
   */
  _findStashInstance(stash, kind, defId) {
    for (const [key, item] of Object.entries(stash)) {
      if (!item || typeof item !== 'object') continue;
      const itemKind = item.slotKind ?? item.kind ?? item.type;
      const itemDefId = item.defId ?? item.blueprintId;
      if (itemKind === kind && itemDefId === defId) {
        return { ...item, instanceId: item.instanceId ?? key };
      }
    }
    return null;
  }

  /**
   * 手雷实例：quantity = 开局给满一格（GRENADE_TYPES[id].count，§2.3.1），
   * 并钳到当前护甲下的堆叠上限（dualist 的 grenadeBonus -1，§2.3.2 规则 4）。
   * 不把 armorId 写进实例字段 —— 堆叠上限按当前护甲现算（§3.5 派生而非存储）。
   */
  _makeGrenadeInstance(grenadeId, instanceId, armorId) {
    const stackMax = grenadeStackMax(grenadeId, armorId);
    const quantity = Math.min(GRENADE_TYPES[grenadeId]?.count ?? 1, stackMax);
    const overrides = { quantity, stackMax };
    if (instanceId) overrides.instanceId = instanceId;
    return ItemInstance('grenade', grenadeId, overrides);
  }

  /**
   * 局外整备背包 getter。惰性构建 + 配置变更失效：
   * - 同一次派生后返回同一对象引用（getter 稳定），UI 可在面板会话内直接读写；
   * - 四字段配置的任何变更（setPistol / installAttachment / setArmor /
   *   setGrenade / import / reset）都会使缓存失效，下一次调用重新派生。
   */
  getInventory() {
    if (!this._inventory) this.syncInventoryFromLoadout();
    return this._inventory;
  }

  /**
   * 从四字段配置 + profile.stash 重建整备背包（两个同步点之一）。
   *
   * 派生规则（全部是「能不能真正带出去」的事实判定）：
   * - pistol：恒非空保底（§1 不变量 1），配件镜像进 payload.attachments（§3.3）；
   * - armor：standard 表达为空槽（§2.5.2）；非保底护甲只有 stash 真实实例才入槽，
   *   否则同样落回空槽（= standard 地板）；
   * - grenade：flash 保底直接放入；非保底手雷只有 stash 真实实例才入格，
   *   没有实例则留空（玩家实际带不出去，写回时落回 flash 地板）；
   * - primary / misc：当前配置没有来源，保持空槽（批 2b-2 拖拽接线后才有内容）。
   *
   * @returns {object} createInventory 形状的整备背包（同对象会挂到 getInventory）
   */
  syncInventoryFromLoadout() {
    const stash = this.getStash();

    // 1. 护甲槽：先解析 —— 它的 defId 决定其余槽位数量（§2.5.1 单向依赖）。
    let armorItem = null;
    if (this.armor && this.armor !== 'standard') {
      const inst = this._findStashInstance(stash, 'armor', this.armor);
      if (inst) {
        armorItem = ItemInstance('armor', this.armor, { instanceId: inst.instanceId });
      }
    }

    const inv = createInventory({ armor: armorItem });

    // 2. 手枪位：恒非空保底（§1 不变量 1）。配件与 loadoutManager.attachments
    //    同形状（{muzzle,optic,magazine,grip}），getWeaponModifiers 零改动兼容。
    const pistolAtt = this.attachments[this.pistol] ?? {
      muzzle: null, optic: null, magazine: null, grip: null,
    };
    inv.pistol = ItemInstance('weapon', this.pistol, {
      payload: { attachments: JSON.parse(JSON.stringify(pistolAtt)) },
    });

    // 3. 手雷格：flash 保底 / 非保底需真实 stash 实例。
    if (this.grenade) {
      let grenadeItem = null;
      if (this.grenade === 'flash') {
        grenadeItem = this._makeGrenadeInstance('flash', null, inv.armorId);
      } else {
        const inst = this._findStashInstance(stash, 'grenade', this.grenade);
        if (inst) {
          grenadeItem = this._makeGrenadeInstance(this.grenade, inst.instanceId, inv.armorId);
        }
      }
      if (grenadeItem) inv.grenade[0] = grenadeItem;
    }

    this._inventory = inv;
    return inv;
  }

  /**
   * 把整备背包写回四字段配置（两个同步点之二：确认出击 / 面板关闭）。
   * 单向派生回写：护甲槽空 → 'standard'（§2.5.2）；手雷格空 → 保底 'flash'。
   * 只写配置并落盘，不重建背包 —— 背包是本次编辑会话的源，写完仍是同一对象。
   *
   * 注意 normalizeGrenadeId 会把任何非 frag/he 的 id 折成 'flash'（它是为
   * 旧存档写的），所以这里不能走它 —— 只做 'frag' → 'he' 的旧别名映射。
   */
  syncLoadoutFromInventory() {
    const inv = this.getInventory();

    if (inv.pistol?.defId && WEAPONS_SUPPORTED.has(inv.pistol.defId)) {
      this.pistol = inv.pistol.defId;
      const att = inv.pistol.payload?.attachments;
      if (att) {
        this.attachments[inv.pistol.defId] = JSON.parse(JSON.stringify(att));
      }
    }

    this.armor = inv.armorId;   // 空槽 = 'standard'
    const grenadeId = inv.grenade.find(Boolean)?.defId;
    this.grenade = (grenadeId && GRENADE_TYPES[grenadeId])
      ? (grenadeId === 'frag' ? 'he' : grenadeId)
      : 'flash';

    this.saveToStorage();
    return this;
  }

  /**
   * 本局风险物收集入口（§4.3）：beginRaid() 用它作为 startRaid 的 brought 参数。
   * 复用 inventory.js 的 collectStashInstanceIds —— 保底装备（手枪 / standard /
   * flash）被 _isDefaultGear 自动排除，只有真实存在于 stash 的实例被计入。
   * 无论背包缓存是否过期（如上一局死亡销毁了 stash 实例），这里按当前 stash
   * 实时过滤，结果恒正确 —— main.js 不需要重复写过滤逻辑。
   *
   * @returns {string[]} 本局风险物 instanceId 列表
   */
  collectRiskInstanceIds() {
    return collectStashInstanceIds(this.getInventory(), this.getStash());
  }

  /**
   * 获取完整的装备摘要（供 UI 显示）
   */
  getSummary() {
    const pistolAttachments = this.getPistolAttachments();
    const armorData = ARMOR_TYPES[this.armor];
    const grenadeData = GRENADE_TYPES[this.grenade];
    const tendencies = this.calculateTendencies();

    return {
      pistol: {
        id: this.pistol,
        attachments: {
          muzzle: pistolAttachments.muzzle ? ATTACHMENTS[pistolAttachments.muzzle] : null,
          optic: pistolAttachments.optic ? ATTACHMENTS[pistolAttachments.optic] : null,
          magazine: pistolAttachments.magazine ? ATTACHMENTS[pistolAttachments.magazine] : null,
          grip: pistolAttachments.grip ? ATTACHMENTS[pistolAttachments.grip] : null,
        },
      },
      armor: armorData,
      grenade: grenadeData,
      tendencies,
    };
  }
}

// 导出单例
export const loadoutManager = new LoadoutManager();
