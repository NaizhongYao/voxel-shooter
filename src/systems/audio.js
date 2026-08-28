/**
 * 音效系统 —— 全部用 Web Audio 现场合成，零音频文件。
 *
 * 为什么不用采样：这个项目的视觉语言是「一切都是方块」，音频也应该
 * 同样自洽 —— 全合成的声音天然带一种粗糙的电子质感，和体素画面是一套东西。
 * 更实际的原因是零资源依赖：不需要下载、不需要许可、不会有 404。
 *
 * 合成手段（按真实声音的物理结构分层叠加）：
 *   噪声爆发 + 陡降包络  → 枪口爆音、爆炸碎裂、脚步触地（打击类）
 *   正弦扫频            → 低频冲击波、后坐、提示音（音调类）
 *   带通滤波噪声        → 烟雾尾音、弹壳、摩擦（质感类）
 *
 * 输出链路：master → DynamicsCompressor → makeup → destination。
 * 压缩器把叠加的枪声/爆炸峰值压住，让整体电平可以推得很响而不破音；
 * makeup 增益再把压下去的响度补回来 —— 这是「声音更大」的来源。
 *
 * 另挂一条合成混响（ConvolverNode + 程序生成的脉冲响应）：
 * 真实的枪声和爆炸在室内从来不是干的一声，而是「爆音 + 空间尾响」，
 * 尾响是真实感的主要来源。湿声比例由各音效的 wet 参数控制。
 *
 * 所有声音都做 3D 衰减（按距离降音量），但不做 HRTF 全景 ——
 * PannerNode 的开销不值得，简单的距离衰减已经能表达「远处有枪声」。
 */

const MASTER_VOLUME = 1.0;
/** 背景音乐相对主线的音量。要压在枪声下面，但单独听也得听得见 */
const MUSIC_VOLUME = 0.42;

export class Audio {
  constructor() {
    this.ctx = null;
    this.master = null;
    this.reverb = null;
    this.enabled = true;
    this.ready = false;
    /** 背景音乐开关。默认开，N 键可切（见 toggleMusic） */
    this.musicOn = true;
    this.musicGain = null;
    this._stingTimer = null;
    /** 脚步节流：按距离累积，走够一步才响（不是按时间） */
    this._stepAccum = 0;
    this._lastPos = null;
  }

  /**
   * 真正创建 AudioContext。
   *
   * 必须由用户手势触发 —— 浏览器的自动播放策略会把在手势之前创建的
   * context 直接挂成 suspended 状态，之后所有声音都是静音的。
   * 主循环在第一次点击（也就是请求指针锁定的那次）调用它。
   */
  init() {
    if (this.ctx) {
      // 已存在但被浏览器挂起（切标签页回来）→ 恢复
      if (this.ctx.state === 'suspended') this.ctx.resume();
      return;
    }
    const AC = window.AudioContext || window.webkitAudioContext;
    if (!AC) { this.enabled = false; return; }
    this.ctx = new AC();

    // 干声总线 → 压缩器 → 补偿增益 → 扬声器
    this.master = this.ctx.createGain();
    this.master.gain.value = MASTER_VOLUME;
    const comp = this.ctx.createDynamicsCompressor();
    comp.threshold.value = -16;
    comp.knee.value = 10;
    comp.ratio.value = 6;
    comp.attack.value = 0.002;
    comp.release.value = 0.16;
    const makeup = this.ctx.createGain();
    makeup.gain.value = 1.5;
    this.master.connect(comp);
    comp.connect(makeup);
    makeup.connect(this.ctx.destination);

    // 混响：程序生成的立体声脉冲响应（指数衰减噪声），模拟室内空间
    this.reverb = this.ctx.createConvolver();
    this.reverb.buffer = this._impulse(1.8, 2.6);
    const wet = this.ctx.createGain();
    wet.gain.value = 0.4;
    this.reverb.connect(wet);
    wet.connect(this.master);

    this.ready = true;
    // init() 由用户手势触发，满足自动播放策略 —— 音乐可以安全地从这里起步
    this._buildMusic();
  }

