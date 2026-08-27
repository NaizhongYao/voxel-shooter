/**
 * 肃清协议 3D — 全局调参表
 * 所有数值来自 GDD。1 vox = 1 世界单位 = 1 米。
 * 这里是唯一的数值来源，其他模块不得硬编码玩法常量。
 */

export const WORLD = {
  SX: 64, SY: 10, SZ: 64,       // 体素网格尺寸
  CHUNK: 16,                    // 区块水平边长（高度整层）
  BLOCK_INSET: 0.01,            // 方块渲染缩到 0.98，留描边缝
};

export const PALETTE = {
  wall:      0x1a2029,
  floor:     0x2b3240,
  cover:     0x3a4354,
  amber:     0xf5a623,
  threat:    0xe5484d,
  good:      0x3fb96f,
  cyan:      0x4cc9f0,
  purple:    0xa78bfa,
  moon:      0x9fb4cc,
  nearBlack: 0x141c26,
  white:     0xffffff,
  bloodDark: 0x7a2c2c,
  brass:     0xb08d3f,
};

export const RENDER = {
  clearColor: PALETTE.nearBlack,
  fogDensity: 0.055,            // FogExp2，与清屏色一致
  colorJitter: 0.04,            // 每方块 ±4% 明度抖动
  moonBake: 1.35,               // 庭院月光烘焙强度（可辨轮廓，不可辨细节）
  shadowMapSize: 1024,
  maxPixelRatio: 1.75,
};

export const LIGHT = {
  ambientIndoor: 0.03,          // 室内环境光（近乎全黑）
  moonlight: 0.22,              // 室外庭院月光（烘焙进顶点色）
  moonColor: PALETTE.moon,
  flashlight: {
    color: 0xffe6b8,
    intensity: 3.4,
    distance: 26,               // 射程 26 vox
    angleDeg: 27.5,             // three.js 用半角；锥角 55°
    penumbra: 0.25,
    decay: 1.1,
    detectSpotRadius: 12,       // 「光斑」被敌人察觉的半径
    onDetectMul: 1.8,           // 开灯：敌人探测距离 ×1.8
    offDetectMul: 0.45,         // 关灯：×0.45
    nearGlow: 4,                // 关灯时身边可见范围
  },
  muzzle: { intensity: 9, distance: 8, lifeMs: 80, poolSize: 4 },
};

export const CAMERA = {
  fov: 70,
  adsFov: 55,
  near: 0.05,
  far: 120,
  offset:    { x: 0.7,  y: 1.8, z: 3.2 },   // 右 / 上 / 后
  adsOffset: { x: 0.45, y: 1.7, z: 1.8 },
  pitchMin: -75 * Math.PI / 180,
  pitchMax:  70 * Math.PI / 180,
  followLerp: 0.18,
  adsFollowLerp: 0.35,
  pullbackPad: 0.28,            // 相机射线回拉留边
  mouseSensitivity: 0.0022,
  crouchEyeDrop: 0.55,
};

export const PLAYER = {
  hpMax: 60,
  width: 0.6,                   // AABB
  height: 1.8,
  crouchHeight: 1.0,
  eyeHeight: 1.62,
  speed: 2.6,                   // 常速 vox/s
  slowSpeed: 1.2,               // Ctrl 战术慢走
  crouchSpeed: 1.1,
  accel: 22,                    // 到达目标速度的加速度
  airAccel: 6,
  jumpHeight: 1.1,
  stepUpMax: 0.6,               // 自动登台
  gravity: -22,
  maxFallSpeed: 34,
  terminalSafeFall: 4,          // 超过 4 vox 才开始摔伤
  fallDmgPerVox: 5,
  fallDmgCap: 15,
  crouchLerp: 10,               // 蹲伏高度过渡速率
  lean: {
    angleDeg: 22,
    offset: 0.5,                // 侧移 vox（命中盒不动）
    timeMs: 180,
  },
  noise: { normal: 4.0, slow: 1.2, crouch: 0.8 },
  spread: { normal: 1.0, slow: 0.8, crouch: 0.6 },
  hitbox: { head: 2.5, torso: 1.0, limb: 0.7 },
};

/** 方块人形部件尺寸（vox），来自 GDD 02 章 */
export const RIG = {
  head:  { x: 0.5,  y: 0.5,  z: 0.5  },
  torso: { x: 0.6,  y: 0.75, z: 0.35 },
  arm:   { x: 0.2,  y: 0.6,  z: 0.2  },
  leg:   { x: 0.25, y: 0.75, z: 0.25 },
  gun:   { x: 0.15, y: 0.15, z: 0.9  },
  walkSwingMax: 0.9,            // 腿部正弦摆动最大弧度
  walkFreq: 2.1,                // 每 vox/s 的摆动频率系数
  leanPivotAtFeet: true,
};

export const INPUT = {
  forward: ['KeyW'], back: ['KeyS'], left: ['KeyA'], right: ['KeyD'],
  jump: ['Space'], crouch: ['ShiftLeft', 'ShiftRight'],
  slow: ['ControlLeft', 'ControlRight'],
  leanLeft: ['KeyQ'], leanRight: ['KeyE'],
  flashlight: ['KeyF'],
  debug: ['Backquote'],
};
