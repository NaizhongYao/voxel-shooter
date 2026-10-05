import { encode, decode, BUILD_ID, NET_VERSION, MAX_MESSAGE_BYTES, roomCode, cleanName, validCode, randomId } from './protocol.js';
import { netLog } from './diagnostics.js';
import { CoopRoom } from '../../server/room.mjs';
import { CoopSimulation } from '../../server/simulation.mjs';

// 点对点直连（局域网内可用，不需要任何服务器）：页面仍从静态站点加载，
// 战局数据直接在两个浏览器之间走 WebRTC 数据通道。
// 代价是必须交换一次信令（邀请码/回答码）——这是无服务器架构的数学下限，
// 做成“复制链接发微信”即可，不需要任何技术操作。

const SIGNAL_VERSION = 2;
const SIGNAL_MAX = 131072;
const CONNECT_MS = 25000;
const SIGNAL_TTL = 10 * 60 * 1000;

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
  const raw = String(text ?? '').trim().replace(/[\s\u200B-\u200D\uFEFF]/g, '');
  if(raw.length>SIGNAL_MAX)throw new Error('邀请内容过长，请重新复制完整邀请码');
  const tail = raw.includes('#') ? raw.slice(raw.lastIndexOf('#') + 1) : raw;
  const body = /^[oa]=/.test(tail) ? tail.slice(2) : tail;
  let data;
  try { data = JSON.parse(b64d(body)); } catch { throw new Error('邀请码无法识别，请重新复制完整内容'); }
  if (data?.v !== SIGNAL_VERSION) throw new Error('邀请码版本不一致，请双方都刷新页面');
  if (data.build !== BUILD_ID) throw new Error('双方游戏版本不一致，请都刷新页面后重试');
  if (!validCode(data.code)) throw new Error('房间码无效，请房主重新生成邀请');
  if (typeof data.sdp !== 'string' || !data.sdp.includes('m=application')) throw new Error('邀请码不完整，请重新复制');
  if (data.type!==undefined && !['offer','answer'].includes(data.type)) throw new Error('信令类型无效');
  if (data.map!==undefined && !['blackhouse','clinic','radio'].includes(data.map)) throw new Error('邀请中的地图无效');
  if (data.id!==undefined && !/^[a-f0-9-]{36}$/.test(data.id)) throw new Error('邀请标识无效');
  if (data.expiresAt != null && (!Number.isFinite(data.expiresAt) || Date.now()>data.expiresAt)) throw new Error('邀请已过期，请房主重新生成邀请');
  return data;
}

export function waitIce(pc, timeoutMs=10000) {
  return new Promise((resolve,reject) => {
    let timer;
    const finish = (error) => { clearTimeout(timer); pc.removeEventListener('icegatheringstatechange',changed); pc.removeEventListener('signalingstatechange',changed); error?reject(error):resolve(); };
    const changed = () => {
      if(pc.signalingState==='closed')finish(new Error('连接已取消，请重新生成邀请'));
      else if(pc.iceGatheringState==='complete'){
        if(!/^a=candidate:/m.test(pc.localDescription?.sdp??''))finish(new Error('浏览器没有提供局域网候选地址：请检查本地网络权限，或使用局域网服务器备用方式'));
        else {const candidates=(pc.localDescription?.sdp??'').split('\n').filter(line=>line.startsWith('a=candidate:'));netLog('ice-complete',{count:candidates.length,types:[...new Set(candidates.map(line=>line.match(/ typ (\w+)/)?.[1]).filter(Boolean))],mdns:candidates.some(line=>line.includes('.local'))});finish();}
      }
    };
    pc.addEventListener('icegatheringstatechange',changed); pc.addEventListener('signalingstatechange',changed);
    timer=setTimeout(()=>finish(new Error('收集网络地址超时（10 秒）：请重试或使用局域网服务器备用方式')),timeoutMs);
    changed();
  });
}

export function rtcStep(operation, label, timeoutMs=10000) {
  return new Promise((resolve,reject)=>{
    const timer=setTimeout(()=>reject(new Error(`${label}超时（10 秒），请重试或使用备用方式`)),timeoutMs);
    Promise.resolve(operation).then(value=>{clearTimeout(timer);resolve(value);},error=>{
      clearTimeout(timer);reject(new Error(`${label}失败（${error?.name??'RTCError'}）：请使用最新邀请、允许本地网络权限，或使用备用方式`));
    });
  });
}

/**
 * 把 RTCDataChannel 包装成 CoopClient 认得的 WebSocket 形状。
 * deliver(str) 由 P2P 层在收到网络消息时调用；send 直接写通道。
 */
