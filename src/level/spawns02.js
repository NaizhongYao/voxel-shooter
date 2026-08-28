import { ARCHETYPE } from '../systems/enemy.js';
import { itemAt } from './furniture.js';

/**
 * 关卡 02「废弃诊所」的敌人出生点池（20 人，tier 分层与 01 同构）。
 *
 * 与黑楼不同，诊所是 C 形 + 中部庭院：推进路线是「庭院绕打」——
 * 玩家从东侧庭院接近，西脊接待处是唯一主入口，其余房间全靠侧门，
 * 所以伏击者多数蹲在门口视线死角（接待、候诊、停尸），巡逻者
 * 覆盖每个有净空环路的房间。
 *
 * ══ 数量与 tier 结构刻意与 01 完全一致 ══
 *
 * 难度卡与简报的数字全部由 countEnemies(spawns, tier) 推导：
 *   tier 1（简单 13 人）：9 个房间全有人，保证「找得到、打得过」。
 *   tier 2（困难 17 人）：接待追加武装巡逻、隔离西角与停尸补人。
 *   tier 3（专家 20 人）：庭院出现 DMR 武装巡逻（长视线威胁）+ 诊 B 伏击。
 * 全难度 +30%（原 10/13/15）靠追加蹲守者/伏击者做到，不新增巡逻路线。
 *
 * ══ 重甲盾兵：诊所这关的招牌敌人（化验室，tier 1）══
 *
 * 正面几乎打不穿（前方 150° 扇区吸收 94%），逼玩家放弃「站桩对枪」，
 * 改绕侧或用手雷。三档都会遇到，不是专家限定的隐藏彩蛋。见
 * `ARCHETYPE.SHIELD` 与 `config.js` 的 `SHIELD_ENEMY`。
 *
 * ══ 巡逻路线同样要求「实测通畅」══
 *
 * 家具（诊床、候诊沙发、手术台、停尸冷柜）比黑楼密得多，且全部是
 * 实心方块（含盆栽、台灯、椅子）。每条路线都避开家具逐段采样验证过，
 * 由 tools/check-level02-spawns.mjs 持续守着 —— 改任何一个坐标都要
 * 重跑那个脚本。Enemy.walkPatrol 的卡死兜底在，但路线本身必须通。
 */

const Y1 = 1;

