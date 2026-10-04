import * as THREE from 'three';
import { LEVELS } from '../src/level/index.js';
import { Player } from '../src/player/player.js';
import { OrbitFollowCamera } from '../src/player/camera.js';
import { Enemy, STATE, setPlayerPosCache } from '../src/systems/enemy.js';
import { DoorManager } from '../src/systems/doors.js';
import { buildNavigationIndex } from '../src/systems/navigation.js';
import { Combat } from '../src/systems/combat.js';
import { Loadout, WEAPONS, applyWeaponModifiers } from '../src/systems/weapons.js';
import { GrenadeSystem } from '../src/systems/grenades.js';
import { Flashlight } from '../src/systems/flashlight.js';
import { EmergencyLights } from '../src/systems/lights.js';
import { LootContainerManager } from '../src/systems/loot-container.js';
import { PickupManager } from '../src/systems/pickups.js';
import { OpenableFurnitureManager } from '../src/systems/openable-furniture.js';
import { ARMOR_TYPES, ATTACHMENTS } from '../src/systems/loadout-config.js';
import { D } from '../src/difficulty.js';
import { ItemInstance } from '../src/systems/inventory.js';
import { LOOT_ITEMS } from '../src/data/loot-tables.js';
import { PLAYER, GRENADES, EXTRACTION, LOOT_SEARCH, grenadeInventory } from '../src/config.js';
import { normalizeItemInstance, seedQuickUseGrenade, syncEquipmentFromLoadout, mirrorPrimaryFromLoadout,
  openContainerSession, closeContainerSession, snapshotRaidInventory, restoreRaidInventory,
  transferItem, moveToSlot, splitStack, setQuickUseSlot, clearQuickUseSlot, placeIntoBackpack,
  getCarriedItems, consumeQuickUse, resolveSlot } from '../src/systems/raid-inventory.js';

const noop = () => {};
const vec = (v) => ({ x: v.x, y: v.y, z: v.z });
const distance = (a, b) => Math.hypot(a.x - b.x, a.y - b.y, a.z - b.z);
const ref = (r) => r && ['backpack','quickUse','container'].includes(r.container) && Number.isInteger(r.index) && r.index >= 0 && r.index < 32;

export function normalizeKit(raw = {}) {
  const armor = Object.hasOwn(ARMOR_TYPES, raw.armor) ? raw.armor : 'standard';
  const pistol = ['pistol', 'pistolFast'].includes(raw.pistol) ? raw.pistol : 'pistol';
  const grenade = Object.hasOwn(GRENADES, raw.grenade) ? raw.grenade : 'flash';
  const primary = (Array.isArray(raw.primary) ? raw.primary : []).slice(0, 2).map((it) => {
    if (!it || !Object.hasOwn(WEAPONS, it.defId) || WEAPONS[it.defId].slot !== 2) return null;
    const spec = WEAPONS[it.defId];
    return { defId: it.defId, ammo: Math.max(0, Math.min(spec.mag, Number.isFinite(it.ammo) ? Math.floor(it.ammo) : spec.mag)),
      reserve: Math.max(0, Math.min(spec.reserve, Number.isFinite(it.reserve) ? Math.floor(it.reserve) : spec.reserve)) };
  });
  const attachments = {};
  for (const weaponId of Object.keys(WEAPONS)) {
    attachments[weaponId] = {};
    for (const [slot, id] of Object.entries(raw.attachments?.[weaponId] ?? {}).slice(0, 8)) {
      const a = Object.hasOwn(ATTACHMENTS, id) ? ATTACHMENTS[id] : null;
      if (a && a.slot === slot && (!a.compatibleWeapons.length || a.compatibleWeapons.includes(weaponId))) attachments[weaponId][slot] = id;
    }
  }
  const risked = (Array.isArray(raw.risked) ? raw.risked : []).slice(0, 48).filter(id => typeof id === 'string' && id.length < 128);
  const validItem = it => {
    if (!it || typeof it.instanceId !== 'string' || !risked.includes(it.instanceId)) return null;
    const { slotKind, defId } = it;
    const valid = slotKind === 'grenade' ? Object.hasOwn(GRENADES, defId)
      : slotKind === 'material' ? Object.hasOwn(LOOT_ITEMS, defId)
      : slotKind === 'consumable' ? defId === 'medkit'
      : slotKind === 'attachment' ? Object.hasOwn(ATTACHMENTS, defId) : false;
    if (!valid) return null;
    const base = ItemInstance(slotKind, defId, { instanceId: it.instanceId, armorId: armor });
    base.quantity = Math.max(1, Math.min(base.stackMax, Number.isInteger(it.quantity) ? it.quantity : 1));
    base.payload.raidOrigin = 'loadout';base.payload.originId = it.instanceId;
    return base;
  };
  const seen = new Set();
  const supplies = (Array.isArray(raw.supplies) ? raw.supplies : []).slice(0, 24).map(validItem).filter(it => {
    if(!it || seen.has(it.instanceId)) return false; seen.add(it.instanceId); return true;
  });
  const primaryIds = (Array.isArray(raw.primaryIds) ? raw.primaryIds : []).slice(0, 2).map(id => risked.includes(id) ? id : null);
  return { armor, pistol, grenade, primary, primaryIds, risked, supplies, attachments };
}

