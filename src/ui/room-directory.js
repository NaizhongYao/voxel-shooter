import { validCode } from '../net/protocol.js';

const escape=s=>String(s??'').replaceAll('&','&amp;').replaceAll('<','&lt;').replaceAll('"','&quot;');
const maps={blackhouse:'黑楼',clinic:'废弃诊所',radio:'废弃电台'};
export function roomCards(rooms) {
  return rooms.filter(r=>validCode(r.code)).slice(0,32).map(r=>{
    const joinable=r.joinable===true&&r.phase==='lobby'&&r.seats<r.maxPlayers;
    const state=r.phase==='preparing'?'正在出发':r.phase==='active'?'战局进行中':joinable?'等待加入':'房间已满（含保留席位）';
    return `<article class="coop-list-room"><div><b>${escape(r.host)}的小队</b><span>${escape(maps[r.map]??'未知地图')} · ${escape(r.code)}</span></div><div><strong>${escape(r.online)} / ${escape(r.maxPlayers)} 在线</strong><span>${escape(state)}${r.seats>r.online?` · ${escape(r.seats-r.online)} 个断线保留席位`:''}</span></div><button type="button" data-coop="browse-join" data-code="${r.code}" ${joinable?'':'disabled'}>加入 ${r.code}</button></article>`;
  }).join('');
}
export class RoomDirectory {
  constructor(root,client,{available=false}={}) {
    this.root=root;this.client=client;this.available=available;this.active=false;this.loading=false;this.generation=0;this.timer=null;this.controller=null;
    root.innerHTML=`<div class="coop-directory-head"><b>局域网在线房间</b><button type="button" data-coop="browse">浏览在线房间</button><button type="button" data-coop="browse-refresh" hidden>刷新房间</button></div><p class="coop-directory-status" role="status" aria-live="polite">${available?'列出此开服地址上的房间；点加入即可，无需交换邀请码或输入房间码。':'GitHub Pages 无法扫描 Wi-Fi 中其他浏览器的直连房间。请使用下方开服包，所有人打开同一个局域网网址后即可浏览并加入房间。'}</p><div class="coop-room-list"></div>`;
    this.status=root.querySelector('.coop-directory-status');this.list=root.querySelector('.coop-room-list');
  }
  async start(){
    if(!this.available){this.status.textContent='此页面是静态网站，不能自动发现局域网房间。请下载新版开服包，让所有人打开同一个开服网址。';return;}
    this.active=true;this.root.querySelector('[data-coop="browse"]').hidden=true;this.root.querySelector('[data-coop="browse-refresh"]').hidden=false;
    return this.refresh();
  }
  async refresh(){
    if(!this.active||this.loading)return;
    const generation=this.generation;clearTimeout(this.timer);this.loading=true;this.controller=new AbortController();
    const button=this.root.querySelector('[data-coop="browse-refresh"]');button.disabled=true;
    this.list.querySelectorAll?.('button').forEach(b=>b.disabled=true);this.status.textContent='正在读取在线房间…最多 5 秒';
    try{
      const rooms=await this.client.listRooms(this.controller.signal);
      if(!this.active||generation!==this.generation)return;
      this.list.innerHTML=roomCards(rooms);
      this.status.textContent=rooms.length?`${rooms.length} 个在线房间 · 每 5 秒自动刷新 · 仅显示当前开服地址上的房间`:'当前没有在线房间。让一位朋友点「创建房间」并保持页面打开；每 5 秒自动刷新。';
    }catch(err){if(this.active&&generation===this.generation){this.list.innerHTML='';this.status.textContent=`${err.message}。可点「刷新房间」重试。`;}}
    finally{
      if(generation===this.generation){this.loading=false;this.controller=null;button.disabled=false;if(this.active)this.timer=setTimeout(()=>{if(document.hidden){this.timer=setTimeout(()=>void this.refresh(),5000);return;}void this.refresh();},5000);}
    }
  }
  stop(){
    this.active=false;this.generation++;clearTimeout(this.timer);this.controller?.abort();this.controller=null;this.loading=false;this.list.innerHTML='';
    this.root.querySelector('[data-coop="browse"]').hidden=false;this.root.querySelector('[data-coop="browse-refresh"]').hidden=true;
  }
}
