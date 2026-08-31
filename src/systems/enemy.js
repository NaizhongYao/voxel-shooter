import * as THREE from 'three';
import {
  PALETTE, PLAYER, LIGHT, ARMOR_ABSORB, ARMOR_MAX, ARMORED_HP_MULT,
  SHIELD_ENEMY, RUSHER_ENEMY,
} from '../config.js';
import { D } from '../difficulty.js';
import { BlockyRig } from '../player/rig.js';
import { WEAPONS, WeaponInstance, HITBOX_MULT } from './weapons.js';

/**
 * 敌人系统（GDD 12 章）。
 *
 * 三类行为原型：伏地者 / 蹲守者 / 巡逻者
 * 五个状态：基础行为 → 调查 → 警戒 → 战斗 → 死亡（+ 致盲）
 *
 * 公平性保障（60 HP 体系下玩家生存的唯一依靠）：
 *  - 发现玩家后有 300–500ms 反应延迟，期间有可见的举枪动作
 *  - 开枪时枪口焰暴露位置
 *  - 单个敌人有散布、会打空；多人同时交火才致命
 */

export const STATE = {
  IDLE: 'idle', INVESTIGATE: 'investigate', ALERT: 'alert',
  COMBAT: 'combat', BLINDED: 'blinded', DEAD: 'dead',
};

export const ARCHETYPE = {
  // 伏击者：蹲在掩体后，玩家靠近或被发现时站起来反击。
  // 原本是「趴在地上」，但方块人形躺平后姿态很难看懂，而且起身动画
  // 需要一整套骨骼插值才不别扭。改成「蹲伏 → 站起」，用现成的蹲伏
  // 缩放就能表达，玩法目的（黑暗中的突然袭击）完全保留。
  AMBUSHER: 'ambusher',
  SENTRY:   'sentry',     // 蹲守者：固定朝向，大视野锥
  PATROLLER:'patroller',  // 巡逻者：沿路径走，会呼叫同伴

  /**
   * 重甲盾兵（02 诊所起引入）。正面几乎打不穿，逼玩家放弃站桩对枪。
   *
   * 护盾只挡正面 ±75°（前方 150° 扇区）：从这个扇区打进来的子弹被
   * 吸收 94%，绕到侧后方则护盾完全不生效，和普通敌人没区别。
   * 手雷不吃这条判定（爆炸是全方向的）—— 这是「绕侧或用手雷」这个
   * 设计意图的机制载体，见 takeDamage 的 source 参数。
   *
   * 几乎不动、转身比普通敌人慢半拍：转得慢，绕后才有意义。
   */
  SHIELD:   'shield',

  /**
   * 冲锋手（03 电台起引入）。脆但极快，破坏「找掩体打远处」的舒适区。
   *
   * 确认交火（举枪反应结束）之后不再按 pushChance 概率性挪动，
   * 而是全速冲向玩家，冲到霰弹有效距离才停下开火。
   * 血量比普通敌人还低、没有护甲 —— 危险在于「来不来得及打中」，
   * 不是「打不打得动」。
   */
  RUSHER:   'rusher',
};

/** 兼容旧名字，避免关卡配置里散落的字符串失效 */
ARCHETYPE.PRONE = ARCHETYPE.AMBUSHER;

const PERCEPTION = {
  visionRange: 18,          // 基础视觉距离 vox
  hFovDeg: 100,             // 水平视野锥
  vFovDeg: 70,              // 垂直视野锥
  /**
   * 声音每穿过一层不透光方块的衰减系数（见 Enemy.hearNoise）。
   *
   * 0.62：隔一道 2 格厚的墙（算 2 层）剩 38%，隔两道剩 15%。
   * 效果是「隔壁听得见闷响、隔两个房间基本传不到」——
   * 墙厚 2 格是本作的硬规则，所以按层数算比按「几道墙」算更自然。
   */
  noiseWallMul: 0.62,
  sentryRangeMul: 1.35,     // 蹲守者视野更远
  ambushWakeRange: 6,       // 伏击者的惊起距离
  reactionMin: 0.30,        // 反应延迟下限（秒）
  reactionMax: 0.50,
  shadowMul: 0.6,           // 玩家处于阴影中再 ×0.6
  crossFloorMul: 0.6,       // 噪音跨楼板衰减
  callRadius: 15,           // 呼叫同伴半径
  investigateTime: 6,       // 调查状态持续时间
  loseTargetTime: 2.5,      // 失去目标后回落的时间
  // 敌人瞄准误差（vox）：弹着点在目标周围的横向偏移半径。
  // 用线性偏移而不是固定角度，近距离才不会变成百发百中。
  // 0.55 vox 相对躯干半宽 0.32 → 单发命中率约 55%，符合「受控 DPS」。
  aimError: 0.55,
  burstGap: 0.45,           // 连发之间的停顿

  /**
   * ── 转向速率（rad/s 的 lerp 系数）──
   *
   * 旧值 18/14/9 换算成转 180° 只要 0.15 秒左右，等于瞬间甩头，
   * 完全没有真人转身该有的重量感。整体下调 40%（×0.6），
   * 让举枪跟枪、查房转身都看得出「正在转」，而不是瞬间对准。
   *
   * 这不会让敌人变得不公平 —— 反应延迟（reactionTimer）才是玩家的
   * 机会窗口，转身慢只是让敌人看起来更真实。两者是独立的旋钮。
   */
  turnRateCombat: 10.8,     // 18 × 0.6
  turnRateAlert: 8.4,       // 14 × 0.6
  turnRateSearch: 5.4,      // 9  × 0.6，朝最后已知位置转/扫视中心过渡也用它

  /**
   * ── 站岗感修复：蹲守者/查房不再是「定住→甩头→定住」的离散跳变 ──
   *
   * 旧版每隔 2~4 秒随机挑一个新方向再快速转过去，玩家看到的是长时间
   * 面朝一处不动、然后突然甩头——像在站岗。现在改成持续的正弦左右
   * 摆动，手电挂在头部朝向上，摆动本身就是巡视扫光，没有任何「定住
   * 不动」的瞬间。
   */
  scanAmplitudeRad: 35 * Math.PI / 180,        // 蹲守者摆动振幅，约 ±35°
  scanPeriod: 6,                                // 一个来回的秒数（实例上再加随机抖动）
  investScanAmplitudeRad: 50 * Math.PI / 180,  // 查房无目标时的张望振幅，更急促
  investScanPeriod: 3,

  // ── 警戒度（alertLevel）的涨落速率，单位：每秒 ──
  /** 看见玩家时的上涨速率（约 0.5 秒涨满 → 进入战斗） */
  alertRiseSeen: 2.0,
  /** 只看到手电光斑时的上涨速率（慢得多，玩家有机会关灯） */
  alertRiseSpot: 0.75,
  /** 开着手电时的自然回落速率（很慢 —— 灯还亮着就一直可疑） */
  alertDecayLit: 0.25,
  /**
   * 关灯后的回落速率。是开灯时的 6 倍 ——
   * 这就是「关手电大幅降低 alert」的核心数值。
   * 玩家被发现之后关灯躲进掩体，约 1.2 秒就能把警戒度清空。
   */
  alertDecayDark: 1.5,
  /** 关灯时脱战时间的缩短倍率（更快放弃搜索） */
  darkLoseTargetMul: 0.45,

  /**
   * 巡逻卡死判定：连续这么多秒没有实质位移就放弃当前路径点。
   *
   * 2.5 秒足够长，不会误判「绕过掩体时短暂贴墙滑行」；也足够短，
   * 玩家不会看到一个明显卡住的敌人。
   */
  patrolStallLimit: 2.5,
};

/** 难度加权后的感知参数。所有读取都要走这里，不要直接用 PERCEPTION。 */
function perc() {
  const d = D();
  return {
    visionRange: PERCEPTION.visionRange * d.visionRangeMul,
    reactionMin: PERCEPTION.reactionMin * d.reactionMul,
    reactionMax: PERCEPTION.reactionMax * d.reactionMul,
    aimError: PERCEPTION.aimError * d.aimErrorMul,
    callRadius: PERCEPTION.callRadius * d.callRadiusMul,
    investigateTime: PERCEPTION.investigateTime * d.investigateTimeMul,
    loseTargetTime: PERCEPTION.loseTargetTime * d.loseTargetMul,
    // ── 侵略性（难度表里的 aggression 字段，缺省值保持旧行为）──
    hearRangeMul: d.hearRangeMul ?? 1,
    suppressChance: d.suppressChance ?? 0,
    suppressSpread: d.suppressSpread ?? 1.5,
    pushChance: d.pushChance ?? 0,
    searchRooms: d.searchRooms ?? false,
  };
}

let _idSeq = 0;
const _v = new THREE.Vector3();

/**
 * 数出 A→B 直线上穿过了多少层不透光方块（声音传播衰减用）。
 *
 * 用等步长采样而不是 DDA：这里只需要「大概隔了几层」，
 * 采样步长 0.5 vox 对 2 格厚的墙足够可靠，而且比逐格 DDA 便宜得多 ——
 * 每次开枪都要对全部敌人算一遍，不能太贵。
 *
 * 注意判定的是 opaque（挡视线），不是 solid：开着的门是空气，不算遮挡，
 * 所以「关门挡声、开门漏声」自然成立。
 */
function countOpaqueLayers(world, ax, ay, az, bx, by, bz) {
  const dx = bx - ax, dy = by - ay, dz = bz - az;
  const dist = Math.hypot(dx, dy, dz);
  if (dist < 1e-4) return 0;
  const STEP = 0.5;
  const n = Math.min(160, Math.ceil(dist / STEP));   // 上限防超长射线
  let layers = 0, inside = false;
  for (let i = 1; i < n; i++) {
    const t = i / n;
    const gx = Math.floor(ax + dx * t);
    const gy = Math.floor(ay + dy * t);
    const gz = Math.floor(az + dz * t);
    const solid = world.opaqueAt(gx, gy, gz);
    // 只在「进入一段实心」时计数，连续的同一道墙算一层过渡
    if (solid && !inside) layers++;
    inside = solid;
  }
  return layers;
}

/** 实体碰撞半径（圆柱），略小于碰撞盒半宽以免贴墙时互相挤穿 */
export const ENTITY_RADIUS = 0.28;

