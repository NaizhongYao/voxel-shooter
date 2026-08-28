import * as THREE from 'three';
import { D } from '../difficulty.js';

/**
 * 敌人头顶状态指示器。
 *
 * ══ 要解决的问题 ══
 *
 * 状态机有 6 个状态，但玩家在黑屋里能观察到的只有「敌人动了 / 敌人开枪了」。
 * 「他正在怀疑」「他在找我」「他锁定我了」三者的区别完全不可见，
 * 于是玩家学不到任何东西 —— 死了也不知道是哪一步暴露的。
 *
 * ══ 视觉语言 ══
 *
 * 三档形状 + 三档颜色，在体素画面里 0.2 秒内可读：
 *   平静  灰色小方块（低调，只是告诉你「那里有人」）
 *   搜索  黄色方块 + 缓慢脉动（他知道有异常）
 *   警戒  橙色方块 + 快速脉动 + 上下弹跳（举枪窗口，玩家的最后机会）
 *   战斗  红色方块 + 高频闪烁 + 更大（已经在打你了）
 *
 * 下方还有一条填充条表示 alertLevel 的连续值 —— 玩家能看到「他快要发现我了」
 * 这个过程，而不是突然被打。
 *
 * ══ 为什么用 Sprite 而不是 Mesh ══
 *
 * Sprite 永远面向相机，不需要每帧算朝向；而且它不受光照影响
 * （MeshBasic 也可以，但 Sprite 天然处理了朝向）。指示器是 UI 而不是场景
 * 物件，不应该被手电照亮或投下阴影。
 *
 * ══ 难度差异 ══
 *
 * 简单：indicatorRange 60（几乎全图）+ showIdleIndicator（平静时也显示）
 * 困难：range 28，只有被注意到才显示
 * 专家：range 14，几乎没有情报 —— 必须靠听声和光柱判断
 */

/** 各档位的颜色与行为参数 */
const TIERS = {
  calm:   { color: 0x6b7480, size: 0.20, pulse: 0.0, bob: 0.0 },
  search: { color: 0xf5d76e, size: 0.26, pulse: 2.2, bob: 0.0 },
  alert:  { color: 0xf5a623, size: 0.34, pulse: 6.5, bob: 0.10 },
  combat: { color: 0xe5484d, size: 0.40, pulse: 11.0, bob: 0.06 },
};

/** 指示器悬在敌人头顶多高（vox） */
const HEIGHT_ABOVE = 0.55;

/**
 * 生成一个圆角方形的贴图。
 *
 * 用 canvas 画而不是加载图片：零外部资源，而且可以精确控制边缘 ——
 * 一个带暗色描边的方块在任何背景上都读得清，纯色方块在暗墙上会糊掉。
 */
function makeMarkerTexture() {
  const S = 64;
  const c = document.createElement('canvas');
  c.width = c.height = S;
  const g = c.getContext('2d');
  // 外描边（暗色，保证在亮背景上也有轮廓）
  g.fillStyle = 'rgba(10,13,18,0.85)';
  g.fillRect(6, 6, S - 12, S - 12);
  // 内部填白，实际颜色由 Sprite 的 material.color 乘上去
  g.fillStyle = '#ffffff';
  g.fillRect(12, 12, S - 24, S - 24);
  const tex = new THREE.CanvasTexture(c);
  tex.magFilter = THREE.NearestFilter;   // 保持硬边，符合体素风格
  tex.minFilter = THREE.NearestFilter;
  return tex;
}

/** 警戒度填充条的贴图：左对齐的横条，用 scale.x 表达填充比例 */
function makeBarTexture() {
  const W = 64, H = 12;
  const c = document.createElement('canvas');
  c.width = W; c.height = H;
  const g = c.getContext('2d');
  g.fillStyle = '#ffffff';
  g.fillRect(0, 0, W, H);
  const tex = new THREE.CanvasTexture(c);
  tex.magFilter = THREE.NearestFilter;
  tex.minFilter = THREE.NearestFilter;
  return tex;
}