  /** 合成混响脉冲响应：立体声、指数衰减的噪声，模拟小房间的尾响 */
  _impulse(seconds, decay) {
    const len = Math.max(1, Math.floor(this.ctx.sampleRate * seconds));
    const buf = this.ctx.createBuffer(2, len, this.ctx.sampleRate);
    for (let ch = 0; ch < 2; ch++) {
      const d = buf.getChannelData(ch);
      for (let i = 0; i < len; i++) {
        d[i] = (Math.random() * 2 - 1) * Math.pow(1 - i / len, decay);
      }
    }
    return buf;
  }

  get t() { return this.ctx.currentTime; }

  /** 距离衰减增益。listenDist 为声源到听者的距离。 */
  gainFor(dist, maxDist) {
    if (dist >= maxDist) return 0;
    // 平方衰减太快（远处枪声完全听不到，玩家失去情报），用线性的平方根
    return Math.pow(1 - dist / maxDist, 1.6);
  }

  /** 一段白噪声缓冲，各类打击音的原料。缓存复用避免每发都重新生成。 */
  noiseBuffer(seconds = 0.5) {
    const key = Math.round(seconds * 100);
    this._noise ??= new Map();
    if (this._noise.has(key)) return this._noise.get(key);
    const len = Math.max(1, Math.floor(this.ctx.sampleRate * seconds));
    const buf = this.ctx.createBuffer(1, len, this.ctx.sampleRate);
    const d = buf.getChannelData(0);
    for (let i = 0; i < len; i++) d[i] = Math.random() * 2 - 1;
    this._noise.set(key, buf);
    return buf;
  }

  /**
   * 把节点挂到输出：干声进 out（默认 master），wet>0 时再按比例送混响。
   * 背景音乐的事件音走 musicGain 总线，这样音乐开关对它们同样生效。
   */
  _tap(node, wet, out = null) {
    node.connect(out ?? this.master);
    if (wet > 0 && this.reverb) {
      const wg = this.ctx.createGain();
      wg.gain.value = wet;
      node.connect(wg);
      wg.connect(this.reverb);
    }
  }

  /**
   * 噪声爆发。打击类声音的通用构件。
   * @param filterType lowpass 给低沉的（爆炸），highpass 给清脆的（枪声）
   * @param wet 送入混响的比例（0 = 纯干声）
   * @param at 起播时刻（默认当前时刻），音乐事件用来排延迟音
   * @param out 目标总线（默认 master）
   */
  burst({ dur = 0.12, gain = 1, filterType = 'bandpass', freq = 1200,
          q = 1, freqEnd = null, wet = 0, at = null, out = null } = {}) {
    const t0 = at ?? this.t;
    const src = this.ctx.createBufferSource();
    src.buffer = this.noiseBuffer(Math.max(0.2, dur * 1.5));
    const filt = this.ctx.createBiquadFilter();
    filt.type = filterType;
    filt.frequency.value = freq;
    filt.Q.value = q;
    if (freqEnd !== null) {
      filt.frequency.setValueAtTime(freq, t0);
      filt.frequency.exponentialRampToValueAtTime(
        Math.max(40, freqEnd), t0 + dur
      );
    }
    const g = this.ctx.createGain();
    // 陡降包络：瞬时全开然后按幂曲线衰减，这是「打击感」的来源
    g.gain.setValueAtTime(gain, t0);
    g.gain.exponentialRampToValueAtTime(0.0008, t0 + dur);
    src.connect(filt); filt.connect(g);
    this._tap(g, wet, out);
    src.start(t0);
    src.stop(t0 + dur * 1.4);
    return g;
  }

  /** 正弦/三角扫频。低频冲击与提示音用。at/out 含义同 burst。 */
  tone({ from = 220, to = 60, dur = 0.2, gain = 0.5, type = 'sine',
         wet = 0, at = null, out = null } = {}) {
    const t0 = at ?? this.t;
    const osc = this.ctx.createOscillator();
    osc.type = type;
    osc.frequency.setValueAtTime(from, t0);
    osc.frequency.exponentialRampToValueAtTime(Math.max(20, to), t0 + dur);
    const g = this.ctx.createGain();
    g.gain.setValueAtTime(gain, t0);
    g.gain.exponentialRampToValueAtTime(0.0008, t0 + dur);
    osc.connect(g);
    this._tap(g, wet, out);
    osc.start(t0);
    osc.stop(t0 + dur * 1.1);
    return g;
  }

  // ── 具体音效 ─────────────────────────────────────────────────────────

