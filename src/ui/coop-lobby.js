const escape = (s) => String(s??'').replaceAll('&','&amp;').replaceAll('<','&lt;').replaceAll('"','&quot;');
export class CoopLobby {
  constructor(client,{onReady,onLeave,onMap,onOpenKit}={}) {
    this.client=client;this.callbacks={onReady,onLeave,onMap,onOpenKit};this.status='offline';this.room=null;
    this.root=document.createElement('section');this.root.className='coop-lobby';
    this.root.setAttribute('aria-label','好友合作');
    this.root.innerHTML=`<header><span class="coop-kicker">SQUAD LINK / 好友合作</span><h2>一起进去，一起回来。</h2><p>2–4 人合作 · 分享房间码即可加入 · 无账号 · 无队友伤害</p></header>
      <div class="coop-connect"><label>呼号<input class="coop-name" maxlength="16" value="行动员" autocomplete="nickname"></label>
      <button type="button" data-coop="create">创建房间</button><label>房间码<input class="coop-code" maxlength="6" placeholder="6 位房间码" autocapitalize="characters" autocomplete="off"></label><button type="button" data-coop="join">加入好友</button></div>
      <p class="coop-message" role="status" aria-live="polite">单人模式保持不变。创建房间或输入好友的房间码。</p>
      <div class="coop-room" hidden></div>`;
    this.name=this.root.querySelector('.coop-name');this.code=this.root.querySelector('.coop-code');
    this.message=this.root.querySelector('.coop-message');this.roomEl=this.root.querySelector('.coop-room');
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
        }else if(a==='ready')this.callbacks.onReady?.();
        else if(a==='start'){client.send({type:'start'});this.showMessage('正在确认全员存档并部署战局…');}
        else if(a==='leave')this.callbacks.onLeave?.();
        else if(a==='kit')this.callbacks.onOpenKit?.();
      }catch(err){this.showMessage(err.message||'连接失败，请检查网络');}
    });
    this.root.addEventListener('change',e=>{if(e.target.matches('.coop-map'))this.callbacks.onMap?.(e.target.value);});
    document.querySelector('#missions-page')?.prepend(this.root);
    if(!client.endpoint){
      this.root.querySelectorAll('[data-coop="create"],[data-coop="join"]').forEach(b=>b.disabled=true);
      this.showMessage('联机服务尚未部署；单人模式可正常游玩。');
    }
    this.hud=document.createElement('aside');this.hud.className='coop-hud';this.hud.hidden=true;
    document.querySelector('#ui')?.append(this.hud);
  }
  showMessage(text){this.message.textContent=text;}
  setStatus(status){this.status=status;
    const text={connecting:'正在建立连接…',reconnecting:'连接中断，自动重连中（保留席位 60 秒）',failed:'房间连接失败，请重新加入',connected:'已连接。确认装备，准备后由房主统一出发。'}[status];
    if(text)this.showMessage(text);
    this.root.querySelectorAll('[data-coop="create"],[data-coop="join"]').forEach(b=>b.disabled=['connecting','reconnecting'].includes(status));
  }
  render(room){
    this.room=room;this.roomEl.hidden=!room;if(!room)return;
    if(room.phase==='preparing')this.showMessage('全员准备完成，正在部署战局…');
    const id=this.client.credentials?.id,host=room.host===id,me=room.members.find(m=>m.id===id);
    this.root.querySelector('.coop-connect').hidden=true;
    // 房主用 localhost 打开时，直接把队友该用的局域网地址摆在最显眼处。
    const loopback=['localhost','127.0.0.1','::1','[::1]'].includes(location.hostname);
    const shareLan=loopback&&this.client.lanHost?`http://${this.client.lanHost}:${location.port||8787}/`:null;
    this.roomEl.innerHTML=`<div class="coop-room-top"><span>房间 <strong>${escape(room.code)}</strong></span><button data-coop="copy">复制邀请链接</button><button data-coop="leave">离开房间</button></div>
      ${shareLan?`<p class="coop-note">队友（同一 WiFi）打开：<code>${shareLan}</code> 并输入房主给的房间码即可加入。</p>`:''}
      <div class="coop-roster">${room.members.map((m,i)=>`<div class="coop-member ${m.ready?'ready':''}"><span class="coop-number">0${i+1}</span><b>${escape(m.name)}${m.id===id?' · 你':''}</b><small>${!m.connected?'断线保留中':m.id===room.host?'房主':'队员'} · ${m.ready?'已准备':'整备中'}</small></div>`).join('')}${Array.from({length:4-room.members.length},()=>'<div class="coop-member empty">等待队友加入</div>').join('')}</div>
      <div class="coop-actions"><label>行动区域 <select class="coop-map" ${!host||room.phase!=='lobby'?'disabled':''}>${[['blackhouse','黑楼'],['clinic','废弃诊所'],['radio','废弃电台']].map(([v,n])=>`<option value="${v}" ${v===room.map?'selected':''}>${n}</option>`).join('')}</select></label>
      <button data-coop="kit" ${room.phase!=='lobby'?'disabled':''}>调整装备</button><button data-coop="ready" ${room.phase!=='lobby'?'disabled':''}>${me?.ready?'取消准备':'我准备好了'}</button>
      ${host?`<button class="primary" data-coop="start" ${room.members.length<2||room.members.some(m=>!m.ready||!m.connected)||room.phase!=='lobby'?'disabled':''}>全员出发</button>`:''}</div>
      <p class="coop-note">房主离线不终止战局。战利品先拿先得，空手也可撤离；各自仓库独立结算。</p>`;
  }
  updateHUD(snapshot){
    this.hud.hidden=false;
    this.hud.innerHTML=`<div class="coop-hud-head">小队 ${escape(this.room?.code)} · ${this.client.connected?`${this.client.rtt} ms`:'正在重连'}</div>`+
      snapshot.players.map(p=>`<div><b>${escape(p.name)}</b><span>${p.status==='extracted'?'已撤离':p.status==='dead'?'阵亡':`${p.hp} HP · ${p.armor} 甲`}</span></div>`).join('');
  }
  reset(){this.room=null;this.roomEl.hidden=true;this.root.querySelector('.coop-connect').hidden=false;this.hud.hidden=true;this.showMessage('已离开房间，可以继续单人行动。');}
}
