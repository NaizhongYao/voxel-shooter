import * as THREE from 'three';
import { BlockyRig } from '../player/rig.js';
import { INPUT_ACTIONS } from './protocol.js';
import { WEAPONS, WeaponInstance } from '../systems/weapons.js';
import { restoreRaidInventory } from '../systems/raid-inventory.js';
import { PLAYER, EXTRACTION, LIGHT } from '../config.js';
import { ARMOR_TYPES } from '../systems/loadout-config.js';

const emptyInput={down:()=>false,justPressed:()=>false};
const xyz=(p)=>({x:p.x,y:p.y,z:p.z});
export class CoopRuntime {
  constructor(client,ctx){
    this.client=client;this.ctx=ctx;this.snapshot=null;this.active=false;this.revision=-1;this.eventId=0;
    this.peers=new Map();this.netPickups=new Map();this.sendAt=0;this.pressed=new Set();this.poses=new Map();
    this.lastSnapshotAt=0;this.results=new Set();this.lastHud=0;this.projectiles=[];this.inventoryDirty=false;
  }
  receive(s){
    if(!s||s.tick<(this.snapshot?.tick??-1))return;
    const c=this.ctx,me=s.players.find(p=>p.id===this.client.credentials?.id);if(!me)return;
    const first=!this.active;this.active=true;this.lastSnapshotAt=performance.now();this.snapshot=s;
    c.game.started=true;c.game.startTime=performance.now()/1000-s.time;
    if(first){c.closeInventory({silent:true});c.game.over=false;}
    c.enter();
    if(first){c.audio.init();document.activeElement?.blur?.();}
    const sent=this.poses.get(s.ack);
    const goal=new THREE.Vector3(me.pos.x,me.pos.y,me.pos.z);
    if(sent&&!first){goal.x+=c.player.pos.x-sent.x;goal.z+=c.player.pos.z-sent.z;}
    if(first||Math.hypot(c.player.pos.x-goal.x,c.player.pos.z-goal.z)>3)Object.assign(c.player.pos,xyz(goal));
    else {c.player.pos.x+=(goal.x-c.player.pos.x)*.45;c.player.pos.z+=(goal.z-c.player.pos.z)*.45;if(Math.abs(me.pos.y-c.player.pos.y)>.6)c.player.pos.y=me.pos.y;}
    for(const key of this.poses.keys())if(key<=s.ack)this.poses.delete(key);
    c.player.hp=me.hp;c.player.armor=me.armor;c.player.hpMax=me.hpMax;c.player.armorMax=me.armorMax;
    if(me.status==='dead'&&!c.player.dead)c.player.rig.startDeath(0,1);
    c.player.dead=me.status==='dead';
    c.flashlight.on=me.lamp;c.flashlight.light.intensity=me.lamp?LIGHT.flashlight.intensity:0;c.flashlight.light.shadow.autoUpdate=me.lamp;
    if(first){
      c.player.loadoutModifiers={...c.player.loadoutModifiers,...ARMOR_TYPES[me.armorId]?.effects,visualKit:me.armorId};
      c.player.syncCarryCapacity();c.player.rig.setArmorKit(me.armorId);
    }
    c.loadout.maxPrimarySlots=s.loadout.maxPrimarySlots;c.loadout.active=s.loadout.active;
    if(s.loadout.switchRemaining)c.loadout.switchUntil=performance.now()/1000+s.loadout.switchRemaining;
    s.loadout.slots.forEach((w,i)=>{
      if(!w){c.loadout.slots[i]=null;return;}
      if(c.loadout.slots[i]?.id!==w.id)c.loadout.slots[i]=new WeaponInstance(WEAPONS[w.id]);
      const local=c.loadout.slots[i];if(w.spec)local.spec=w.spec;local.ammo=w.ammo;local.reserve=w.reserve;local.reloading=w.reloading;
      local.reloadUntil=performance.now()/1000+w.reloadRemaining;
    });
    c.player.rig.setGun(me.weapon);
    if(s.revision!==this.revision){
      this.revision=s.revision;
      const inv=c.player.raidInventory,box=s.inventory.openContainer;
      if(box){const model=c.lootContainers.containers.find(x=>x.netId===box.id);inv.openContainer={...box,items:[],container:model};}
      else inv.openContainer=null;
      restoreRaidInventory(inv,s.inventory);
      this.inventoryDirty=true;
      if(c.raidInventoryView.isOpen&&!c.raidInventoryView.drag){c.raidInventoryView.refresh();this.inventoryDirty=false;}
    }
    s.doors.forEach((d,i)=>{const local=c.doors.doors[i];if(!local)return;if(d.destroyed)local.destroy();else if(d.open!==local.open)local.setOpen(d.open);local.hp=d.hp;});
    s.furniture?.forEach((open,i)=>{const entry=c.openableFurniture.openables[i];if(entry&&!!entry.placement.open!==open)c.openableFurniture.toggle(entry.placement);});
    s.lamps.forEach((l,i)=>{const local=c.lights.lamps[i];if(local&&!local.broken&&l.broken)c.lights.damage(local,1e6);});
    s.boxes.forEach((b,i)=>{const local=c.lootContainers.containers[i];if(!local)return;local.netId=b.id;local.opened=b.opened;local._lidTarget=b.opened?-1.9:0;
      if(b.opened){local.strap.material.opacity=.12;local.loot.length=b.remaining;}});
    const pickupIds=new Set(s.pickups.map(p=>p.id));
    for(const [id,p] of this.netPickups)if(!pickupIds.has(id)){p.take();this.netPickups.delete(id);}
    if(first){for(const p of c.pickups.items)p.take();c.pickups.items=[];}
    for(const p of s.pickups)if(!this.netPickups.has(p.id)){const local=c.pickups.add(p.kind,p.pos,p.payload);local.netId=p.id;this.netPickups.set(p.id,local);}
    if(s.stats)Object.assign(c.combat.stats,s.stats);
    c.game.killed=s.enemies.filter(e=>e.dead).length;c.game.clearBonus=c.game.killed===s.enemies.length;
    if(first)this.eventId=s.events.at(-1)?.id??0;
    for(const e of s.events){if(e.id<=this.eventId)continue;this.eventId=e.id;this.event(e);}
    if(first&&s.inventory.openContainer&&!s.outcome)c.openInventory();
    c.syncVitals();c.syncCarry();
    if(s.outcome&&!this.results.has(s.raidId)){
      this.results.add(s.raidId);c.onResult(s.outcome);
    }
  }
  event(e){
    const c=this.ctx;
    if(e.type==='tracer')c.effects.tracer(new THREE.Vector3(e.a.x,e.a.y,e.a.z),new THREE.Vector3(e.b.x,e.b.y,e.b.z),e.color,.03);
    if(e.type==='explosion'){c.effects.explosion(new THREE.Vector3(e.pos.x,e.pos.y,e.pos.z),18);c.audio.explosion(Math.hypot(e.pos.x-c.player.pos.x,e.pos.z-c.player.pos.z));}
    if(e.type==='shot'){
      if(e.player!==this.client.credentials?.id){this.peers.get(e.player)?.rig.kick(.5);c.audio.shoot(WEAPONS[e.weapon]?.sound??'medium',10);}
    }
    if(e.type==='kill'){const enemy=c.enemies[e.enemy];if(enemy)c.effects.deathBurst(enemy.pos,0xe5484d,10);}
    if(e.type==='hurt'&&e.player===this.client.credentials?.id){c.game.damageFlash=1;c.audio.hurt(false);c.cam.kick(.4);}
    if(e.type==='blind'&&e.player===this.client.credentials?.id){c.game.playerFlash=1;c.game.playerFlashMs=e.ms;}
    if(e.type==='container'&&e.player===this.client.credentials?.id&&!this.snapshot.outcome)c.openInventory();
    if(e.type==='door')c.audio.door(true);
  }
  async action(action){
    const result=await this.client.action(action);
    if(result.reason)this.ctx.toast(result.reason,1500);
    return result;
  }
  inventory(action,sel=null,extra={}) {
    const c=this.ctx;const vm=c.raidInventoryView.getSelectedItem();
    void this.action({type:'inventory',action,sel:sel?{container:sel.container,index:sel.index}:null,
      instanceId:vm?.instanceId,revision:this.revision,...extra});
    return {ok:true,pending:true};
  }
  frame(dt,nowMs){
    const c=this.ctx,{player:p,input,cam,game}=c;const now=nowMs/1000;
    if(!this.snapshot)return;
    const me=this.snapshot.players.find(m=>m.id===this.client.credentials?.id);
    if(this.inventoryDirty&&c.raidInventoryView.isOpen&&!c.raidInventoryView.drag){c.raidInventoryView.refresh();this.inventoryDirty=false;}
    const live=me?.status==='active'&&this.client.connected&&nowMs-this.lastSnapshotAt<1800;
    if(input.justPressed('inventory')&&live){if(game.inventoryOpen)c.closeInventory();else c.openInventory();}
    if(input.justPressed('cancel')&&game.inventoryOpen)c.closeInventory();
    else if(input.justPressed('cancel')&&game.mapOpen)c.toggleMap();
    if(input.justPressed('map')&&!game.inventoryOpen)c.toggleMap();
    if(input.justPressed('minimap'))c.toggleMinimap();
    if(input.justPressed('viewToggle')){p.rig.setFirstPerson(cam.toggleView());}
    if(input.justPressed('shoulder'))cam.toggleShoulder();
    if(input.locked||input.down('fire')||input.down('aim'))c.audio.init();
    if(input.justPressed('mute'))c.audio.toggle();
    if(input.justPressed('music'))c.audio.toggleMusic();
    if(input.justPressed('debug'))c.hud.stats.style.display=c.hud.stats.style.display==='none'?'':'none';
    if(!game.inventoryOpen&&!c.quickWheel.isOpen&&input.justPressed('quickWheel')&&live)c.quickWheel.openWith(c.wheelItems());
    if(c.quickWheel.isOpen){
      c.quickWheel.updateFromMouse(input.mouseDX,input.mouseDY,nowMs);
      if(input.justClicked(2)||input.justPressed('cancel'))c.quickWheel.cancel();
      else if(input.releasedAny('quickWheel'))c.quickWheel.confirmSelection();
    }
    if(c.swapping()){
      if(input.justPressed('cancel'))c.closeWeaponSwap();
      else if(input.justPressed('weaponSlot0'))c.chooseWeaponSwap(1);
      else if(input.justPressed('weaponSlot1'))c.chooseWeaponSwap(2);
    }
    const panel=c.lobby.recoveryOpen||game.inventoryOpen||c.quickWheel.isOpen||game.over||c.swapping();
    if(panel&&input.down('fire'))this.heldFire=true;
    if(!input.down('fire'))this.heldFire=false;
    if(!panel&&live){cam.addMouse(input.mouseDX,input.mouseDY);cam.aiming=input.down('aim');}
    else cam.aiming=false;
    if (!p.dead && me?.status === 'active') p.update(dt,live&&!panel?input:emptyInput,cam);
    else if (p.dead) p.rig.updateDeath(dt);
    cam.update(dt,{x:p.pos.x,z:p.pos.z,feetY:p.pos.y,height:p.body.height,leanAmt:p.leanAmt});
    const dir=new THREE.Vector3();cam.cam.getWorldDirection(dir);c.flashlight.update(p.muzzle().pos,dir);
    c.loadout.update(now,dt);
    if(live&&!panel){
      for(const a of INPUT_ACTIONS)if(input.justPressed(a)&&!(a==='fire'&&this.heldFire))this.pressed.add(a);
      if(input.justPressed('grenade'))c.throwGrenade();
      const weapon=c.loadout.current;
      if(weapon&&!this.heldFire&&(weapon.spec.auto?input.down('fire'):input.justPressed('fire'))&&weapon.consume(now)){
        const muzzle=p.muzzle().pos;c.effects.muzzleFlash(muzzle,dir,weapon.spec.muzzleScale);c.flashPool.pop(muzzle.x,muzzle.y,muzzle.z);
        p.rig.kick(weapon.spec.recoil.kick);cam.kick(weapon.spec.recoil.shake);c.audio.shoot(weapon.spec.sound,0);
      }
    }else if(game.inventoryOpen&&input.justPressed('flashlight'))this.inventory('take-all');
    if(live&&nowMs-this.sendAt>=1000/30){
      this.sendAt=nowMs;this.client.input({yaw:cam.yaw,pitch:cam.pitch,firstPerson:cam.firstPerson,shoulder:cam.shoulder,
        panel,down:panel?[]:INPUT_ACTIONS.filter(a=>input.down(a)&&!(a==='fire'&&this.heldFire)),pressed:[...this.pressed]});
      this.pressed.clear();this.poses.set(this.client.seq,xyz(p.pos));if(this.poses.size>120)this.poses.delete(this.poses.keys().next().value);
    }
    this.renderActors(dt);
    this.snapshot.grenades.forEach((g,i)=>{
      let mesh=this.projectiles[i];
      if(!mesh){mesh=new THREE.Mesh(new THREE.BoxGeometry(.22,.22,.22),new THREE.MeshLambertMaterial({color:0xa6ba96}));this.projectiles[i]=mesh;c.scene.add(mesh);}
      mesh.visible=true;mesh.position.set(g.pos.x,g.pos.y,g.pos.z);mesh.rotation.x+=dt*5;
    });
    for(let i=this.snapshot.grenades.length;i<this.projectiles.length;i++)this.projectiles[i].visible=false;
    c.doors.update(dt);c.lootContainers.update(dt,now);c.lights.update(dt,p.pos.x,p.pos.y,p.pos.z);
    for(const x of this.netPickups.values())x.update(dt,now);
    const weapon=[...this.netPickups.values()].find(x=>x.kind==='weapon'&&Math.hypot(x.pos.x-p.pos.x,x.pos.z-p.pos.z)<1.6);
    if(weapon&&live&&!panel&&input.longPress('interact',.4)){
      void this.action({type:'pickup',id:weapon.netId}).then(r=>{if(r.needChoice)c.showWeaponSwap(weapon);});
    }
    let hint='';
    const nearDoor=c.doors.nearest(p.pos.x,p.pos.y+1,p.pos.z,2.2);
    const box=c.lootContainers.nearest(p.pos.x,p.pos.y,p.pos.z);
    const atExit=Math.hypot(p.pos.x-c.spawn.x,p.pos.z-c.spawn.z)<EXTRACTION.radius;
    if(!this.client.connected)hint='连接中断 · 自动重连中（60 秒内恢复）';
    else if(game.over)hint='你的行动已结束 · 队友仍可继续';
    else if(game.inventoryOpen)hint='Tab / Esc 关闭背包 · F 全部拿取';
    else if(nearDoor)hint=`E ${nearDoor.open?'关门':'开门'}`;
    else if(atExit)hint='长按 E 撤离 · 空手也可撤';
    else if(box)hint=box.opened?'E 搜刮物资箱':'长按 E 搜索物资箱';
    else if(weapon)hint=`长按 E 拾取 ${WEAPONS[weapon.payload.weapon]?.name??'武器'}`;
    c.hud.prompt.textContent=hint;c.hud.prompt.style.display=hint?'block':'none';
    const progress=live&&!panel?this.snapshot.progress:null;
    c.hud.holdProgress.style.display=progress?'block':'none';
    if(progress){c.hud.holdProgress.classList.toggle('extract',progress.kind==='extract');c.hud.holdProgressBar.style.width=`${Math.min(100,progress.value*100)}%`;}
    c.effects.update(dt);c.flashPool.update(dt);c.mesher.rebuildDirty();
    c.hud.damage.style.opacity=String(game.damageFlash*.55);game.damageFlash=Math.max(0,game.damageFlash-dt*2.6);
    game.playerFlash=Math.max(0,game.playerFlash-dt*1000/game.playerFlashMs);c.hud.flashWhite.style.opacity=String(game.playerFlash);
    c.updateWeapon(now);c.updateMap();
    c.hud.objectiveLabel.textContent='合作行动 · 可随时撤离';
    c.hud.enemies.textContent=`${p.carryCount} 件 · 庭院 ${Math.ceil(Math.hypot(p.pos.x-c.spawn.x,p.pos.z-c.spawn.z))} m`;
    if(nowMs-this.lastHud>300){this.lastHud=nowMs;c.lobby.updateHUD(this.snapshot);c.syncVitals();c.syncCarry();}
    c.hud.expose.style.opacity=c.indicators.maxAlert>.03?'1':'0';
    c.hud.exposeFill.style.width=`${Math.round(c.indicators.maxAlert*100)}%`;
    if(game.toastUntil>0&&now>game.toastUntil){c.hud.toast.style.opacity='0';game.toastUntil=0;}
    c.renderer.render(c.scene,cam.cam);
    if(game.over&&(input.justPressed('restart')||input.justPressed('backToBrief'))){this.client.send({type:'leave'});this.client.stop();location.href=location.pathname;}
  }
  renderActors(dt){
    const c=this.ctx;
    const alpha=1-Math.exp(-dt*16);
    for(const remote of this.snapshot.players){
      if(remote.id===this.client.credentials?.id)continue;
      let peer=this.peers.get(remote.id);
      if(!peer){
        const rig=new BlockyRig(0x4cc9f0,{isPlayer:true,kit:'player'});rig.setArmorKit(remote.armorId);rig.setGun(remote.weapon);
        rig.root.position.set(remote.pos.x,remote.pos.y,remote.pos.z);c.scene.add(rig.root);
        const label=document.createElement('div');label.className='coop-label';label.textContent=remote.name;c.hudRoot.append(label);
        peer={rig,label,weapon:remote.weapon};this.peers.set(remote.id,peer);
      }
      peer.rig.root.visible=remote.status!=='extracted';
      peer.rig.root.position.lerp(new THREE.Vector3(remote.pos.x,remote.pos.y,remote.pos.z),alpha);
      if(peer.weapon!==remote.weapon){peer.rig.setGun(remote.weapon);peer.weapon=remote.weapon;}
      if(remote.status==='dead'&&!peer.rig.deathAmt)peer.rig.startDeath(0,1);
      peer.rig.update(dt,{yaw:remote.yaw,pitch:remote.pitch,speed:remote.speed,crouchAmt:remote.stance==='crouch'?1:0});peer.rig.setLampOn(remote.lamp);
      const marker=new THREE.Vector3(remote.pos.x,remote.pos.y+2.5,remote.pos.z).project(c.cam.cam);
      peer.label.hidden=remote.status==='extracted'||marker.z<0||marker.z>1||Math.abs(marker.x)>1||Math.abs(marker.y)>1;
      peer.label.style.left=`${(marker.x+1)*50}%`;peer.label.style.top=`${(1-marker.y)*50}%`;
      peer.label.textContent=`${remote.name} · ${remote.status==='dead'?'阵亡':`${remote.hp} HP`}`;
    }
    for(const remote of this.snapshot.enemies){
      const e=c.enemies[remote.id];if(!e)continue;
      if(remote.dead&&!e.dead)e.rig.startDeath(0,1);
      e.dead=remote.dead;e.hp=remote.hp;e.armor=remote.armor;e.state=remote.state;e.alertLevel=remote.alert;e.yaw=remote.yaw;
      e.pos.lerp(new THREE.Vector3(remote.pos.x,remote.pos.y,remote.pos.z),alpha);
      e.rig.root.position.copy(e.pos);e.rig.setLampOn(!e.dead);
      if(e.dead)e.rig.updateDeath(dt);else e.rig.update(dt,{yaw:e.yaw,crouchAmt:remote.crouch,speed:1});
    }
    c.indicators.update(c.cam.cam.position,performance.now()/1000,dt,false,c.cam.yaw);
    c.enemyLights.update(c.enemies,c.player.pos,performance.now()/1000);
  }
}