export class Enemy {
  /**
   * @param spec { x, z, y, archetype, weapon, yaw, patrol?: [[x,z],...], wander?: boolean }
   * @param services Optional runtime services:
   *   `{ doors, navigation, rooms, roomLinks, rng, onDoorNoise }`.
   *   The two-argument form remains valid for logic-only callers and tests.
   */
  constructor(world, spec, services = null) {
    this.id = ++_idSeq;
    this.world = world;
    this.services = services ?? spec.services ?? {};
    this.archetype = spec.archetype;
    this.spawn = new THREE.Vector3(spec.x, spec.y, spec.z);
    this.pos = this.spawn.clone();
    this.anchor = this.spawn.clone();
    this.anchorPoint = { x: this.anchor.x, y: this.anchor.y, z: this.anchor.z };
    this.yaw = spec.yaw ?? 0;
    this.homeYaw = this.yaw;
    this.rng = typeof this.services.rng === 'function'
      ? this.services.rng : () => Math.random();
    const validPatrol = Array.isArray(spec.patrol) && spec.patrol.length >= 2;
    this.patrol = validPatrol ? spec.patrol : null;
    this.behaviorMode = validPatrol ? 'patrol' : spec.wander === true ? 'wander' : 'sentry';
    this.wander = spec.wander === true;
    this.canCrossRooms = spec.canCrossRooms === true;
    this.wanderRooms = Array.isArray(spec.wanderRooms)
      ? spec.wanderRooms.filter((room) => typeof room === 'string') : [];
    this.patrolIdx = 0;

    // Navigation is resolved lazily so legacy worlds without an index still work.
    const navigation = this.navigation;
    this.anchorRoom = spec.anchorRoom
      ?? navigation?.getRoomAt?.(this.anchor.x, this.anchor.z)
      ?? null;
    const requestedHomeRadius = Number(spec.homeRadius ?? 5);
    this.homeRadius = Number.isFinite(requestedHomeRadius)
      ? Math.max(0, requestedHomeRadius) : 5;
    this.homeRadius = this.clipHomeRadius(this.homeRadius, this.anchorRoom);
    this.wanderTarget = null;
    this.wanderPath = [];
    this.wanderWaypointIndex = 0;
    this.wanderPause = 0;
    this.wanderStall = 0;
    this.wanderRecentTargets = [];
    this.wanderScanCenter = this.yaw;
    this.wanderScanPhase = 0;
    this.wanderScanAmplitude = 35 * Math.PI / 180;
    this.wanderScanPeriod = 3.2;
    // Look-around is a visual-only idle submode. Combat always overwrites yaw
    // from the live/last-known target and never inherits this value.
    this.lookYaw = this.yaw;
    this.returnHome = {
      active: false,
      target: null,
      path: [],
      waypointIndex: 0,
      hold: 0,
      retryAt: 0,
    };
    // Strafe is deliberately opt-in so existing sentry, shield, and rusher
    // encounters keep their authored movement identities.
    this.combatStrafeEnabled = spec.combatStrafe === true || spec.strafe === true;
    this.strafeActive = false;
    this.strafeTarget = null;
    this.strafeSpeed = 0;
    this.strafeUntil = 0;
    this.nextStrafeAt = 0;
    this.crossPlan = null;
    this.crossPlanIndex = 0;
    this.crossPhase = 'idle';
    this.crossWait = 0;
    this.crossDoorRetries = 0;
    this.pathRevision = this.navigation?.doorRevision ?? 0;
    this.crossFailureUntil = 0;
    this.crossFailedTarget = null;
    this.crossBlocked = false;

    /**
     * 武装敌人要先于 hpMax 判定（血量翻倍依据这一点）。
     * 血量 ×ARMORED_HP_MULT：一枪爆头（AR 63）最多打穿护甲，
     * 做不到首发即死 —— 重甲目标要持续集火。
     */
    this.armored = !!spec.armored;
    /** 重甲盾兵 / 冲锋手（新原型，见 ARCHETYPE 的注释） */
    this.isShield = this.archetype === ARCHETYPE.SHIELD;
    this.isRusher = this.archetype === ARCHETYPE.RUSHER;

    /**
     * 血量：盾兵固定 200（不吃难度缩放）、冲锋手 ×0.8（脆），
     * 精英 ×3，其余 ×1。
     */
    const hpMult = this.isRusher ? RUSHER_ENEMY.hpMult
      : this.armored ? ARMORED_HP_MULT : 1;
    this.hpMax = this.isShield ? SHIELD_ENEMY.hpMax : Math.round(D().enemyHp * hpMult);
    this.hp = this.hpMax;
    /**
     * 护甲先扣、生命后扣，与玩家侧 Player.applyDamage 同一套公式。
     *
     * 盾兵有固定 200 点「方向性护甲」，但不会像普通精英那样所有方向
     * 都吃它：takeDamage 只有在正面子弹命中时才从这 200 点里扣；
     * 侧后与爆炸完全绕过，不减甲也不减伤。
     */
    this.armorMax = this.isShield ? SHIELD_ENEMY.armorMax
      : this.armored ? ARMOR_MAX : 0;
    this.armor = this.armorMax;
    this.state = STATE.IDLE;
    this.stateTime = 0;
    this.weapon = new WeaponInstance(WEAPONS[spec.weapon]);
    this.reactionTimer = 0;
    this.blindUntil = 0;
    this.lastSeenPlayer = new THREE.Vector3();
    this.hasLastSeen = false;
    this.investigateTarget = null;
    this.alerted = false;
    this.nextShotAt = 0;
    this.moveSpeed = 0;             // 本帧的移动速度，驱动腿部摆动
    /**
     * 蹲守者的持续左右扫视状态（见 PERCEPTION.scanAmplitudeRad 的注释）。
     * scanCenter 是摆动中心朝向，scanPhase 驱动正弦摆动，
     * scanShiftTimer 到点后悄悄挪一次中心（避开墙面）。
     */
    this.scanCenter = this.yaw;
    this.scanPhase = this.random() * Math.PI * 2;
    this.scanShiftTimer = 8 + this.random() * 4;
    /** 查房无目标时的张望摆动，同一套机制，振幅/周期更急促 */
    this.investScanCenter = this.yaw;
    this.investScanPhase = this.random() * Math.PI * 2;
    // 搜索状态：失去目标后去哪些点找人
    this.searchPoints = null;
    this.searchIdx = 0;
    /** 巡逻卡死计时（秒）。超过 patrolStallLimit 就跳过当前路径点。 */
    this.patrolStall = 0;
    /** 噪音来源点（听到枪声的位置），查房时用来判断是否继续往里推 */
    this.searchOrigin = null;
    /** 上次尝试开门的时间，避免每帧反复推同一扇门 */
    this.lastDoorAt = -99;
    /**
     * 应急灯系统（可选，由 main.js 装配时注入）。
     * 只用来查「玩家是不是站在灯下」，见 canSeePlayer。
     */
    this.lights = null;

    /**
     * 警戒度 0..1 —— 连续量，驱动头顶指示器的填充与颜色。
     *
     * 为什么在离散状态机之外再加一个连续量：STATE 只有 6 个离散值，
     * 玩家看到的是「突然从 idle 跳到 combat」，中间没有可读的过程。
     * alertLevel 让「他快要发现我了」变成一个可以观察、可以反应的过程 ——
     * 玩家看到指示器在涨，就知道该躲回掩体或者关灯。
     *
     * 关灯会让它快速回落（见 decayAlert），这就是「关手电大幅降低 alert」
     * 的机制载体。
     */
    this.alertLevel = 0;

    // 视觉：方块人形。伏击者初始蹲伏（轮廓矮、藏在掩体后），被发现后站起
    // 武装敌人（armored）在躯干外挂一层深灰护甲壳，见 BlockyRig 的 armored 选项。
    this.rig = new BlockyRig(PALETTE.threat, {
      isPlayer: false,
      armored: this.armored,
      // 盾兵有自己的一套钢灰护壳（只包正面），见 rig.js 的 'shield' 分支
      kit: this.isShield ? 'shield' : (this.armored ? 'armored' : 'enemy'),
    });
    this.rig.root.position.copy(this.pos);
    this.rig.setGun(spec.weapon);

    this.isAmbusher = this.archetype === ARCHETYPE.AMBUSHER;
    // 伏击者仍守点，但站着、开手电。蹲着关灯会让人在黑暗里几乎看不见、也打不中。
    this.crouched = false;
    this.crouchAmt = 0;
    this.height = PLAYER.height;
    this.dead = false;
    this.flashlightOn = true;

    // 出生点脱困：万一关卡布置把敌人放进了墙里，就近推出来。
    // 布置数据是手写的，出错概率永远不为零；卡在墙里的敌人打不着也走不动，
    // 玩家会以为是 bug（因为确实是）。这层兜底让关卡数据的小失误不致命。
    this.escapeIfStuck();

    /**
     * 修正朝墙的初始朝向。
     *
     * 布置数据里的 yaw 是手写的，难免有几个正好对着墙。而 homeYaw 是
     * 扫视的中心，一旦它朝墙，敌人的整个扫视扇区都会反复扫过墙面 ——
     * 看起来就是「这个敌人在瞪墙」。在这里一次性修好，比在扫视逻辑里
     * 每帧躲避要干净得多（后者会让扫视看起来抽搐）。
     */
    if (this.facesWall(this.yaw)) {
      this.yaw = this.pickOpenDirection(Math.PI);
      this.homeYaw = this.yaw;
      this.scanCenter = this.yaw;
      this.investScanCenter = this.yaw;
    }
  }

  /** 该朝向的正前方是否紧贴墙面（默认 2 vox 内） */
  facesWall(yaw, within = 2.0) {
    const hit = this.world.raycast(
      this.pos.x, this.eyeY, this.pos.z,
      -Math.sin(yaw), 0, -Math.cos(yaw), within + 1, true
    );
    return !!hit && hit.dist < within;
  }

  /**
   * 如果当前位置与墙体相交，螺旋向外找最近的可站位置。
   *
   * 搜索半径只到 3 vox：更远就说明布置数据错得太厉害，
   * 硬搬过去反而会把敌人挪进别的房间，那种「敌人凭空出现在隔壁」
   * 比卡墙更难排查。所以超出半径就放弃并留在原地。
   */
  escapeIfStuck(maxR = 3) {
    if (!this.blockedAt(this.pos.x, this.pos.z)) return false;
    for (let r = 1; r <= maxR * 2; r++) {
      const step = r * 0.5;
      for (let a = 0; a < 12; a++) {
        const ang = (a / 12) * Math.PI * 2;
        const nx = this.pos.x + Math.cos(ang) * step;
        const nz = this.pos.z + Math.sin(ang) * step;
        if (this.blockedAt(nx, nz)) continue;
        this.pos.x = nx; this.pos.z = nz;
        // 落到地面上，避免悬空或半嵌进地板
        const surf = this.world.highestSurfaceUnder(
          nx - ENTITY_RADIUS, nz - ENTITY_RADIUS,
          nx + ENTITY_RADIUS, nz + ENTITY_RADIUS,
          this.pos.y + 1.0, this.pos.y - 2.0
        );
        if (Number.isFinite(surf)) this.pos.y = surf;
        this.spawn.copy(this.pos);
        return true;
      }
    }
    return false;
  }

  /** 蹲伏 → 站立的平滑过渡（0=站立，1=全蹲） */
  updateStance(dt) {
    const want = this.crouched ? 1 : 0;
    if (this.crouchAmt !== want) {
      const rate = dt * 5.5;               // 约 0.2s 完成起身
      this.crouchAmt += Math.sign(want - this.crouchAmt) * rate;
      this.crouchAmt = Math.max(0, Math.min(1, this.crouchAmt));
    }
    this.height = PLAYER.height
      - this.crouchAmt * (PLAYER.height - PLAYER.crouchHeight);
  }

  /**
   * 起身。伏击者暴露之后就没有藏的必要了，顺手把手电打开 ——
   * 玩家因此能看到「暗处突然亮起一束光」，比无声起身的可读性高得多。
   */
  standUp() {
    this.crouched = false;
    this.flashlightOn = true;
  }

  /**
   * 警戒度的涨落。这是「关手电大幅降低 alert」的机制核心。
   *
   * 上涨：看见玩家最快（0.5 秒涨满），只看到光斑慢得多（1.3 秒）——
   *      后者给玩家留出「发现光斑被注意到了，赶紧关灯」的反应窗口。
   *
   * 回落：开着灯时很慢（0.25/s，4 秒才清空），关灯后快 6 倍（1.5/s）。
   *      所以正确的脱战操作是「关灯 + 躲掩体」，而不是单纯跑远 ——
   *      这让手电开关成为一个真正的战术决策，不只是亮度选项。
   *
   * 战斗中不回落：已经在交火了，关灯不能让敌人当场忘记你。
   * 关灯的收益体现在 doCombat 里缩短的脱战时间上。
   */
  updateAlert(dt, sees, spotsLight, flashlight) {
    if (this.state === STATE.COMBAT) {
      this.alertLevel = 1;
      return;
    }
    if (sees) {
      this.alertLevel = Math.min(1, this.alertLevel + dt * PERCEPTION.alertRiseSeen);
    } else if (spotsLight) {
      this.alertLevel = Math.min(1, this.alertLevel + dt * PERCEPTION.alertRiseSpot);
    } else {
      const lit = flashlight?.on ?? true;
      const rate = lit ? PERCEPTION.alertDecayLit : PERCEPTION.alertDecayDark;
      this.alertLevel = Math.max(0, this.alertLevel - dt * rate);
    }
    // 警戒/调查状态有一个底线，避免指示器在搜索途中掉到全无
    if (this.state === STATE.ALERT) {
      this.alertLevel = Math.max(this.alertLevel, 0.7);
    } else if (this.state === STATE.INVESTIGATE) {
      this.alertLevel = Math.max(this.alertLevel, 0.35);
    }
  }

  /**
   * 头顶指示器要显示的等级。玩家靠它判断「我被发现了吗」。
   *
   * @returns 'combat' | 'alert' | 'search' | 'calm' | 'dead'
   */
  get alertTier() {
    if (this.dead) return 'dead';
    if (this.state === STATE.COMBAT) return 'combat';
    if (this.state === STATE.ALERT) return 'alert';
    if (this.state === STATE.INVESTIGATE || this.alertLevel > 0.15) return 'search';
    return 'calm';
  }

  /** NavigationIndex is optional and may be mounted after an Enemy is created. */
  get navigation() { return this.services?.navigation ?? this.world?.navigation ?? null; }

  /** Late wiring remains available for legacy worlds and focused tests. */
  attachNavigation(services = {}) {
    this.services = { ...this.services, ...services };
    if (typeof services.rng === 'function') this.rng = services.rng;
    return this;
  }

  random() {
    let value;
    try { value = Number(this.rng?.()); } catch { value = 0; }
    return Number.isFinite(value) ? Math.max(0, Math.min(0.999999999, value)) : 0;
  }

  /** Keep the wander leash inside 45% of the room's shorter side. */
  clipHomeRadius(radius, roomId) {
    const room = this.navigation?.level?.rooms?.[roomId];
    if (!room) return radius;
    const width = Number(room.x1) - Number(room.x0) + 1;
    const depth = Number(room.z1) - Number(room.z0) + 1;
    const shortSide = Math.min(width, depth);
    return Number.isFinite(shortSide) && shortSide > 0
      ? Math.min(radius, shortSide * 0.45) : radius;
  }

  /** Resolve room metadata after a late world.navigation mount. */
  ensureWanderContext() {
    const nav = this.navigation;
    if (!nav) return null;
    if (!this.anchorRoom && typeof nav.getRoomAt === 'function') {
      this.anchorRoom = nav.getRoomAt(this.anchor.x, this.anchor.z) ?? null;
    }
    this.homeRadius = this.clipHomeRadius(this.homeRadius, this.anchorRoom);
    return this.anchorRoom;
  }

  /** Return-home is a submode of investigation, never a new public STATE. */
  canReturnHome() {
    const nav = this.navigation;
    const roomId = this.ensureWanderContext();
    if (!this.canCrossRooms
        || (this.behaviorMode !== 'wander' && this.behaviorMode !== 'patrol')
        || !roomId
        || typeof nav?.getRoomNodes !== 'function'
        || typeof nav?.findLocalPath !== 'function') return false;
    const nodes = nav.getRoomNodes(roomId);
    return Array.isArray(nodes) && nodes.length > 0;
  }

