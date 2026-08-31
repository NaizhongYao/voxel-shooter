import { INPUT } from '../config.js';

/**
 * 键鼠输入。指针锁定 + 鼠标增量累积，每帧被消费一次。
 */
export class Input {
  constructor(canvas) {
    this.canvas = canvas;
    this.keys = new Set();
    this.pressed = new Set();     // 本帧刚按下
    this.keyDownAt = new Map();  // code -> performance timestamp (ms)
    this.longPressed = new Set();
    this.longCompleted = new Set();
    this.released = new Set();
    this.releasedDuration = new Map();
    this.mouseDX = 0;
    this.mouseDY = 0;
    this.buttons = new Set();     // 当前按住的鼠标键
    this.clicked = new Set();     // 本帧刚按下的鼠标键
    this.locked = false;
    this.wheel = 0;

    this.keyEventCount = 0;      // 诊断用：确认键盘事件是否真的到达

    window.addEventListener('keydown', (e) => {
      if (e.repeat) return;
      this.keyEventCount++;
      this.keys.add(e.code);
      this.pressed.add(e.code);
      this.keyDownAt.set(e.code, performance.now());
      // 游戏锁定时吞掉会影响浏览器/系统焦点的动作键。Tab 必须在任意时刻拦截
      // （不只是指针锁定）：背包面板打开时焦点已解锁，不拦截的话 Tab 会把焦点
      // 移出画布/面板，而面板自己正在用 Tab 关闭 —— 不能让浏览器抢走按键语义。
      if (e.code === 'Tab') e.preventDefault();
      else if (['Space', 'F10'].includes(e.code) && this.locked) e.preventDefault();
    });
    window.addEventListener('keyup', (e) => {
      this.keys.delete(e.code);
      const downAt = this.keyDownAt.get(e.code);
      if (downAt !== undefined) {
        this.released.add(e.code);
        this.releasedDuration.set(e.code, performance.now() - downAt);
      }
      this.keyDownAt.delete(e.code);
      this.longPressed.delete(e.code);
      this.longCompleted.delete(e.code);
    });
    /**
     * 失焦时清空所有按住状态 —— 不止 keys/buttons：
     * pressed 里的「本帧刚按下」如果不清，回到窗口那一帧会凭空触发
     * 一次开火/开门/切枪；clicked 不清则半自动武器会自己打一枪。
     */
    window.addEventListener('blur', () => {
      this.keys.clear();
      this.keyDownAt.clear();
      this.longPressed.clear();
      this.longCompleted.clear();
      this.released.clear();
      this.releasedDuration.clear();
      this.buttons.clear();
      this.pressed.clear();
      this.clicked.clear();
    });

    canvas.addEventListener('mousedown', (e) => {
      // 未锁定时请求指针锁定，但仍然记录这次按键。
      // 注意：指针锁定有 ~1s 的浏览器冷却期，冷却内调用会抛 SecurityError；
      // 没有用户手势时（R 重开的自动流程）Promise 会 reject。
      // 两种情况都必须吞掉 —— 否则下面的 buttons.add 执行不到，
      // 表现就是「ESC 之后第一枪怎么点都打不出去」。
      if (!this.locked) {
        try { canvas.requestPointerLock()?.catch?.(() => {}); }
        catch { /* 冷却中，下一帧再试 */ }
      }
      this.buttons.add(e.button);
      this.clicked.add(e.button);      // 「本帧刚按下」——半自动武器用
    });
    window.addEventListener('mouseup', (e) => this.buttons.delete(e.button));
    canvas.addEventListener('contextmenu', (e) => e.preventDefault());

    document.addEventListener('pointerlockchange', () => {
      this.locked = document.pointerLockElement === canvas;
      document.body.classList.toggle('locked', this.locked);
      /**
       * 解锁时清空鼠标状态：按住左键再按 ESC，这次 mouseup 会被浏览器
       * 在解锁过程中吞掉 —— 不复位的话回到游戏会一直自动开火。
       */
      if (!this.locked) {
        this.keyDownAt.clear();
        this.longPressed.clear();
        this.longCompleted.clear();
        this.released.clear();
        this.releasedDuration.clear();
        this.buttons.clear();
        this.clicked.clear();
        this.pressed.clear();
      }
    });
    document.addEventListener('mousemove', (e) => {
      if (!this.locked) return;
      this.mouseDX += e.movementX;
      this.mouseDY += e.movementY;
    });
    window.addEventListener('wheel', (e) => { this.wheel += Math.sign(e.deltaY); });
  }

  any(codes = []) {
    return codes.some((code) => {
      const mouse = /^Mouse(\d+)$/.exec(code);
      return mouse ? this.buttons.has(Number(mouse[1])) : this.keys.has(code);
    });
  }

  anyPressed(codes = []) {
    return codes.some((code) => {
      const mouse = /^Mouse(\d+)$/.exec(code);
      return mouse ? this.clicked.has(Number(mouse[1])) : this.pressed.has(code);
    });
  }

  down(action) { return this.any(INPUT[action]); }
  justPressed(action) { return this.anyPressed(INPUT[action]); }

  /**
   * 按键持续达到 durationSec 时只返回一次 true。
   * 释放后可再次触发，短按不会误触发长按动作。
   */
  longPress(action, durationSec = 0.4) {
    const thresholdMs = durationSec * 1000;
    for (const code of INPUT[action] ?? []) {
      const downAt = this.keyDownAt.get(code);
      if (downAt !== undefined && !this.longCompleted.has(code)
          && performance.now() - downAt >= thresholdMs) {
        this.longCompleted.add(code);
        return true;
      }
    }
    return false;
  }

  /** 本帧释放的动作是否达到指定按住时长。 */
  releasedShort(action, durationSec = 0.4) {
    const thresholdMs = durationSec * 1000;
    return (INPUT[action] ?? []).some((code) => this.released.has(code)
      && (this.releasedDuration.get(code) ?? Infinity) < thresholdMs);
  }

  /**
   * 本帧是否释放该动作（不论按住时长）。Quick Wheel「松开确认」用 ——
   * releasedShort/releasedLong 按时长二选一，这里提供无歧义的合并读法，
   * 避免同一帧先判 short 又判 long 的语义分叉。
   */
  releasedAny(action) {
    return (INPUT[action] ?? []).some((code) => this.released.has(code));
  }

  /** 本帧释放的动作是否已经完成长按。 */
  releasedLong(action, durationSec = 0.4) {
    const thresholdMs = durationSec * 1000;
    return (INPUT[action] ?? []).some((code) => this.released.has(code)
      && (this.releasedDuration.get(code) ?? 0) >= thresholdMs);
  }

  /** 鼠标键是否在本帧刚按下（半自动武器 / 单次交互用） */
  justClicked(button = 0) { return this.clicked.has(button); }

  /** 每帧末调用：消费鼠标增量与「刚按下」集合 */
  endFrame() {
    this.mouseDX = 0;
    this.mouseDY = 0;
    this.wheel = 0;
    // longPressed 中的 code 会在 keyup 时清除，确保一次按住只触发一次。
    this.pressed.clear();
    this.clicked.clear();
    this.released.clear();
    this.releasedDuration.clear();
  }
}