function weaponMods(kit, id) {
  const m = {};
  for (const aid of Object.values(kit.attachments[id] ?? {})) {
    const e = ATTACHMENTS[aid].effects;
    for (const [key, target] of [['noise','noise'],['range','range'],['spread','spread'],['magCapacity','mag'],['reloadTimeMult','reload']]) m[target] = (m[target] ?? 0) + (e[key] ?? 0);
    for (const [key, targets] of [['recoilMult',['recoilKickMult','recoilClimbMult','recoilShakeMult']],['muzzleFlashMult',['muzzleFlashMult']],['adsTimeMult',['adsTimeMult']],['switchTimeMult',['switchTimeMult']]]) {
      for (const target of targets) m[target] = (m[target] ?? 1) * (1 + (e[key] ?? 0));
    }
  }
  return m;
}

export class CoopSimulation {
  constructor(map, members, raidId) {
    this.level = LEVELS.find((l) => l.id === map);
    if (!this.level) throw new Error('未知地图');
    this.raidId = raidId;
    this.time = 0;
    this.tick = 0;
    this.events = [];
    this.eventId = 0;
    this.members = new Map();
    this.world = this.level.build();
    this.scene = new THREE.Scene();
    this.doors = new DoorManager(this.scene, this.world, this.level.doors);
    this.doors.openAt(this.level.mainEntrance);
    this.navigation = buildNavigationIndex(this.world, this.level);
    this.world.navigation = this.navigation;
    this.doors.navigation = this.navigation;
    this.enemies = this.level.spawns.filter((s) => s.tier <= D().enemyTier).map((s) => new Enemy(this.world, s, { navigation: this.navigation, doors: this.doors }));
    this.pickups = new PickupManager(this.scene, this.world);
    this.pickupSeq = 0;
    for (const s of this.level.weapons ?? []) this.pickups.add('weapon', s, s);
    for (const s of this.level.medkits ?? []) this.pickups.add('medkit', s, {});
    this.boxes = new LootContainerManager(this.scene);
    for (const [i, s] of (this.level.lootContainers ?? []).entries()) {
      const c = this.boxes.add({ x: s.x, y: s.y, z: s.z }, s.tier);
      c.id = `box-${i}`;
    }
    this.furniture = new OpenableFurnitureManager(this.scene, this.world.furniture);
    this.lights = new EmergencyLights(this.scene, this.world);
    this.lights.scan();
    const fx = { tracer: (a,b,color) => this.event('tracer', { a: vec(a), b: vec(b), color }),
      muzzleFlash: noop, bloodMist: noop, impact: noop, bulletHole: noop, shell: noop,
      explosion: (p) => this.event('explosion', { pos: vec(p) }) };
    this.combat = new Combat(this.world, fx, { pop: noop }, this.enemies);
    this.combat.lights = this.lights;
    for (const e of this.enemies) e.lights = this.lights;
    this.combat.onPlayerHit = (dmg) => { if (this.target) this.hurt(this.target, dmg); };
    this.combat.onKill = (e) => { this.pickups.dropWeapon(e.pos, e.weapon.id, e.weapon.ammo, Math.floor(e.weapon.spec.reserve * .25) || 20); this.event('kill', { enemy: this.enemies.indexOf(e) }); };
    this.combat.onDoorHit = (x,y,z,dmg) => { const d=this.doors.atCell(x,z); if (d?.damage(dmg)) this.navigation.invalidateDoors(); };
    this.grenades = new GrenadeSystem(this.scene, this.world, fx, { pop: noop });
    this.grenades.onExplode = (pos, owner, spec) => {
      for (const e of this.enemies) {
        if (e.dead) continue;
        if (spec.blindSec && this.grenades.canBlind(pos,e.pos.x,e.eyeY,e.pos.z,spec)) e.blind(this.time,spec.blindSec);
        const dmg = this.grenades.damageAt(pos,e.pos.x,e.eyeY,e.pos.z,spec);
        if (dmg && e.takeDamage(dmg,'torso',new THREE.Vector3().subVectors(e.pos,pos).normalize(),'blast')) this.combat.onKill(e);
      }
      // 合作模式关闭队友伤害；爆炸仅保留投掷者自伤。
      const m = this.members.get(this.explodingOwner);
      if (m && !m.player.dead) this.hurt(m, this.grenades.damageAt(pos,m.player.pos.x,m.player.pos.y+1,m.player.pos.z,spec) * spec.selfDamageMul);
      for (const m of this.members.values()) {
        if (spec.blindSec && this.grenades.canBlind(pos,m.player.pos.x,m.player.pos.y+1,m.player.pos.z,spec)) this.event('blind', { player: m.id, ms: spec.playerFlashMs ?? 1200 });
      }
      this.combat.emitNoise(pos.x,pos.y,pos.z,spec.noise);
    };
    const explode = this.grenades.explode.bind(this.grenades);
    this.grenades.explode = g => { this.explodingOwner = g.ownerId; explode(g); this.explodingOwner = null; };
    for (const [i, member] of members.entries()) this.addMember(member, i);
    for(const p of this.pickups.items)p.netId=`pickup-${++this.pickupSeq}`;
  }

