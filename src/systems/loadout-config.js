/**
 * 装备整备系统配置表
 * 
 * 包含：枪械部件、防护装备、手榴弹类型的完整定义。
 * 这里是装备面板的数据源，不直接影响战斗数值（战斗数值由 player.js / weapons.js 读取）。
 */

// ═══════════════════════════════════════════════════════════════════════════
// 枪械部件
// ═══════════════════════════════════════════════════════════════════════════

/**
 * 枪械部件插槽类型
 */
export const ATTACHMENT_SLOT = {
  MUZZLE: 'muzzle',     // 枪口：消音器、补偿器、制退器
  OPTIC: 'optic',       // 瞄具：红点、全息、倍镜
  MAGAZINE: 'magazine', // 弹匣：标准、扩容、快换
  GRIP: 'grip',         // 握把/枪托：战术、垂直、稳定
};

/**
 * 枪械部件库
 * 
 * 每个部件定义：
 * - id: 唯一标识
 * - name: 显示名称
 * - slot: 适用的插槽类型
 * - compatibleWeapons: 支持的枪械 ID 列表（空数组 = 所有枪支持）
 * - effects: 属性修改（加减百分比或绝对值）
 * - unlocked: 是否已解锁（后续可关联关卡进度）
 */
export const ATTACHMENTS = {
  // ── 枪口部件 ──
  suppressor1: {
    id: 'suppressor1',
    name: '消音器 Mk.I',
    slot: ATTACHMENT_SLOT.MUZZLE,
    compatibleWeapons: ['pistol', 'pistolFast', 'smg', 'ar'],
    effects: {
      noise: -10,        // 噪音 -10
      range: -2,         // 射程 -2
    },
    unlocked: true,
    desc: '降低枪声，减少敌人调查半径',
  },
  
  compensator: {
    id: 'compensator',
    name: '补偿器',
    slot: ATTACHMENT_SLOT.MUZZLE,
    compatibleWeapons: ['pistolFast', 'smg', 'ar'],
    effects: {
      recoilMult: -0.15,  // 后坐力 -15%
      noise: 2,           // 噪音 +2
    },
    unlocked: true,
    desc: '减少后坐力，但声音略大',
  },

  flashHider: {
    id: 'flashHider',
    name: '消焰器',
    slot: ATTACHMENT_SLOT.MUZZLE,
    compatibleWeapons: ['ar', 'dmr'],
    effects: {
      muzzleFlashMult: -0.6,  // 枪口焰 -60%
      noise: -3,
    },
    unlocked: false,
    desc: '抑制枪口焰，夜间射击不易暴露',
  },

  // ── 瞄具部件 ──
  redDot: {
    id: 'redDot',
    name: '红点瞄具',
    slot: ATTACHMENT_SLOT.OPTIC,
    compatibleWeapons: ['pistol', 'pistolFast', 'smg', 'ar'],
    effects: {
      spread: -0.4,       // 散布 -0.4 度
      adsTimeMult: 0.05,  // ADS 时间 +5%
    },
    unlocked: true,
    desc: '提升精度，ADS 稳定性更好',
  },

  holo: {
    id: 'holo',
    name: '全息瞄具',
    slot: ATTACHMENT_SLOT.OPTIC,
    compatibleWeapons: ['smg', 'ar'],
    effects: {
      spread: -0.6,
      adsTimeMult: 0.08,
    },
    unlocked: false,
    desc: '宽视野，适合中近距快速瞄准',
  },

  scope2x: {
    id: 'scope2x',
    name: '2 倍镜',
    slot: ATTACHMENT_SLOT.OPTIC,
    compatibleWeapons: ['ar', 'dmr'],
    effects: {
      spread: -0.8,
      adsTimeMult: 0.12,
    },
    unlocked: false,
    desc: '中距精准射击，切镜稍慢',
  },

  // ── 弹匣部件 ──
  extendedMag: {
    id: 'extendedMag',
    name: '扩容弹匣',
    slot: ATTACHMENT_SLOT.MAGAZINE,
    compatibleWeapons: ['pistol', 'pistolFast', 'smg', 'ar'],
    effects: {
      magCapacity: 6,       // 弹容量 +6
      reloadTimeMult: 0.08, // 换弹时间 +8%
    },
    unlocked: true,
    desc: '增加弹容量，换弹稍慢',
  },

  quickMag: {
    id: 'quickMag',
    name: '快换弹匣',
    slot: ATTACHMENT_SLOT.MAGAZINE,
    compatibleWeapons: ['pistol', 'pistolFast', 'smg', 'ar', 'dmr'],
    effects: {
      reloadTimeMult: -0.15, // 换弹时间 -15%
    },
    unlocked: false,
    desc: '换弹速度大幅提升',
  },

  // ── 握把 / 枪托部件 ──
  tacticalGrip: {
    id: 'tacticalGrip',
    name: '战术握把',
    slot: ATTACHMENT_SLOT.GRIP,
    compatibleWeapons: ['pistol', 'pistolFast', 'smg', 'ar'],
    effects: {
      recoilMult: -0.12,
      switchTimeMult: 0.05,  // 切枪时间 +5%
    },
    unlocked: true,
    desc: '减少后坐力，切枪稍慢',
  },

  verticalGrip: {
    id: 'verticalGrip',
    name: '垂直握把',
    slot: ATTACHMENT_SLOT.GRIP,
    compatibleWeapons: ['smg', 'ar'],
    effects: {
      recoilMult: -0.18,
      adsTimeMult: 0.08,
    },
    unlocked: false,
    desc: '大幅减少后坐力，但举枪较慢',
  },

  precisionStock: {
    id: 'precisionStock',
    name: '精准枪托',
    slot: ATTACHMENT_SLOT.GRIP,
    compatibleWeapons: ['ar', 'dmr'],
    effects: {
      recoilMult: -0.20,
      moveSpeedMult: -0.04,  // 移动速度 -4%
    },
    unlocked: false,
    desc: '后坐力大幅降低，机动性略降',
  },

  // ── 霰弹枪专属部件（新增 3 个，填满 muzzle/optic/grip；magazine 保持 null）──
  choke: {
    id: 'choke',
    name: '喉缩器',
    slot: ATTACHMENT_SLOT.MUZZLE,
    compatibleWeapons: ['shotgun'],
    effects: {
      spread: -6,      // 弹丸散布 -6°（18° → 12°，收束弹丸锥）
      noise: 2,        // 枪口爆音更集中，噪音 +2（40 → 42）
    },
    unlocked: false,
    desc: '收束弹丸散布，中近距离命中更稳，枪声略大',
  },

  ghostRing: {
    id: 'ghostRing',
    name: '鬼环瞄具',
    slot: ATTACHMENT_SLOT.OPTIC,
    compatibleWeapons: ['shotgun'],
    effects: {
      adsTimeMult: -0.35,  // 举枪瞄准 -35%（0.25s → 0.16s，贴脸瞬瞄）
      spread: -1.5,        // 散布 -1.5°
    },
    unlocked: false,
    desc: '超大孔径环状照门，贴脸交火瞬间瞄准',
  },

  pumpGrip: {
    id: 'pumpGrip',
    name: '战术泵动握把',
    slot: ATTACHMENT_SLOT.GRIP,
    compatibleWeapons: ['shotgun'],
    effects: {
      recoilMult: -0.20,     // 后坐力 -20%（kick 1.0→0.8 / climb 5.5→4.4 / shake 0.55→0.44）
      switchTimeMult: 0.05,  // 换枪时间 +5%（0.35s → 0.37s）
    },
    unlocked: false,
    desc: '抑制泵动连发的后坐抬枪，换枪稍慢',
  },
};

