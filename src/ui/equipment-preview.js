/**
 * 装备面板 3D 角色预览
 * 
 * 在装备面板左侧显示一个可旋转的方块人模型。
 * 与实战共用 BlockyRig，装备外观在两个场景中保持一致。
 */

import * as THREE from 'three';
import { PALETTE } from '../config.js';
import { BlockyRig } from '../player/rig.js';
import { ARMOR_TYPES } from '../systems/loadout-config.js';

let previewScene = null;
let previewCamera = null;
let previewRenderer = null;
let previewRig = null;
let previewRotation = 0;
let previewAnimationFrame = null;

/**
 * display:none 期间 canvas 尺寸为 0：初始化相机/渲染器时用这个占位尺寸
 * 兜底（0/0 会得到 NaN 宽高比，投影矩阵从此报废）。真实比例等面板第一次
 * 显示时派发的 equipment-preview-resize 事件校正。
 */
const PREVIEW_FALLBACK_WIDTH = 480;
const PREVIEW_FALLBACK_HEIGHT = 640;

function getPreviewSize(canvas) {
  if (canvas.clientWidth > 0 && canvas.clientHeight > 0) {
    return { width: canvas.clientWidth, height: canvas.clientHeight };
  }
  return { width: PREVIEW_FALLBACK_WIDTH, height: PREVIEW_FALLBACK_HEIGHT };
}

/**
 * 初始化 3D 预览
 */
export function initEquipmentPreview() {
  const canvas = document.getElementById('eq-canvas');
  if (!canvas) return;

  // 场景
  previewScene = new THREE.Scene();
  previewScene.background = new THREE.Color(0x0a0e14);

  // 相机
  // 顶层 main.js 在 #equipment 还是 display:none 时初始化这里，
  // canvas 尺寸恒为 0 —— 用占位尺寸构造，避免 aspect 变 NaN/Infinity。
  const { width, height } = getPreviewSize(canvas);
  previewCamera = new THREE.PerspectiveCamera(35, width / height, 0.1, 100);
  previewCamera.position.set(0, 1.6, 4);
  previewCamera.lookAt(0, 1, 0);

  // 渲染器
  previewRenderer = new THREE.WebGLRenderer({ canvas, antialias: true });
  previewRenderer.setPixelRatio(Math.min(window.devicePixelRatio, 2));
  // updateStyle=false：不写 canvas 的 inline 尺寸。canvas 显示尺寸始终由
  // CSS（#eq-canvas{width:100%;height:100%}）决定 —— 否则隐藏期间
  // setSize(0,0) 会把 inline style 污染成 0px，之后 clientWidth 永远
  // 读不到真实布局尺寸。
  previewRenderer.setSize(width, height, false);

  // 灯光
  const ambientLight = new THREE.AmbientLight(0xffffff, 0.5);
  previewScene.add(ambientLight);

  const dirLight = new THREE.DirectionalLight(0xffffff, 0.8);
  dirLight.position.set(2, 4, 3);
  previewScene.add(dirLight);

  const fillLight = new THREE.DirectionalLight(0x4cc9f0, 0.3);
  fillLight.position.set(-2, 1, -1);
  previewScene.add(fillLight);

  // 与实战共用 BlockyRig，装备页和任务内的角色轮廓保持一致
  createRig();

  // 添加地面圆圈
  const circle = new THREE.Mesh(
    new THREE.RingGeometry(0.9, 1.0, 32),
    new THREE.MeshBasicMaterial({ color: 0x2c3644, side: THREE.DoubleSide })
  );
  circle.rotation.x = -Math.PI / 2;
  circle.position.y = 0.01;
  previewScene.add(circle);

  // 窗口大小调整
  window.addEventListener('resize', handleResize);

  // 键盘控制旋转
  document.addEventListener('keydown', (e) => {
    if (!isEquipmentActive()) return;
    if (e.key === 'ArrowLeft') {
      previewRotation -= Math.PI / 8;
    } else if (e.key === 'ArrowRight') {
      previewRotation += Math.PI / 8;
    } else if (e.key === 'r' || e.key === 'R') {
      previewRotation = 0;
    }
  });

  // 开始动画循环
  animatePreview();
  updateRigArmor('standard');
  window.addEventListener('equipment-preview-resize', handleResize);
}

/**
 * 创建方块人模型（简化版）
 */
function createRig() {
  previewRig = new BlockyRig(PALETTE.player, { isPlayer: true, kit: 'player' });
  previewRig.root.position.y = 0.08;
  previewRig.root.scale.setScalar(1.08);
  previewScene.add(previewRig.root);
}

/**
 * 更新角色装备外观
 *
 * 护甲 id 直接作为 rig 配色表的键（rig.js 的 ARMOR_KIT_COLORS）：
 * 8 套护甲共享同一套几何部件，唯一视觉差异是专属配色。
 * 预览与实战走同一个 setArmorKit 入口、同一张配色表，不会出现
 * 「预览面板一种颜色、实战里另一种」的割裂。ARMOR_TYPES 数据表
 * 仍是名称/数值的唯一真源，标签文字直接读 nameEn。
 *
 * @param {string} armorId - 防护装备 id（ARMOR_TYPES 的键，如 ghost/runner）
 */
export function updateRigArmor(armorId) {
  if (!previewRig) return;
  const armor = ARMOR_TYPES[armorId] ?? ARMOR_TYPES.standard;
  previewRig.setArmorKit(armor.id);
  const tag = document.getElementById('eq-armor-tag');
  if (tag) {
    tag.textContent = armor.nameEn ?? armor.name ?? armor.id;
  }
}

/**
 * 动画循环
 */
function animatePreview() {
  previewAnimationFrame = requestAnimationFrame(animatePreview);

  if (!previewRig) return;

  // 平滑旋转
  previewRig.root.rotation.y += (previewRotation - previewRig.root.rotation.y) * 0.1;

  // 轻微呼吸动画
  const t = Date.now() / 1000;
  previewRig.root.position.y = 0.08 + Math.sin(t * 0.8) * 0.02;

  previewRenderer.render(previewScene, previewCamera);
}

/**
 * 处理尺寸变化（面板显示 / 窗口 resize）
 */
function handleResize() {
  const canvas = document.getElementById('eq-canvas');
  if (!canvas || !previewCamera || !previewRenderer) return;

  // 面板隐藏时读不到真实尺寸（display:none 恒为 0）：直接跳过。
  // 绝不用 Math.max(1, 0) 之类的假尺寸写渲染器——那会把画布
  // 锁死在 1px，等真正显示时再来一次真实校正即可。
  const width = canvas.clientWidth;
  const height = canvas.clientHeight;
  if (width === 0 || height === 0) return;

  previewCamera.aspect = width / height;
  previewCamera.updateProjectionMatrix();
  previewRenderer.setSize(width, height, false);
}

/**
 * 检查装备面板是否激活
 */
function isEquipmentActive() {
  const equipment = document.getElementById('equipment');
  return equipment?.classList.contains('active');
}

/**
 * 清理资源
 */
export function disposeEquipmentPreview() {
  if (previewAnimationFrame) {
    cancelAnimationFrame(previewAnimationFrame);
    previewAnimationFrame = null;
  }

  if (previewRenderer) {
    previewRenderer.dispose();
    previewRenderer = null;
  }

  window.removeEventListener('resize', handleResize);
  window.removeEventListener('equipment-preview-resize', handleResize);
}