  addMember(member, index) {
    const kit = normalizeKit(member.kit);
    const fx = ARMOR_TYPES[kit.armor].effects;
    const mods = { ...fx, visualKit: kit.armor, armorMax: fx.armorMax ?? 200 };
    for(const aid of Object.values(kit.attachments[kit.pistol]??{})) {
      const mult=ATTACHMENTS[aid]?.effects?.moveSpeedMult;
      if(mult!==undefined)mods.moveSpeedMult=(mods.moveSpeedMult??1)*mult;
    }
    const p = new Player(this.world, this.level.spawn, mods);
    const sx = p.pos.x + (index % 2 ? 0.9 : -0.9), sz = p.pos.z + (index >= 2 ? 1 : 0);
    if (!p.body.blocked(this.world, sx, p.pos.y, sz)) { p.pos.x = sx; p.pos.z = sz; }
    p.blockers = this.enemies;
    const cam = new OrbitFollowCamera(this.world);
    const loadout = new Loadout({ pistolId: kit.pistol, maxPrimarySlots: 1 + (fx.weaponSlots ?? 0) });
    loadout.setPistol(kit.pistol, weaponMods(kit, kit.pistol));
    kit.primary.forEach((it,i) => { if(it && i<loadout.maxPrimarySlots) loadout.pickUpToSlot({weapon:it.defId,ammo:it.ammo,reserve:it.reserve},0,i+1); if(it && i<loadout.maxPrimarySlots)loadout.slots[i+1].spec=applyWeaponModifiers(WEAPONS[it.defId],weaponMods(kit,it.defId)); });
    syncEquipmentFromLoadout(p.raidInventory,loadout,{armorId:kit.armor,attachments:kit.attachments});
    for (let i=0;i<2;i++) {
      const it=p.raidInventory.equipment.primary[i];
      if(it && kit.primaryIds[i]){it.instanceId=kit.primaryIds[i];it.payload.originId=kit.primaryIds[i];it.payload.originOwner=member.id;}
    }
    for(const it of kit.supplies){
      const item=structuredClone(it);item.payload.originOwner=member.id;
      const placed=placeIntoBackpack(p.raidInventory,item);
      if(placed.remaining) throw new Error('带入物品超过背包容量');
    }
    const selectedGrenade=p.raidInventory.backpack.grenade.find(it=>it?.defId===kit.grenade);
    if(selectedGrenade)setQuickUseSlot(p.raidInventory,0,selectedGrenade);
    else seedQuickUseGrenade(p.raidInventory,'flash',grenadeInventory('flash',Math.max(0,D().grenades+(fx.grenadeBonus??0))));
    p.rig.setGun(kit.pistol);
    const m = { id: member.id, name: member.name, index, kit, player:p, cam, loadout,
      input:{seq:0,yaw:0,pitch:0,down:[],pressed:[],shoulder:1,firstPerson:false,panel:false}, pressed:new Set(), inputAt:0, ack:0, receivedSeq:0, status:'active',
      search:0, searchId:null, extract:0, fireStun:0, revision:0, outcome:null,stats:{shots:0,hits:0,headshots:0,kills:0} };
    m.flashlight=new Flashlight(this.scene,this.world);
    m.lampOn=true;
    this.members.set(member.id,m);
    return m;
  }
  event(type, data) { this.events.push({ id:++this.eventId, type, ...data }); if(this.events.length>100) this.events.shift(); }
  input(id, data) {
    const m=this.members.get(id);
    if(!m || m.status!=='active' || data.seq<=m.receivedSeq) return;
    m.receivedSeq=data.seq; m.input=data; m.inputAt=this.time;
    for(const a of data.pressed) m.pressed.add(a);
  }
  hurt(m, damage) {
    const r=m.player.applyDamage(Math.round(damage));
    if(!r.hpLost&&!r.armorLost) return;
    m.search=0; m.extract=0; m.fireStun=.3;
    this.event('hurt',{player:m.id});
    if(r.died) { m.player.rig.startDeath(0,1); this.finish(m,false); }
  }
  finish(m, success) {
    if(m.outcome) return m.outcome;
    m.status=success?'extracted':'dead';
    closeContainerSession(m.player.raidInventory);
    m.revision++;
    const raid=m.player.raidInventory;
    const tracked=new Set([...m.kit.primaryIds.filter(Boolean),...m.kit.supplies.map(it=>it.instanceId)]);
    const earned=getCarriedItems(raid);
    const kept=[...raid.equipment.primary,...raid.backpack.grenade,...raid.backpack.misc,...raid.quickUse].filter(Boolean);
    const returnedRiskItems=[];
    if(success)for(const id of tracked){
      const parts=kept.filter(it=>it.payload?.raidOrigin==='loadout'&&(it.payload?.originId??it.instanceId)===id);
      if(!parts.length)continue;
      const copy=structuredClone(parts[0]);copy.instanceId=id;copy.quantity=parts.reduce((sum,it)=>sum+it.quantity,0);
      const slot=raid.equipment.primary.indexOf(parts[0]);
      if(slot>=0&&m.loadout.slots[slot+1]){
        copy.payload.ammo=m.loadout.slots[slot+1].ammo;copy.payload.reserve=m.loadout.slots[slot+1].reserve;
      }
      returnedRiskItems.push(copy);
    }
    for(let i=0;i<2;i++){
      const it=raid.equipment.primary[i],w=m.loadout.slots[i+1];
      if(it&&w){it.payload.ammo=w.ammo;it.payload.reserve=w.reserve;}
    }
    for(const item of kept){
      if(item.payload?.raidOrigin==='loadout'&&item.payload.originOwner&&item.payload.originOwner!==m.id){
        const acquired=structuredClone(item);delete acquired.payload.raidOrigin;
        acquired.instanceId=`${this.raidId}-${m.id}-${item.instanceId}`;earned.push(acquired);
      }
    }
    m.outcome={ raidId:this.raidId,elapsed:this.time,stats:{...m.stats},returnedRiskItems, untrackedRiskIds:m.kit.risked.filter(id=>!tracked.has(id)),
      success,extracted:success&&earned.length>0,
      carriedLoot:success?structuredClone(earned):[],
      enemiesKilled:this.enemies.filter(e=>e.dead).length,clearBonus:this.enemies.every(e=>e.dead) };
    this.event('result',{player:m.id,success});
    return m.outcome;
  }
  disconnect(id) { const m=this.members.get(id); if(m) {m.input.down=[];m.pressed.clear();m.search=0;m.extract=0;} }
  abandon(id) { const m=this.members.get(id); if(m&&!m.outcome) {m.player.dead=true;this.finish(m,false);} }
  get active() { return [...this.members.values()].some(m=>m.status==='active'); }

