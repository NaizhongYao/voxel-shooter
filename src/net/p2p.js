import { encode, decode, BUILD_ID, NET_VERSION, roomCode, cleanName } from './protocol.js';
import { CoopRoom } from '../../server/room.mjs';
import { CoopSimulation } from '../../server/simulation.mjs';

// 点对点直连（局域网内可用，不需要任何服务器）：页面仍从静态站点加载，
// 战局数据直接在两个浏览器之间走 WebRTC 数据通道。
// 代价是必须交换一次信令（邀请码/回答码）——这是无服务器架构的数学下限，
// 做成“复制链接发微信”即可，不需要任何技术操作。

const SIGNAL_VERSION = 1;

/** UTF-8 安全的 base64url。 */
function b64e(text) {
  const bytes = new TextEncoder().encode(text);
  let bin = '';
  for (const b of bytes) bin += String.fromCharCode(b);
  return btoa(bin).replaceAll('+', '-').replaceAll('/', '_').replaceAll('=', '');
}
function b64d(str) {
  const b64 = str.replaceAll('-', '+').replaceAll('_', '/');
  const bin = atob(b64 + '='.repeat((4 - (b64.length % 4)) % 4));
  const bytes = Uint8Array.from(bin, (c) => c.charCodeAt(0));
  return new TextDecoder().decode(bytes);
}

export function p2pAvailable() {
  return typeof RTCPeerConnection === 'function';
}

/** {v,build,code,sdp} → 可粘贴/可放进链接的短文本。 */
export function encodeSignal(payload) {
  return b64e(JSON.stringify({ v: SIGNAL_VERSION, build: BUILD_ID, ...payload }));
}
export function decodeSignal(text) {
  const raw = String(text ?? '').trim();
  const tail = raw.includes('#') ? raw.slice(raw.lastIndexOf('#') + 1) : raw;
  const body = /^[oa]=/.test(tail) ? tail.slice(2) : tail;
  let data;
  try { data = JSON.parse(b64d(body)); } catch { throw new Error('邀请码无法识别，请重新复制完整内容'); }
  if (data?.v !== SIGNAL_VERSION) throw new Error('邀请码版本不一致，请双方都刷新页面');
  if (data.build !== BUILD_ID) throw new Error('双方游戏版本不一致，请都刷新页面后重试');
  if (typeof data.sdp !== 'string' || !data.sdp.includes('m=application')) throw new Error('邀请码不完整，请重新复制');
  return data;
}

const waitIce = (pc) => new Promise((resolve) => {
  if (pc.iceGatheringState === 'complete') return resolve();
  const done = () => { pc.onicegatheringstatechange = null; clearTimeout(timer); resolve(); };
  const timer = setTimeout(done, 1500); // 无 STUN 时几乎立即完成，1.5s 只是兜底
  pc.onicegatheringstatechange = () => { if (pc.iceGatheringState === 'complete') done(); };
});

/**
 * 把 RTCDataChannel 包装成 CoopClient 认得的 WebSocket 形状。
 * deliver(str) 由 P2P 层在收到网络消息时调用；send 直接写通道。
 */
export function channelSocket(getChannel) {
  const s = {
    readyState: 0, bufferedAmount: 0,
    onopen: null, onmessage: null, onclose: null, onerror: null,
    deliver(str) { s.onmessage?.({ data: str }); },
    send(str) { const ch = getChannel(); if (ch?.readyState === 'open') ch.send(str); },
    close() { try { getChannel()?.close(); } catch { /* 已断开 */ } },
  };
  return s;
}

function bindChannel(ch, s) {
  if (ch.__bound) return;
  ch.__bound = true;
  const opened = () => {
    if (s.readyState === 1) return;
    s.readyState = 1;
    s.onopen?.();
    s.__opened?.();
  };
  ch.onopen = opened;
  ch.onmessage = (e) => s.deliver(typeof e.data === 'string' ? e.data : '');
  ch.onclose = () => { s.readyState = 3; s.onclose?.({ code: 1006 }); };
  ch.onerror = () => { try { s.onerror?.(); } catch { /* 忽略 */ } };
  if (ch.readyState === 'open') queueMicrotask(opened);
}

/**
 * 一次 P2P 连接的完整生命周期（房主与队友共用）。
 * 房主：createInvite → acceptAnswer；队友：acceptInvite（返回回答码）。
 * 通道打开后 onOpen 被调用，随后把 socket() 交给 CoopClient 即可。
 */
