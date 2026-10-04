import { CoopSimulation, normalizeKit } from './simulation.mjs';
import { NET_VERSION, BUILD_ID, MAX_PLAYERS, RECONNECT_MS, parseInput, cleanName } from '../src/net/protocol.js';

// 房主只管理集合出发，不承载战局计算；房主掉线不影响其他人的敌人、物品或撤离。
export class CoopRoom {
  constructor(code, options = {}) {
    this.code=code; this.members=new Map(); this.phase='lobby'; this.map='blackhouse';
    this.host=null; this.sim=null; this.raidId=null; this.now=options.now??(()=>Date.now());
    this.createSimulation=options.createSimulation??((...args)=>new CoopSimulation(...args));
    // Keep recent preparation dispositions so reconnect can recover by exact raid id.
    this.resolutions=new Map();
    this.expiresAt=this.now()+2*60*60*1000; this.prepareUntil=0;
  }
  join(session, send) {
    if(this.now()>this.expiresAt)throw new Error('房间已过期，请重新创建');
    let m=this.members.get(session.id);
    if(m) {
      if(m.token!==session.token)throw new Error('重连凭据无效');
      if(m.connected)throw new Error('这个会话已在另一个窗口连接');
      const recoveryRaid=session.recovery?.raidId;
      const exactRecovery=!!recoveryRaid&&(recoveryRaid===this.raidId||this.resolutions.has(recoveryRaid));
      if(m.disconnectedAt&&this.now()-m.disconnectedAt>RECONNECT_MS&&this.phase!=='lobby'
        &&!exactRecovery&&!this.sim?.members.get(m.id)?.outcome&&!m.outcome)throw new Error('重连保留时间已过');
    } else {
      const recovery=this.resolutions.get(session.recovery?.raidId);
      const owner=recovery?.members?.[session.id];
      if(owner && owner.token && owner.token!==session.token)throw new Error('重连凭据无效');
      if(this.phase!=='lobby')throw new Error('战局已经开始，暂不允许中途加入');
      if(this.members.size>=MAX_PLAYERS)throw new Error('房间已满（最多 4 人）');
      m={id:session.id,token:session.token,name:cleanName(session.name),ready:false,kit:normalizeKit(),committed:false,lastAction:0,seenActions:new Map()};
      this.members.set(m.id,m);
      this.host??=m.id;
    }
    m.connected=true;m.send=send;m.disconnectedAt=null;m.lastSeen=this.now();
    send({type:'welcome',id:m.id,token:m.token,code:this.code,version:NET_VERSION,build:BUILD_ID,seq:this.sim?.members.get(m.id)?.receivedSeq??0,actionId:m.lastAction});
    const recoveryRaid=session.recovery?.raidId;
    if(recoveryRaid){
      const resolution=this.resolutions.get(recoveryRaid);
      if(resolution?.members?.[m.id]) send({type:'raid-recovery',raidId:recoveryRaid,...resolution.members[m.id]});
      else if(this.phase==='aborted'&&this.raidId===recoveryRaid) send({type:'raid-recovery',raidId:recoveryRaid,status:'aborted',outcome:m.outcome??null,reason:'服务已重新启动；未完成战局不发战利品，带入装备退还'});
      else if(this.phase==='active'&&this.raidId===recoveryRaid) send({type:'raid-recovery',raidId:recoveryRaid,status:'active'});
    }
    this.broadcastLobby();
    if(this.phase==='active')send({type:'snapshot',data:this.sim.snapshot(m.id)});
    if(this.phase==='aborted')send({type:'aborted',outcome:m.outcome,reason:'服务已重新启动；未完成战局不发战利品，带入装备退还'});
    return m;
  }
  disconnect(id, connection = null) {
    const m=this.members.get(id);if(!m || (connection && m.send !== connection))return;
    m.connected=false;m.send=null;m.ready=false;m.disconnectedAt=this.now();
    this.sim?.disconnect(id);
    if(this.phase==='preparing')this.cancelPrepare('队友断线，出发已取消');
    if(this.host===id) this.host=[...this.members.values()].find(x=>x.connected)?.id??id;
    this.broadcastLobby();
  }
  send(id,msg) {const m=this.members.get(id);if(m?.connected)m.send?.(msg);}
  broadcast(msg) {for(const m of this.members.values())if(m.connected)m.send?.(msg);}
  lobby() {return {type:'room',code:this.code,map:this.map,phase:this.phase,host:this.host,raidId:this.raidId,
    members:[...this.members.values()].map(m=>({id:m.id,name:m.name,ready:m.ready,connected:m.connected,status:this.sim?.members.get(m.id)?.status??'lobby'}))};}
  broadcastLobby(){this.broadcast(this.lobby());}
  cancelPrepare(reason) {
    const canceledRaid=this.raidId;
    this.phase='lobby';this.prepareUntil=0;
    const members={};
    for(const m of this.members.values()) {
      members[m.id]={token:m.token,status:'cancelled',outcome:{raidId:canceledRaid,success:true,extracted:false,carriedLoot:[],returnedRiskItems:[],untrackedRiskIds:Array.isArray(m.kit?.risked)?[...m.kit.risked]:[],enemiesKilled:0,clearBonus:false},reason};
    }
    if(canceledRaid){
      this.resolutions.set(canceledRaid,{status:'cancelled',members});
      while(this.resolutions.size>8)this.resolutions.delete(this.resolutions.keys().next().value);
    }
    this.broadcast({type:'cancel-start',raidId:canceledRaid,reason});
    for(const m of this.members.values()){m.committed=false;m.ready=false;}
    this.broadcastLobby();
  }
  receive(id,msg,connection = null) {
    const m=this.members.get(id);if(!m?.connected||(connection && m.send !== connection)||!msg||typeof msg!=='object')return;
    m.lastSeen=this.now();
    if(msg.type==='ping'){this.send(id,{type:'pong',at:msg.at});return;}
    if(msg.type==='input'&&this.phase==='active') {const data=parseInput(msg.data);if(data)this.sim.input(id,data);return;}
    if(msg.type==='ready'&&this.phase==='lobby') {
      m.kit=normalizeKit(msg.kit);m.ready=!!msg.ready;this.broadcastLobby();return;
    }
    if(msg.type==='map'&&id===this.host&&this.phase==='lobby') {
      if(!['blackhouse','clinic','radio'].includes(msg.map))return;
      this.map=msg.map;for(const m of this.members.values())m.ready=false;
      this.broadcastLobby();return;
    }
    if(msg.type==='start'&&id===this.host&&this.phase==='lobby') {
      const members=[...this.members.values()];
      if(members.length<2||members.some(m=>!m.connected||!m.ready)){this.send(id,{type:'error',message:'至少 2 人加入并全部准备后才能出发'});return;}
      this.phase='preparing';this.raidId=crypto.randomUUID();this.prepareUntil=this.now()+20_000;
      this.broadcast({type:'prepare',raidId:this.raidId,map:this.map});this.broadcastLobby();return;
    }
    if(msg.type==='commit'&&this.phase==='preparing'&&msg.raidId===this.raidId) {
      if(!msg.ok){this.cancelPrepare('队友存档无法写入，本次出发取消');return;}
      m.committed=true;
      if([...this.members.values()].every(m=>m.committed&&m.connected)) {
        try {this.sim=this.createSimulation(this.map,[...this.members.values()],this.raidId);this.phase='active';}
        catch(err){this.cancelPrepare('关卡初始化失败，本次出发取消');return;}
        this.broadcast({type:'started',raidId:this.raidId});this.broadcastLobby();this.snapshots();
      }
      return;
    }
    if(msg.type==='leave') {
      if(this.phase==='active') {this.sim.abandon(id);this.send(id,{type:'snapshot',data:this.sim.snapshot(id)});}
      else {
        if(this.phase==='preparing')this.cancelPrepare('队友离开，本次出发取消');
        this.send(id,{type:'left'});this.members.delete(id);if(this.host===id)this.host=[...this.members.keys()][0]??null;this.broadcastLobby();
      }
      return;
    }
    if(msg.type==='action'&&this.phase==='active') {
      const a=msg.action;
      if(!Number.isSafeInteger(msg.id)||msg.id<1||!a||typeof a!=='object')return;
      if(m.seenActions.has(msg.id)){this.send(id,m.seenActions.get(msg.id));return;}
      if(msg.id<=m.lastAction){this.send(id,{type:'action-result',id:msg.id,result:{ok:false,reason:'操作已过期'}});return;}
      m.lastAction=msg.id;
      let result;try{result=this.sim.action(id,a);}catch{result={ok:false,reason:'操作被拒绝'};}
      const reply={type:'action-result',id:msg.id,result};m.seenActions.set(msg.id,reply);
      if(m.seenActions.size>64)m.seenActions.delete(m.seenActions.keys().next().value);
      this.send(id,reply);this.snapshots();
    }
  }
  advance(dt) {
    const now=this.now();
    for(const m of [...this.members.values()]) {
      if(m.connected&&now-m.lastSeen>90000){this.disconnect(m.id);continue;}
      if(!m.connected&&m.disconnectedAt&&now-m.disconnectedAt>RECONNECT_MS){
        if(this.phase==='active')this.sim.abandon(m.id);
        // lobby 成员保留到房间过期：取消准备的 raidId 处置记录仍需可恢复，
        // 且保留原 token 才能证明是同一浏览器会话。房间容量由成员总数限制，
        // 过期房间统一清理，不在这里把可恢复身份变成“新玩家”。
      }
    }
    if(this.phase==='preparing'&&now>this.prepareUntil)this.cancelPrepare('等待队友超时，本次出发取消');
    if(this.phase==='active'&&this.sim.active)this.sim.step(dt);
  }
  snapshots(){if(this.phase==='active')for(const m of this.members.values())this.send(m.id,{type:'snapshot',data:this.sim.snapshot(m.id)});}
  checkpoint() {
    // 战局进程故障不重建旧掉落：恢复成终止状态，避免重复发货；已结算者保留终态。
    return {code:this.code,map:this.map,phase:this.phase,host:this.host,raidId:this.raidId,expiresAt:this.expiresAt,
      resolutions:[...this.resolutions.entries()],
      members:[...this.members.values()].map(m=>({id:m.id,token:m.token,name:m.name,kit:m.kit,outcome:this.sim?.members.get(m.id)?.outcome??m.outcome??null}))};
  }
  restore(saved) {
    this.map=saved.map;this.host=saved.host;this.raidId=saved.raidId;this.expiresAt=saved.expiresAt;
    this.resolutions=new Map(Array.isArray(saved.resolutions)?saved.resolutions:[]);
    this.phase=['active','preparing','aborted'].includes(saved.phase)?'aborted':'lobby';
    for(const m of saved.members)this.members.set(m.id,{...m,connected:false,ready:false,committed:false,lastAction:0,seenActions:new Map()});
  }
  dispose(){this.sim?.dispose();}
}