  step(dt=1/30) {
    this.time+=dt; this.tick++;
    for(const m of this.members.values()) {
      if(m.status!=='active') continue;
      const p=m.player, data=m.input;
      const stale=this.time-m.inputAt>.4;
      const down=new Set(stale||data.panel?[]:data.down);
      const pressed=stale||data.panel?new Set():m.pressed;
      m.cam.yaw=data.yaw; m.cam.pitch=data.pitch; m.cam.firstPerson=data.firstPerson; m.cam.shoulder=data.shoulder;
      m.cam.aiming=down.has('aim');
      p.update(dt,{down:a=>down.has(a),justPressed:a=>pressed.has(a)},m.cam);
      m.cam.update(dt,{x:p.pos.x,z:p.pos.z,feetY:p.pos.y,height:p.body.height,leanAmt:p.leanAmt});
      m.fireStun=Math.max(0,m.fireStun-dt);
      m.loadout.update(this.time,dt);
      for(let i=0;i<3;i++) if(pressed.has(`weaponSlot${i}`)) m.loadout.switchTo(i,this.time);
      if(pressed.has('flashlight')) m.lampOn=!(m.lampOn??true);
      const direction=new THREE.Vector3();m.cam.cam.getWorldDirection(direction);
      m.flashlight.on=m.lampOn;m.flashlight.update(p.muzzle().pos,direction);
      const weapon=m.loadout.current;
      if(weapon) {
        p.rig.setGun(weapon.id);
        if(!data.panel&&!p.rolling&&this.time>=m.loadout.switchUntil&&m.fireStun<=0 && (weapon.spec.auto?down.has('fire'):pressed.has('fire'))) {
          const before={...this.combat.stats};
          if(this.combat.playerShoot(p,m.cam,weapon,this.time)){
            for(const k of Object.keys(m.stats))m.stats[k]+=this.combat.stats[k]-before[k];
            this.event('shot',{player:m.id,weapon:weapon.id});
          }
        }
        if(pressed.has('reload') || (weapon.isEmpty&&weapon.canReload)) weapon.startReload(this.time);
      }
      const nearDoor=this.doors.nearest(p.pos.x,p.pos.y+1,p.pos.z,2.2);
      const nearBox=this.boxes.nearest(p.pos.x,p.pos.y,p.pos.z);
      const seesBox=nearBox&&!this.world.lineBlocked(p.pos.x,p.pos.y+1,p.pos.z,nearBox.pos.x,nearBox.pos.y+.65,nearBox.pos.z);
      const atExit=Math.hypot(p.pos.x-this.level.spawn.x,p.pos.z-this.level.spawn.z)<EXTRACTION.radius;
      if(pressed.has('interact')&&!data.panel&&!nearDoor&&!nearBox&&!atExit){
        const furnishing=this.furniture.nearest(p.pos.x,p.pos.y,p.pos.z);
        if(furnishing)this.furniture.toggle(furnishing);
      }
      if(pressed.has('interact')&&!data.panel&&nearDoor) {
        if(!nearDoor.open || !nearDoor.blockedByActor([...this.enemies,...[...this.members.values()].map(x=>({pos:x.player.pos,dead:x.player.dead,height:x.player.body.height}))])) {
          nearDoor.toggle();this.navigation.invalidateDoors();this.event('door',{});
        }
      }
      if(down.has('interact')&&!nearDoor&&!data.panel&&m.fireStun<=0&&!p.rolling) {
        if(atExit&&p.horizSpeed<.25) {m.search=0;m.extract+=dt;if(m.extract>=EXTRACTION.holdSec)this.finish(m,true);}
        else if(seesBox) {
          m.extract=0;
          if(m.searchId!==nearBox.id){m.searchId=nearBox.id;m.search=0;}
          m.search+=dt;
          if(nearBox.opened||m.search>=LOOT_SEARCH.holdSec) {
            const firstOpen=!nearBox.opened;
            openContainerSession(p.raidInventory,nearBox);m.revision++;
            if(firstOpen)this.combat.emitNoise(nearBox.pos.x,nearBox.pos.y,nearBox.pos.z,LOOT_SEARCH.noise);
            if(!m.openSent){this.event('container',{player:m.id,box:nearBox.id});m.openSent=true;}
          }
        } else {m.search=0;m.searchId=null;m.extract=0;m.openSent=false;}
      } else { m.search=0;m.searchId=null;m.extract=0;m.openSent=false; }
      if(p.raidInventory.openContainer && distance(p.pos,p.raidInventory.openContainer.container.pos)>3) {closeContainerSession(p.raidInventory);m.revision++;}
      if(p.dead) this.finish(m,false);
      m.pressed.clear();m.ack=data.seq;
      if(m.status==='active')this.pickups.update(dt,p,m.loadout,this.time,()=>{m.revision++;});
    }
    const alive=[...this.members.values()].filter(m=>m.status==='active');
    for(const e of this.enemies) {
      if(!alive.length) break;
      const ordered=alive.slice().sort((a,b)=>distance(e.pos,a.player.pos)-distance(e.pos,b.player.pos));
      const candidate=ordered.find(m=>e.canSeePlayer(m.player,m.flashlight))??ordered[0];
      this.target=candidate;
      setPlayerPosCache(candidate.player.pos);
      const lamp=candidate.flashlight;
      e.update(dt,this.time,{player:candidate.player,flashlight:lamp,combat:this.combat,enemies:this.enemies,doors:this.doors});
      e.resolveOverlap(this.enemies,candidate.player);
    }
    this.target=null;
    this.doors.update(dt);this.grenades.update(dt);
    for(const p of this.pickups.items) p.netId??=`pickup-${++this.pickupSeq}`;
  }

