import { CoopP2P, P2PHost, p2pAvailable, decodeSignal, encodeSignal } from '../net/p2p.js';
import { connectionReport, netLog, lanPageURL } from '../net/diagnostics.js';
import { RoomDirectory } from './room-directory.js';

const escape = s => String(s??'').replaceAll('&','&amp;').replaceAll('<','&lt;').replaceAll('"','&quot;');
export class CoopLobby {
  constructor(client,{onReady,onLeave,onMap,onOpenKit}={}) {
    this.client=client;this.callbacks={onReady,onLeave,onMap,onOpenKit};this.status='offline';this.room=null;
    this.p2pHost=new P2PHost();this.p2pConn=null;this.p2pCode=null;this.p2pInvites=[];this.p2pInviteOpen=false;this.p2pRole=null;
    this.busy=false;this.flowGeneration=0;this.recoveryOpen=false;
    this.serverUsable=!!client.endpoint&&!/(^|\.)github\.io$/.test(location.hostname);
    if(!this.serverUsable){try{sessionStorage.removeItem('pc.coop.session');}catch{}}
    this.root=document.createElement('section');this.root.className='coop-lobby';this.root.setAttribute('aria-label','好友合作');
    this.root.innerHTML=`<header><span class="coop-kicker">SQUAD LINK / 好友合作</span><h2>一起进去，一起回来。</h2><p>2–4 人合作 · 直连交换邀请与回答；服务器模式使用房间码 · 无账号</p></header>
      <div class="coop-connect"><label>呼号<input class="coop-name" maxlength="16" value="行动员" autocomplete="nickname"></label>
      <button type="button" data-coop="create">创建房间</button><label>房间码<input class="coop-code" maxlength="6" placeholder="6 位房间码" autocapitalize="characters" autocomplete="off"></label><button type="button" data-coop="join">加入好友</button></div>
      <section class="coop-directory" aria-label="局域网在线房间"></section>
      <div class="coop-p2p"><div class="coop-p2p-head"><b>局域网直连</b><span>无需公网服务器 · 同一局域网优先直连 · 失败可用下方备用方式</span></div>
        <div class="coop-p2p-row"><button type="button" class="primary" data-coop="p2p-host">创建直连房间</button><button type="button" data-coop="p2p-join">我有邀请码</button></div>
        <div class="coop-p2p-box invite" hidden><label>把这条邀请链接发给队友（在系统浏览器打开）：<textarea class="p2p-invite" readonly rows="2"></textarea></label><button type="button" data-coop="p2p-copy-invite">复制邀请链接</button></div>
        <div class="coop-p2p-box answer" hidden><label>队友把「回答码」发回来后，粘贴到这里：<textarea class="p2p-answer" rows="2" placeholder="粘贴队友发回的内容"></textarea></label><button type="button" class="primary" data-coop="p2p-accept">完成连接</button></div>
        <div class="coop-p2p-box join" hidden><label>粘贴房主发来的邀请（链接或邀请码，不是回答码）：<textarea class="p2p-invite-in" rows="2" placeholder="粘贴邀请链接"></textarea></label><button type="button" class="primary" data-coop="p2p-gen">生成回答码</button></div>
        <div class="coop-p2p-box reply" hidden><label>把这条「回答」发回给房主：<textarea class="p2p-answer-out" readonly rows="2"></textarea></label><button type="button" data-coop="p2p-copy-answer">复制回答</button></div>
      </div>
      <p class="coop-message" role="status" aria-live="polite">单人模式保持不变。</p>
      <div class="coop-recovery" hidden><b>连接没有完成</b><p class="coop-failure"></p><button type="button" data-coop="p2p-retry">重新交换邀请</button><button type="button" data-coop="fallback">查看备用方式</button></div>
      <details class="coop-fallback"><summary>直连失败？局域网服务器备用方式（Windows / Mac）</summary>
        <p>此方式不使用 WebRTC：一位朋友用 Windows 或 Mac 电脑开服，其他设备在浏览器里打开开服窗口显示的网址。不能自动切换，也不会迁移正在进行的战局。存档按网址独立。</p>
        <ol><li>开服者安装 Node.js 22 或更新版本（<a href="https://nodejs.org/en/download">官方下载</a>）。</li><li>下载并解压<a href="./downloads/protocol-clearance-lan.zip" download>局域网开服包</a>。Windows 双击 Start-Windows.cmd；Mac 在终端输入 sh，将 Start-Mac.command 拖进终端后回车。依赖已包含，不需要 npm install。</li><li>房主在窗口显示的局域网网址打开游戏，点「创建房间」。队友打开相同网址，点「浏览在线房间」并选择小队加入，也可输入房间码。窗口保持运行。</li></ol>
        <label>开服窗口显示的局域网网址<input class="coop-lan-url" placeholder="http://192.168.1.20:8787/" autocomplete="off"></label><button type="button" data-coop="lan-open">打开备用局域网页面</button>
        <p>必须打开整个局域网页面，不要从 HTTPS 游戏页面连接 HTTP 后端。浏览器询问本地网络权限时请允许。访客网络或设备隔离可能阻断设备互访。没有电脑开服时，此备用方式不可用。</p>
      </details>
      <details class="coop-diagnostics"><summary>连接诊断与日志</summary><p class="coop-capabilities"></p><p>微信等内置浏览器可能禁用直连，请用更新的 Safari / Chrome / Edge / Firefox。房主保持页面在前台，避免锁屏。</p><button type="button" data-coop="diagnostics">生成诊断日志</button><button type="button" data-coop="diagnostics-copy">复制诊断日志</button><textarea class="coop-log" aria-label="诊断日志" readonly rows="6"></textarea><p>不记录邀请码、回答 SDP 或身份凭据；浏览器版本和错误信息仍可能包含设备信息，请只发给信任的人。</p></details>
      <div class="coop-room" hidden></div>`;
    this.directory=new RoomDirectory(this.root.querySelector('.coop-directory'),client,{available:this.serverUsable&&new URL(client.endpoint).hostname===location.hostname});
    this.name=this.root.querySelector('.coop-name');this.code=this.root.querySelector('.coop-code');
    this.message=this.root.querySelector('.coop-message');this.roomEl=this.root.querySelector('.coop-room');
    this.root.addEventListener('click',event=>void this._click(event));
    this.root.addEventListener('change',e=>{if(e.target.matches('.coop-map'))this.callbacks.onMap?.(e.target.value);});
    document.querySelector('#missions-page')?.prepend(this.root);
    if(!this.serverUsable){
      this.root.querySelector('[data-coop="create"]').hidden=true;this.root.querySelector('[data-coop="join"]').hidden=true;this.code.parentElement.hidden=true;
      if(!p2pAvailable())this.connectionFailed(new Error('当前浏览器不支持 WebRTC，请使用系统浏览器或下方服务器备用方式'));
      else this.showMessage('先填呼号，再点「创建直连房间」。邀请和回答必须双向交换，最后由房主点「完成连接」。');
    }
    this.root.querySelector('.coop-capabilities').textContent=`WebRTC：${p2pAvailable()?'可用':'不可用'} · 安全页面：${globalThis.isSecureContext?'是':'否'} · 复制：${navigator.clipboard?'可请求':'请手动复制'}`;
    document.addEventListener('visibilitychange',()=>{
      if(document.hidden&&this.p2pRole==='host'&&this.client.connected){netLog('host-background');this.showMessage('房主页面进入后台可能暂停战局，请回到本页并保持屏幕亮着');}
    });
    window.addEventListener('offline',()=>{netLog('browser-offline');if(this.p2pRole)this.connectionFailed(new Error('浏览器报告网络断开，请恢复局域网连接后重试'));});
    this.hud=document.createElement('aside');this.hud.className='coop-hud';this.hud.hidden=true;document.querySelector('#ui')?.append(this.hud);
    this._hashFlow();
  }
  async _click(event){
    const button=event.target.closest('[data-coop]');const a=button?.dataset.coop;if(!a||button.disabled)return;
    const longAction=['p2p-host','p2p-new','p2p-gen','p2p-accept','p2p-retry','create','join','browse-join'].includes(a);
    if(longAction&&this.busy)return;
    if(longAction)this._busy(true);
    try{
      if(a==='browse'||a==='browse-refresh'){
        if(this.client.connected)throw new Error('请先离开当前房间再浏览其它房间');
        if(a==='browse')await this.directory.start();else await this.directory.refresh();
        if(!this.directory.available)this.root.querySelector('.coop-fallback').open=true;
      }else if(a==='create'||a==='join'||a==='browse-join'){
        if(this.client.connected)throw new Error('请先离开当前房间再切换连接方式');
        this.directory.stop();this.flowGeneration++;this.client.stop(false);this.p2pConn?.close();for(const conn of this.p2pInvites)conn.close();this.p2pHost.dispose();this.p2pHost=new P2PHost();this.p2pInvites=[];this.client.dial=null;this.p2pRole=null;
        this.showMessage('正在连接房间服务…');
        if(a==='create')await this.client.create(this.name.value);else await this.client.join(a==='browse-join'?button.dataset.code:this.code.value,this.name.value);
      }else if(a==='copy'){
        const url=new URL(location.href);url.hash='';url.searchParams.set('room',this.room.code);url.searchParams.set('map',this.room.map);
        if(['localhost','127.0.0.1','::1','[::1]'].includes(location.hostname)&&this.client.lanHost)url.hostname=this.client.lanHost;
        await this._copy(url.href,null,`邀请链接已复制：${url.href}`);
      }else if(a==='p2p-host'||a==='p2p-new')await this.p2pHostStart();
      else if(a==='p2p-join'){
        if(this.client.connected)throw new Error('请先离开当前房间再加入另一房间');
        this.p2pInviteOpen=true;this.root.querySelector('.coop-p2p').hidden=false;this._box('join');this.showMessage('粘贴房主的完整邀请，再点「生成回答码」。');
      }else if(a==='p2p-accept')await this.p2pHostAccept(this.root.querySelector('.p2p-answer').value);
      else if(a==='p2p-gen')await this.p2pGuestStart(this.root.querySelector('.p2p-invite-in').value);
      else if(a==='p2p-copy-invite'||a==='p2p-copy-answer'){
        const field=this.root.querySelector(a==='p2p-copy-invite'?'.p2p-invite':'.p2p-answer-out');await this._copy(field.value,field,'已复制：必须发给对方；房主收到回答后点「完成连接」。');
      }else if(a==='p2p-retry'){
        this.root.querySelector('.coop-recovery').hidden=true;
        if(this.p2pRole==='host')await this.p2pHostStart();
        else{this.flowGeneration++;this.p2pConn?.close();this.p2pInviteOpen=true;this.root.querySelector('.coop-p2p').hidden=false;this._box('reply',false);this._box('join');this.showMessage('请房主生成新邀请，在此原页面粘贴并生成新回答。不要刷新或新开标签页，不要重复使用旧回答。');}
      }else if(a==='fallback')this.root.querySelector('.coop-fallback').open=true;
      else if(a==='lan-open')location.href=lanPageURL(this.root.querySelector('.coop-lan-url').value);
      else if(a==='diagnostics'||a==='diagnostics-copy'){
        const field=this.root.querySelector('.coop-log');field.value=connectionReport({role:this.p2pRole,status:this.status,stage:this.p2pConn?.stage??null});
        if(a==='diagnostics-copy')await this._copy(field.value,field,'诊断日志已复制');
      }else if(a==='ready')this.callbacks.onReady?.();
      else if(a==='start'){if(!this.client.send({type:'start'}))throw new Error('连接未就绪，不能出发');this.showMessage('正在确认全员存档并部署战局…');}
      else if(a==='leave')this.callbacks.onLeave?.();
      else if(a==='kit')this.callbacks.onOpenKit?.();
    }catch(err){this.connectionFailed(err);}
    finally{if(longAction)this._busy(false);}
  }
  async _copy(value,field,message){
    if(!value)throw new Error('没有可复制的内容，请先生成邀请或回答');
    try{await navigator.clipboard.writeText(value);this.showMessage(message);}
    catch{field?.focus();field?.select();this.showMessage(field?'浏览器未允许自动复制：请手动复制已选中的全部内容。':`请手动复制链接：${value}`);}
  }
  _box(name,show=true){const el=this.root.querySelector(`.coop-p2p-box.${name}`);el.hidden=!show;return el;}
  _busy(busy){this.busy=busy;this.root.querySelectorAll('[data-coop="p2p-host"],[data-coop="p2p-new"],[data-coop="p2p-gen"],[data-coop="p2p-accept"],[data-coop="p2p-retry"]').forEach(b=>b.disabled=busy);}
  connectionFailed(err){
    if(this.client.room?.phase==='active')this.recoveryOpen=true;
    const message=err.message||String(err);this.trace('failure',message);netLog('lobby-failure',{message});this.showMessage(message);
    this.root.querySelector('.coop-recovery').hidden=false;this.root.querySelector('.coop-failure').textContent=message;
    this.root.querySelector('.coop-diagnostics').open=true;
    this.root.querySelector('.coop-log').value=connectionReport({role:this.p2pRole,status:this.status,stage:this.p2pConn?.stage??null});
  }
  _connection(){
    const generation=this.flowGeneration;
    return new CoopP2P({onOpen:()=>{if(generation===this.flowGeneration)this._p2pConnected();},
      onState:stage=>{
        if(generation!==this.flowGeneration)return;this.trace('p2p',stage);
        const text={gathering:'正在收集局域网地址…最多 10 秒',connecting:'回答已接收，正在连通设备…最多 25 秒',slow:'仍在等待设备连通；请允许本地网络权限并保持双方页面打开',disconnected:'网络暂时中断，等待通道恢复…最多 25 秒'}[stage];if(text)this.showMessage(text);
      },onFailure:err=>{if(generation===this.flowGeneration)this.connectionFailed(err);}});
  }
  async p2pHostStart(){
    this.trace('host-start');this.directory.stop();
    if(!p2pAvailable())throw new Error('当前浏览器不支持 WebRTC，请使用局域网服务器备用方式');
    if(this.client.connected&&!this.client.dial)throw new Error('请先离开服务器房间再切换直连');
    if(this.client.dial&&this.p2pRole!=='host'&&this.client.connected)throw new Error('请先离开当前房间再创建房间');
    if(this.p2pHost.room&&this.p2pHost.room.phase==='preparing')throw new Error('正在部署战局，请等待部署结果');
    if(this.p2pRole==='guest'){this.flowGeneration++;this.p2pConn?.close();this.client.dial=null;}
    this.root.querySelector('.coop-recovery').hidden=true;
    const code=this.p2pHost.ensureRoom();const pageMap=new URLSearchParams(location.search).get('map');
    if(this.p2pHost.room.phase==='lobby'&&['blackhouse','clinic','radio'].includes(pageMap))this.p2pHost.room.map=pageMap;
    this.p2pCode=code;this.p2pRole='host';this.p2pInviteOpen=true;this.root.querySelector('.coop-p2p').hidden=false;
    if(!this.client.dial||!this.client.connected){this.client.stop(false);this.client.dial=()=>this.p2pHost.selfSocket();await this.client.join(code,this.name.value);}
    for(const old of this.p2pInvites)old.close();this.p2pInvites=[];
    const conn=this._connection();this.p2pInvites.push(conn);this.p2pConn=conn;
    const invite=await conn.createInvite(code,this.p2pHost.room.map);if(conn.closed)throw new Error('邀请已取消');this.p2pHost.attachGuest(conn);
    const link=`${location.origin}${location.pathname}?map=${this.p2pHost.room.map}#o=${invite}`;
    this.root.querySelector('.p2p-invite').value=link;this.root.querySelector('.p2p-answer').value='';
    this._box('join',false);this._box('reply',false);this._box('invite');this._box('answer');
    this.showMessage('步骤 1/3：把邀请发给队友。在系统浏览器打开；收到回答后粘贴，再点「完成连接」。邀请 10 分钟有效；生成新邀请后旧邀请作废。');
  }
  async p2pGuestStart(invite){
    this.trace('guest-start');this.directory.stop();
    if(!p2pAvailable())throw new Error('当前浏览器不支持 WebRTC，请使用局域网服务器备用方式');
    if(this.client.connected)throw new Error('请先离开当前房间，再接受新邀请');
    if(!String(invite??'').trim())throw new Error('先粘贴房主的完整邀请链接');
    const data=decodeSignal(invite);if(data.type!=='offer')throw new Error('需要房主的邀请码，不是队友的回答码');
    if(this.client.room?.phase==='active'&&this.p2pCode!==data.code)throw new Error('旧战局尚未结束，只能重新加入原房间');
    const pageMap=new URLSearchParams(location.search).get('map')||'blackhouse';
    const offeredMap=data.map||'blackhouse';
    if(offeredMap!==pageMap){
      const url=new URL(location.href);url.searchParams.set('map',offeredMap);
      url.hash=`o=${encodeSignal(data)}`;location.href=url.href;return;
    }
    this.flowGeneration++;this.client.stop(false);this.p2pConn?.close();
    if(this.p2pRole==='host'){this.p2pHost.dispose();this.p2pHost=new P2PHost();this.p2pInvites=[];}
    this.p2pRole='guest';this.p2pInviteOpen=true;
    this.root.querySelector('.coop-p2p').hidden=false;this.root.querySelector('.coop-recovery').hidden=true;
    const conn=this._connection();this.p2pConn=conn;
    const {code,answer}=await conn.acceptInvite(invite);if(conn.closed)throw new Error('邀请已取消');this.p2pCode=code;
    this.root.querySelector('.p2p-answer-out').value=answer;this._box('invite',false);this._box('answer',false);this._box('join',false);this._box('reply');
    this.showMessage('步骤 2/3：必须把下面的回答发回房主，并让房主点「完成连接」。只复制不发回不会连接；等待超过 90 秒会提示重试。');
  }
  async p2pHostAccept(answer){
    this.trace('host-accept');const data=decodeSignal(answer);
    if(data.type!=='answer')throw new Error('请粘贴队友的回答码，不是房主的邀请码');
    const conn=this.p2pInvites.find(c=>!c.closed&&c.id===data.id&&c.code===data.code);
    if(!conn)throw new Error('回答不属于当前邀请，或邀请已关闭：请重新交换最新邀请和回答');
    await conn.acceptAnswer(answer);await conn.waitConnected();
    const start=performance.now();
    await new Promise((resolve,reject)=>{const poll=()=>{
      if(conn.closed)return reject(conn.error??new Error('队友连接已关闭'));
      if(this.p2pHost.peers.get(conn)?.member)return resolve();
      if(performance.now()-start>12000){conn.close();return reject(new Error('通道已打开，但队友未完成入房握手（12 秒），请重新交换邀请'));}
      setTimeout(poll,100);
    };poll();});
    this.p2pInvites=this.p2pInvites.filter(c=>c!==conn);this._box('answer',false);this._box('invite',false);this.p2pInviteOpen=false;
    this.root.querySelector('.coop-p2p').hidden=true;this.root.querySelector('.coop-recovery').hidden=true;
    this.recoveryOpen=false;
    this.showMessage(this.room?.phase==='active'?'队友已恢复原座位，正在继续同步原战局。':'连接成功：队友已经出现在成员列表中。各自点「我准备好了」，房主点「全员出发」。');
  }
  _p2pConnected(){
    this.trace('p2p-opened','role='+this.p2pRole);
    if(this.client.dial&&this.client.connected)return;
    this.client.stop(false);
    const socket=this.p2pRole==='host'?this.p2pHost.selfSocket():this.p2pConn.socketReady();this.client.dial=()=>socket;
    void this.client.join(this.p2pCode,this.name.value).then(()=>{
      this.recoveryOpen=false;this._box('reply',false);this.p2pInviteOpen=false;this.root.querySelector('.coop-p2p').hidden=true;this.root.querySelector('.coop-recovery').hidden=true;
      if(this.room?.phase==='active')this.showMessage('已恢复原座位，正在继续同步原战局。');
    }).catch(err=>this.connectionFailed(err));
  }
  _hashFlow(){
    const hash=location.hash??'';if(!/^#o=/.test(hash))return;
    if(!p2pAvailable()){this.connectionFailed(new Error('邀请已收到，但当前浏览器不支持 WebRTC，请使用系统浏览器或备用方式'));return;}
    history.replaceState(null,'',location.pathname+location.search);
    this._busy(true);this.p2pGuestStart(hash.slice(1)).catch(err=>this.connectionFailed(err)).finally(()=>this._busy(false));
  }
  showMessage(text){this.message.textContent=text;}
  trace(...parts){const log=window.__coopTrace??(window.__coopTrace=[]);log.push(`${Math.round(performance.now())} ${parts.join(' ')}`);if(log.length>200)log.shift();}
  setStatus(status){
    this.status=status;this.trace('status',status);
    const text={connecting:'正在建立连接…',reconnecting:'连接中断，自动重连中（保留席位 60 秒）',connected:'已连接。确认装备，准备后由房主统一出发。'}[status];if(text)this.showMessage(text);
    if(status==='failed')this.connectionFailed(new Error(this.client.dial?'直连已断开，请重新交换邀请恢复原座位，或查看备用方式':'房间服务连接失败，请检查开服窗口和局域网页面网址'));
    this.root.querySelectorAll('[data-coop="create"],[data-coop="join"]').forEach(b=>b.disabled=['connecting','reconnecting'].includes(status));
    if(this.room)this.render(this.room);
  }
  render(room){
    this.trace('render',room?.phase,room?.members?.length??0);this.room=room;this.roomEl.hidden=!room;if(!room)return;
    if(room.phase==='preparing')this.showMessage('全员准备完成，正在部署战局…');
    const id=this.client.credentials?.id,host=room.host===id,me=room.members.find(m=>m.id===id);
    this.directory.stop();this.directory.root.hidden=true;
    this.root.querySelector('.coop-connect').hidden=true;this.root.querySelector('.coop-p2p').hidden=!this.p2pInviteOpen;
    const loopback=['localhost','127.0.0.1','::1','[::1]'].includes(location.hostname);
    const shareLan=!this.client.dial&&loopback&&this.client.lanHost?`http://${this.client.lanHost}:${location.port||8787}/`:null;
    const canInvite=this.p2pRole==='host'&&!!this.client.dial&&((room.phase==='lobby'&&room.members.length<4)||room.members.some(m=>!m.connected));
    this.roomEl.innerHTML=`<div class="coop-room-top"><span>房间 <strong>${escape(room.code)}</strong></span>${canInvite?'<button data-coop="p2p-new">邀请新队友</button>':''}${this.client.dial?'':'<button data-coop="copy">复制邀请链接</button>'}<button data-coop="leave">离开房间</button></div>
      ${shareLan?`<p class="coop-note">队友打开：<code>${escape(shareLan)}</code> 并输入房间码。${(this.client.lanAddresses??[]).length>1?'多个网卡地址：请选择与队友同网段的 Wi-Fi/网线地址。'+this.client.lanAddresses.map(a=>`${escape(a.name)}：http://${escape(a.address)}:${location.port||8787}/`).join(' · '):''}</p>`:''}
      <div class="coop-roster">${room.members.map((m,i)=>`<div class="coop-member ${m.ready?'ready':''}"><span class="coop-number">0${i+1}</span><b>${escape(m.name)}${m.id===id?' · 你':''}</b><small>${!m.connected?'断线保留中':m.id===room.host?'房主':'队员'} · ${m.ready?'已准备':'整备中'}</small></div>`).join('')}${Array.from({length:Math.max(0,4-room.members.length)},()=>'<div class="coop-member empty">等待队友加入</div>').join('')}</div>
      <div class="coop-actions"><label>行动区域 <select class="coop-map" ${(!host||room.phase!=='lobby'||this.client.dial)?'disabled':''}>${[['blackhouse','黑楼'],['clinic','废弃诊所'],['radio','废弃电台']].map(([v,n])=>`<option value="${v}" ${v===room.map?'selected':''}>${n}</option>`).join('')}</select></label>
      <button data-coop="kit" ${room.phase!=='lobby'||!this.client.connected?'disabled':''}>调整装备</button><button data-coop="ready" ${room.phase!=='lobby'||!this.client.connected?'disabled':''}>${me?.ready?'取消准备':'我准备好了'}</button>
      ${host?`<button class="primary" data-coop="start" ${room.members.length<2||room.members.some(m=>!m.ready||!m.connected)||room.phase!=='lobby'||!this.client.connected?'disabled':''}>全员出发</button>`:''}</div>
      <p class="coop-note">${this.client.dial?'直连由创建者页面运行战局：请保持前台、不要关闭或锁屏；队友掉线请在原页面粘贴新邀请恢复原座位（不要刷新、关闭或新开标签页）。':'服务器窗口必须保持运行；房主浏览器掉线不终止战局。'}战利品先拿先得，各自仓库独立结算。</p>`;
    if(this.busy)this._busy(true);
  }
  updateHUD(snapshot){
    this.hud.hidden=false;this.hud.innerHTML=`<div class="coop-hud-head">小队 ${escape(this.room?.code)} · ${this.client.connected?(this.client.rtt?`${this.client.rtt} ms`:'直连'):(this.client.dial?'直连中断，请重新交换邀请':'正在重连')}</div>`+snapshot.players.map(p=>`<div><b>${escape(p.name)}</b><span>${p.status==='extracted'?'已撤离':p.status==='dead'?'阵亡':`${p.hp} HP · ${p.armor} 甲`}</span></div>`).join('');
  }
  reset(){
    this.directory.stop();this.directory.root.hidden=false;
    this.recoveryOpen=false;this.flowGeneration++;this.p2pConn?.close();for(const conn of this.p2pInvites)conn.close();this.p2pHost.dispose();this.p2pHost=new P2PHost();
    this.room=null;this.roomEl.hidden=true;this.root.querySelector('.coop-connect').hidden=false;this.root.querySelector('.coop-p2p').hidden=false;
    for(const box of this.root.querySelectorAll('.coop-p2p-box'))box.hidden=true;
    this.root.querySelector('.coop-recovery').hidden=true;this.p2pConn=null;this.p2pCode=null;this.p2pInvites=[];this.p2pInviteOpen=false;this.p2pRole=null;this.client.dial=null;
    this.hud.hidden=true;this.showMessage('已离开房间，可以继续单人行动。');
  }
}
