import { INPUT } from '../config.js';

/**
 * 键鼠输入。指针锁定 + 鼠标增量累积，每帧被消费一次。
 */
export class Input {
  constructor(canvas) {
    this.canvas = canvas;
    this.keys = new Set();
    this.pressed = new Set();     // 本帧刚按下
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
      if (['Space', 'Tab'].includes(e.code) && this.locked) e.preventDefault();
    });
    window.addEventListener('keyup', (e) => this.keys.delete(e.code));
    window.addEventListener('blur', () => { this.keys.clear(); this.buttons.clear(); });

    canvas.addEventListener('mousedown', (e) => {
      // 未锁定时请求指针锁定，但仍然记录这次按键。
      // 早期版本在这里 return，导致指针锁定失败或玩家按过 ESC 之后
      // 射击会彻底失效且没有任何提示。
      if (!this.locked) canvas.requestPointerLock();
      this.buttons.add(e.button);
      this.clicked.add(e.button);      // 「本帧刚按下」——半自动武器用
    });
    window.addEventListener('mouseup', (e) => this.buttons.delete(e.button));
    canvas.addEventListener('contextmenu', (e) => e.preventDefault());

    document.addEventListener('pointerlockchange', () => {
      this.locked = document.pointerLockElement === canvas;
      document.body.classList.toggle('locked', this.locked);
    });
    document.addEventListener('mousemove', (e) => {
      if (!this.locked) return;
      this.mouseDX += e.movementX;
      this.mouseDY += e.movementY;
    });
    window.addEventListener('wheel', (e) => { this.wheel += Math.sign(e.deltaY); });
  }

  any(codes) { return codes.some((c) => this.keys.has(c)); }
  anyPressed(codes) { return codes.some((c) => this.pressed.has(c)); }

  down(action) { return this.any(INPUT[action]); }
  justPressed(action) { return this.anyPressed(INPUT[action]); }

  /** 鼠标键是否在本帧刚按下（半自动武器 / 单次交互用） */
  justClicked(button = 0) { return this.clicked.has(button); }

  /** 每帧末调用：消费鼠标增量与「刚按下」集合 */
  endFrame() {
    this.mouseDX = 0;
    this.mouseDY = 0;
    this.wheel = 0;
    this.pressed.clear();
    this.clicked.clear();
  }
}