/**
 * 枪械的默认插槽配置
 * 
 * 不同枪械支持不同的插槽组合。
 */
export const WEAPON_SLOTS = {
  pistol: [
    ATTACHMENT_SLOT.MUZZLE,
    ATTACHMENT_SLOT.OPTIC,
    ATTACHMENT_SLOT.MAGAZINE,
    ATTACHMENT_SLOT.GRIP,
  ],
  pistolFast: [
    ATTACHMENT_SLOT.MUZZLE,
    ATTACHMENT_SLOT.OPTIC,
    ATTACHMENT_SLOT.MAGAZINE,
    ATTACHMENT_SLOT.GRIP,
  ],
  smg: [
    ATTACHMENT_SLOT.MUZZLE,
    ATTACHMENT_SLOT.OPTIC,
    ATTACHMENT_SLOT.MAGAZINE,
    ATTACHMENT_SLOT.GRIP,
  ],
  ar: [
    ATTACHMENT_SLOT.MUZZLE,
    ATTACHMENT_SLOT.OPTIC,
    ATTACHMENT_SLOT.MAGAZINE,
    ATTACHMENT_SLOT.GRIP,
  ],
  dmr: [
    ATTACHMENT_SLOT.MUZZLE,
    ATTACHMENT_SLOT.OPTIC,
    ATTACHMENT_SLOT.MAGAZINE,
    ATTACHMENT_SLOT.GRIP,
  ],
  shotgun: [
    ATTACHMENT_SLOT.MUZZLE,    // 喉缩器
    ATTACHMENT_SLOT.OPTIC,     // 霰弹瞄具
    null,                      // 管式弹仓不支持更换
    ATTACHMENT_SLOT.GRIP,
  ],
};