  clearReturnHome() {
    this.returnHome.active = false;
    this.returnHome.target = null;
    this.returnHome.path = [];
    this.returnHome.waypointIndex = 0;
    this.returnHome.hold = 0;
    this.returnHome.retryAt = 0;
  }

  beginReturnHome(now = 0) {
    if (!this.canReturnHome()) return false;
    this.clearCrossRoomPlan();
    this.investigateTarget = null;
    this.searchOrigin = null;
    this.returnHome.active = true;
    this.returnHome.retryAt = now;
    this.stateTime = 0;
    return true;
  }

  /** Pick a bounded, legal node near this enemy's own birth anchor. */
  chooseReturnHomeTarget(now = 0) {
    if (!this.canReturnHome()) return null;
    const nav = this.navigation;
    const roomId = this.ensureWanderContext();
    if (!nav || typeof nav.getRoomNodes !== 'function'
        || typeof nav.findLocalPath !== 'function') return null;
    const nodes = nav.getRoomNodes(roomId)
      .filter((node) => this.validWanderPoint(node));
    if (nodes.length === 0) return null;

    const point = (value) => ({ x: Number(value.x), z: Number(value.z) });
    const dist = (a, b) => Math.hypot(a.x - b.x, a.z - b.z);
    const anchor = { x: this.anchor.x, z: this.anchor.z };
    const current = { x: this.pos.x, z: this.pos.z };
    const currentRoom = nav.getRoomAt?.(this.pos.x, this.pos.z);
    const recent = (this.wanderRecentTargets ?? []).slice(-3).map(point);
    const maxDistance = Number.isFinite(this.homeRadius) ? this.homeRadius : 5;
    const candidates = nodes.filter((node) => {
      const p = point(node);
      return dist(anchor, p) <= maxDistance + 1e-6
        && (typeof nav.isWalkablePoint !== 'function' || nav.isWalkablePoint(
          p.x, p.z, { roomId, y: this.pos.y, entityRadius: this.radius, entityHeight: this.height }
        ));
    });

    // A finite shuffled pass keeps target choice deterministic under injected RNG.
    const pool = candidates.slice();
    for (let attempt = 0; attempt < 24 && pool.length > 0; attempt++) {
      const index = Math.floor(this.random() * pool.length);
      const [node] = pool.splice(index, 1);
      const p = point(node);
      if (recent.some((old) => dist(old, p) < 2.5)) continue;
      let path = null;
      let cross = false;
      const target = new THREE.Vector3(p.x, this.pos.y, p.z);
      if (currentRoom === roomId) {
        path = nav.findLocalPath(current, p, {
          roomId, maxNodes: 192, maxDistance: 48,
        });
      } else if (currentRoom && this.planCrossRoom(target, 'wander', [roomId])) {
        cross = true;
      }
      if (!cross && (!Array.isArray(path) || path.length === 0)) continue;
      if (!cross && path.some((waypoint) => !this.validWanderPoint(waypoint))) continue;
      if (!cross && path.some((waypoint) => dist(anchor, point(waypoint)) > maxDistance + 1e-6)) continue;
      this.returnHome.target = target;
      this.returnHome.path = cross ? [] : path.slice();
      this.returnHome.waypointIndex = 0;
      this.returnHome.hold = 0;
      this.returnHome.retryAt = now;
      const history = Array.isArray(this.wanderRecentTargets)
        ? this.wanderRecentTargets : [];
      this.wanderRecentTargets = [...history, p].slice(-8);
      return target;
    }
    return null;
  }

  finishReturnHome() {
    const mode = this.behaviorMode;
    this.clearReturnHome();
    this.clearCrossRoomPlan();
    this.investigateTarget = null;
    this.state = STATE.IDLE;
    this.stateTime = 0;
    this.lookYaw = this.yaw;
    if (mode === 'wander') this.beginWanderPause();
    else if (mode === 'patrol' && this.patrol) this.patrolIdx = this.nearestPatrolIndex();
  }

  doReturnHome(dt, ctx, now) {
    const nav = this.navigation;
    const roomId = this.ensureWanderContext();
    if (!this.canReturnHome() || !nav || !roomId
        || typeof nav.getRoomNodes !== 'function'
        || typeof nav.findLocalPath !== 'function') {
      this.clearReturnHome();
      this.state = STATE.IDLE;
      this.stateTime = 0;
      return;
    }
    if (this.pathRevision !== nav.doorRevision) {
      this.clearCrossRoomPlan();
      this.returnHome.path = [];
      this.returnHome.waypointIndex = 0;
      this.pathRevision = nav.doorRevision;
    }
    if (!this.returnHome.target && now >= this.returnHome.retryAt) {
      if (!this.chooseReturnHomeTarget(now)) this.returnHome.retryAt = now + 1.0;
    }
    const target = this.returnHome.target;
    if (!target) {
      this.doReturnHomeLook(dt);
      return;
    }

    if (this.crossPlan) {
      const status = this.moveCrossRoom(dt, 1.5, now, 'wander');
      if (status === 'failed') {
        this.returnHome.target = null;
        this.returnHome.path = [];
        this.returnHome.waypointIndex = 0;
        this.returnHome.retryAt = now + 1.2;
      } else if (status !== 'arrived') {
        return;
      }
    }
    if (!this.crossPlan) {
      const currentRoom = nav.getRoomAt?.(this.pos.x, this.pos.z);
      if (currentRoom !== roomId) {
        // A door revision clears the staged plan. Rebuild it from the current
        // room instead of leaving the return target suspended forever.
        if (now >= this.returnHome.retryAt) {
          if (!this.planCrossRoom(target, 'wander', [roomId])) {
            this.returnHome.retryAt = now + 1.2;
          }
        }
        return;
      }
      if (!Array.isArray(this.returnHome.path) || this.returnHome.path.length === 0) {
        const path = nav.findLocalPath(
          { x: this.pos.x, z: this.pos.z },
          { x: target.x, z: target.z },
          { roomId, maxNodes: 192, maxDistance: 48 },
        );
        if (Array.isArray(path) && path.length > 0
            && path.every((point) => this.validWanderPoint(point))) {
          this.returnHome.path = path;
          this.returnHome.waypointIndex = 0;
        }
      }
      const waypoint = this.returnHome.path[this.returnHome.waypointIndex];
      if (!this.validWanderPoint(waypoint)) {
        this.returnHome.target = null;
        this.returnHome.path = [];
        this.returnHome.waypointIndex = 0;
        this.returnHome.retryAt = now + 1.0;
        return;
      }
      const arrived = this.moveToward(waypoint, dt, 1.5, { doors: ctx?.doors, now });
      if (arrived && this.returnHome.waypointIndex < this.returnHome.path.length - 1) {
        this.returnHome.waypointIndex += 1;
      }
    }

    const currentRoom = nav.getRoomAt?.(this.pos.x, this.pos.z);
    const distance = Math.hypot(target.x - this.pos.x, target.z - this.pos.z);
    if (currentRoom === roomId && distance <= 0.7) {
      this.returnHome.hold += dt;
      this.doReturnHomeLook(dt);
      if (this.returnHome.hold >= 0.25) this.finishReturnHome();
    } else {
      this.returnHome.hold = 0;
    }
  }

  doReturnHomeLook(dt) {
    this.wanderScanPhase += dt * (Math.PI * 2 / this.wanderScanPeriod);
    const targetYaw = this.wanderScanCenter
      + Math.sin(this.wanderScanPhase) * this.wanderScanAmplitude;
    this.yaw += angleDiff(targetYaw, this.yaw)
      * Math.min(1, dt * PERCEPTION.turnRateSearch);
    this.lookYaw = this.yaw;
  }

  /** True only for finite, usable navigation points. */
  validWanderPoint(point) {
    return !!point && Number.isFinite(Number(point.x)) && Number.isFinite(Number(point.z));
  }

  /** 碰撞圆柱半径。门系统用它判断「门洞里有没有人」。 */
  get radius() { return ENTITY_RADIUS; }

  get eyeY() {
    return this.pos.y + this.height * 0.85;
  }

  /**
   * 命中盒：三段 AABB（头 / 躯干 / 四肢），返回命中倍率。
   * 按当前身高等比缩放 —— 蹲伏时整体压低，头部盒也随之下降，
   * 所以「蹲在掩体后的敌人更难爆头」是几何的自然结果，不需要特例。
   */
  hitTest(ox, oy, oz, dx, dy, dz, maxDist) {
    if (this.dead) return null;
    /**
     * 蹲伏只把命中盒压到约 1.15 高，不要按 1.0/1.8 等比缩到 0.55。
     * 等比缩放会让伏击者的头胸都低于站立准星，玩家瞄准人形中心也打不中，
     * 看起来就像「人在那儿但打不到」。
     */
    const s = Math.max(0.64, this.height / PLAYER.height);
    const zones = [
      { name: 'head',  y0: 1.48 * s, y1: 1.98 * s, half: 0.28, mult: HITBOX_MULT.head },
      { name: 'torso', y0: 0.55 * s, y1: 1.48 * s, half: 0.36, mult: HITBOX_MULT.torso },
      { name: 'limb',  y0: 0.0,      y1: 0.68 * s, half: 0.32, mult: HITBOX_MULT.limb },
    ];

    let best = null;
    for (const z of zones) {
      const t = rayBox(
        ox, oy, oz, dx, dy, dz,
        this.pos.x - z.half, this.pos.y + z.y0, this.pos.z - z.half,
        this.pos.x + z.half, this.pos.y + z.y1, this.pos.z + z.half
      );
      if (t !== null && t >= 0 && t <= maxDist && (!best || t < best.dist)) {
        best = { dist: t, zone: z.name, mult: z.mult, enemy: this };
      }
    }
    return best;
  }

  /**
   * @param dir 子弹飞行方向（可选），决定倒地朝向
   */
  /**
   * @param source 'bullet' | 'blast' —— 这一刀是子弹还是爆炸。
   *
   * ══ 为什么必须区分 ══
   *
   * 子弹和手雷走的是同一个 takeDamage。盾兵的护盾只挡正面，判定依据是
   * 「伤害来向 vs 他面朝方向」；而爆炸是全方向的，没有「来向」这个概念。
   * 不加这个标记的话，炸在他正面的手雷会被误判成正面命中、被护盾挡掉
   * 94% —— 那么「手雷是盾兵的解法」这条设计就完全落不了地。
   * 默认 'bullet' 保持所有旧调用点的行为不变。
   */
  takeDamage(amount, zone, dir = null, source = 'bullet') {
    if (this.dead) return false;

    /**
     * ── 重甲盾兵：方向性护盾 ──
     *
     * 只有子弹吃这条判定。dir 是子弹的飞行方向，所以「子弹打向他的方向」
     * 取反才是「他看到子弹来的方向」。用他的面朝向量与来向的夹角判断：
     * 落在前方 150° 扇区内 → 吸收 94%；扇区外 → 护盾完全不生效。
     */
    if (this.isShield && source === 'bullet' && dir && this.armor > 0) {
      const fwdX = -Math.sin(this.yaw), fwdZ = -Math.cos(this.yaw);
      // 来向：从他指向射手（dir 是子弹前进方向，取反）
      const inX = -dir.x, inZ = -dir.z;
      const inLen = Math.hypot(inX, inZ) || 1;
      const cos = (inX / inLen) * fwdX + (inZ / inLen) * fwdZ;
      const halfArc = Math.cos(SHIELD_ENEMY.frontArcDeg * Math.PI / 360);
      if (cos >= halfArc) {
        /**
         * 正面子弹：固定 500 护盾池吸收 94%，剩下 6%渗到 200 HP。
         * 甲耗尽之后，正面也终于会掉满血；但侧后方/爆炸从第一发起
         * 就完全绕开这段代码，不扣甲也不减伤。
         */
        const absorbed = Math.min(this.armor, Math.round(amount * SHIELD_ENEMY.frontAbsorb));
        this.armor -= absorbed;
        amount -= absorbed;
      }
      // 扇区外：不做任何吸收，和普通敌人完全一样
    }

    /**
     * 普通武装精英：护甲先吸收 ARMOR_ABSORB 比例的伤害，其余渗透到生命。
     * 盾兵不走这条通用护甲路径 —— 它只在上面的正面 bullet 分支扣甲。
     */
    if (this.armored && !this.isShield && this.armor > 0) {
      const absorbed = Math.min(this.armor, Math.round(amount * ARMOR_ABSORB));
      this.armor -= absorbed;
      amount -= absorbed;
    }
    this.hp -= amount;

    /**
     * 被打中 → 知道「有人在打我」，但不知道人在哪。
     *
     * 原来这里直接 state = COMBAT，而 COMBAT 会精确跟枪 —— 等于背后被偷袭
     * 的敌人瞬间就锁定了玩家位置。现在改成：转入 ALERT（有反应延迟、
     * 会朝子弹来向转身），玩家的偷袭因此真的有先手优势。
     */
    if (this.state !== STATE.BLINDED && this.state !== STATE.COMBAT) {
      // 朝子弹来的方向查看（不是朝玩家 —— 敌人只知道方向，不知道距离）
      if (dir) {
        this.investigateTarget = new THREE.Vector3(
          this.pos.x - dir.x * 6, this.pos.y, this.pos.z - dir.z * 6
        );
        this.crossBlocked = false;
      }
      this.toAlert();
    }
    this.standUp();
    this.alerted = true;

    if (this.hp <= 0) {
      this.hp = 0;
      this.dead = true;
      this.state = STATE.DEAD;
      this.flashlightOn = false;
      // 倒地而不是凭空消失 —— 玩家需要看到「他死了」。
      // 不隐藏枪：updateDeath 里 gunPivot.rotation.x = limp * 1.2 让枪
      // 跟着身体一起垂落倒地；这里若 visible=false，身体在慢慢倒下、
      // 枪却瞬间蒸发，两者视觉上自相矛盾。（枪挂手电已由
      // startDeath 单独熄灭，不会出现「死人手电还亮着」。）
      this.rig.startDeath(dir ? dir.x : 0, dir ? dir.z : 1);
      return true;                     // 击杀
    }
    return false;
  }