export const ENEMY_SPAWNS02 = [
  // ── 档案接待（西脊，主入口进门第一间）── tier 1
  // 伏击者蹲在接待桌东侧：玩家推门进来看不到他，先教「进门先看角落」。
  { x: 19.5, y: Y1, z: 21.5, yaw: -Math.PI / 2, archetype: ARCHETYPE.AMBUSHER, weapon: 'shotgun', tier: 1 },

  // ── 候诊室（北翼中段）── tier 1
  // 两排沙发 + 中央墙垛把房间切成三个口袋，巡逻绕不开沙发列，
  // 所以这里是伏击位：蹲在南门内侧的沙发缝里。
  { x: 33.5, y: Y1, z: 14.5, yaw: Math.PI, archetype: ARCHETYPE.AMBUSHER, weapon: 'shotgun', tier: 1 },

  // ── 值班休息（北翼西端）── tier 1
  // 绕床与电视的净空环路，手枪巡逻（休息室不该有重火力）。
  {
    x: 12.5, y: Y1, z: 9.5, yaw: Math.PI / 2,
    archetype: ARCHETYPE.PATROLLER, weapon: 'pistol', tier: 1,
    patrol: [[12.5, 9.5], [17.5, 9.5], [17.5, 14.5], [12.5, 14.5]],
  },

  // ── 诊室 A（北翼东段）── tier 1
  // 诊床西侧的窄环，进出门都看得见。
  {
    x: 41.5, y: Y1, z: 13.5, yaw: Math.PI,
    archetype: ARCHETYPE.PATROLLER, weapon: 'smg', tier: 1,
    patrol: [[41.5, 13.5], [44.5, 13.5], [44.5, 15.5], [41.5, 15.5]],
  },

  // ── 隔离病房（西脊中段）── tier 1
  // 家具注释里的「高潮区域」：墙垛把房间劈成东西两半，
  // 巡逻走东半的净空环（西角留给 tier 2 的伏击者）。
  {
    x: 17.5, y: Y1, z: 27.5, yaw: -Math.PI / 2,
    archetype: ARCHETYPE.PATROLLER, weapon: 'smg', tier: 1,
    patrol: [[17.5, 27.5], [21.5, 27.5], [21.5, 31.5], [17.5, 31.5]],
  },

  /**
   * ── 化验室（南翼西端，最大的房间）── tier 1
   *
   * 重甲盾兵（诊所这关真正的招牌敌人，三档都会遇到，不是专家限定）。
   * 正面几乎打不穿：护盾只挡他面朝方向 ±75°（前方 150° 扇区），
   * 从这个扇区打进来的子弹被吸收 94%；绕到侧后方护盾完全不生效，
   * 和普通敌人没区别。手雷不吃这条判定，炸他脚下永远是重伤。
   *
   * 面朝北（yaw=0，朝向房间中央 / 化验室的主门方向）站定，几乎不动、
   * 转身也慢半拍 —— 逼玩家放弃「站桩对枪」，改绕侧或用手雷。
   * 没有 patrol：盾兵的战术就是「挡在这」，站桩本身就是设计意图。
   */
  {
    x: 15.5, y: Y1, z: 41.5, yaw: 0,
    archetype: ARCHETYPE.SHIELD, weapon: 'ar', tier: 1,
  },

  // ── 手术室（南翼中段）── tier 1 ×2
  // 手术台 + 墙垛把房间切成三块：东口袋巡逻，西侧伏击者蹲在台旁。
  {
    x: 35.5, y: Y1, z: 37.5, yaw: 0,
    archetype: ARCHETYPE.PATROLLER, weapon: 'smg', tier: 1,
    patrol: [[35.5, 37.5], [36.5, 37.5], [36.5, 45.5], [35.5, 45.5]],
  },
  { x: 30.5, y: Y1, z: 38.5, yaw: -Math.PI / 2, archetype: ARCHETYPE.AMBUSHER, weapon: 'shotgun', tier: 1 },

  // ── 停尸房（南翼东段）── tier 1
  // 两排停尸床之间的暗角，蹲在门口视线外。
  { x: 43.5, y: Y1, z: 40.5, yaw: 0, archetype: ARCHETYPE.AMBUSHER, weapon: 'shotgun', tier: 1 },

  // ── 值夜室（南翼东端）── tier 1
  // 沙发背后的净空环，直通东侧门外。
  {
    x: 50.5, y: Y1, z: 38.5, yaw: -Math.PI / 2,
    archetype: ARCHETYPE.PATROLLER, weapon: 'smg', tier: 1,
    patrol: [[50.5, 38.5], [52.5, 38.5], [52.5, 44.5], [50.5, 44.5]],
  },

  // ── 档案接待追加：武装巡逻（AR + 护甲）── tier 2
  // 困难/专家档的接待火力：主入口一线的纵深压力。
  {
    x: 16.5, y: Y1, z: 20.5, yaw: -Math.PI / 2,
    archetype: ARCHETYPE.PATROLLER, weapon: 'ar', tier: 2, armored: true,
    patrol: [[16.5, 20.5], [20.5, 20.5], [20.5, 23.5], [16.5, 23.5]],
  },

  // ── 隔离病房西角伏击者 ── tier 2
  // 与东半的巡逻者一静一动，覆盖墙垛两侧。
  { x: 10.5, y: Y1, z: 32.5, yaw: -Math.PI / 2, archetype: ARCHETYPE.AMBUSHER, weapon: 'shotgun', tier: 2 },

  // ── 停尸房巡逻者 ── tier 2
  // 停尸床之间的窄环：两个敌人（巡逻 + 伏击）让这个房间真正需要清点。
  {
    x: 42.5, y: Y1, z: 39.5, yaw: 0,
    archetype: ARCHETYPE.PATROLLER, weapon: 'smg', tier: 2,
    patrol: [[42.5, 39.5], [44.5, 39.5], [44.5, 45.5], [42.5, 45.5]],
  },

  // ── 庭院 DMR 武装巡逻 ── tier 3
  // 专家档的长视线威胁：隔着庭院对西脊各门点射，
  // 对应黑楼「走廊两端蹲守者对射」的定位，但场地换成开口庭院。
  {
    x: 42.5, y: Y1, z: 20.5, yaw: Math.PI / 2,
    archetype: ARCHETYPE.PATROLLER, weapon: 'dmr', tier: 3, armored: true,
    patrol: [[42.5, 20.5], [46.5, 20.5], [46.5, 25.5], [42.5, 25.5]],
  },

  // ── 诊室 B 伏击者 ── tier 3
  // 最小房间里的第二重威胁：进门先看到诊床，看不到床侧的人。
  { x: 52.5, y: Y1, z: 14.5, yaw: Math.PI, archetype: ARCHETYPE.AMBUSHER, weapon: 'shotgun', tier: 3 },

  /**
   * ── 人数 +30%（全难度）：13 / 17 / 20 ──
   *
   * 与黑楼同一套做法：全部用伏击者（AMBUSHER），不用蹲守者（SENTRY）—
   * 原地不动的敌人朝向对着墙会整局瞪墙，也让楼里显得像静态靶场
   * （见 test/combat.test.mjs 「没有原地不动的纯蹲守者」）。
   * 伏击者不需要 patrol 数组，不加新的巡逻路线。
   */
  // tier 1 追加：值班休息、诊室 B、隔离病房三个伏击者
  { x: 15.5, y: Y1, z: 10.5, yaw: Math.PI, archetype: ARCHETYPE.AMBUSHER, weapon: 'pistol', tier: 1 },
  { x: 54.5, y: Y1, z: 13.5, yaw: -Math.PI / 2, archetype: ARCHETYPE.AMBUSHER, weapon: 'smg', tier: 1 },
  { x: 19.5, y: Y1, z: 29.5, yaw: -Math.PI / 2, archetype: ARCHETYPE.AMBUSHER, weapon: 'shotgun', tier: 1 },

  // tier 2 追加：诊室 A 伏击者
  { x: 45.5, y: Y1, z: 10.5, yaw: Math.PI, archetype: ARCHETYPE.AMBUSHER, weapon: 'ar', tier: 2 },

  // tier 3 追加：停尸房伏击者，专家档最后一重威胁
  { x: 42.5, y: Y1, z: 44.5, yaw: 0, archetype: ARCHETYPE.AMBUSHER, weapon: 'shotgun', tier: 3 },
];

/**
 * 医疗包：全关 3 个，固定位置。
 * 候诊（北门进来顺路）、手术（中段补给）、庭院（绕打路线的中点）。
 */
export const MEDKIT_SPAWNS02 = [
  itemAt('medkit', 31.5, 8.5),    // 候诊室北门内
  itemAt('medkit', 30.5, 45.5),   // 手术室南墙
  itemAt('medkit', 44.5, 26.5),   // 庭院中部
];

/**
 * 初始武器拾取：与黑楼同构 —— 第一间房捡 SMG，高潮区域捡 AR。
 * 诊所的「第一间」是档案接待（主入口直通），「高潮区域」是隔离病房。
 */
export const WEAPON_SPAWNS02 = [
  itemAt('smg', 20.5, 22.5),      // 档案接待
  itemAt('ar', 19.5, 29.5),       // 隔离病房
];