  /**
   * 枪声。按真实枪声的四层结构叠加：
   *   ① 高频爆裂（激波「啪」）② 中频体（枪管共鸣）
   *   ③ 烟雾尾音（低通噪声余响，真实感的主要来源）④ 低频后坐
   * 每发随机微调音高/音量，连发时不会像复读机。
   * 不同武器只改各层的频率与时长，所以手枪和 DMR 一听就分得出来。
   *
   * @param weight 'light'（手枪/SMG）| 'medium'（AR）| 'heavy'（DMR/霰弹）
   */
  shoot(weight = 'medium', dist = 0, maxDist = 55) {
    if (!this.ready || !this.enabled) return;
    const att = this.gainFor(dist, maxDist);
    if (att <= 0.001) return;

    const P = {
      light:  { hi: 3400, body: 950, low: 165, dur: 0.09, tail: 0.22, g: 0.85 },
      medium: { hi: 2700, body: 720, low: 115, dur: 0.13, tail: 0.30, g: 1.05 },
      heavy:  { hi: 2000, body: 500, low: 78,  dur: 0.20, tail: 0.45, g: 1.35 },
    }[weight] ?? {};
    const v = 0.92 + Math.random() * 0.16;

    // ① 枪口爆音
    this.burst({
      dur: P.dur * 0.4, gain: 1.0 * P.g * att * v,
      filterType: 'highpass', freq: P.hi * v, q: 0.6, wet: 0.2,
    });
    // ② 枪体共鸣（频率下坠制造「砰」的厚度）
    this.burst({
      dur: P.dur, gain: 0.85 * P.g * att * v,
      filterType: 'bandpass', freq: P.body * v, freqEnd: P.body * 0.3, q: 1.0, wet: 0.3,
    });
    // ③ 烟雾尾音
    this.burst({
      dur: P.tail, gain: 0.42 * P.g * att * v,
      filterType: 'lowpass', freq: 950, freqEnd: 200, q: 0.5, wet: 0.5,
    });
    // ④ 后坐冲击
    this.tone({
      from: P.low * v, to: P.low * 0.42, dur: P.dur * 1.8,
      gain: 0.6 * P.g * att, type: 'triangle', wet: 0.15,
    });
  }

  /**
   * 爆炸。真实爆炸 = 起爆脆响 + 低频冲击波 + 主体轰鸣 + 碎石余震，
   * 四层全部带混响尾，比枪声厚重一个数量级。
   */
  explosion(dist = 0, maxDist = 70) {
    if (!this.ready || !this.enabled) return;
    const att = this.gainFor(dist, maxDist);
    if (att <= 0.001) return;
    // 起爆的「咔」
    this.burst({
      dur: 0.08, gain: 1.1 * att, filterType: 'highpass', freq: 3500, q: 0.4, wet: 0.4,
    });
    // 低频冲击波（胸腔感受到的那一下）
    this.tone({ from: 110, to: 24, dur: 1.1, gain: 1.4 * att, type: 'sine', wet: 0.35 });
    // 主体轰鸣：扫频向下模拟火球膨胀后消散
    this.burst({
      dur: 0.9, gain: 1.1 * att,
      filterType: 'lowpass', freq: 2800, freqEnd: 140, q: 0.5, wet: 0.55,
    });
    // 碎石与余震的长尾
    this.burst({
      dur: 1.5, gain: 0.45 * att,
      filterType: 'lowpass', freq: 420, freqEnd: 60, q: 0.8, wet: 0.6,
    });
  }

  /**
   * 脚步。按累积移动距离触发，而不是定时器 ——
   * 定时器在慢走时会响得和跑步一样密，节奏完全不对。
   *
   * 三层结构：脚跟闷响（低通）+ 地面砂砾（带通）+ 轻微的楼板共振，
   * 频率和音量都随机化，避免机械重复。
   *
   * @param stance normal | slow | crouch，决定音量（和噪音半径一致）
   */
  footstep(stance = 'normal', dist = 0, maxDist = 26) {
    if (!this.ready || !this.enabled) return;
    const att = this.gainFor(dist, maxDist);
    if (att <= 0.001) return;
    const vol = { normal: 0.55, slow: 0.26, crouch: 0.15 }[stance] ?? 0.55;
    const v = 0.85 + Math.random() * 0.3;
    // 脚跟触地的闷响
    this.burst({
      dur: 0.085, gain: vol * att * v,
      filterType: 'lowpass', freq: 320 + Math.random() * 140, q: 1.1,
    });
    // 鞋底与地面的砂砾摩擦
    this.burst({
      dur: 0.05, gain: vol * 0.45 * att * v,
      filterType: 'bandpass', freq: 1900 + Math.random() * 900, q: 2.2,
    });
    // 楼板/地面的低频共振
    this.tone({
      from: 95 + Math.random() * 25, to: 55, dur: 0.07,
      gain: vol * 0.3 * att, type: 'sine',
    });
  }