  blind(now, duration = 3.5) {
    if (this.dead) return;
    this.state = STATE.BLINDED;
    this.blindUntil = now + duration;
  }

  /** 能否看见玩家：视野锥 + 无遮挡 + 被照亮或极近 */
  canSeePlayer(player, flashlight) {
    if (this.dead) return false;
    const px = player.pos.x, pz = player.pos.z;
    const py = player.pos.y + player.body.height * 0.7;

    const dx = px - this.pos.x, dz = pz - this.pos.z;
    const dy = py - this.eyeY;
    const dist = Math.hypot(dx, dy, dz);

    /**
     * ── 玩家有多显眼 ──
     *
     * 手电开着       ×1.8（自己的锥光，方向感很强）
     * 站在应急灯下   ×2.0（持续、全向，比手电更糟）
     * 两者都没有     手电的 ×0.45 再 ×shadowMul（藏在暗处）
     *
     * 应急灯倍率**取代**而不是叠乘手电倍率：关着手电站在灯下不该比
     * 开着手电还安全，否则「打碎灯」这个决策就没有意义了。
     */
    const lampLit = this.lights ? this.lights.litAt(px, player.pos.y, pz) : false;
    let lightMul = lampLit ? LIGHT.emergencyLamp.litDetectMul : flashlight.detectionMultiplier;
    // chameleon：只打折「灯下 / 开灯」的暴露倍率，暗处仍走原 offDetectMul × shadowMul
    if (lampLit || flashlight.on) {
      lightMul *= (player.loadoutModifiers?.litExposureMul ?? 1);
    }
    let range = perc().visionRange
      * lightMul
      * (player.loadoutModifiers?.detectionMult ?? 1);
    if (this.archetype === ARCHETYPE.SENTRY) range *= PERCEPTION.sentryRangeMul;
    // 手电与应急灯都没照到 → 藏在阴影里，更难被发现
    if (!flashlight.on && !lampLit) range *= PERCEPTION.shadowMul;

    if (dist > range) return false;

    // 极近距离无条件察觉（贴身公平性）
    if (dist < 2.5) return !this.world.lineBlocked(this.pos.x, this.eyeY, this.pos.z, px, py, pz);

    // 视野锥：水平 + 垂直
    const fwdX = -Math.sin(this.yaw), fwdZ = -Math.cos(this.yaw);
    const hLen = Math.hypot(dx, dz) || 1;
    const cosH = (dx / hLen) * fwdX + (dz / hLen) * fwdZ;
    if (cosH < Math.cos(PERCEPTION.hFovDeg * Math.PI / 360)) return false;
    const vAngle = Math.abs(Math.atan2(dy, hLen));
    if (vAngle > PERCEPTION.vFovDeg * Math.PI / 360) return false;

    return !this.world.lineBlocked(this.pos.x, this.eyeY, this.pos.z, px, py, pz);
  }

  /**
   * 听到噪音 → 进入调查，或（大口径武器）直接跳级到警戒。
   *
   * @param loud 是否为「大口径」噪音（见 combat.emitNoise 与
   *             config.NOISE_SPIKE_THRESHOLD）。true 时 IDLE 敌人
   *             跳过慢悠悠的 INVESTIGATE，直接举枪进入 ALERT ——
   *             霰弹/DMR 的枪声就是这么大，听到不该只是「走过去看看」。
   * @param isFootstep 是否为脚步声。脚步噪音不穿墙（需要 LOS 或开放路径）。
   */
  hearNoise(x, y, z, radius, loud = false, world = null, isFootstep = false) {
    if (this.dead || this.state === STATE.COMBAT) return false;
    const p = perc();
    const dy = Math.abs(y - this.pos.y);
    /**
     * 听觉灵敏度随难度放大（hearRangeMul）：专家档 1.8 倍。
     * 这是「aggression 随难度上升」里最先被玩家感受到的一环 ——
     * 同一声枪响，简单档只有隔壁听得到，专家档半层楼都会过来查。
     */
    let effective = radius * p.hearRangeMul;
    // 跨楼板衰减
    if (dy > 2) effective *= PERCEPTION.crossFloorMul;

    /**
     * ── 遮挡衰减：声音穿墙会变小 ──
     *
     * 之前只比距离，于是一声枪响能让整栋楼 15 个人同时开始查房 ——
     * 玩家在最角落的房间开一枪，另一头封闭房间里的人也「听见」了，
     * 既不真实也让潜行毫无意义（反正所有人都会来）。
     *
     * 现在沿声源→听者的直线数出中间隔了几层不透光方块，每一层按
     * NOISE_WALL_MUL 衰减。隔一道墙还听得见（闷响），隔三四道就基本
     * 传不过去了。开着的门不算遮挡 —— 门开着声音就是直接传过来的，
     * 这也让「关门」第一次有了战术价值。
     */
    const w = world ?? this.world;
    if (w) {
      const layers = countOpaqueLayers(w, x, y + 0.6, z, this.pos.x, this.eyeY, this.pos.z);
      /**
       * ── 脚步噪音：不穿墙 ──
       *
       * 脚步与枪声的传播方式完全不同。枪声是爆炸性脉冲，能隔墙传递闷响；
       * 脚步是结构振动，只在开放空间或薄门缝传播。
       *
       * 实现：隔超过 1 层墙直接听不到（不只是衰减）。「1 层」覆盖开着的门
       * （门是空气，算 0 层）和半掩的门（薄门板，算 1 层），但完全隔断
       * 厚实墙体（2 格 = 2 层）。这让「关门挡脚步」成为真正的潜行工具。
       */
      if (isFootstep && layers > 1) return false;
      effective *= Math.pow(PERCEPTION.noiseWallMul, layers);
    }

    const d = Math.hypot(x - this.pos.x, y - this.pos.y, z - this.pos.z);
    if (d > effective) return false;
    // A new stimulus supersedes a pending return-home route as well as any
    // blocked cross-room plan; the next investigation must honor this clue.
    this.clearReturnHome();
    this.investigateTarget = new THREE.Vector3(x, y, z);
    this.clearCrossRoomPlan();
    this.crossBlocked = false;
    // 记下噪音来源，供 doInvestigate 判断「到了以后要不要往房间深处搜」
    this.searchOrigin = new THREE.Vector3(x, y, z);
    if (this.state === STATE.IDLE) {
      if (loud) {
        this.toAlert();
      } else {
        this.state = STATE.INVESTIGATE;
        this.stateTime = 0;
      }
    }
    return true;
  }

  /** 被同伴呼叫 → 进入警戒 */
  onCalled(x, y, z) {
    if (this.dead || this.state === STATE.COMBAT) return;
    this.alerted = true;
    this.clearReturnHome();
    this.clearCrossRoomPlan();
    this.investigateTarget = new THREE.Vector3(x, y, z);
    if (this.state === STATE.IDLE) { this.state = STATE.INVESTIGATE; this.stateTime = 0; }
  }

  update(dt, now, ctx) {
    // 死了也要继续推进倒地动画（约 0.45 秒），不能直接 return
    if (this.dead) {
      this.rig.setLampOn(false);
      this.rig.updateDeath(dt);
      return;
    }
    const { player, flashlight, combat } = ctx;
    this.stateTime += dt;
    this.weapon.update(now, dt);
    this.updateStance(dt);

    /**
     * 每帧卡墙自救。
     *
     * 出生点脱困只覆盖初始布置；运行时还有两条路会把敌人挤进墙里：
     * resolveOverlap 的互推、以及起身时高度从 1.0 变 1.8（蹲着能待的位置
     * 站起来可能就顶进墙）。检测很便宜（一次 AABB），不做的代价是
     * 「敌人卡在墙里，打不着也不动」——玩家只会当成 bug。
     */
    if (this.blockedAt(this.pos.x, this.pos.z)) this.escapeIfStuck(2);

    const sees = this.canSeePlayer(player, flashlight);
    // 光斑先于你抵达：敌人察觉手电光斑，不需要看见玩家本人
    const spotsLight = !sees && flashlight.spotNoticedBy(this.pos.x, this.pos.y, this.pos.z);

    if (sees) {
      this.lastSeenPlayer.set(player.pos.x, player.pos.y, player.pos.z);
      this.hasLastSeen = true;
    }

    this.updateAlert(dt, sees, spotsLight, flashlight);

    /**
     * ── 脚步噪音听觉检测（每帧）──
     *
     * 玩家移动时持续发出噪音，敌人每帧检查是否在听觉范围内。
     * 与枪声不同，脚步噪音不穿墙（hearNoise 的 isFootstep 分支处理）。
     *
     * 为什么要每帧检查：脚步是连续噪音，不是脉冲事件。玩家走近时敌人应该
     * 逐渐察觉，而不是「踩到某个格子才触发」。移动速度阈值在 player.noiseRadius
     * 里已经处理（静止时返回 0），这里只需要判断半径是否 > 0。
     *
     * 战斗中不响应脚步声（已经在交火了，脚步无关紧要）；致盲时也不响应
     * （感官失效）。其它状态（IDLE / INVESTIGATE / ALERT）都会因为脚步转向。
     */
    if (this.state !== STATE.COMBAT && this.state !== STATE.BLINDED) {
      const footstepRadius = player.noiseRadius;
      if (footstepRadius > 0) {
        this.hearNoise(
          player.pos.x, player.pos.y, player.pos.z,
          footstepRadius, false, this.world, true
        );
      }
    }

    switch (this.state) {
      case STATE.BLINDED:
        // 致盲：无法射击，原地转身
        this.yaw += dt * 2.2;
        if (now >= this.blindUntil) {
          this.state = sees ? STATE.COMBAT : STATE.INVESTIGATE;
          this.stateTime = 0;
        }
        break;

      case STATE.IDLE:
        this.doIdle(dt, sees, spotsLight, player, now);
        break;

      case STATE.INVESTIGATE:
        this.doInvestigate(dt, sees, ctx, now);
        break;

      case STATE.ALERT:
        // 举枪窗口：玩家唯一的反应机会。
        // 同样只在看得见时跟枪；玩家在举枪期间躲回掩体应该能甩掉瞄准。
        if (sees) this.faceTarget(player, dt, PERCEPTION.turnRateAlert);
        else if (this.hasLastSeen) {
          this.faceToward(this.lastSeenPlayer, dt, PERCEPTION.turnRateSearch);
        }
        this.reactionTimer -= dt;
        this.rig.gunPivot.rotation.x = -0.35;      // 可见的举枪动作
        if (this.reactionTimer <= 0) {
          this.state = STATE.COMBAT;
          this.stateTime = 0;
          this.callAllies(ctx);
        }
        break;

      case STATE.COMBAT:
        this.doCombat(dt, now, sees, ctx);
        break;
    }

    // 视觉更新。方块人形永远是直立的，只有蹲/站两种姿态。
    this.rig.root.position.copy(this.pos);
    this.rig.setLampOn(this.flashlightOn);
    this.rig.update(dt, {
      speed: this.moveSpeed,
      yaw: this.yaw,
      pitch: 0,
      crouchAmt: this.crouchAmt,
      leanAmt: 0,
      aiming: this.state === STATE.COMBAT || this.state === STATE.ALERT,
    });
    this.moveSpeed = 0;      // 由 moveToward 每帧重新置位
  }