export function channelSocket(getChannel) {
  const s = {
    readyState: 0,
    get bufferedAmount() { return getChannel()?.bufferedAmount??0; },
    onopen: null, onmessage: null, onclose: null, onerror: null,
    deliver(str) { s.onmessage?.({ data: str }); },
    send(str) { const ch = getChannel(); if (ch?.readyState === 'open') ch.send(str); },
    close() { try { getChannel()?.close(); } catch { /* 已断开 */ } if(s.readyState!==3){s.readyState=3;s.onclose?.({code:1000});} },
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
  constructor({ onOpen, onClose, onState=()=>{}, onFailure=()=>{}, connectMs=CONNECT_MS } = {}) {
    this.onState=onState;this.onFailure=onFailure;this.connectMs=connectMs;this.connectTimer=null;this.expireTimer=null;this.progressTimer=null;
    this.id=null;this.code=null;this.waiters=[];this.error=null;this.stage='idle';
    this.onOpen = onOpen; this.onClose = onClose;
    this.pc = null; this.channel = null; this.socket = null; this.closed = false; this.openedFired = false;
  }
  _pc() {
    if (this.pc) return this.pc;
    this.pc = new RTCPeerConnection({ iceServers: [] }); // 局域网直连：不需要 STUN/TURN，也不碰被墙的公网探测
    this.socket = channelSocket(() => this.channel);
    this.socket.__opened = () => {
      if(this.closed||this.openedFired)return;
      this.openedFired=true;this._clearTimers();this._state('open');
      for(const w of this.waiters.splice(0))w.resolve();
      this.onOpen?.();
      void this.pc.getStats().then(stats=>{
        const pairs=[...stats.values()].filter(s=>s.type==='candidate-pair'&&s.state==='succeeded');
        netLog('p2p-path',{paths:pairs.map(s=>({rttMs:Math.round((s.currentRoundTripTime??0)*1000),nominated:!!s.nominated}))});
      }).catch(()=>{});
    };
    const changed=()=>{
      netLog('p2p-state',{connection:this.pc.connectionState,ice:this.pc.iceConnectionState,gathering:this.pc.iceGatheringState});
      if(this.closed)return;
      if(this.pc.connectionState==='failed'||this.pc.iceConnectionState==='failed')this._fail('网络未能建立直连：可重新交换邀请，或使用局域网服务器备用方式');
      else if(this.pc.connectionState==='disconnected'||this.pc.iceConnectionState==='disconnected'){
        this._state('disconnected');this._watch(this.connectMs);
      }else if(this.openedFired&&(this.pc.connectionState==='connected'||this.pc.iceConnectionState==='connected')){this._clearTimers();this._state('open');}
    };
    this.pc.onconnectionstatechange=changed;this.pc.oniceconnectionstatechange=changed;
    return this.pc;
  }
  _state(stage) { this.stage=stage;netLog('p2p-step',{stage});this.onState(stage); }
  _clearTimers(){clearTimeout(this.connectTimer);clearTimeout(this.expireTimer);clearTimeout(this.progressTimer);this.connectTimer=null;}
  _watch(ms){
    if(this.connectTimer||this.closed||(this.openedFired&&this.stage!=='disconnected'))return;
    this.connectTimer=setTimeout(()=>this._fail(this.openedFired?'直连中断超过 25 秒，请重新交换邀请恢复原座位':'直连超时（25 秒）：回答已收到，但设备间网络没有接通。请重试，或使用局域网服务器备用方式'),ms);
    this.progressTimer=setTimeout(()=>{if(!this.closed)this._state('slow');},8000);
  }
  _fail(message){
    if(this.closed)return;
    this.error=new Error(message);netLog('p2p-failure',{message});this._state('failed');this.close();this.onFailure(this.error);
  }
  _bind(ch) {
    this.channel=ch;bindChannel(ch,this.socket);
    ch.addEventListener('close',()=>{if(!this.closed)this._fail('数据通道已关闭：请重新交换邀请，或使用备用方式');});
    ch.addEventListener('error',()=>{if(!this.closed)this._fail('数据通道发生错误：请重新交换邀请，或使用备用方式');});
  }
  socketReady(){return this.socket;}
  waitConnected(){
    if(this.closed)return Promise.reject(this.error??new Error('这条邀请已关闭，请生成新邀请'));
    if(this.openedFired)return Promise.resolve();
    return new Promise((resolve,reject)=>this.waiters.push({resolve,reject}));
  }
  async createInvite(code,map='blackhouse'){
    if(!validCode(code))throw new Error('房间码无效');
    this.code=code;this.id=randomId();this.expiresAt=Date.now()+SIGNAL_TTL;this._state('gathering');
    const pc=this._pc();this._bind(pc.createDataChannel('coop',{ordered:true}));
    try{
      const offer=await rtcStep(pc.createOffer(),'创建邀请');await rtcStep(pc.setLocalDescription(offer),'保存邀请');await waitIce(pc);
      this._state('waiting-answer');this.expireTimer=setTimeout(()=>this._fail('邀请已过期（10 分钟），请重新生成邀请'),SIGNAL_TTL);
      return encodeSignal({code,map,id:this.id,type:'offer',expiresAt:this.expiresAt,sdp:pc.localDescription.sdp});
    }catch(err){this.close();throw err;}
  }
  async acceptInvite(invite){
    const data=decodeSignal(invite);
    if(data.type!=='offer'||typeof data.id!=='string'||!Number.isFinite(data.expiresAt))throw new Error('这里需要房主的邀请码，不是回答码');
    this.code=data.code;this.id=data.id;this.expiresAt=data.expiresAt;this._state('gathering');
    const pc=this._pc();pc.ondatachannel=e=>this._bind(e.channel);
    try{
      await rtcStep(pc.setRemoteDescription({type:'offer',sdp:data.sdp}),'解析邀请');const answer=await rtcStep(pc.createAnswer(),'创建回答');await rtcStep(pc.setLocalDescription(answer),'保存回答');await waitIce(pc);
      this._state('waiting-host');this.expireTimer=setTimeout(()=>this._fail('等待房主超过 90 秒：确认已把回答发回，且房主点了「完成连接」。请重新交换最新邀请和回答'),Math.min(90000,Math.max(1,this.expiresAt-Date.now())));
      return {code:data.code,answer:encodeSignal({code:data.code,id:data.id,type:'answer',expiresAt:this.expiresAt,sdp:pc.localDescription.sdp})};
    }catch(err){this.close();throw err;}
  }
  async acceptAnswer(answer){
    const data=decodeSignal(answer);
    if(data.type!=='answer')throw new Error('请粘贴队友的回答码，不是房主的邀请码');
    if(data.code!==this.code||data.id!==this.id)throw new Error('回答与此邀请不匹配，请使用对应邀请的回答');
    if(this.closed||!this.pc)throw new Error('这条邀请已关闭，请生成新邀请');
    if(this.pc.signalingState!=='have-local-offer')throw new Error('这条回答已经使用，请等待连接结果');
    this._clearTimers();this._state('connecting');
    try{await rtcStep(this.pc.setRemoteDescription({type:'answer',sdp:data.sdp}),'解析回答');this._watch(this.connectMs);}catch(err){this._fail(err.message);throw err;}
    return data.code;
  }
  close(){
    if(this.closed)return;
    this.closed=true;this._clearTimers();
    for(const w of this.waiters.splice(0))w.reject(this.error??new Error('连接已取消'));
    try{this.channel?.close();}catch{}
    try{this.pc?.close();}catch{}
    this.socket?.close();this.onClose?.();
  }
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
    if (this.self?.socket.readyState!==3&&this.self) return this.self.socket;
    if(this.self?.member)this.room.disconnect(this.self.member.id,this.self.send);
    const socket = channelSocket(() => ({
      readyState: 'open',
      send: (str) => { try { this._receive(null, str); } catch (err) { console.error('[P2P] 房主消息处理失败', err); } },
    }));
    queueMicrotask(() => { socket.readyState = 1; socket.onopen?.(); });
    this.self = { socket, member: null, send: (m) => this._sendTo(null, m) };
    const originalClose=socket.close;
    socket.close=()=>{if(this.self?.member)this.room?.disconnect(this.self.member.id,this.self.send);originalClose();};
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
    if (peer.member && this.room) this.room.disconnect(peer.member.id,peer.send);
  }
  _sendTo(peer, msg) {
    const str = encode(msg);
    if (peer) {
      if(peer.socket.bufferedAmount>512000)return;
      try{peer.socket.send(str);}catch{peer.p2p.close();}
    } else this.self?.socket.deliver(str);
  }
  _receive(p2p, str) {
    if(typeof str!=='string'||str.length>MAX_MESSAGE_BYTES)return;
    const msg = decode(str);
    const room = this.room;
    if (!room) return;
    const peer = p2p ? this.peers.get(p2p) : this.self;
    if (!peer) return;
    if (!peer.member) {
      if (msg.type !== 'hello') return;
      if (msg.version !== NET_VERSION || msg.build !== BUILD_ID) {
        if (p2p) { this._sendTo(peer, { type: 'error', message: '版本不一致，请双方刷新页面' }); setTimeout(()=>p2p.close(),100); }
        return;
      }
      // 同一个 send 闭包必须贯穿 join/receive：CoopRoom 用它识别“同一条连接”。
      peer.send = (m) => this._sendTo(p2p ? peer : null, m);
      const uuid = (v) => (/^[a-f0-9-]{36}$/.test(v ?? '') ? v : null);
      try {
        peer.member = room.join(
          { id: uuid(msg.id) ?? randomId(), token: uuid(msg.token) ?? randomId(), name: cleanName(msg.name), recovery:msg.recovery }, 
          peer.send,
        );
      } catch (err) {
        // 房间已满 / 战局已开始 / 凭据失效：必须让队友看到原因，不能静默卡住。
        if (p2p) { this._sendTo(peer, { type: 'error', message: err.message }); setTimeout(()=>p2p.close(),100); }
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
    this.peers.clear();this.self?.socket.close();this.self=null;this.code=null;
  }
}