// ═══════════════════════════════════════════════════════════════════════════
// 防护装备
// ═══════════════════════════════════════════════════════════════════════════

/**
 * 防护装备类型
 * 
 * 每套装备包含：头盔、背心、护膝等，但UI上作为一个整体选择。
 * 视觉层：8 套护甲共享同一套几何部件，外观差异只有颜色 ——
 * 专属配色在 player/rig.js 的 ARMOR_KIT_COLORS（键 = 护甲 id）。
 * 本表只承载数值与文案，不再有 visualKit 之类的视觉复用字段。
 */
export const ARMOR_TYPES = {
  light: {
    id: 'light',
    name: '幽影软甲',
    nameEn: 'STEALTH RIG',
    desc: '轻型凯夫拉背心，适合潜行',
    effects: {
      armorMax: 150,          // 护甲上限 150
      moveSpeedMult: 1.08,    // 移动速度 +8%
      noiseRadiusMult: 0.75,  // 脚步噪音半径 ×0.75
      detectionMult: 0.85,    // 敌人探测倍率 ×0.85
    },
    unlocked: false,
  },

  standard: {
    id: 'standard',
    name: '标准战术背心',
    nameEn: 'TACTICAL VEST',
    desc: '均衡的防护与机动性',
    effects: {
      armorMax: 200,
      moveSpeedMult: 1.0,
      noiseRadiusMult: 1.0,
      detectionMult: 1.0,
    },
    unlocked: true,
  },

  heavy: {
    id: 'heavy',
    name: '重型防弹板',
    nameEn: 'HEAVY ARMOR',
    desc: '陶瓷板 + 钢板组合，正面突破',
    effects: {
      armorMax: 280,
      moveSpeedMult: 0.92,     // 移动速度 -8%
      noiseRadiusMult: 1.15,   // 脚步噪音半径 ×1.15
      detectionMult: 1.08,     // 敌人探测倍率 ×1.08
    },
    unlocked: false,
  },

  // ── 蓝图护甲（新增 5 套；unlocked: false = 蓝图门票，判定逻辑由后续任务接线）──
  ghost: {
    id: 'ghost',
    name: '幽灵作战服',
    nameEn: 'GHOST SUIT',
    desc: '极致静默与隐蔽，护甲最薄',
    effects: {
      armorMax: 100,          // 护甲上限 100（标准的一半）
      moveSpeedMult: 1.0,
      noiseRadiusMult: 0.50,  // 脚步噪音半径 ×0.50（贴脸级静默）
      detectionMult: 0.65,    // 敌人探测倍率 ×0.65
    },
    unlocked: false,
  },

  runner: {
    id: 'runner',
    name: '斥候轻装',
    nameEn: 'RECON HARNESS',
    desc: '轻装疾行，为撤离速度牺牲防护',
    effects: {
      armorMax: 130,
      moveSpeedMult: 1.15,    // 移动速度 +15%
      noiseRadiusMult: 1.0,
      detectionMult: 1.0,
    },
    unlocked: false,
  },

  carrier: {
    id: 'carrier',
    name: '携行装具',
    nameEn: 'LOOT CARRIER',
    desc: '背部扩容装具，携带栏上限 +2',
    effects: {
      armorMax: 160,
      moveSpeedMult: 0.97,    // 移动速度 -3%（带货的沉重感）
      noiseRadiusMult: 1.0,
      detectionMult: 1.0,
      carryCapBonus: 2,       // ⚠️ 新字段：携带栏 +2（批 1 接线，当前为死数据）
    },
    unlocked: false,
  },

  chameleon: {
    id: 'chameleon',
    name: '光学迷彩服',
    nameEn: 'CHAMELEON SUIT',
    desc: '迷彩涂层，大幅削弱光照下的暴露',
    effects: {
      armorMax: 140,
      moveSpeedMult: 1.0,
      noiseRadiusMult: 1.05,  // 迷彩布料摩擦声稍大
      detectionMult: 1.0,
      litExposureMul: 0.6,    // ⚠️ 新字段：光照暴露 ×0.6（批 1 接线，当前为死数据）
    },
    unlocked: false,
  },

  dualist: {
    id: 'dualist',
    name: '双枪战术甲',
    nameEn: 'TWIN RIG',
    desc: '双主武器挂载具，为火力灵活性牺牲护甲与静默',
    effects: {
      armorMax: 190,
      moveSpeedMult: 1.00,
      noiseRadiusMult: 1.10,
      detectionMult: 1.00,
      weaponSlots: 1,         // ⚠️ 新字段：主武器槽 +1（批 1 双主武器系统接线）
      grenadeBonus: -1,       // ⚠️ 新字段：手雷数 -1（批 1 接线，必须允许负数）
    },
    unlocked: false,
  },
};