  doIdle(dt, sees, spotsLight, player, now = 0) {
    /**
     * 盾兵是守点，不参加普通敌人的左右扫视。否则他会在玩家还没接近时
     * 随机把护盾转向墙面，玩家绕进来却正好得到免费背刺，招牌敌人的
     * 「正面封锁」就变成纯随机。固定面朝由关卡配置给定；真正看见人后
     * 仍会以 turnRateMul 0.45 缓慢转身，绕后依然有意义。
     */
    if (this.behaviorMode === 'patrol') {
      this.walkPatrol(dt);
    } else if (this.behaviorMode === 'wander') {
      this.doWander(dt, now);
    } else if (this.isShield) return;

    if (this.isAmbusher && this.behaviorMode !== 'wander'
        && this.behaviorMode !== 'patrol') {
      /**
       * 伏击者：蹲在掩体后不动，玩家靠近或被看见 → 站起来反击。
       *
       * 关键修正：原来只看水平距离就惊起，等于隔着墙感知玩家 ——
       * 玩家在隔壁房间走过，伏击者就站起来了。现在要求有视线，
       * 「贴脸」才无条件惊起（那时候听得到脚步，合理）。
       */
      const d = Math.hypot(this.pos.x - player.pos.x, this.pos.z - player.pos.z);
      const veryClose = d < 2.2;
      const inRange = d < PERCEPTION.ambushWakeRange
        && !this.world.lineBlocked(
          this.pos.x, this.eyeY, this.pos.z,
          player.pos.x, player.pos.y + 1.0, player.pos.z
        );
      if (sees || veryClose || inRange) {
        this.standUp();
        this.toAlert();
      }
      return;
    }

    if (this.behaviorMode !== 'patrol' && this.behaviorMode !== 'wander') {

      /**
       * 蹲守者：持续左右扫视（含手电），不再是「定住→甩头→定住」。
       *
       * 用一个正弦摆动驱动 yaw，扫视本身就是连续动作，没有任何静止
       * 的瞬间——手电挂在头部朝向上，摆动自然带出「左右扫光」。
       * 摆动中心 scanCenter 每隔一段时间悄悄挪一次（仍避开墙面），
       * 挪动过程也走同一套 turnRateSearch，不会显得突兀。
       */
      this.scanShiftTimer -= dt;
      if (this.scanShiftTimer <= 0) {
        this.scanShiftTimer = 8 + this.random() * 4;
        this.scanCenter = this.pickOpenDirection();
      } else if (this.facesWall(this.scanCenter, 1.4)) {
        // 中心本身朝墙（比如刚经历过 escapeIfStuck）：提前换一次，不等定时器
        this.scanCenter = this.pickOpenDirection();
      }
      this.scanPhase += dt * (Math.PI * 2 / PERCEPTION.scanPeriod);
      let target = this.scanCenter + Math.sin(this.scanPhase) * PERCEPTION.scanAmplitudeRad;
      // Keep the sweep itself out of a wall, rather than waiting for the
      // smoothed yaw to catch up after it has already turned into one.
      if (this.facesWall(target, 1.4)) {
        const open = this.pickOpenDirection(Math.PI);
        if (!this.facesWall(open, 1.4)) {
          this.scanCenter = open;
          target = open;
        }
      }
      this.yaw += angleDiff(target, this.yaw) * Math.min(1, dt * PERCEPTION.turnRateSearch);
      if (this.facesWall(this.yaw, 1.4)) {
        const open = this.pickOpenDirection(Math.PI);
        if (!this.facesWall(open, 1.4)) this.yaw = open;
      }
    }

    if (sees) this.toAlert();
    else if (spotsLight) {
      // 看到光斑 → 警戒（不是立刻开火，因为还没看见人）
      this.state = STATE.INVESTIGATE;
      this.stateTime = 0;
      this.investigateTarget = null;
      // 没有具体目标点，立刻进入张望摆动，中心就是当前朝向
      this.investScanCenter = this.yaw;
      this.investScanPhase = 0;
      this.alerted = true;
    }
  }

  /**
   * 挑一个「看得远」的朝向，避免面对墙壁。
   *
   * 在 homeYaw 附近撒 9 个候选角，各射一条视线，取能看最远的那个。
   * 不是全向搜索 —— 蹲守者应该大致守着自己的岗位方向，
   * 只是不要蠢到贴脸瞪墙。
   */
  pickOpenDirection(spreadRad = 1.3) {
    // 先收集扇区内所有「不贴墙」的候选方向
    const open = [];
    let bestYaw = this.homeYaw, bestDist = -1;
    for (let i = 0; i < 13; i++) {
      const cand = this.homeYaw + (i / 12 - 0.5) * 2 * spreadRad;
      const hit = this.world.raycast(
        this.pos.x, this.eyeY, this.pos.z,
        -Math.sin(cand), 0, -Math.cos(cand), 22, true
      );
      const dist = hit ? hit.dist : 22;
      if (dist > bestDist) { bestDist = dist; bestYaw = cand; }
      if (dist >= 3.5) open.push(cand);
    }

    // 有开阔方向就随机挑一个 —— 每次都选「最远」会让敌人反复盯同一处，
    // 随机化让扫视看起来像在真的巡视房间。
    if (open.length > 0) return open[(this.random() * open.length) | 0];

    // 整个扇区都贴墙（敌人被塞在角落里）→ 全向搜索一个能看得远的方向
    if (bestDist < 3.5 && spreadRad < Math.PI) {
      for (let i = 0; i < 16; i++) {
        const cand = (i / 16) * Math.PI * 2;
        const hit = this.world.raycast(
          this.pos.x, this.eyeY, this.pos.z,
          -Math.sin(cand), 0, -Math.cos(cand), 22, true
        );
        if ((hit ? hit.dist : 22) >= 4.0) return cand;
      }
    }
    return bestYaw;
  }

  doInvestigate(dt, sees, ctx = null, now = 0) {
    if (sees) { this.clearReturnHome(); this.toAlert(); return; }
    this.standUp();          // 起身查看，不会蹲着走路
    if (this.returnHome.active) {
      this.doReturnHome(dt, ctx, now);
      return;
    }
    const p = perc();
    const mv = { doors: ctx?.doors, now };
    const nav = this.navigation;
    const currentRoom = nav?.getRoomAt?.(this.pos.x, this.pos.z);
    const targetRoom = this.investigateTarget && nav?.getRoomAt?.(
      this.investigateTarget.x, this.investigateTarget.z
    );
    const crossTarget = this.canCrossRooms && nav && this.investigateTarget
      && (!currentRoom || !targetRoom || currentRoom !== targetRoom);
    if (crossTarget) {
      if (this.pathRevision !== nav.doorRevision) {
        this.clearCrossRoomPlan();
        this.pathRevision = nav.doorRevision;
      }
      // A failed cross-room target is suspended, rather than handed to the
      // local steering fallback which could push through an arbitrary wall.
      if (this.crossBlocked) {
        this.investigateTarget = null;
      } else if (now >= this.crossFailureUntil) {
        if (!this.crossPlan) this.planCrossRoom(this.investigateTarget, 'investigate');
        if (this.crossPlan) {
          const status = this.moveCrossRoom(dt, 1.5 + p.pushChance * 1.2, now, 'investigate');
          if (status === 'arrived') this.investigateTarget = null;
          if (status !== 'failed') return;
        }
        this.crossFailureUntil = now + 1.2;
        this.crossBlocked = true;
        this.investigateTarget = null;
      } else {
        // A cooldown is also a hard no-go for direct steering, even if an
        // external caller cleared the marker but retained the suspended timer.
        this.investigateTarget = null;
      }
    }
    if (this.investigateTarget) {
      // 查房速度：难度越凶走得越快（专家档几乎是小跑着冲进来）
      const speed = 1.5 + p.pushChance * 1.2;
      const arrived = this.moveToward(this.investigateTarget, dt, speed, mv);
      if (arrived) {
        this.investigateTarget = null;
        /**
         * 到了噪音点还是没人 → 继续往房间深处搜（searchRooms）。
         *
         * 只走到噪音点就停下的话，玩家只要开完枪往房间里退两步就绝对安全 ——
         * 敌人会站在门口环视几秒然后回去巡逻。往里推进才让「他们会来查房」
         * 这件事真的有威胁：敌人会沿着能走的方向往房间里推。
         */
        if (p.searchRooms) {
          const next = this.pickSearchPoint();
          if (next) this.investigateTarget = next;
        }
        if (!this.investigateTarget) {
          this.investScanCenter = this.yaw;
          this.investScanPhase = 0;
        }
      }
    } else {
      /** 没有目标点：持续左右张望找人。 */
      this.investScanPhase += dt * (Math.PI * 2 / PERCEPTION.investScanPeriod);
      const target = this.investScanCenter
        + Math.sin(this.investScanPhase) * PERCEPTION.investScanAmplitudeRad;
      this.yaw += angleDiff(target, this.yaw) * Math.min(1, dt * PERCEPTION.turnRateSearch);
      this.lookYaw = this.yaw;
    }
    if (this.stateTime > p.investigateTime) {
      // Wander/patrol actors with room navigation return to their own birth
      // anchor. Legacy actors retain the original local investigation ending.
      if (this.beginReturnHome(now)) {
        this.doReturnHome(dt, ctx, now);
        return;
      }
      this.state = STATE.IDLE;
      this.stateTime = 0;
      this.investigateTarget = null;
      this.scanCenter = this.yaw;
      this.scanPhase = 0;
      this.scanShiftTimer = 8 + this.random() * 4;
      this.investScanCenter = this.yaw;
      this.investScanPhase = 0;
      if (this.behaviorMode === 'wander') {
        this.wanderTarget = null;
        this.wanderPath = [];
        this.wanderWaypointIndex = 0;
        this.wanderStall = 0;
        this.wanderPause = 0.8;
      } else if (this.patrol) {
        this.patrolIdx = this.nearestPatrolIndex();
      }
    }
  }

  /**
   * 查房时的下一个搜索点：朝当前朝向的前方扇区里挑一个「走得到、且离
   * 噪音源不太远」的开阔点。
   *
   * 不做真正的寻路（本作没有导航网格），但这已经足够让搜索看起来
   * 有目的：敌人会沿着能走的方向往房间里推，而不是站在门口原地转圈。
   * 离噪音源超过 14 vox 就不再往外扩 —— 否则敌人会一路搜到地图另一头，
   * 玩家再也遇不到他，反而降低压迫感。
   */
  pickSearchPoint() {
    const origin = this.searchOrigin ?? this.pos;
    let best = null, bestScore = -Infinity;
    for (let i = 0; i < 12; i++) {
      // 以当前朝向为中心撒开，偏向正前方
      const ang = this.yaw + (this.random() - 0.5) * Math.PI * 1.2;
      const dist = 3 + this.random() * 5;
      const tx = this.pos.x - Math.sin(ang) * dist;
      const tz = this.pos.z - Math.cos(ang) * dist;
      if (this.blockedAt(tx, tz)) continue;
      // 视线必须通畅，否则「走得到」只是错觉（会卡在墙角）
      if (this.world.lineBlocked(this.pos.x, this.eyeY, this.pos.z, tx, this.eyeY, tz)) continue;
      const fromOrigin = Math.hypot(tx - origin.x, tz - origin.z);
      if (fromOrigin > 14) continue;
      // 越远越好（推进得更深），但离噪音源太远要扣分
      const score = dist - fromOrigin * 0.35;
      if (score > bestScore) { bestScore = score; best = new THREE.Vector3(tx, this.pos.y, tz); }
    }
    return best;
  }

  clearCrossRoomPlan() {
    this.crossPlan = null;
    this.crossPlanIndex = 0;
    this.crossPhase = 'idle';
    this.crossWait = 0;
    this.crossDoorRetries = 0;
    this.crossBlocked = false;
  }

  crossRoomDelay(kind = 'wander') {
    const ranges = {
      wander: [0.35, 0.55],
      investigate: [0.2, 0.4],
      combat: [0.25, 0.45],
    };
    const [min, max] = ranges[kind] ?? ranges.wander;
    return min + this.random() * (max - min);
  }

  /** Build one bounded, sequential plan from the current room to a target. */
  planCrossRoom(target, kind = 'wander', allowedRooms = null) {
    const nav = this.navigation;
    if (!this.canCrossRooms || !nav?.findDoorPath || !this.validWanderPoint(target)) return null;
    const fromRoom = nav.getRoomAt?.(this.pos.x, this.pos.z);
    const targetRoom = nav.getRoomAt?.(target.x, target.z);
    if (!fromRoom || !targetRoom || fromRoom === targetRoom) return null;
    if (Array.isArray(allowedRooms) && allowedRooms.length > 0
        && !allowedRooms.includes(targetRoom)) return null;
    const path = nav.findDoorPath(fromRoom, targetRoom);
    if (!path?.links?.length || path.rooms?.[0] !== fromRoom) return null;

    const steps = path.links.map((link, index) => {
      const forward = path.rooms[index] === link.from;
      const staging = Array.isArray(link.staging) ? link.staging : [];
      const entry = staging[forward ? 0 : 1];
      const exit = staging[forward ? 1 : 0];
      if (!this.validWanderPoint(entry) || !this.validWanderPoint(exit)) return null;
      const passage = link.door && typeof link.door === 'object'
        ? (link.door.through === 'z'
          ? { x: link.door.x + (Number(link.door.span ?? 1) / 2), z: link.door.z + 0.5 }
          : { x: link.door.x + 0.5, z: link.door.z + (Number(link.door.thick ?? 1) / 2) })
        : (link.opening && typeof link.opening === 'object'
          ? (link.opening.through === 'z'
            ? { x: link.opening.x + (Number(link.opening.span ?? 1) / 2), z: link.opening.z + (Number(link.opening.thick ?? 1) / 2) }
            : { x: link.opening.x + (Number(link.opening.thick ?? 1) / 2), z: link.opening.z + (Number(link.opening.span ?? 1) / 2) })
          : exit);
      if (!this.validWanderPoint(passage)) return null;
      return {
        link,
        fromRoom: path.rooms[index],
        toRoom: path.rooms[index + 1],
        entry,
        passage,
        exit,
        door: link.door ?? null,
      };
    });
    if (steps.some((step) => !step)) return null;
    const plan = {
      fromRoom, targetRoom, target: new THREE.Vector3(target.x, this.pos.y, target.z),
      steps, stepIndex: 0, path: [], pathIndex: 0, phase: 'entry',
      kind, revision: nav.doorRevision, wait: 0, failures: 0,
    };
    if (!this.setCrossLocalPath(plan, { x: this.pos.x, z: this.pos.z }, steps[0].entry)) {
      return null;
    }
    this.crossPlan = plan;
    this.crossPlanIndex = 0;
    this.crossPhase = 'entry';
    this.crossBlocked = false;
    this.pathRevision = nav.doorRevision;
    return plan;
  }

