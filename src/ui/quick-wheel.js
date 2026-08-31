/**
 * Quick Wheel（批 2）：固定 5 槽径向轮盘 —— 纯几何 + 会话控制器，零三方依赖。
 *
 * 与数据层的关系：本模块只读「显示条目」和回调，不知道 raidInventory 的形状。
 *  - onConfirm(index)   松开确认某个槽位（空槽也回调，由外部决定是否消耗）
 *  - onCancel()         中央 / Esc / 右键取消，绝不消耗
 *
 * Node 测试不需要真实 DOM：root / slotNodes / centerNode 都可省略，
 * 省略时 render() 只更新内部状态。视觉布局使用截图的双环深色语言：
 * 外环物品槽 + 数字徽标位（本项目不放数字直达键，避免覆盖 1/2/3 武器槽），
 * 中央区域显示「取消」语义，选中时展示本项目物品名与数量。
 */

export const QUICK_WHEEL_SLOT_COUNT = 5;

/** 每槽占 72°，第一槽在正上方，其余顺时针（屏幕坐标系 y 向下）。 */
export const QUICK_WHEEL_SECTOR = (Math.PI * 2) / QUICK_WHEEL_SLOT_COUNT;

/** 归一化中心取消半径：向量长度小于它 = 中央取消（返回 -1）。 */
export const QUICK_WHEEL_CENTER_RADIUS = 0.22;

/** 归一化槽位环半径（单位圆 1.0 = 外环边缘）。 */
export const QUICK_WHEEL_SLOT_RADIUS = 0.55;

/**
 * 中央取消的连续保持阈值（ms）：选过槽后向量回到中心，必须持续处于中心
 * 这么久才把 selected 清成 -1（真正取消）；阈值内离开中心则保留/切换原选择，
 * 防止「瞄好槽位 → 停住鼠标 → 松开 Q」因向量衰减穿过中心而被静默取消。
 */
export const QUICK_WHEEL_CENTER_CANCEL_MS = 300;

function wrapIndex(index) {
  return ((index % QUICK_WHEEL_SLOT_COUNT) + QUICK_WHEEL_SLOT_COUNT) % QUICK_WHEEL_SLOT_COUNT;
}

/**
 * 鼠标方向向量 → 槽位 index。
 * 判定：长度 < centerRadius（含 0 向量）→ -1（中央取消）；
 * 否则按「正上为 0、顺时针 72° 一格」的稳定扇区映射取最近槽。
 */
export function indexFromVector(dx, dy, centerRadius = QUICK_WHEEL_CENTER_RADIUS) {
  const len = Math.hypot(dx, dy);
  if (!(len > 0) || len < centerRadius) return -1;
  // atan2(dx, -dy)：0 弧度 = 正上，顺时针增长（屏幕 y 向下）。
  const angle = Math.atan2(dx, -dy);
  return wrapIndex(Math.round(angle / QUICK_WHEEL_SECTOR));
}

/** 槽位中心角（弧度，从正上顺时针）。 */
export function slotAngle(index, count = QUICK_WHEEL_SLOT_COUNT) {
  return index * ((Math.PI * 2) / count);
}

/**
 * 槽位中心在归一化单位圆上的位置（y 向下，0 = 屏幕中心）。
 * CSS 用同一公式（rotate 72° × i + translateY 环半径）排版，本函数供测试取值。
 */
export function slotPoint(index, radius = QUICK_WHEEL_SLOT_RADIUS, count = QUICK_WHEEL_SLOT_COUNT) {
  const a = slotAngle(index, count);
  return { x: Math.sin(a) * radius, y: -Math.cos(a) * radius };
}

function normalizeItems(items) {
  const out = new Array(QUICK_WHEEL_SLOT_COUNT).fill(null);
  if (Array.isArray(items)) {
    for (let i = 0; i < QUICK_WHEEL_SLOT_COUNT; i++) out[i] = items[i] ?? null;
  }
  return out;
}

export class QuickWheel {
  /**
   * @param {object} [options]
   * @param {HTMLElement|null} [options.root]       轮盘最外层节点（可为空 = 无 DOM）
   * @param {Array|null} [options.slotNodes]        5 个槽位节点（可为空）
   * @param {HTMLElement|null} [options.centerName] 中央选中名称节点（可为空）
   * @param {(index:number)=>void} [options.onConfirm]
   * @param {()=>void} [options.onCancel]
   */
  constructor(options = {}) {
    this.root = options.root ?? null;
    this.slotNodes = Array.isArray(options.slotNodes) ? options.slotNodes : null;
    this.centerName = options.centerName ?? null;
    this.onConfirm = typeof options.onConfirm === 'function' ? options.onConfirm : null;
    this.onCancel = typeof options.onCancel === 'function' ? options.onCancel : null;
    this.isOpen = false;
    this.items = normalizeItems(null);
    this.selected = -1;
    this.vecX = 0;
    this.vecY = 0;
    /** 进入中心区的时间戳（ms）；null = 不在中心取消计时中 */
    this.centerCancelSince = null;
  }

