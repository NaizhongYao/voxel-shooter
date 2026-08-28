import * as THREE from 'three';
import { PALETTE, PLAYER, LIGHT, ARMOR_ABSORB, ARMOR_MAX, ARMORED_HP_MULT } from '../config.js';
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
};

/** 兼容旧名字，避免关卡配置里散落的字符串失效 */
ARCHETYPE.PRONE = ARCHETYPE.AMBUSHER;

const PERCEPTION = {
  visionRange: 18,          // 基础视觉距离 vox
  hFovDeg: 100,             // 水平视野锥
  vFovDeg: 70,              // 垂直视野锥
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
  };
}

let _idSeq = 0;
const _v = new THREE.Vector3();

/** 实体碰撞半径（圆柱），略小于碰撞盒半宽以免贴墙时互相挤穿 */
export const ENTITY_RADIUS = 0.28;

export class Enemy {
  /**
   * @param spec { x, z, y, archetype, weapon, yaw, patrol?: [[x,z],...] }
   */
  constructor(world, spec) {
    this.id = ++_idSeq;
    this.world = world;
    this.archetype = spec.archetype;
    this.spawn = new THREE.Vector3(spec.x, spec.y, spec.z);
    this.pos = this.spawn.clone();
    this.yaw = spec.yaw ?? 0;
    this.homeYaw = this.yaw;
    this.patrol = spec.patrol ?? null;
    this.patrolIdx = 0;

    /**
     * 武装敌人要先于 hpMax 判定（血量翻倍依据这一点）。
     * 血量 ×ARMORED_HP_MULT：一枪爆头（AR 63）最多打穿护甲，
     * 做不到首发即死 —— 重甲目标要持续集火。
     */
    this.armored = !!spec.armored;
    this.hpMax = this.armored ? D().enemyHp * ARMORED_HP_MULT : D().enemyHp;
    this.hp = this.hpMax;
    /**
     * 护甲先扣、生命后扣，与玩家侧 PLAYER.armorAbsorb 同一套公式
     * （见 takeDamage）。护甲值不随难度缩放——它是关卡里固定的战术
     * 要素，不是难度杠杆；血量随难度走，两个变量各司其职。
     */
    this.armorMax = this.armored ? ARMOR_MAX : 0;
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
    // 蹲守者的扫视状态（避免长时间面对墙）
    this.scanTimer = Math.random() * 2;
    this.scanTarget = this.yaw;
    // 搜索状态：失去目标后去哪些点找人
    this.searchPoints = null;
    this.searchIdx = 0;
    /** 巡逻卡死计时（秒）。超过 patrolStallLimit 就跳过当前路径点。 */
    this.patrolStall = 0;

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
      kit: this.armored ? 'armored' : 'enemy',
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
      this.scanTarget = this.yaw;
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

  get eyeY() {
    return this.pos.y + this.height * 0.85;
  }

  /** 碰撞圆柱半径。门系统用它判断「门洞里有没有人」。 */
  get radius() { return ENTITY_RADIUS; }

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
  takeDamage(amount, zone, dir = null) {
    if (this.dead) return false;

    /**
     * 武装敌人：护甲先吸收 ARMOR_ABSORB 比例的伤害，其余渗透到生命。
     * 与玩家侧 Player.applyDamage 同一套公式（见 player/player.js），
     * 保持「护甲机制」在敌我两侧手感一致——玩家打武装敌人时的体感
     * 应该跟自己中弹时是同一种「盔甲在慢慢吃伤害」的感觉。
     */
    if (this.armored && this.armor > 0) {
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
      // 倒地而不是凭空消失 —— 玩家需要看到「他死了」
      this.rig.startDeath(dir ? dir.x : 0, dir ? dir.z : 1);
      this.rig.gunPivot.visible = false;
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

    let range = perc().visionRange * flashlight.detectionMultiplier;
    if (this.archetype === ARCHETYPE.SENTRY) range *= PERCEPTION.sentryRangeMul;
    // 玩家不在光照中时更难被发现
    const lit = flashlight.on;
    if (!lit) range *= PERCEPTION.shadowMul;

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
   */
  hearNoise(x, y, z, radius, loud = false) {
    if (this.dead || this.state === STATE.COMBAT) return false;
    const dy = Math.abs(y - this.pos.y);
    // 跨楼板半径衰减
    const effective = dy > 2 ? radius * PERCEPTION.crossFloorMul : radius;
    const d = Math.hypot(x - this.pos.x, y - this.pos.y, z - this.pos.z);
    if (d > effective) return false;
    this.investigateTarget = new THREE.Vector3(x, y, z);
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
        this.doIdle(dt, sees, spotsLight, player);
        break;

      case STATE.INVESTIGATE:
        this.doInvestigate(dt, sees);
        break;

      case STATE.ALERT:
        // 举枪窗口：玩家唯一的反应机会。
        // 同样只在看得见时跟枪；玩家在举枪期间躲回掩体应该能甩掉瞄准。
        if (sees) this.faceTarget(player, dt, 7);
        else if (this.hasLastSeen) this.faceToward(this.lastSeenPlayer, dt, 4);
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

  doIdle(dt, sees, spotsLight, player) {
    if (this.isAmbusher) {
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

    if (this.patrol) {
      this.walkPatrol(dt);
    } else {
      /**
       * 蹲守者：原地扫视，但绝不长时间面对墙。
       *
       * 原来是 homeYaw + sin() 的固定小幅摆动 —— 如果布置时给的 homeYaw
       * 正好朝墙，这个敌人整局都在瞪着墙面，看起来完全是坏的。
       * 现在扫视幅度大得多（±75°），而且每次到端点都检查前方是不是墙，
       * 朝墙就直接换一个开阔方向。
       */
      this.scanTimer -= dt;
      if (this.scanTimer <= 0) {
        this.scanTimer = 2.2 + Math.random() * 2.0;
        this.scanTarget = this.pickOpenDirection();
      }
      // 转向目标。转得比较快（×2.6）是有意的：慢慢扫过墙面的那段时间
      // 看起来还是在瞪墙，快速转过去就只是「换了个方向看」。
      this.yaw += angleDiff(this.scanTarget, this.yaw) * Math.min(1, dt * 2.6);
    }

    if (sees) this.toAlert();
    else if (spotsLight) {
      // 看到光斑 → 警戒（不是立刻开火，因为还没看见人）
      this.state = STATE.INVESTIGATE;
      this.stateTime = 0;
      this.investigateTarget = null;
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
    if (open.length > 0) return open[(Math.random() * open.length) | 0];

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

  doInvestigate(dt, sees) {
    if (sees) { this.toAlert(); return; }
    this.standUp();          // 起身查看，不会蹲着走路
    if (this.investigateTarget) {
      const arrived = this.moveToward(this.investigateTarget, dt, 1.5);
      if (arrived) this.investigateTarget = null;
    } else {
      // 到了目标点却没人：原地环视找人（不是死盯一个方向）
      this.yaw += dt * 1.4;
    }
    if (this.stateTime > perc().investigateTime) {
      // 调查超时 → 回到常态行为。巡逻者继续走路线，
      // 蹲守者回到岗位朝向（而不是留在原地朝着刚才乱转的方向）
      this.state = STATE.IDLE;
      this.stateTime = 0;
      this.investigateTarget = null;
      this.scanTimer = 0;
      if (this.patrol) this.patrolIdx = this.nearestPatrolIndex();
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

  doCombat(dt, now, sees, ctx) {
    const { player, combat, flashlight } = ctx;

    if (!sees) {
      // 看不见玩家时只能朝「最后看见的位置」，不能跟着真实坐标转。
      // 隔着墙锁定玩家的话，玩家绕到墙后敌人枪口依然精准跟着走，一露头就被打。
      if (this.hasLastSeen) this.faceToward(this.lastSeenPlayer, dt, 4);

      /**
       * 脱战时间。关灯会大幅缩短它 —— 玩家躲进掩体并关灯之后，
       * 敌人放弃锁定的速度快一倍多。这是「关手电降低 alert」在
       * 状态机层面的体现：不只是指示器数字降下去，敌人的行为真的变了。
       */
      let lose = perc().loseTargetTime;
      if (flashlight && !flashlight.on) lose *= PERCEPTION.darkLoseTargetMul;

      if (this.stateTime > lose && this.hasLastSeen) {
        // 去最后看见的位置搜索，而不是一直站着瞄
        this.investigateTarget = this.lastSeenPlayer.clone();
        this.state = STATE.INVESTIGATE;
        this.stateTime = 0;
      }
      return;
    }

    // 只有真正看见时才精确跟枪
    this.faceTarget(player, dt, 9);

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
    this.state = STATE.ALERT;
    this.stateTime = 0;
    this.standUp();          // 举枪前先站起来，姿态才读得懂
    const p = perc();
    this.reactionTimer = p.reactionMin
      + Math.random() * (p.reactionMax - p.reactionMin);
  }

  callAllies(ctx) {
    if (this.archetype !== ARCHETYPE.PATROLLER) return;
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

  /** 朝目标走一步，返回是否已到达。会做简单的墙体规避 */
  moveToward(target, dt, speed) {
    const dx = target.x - this.pos.x, dz = target.z - this.pos.z;
    const d = Math.hypot(dx, dz);
    if (d < 0.6) return true;
    const nx = dx / d, nz = dz / d;
    const want = Math.atan2(-nx, -nz);
    let diff = want - this.yaw;
    while (diff > Math.PI) diff -= Math.PI * 2;
    while (diff < -Math.PI) diff += Math.PI * 2;
    this.yaw += diff * Math.min(1, dt * 6);

    const stepX = nx * speed * dt, stepZ = nz * speed * dt;
    // 分轴推进，撞墙则只走另一轴（沿墙滑行）
    const px = this.pos.x, pz = this.pos.z;
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
      if (d < 1e-4) { dx = Math.random() - 0.5; dz = Math.random() - 0.5; d = 0.5; }
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