  setCrossLocalPath(plan, start, goal) {
    const nav = this.navigation;
    const roomId = nav?.getRoomAt?.(start.x, start.z);
    const goalRoom = nav?.getRoomAt?.(goal.x, goal.z);
    if (!roomId || roomId !== goalRoom || !nav?.findLocalPath) return false;
    const path = nav.findLocalPath(start, goal, {
      roomId, maxNodes: 192, maxDistance: 48,
    });
    if (!Array.isArray(path) || path.length === 0
        || path.some((point) => !this.validWanderPoint(point))) return false;
    plan.path = path;
    plan.pathIndex = 0;
    return true;
  }

  /** Move the current cross-room plan one bounded stage at a time. */
  moveCrossRoom(dt, speed, now, kind = 'wander') {
    const plan = this.crossPlan;
    const nav = this.navigation;
    if (!plan || !nav) return 'failed';
    if (plan.revision !== nav.doorRevision) {
      this.clearCrossRoomPlan();
      this.pathRevision = nav.doorRevision;
      return 'replan';
    }
    const step = plan.steps[plan.stepIndex];
    if (!step) {
      const d = Math.hypot(plan.target.x - this.pos.x, plan.target.z - this.pos.z);
      if (d < 0.6) { this.clearCrossRoomPlan(); return 'arrived'; }
      if (plan.phase !== 'goal') {
        if (!this.setCrossLocalPath(plan, { x: this.pos.x, z: this.pos.z }, plan.target)) {
          this.clearCrossRoomPlan(); return 'failed';
        }
        plan.phase = 'goal';
      }
    }

    if (plan.phase === 'entry' || plan.phase === 'goal') {
      const waypoint = plan.path[plan.pathIndex];
      if (!waypoint) {
        if (plan.phase === 'goal') { this.clearCrossRoomPlan(); return 'arrived'; }
        plan.phase = 'door';
      } else {
        const arrived = this.moveToward(waypoint, dt, speed);
        if (arrived || Math.hypot(waypoint.x - this.pos.x, waypoint.z - this.pos.z) < 0.12) {
          if (plan.pathIndex < plan.path.length - 1) plan.pathIndex += 1;
          else if (plan.phase === 'entry') plan.phase = 'door';
          else { this.clearCrossRoomPlan(); return 'arrived'; }
        }
        return 'moving';
      }
    }

    if (plan.phase === 'door') {
      const door = step.door && this.services.doors?.byKey
        ? this.services.doors.byKey(step.link.doorKey ?? step.door) : null;
      const needsOpen = !!door && !door.destroyed && !door.open;
      if (step.link.requiresOpen && !door) {
        plan.failures = (plan.failures ?? 0) + 1;
        if (plan.failures >= 3) {
          this.clearCrossRoomPlan();
          return 'failed';
        }
        plan.wait = 0.45 + this.random() * 0.25;
        return 'blocked';
      }
      if (!needsOpen) {
        plan.phase = 'cross';
      } else {
        if (plan.wait <= 0) {
          plan.wait = this.crossRoomDelay(kind);
          this.crossWait = plan.wait;
          // The first frame at the door starts the pause; do not consume part
          // of the product-defined pause before the actor has visibly stopped.
          return 'waiting';
        }
        plan.wait -= dt;
        this.crossWait = Math.max(0, plan.wait);
        if (plan.wait > 0) return 'waiting';
        const opened = this.services.doors?.requestAIOpen?.(door, this, {
          navigation: nav,
          onDoorNoise: this.services.onDoorNoise,
        });
        if (!opened) {
          plan.failures = (plan.failures ?? 0) + 1;
          plan.wait = 0.45 + this.random() * 0.25;
          this.crossDoorRetries = plan.failures;
          if (plan.failures >= 3) {
            this.clearCrossRoomPlan();
            return 'failed';
          }
          return 'blocked';
        }
        // Keep the old plan revision. The next frame observes the increment and
        // discards every cached local segment, including the segment behind the
        // door that just changed state.
        return 'opened';
      }
    }

    if (plan.phase === 'cross') {
      // Unlike ordinary steering, crossing must reach the far staging point;
      // stopping 0.6 vox away leaves the actor inside the door gap.
      const arrived = this.moveToward(step.exit, dt, speed, { arrivalDistance: 0.12 });
      if (!arrived) return 'crossing';
      plan.stepIndex += 1;
      if (plan.stepIndex >= plan.steps.length) {
        plan.phase = 'goal';
        if (!this.setCrossLocalPath(plan, { x: this.pos.x, z: this.pos.z }, plan.target)) {
          this.clearCrossRoomPlan(); return 'failed';
        }
      } else {
        const next = plan.steps[plan.stepIndex];
        plan.phase = 'entry';
        if (!this.setCrossLocalPath(plan, { x: this.pos.x, z: this.pos.z }, next.entry)) {
          this.clearCrossRoomPlan(); return 'failed';
        }
      }
      return 'crossed';
    }
    return 'moving';
  }

  chooseCrossWanderTarget() {
    const nav = this.navigation;
    const currentRoom = nav?.getRoomAt?.(this.pos.x, this.pos.z) ?? this.anchorRoom;
    if (!nav || !currentRoom) return null;
    const candidates = (this.wanderRooms.length > 0
      ? this.wanderRooms : [currentRoom, this.anchorRoom]).filter((room, index, list) =>
        room && room !== currentRoom && list.indexOf(room) === index
        && nav.getRoomNodes?.(room)?.length > 0);
    if (candidates.length === 0) return null;
    const room = candidates[Math.floor(this.random() * candidates.length)];
    const nodes = nav.getRoomNodes(room).filter((node) => this.validWanderPoint(node));
    if (nodes.length === 0) return null;
    const start = Math.floor(this.random() * nodes.length);
    for (let i = 0; i < nodes.length; i++) {
      const node = nodes[(start + i) % nodes.length];
      const target = new THREE.Vector3(node.x, this.pos.y, node.z);
      if (this.planCrossRoom(target, 'wander', this.wanderRooms.length ? this.wanderRooms : null)) {
        this.wanderTarget = target;
        this.wanderPath = [];
        this.wanderWaypointIndex = 0;
        return target;
      }
    }
    return null;
  }

  /**
   * Choose a legal local target for Wander. Room links are consulted only for
   * explicitly enabled cross-room Wander specs.
   */
  chooseWanderTarget() {
    if (this.canCrossRooms) {
      const crossTarget = this.chooseCrossWanderTarget();
      if (crossTarget) return crossTarget;
    }
    const nav = this.navigation;
    this.ensureWanderContext();
    if (!nav || typeof nav.getRoomNodes !== 'function'
        || typeof nav.findLocalPath !== 'function') {
      this.wanderTarget = null;
      this.wanderPath = [];
      this.wanderWaypointIndex = 0;
      return null;
    }

    const roomId = nav.getRoomAt?.(this.pos.x, this.pos.z) ?? this.anchorRoom;
    if (!roomId) {
      this.wanderTarget = null;
      this.wanderPath = [];
      this.wanderWaypointIndex = 0;
      this.wanderPause = Math.max(this.wanderPause, 0.8);
      return null;
    }
    const nodes = nav.getRoomNodes(roomId);
    if (!Array.isArray(nodes) || nodes.length === 0) {
      this.wanderTarget = null;
      this.wanderPath = [];
      this.wanderWaypointIndex = 0;
      this.wanderPause = Math.max(this.wanderPause, 0.8);
      return null;
    }

    const history = Array.isArray(this.wanderRecentTargets)
      ? this.wanderRecentTargets.slice(-8) : [];
    const recent = history.slice(-3);
    const point = (value) => Array.isArray(value)
      ? { x: Number(value[0]), z: Number(value[1]) }
      : { x: Number(value?.x), z: Number(value?.z) };
    const distance = (a, b) => Math.hypot(a.x - b.x, a.z - b.z);
    const anchor = { x: this.anchor.x, z: this.anchor.z };
    const current = { x: this.pos.x, z: this.pos.z };
    const maxDistance = Number.isFinite(this.homeRadius) ? this.homeRadius : 5;

    // The stable source order from NavigationIndex is retained; RNG only picks
    // which candidate to try next, making a seeded sequence reproducible.
    const candidates = nodes.filter((node) => {
      const p = point(node);
      if (!Number.isFinite(p.x) || !Number.isFinite(p.z)) return false;
      if (distance(anchor, p) > maxDistance + 1e-6) return false;
      if (typeof nav.isWalkablePoint === 'function' && !nav.isWalkablePoint(
        p.x, p.z, { roomId, y: this.pos.y, entityRadius: this.radius, entityHeight: this.height }
      )) return false;
      return true;
    });

    let attemptsRemaining = 18;
    const find = (pool, minCurrent, minRecent) => {
      const available = pool.filter((node) => {
        const p = point(node);
        return distance(current, p) >= minCurrent
          && recent.every((old) => distance(point(old), p) >= minRecent);
      });
      const limit = Math.min(attemptsRemaining, available.length);
      for (let i = 0; i < limit; i++) {
        attemptsRemaining -= 1;
        const index = Math.floor(this.random() * available.length);
        const [node] = available.splice(index, 1);
        const p = point(node);
        const path = nav.findLocalPath(
          { x: this.pos.x, z: this.pos.z }, p,
          { roomId, maxNodes: 96, maxDistance: 14 }
        );
        if (!Array.isArray(path) || path.length === 0) continue;
        if (path.some((waypoint) => !this.validWanderPoint(waypoint))) continue;
        if (path.some((waypoint) => distance(anchor, point(waypoint)) > maxDistance + 1e-6)) continue;
        const target = new THREE.Vector3(p.x, this.pos.y, p.z);
        this.wanderTarget = target;
        this.wanderPath = path.slice();
        this.wanderWaypointIndex = 0;
        this.wanderStall = 0;
        this.wanderRecentTargets = [...history, { x: p.x, z: p.z }].slice(-8);
        return target;
      }
      return null;
    };

    let target = find(candidates, 4, 2.5);
    if (!target) {
      // A cramped room can legitimately exhaust the strict filters. Relax only
      // after the bounded 18-attempt pass, then cool down if no path exists.
      target = find(candidates, 2.5, 1.25);
    }
    if (!target) {
      this.wanderTarget = null;
      this.wanderPath = [];
      this.wanderWaypointIndex = 0;
      this.wanderPause = Math.max(this.wanderPause, 0.8);
    }
    return target;
  }

  beginWanderPause() {
    this.wanderTarget = null;
    this.wanderPath = [];
    this.wanderWaypointIndex = 0;
    this.wanderStall = 0;
    this.wanderPause = 1.2 + this.random() * 1.4;
    this.wanderScanCenter = this.yaw;
    this.wanderScanPhase = 0;
    this.wanderScanAmplitude = (25 + this.random() * 25) * Math.PI / 180;
  }

  /** Wander fallback uses the same continuous, wall-aware idle scan as Sentry. */
  doWanderFallbackScan(dt) {
    this.scanShiftTimer -= dt;
    if (this.scanShiftTimer <= 0) {
      this.scanShiftTimer = 8 + this.random() * 4;
      this.scanCenter = this.pickOpenDirection();
    } else if (this.facesWall(this.scanCenter, 1.4)) {
      this.scanCenter = this.pickOpenDirection();
    }
    this.scanPhase += dt * (Math.PI * 2 / PERCEPTION.scanPeriod);
    const target = this.scanCenter + Math.sin(this.scanPhase) * PERCEPTION.scanAmplitudeRad;
    this.yaw += angleDiff(target, this.yaw) * Math.min(1, dt * PERCEPTION.turnRateSearch);
  }