  /**
   * 玩家移动 → 脚步节流。每 STEP_DIST vox 响一次。
   * @returns 是否触发了脚步（供上层同步动画等）
   */
  updateFootsteps(pos, stance, onGround) {
    if (!this.ready || !this.enabled) return false;
    if (!this._lastPos) {
      this._lastPos = { x: pos.x, z: pos.z };
      return false;
    }
    const dx = pos.x - this._lastPos.x, dz = pos.z - this._lastPos.z;
    this._lastPos.x = pos.x; this._lastPos.z = pos.z;
    if (!onGround) return false;
    this._stepAccum += Math.hypot(dx, dz);
    // 蹲行的步幅更短
    const stride = stance === 'crouch' ? 1.0 : stance === 'slow' ? 1.4 : 1.9;
    if (this._stepAccum < stride) return false;
    this._stepAccum = 0;
    this.footstep(stance, 0);
    return true;
  }

  /** 换弹：机械的「咔哒」两声 */
  reload() {
    if (!this.ready || !this.enabled) return;
    this.burst({ dur: 0.05, gain: 0.35, filterType: 'bandpass', freq: 1800, q: 3 });
    const later = this.t + 0.14;
    const src = this.ctx.createBufferSource();
    src.buffer = this.noiseBuffer(0.2);
    const f = this.ctx.createBiquadFilter();
    f.type = 'bandpass'; f.frequency.value = 1200; f.Q.value = 3;
    const g = this.ctx.createGain();
    g.gain.setValueAtTime(0.32, later);
    g.gain.exponentialRampToValueAtTime(0.0008, later + 0.06);
    src.connect(f); f.connect(g); g.connect(this.master);
    src.start(later); src.stop(later + 0.1);
  }

  /** 玩家受击：短促的闷击 + 耳鸣感的高频 */
  hurt(armorAbsorbed) {
    if (!this.ready || !this.enabled) return;
    if (armorAbsorbed) {
      // 打在护甲上：金属质感，比打在肉上清脆
      this.burst({ dur: 0.1, gain: 0.5, filterType: 'bandpass', freq: 2600, q: 4 });
      this.tone({ from: 320, to: 140, dur: 0.1, gain: 0.25, type: 'square' });
    } else {
      this.burst({ dur: 0.14, gain: 0.55, filterType: 'lowpass', freq: 500, q: 1 });
      this.tone({ from: 180, to: 70, dur: 0.22, gain: 0.4, type: 'triangle' });
    }
  }

  /**
   * 敌人死亡。不要「叮」式的正反馈欢快音 —— 那太喜感，和肃清协议的氛围相悖。
   * 这里要的是一声绝望的终结：
   *   喉音般的低吟（锯齿波过低通，带濒死颤抖的 vibrato，音高一路滑落）
   *   + 躯体倒地的闷响。整声混响拉满，留出「人没了」的空旷感。
   */
  kill() {
    if (!this.ready || !this.enabled) return;
    const t0 = this.t;
    // 低吟：锯齿波谐波丰富，过低通后接近人声的粗糙质感
    const osc = this.ctx.createOscillator();
    osc.type = 'sawtooth';
    const f0 = 165 + Math.random() * 40;
    osc.frequency.setValueAtTime(f0, t0);
    osc.frequency.exponentialRampToValueAtTime(f0 * 0.32, t0 + 0.62);
    // 濒死的颤抖：7Hz vibrato 调制音高，幅度随音高下降显得越来越无力
    const vib = this.ctx.createOscillator();
    vib.frequency.value = 7;
    const vibG = this.ctx.createGain();
    vibG.gain.value = 6;
    vib.connect(vibG); vibG.connect(osc.frequency);
    const lp = this.ctx.createBiquadFilter();
    lp.type = 'lowpass'; lp.frequency.value = 680; lp.Q.value = 0.8;
    const g = this.ctx.createGain();
    // 先轻起（像最后一口气呼出来）再衰减，避免硬起的「叭」声
    g.gain.setValueAtTime(0.0001, t0);
    g.gain.exponentialRampToValueAtTime(0.3, t0 + 0.05);
    g.gain.exponentialRampToValueAtTime(0.0008, t0 + 0.72);
    osc.connect(lp); lp.connect(g);
    this._tap(g, 0.5);
    osc.start(t0); vib.start(t0);
    osc.stop(t0 + 0.8); vib.stop(t0 + 0.8);
    // 躯体倒地：一声闷响垫在吟声下面
    this.tone({ from: 92, to: 40, dur: 0.24, gain: 0.3, type: 'sine', wet: 0.3 });
    this.burst({ dur: 0.12, gain: 0.18, filterType: 'lowpass', freq: 420, q: 1 });
  }