export class EnemyIndicators {
  /**
   * @param scene   three.js 场景
   * @param enemies 敌人数组（长度固定，指示器一对一绑定）
   */
  constructor(scene, enemies) {
    this.enemies = enemies;
    this.markerTex = makeMarkerTexture();
    this.barTex = makeBarTexture();
    this.items = [];

    for (const e of enemies) {
      const group = new THREE.Group();

      const marker = new THREE.Sprite(new THREE.SpriteMaterial({
        map: this.markerTex, color: TIERS.calm.color,
        transparent: true, depthTest: true, depthWrite: false,
        sizeAttenuation: true, fog: false,
      }));
      marker.scale.set(TIERS.calm.size, TIERS.calm.size, 1);
      group.add(marker);

      // 警戒度条：底色（暗）+ 填充（亮），都是左对齐
      const barBg = new THREE.Sprite(new THREE.SpriteMaterial({
        map: this.barTex, color: 0x141c26,
        transparent: true, opacity: 0.75, depthTest: true, depthWrite: false,
        fog: false,
      }));
      barBg.position.y = -0.26;
      barBg.center.set(0.5, 0.5);
      barBg.scale.set(0.5, 0.06, 1);
      group.add(barBg);

      const barFill = new THREE.Sprite(new THREE.SpriteMaterial({
        map: this.barTex, color: TIERS.search.color,
        transparent: true, depthTest: true, depthWrite: false, fog: false,
      }));
      // center 设到左边缘 → scale.x 变化时从左往右填充
      barFill.center.set(0, 0.5);
      barFill.position.y = -0.26;
      barFill.scale.set(0.5, 0.06, 1);
      group.add(barFill);

      group.visible = false;
      scene.add(group);
      this.items.push({ enemy: e, group, marker, barBg, barFill, phase: Math.random() * 6 });
    }
  }

  /**
   * @param viewPos 相机（或玩家）位置，用来做距离裁剪
   * @param now     秒，驱动脉动
   * @param forceReveal 收尾阶段：只剩最后几个敌人时无视距离与平静隐藏，
   *                     全部亮标 —— 否则黑楼里找不到最后一个人，游戏永远无法结束。
   */
  update(viewPos, now, dt, forceReveal = false) {
    const d = D();
    for (const it of this.items) {
      const e = it.enemy;
      const tier = e.alertTier;

      // 死了就藏掉指示器（尸体不需要状态）
      if (tier === 'dead') { it.group.visible = false; continue; }

      const dist = Math.hypot(e.pos.x - viewPos.x, e.pos.z - viewPos.z);
      // 超出难度设定的可见范围 → 不显示（这是难度的核心差异之一）
      if (dist > d.indicatorRange && !forceReveal) { it.group.visible = false; continue; }
      // 困难/专家：平静状态不给情报，玩家得自己找人
      if (tier === 'calm' && !d.showIdleIndicator && !forceReveal) {
        it.group.visible = false;
        continue;
      }

      const T = TIERS[tier];
      it.group.visible = true;
      it.group.position.set(e.pos.x, e.pos.y + e.height + HEIGHT_ABOVE, e.pos.z);

      // 脉动：alert/combat 高频闪烁，是「危险」最直接的视觉信号
      let alpha = 1;
      if (T.pulse > 0) {
        alpha = 0.55 + 0.45 * Math.sin(now * T.pulse + it.phase);
      }
      it.marker.material.color.setHex(T.color);
      it.marker.material.opacity = alpha;

      // 弹跳：警戒时上下动，在余光里也能注意到
      const bob = T.bob > 0 ? Math.sin(now * T.pulse * 0.5 + it.phase) * T.bob : 0;
      it.marker.position.y = bob;

      // 距离衰减尺寸：远处稍大一点，避免小到看不见
      const scale = T.size * (1 + Math.min(dist / d.indicatorRange, 1) * 0.35);
      it.marker.scale.set(scale, scale, 1);

      // 警戒度条：只在有警戒度时显示，平静时藏起来（减少视觉噪声）
      const lvl = e.alertLevel;
      const showBar = lvl > 0.02 && tier !== 'calm';
      it.barBg.visible = showBar;
      it.barFill.visible = showBar;
      if (showBar) {
        const w = 0.5;
        it.barBg.scale.set(w, 0.06, 1);
        it.barBg.position.set(0, -scale * 0.85, 0);
        it.barFill.scale.set(w * lvl, 0.06, 1);
        // center.x=0 时，position.x 是左边缘 → 与底色左对齐
        it.barFill.position.set(-w / 2, -scale * 0.85, 0);
        it.barFill.material.color.setHex(T.color);
      }
    }
  }

  /** 统计当前有多少敌人处于战斗/警戒（HUD 的「被发现」提示用） */
  get threatCount() {
    let n = 0;
    for (const it of this.items) {
      const t = it.enemy.alertTier;
      if (t === 'combat' || t === 'alert') n++;
    }
    return n;
  }

  /** 场上最高的警戒度，驱动 HUD 的「暴露度」条 */
  get maxAlert() {
    let m = 0;
    for (const it of this.items) {
      if (!it.enemy.dead) m = Math.max(m, it.enemy.alertLevel);
    }
    return m;
  }
}