export class CoopP2P {
  constructor({ onOpen, onClose } = {}) {
    this.onOpen = onOpen; this.onClose = onClose;
    this.pc = null; this.channel = null; this.socket = null; this.closed = false; this.openedFired = false;
  }
  _pc() {
    if (this.pc) return this.pc;
    this.pc = new RTCPeerConnection({ iceServers: [] }); // 局域网直连：不需要 STUN/TURN，也不碰被墙的公网探测
    this.socket = channelSocket(() => this.channel);
    this.socket.__opened = () => { if (!this.openedFired) { this.openedFired = true; this.onOpen?.(); } };
    this.pc.onconnectionstatechange = () => {
      if (['failed', 'closed'].includes(this.pc?.connectionState) && !this.closed) {
        this.closed = true; this.onClose?.();
      }
    };
    return this.pc;
  }
  _bind(ch) {
    this.channel = ch;
    bindChannel(ch, this.socket);
    this.socket.__opened = this.onOpen;
  }
  socketReady() { return this.socket; }
  async createInvite(code) {
    const pc = this._pc();
    this._bind(pc.createDataChannel('coop', { ordered: true }));
    await pc.setLocalDescription(await pc.createOffer());
    await waitIce(pc);
    return encodeSignal({ code, sdp: pc.localDescription.sdp });
  }
  async acceptInvite(invite) {
    const data = decodeSignal(invite);
    const pc = this._pc();
    pc.ondatachannel = (e) => this._bind(e.channel);
    await pc.setRemoteDescription({ type: 'offer', sdp: data.sdp });
    await pc.setLocalDescription(await pc.createAnswer());
    await waitIce(pc);
    return { code: data.code, answer: encodeSignal({ code: data.code, sdp: pc.localDescription.sdp }) };
  }
  async acceptAnswer(answer) {
    const data = decodeSignal(answer);
    await this.pc.setRemoteDescription({ type: 'answer', sdp: data.sdp });
    return data.code;
  }
  close() { this.closed = true; try { this.channel?.close(); } catch { /* 已断开 */ } try { this.pc?.close(); } catch { /* 已断开 */ } }
}

/**
 * 房主浏览器内的权威战局：直接复用服务端同一套 CoopRoom / CoopSimulation，
 * 只是把“网络发送”换成数据通道与本地回环。整个流程的消息形状与联机服务器完全一致。
 */
export class P2PHost {
  constructor() {
    this.room = null; this.code = null; this.timer = null;
    this.peers = new Map();   // p2p 实例 → { socket, member }
    this.self = null;         // 房主自己的回环 socket
  }
  ensureRoom() {
    if (this.room) return this.code;
    this.code = roomCode();
    this.room = new CoopRoom(this.code, { createSimulation: (map, members, raidId) => new CoopSimulation(map, members, raidId) });
    let last = performance.now(), count = 0;
    this.timer = setInterval(() => {
      const now = performance.now(), dt = Math.min(0.1, (now - last) / 1000); last = now;
      try { this.room.advance(dt); if (count % 3 === 0) this.room.snapshots(); } catch (err) { console.error('[P2P] 战局推进失败', err); }
      count++;
    }, 1000 / 30);
    return this.code;
  }
  /** 房主自己的客户端走本地回环：发出去的字符串直接进 CoopRoom，房间发回来的消息直接回调。 */
  selfSocket() {
    if (this.self) return this.self.socket;
    const socket = channelSocket(() => ({
      readyState: 'open',
      send: (str) => { try { this._receive(null, str); } catch (err) { console.error('[P2P] 房主消息处理失败', err); } },
    }));
    queueMicrotask(() => { socket.readyState = 1; socket.onopen?.(); });
    this.self = { socket, member: null, send: (m) => this._sendTo(null, m) };
    return socket;
  }
  attachGuest(p2p) {
    p2p.onClose = () => this._dropGuest(p2p);
    const socket = p2p.socketReady();
    // 队友发来的字符串先进入房主的权威房间（CoopRoom），而不是直接交给本地客户端。
    socket.onmessage = (e) => { try { this._receive(p2p, e.data); } catch (err) { console.error('[P2P] 队友消息处理失败', err); } };
    this.peers.set(p2p, { p2p, socket, member: null, send: null });
  }
  _dropGuest(p2p) {
    const peer = this.peers.get(p2p);
    if (!peer) return;
    this.peers.delete(p2p);
    if (peer.member && this.room) this.room.disconnect(peer.member.id);
  }
  _sendTo(peer, msg) {
    const str = encode(msg);
    if (peer) peer.socket.send(str);
    else this.self?.socket.deliver(str);
  }
  _receive(p2p, str) {
    const msg = decode(str);
    const room = this.room;
    if (!room) return;
    const peer = p2p ? this.peers.get(p2p) : this.self;
    if (!peer) return;
    if (!peer.member) {
      if (msg.type !== 'hello') return;
      if (msg.version !== NET_VERSION || msg.build !== BUILD_ID) {
        if (p2p) { this._sendTo(peer, { type: 'error', message: '版本不一致，请双方刷新页面' }); p2p.close(); }
        return;
      }
      // 同一个 send 闭包必须贯穿 join/receive：CoopRoom 用它识别“同一条连接”。
      peer.send = (m) => this._sendTo(p2p ? peer : null, m);
      const uuid = (v) => (/^[a-f0-9-]{36}$/.test(v ?? '') ? v : null);
      try {
        peer.member = room.join(
          { id: uuid(msg.id) ?? crypto.randomUUID(), token: uuid(msg.token) ?? crypto.randomUUID(), name: cleanName(msg.name) },
          peer.send,
        );
      } catch (err) {
        // 房间已满 / 战局已开始 / 凭据失效：必须让队友看到原因，不能静默卡住。
        if (p2p) { this._sendTo(peer, { type: 'error', message: err.message }); p2p.close(); }
        else console.error('[P2P] 房主入房失败', err);
        return;
      }
      return;
    }
    room.receive(peer.member.id, msg, peer.send);
  }
  dispose() {
    if (this.timer) clearInterval(this.timer);
    this.timer = null;
    this.room?.dispose(); this.room = null;
    for (const peer of this.peers.keys()) peer.close();
    this.peers.clear();
  }
}