  /** 拾取 */
  pickup() {
    if (!this.ready || !this.enabled) return;
    this.tone({ from: 440, to: 780, dur: 0.11, gain: 0.2, type: 'sine' });
  }

  /** 开关门：木质的吱呀（低频扫频 + 摩擦噪声） */
  door(opening) {
    if (!this.ready || !this.enabled) return;
    this.burst({
      dur: 0.3, gain: 0.3, filterType: 'bandpass',
      freq: opening ? 400 : 300, freqEnd: opening ? 700 : 180, q: 2,
    });
  }

  /** 手雷出手：拉环的金属「叮」+ 挥臂破空（带通上扫） */
  grenadeThrow() {
    if (!this.ready || !this.enabled) return;
    // 拉环
    this.burst({ dur: 0.04, gain: 0.4, filterType: 'bandpass', freq: 2700, q: 7 });
    this.tone({ from: 2400, to: 1900, dur: 0.05, gain: 0.12, type: 'triangle' });
    // 挥臂破空
    this.burst({
      dur: 0.22, gain: 0.35, filterType: 'bandpass',
      freq: 500, freqEnd: 1900, q: 1.3, wet: 0.2,
    });
  }

  /** 玩家死亡：一段下沉的低频（「视野暗下去」的听觉对应） */
  death() {
    if (!this.ready || !this.enabled) return;
    this.tone({ from: 220, to: 30, dur: 1.4, gain: 0.5, type: 'sine', wet: 0.3 });
    this.burst({
      dur: 1.0, gain: 0.3, filterType: 'lowpass', freq: 800, freqEnd: 90, q: 0.7, wet: 0.3,
    });
  }

  // ── 背景音乐（紧张 / 恐怖氛围，全程序化合成） ─────────────────────────
  //
  // 结构 = 常驻低音层 + 稀疏的随机惊悚事件：
  //   ① 次低频 drone：两支相差 0.4Hz 的 55Hz 正弦，拍频制造生理性的不安，
  //      LFO 让它像呼吸一样缓慢起伏
  //   ② 中频小二度：220 与 233.08Hz 同奏 —— 小二度是恐怖片标配的不协和音程，
  //      音量压得很低，只在意识边缘制造紧张
  //   ③ 高频泛音：一根若有若无的细线，极慢地忽隐忽现
  //   事件音（6~17 秒随机一次）：远处闷雷 / 高音不协和刺 / 心跳两连击 / 金属吱呀
  //
  // 全部走 musicGain 总线，toggleMusic() 一刀可切；总线挂在 master 上，
  // 所以 M 键总静音对音乐同样生效。