  /**
   * 打开轮盘。传入 5 槽显示条目（null = 空槽，永远占位；不压缩其它槽）。
   * 打开本身不接触任何世界暂停状态 —— 世界更新继续由主循环照常调用。
   */
  openWith(items) {
    this.items = normalizeItems(items);
    this.selected = -1;
    this.vecX = 0;
    this.vecY = 0;
    this.centerCancelSince = null;
    this.isOpen = true;
    this.render();
  }

  /**
   * 关闭轮盘。不调用任何回调（回调由确认/取消路径显式触发）。
   * 所有强制收口（失焦 / pointerlockchange / 死亡 / endGame）共用：
   * 清除选中、方向向量与中心取消计时，防止残留粘性选中。
   */
  close() {
    this.isOpen = false;
    this.selected = -1;
    this.vecX = 0;
    this.vecY = 0;
    this.centerCancelSince = null;
    if (this.root?.classList) this.root.classList.remove('open');
    this.render();
  }

  /**
   * 每帧喂入指针锁定鼠标增量：0.9 低通累积成方向向量（往右拖动选中右槽）。
   *
   * 选中与中央取消的折中时序：
   *  - indexFromVector 保持「中心 = -1」的纯几何语义（不粘性）；
   *  - 选过槽后（selected >= 0）向量回到中心不立即清选择 —— 只启动
   *    centerCancelSince 计时；连续处于中心 ≥ QUICK_WHEEL_CENTER_CANCEL_MS
   *    才把 selected 置 -1，此时松开 Q 才真正取消；
   *  - 阈值内离开中心（继续选其它槽）则保留/切换选择，centerCancelSince 重置；
   *  - 从未选中过时中心仍然是即时取消（selected 本来就是 -1）。
   * 明确取消仍然走 Esc / 右键 / 选中清空后松开（中央取消）。
   * @param {number} dx 本帧鼠标增量 X
   * @param {number} dy 本帧鼠标增量 Y
   * @param {number} [nowMs] 帧时间戳（ms），默认 performance.now()，测试可注入
   * @returns {number} 当前选中的槽 index（-1 = 中央取消）
   */
  updateFromMouse(dx, dy, nowMs = performance.now()) {
    if (!this.isOpen || !Number.isFinite(dx) || !Number.isFinite(dy)) return this.selected;
    this.vecX = this.vecX * 0.9 + dx;
    this.vecY = this.vecY * 0.9 + dy;
    const index = indexFromVector(this.vecX, this.vecY);
    if (index >= 0) {
      this.selected = index;
      this.centerCancelSince = null;   // 离开中心：清空计时，选择落回当前槽
    } else if (this.selected >= 0) {
      if (this.centerCancelSince === null) {
        this.centerCancelSince = nowMs;            // 首次进入中心：开始计时
      } else if (nowMs - this.centerCancelSince >= QUICK_WHEEL_CENTER_CANCEL_MS) {
        this.selected = -1;                        // 连续保持阈值：真正中央取消
        this.centerCancelSince = null;
      }
    } else {
      this.selected = -1;
      this.centerCancelSince = null;
    }
    this.render();
    return this.selected;
  }

  /**
   * 松开确认：central/无选择 → onCancel；有选择 → onConfirm(index)（空槽也回调，
   * 是否消耗由外部数据层决定）。确认/取消都关闭轮盘，之后世界继续。
   */
  confirmSelection() {
    const index = this.selected;
    this.close();
    if (index < 0 || index >= QUICK_WHEEL_SLOT_COUNT) {
      if (this.onCancel) this.onCancel();
      return { ok: false, index: -1, reason: 'cancel' };
    }
    if (this.onConfirm) this.onConfirm(index);
    return { ok: true, index };
  }

  /** 外部取消（Esc / 右键）：关闭且不消耗。 */
  cancel() {
    this.close();
    if (this.onCancel) this.onCancel();
    return { ok: false, index: -1, reason: 'cancel' };
  }

  /** 把内部状态刷到 DOM（无节点时只内部状态）。 */
  render() {
    if (!this.slotNodes) return;
    for (let i = 0; i < QUICK_WHEEL_SLOT_COUNT; i++) {
      const node = this.slotNodes[i];
      if (!node) continue;
      const item = this.items[i];
      const selected = this.isOpen && this.selected === i;
      if (node.classList) {
        node.classList.toggle('selected', selected);
        node.classList.toggle('empty', !item);
      }
      const name = node.querySelector?.('.qw-name');
      if (name) name.textContent = item ? (item.name ?? item.defId ?? '物品') : '空';
      const qty = node.querySelector?.('.qw-qty');
      if (qty) qty.textContent = item && (item.quantity ?? 1) > 1 ? `×${item.quantity}` : '';
      const icon = node.querySelector?.('.qw-icon');
      if (icon) icon.innerHTML = item?.glyph ?? '';
    }
    if (this.centerName) {
      const item = this.selected >= 0 ? this.items[this.selected] : null;
      this.centerName.textContent = item
        ? `${item.name ?? item.defId ?? '物品'}${(item.quantity ?? 1) > 1 ? ` ×${item.quantity}` : ''}`
        : '';
    }
    if (this.root?.classList) this.root.classList.toggle('open', this.isOpen);
  }
}