// ═══════════════════════════════════════════════════════════════════════════
// 手榴弹类型
// ═══════════════════════════════════════════════════════════════════════════

/**
 * 手榴弹配置
 * 
 * 对应 config.js 的 GRENADES 表，但这里是装备选择界面用的展示数据。
 */
export const GRENADE_TYPES = {
  flash: {
    id: 'flash',
    name: '闪光弹',
    nameEn: 'FLASHBANG',
    count: 6,
    desc: '不伤害 · 致盲 3.5 秒 · 强照明',
    effects: {
      damage: 0,
      blindDuration: 3.5,
      lightIntensity: 'high',
    },
    color: '#6dd5ed',  // 冷青色
    unlocked: true,
  },

  he: {
    id: 'he',
    name: '高爆弹',
    nameEn: 'FRAG GRENADE',
    count: 1,
    desc: '高伤害 · 大范围 · 高噪音',
    effects: {
      damage: 'high',
      radius: 'large',
      noise: 'high',
    },
    color: '#ff6b35',  // 暗橙红色
    unlocked: false,
  },

  // ── 蓝图手雷（新增 5 种；unlocked: false = 蓝图门票，判定逻辑由后续任务接线）──
  concussion: {
    id: 'concussion',
    name: '震撼弹',
    nameEn: 'CONCUSSION',
    count: 3,
    desc: '致盲 5s · 半径 18 · 无伤 · 更响',
    effects: {
      blindSec: 5.0,
      radius: 18,
      noise: 28,
      maxDamage: 0,
    },
    color: '#9fb4cc',  // 月蓝（区别于 flash 的银灰）
    unlocked: false,
  },

  smoke: {
    id: 'smoke',
    name: '烟雾弹',
    nameEn: 'SMOKE',
    count: 2,
    desc: '遮蔽敌人视线 8s · 半径 7 · 极安静',
    effects: {
      smokeSec: 8,      // ⚠️ 新机制字段：烟区持续时间（批 2 接线，当前为死数据）
      radius: 7,
      noise: 12,
      maxDamage: 0,
    },
    color: '#8a97a5',
    unlocked: false,
  },

  phosphorus: {
    id: 'phosphorus',
    name: '白磷弹',
    nameEn: 'PHOSPHORUS',
    count: 3,
    desc: '150→30 燃烧伤害 · 半径 14 · 高自伤',
    effects: {
      maxDamage: 150,
      minDamage: 30,
      radius: 14,
      selfDamageMul: 0.85,
      noise: 30,
    },
    color: '#ff7a3c',
    unlocked: false,
  },

  emp: {
    id: 'emp',
    name: '电磁脉冲弹',
    nameEn: 'EMP',
    count: 2,
    desc: '半径 18 灭应急灯 · 无伤',
    effects: {
      empRadius: 18,    // ⚠️ 新机制字段：灭灯半径（批 2 接线，当前为死数据）
      noise: 18,
      maxDamage: 0,
    },
    color: '#4cc9f0',
    unlocked: false,
  },

  decoy: {
    id: 'decoy',
    name: '诱饵弹',
    nameEn: 'DECOY',
    count: 2,
    desc: '落点连发 4 次噪音脉冲把敌人引走',
    effects: {
      decoyPulses: 4,        // ⚠️ 新机制字段（批 2 接线，当前为死数据）
      decoyPulseGap: 1.5,
      decoyPulseRadius: 20,
      noise: 6,
    },
    color: '#8a7fb5',
    unlocked: false,
  },
};

// ═══════════════════════════════════════════════════════════════════════════
// 默认装备配置
// ═══════════════════════════════════════════════════════════════════════════

/**
 * 玩家首次进入装备面板时的默认装备
 */
export const DEFAULT_LOADOUT = {
  pistol: 'pistol',              // M19 消音
  attachments: {
    pistol: {
      muzzle: 'suppressor1',     // 消音器 Mk.I
      optic: null,
      magazine: null,
      grip: null,
    },
  },
  armor: 'standard',             // 标准战术背心
  grenade: 'flash',              // 闪光弹
};