  action(id, msg) {
    const m=this.members.get(id);
    if(!m || m.status!=='active') return {ok:false,reason:'当前已不在战局中'};
    const raid=m.player.raidInventory;
    if(this.time-m.inputAt>.6)return {ok:false,reason:'连接暂停，等待同步'};
    if(msg.type==='leave') {this.abandon(id);return {ok:true};}
    if(msg.type==='close-container') {closeContainerSession(raid);m.revision++;return {ok:true};}
    if(msg.type==='grenade') {
      const i=msg.index, it=raid.quickUse[i];
      if(this.time<(m.nextGrenadeAt??0))return {ok:false,reason:'投掷准备中'};
      if(!Number.isInteger(i)||!it||it.slotKind!=='grenade'||m.player.rolling||m.fireStun>0)return {ok:false,reason:'当前不能投掷'};
      const dir=new THREE.Vector3();m.cam.cam.getWorldDirection(dir);
      const pos=new THREE.Vector3(m.player.pos.x,m.player.pos.y+1.5,m.player.pos.z).addScaledVector(dir,.5);
      const g=this.grenades.throwFrom(pos,dir,true,it.defId);g.ownerId=id;
      m.nextGrenadeAt=this.time+.45;consumeQuickUse(raid,i);m.revision++;return {ok:true};
    }
    if(msg.type==='pickup') {
      const p=this.pickups.items.find(p=>p.netId===msg.id&&!p.taken);
      if(!p||distance(p.pos,m.player.pos)>2)return {ok:false,reason:'物品已被拿走或距离过远'};
      const slot=Number.isInteger(msg.slot)?msg.slot:undefined;
      const result=slot?this.pickups.takeWeaponToSlot(p,m.loadout,m.player,this.time,slot):this.pickups.takeWeaponAuto(p,m.loadout,m.player,this.time);
      if(result.ok){
        const mirror=mirrorPrimaryFromLoadout(raid,m.loadout,slot??m.loadout.active,{
          instanceId:p.payload.instanceId??`${this.raidId}-${p.netId}`,
          raidOrigin:p.payload.raidOrigin,
        });
        const current=raid.equipment.primary[(slot??m.loadout.active)-1];
        if(current&&p.payload.originId){
          current.payload.originId=p.payload.originId;current.payload.originOwner=p.payload.originOwner;
        }
        if(mirror.replaced){
          const dropped=this.pickups.items.at(-1);
          dropped.payload.instanceId=mirror.replaced.instanceId;
          dropped.payload.raidOrigin=mirror.replaced.payload?.raidOrigin;
          dropped.payload.originId=mirror.replaced.payload?.originId;dropped.payload.originOwner=mirror.replaced.payload?.originOwner;
        }
        m.revision++;
      }
      return {ok:!!result.ok,needChoice:!!result.needChoice,reason:result.needChoice?'主武器槽已满，请选择替换槽':result.reason};
    }
    if(msg.type!=='inventory') return {ok:false,reason:'未知操作'};
    if(msg.revision!==m.revision)return {ok:false,reason:'物品已更新，请重试'};
    const session=raid.openContainer;
    if(session && distance(session.container.pos,m.player.pos)>3)return {ok:false,reason:'距离容器过远'};
    let r={ok:false,reason:'无效物品操作'};
    const sel=msg.sel;
    if(msg.action==='take-all' && session) {
      let count=0;for(const it of [...session.items])if(transferItem(raid,'container','backpack',it).ok)count++;
      r={ok:count>0,reason:count?`已拿取 ${count} 件`:'背包已满'};
    } else if(msg.action==='drag' && ref(msg.from)&&ref(msg.to)) {
      const source=resolveSlot(raid,msg.from);
      if(source?.array[source.index]?.instanceId!==msg.instanceId)return {ok:false,reason:'物品位置已改变，请重新选择'};
      r=moveToSlot(raid,msg.from,msg.to,msg.quantity===undefined?{}:{quantity:msg.quantity});
    }
    else if(sel&&ref(sel)) {
      const loc=resolveSlot(raid,sel);
      if(msg.instanceId && loc?.array[loc.index]?.instanceId!==msg.instanceId)return {ok:false,reason:'物品位置已改变，请重新选择'};
      if(msg.action==='split')r=splitStack(raid,sel,msg.quantity);
      else if(sel.container==='container'&&msg.action==='quick-move')r=transferItem(raid,'container','backpack',msg.instanceId);
      else if(sel.container==='backpack'&&msg.action==='to-container')r=transferItem(raid,'backpack','container',msg.instanceId);
      else if(sel.container==='backpack'&&msg.action==='to-quickuse')r=setQuickUseSlot(raid,raid.quickUse.findIndex(i=>!i),msg.instanceId);
      else if(sel.container==='quickUse'&&msg.action==='discard')r=clearQuickUseSlot(raid,sel.index);
      else if(sel.container==='quickUse'&&msg.action==='use'){
        const it=raid.quickUse[sel.index];
        if(it?.slotKind==='grenade')return this.action(id,{type:'grenade',index:sel.index});
        if(it?.slotKind==='consumable'&&it.defId==='medkit'&&m.player.hp<m.player.hpMax){
          r=consumeQuickUse(raid,sel.index);if(r.ok)m.player.hp=Math.min(m.player.hpMax,m.player.hp+D().medkitHeal);
        }else r={ok:false,reason:'生命已满或该物品不能使用'};
      }
    }
    if(r.ok) {
      m.revision++;
      for(const other of this.members.values()) if(other!==m&&session&&other.player.raidInventory.openContainer?.id===session.id)other.revision++;
    }
    return {ok:!!r.ok,reason:r.reason??(r.ok?'物品已转移':'无法转移')};
  }