  doWander(dt, now = 0) {
    if (this.state !== STATE.IDLE || this.behaviorMode !== 'wander') return;
    const nav = this.navigation;
    this.ensureWanderContext();
    if (!nav || typeof nav.getRoomNodes !== 'function'
        || typeof nav.findLocalPath !== 'function') {
      this.doWanderFallbackScan(dt);
      return;
    }

    if (this.pathRevision !== nav.doorRevision) {
      // Door state changed. Keep the chosen room/target, but discard every
      // local segment and rebuild the staged route from the current position.
      this.clearCrossRoomPlan();
      this.wanderPath = [];
      this.wanderWaypointIndex = 0;
      this.pathRevision = nav.doorRevision;
    }

    if (this.wanderPause > 0) {
      this.wanderPause = Math.max(0, this.wanderPause - dt);
      this.wanderScanPhase += dt * (Math.PI * 2 / this.wanderScanPeriod);
      const targetYaw = this.wanderScanCenter
        + Math.sin(this.wanderScanPhase) * this.wanderScanAmplitude;
      this.yaw += angleDiff(targetYaw, this.yaw)
        * Math.min(1, dt * PERCEPTION.turnRateSearch);
      if (this.wanderPause > 0) return;
    }

    const currentRoom = nav.getRoomAt?.(this.pos.x, this.pos.z) ?? this.anchorRoom;
    const targetRoom = this.wanderTarget
      ? nav.getRoomAt?.(this.wanderTarget.x, this.wanderTarget.z) : null;
    if (this.canCrossRooms && this.crossPlan) {
        const status = this.moveCrossRoom(dt, 1.15, now, 'wander');

      if (status === 'arrived') this.beginWanderPause();
      else if (status === 'failed') {
        this.wanderTarget = null;
        this.wanderPause = 0.8;
      }
      return;
    }
    if (this.canCrossRooms && (!this.wanderTarget || !this.crossPlan)) {
      const targetRoomId = this.wanderTarget
        ? nav.getRoomAt?.(this.wanderTarget.x, this.wanderTarget.z) : null;
      if (targetRoomId && targetRoomId !== currentRoom) {
        this.planCrossRoom(this.wanderTarget, 'wander',
          this.wanderRooms.length ? this.wanderRooms : null);
      } else if (this.chooseCrossWanderTarget()) {
        return;
      }
      if (this.crossPlan) return;
    }

    if (!this.wanderTarget || !Array.isArray(this.wanderPath)
        || this.wanderWaypointIndex >= this.wanderPath.length) {
      if (!this.chooseWanderTarget()) return;
    }

    const target = this.wanderTarget;
    const roomId = nav.getRoomAt?.(this.pos.x, this.pos.z) ?? this.anchorRoom;
    if (!this.validWanderPoint(target)
        || (this.anchorRoom && roomId && roomId !== this.anchorRoom)
        || Math.hypot(target.x - this.anchor.x, target.z - this.anchor.z)
          > this.homeRadius + 1e-6) {
      this.wanderTarget = null;
      this.wanderPath = [];
      this.wanderWaypointIndex = 0;
      this.wanderPause = 0.8;
      return;
    }

    const waypoint = this.wanderPath[this.wanderWaypointIndex];
    if (!this.validWanderPoint(waypoint)) {
      this.wanderTarget = null;
      this.wanderPath = [];
      this.wanderWaypointIndex = 0;
      this.wanderPause = 0.8;
      return;
    }
    const beforeX = this.pos.x, beforeZ = this.pos.z;
    const arrived = this.moveToward(waypoint, dt, 1.15);
    const moved = Math.hypot(this.pos.x - beforeX, this.pos.z - beforeZ);
    if (arrived) {
      if (this.wanderWaypointIndex < this.wanderPath.length - 1) {
        this.wanderWaypointIndex += 1;
        this.wanderStall = 0;
      } else if (Math.hypot(this.wanderTarget.x - this.pos.x,
        this.wanderTarget.z - this.pos.z) < 0.6) {
        this.beginWanderPause();
      }
      return;
    }

    const expected = 1.15 * dt * 0.2;
    if (moved < expected) {
      this.wanderStall += dt;
      if (this.wanderStall > 5) {
        this.wanderTarget = null;
        this.wanderPath = [];
        this.wanderWaypointIndex = 0;
        this.wanderStall = 0;
        this.wanderPause = 0.8;
      }
    } else {
      this.wanderStall = 0;
    }
  }

  /** 回到巡逻路线时，从最近的路径点接上（不要横穿整个楼去追第 0 点） */
  nearestPatrolIndex() {
    let best = 0, bestD = Infinity;
    for (let i = 0; i < this.patrol.length; i++) {
      const d = (this.patrol[i][0] - this.pos.x) ** 2
              + (this.patrol[i][1] - this.pos.z) ** 2;
      if (d < bestD) { bestD = d; best = i; }
    }
    return best;
  }

  startCombatStrafe(player, now) {
    if (this.state !== STATE.COMBAT || !this.combatStrafeEnabled
        || this.isShield || this.isRusher || this.strafeActive || !player?.pos) return false;
    if (now < this.nextStrafeAt) return false;
    // Cooldown is set even when the random trigger declines, preventing a
    // synchronized per-frame roll across multiple ordinary enemies.
    this.nextStrafeAt = now + 2.2 + this.random() * 2.3;
    if (this.random() >= 0.45) return false;
    const dx = player.pos.x - this.pos.x, dz = player.pos.z - this.pos.z;
    const distance = Math.hypot(dx, dz);
    if (distance < 1e-4) return false;
    const side = this.random() < 0.5 ? -1 : 1;
    const offset = 0.6 + this.random() * 0.6;
    const target = new THREE.Vector3(
      this.pos.x + (-dz / distance) * side * offset,
      this.pos.y,
      this.pos.z + (dx / distance) * side * offset,
    );
    if (this.blockedAt(target.x, target.z)) return false;
    this.strafeActive = true;
    this.strafeTarget = target;
    this.strafeSpeed = 0.8 + this.random() * 0.6;
    this.strafeUntil = now + 0.45 + this.random() * 0.45;
    return true;
  }

  updateCombatStrafe(dt, now, player) {
    if (!this.strafeActive) return this.startCombatStrafe(player, now);
    if (now >= this.strafeUntil || !this.strafeTarget) {
      this.strafeActive = false;
      this.strafeTarget = null;
      return false;
    }
    const beforeX = this.pos.x, beforeZ = this.pos.z;
    const arrived = this.moveToward(this.strafeTarget, dt, this.strafeSpeed,
      { arrivalDistance: 0.08 });
    const moved = Math.hypot(this.pos.x - beforeX, this.pos.z - beforeZ);
    if (!arrived && moved < 1e-6) {
      // A wall or closed doorway rejected the real movement. End only the
      // side move; the caller continues the ordinary combat behavior.
      this.strafeActive = false;
      this.strafeTarget = null;
      return false;
    }
    if (arrived || now + dt >= this.strafeUntil) {
      this.strafeActive = false;
      this.strafeTarget = null;
    }
    return moved > 1e-6;
  }

  doCombat(dt, now, sees, ctx) {
    const { player, combat, flashlight } = ctx;
    const p = perc();
    const nav = this.navigation;
    const currentRoom = nav?.getRoomAt?.(this.pos.x, this.pos.z);
    const visibleRoom = sees ? nav?.getRoomAt?.(player.pos.x, player.pos.z) : null;
    const knownRoom = this.hasLastSeen ? nav?.getRoomAt?.(
      this.lastSeenPlayer.x, this.lastSeenPlayer.z
    ) : null;

    // A visible target may move through an open doorway. Use the same staged
    // room plan as investigation instead of steering through wall rectangles.
    let crossMoving = false;
    let crossTargetBlocked = false;
    if (this.canCrossRooms && nav && currentRoom
        && (!visibleRoom || visibleRoom !== currentRoom)) {
      if (this.pathRevision !== nav.doorRevision) {
        this.clearCrossRoomPlan();
        this.pathRevision = nav.doorRevision;
      }
      if (this.crossPlan && this.crossPlan.targetRoom !== visibleRoom) {
        this.clearCrossRoomPlan();
      }
      // crossBlocked limits only another traversal attempt. It must never
      // suppress target-facing or firing while the player remains visible.
      if (now >= this.crossFailureUntil) this.crossBlocked = false;
      crossTargetBlocked = this.crossBlocked || now < this.crossFailureUntil;
      if (!this.crossBlocked) {
        if (!this.crossPlan) this.planCrossRoom(player.pos, 'combat');
        if (this.crossPlan) {
          const status = this.moveCrossRoom(dt, this.isRusher ? RUSHER_ENEMY.chargeSpeed : 1.6,
            now, 'combat');
          if (status !== 'failed') crossMoving = true;
          else {
            this.crossFailureUntil = now + 1.0;
            this.crossBlocked = true;
            crossTargetBlocked = true;
          }
        } else {
          this.crossFailureUntil = now + 1.0;
          this.crossBlocked = true;
          crossTargetBlocked = true;
        }
      }
    }

    if (!sees) {
      // 看不见玩家时只能朝「最后看见的位置」，不能跟着真实坐标转。
      // 隔着墙锁定玩家的话，玩家绕到墙后敌人枪口依然精准跟着走，一露头就被打。
      if (this.hasLastSeen) {
        this.faceToward(this.lastSeenPlayer, dt, PERCEPTION.turnRateSearch);
      }

      // Last-seen room pursuit is allowed, but the current player position is
      // deliberately never used here. The snapshot is replanned only after a
      // door revision or once the staged route is exhausted.
      if (this.canCrossRooms && nav && currentRoom && knownRoom
          && knownRoom !== currentRoom) {
        if (this.pathRevision !== nav.doorRevision) {
          this.clearCrossRoomPlan();
          this.pathRevision = nav.doorRevision;
        }
        if (now >= this.crossFailureUntil) this.crossBlocked = false;
        crossTargetBlocked = this.crossBlocked || now < this.crossFailureUntil;
        if (!this.crossBlocked) {
          if (!this.crossPlan) this.planCrossRoom(this.lastSeenPlayer, 'combat');
          if (this.crossPlan) {
            const status = this.moveCrossRoom(dt, this.isRusher ? RUSHER_ENEMY.chargeSpeed : 1.6,
              now, 'combat');
            // Traversal owns movement, but never owns the rest of combat.
            if (status !== 'failed') crossMoving = true;
            else {
              this.crossFailureUntil = now + 1.0;
              this.crossBlocked = true;
              crossTargetBlocked = true;
            }
          } else {
            this.crossFailureUntil = now + 1.0;
            this.crossBlocked = true;
            crossTargetBlocked = true;
          }
        }
      }

      /**
       * ── 盲射压制 ──
       *
       * 看不见人也朝最后已知方向泼子弹。这是 aggression 里玩家感受最强的
       * 一环：躲进掩体不再等于安全下限，弹雨会持续砸在掩体上，逼玩家换位。
       *
       * 关键约束：必须真的有视线才可能命中（enemyShoot 走同一套射线），
       * 所以这不是穿墙作弊 —— 打在墙上就是打在墙上，玩家听到的是
       * 「他在压制」，而不是莫名其妙掉血。散布额外放大，命中靠运气。
       */
      if (p.suppressChance > 0 && this.hasLastSeen
          && now >= this.nextShotAt && this.weapon.canFire(now)
          && !this.weapon.reloading && !this.weapon.isEmpty
          && this.random() < p.suppressChance) {
        this.weapon.consume(now);
        combat.enemyShoot(this, player, now, {
          // 朝「最后看见的位置」的大致方向，而不是玩家真实坐标
          aimAt: this.lastSeenPlayer,
          extraSpread: p.suppressSpread,
        });
        const rof = this.weapon.spec.rof * D().rofMul;
        this.nextShotAt = now + 1 / rof
          + (this.weapon.spec.auto ? 0 : PERCEPTION.burstGap / D().rofMul);
      }
      if (this.weapon.isEmpty) this.weapon.startReload(now);

      /**
       * 脱战时间。关灯会大幅缩短它 —— 玩家躲进掩体并关灯之后，
       * 敌人放弃锁定的速度快一倍多。这是「关手电降低 alert」在
       * 状态机层面的体现：不只是指示器数字降下去，敌人的行为真的变了。
       */
      let lose = p.loseTargetTime;
      if (flashlight && !flashlight.on) lose *= PERCEPTION.darkLoseTargetMul;

      if (this.stateTime > lose && this.hasLastSeen) {
        // Combat's staged route belongs to the live target. Once combat ends,
        // discard it before investigating the snapshot so it cannot be reused
        // for a different target or fall through to direct wall steering.
        this.clearCrossRoomPlan();
        this.investigateTarget = this.lastSeenPlayer.clone();
        this.searchOrigin = this.lastSeenPlayer.clone();
        this.state = STATE.INVESTIGATE;
        this.stateTime = 0;
      }
      return;
    }

    /**
     * 只有真正看见时才精确跟枪。
     * 盾兵转身慢半拍（turnRateMul 0.45）—— 他转得慢，绕后才有意义；
     * 冲锋手略快一点，能跟着玩家拐弯，但不是制导导弹。
     */
    const turnMul = this.isShield ? SHIELD_ENEMY.turnRateMul
      : this.isRusher ? RUSHER_ENEMY.turnRateMul : 1;
    this.faceTarget(player, dt, PERCEPTION.turnRateCombat * turnMul);

    /**
     * ── 冲锋手：确认交火后全速冲锋 ──
     *
     * 不走下面的 pushChance 概率推进，而是每帧都全速冲向玩家，
     * 冲到霰弹有效距离（stopDist）才停下开火。
     *
     * 冲刺发生在 COMBAT 状态里，也就是举枪反应延迟结束**之后** ——
     * 玩家第一次看到他站起来/转向自己时仍有正常的反应窗口，
     * 这不是偷袭式的瞬间贴脸。
     */
    // A staged route owns movement while crossing or while its retry cooldown is
    // active. Direct steering is forbidden in both cases, but aiming and firing
    // below continue normally.
    if (!crossMoving && !crossTargetBlocked) {
      const strafeMoved = this.updateCombatStrafe(dt, now, player);
      if (!strafeMoved && !this.strafeActive && this.isRusher) {
        const gap = Math.hypot(player.pos.x - this.pos.x, player.pos.z - this.pos.z);
        if (gap > RUSHER_ENEMY.stopDist) {
          this.moveToward(player.pos, dt, RUSHER_ENEMY.chargeSpeed, { doors: ctx.doors, now });
        }
      } else if (!strafeMoved && !this.strafeActive && !this.isRusher
          && p.pushChance > 0 && this.random() < p.pushChance) {
        /**
         * ── 主动推进 ──
         *
         * 站桩对射对玩家最有利：距离固定、掩体固定，交火变成纯粹的比手速。
         * 让敌人边打边压上来（保留 4 vox 的交火距离，不会贴脸糊成一团），
         * 玩家必须持续调整站位。盾兵几乎不动，保留其守点身份。
         */
        const gap = Math.hypot(player.pos.x - this.pos.x, player.pos.z - this.pos.z);
        if (gap > 4) {
          const spd = (1.6 + p.pushChance) * (this.isShield ? SHIELD_ENEMY.moveSpeedMul : 1);
          this.moveToward(player.pos, dt, spd, { doors: ctx.doors, now });
        }
      }
    }
    // Movement helpers update yaw toward their movement vector. Restore combat
    // aim before firing so a side step never changes the shot direction.
    this.faceTarget(player, dt, PERCEPTION.turnRateCombat * turnMul);

    // 换弹
    if (this.weapon.isEmpty) { this.weapon.startReload(now); return; }
    if (this.weapon.reloading) return;

    // 开火（带散布，会打空）
    if (now >= this.nextShotAt && this.weapon.canFire(now)) {
      this.weapon.consume(now);
      combat.enemyShoot(this, player, now);
      // 射速按难度缩放（简单 ×0.7 更慢 / 专家 ×1.15 更快）
      const rof = this.weapon.spec.rof * D().rofMul;
      this.nextShotAt = now + 1 / rof
        + (this.weapon.spec.auto ? 0 : PERCEPTION.burstGap / D().rofMul);
    }
  }