  _buildMusic() {
    const c = this.ctx;
    this.musicGain = c.createGain();
    this.musicGain.gain.value = this.musicOn ? MUSIC_VOLUME : 0;
    this.musicGain.connect(this.master);

    // ① 次低频 drone（拍频不安 + 呼吸起伏）
    const subG = c.createGain();
    subG.gain.value = 0.42;
    for (const f of [55, 55.4]) {
      const o = c.createOscillator();
      o.type = 'sine'; o.frequency.value = f;
      o.connect(subG); o.start();
    }
    const subLp = c.createBiquadFilter();
    subLp.type = 'lowpass'; subLp.frequency.value = 150;
    subG.connect(subLp); subLp.connect(this.musicGain);
    const breathe = c.createOscillator();
    breathe.frequency.value = 0.07;
    const breatheG = c.createGain();
    breatheG.gain.value = 0.16;
    breathe.connect(breatheG); breatheG.connect(subG.gain); breathe.start();

    // ② 中频小二度不协和层（慢颤音）
    const midG = c.createGain();
    midG.gain.value = 0.045;
    for (const f of [220, 233.08]) {
      const o = c.createOscillator();
      o.type = 'triangle'; o.frequency.value = f;
      const og = c.createGain(); og.gain.value = 0.5;
      o.connect(og); og.connect(midG); o.start();
    }
    midG.connect(this.musicGain);
    const trem = c.createOscillator();
    trem.frequency.value = 0.11;
    const tremG = c.createGain();
    tremG.gain.value = 0.028;
    trem.connect(tremG); tremG.connect(midG.gain); trem.start();

    // ③ 高频泛音细线（忽隐忽现）
    const hi = c.createOscillator();
    hi.type = 'sine'; hi.frequency.value = 1244.5;
    const hiG = c.createGain();
    hiG.gain.value = 0.012;
    hi.connect(hiG); hiG.connect(this.musicGain); hi.start();
    const hiLfo = c.createOscillator();
    hiLfo.frequency.value = 0.043;
    const hiLfoG = c.createGain();
    hiLfoG.gain.value = 0.011;
    hiLfo.connect(hiLfoG); hiLfoG.connect(hiG.gain); hiLfo.start();

    this._scheduleSting();
  }

  /** 事件音自调度链：6~17 秒后放一个随机惊悚音。音乐关闭时链不断、只是不发声 */
  _scheduleSting() {
    const wait = 6000 + Math.random() * 11000;
    this._stingTimer = setTimeout(() => {
      if (this.ready && this.enabled && this.musicOn) this._playSting();
      this._scheduleSting();
    }, wait);
  }

  /** 随机惊悚事件，全部走 musicGain 总线 */
  _playSting() {
    const out = this.musicGain;
    const roll = Math.random();
    if (roll < 0.3) {
      // 远处闷雷：像楼下什么地方塌了什么
      this.tone({ from: 82, to: 28, dur: 1.3, gain: 0.5, type: 'sine', wet: 0.6, out });
      this.burst({ dur: 0.8, gain: 0.22, filterType: 'lowpass', freq: 500, freqEnd: 70, q: 0.6, wet: 0.5, out });
    } else if (roll < 0.55) {
      // 高音不协和刺：两个小二度正弦一闪而过，像远处弦乐的尖叫
      const f = 1500 + Math.random() * 500;
      this.tone({ from: f, to: f * 0.94, dur: 0.9, gain: 0.05, type: 'sine', wet: 0.8, out });
      this.tone({ from: f * 1.059, to: f, dur: 0.9, gain: 0.04, type: 'sine', wet: 0.8, out });
    } else if (roll < 0.8) {
      // 心跳：lub-dub 两连击，第二下稍弱稍迟
      this.tone({ from: 58, to: 36, dur: 0.16, gain: 0.5, type: 'sine', wet: 0.2, out });
      this.tone({ from: 52, to: 33, dur: 0.14, gain: 0.36, type: 'sine', wet: 0.2, out, at: this.t + 0.3 });
    } else {
      // 金属吱呀：某扇门或管道在远处被慢慢推开
      this.burst({ dur: 0.9, gain: 0.1, filterType: 'bandpass', freq: 320, freqEnd: 950, q: 5, wet: 0.6, out });
    }
  }

  /** 背景音乐开关。用 0.4 秒淡入淡出，避免开关瞬间的「咔」声 */
  toggleMusic() {
    this.musicOn = !this.musicOn;
    if (this.musicGain) {
      const g = this.musicGain.gain;
      g.cancelScheduledValues(this.t);
      g.setValueAtTime(g.value, this.t);
      g.linearRampToValueAtTime(this.musicOn ? MUSIC_VOLUME : 0, this.t + 0.4);
    }
    return this.musicOn;
  }

  toggle() {
    this.enabled = !this.enabled;
    if (this.master) this.master.gain.value = this.enabled ? MASTER_VOLUME : 0;
    return this.enabled;
  }
}
