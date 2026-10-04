import { CoopP2P, P2PHost, p2pAvailable } from '../net/p2p.js';

const escape = (s) => String(s??'').replaceAll('&','&amp;').replaceAll('<','&lt;').replaceAll('"','&quot;');
export class CoopLobby {
  constructor(client,{onReady,onLeave,onMap,onOpenKit}={}) {
    this.client=client;this.callbacks={onReady,onLeave,onMap,onOpenKit};this.status='offline';this.room=null;
    this.root=document.createElement('section');this.root.className='coop-lobby';
    this.root.setAttribute('aria-label','好友合作');
    this.root.innerHTML=`<header><span class="coop-kicker">SQUAD LINK / 好友合作</span><h2>一起进去，一起回来。</h2><p>2–4 人合作 · 分享房间码即可加入 · 无账号 · 无队友伤害</p></header>
      <div class="coop-connect"><label>呼号<input class="coop-name" maxlength="16" value="行动员" autocomplete="nickname"></label>
      <button type="button" data-coop="create">创建房间</button><label>房间码<input class="coop-code" maxlength="6" placeholder="6 位房间码" autocapitalize="characters" autocomplete="off"></label><button type="button" data-coop="join">加入好友</button></div>
      <div class="coop-p2p"><div class="coop-p2p-head"><b>局域网直连</b><span>不用服务器 · 同一 WiFi 可用 · 国内无 VPN 也能连</span></div>
        <div class="coop-p2p-row">
          <button type="button" class="primary" data-coop="p2p-host">创建直连房间</button>
          <button type="button" data-coop="p2p-join">我有邀请码</button>
        </div>
        <div class="coop-p2p-box invite" hidden><label>把这条邀请链接发给队友（微信直接发）：<textarea class="p2p-invite" readonly rows="2"></textarea></label>
          <button type="button" data-coop="p2p-copy-invite">复制邀请链接</button></div>
        <div class="coop-p2p-box answer" hidden><label>队友把「回答码」发回来后，粘贴到这里：<textarea class="p2p-answer" rows="2" placeholder="粘贴队友发回的内容"></textarea></label>
          <button type="button" class="primary" data-coop="p2p-accept">完成连接</button></div>
        <div class="coop-p2p-box join" hidden><label>粘贴房主发来的邀请（链接或邀请码）：<textarea class="p2p-invite-in" rows="2" placeholder="粘贴邀请链接"></textarea></label>
          <button type="button" class="primary" data-coop="p2p-gen">生成回答码</button></div>
        <div class="coop-p2p-box reply" hidden><label>把这条「回答」发回给房主：<textarea class="p2p-answer-out" readonly rows="2"></textarea></label>
          <button type="button" data-coop="p2p-copy-answer">复制回答</button></div>
      </div>
      <p class="coop-message" role="status" aria-live="polite">单人模式保持不变。创建房间或输入好友的房间码。</p>
      <div class="coop-room" hidden></div>`;
    this.name=this.root.querySelector('.coop-name');this.code=this.root.querySelector('.coop-code');
    this.message=this.root.querySelector('.coop-message');this.roomEl=this.root.querySelector('.coop-room');
    this.p2pHost=new P2PHost();this.p2pConn=null;this.p2pCode=null;
    this.root.addEventListener('click',async(event)=>{
      const a=event.target.closest('[data-coop]')?.dataset.coop;if(!a)return;
      try {
        if(a==='create'||a==='join'){
          this.showMessage('正在连接房间服务…');this.root.blur?.();
          if(a==='create')await client.create(this.name.value);else await client.join(this.code.value,this.name.value);
        }else if(a==='copy'){
          const url=new URL(location.href);url.searchParams.set('room',this.room.code);url.searchParams.set('map',this.room.map);
          // 本机开服时房主常用 localhost 打开：邀请链接换成局域网地址，队友才连得到。
          const loopback=['localhost','127.0.0.1','::1','[::1]'].includes(location.hostname);
          if(loopback&&client.lanHost)url.hostname=client.lanHost;
          try {await navigator.clipboard.writeText(url.href);this.showMessage(`邀请链接已复制：${url.href}`);}
          catch {this.showMessage(`房间码 ${this.room.code} · 让队友打开 ${url.origin} 后输入房间码`);}
        }else if(a==='p2p-host')await this.p2pHostStart();
        else if(a==='p2p-join'){this._box('join');this.showMessage('把房主发来的邀请链接粘贴到下面，再点「生成回答码」。');}
        else if(a==='p2p-accept')await this.p2pHostAccept(this.root.querySelector('.p2p-answer').value);
        else if(a==='p2p-gen'||a==='p2p-copy-invite'||a==='p2p-copy-answer'){
          const field={ 'p2p-gen':'p2p-invite-in','p2p-copy-invite':'p2p-invite','p2p-copy-answer':'p2p-answer-out' }[a];
          const value=this.root.querySelector(`.${field}`).value;
          if(a==='p2p-gen')await this.p2pGuestStart(value);
          else try {await navigator.clipboard.writeText(value);this.showMessage('已复制，发给对方即可');}
          catch {this.showMessage('浏览器未允许复制：请全选文本框内容手动复制');}
        }else if(a==='ready')this.callbacks.onReady?.();
        else if(a==='start'){client.send({type:'start'});this.showMessage('正在确认全员存档并部署战局…');}
        else if(a==='leave')this.callbacks.onLeave?.();
        else if(a==='kit')this.callbacks.onOpenKit?.();
      }catch(err){this.showMessage(err.message||'连接失败，请检查网络');}
    });
    this.root.addEventListener('change',e=>{if(e.target.matches('.coop-map'))this.callbacks.onMap?.(e.target.value);});
    document.querySelector('#missions-page')?.prepend(this.root);
    // 静态站点（GitHub Pages）：云端后端在国内不可达，只呈现直连模式；本机/局域网页面两种都能用。
    const serverUsable=!!client.endpoint&&!/(^|\.)github\.io$/.test(location.hostname);
    if(!serverUsable){
      this.root.querySelector('.coop-connect').hidden=true;
      if(!p2pAvailable())this.showMessage('当前浏览器不支持直连（WebRTC），请用 Chrome/Edge 打开。');
      else this.showMessage('点「创建直连房间」，把邀请链接发给队友（同一 WiFi）。');
    }
    this._hashFlow();
    this.hud=document.createElement('aside');this.hud.className='coop-hud';this.hud.hidden=true;
    document.querySelector('#ui')?.append(this.hud);
  }
  _box(name,show=true){const el=this.root.querySelector(`.coop-p2p-box.${name}`);el.hidden=!show;return el;}
  /** 房主：生成邀请链接。 */
  async p2pHostStart(){
    this.trace('host-start');
    if(!p2pAvailable())throw new Error('当前浏览器不支持直连（WebRTC）');
    this.client.stop(false); // 直连与服务器模式互斥，先收掉旧连接
    this.p2pCode=this.p2pHost.ensureRoom();
    this.p2pRole='host';
    this.p2pConn=new CoopP2P({onOpen:()=>this._p2pConnected()});
    const invite=await this.p2pConn.createInvite(this.p2pCode);
    this.p2pHost.attachGuest(this.p2pConn);
    const link=`${location.origin}${location.pathname}?map=${this.p2pHost.room.map}#o=${invite}`;
    this.root.querySelector('.p2p-invite').value=link;
    this._box('invite');this._box('answer');
    this.showMessage('把邀请链接发给队友；他点开后会把「回答」发回来，粘贴到下面即可。');
    try {await navigator.clipboard.writeText(link);this.showMessage('邀请链接已复制：直接发给队友（微信可发）');} catch { /* 让玩家手动复制 */ }
  }
  /** 队友：用邀请生成回答。 */
  async p2pGuestStart(invite){
    this.trace('guest-start');
    if(!p2pAvailable())throw new Error('当前浏览器不支持直连（WebRTC）');
    if(!String(invite??'').trim())throw new Error('先粘贴房主的邀请链接，或点「创建直连房间」当房主');
    this.client.stop(false);
    this.p2pRole='guest';
    this.p2pConn=new CoopP2P({onOpen:()=>this._p2pConnected()});
    const {code,answer}=await this.p2pConn.acceptInvite(invite); // 生成回答；通道在房主粘贴回答后才打开
    this.trace('guest-answer-ready');
    this.p2pCode=code;
    this.root.querySelector('.p2p-answer-out').value=answer;
    this._box('reply');
    this.showMessage('把「回答」发回给房主（复制后微信发过去）。你这边不用再操作，连上会自动进入房间。');
    try {await navigator.clipboard.writeText(answer);this.showMessage('回答已复制：发回给房主，连上后自动进入房间');} catch { /* 让玩家手动复制 */ }
  }
  /** 房主：粘贴回答并完成连接。 */
  async p2pHostAccept(answer){
    this.trace('host-accept',String(answer??'').length);
    if(!this.p2pConn)throw new Error('先点「创建直连房间」');
    if(!String(answer??'').trim())throw new Error('把队友发回的「回答」粘贴进来');
    this.showMessage('正在建立直连…');
    await this.p2pConn.acceptAnswer(answer);
    this._box('answer',false);
  }
  /** P2P 通道已打开（双方都会走这里）：把它交给普通联机客户端，后续流程完全一致。 */
  _p2pConnected(){
    this.trace('p2p-opened','role='+this.p2pRole,'dial='+!!this.client.dial);
    if(this.client.dial&&this.client.connected)return;
    // 结束可能残留的服务器模式连接/重连，避免与 P2P 客户端抢占同一个 ws 字段。
    this.client.stop(false);
    // 房主的客户端走本地回环（权威房间就在本页），队友的客户端走数据通道。
    const socket=this.p2pRole==='host'?this.p2pHost.selfSocket():this.p2pConn.socketReady();
    this.client.dial=()=>socket;
    void this.client.join(this.p2pCode,this.name.value).catch(err=>this.showMessage(err.message));
  }
  /** 队友点开邀请链接：页面自带 #o=，直接进入生成回答的流程。 */
  _hashFlow(){
    const hash=location.hash??'';
    if(!/^#o=/.test(hash)||!p2pAvailable())return;
    history.replaceState(null,'',location.pathname+location.search);
    this.p2pGuestStart(hash.slice(1)).catch(err=>this.showMessage(err.message));
  }
  showMessage(text){this.message.textContent=text;}
  /** 轻量调试轨迹：排查“连不上”时 window.__coopTrace 能还原事件顺序（对玩家不可见）。 */
  trace(...parts){
    const line=`${Math.round(performance.now()%1e6)} ${parts.join(' ')}`;
    const log=window.__coopTrace??(window.__coopTrace=[]);
    log.push(line); if(log.length>200)log.splice(0,100);
  }
  setStatus(status){this.status=status;this.trace('status',status);
    const text={connecting:'正在建立连接…',reconnecting:'连接中断，自动重连中（保留席位 60 秒）',failed:'连接已断开，请重新建房或加入',connected:'已连接。确认装备，准备后由房主统一出发。'}[status];
    if(text)this.showMessage(text);
    this.root.querySelectorAll('[data-coop="create"],[data-coop="join"]').forEach(b=>b.disabled=['connecting','reconnecting'].includes(status));
  }
  render(room){
    this.trace('render',room?.phase,room?.members?.length??0);
    this.room=room;this.roomEl.hidden=!room;if(!room)return;
    if(room.phase==='preparing')this.showMessage('全员准备完成，正在部署战局…');
    const id=this.client.credentials?.id,host=room.host===id,me=room.members.find(m=>m.id===id);
    this.root.querySelector('.coop-connect').hidden=true;
    this.root.querySelector('.coop-p2p').hidden=true;
    // 房主用 localhost 打开时，直接把队友该用的局域网地址摆在最显眼处。
    const loopback=['localhost','127.0.0.1','::1','[::1]'].includes(location.hostname);
    const shareLan=!this.client.dial&&loopback&&this.client.lanHost?`http://${this.client.lanHost}:${location.port||8787}/`:null;
    this.roomEl.innerHTML=`<div class="coop-room-top"><span>房间 <strong>${escape(room.code)}</strong></span>${this.client.dial?'':`<button data-coop="copy">复制邀请链接</button>`}<button data-coop="leave">离开房间</button></div>
      ${shareLan?`<p class="coop-note">队友（同一 WiFi）打开：<code>${shareLan}</code> 并输入房主给的房间码即可加入。</p>`:''}
      ${this.client.dial?`<p class="coop-note">直连模式：队员要加入请让他刷新页面后点房主新发的邀请链接（每条邀请只能用一次）。</p>`:''}
      <div class="coop-roster">${room.members.map((m,i)=>`<div class="coop-member ${m.ready?'ready':''}"><span class="coop-number">0${i+1}</span><b>${escape(m.name)}${m.id===id?' · 你':''}</b><small>${!m.connected?'断线保留中':m.id===room.host?'房主':'队员'} · ${m.ready?'已准备':'整备中'}</small></div>`).join('')}${Array.from({length:4-room.members.length},()=>'<div class="coop-member empty">等待队友加入</div>').join('')}</div>
      <div class="coop-actions"><label>行动区域 <select class="coop-map" ${!host||room.phase!=='lobby'?'disabled':''}>${[['blackhouse','黑楼'],['clinic','废弃诊所'],['radio','废弃电台']].map(([v,n])=>`<option value="${v}" ${v===room.map?'selected':''}>${n}</option>`).join('')}</select></label>
      <button data-coop="kit" ${room.phase!=='lobby'?'disabled':''}>调整装备</button><button data-coop="ready" ${room.phase!=='lobby'?'disabled':''}>${me?.ready?'取消准备':'我准备好了'}</button>
      ${host?`<button class="primary" data-coop="start" ${room.members.length<2||room.members.some(m=>!m.ready||!m.connected)||room.phase!=='lobby'?'disabled':''}>全员出发</button>`:''}</div>
      <p class="coop-note">房主离线不终止战局。战利品先拿先得，空手也可撤离；各自仓库独立结算。</p>`;
  }
  updateHUD(snapshot){
    this.hud.hidden=false;
    this.hud.innerHTML=`<div class="coop-hud-head">小队 ${escape(this.room?.code)} · ${this.client.connected?(this.client.rtt?`${this.client.rtt} ms`:'直连'):'正在重连'}</div>`+
      snapshot.players.map(p=>`<div><b>${escape(p.name)}</b><span>${p.status==='extracted'?'已撤离':p.status==='dead'?'阵亡':`${p.hp} HP · ${p.armor} 甲`}</span></div>`).join('');
  }
  reset(){this.trace('reset');
    this.room=null;this.roomEl.hidden=true;this.root.querySelector('.coop-connect').hidden=!this.client.endpoint;this.root.querySelector('.coop-p2p').hidden=false;
    for(const b of this.root.querySelectorAll('.coop-p2p-box'))b.hidden=true;
    this.p2pConn=null;this.p2pCode=null;this.p2pHost.dispose();this.p2pHost=new P2PHost();
    this.client.dial=null;
    this.hud.hidden=true;this.showMessage('已离开房间，可以继续单人行动。');}
}