  toAlert() {
    this.clearReturnHome();
    this.state = STATE.ALERT;
    this.stateTime = 0;
    this.standUp();          // 举枪前先站起来，姿态才读得懂
    const p = perc();
    this.reactionTimer = p.reactionMin
      + this.random() * (p.reactionMax - p.reactionMin);
  }

  callAllies(ctx) {
    // 巡逻者与冲锋手会喊人（都是「在楼里活动」的角色）；
    // 伏击者与盾兵是守点的，喊人会破坏他们「安静埋伏」的定位。
    if (this.archetype !== ARCHETYPE.PATROLLER && !this.isRusher) return;
    const base = perc().callRadius;
    for (const e of ctx.enemies) {
      if (e === this || e.dead) continue;
      const dy = Math.abs(e.pos.y - this.pos.y);
      const r = dy > 2 ? base * PERCEPTION.crossFloorMul : base;
      if (e.pos.distanceTo(this.pos) <= r) e.onCalled(this.pos.x, this.pos.y, this.pos.z);
    }
  }

  faceTarget(player, dt, rate) {
    this.faceToward(player.pos, dt, rate);
  }

  /** 平滑转向某个世界坐标 */
  faceToward(target, dt, rate) {
    const dx = target.x - this.pos.x, dz = target.z - this.pos.z;
    if (Math.abs(dx) < 1e-6 && Math.abs(dz) < 1e-6) return;
    this.yaw += angleDiff(Math.atan2(-dx, -dz), this.yaw) * Math.min(1, dt * rate);
  }

  /**
   * 朝目标走一步，返回是否已到达。会做简单的墙体规避。
   *
   * @param opts.doors DoorManager；给了就会在被挡住时尝试开门
   * @param opts.now   当前时间（开门防抖用）
   */
  moveToward(target, dt, speed, opts = null) {
    const dx = target.x - this.pos.x, dz = target.z - this.pos.z;
    const d = Math.hypot(dx, dz);
    const arrivalDistance = Number(opts?.arrivalDistance ?? 0.6);
    if (d < (Number.isFinite(arrivalDistance) ? Math.max(0.02, arrivalDistance) : 0.6)) return true;
    const nx = dx / d, nz = dz / d;
    const want = Math.atan2(-nx, -nz);
    let diff = want - this.yaw;
    while (diff > Math.PI) diff -= Math.PI * 2;
    while (diff < -Math.PI) diff += Math.PI * 2;
    this.yaw += diff * Math.min(1, dt * 6);

    const stepX = nx * speed * dt, stepZ = nz * speed * dt;
    // 分轴推进，撞墙则只走另一轴（沿墙滑行）
    const px = this.pos.x, pz = this.pos.z;
    const hitX = this.blockedAt(this.pos.x + stepX, this.pos.z);
    const hitZ = this.blockedAt(this.pos.x, this.pos.z + stepZ);
    /**
     * 被挡住 → 先看看挡路的是不是门。是门就推开，这一帧不移动
     * （门刚变成空气，下一帧自然走进去），玩家看到的是「他推门进来了」。
     */
    if ((hitX || hitZ) && opts?.doors) {
      this.tryOpenDoor(opts.doors, opts.now ?? 0, nx, nz);
    }
    if (!this.blockedAt(this.pos.x + stepX, this.pos.z)) this.pos.x += stepX;
    if (!this.blockedAt(this.pos.x, this.pos.z + stepZ)) this.pos.z += stepZ;
    // 记录实际位移速度，让腿部摆动与真实移动同步（撞墙时腿会停下）
    this.moveSpeed = Math.hypot(this.pos.x - px, this.pos.z - pz) / Math.max(dt, 1e-5);

    // 贴地：跟随地面高度（含半格阶梯）
    const surf = this.world.highestSurfaceUnder(
      this.pos.x - 0.28, this.pos.z - 0.28, this.pos.x + 0.28, this.pos.z + 0.28,
      this.pos.y + 0.65, this.pos.y - 1.2
    );
    if (Number.isFinite(surf)) this.pos.y = surf;
    return false;
  }

  blockedAt(x, z, y = this.pos.y) {
    const R = ENTITY_RADIUS;
    return this.world.boxIntersects(
      x - R, y + 0.05, z - R,
      x + R, y + this.height - 0.05, z + R
    );
  }

  /**
   * 挡在前面的是门就推开它，让敌人能自然地进出房间。
   *
   * ══ 为什么必须有这个 ══
   *
   * 门在体素网格里是实心方块，moveToward 的分轴推进只会「撞墙则沿另一轴
   * 滑行」。没有开门能力时，敌人搜到关着的门前就开始贴着门板左右横滑，
   * 玩家看到的是一个卡在门口抽搐的人 —— 而且关着的门等于把整个搜索
   * 区域锁死，「听见声音会来查房」这件事在门后完全无法兑现。
   *
   * 只在真的被门挡住时才开（不是路过就开），开完记一个时间戳防抖，
   * 免得同一帧里反复 toggle 出机关枪一样的开门声。
   *
   * @param doors DoorManager（由 ctx 传入；没有就直接返回 false）
   * @returns 是否开了门
   */
  tryOpenDoor(doors, now, dirX, dirZ) {
    if (!doors) return false;
    if (now - this.lastDoorAt < 0.8) return false;
    // 朝移动方向前探一步，找那一格上的门
    const probeX = this.pos.x + dirX * 0.7;
    const probeZ = this.pos.z + dirZ * 0.7;
    const door = doors.nearest(probeX, this.pos.y + 1, probeZ, 1.3);
    if (!door || door.open) return false;
    const opened = doors.requestAIOpen
      ? doors.requestAIOpen(door, this, { onDoorNoise: this.services.onDoorNoise })
      : false;
    if (opened) this.lastDoorAt = now;
    return opened;
  }

  /**
   * 与其它实体的圆柱碰撞：敌人之间、敌人与玩家都不能重叠穿过。
   * 只做水平推开（不同楼层的实体互不影响），推力对半分摊。
   */
  resolveOverlap(others, player) {
    const R = ENTITY_RADIUS * 2;
    for (const o of others) {
      if (o === this || o.dead) continue;
      // 高度差超过一层就不算重叠（楼上楼下互不干扰）
      if (Math.abs(o.pos.y - this.pos.y) > 1.4) continue;
      let dx = this.pos.x - o.pos.x, dz = this.pos.z - o.pos.z;
      let d = Math.hypot(dx, dz);
      if (d >= R) continue;
      if (d < 1e-4) { dx = this.random() - 0.5; dz = this.random() - 0.5; d = 0.5; }
      const push = (R - d) / 2;
      const nx = dx / d, nz = dz / d;
      this.tryShift(nx * push, nz * push);
      o.tryShift(-nx * push, -nz * push);
    }

    // 与玩家：只推开敌人，不推玩家（玩家的移动由物理体独立解算，
    // 从两边同时推会让操作感变得黏滞）
    if (player && Math.abs(player.pos.y - this.pos.y) <= 1.4) {
      const dx = this.pos.x - player.pos.x, dz = this.pos.z - player.pos.z;
      const d = Math.hypot(dx, dz);
      const minD = ENTITY_RADIUS + PLAYER.width / 2;
      if (d < minD && d > 1e-4) {
        this.tryShift((dx / d) * (minD - d), (dz / d) * (minD - d));
      }
    }
  }

  /** 尝试位移，撞墙则不动（避免被推进方块里） */
  tryShift(dx, dz) {
    if (!this.blockedAt(this.pos.x + dx, this.pos.z)) this.pos.x += dx;
    if (!this.blockedAt(this.pos.x, this.pos.z + dz)) this.pos.z += dz;
  }

  /**
   * 沿巡逻路线走。
   *
   * ══ 卡死检测是这里的关键 ══
   *
   * moveToward 只做「撞墙则沿另一轴滑行」，没有寻路。如果某一段路线被
   * 掩体或墙垛完全挡住，敌人会朝着那个点原地推墙 —— 永远到不了，
   * 也永远不会切换到下一个点。实测有 4 个巡逻者因此在 120 秒里静止了
   * 96–115 秒，玩家看到的就是「巡逻者根本不巡逻」。
   *
   * 修数据是必须的（见 level/spawns.js），但光修数据不够：手写坐标的
   * 关卡数据永远可能再出错，而这个失败模式的表现（敌人完全静止）
   * 和「设计成蹲守」难以区分，很难被发现。所以这里加一层兜底：
   * 连续 stallLimit 秒没有实质位移就放弃当前点，跳到下一个。
   * 代价是一个计时器，换来「巡逻者一定在动」这个强保证。
   */
  walkPatrol(dt) {
    const pt = this.patrol[this.patrolIdx];
    _v.set(pt[0], this.pos.y, pt[1]);

    const beforeX = this.pos.x, beforeZ = this.pos.z;
    const arrived = this.moveToward(_v, dt, 1.2);
    const moved = Math.hypot(this.pos.x - beforeX, this.pos.z - beforeZ);

    if (arrived) {
      this.patrolIdx = (this.patrolIdx + 1) % this.patrol.length;
      this.patrolStall = 0;
      return;
    }

    // 位移小于「本该走的距离」的两成 → 认为被挡住了
    const expected = 1.2 * dt * 0.2;
    if (moved < expected) {
      this.patrolStall = (this.patrolStall ?? 0) + dt;
      if (this.patrolStall > PERCEPTION.patrolStallLimit) {
        this.patrolIdx = (this.patrolIdx + 1) % this.patrol.length;
        this.patrolStall = 0;
      }
    } else {
      this.patrolStall = 0;
    }
  }
}

/**
 * 保留为兼容用的空实现。
 * 伏击者现在直接从 update 的 ctx.player 读取玩家位置，
 * 不再需要模块级缓存（那个缓存曾导致「玩家还没靠近就起身」的时序错误）。
 */
export function setPlayerPosCache() {}

/** 两个角度之间的最短差值，结果落在 (-π, π] */
export function angleDiff(want, current) {
  let d = want - current;
  while (d > Math.PI) d -= Math.PI * 2;
  while (d < -Math.PI) d += Math.PI * 2;
  return d;
}

/** 射线 vs AABB（slab 法），返回进入距离或 null */
function rayBox(ox, oy, oz, dx, dy, dz, minX, minY, minZ, maxX, maxY, maxZ) {
  let tmin = -Infinity, tmax = Infinity;
  const o = [ox, oy, oz], d = [dx, dy, dz];
  const lo = [minX, minY, minZ], hi = [maxX, maxY, maxZ];
  for (let i = 0; i < 3; i++) {
    if (Math.abs(d[i]) < 1e-8) {
      if (o[i] < lo[i] || o[i] > hi[i]) return null;
    } else {
      let t1 = (lo[i] - o[i]) / d[i];
      let t2 = (hi[i] - o[i]) / d[i];
      if (t1 > t2) { const t = t1; t1 = t2; t2 = t; }
      tmin = Math.max(tmin, t1);
      tmax = Math.min(tmax, t2);
      if (tmin > tmax) return null;
    }
  }
  return tmin >= 0 ? tmin : (tmax >= 0 ? 0 : null);
}

export { PERCEPTION, rayBox };