  snapshot(id) {
    const m=this.members.get(id);
    if(!m)return null;
    const ps=(m)=>({id:m.id,name:m.name,status:m.status,pos:vec(m.player.pos),yaw:m.cam.yaw,pitch:m.cam.pitch,
      hp:m.player.hp,armor:m.player.armor,hpMax:m.player.hpMax,armorMax:m.player.armorMax,
      height:m.player.body.height,stance:m.player.stance,speed:m.player.horizSpeed,rolling:m.player.rolling,
      armorId:m.kit.armor,weapon:m.loadout.current?.id,lamp:m.lampOn??true});
    return {tick:this.tick,time:this.time,raidId:this.raidId,ack:m.ack,
      players:[...this.members.values()].map(ps),
      enemies:this.enemies.map((e,i)=>({id:i,pos:vec(e.pos),yaw:e.yaw,hp:e.hp,dead:e.dead,state:e.state,alert:e.alertLevel,crouch:e.crouchAmt,armor:e.armor})),
      doors:this.doors.doors.map(d=>({open:d.open,hp:d.hp,destroyed:d.destroyed})),
      furniture:this.furniture.openables.map(e=>!!e.placement.open),
      lamps:this.lights.lamps.map(l=>({hp:l.hp,broken:l.broken})),
      boxes:this.boxes.containers.map(c=>({id:c.id,opened:c.opened,remaining:c.loot.length})),
      pickups:this.pickups.items.filter(p=>!p.taken).map(p=>({id:p.netId,kind:p.kind,pos:vec(p.pos),payload:p.payload})),
      grenades:this.grenades.items.map(g=>({pos:vec(g.pos),kind:g.kind})),
      inventory:{...snapshotRaidInventory(m.player.raidInventory),openContainer:m.player.raidInventory.openContainer?{
        id:m.player.raidInventory.openContainer.id,label:m.player.raidInventory.openContainer.label,capacity:m.player.raidInventory.openContainer.capacity,
        items:m.player.raidInventory.openContainer.items}:null},revision:m.revision,
      loadout:{active:m.loadout.active,switchRemaining:Math.max(0,m.loadout.switchUntil-this.time),maxPrimarySlots:m.loadout.maxPrimarySlots,slots:m.loadout.slots.map(w=>w?{id:w.id,spec:w.spec,ammo:w.ammo,reserve:w.reserve,reloading:w.reloading,reloadRemaining:Math.max(0,w.reloadUntil-this.time)}:null)},
      progress:m.extract>0?{kind:'extract',value:m.extract/EXTRACTION.holdSec}:m.search>0?{kind:'search',value:m.search/LOOT_SEARCH.holdSec}:null,
      stats:m.stats,outcome:m.outcome,events:this.events};
  }

  dispose() {
    const geo=new Set(),mat=new Set();
    const visit=(o)=>o?.traverse?.(n=>{if(n.geometry&&!n.geometry.userData?.shared)geo.add(n.geometry);if(n.material)for(const m of (Array.isArray(n.material)?n.material:[n.material]))mat.add(m);});
    visit(this.scene);visit(this.world.furniture?.group);
    for(const e of this.enemies)visit(e.rig.root);
    for(const m of this.members.values())visit(m.player.rig.root);
    for(const g of geo)g.dispose();for(const m of mat)m.dispose();
  }
}
