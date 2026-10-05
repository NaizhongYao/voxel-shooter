import { NET_VERSION, BUILD_ID, encode, decode, validCode } from './protocol.js';
import { COOP_SERVER_URL } from './config.js';
import { netLog } from './diagnostics.js';

function sessionStore(){try{return globalThis.sessionStorage;}catch{return null;}}

export function serverURL(locationLike = location) {
  const host=locationLike.hostname;
  const local=['localhost','127.0.0.1','::1','[::1]'].includes(host);
  // 局域网/本机：直接连当前页面主机的同端口后端（server/local.mjs 同时提供网页与 WebSocket），
  // 不依赖公网服务，也不受 Cloudflare 线路影响。
  const lan=/^(192\.168\.\d{1,3}\.\d{1,3}|10\.\d{1,3}\.\d{1,3}\.\d{1,3}|172\.(1[6-9]|2\d|3[01])\.\d{1,3}\.\d{1,3})$/.test(host);
  const ipv6=/^\[?(?:fd|fc|fe80:)[a-f\d:]+\]?$/i.test(host);
  if(local||lan||ipv6||host.endsWith('.local')){
    // 网页由本机后端提供时端口相同（默认 8787）；静态开发服务器 8765 例外，后端固定在 8787。
    const port=locationLike.port&&locationLike.port!=='8765'?locationLike.port:'8787';
    const address=host.includes(':')&&!host.startsWith('[')?`[${host}]`:host;
    return `${locationLike.protocol}//${address}:${port}`;
  }
  return COOP_SERVER_URL;
}
export class CoopClient {
  constructor({endpoint=serverURL(),storage=sessionStore(),onMessage=()=>{},onStatus=()=>{},getRecovery=()=>null,dial=null}={}) {
    this.endpoint=(endpoint??'').replace(/\/$/,'');this.storage=storage;this.getRecovery=getRecovery;this.onMessage=onMessage;this.onStatus=onStatus;
    // dial：P2P 直连时由外部提供一个 WebSocket 形状的数据通道；为 null 时按普通 WebSocket 连服务器。
    this.dial=dial;
    this.ws=null;this.credentials=null;this.room=null;this.seq=0;this.actionId=0;this.pending=new Map();
    this.rtt=0;this.lastMessage=0;this.retries=0;this.stopped=true;this.connected=false;this.timer=null;this.heartbeat=null;
  }
  async create(name) {
    if(!this.endpoint)throw new Error('联机服务尚未部署，当前仍可玩单人模式');
    const controller=new AbortController();const timer=setTimeout(()=>controller.abort(),8000);
    let r;
    try{r=await fetch(`${this.endpoint}/rooms`,{method:'POST',signal:controller.signal});}
    catch(err){netLog('create-failed',{message:err.message});throw new Error(controller.signal.aborted?'创建房间超时（8 秒），请检查开服窗口是否仍在运行':'无法访问房间服务：请从开服窗口显示的局域网网址打开整个游戏，不要从 HTTPS 网页直连 HTTP 服务');}
    finally{clearTimeout(timer);}
    if(!r.ok)throw new Error('暂时无法创建房间，请稍后重试');
    const data=await r.json();
    // 本机后端会附带局域网地址：从 localhost 建房时，邀请链接必须用它，否则队友点开连的是自己的电脑。
    this.lanHost=data.lan||null;this.lanAddresses=data.lanAddresses??[];
    return this.join(data.code,name);
  }
  join(code,name) {
    if(!this.endpoint&&!this.dial)throw new Error('联机服务尚未部署');
    code=String(code).trim().toUpperCase();if(!validCode(code))throw new Error('请输入 6 位房间码');
    this.stop(false);this.room=null;this.stopped=false;this.code=code;this.name=name;this.retries=0;
    let saved;try{saved=JSON.parse(this.storage?.getItem('pc.coop.session')||'null');}catch{}
    // P2P：刷新恢复做不到（信令一次性），但同一页面内重新加入同一房间要沿用旧凭据，才能拿回原座位而不是变成两个人。
    this.credentials=this.dial
      ? (this.credentials?.code===code?this.credentials:null)
      : (saved?.code===code&&saved.endpoint===this.endpoint?saved:null);
    if(!this.credentials){this.seq=0;this.actionId=0;}
    return new Promise((resolve,reject)=>{this.joinResolve=resolve;this.joinReject=reject;this.connect();});
  }
  connect() {
    if(this.stopped)return;
    this.onStatus(this.retries?'reconnecting':'connecting');
    netLog('client-connect',{transport:this.dial?'p2p':'websocket',attempt:this.retries});
    let ws;
    try{
    if(this.dial){ws=this.dial();}
    else {
      const url=new URL(`${this.endpoint}/rooms/${this.code}/ws`);url.protocol=url.protocol==='https:'?'wss:':'ws:';
      ws=new WebSocket(url);
    }
    }catch(err){this.stopped=true;this.onStatus('failed');this.joinReject?.(err);this.joinReject=null;return;}
    this.ws=ws;
    const timeout=setTimeout(()=>{
      if(ws!==this.ws||this.connected)return;
      const error=new Error('房间握手超时（12 秒）：通道打开但未收到房间确认，请重试或使用备用方式');
      netLog('hello-timeout');this.joinReject?.(error);this.joinReject=null;this.joinResolve=null;this.stopped=true;this.onStatus('failed');
      this.onMessage({type:'error',message:error.message});ws.close();
    },12000);
    this.handshakeTimer=timeout;
    let helloSent=false;
    ws.onopen=()=>{if(helloSent||ws!==this.ws||this.stopped)return;helloSent=true;netLog('hello-sent');this.send({type:'hello',version:NET_VERSION,build:BUILD_ID,name:this.name,id:this.credentials?.id,token:this.credentials?.token,recovery:this.getRecovery?.()??undefined});};
    if(ws.readyState===1)queueMicrotask(()=>ws.onopen?.());

    ws.onmessage=(event)=>{
      if(ws!==this.ws)return;
      let msg;try{msg=decode(event.data);}catch{return;}
      this.lastMessage=performance.now();
      if(msg.type==='welcome'){
        clearTimeout(timeout);this.connected=true;this.retries=0;this.seq=Math.max(this.seq,msg.seq??0);this.actionId=Math.max(this.actionId,msg.actionId??0);
        this.credentials={id:msg.id,token:msg.token,code:msg.code,endpoint:this.endpoint,name:this.name};
        netLog('welcome');
        try{if(!this.dial)this.storage?.setItem('pc.coop.session',JSON.stringify(this.credentials));}catch{netLog('session-storage-unavailable');}
        this.onStatus('connected');this.joinResolve?.(msg);this.joinResolve=null;this.joinReject=null;
        clearInterval(this.heartbeat);this.heartbeat=setInterval(()=>{
          if(performance.now()-this.lastMessage>75000){ws.close();return;}
          this.send({type:'ping',at:performance.now()});
        },3000);
      }
      if(msg.type==='room')this.room=msg;
      if(msg.type==='pong')this.rtt=Math.round(performance.now()-msg.at);
      if(msg.type==='action-result'){
        const p=this.pending.get(msg.id);if(p){clearTimeout(p.timer);p.resolve(msg.result);this.pending.delete(msg.id);}
      }
      if(msg.type==='error'&&!this.connected){clearTimeout(timeout);this.stopped=true;this.joinReject?.(new Error(msg.message));this.joinReject=null;this.joinResolve=null;this.onStatus('failed');}
      try{this.onMessage(msg);}catch(err){console.error('[Coop] State update failed',err);this.onStatus('failed');ws.close();}
    };
    ws.onclose=(event)=>{
      clearTimeout(timeout);if(ws!==this.ws)return;
      netLog('client-close',{code:event.code});this.connected=false;clearInterval(this.heartbeat);
      for(const p of this.pending.values()){clearTimeout(p.timer);p.resolve({ok:false,reason:'连接中断，正在重新同步'});}this.pending.clear();
      if(this.stopped)return;
      // P2P 通道断开无法自动重连（信令一次性），直接进入失败态，由玩家重新建房/加入。
      if(this.dial){this.stopped=true;this.onStatus('failed');this.joinReject?.(new Error('直连已断开，请重新建房或加入'));this.joinReject=null;return;}
      if(event.code===1008||event.code===1009||++this.retries>20){
        this.stopped=true;this.onStatus('failed');this.joinReject?.(new Error('无法连接房间：房间可能已满、已过期或版本不同'));return;
      }
      this.onStatus('reconnecting');this.timer=setTimeout(()=>this.connect(),Math.min(3000,400*this.retries));
    };
    ws.onerror=()=>{};
  }
  send(msg){if(this.ws?.readyState===1&&this.ws.bufferedAmount<128000){try{this.ws.send(encode(msg));return true;}catch(err){netLog('send-failed',{message:err.message});}}return false;}
  input(data){this.send({type:'input',data:{...data,seq:++this.seq}});}
  action(action){
    if(!this.connected)return Promise.resolve({ok:false,reason:'连接中断，等待重连后重试'});
    const id=++this.actionId;
    return new Promise(resolve=>{
      const timer=setTimeout(()=>{this.pending.delete(id);resolve({ok:false,reason:'操作确认超时，正在等待同步'});},8000);
      this.pending.set(id,{resolve,timer});this.send({type:'action',id,action});
    });
  }
  stop(clear=true){
    this.stopped=true;this.connected=false;clearTimeout(this.timer);clearTimeout(this.handshakeTimer);clearInterval(this.heartbeat);
    this.joinReject?.(new Error('连接已取消'));this.joinReject=null;this.joinResolve=null;
    if(this.ws){this.ws.onclose=null;this.ws.close();this.ws=null;}
    for(const p of this.pending.values()){clearTimeout(p.timer);p.resolve({ok:false,reason:'已离开房间'});}this.pending.clear();
    try{if(clear)this.storage?.removeItem('pc.coop.session');}catch{}
  }
}
