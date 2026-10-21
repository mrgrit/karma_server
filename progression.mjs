// Pure rules and host authority are separate from the temporary LAN disk adapter.
import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import crypto from 'node:crypto';

export const DEFAULT_RANKS=Object.freeze([
  {id:'recruit',minXp:0,budgetBonus:0},
  {id:'private',minXp:100,budgetBonus:100},
  {id:'corporal',minXp:300,budgetBonus:200},
  {id:'sergeant',minXp:600,budgetBonus:300},
  {id:'lieutenant',minXp:1000,budgetBonus:400},
].map(Object.freeze));
export const EMPTY_SLOT=255;
const clone=value=>structuredClone(value);
const fail=message=>{throw new TypeError(message);};
function int(value,name,min=0,max=Number.MAX_SAFE_INTEGER){
  if(!Number.isSafeInteger(value)||value<min||value>max)fail('Invalid '+name);
  return value;
}
function id(value,name){
  if(typeof value!=='string'||!/^[a-zA-Z0-9_.:-]{1,96}$/.test(value))fail('Invalid '+name);
  return value;
}
function vector(value){
  if(!Array.isArray(value)||value.length!==3||value.some(x=>!Number.isFinite(x)||Math.abs(x)>1e7))fail('Invalid position');
  return [...value];
}
function key(...parts){return crypto.createHash('sha256').update(JSON.stringify(parts)).digest('hex');}
function ammo(value){
  if(!value||typeof value!=='object')fail('Invalid ammunition');
  return {magazine:int(value.magazine,'magazine',0,65535),reserve:int(value.reserve,'reserve',0,65535)};
}
function inventory(value,spawn=false){
  if(!Array.isArray(value)||value.length<1||value.length>52||(spawn&&value.length!==7))fail(spawn?'Spawn inventory must contain seven slots':'Invalid inventory length');
  const result=value.map(x=>int(x,'weapon',0,255)),used=new Set();
  for(const weapon of result){
    if(weapon===EMPTY_SLOT)continue;
    if(weapon>51||used.has(weapon))fail('Invalid or duplicate inventory weapon');
    used.add(weapon);
  }
  return result;
}
function ranksValue(ranks){
  if(!Array.isArray(ranks)||!ranks.length||ranks[0].minXp!==0)fail('Invalid rank table');
  let previous=-1;
  for(const rank of ranks){
    if(rank.id!==undefined)id(rank.id,'rank');
    else if(typeof rank.name!=='string'||!rank.name.length||rank.name.length>64)fail('Invalid rank name');
    int(rank.minXp,'rank XP');int(rank.budgetBonus,'rank bonus',0,100000);
    if(rank.minXp<=previous)fail('Ranks must be ordered by XP');
    previous=rank.minXp;
  }
  return ranks;
}
export function rankForXp(xp,ranks=DEFAULT_RANKS){
  int(xp,'XP');ranksValue(ranks);
  return {...ranks.filter(rank=>xp>=rank.minXp).at(-1)};
}
export function loadoutBudget({xp=0,character,ranks=DEFAULT_RANKS}){
  const base=int(character?.inventoryCapacity,'character inventory capacity',0,100000);
  return base+rankForXp(xp,ranks).budgetBonus;
}
export function characterUnlocked(character,xp=0){
  int(xp,'XP');
  return xp>=int(character?.unlockXp??0,'character unlock XP');
}
export function validateLoadout({inventory:slots,selectedWeapon,xp=0,character,weapons,ranks=DEFAULT_RANKS,checkRole=true,spawn=true,slotRules, constraints}){
  const list=inventory(slots,spawn),catalog=new Map(weapons.map(item=>[item.weaponId??item.id,item]));
  if(!characterUnlocked(character,xp))fail('Character is locked until '+character.unlockXp+' XP');
  const budget=loadoutBudget({xp,character,ranks});
  let cost=0;
  for(const weapon of list){
    if(weapon===EMPTY_SLOT)continue;
    const item=catalog.get(weapon);
    if(!item)fail('Unknown weapon '+weapon);
    if(character.age!==undefined&&item.age!==undefined&&character.age!==item.age)fail('Weapon era mismatch');
    if(checkRole&&Array.isArray(character.allowedWeaponIds)&&!character.allowedWeaponIds.includes(weapon))fail('Weapon is unavailable to this character');
    cost+=int(item.inventoryCost,'weapon inventory cost',0,100000);
  }
  if(!list.includes(selectedWeapon)||selectedWeapon===EMPTY_SLOT)fail('Selected weapon must be owned');
  if(spawn&&catalog.get(selectedWeapon)?.selectableAsStartingWeapon===false)fail('Item cannot be selected as a starting weapon');
  if(spawn&&slotRules){
    for(const rule of slotRules){
      const weapon=list[int(rule.index,'slot index',0,6)];
      if(weapon===EMPTY_SLOT){if(!rule.optional&&!character.optionalSlots?.includes(rule.key))fail('Required inventory slot is empty');continue;}
      if(!rule.allowedIds.includes(weapon))fail('Weapon is unavailable in this slot');
      const allowed=character.allowedIdsBySlot?.[rule.key];
      if(checkRole&&allowed&&!allowed.includes(weapon))fail('Weapon is unavailable to this character role');
    }
  }
  if(constraints?.heavyCombination){
    const heavy=constraints.heavyCombination;
    if(list.some(weapon=>heavy.primaryIds.includes(weapon))&&list.some(weapon=>heavy.specialIds.includes(weapon)))fail('Heavy weapon combination is unavailable');
  }
  if(constraints?.dualCannon){
    const dual=constraints.dualCannon,cannons=list.filter(weapon=>dual.cannonIds.includes(weapon));
    if(cannons.length>dual.maxCannons)fail('Too many cannons');
    if(spawn&&dual.cannonIds.includes(list[dual.secondarySlot])&&cannons.length!==2)
      fail('Secondary cannon slot requires the dual cannon loadout');
    if(cannons.length===2){
      if(character.role!==dual.role||xp<dual.minXp)fail('Dual cannon requires heavy class and '+dual.minXp+' XP');
      const allowed=new Set([...dual.cannonIds,...dual.lightAutomaticIds,...dual.utilityIds]);
      if(list.some(weapon=>weapon!==EMPTY_SLOT&&!allowed.has(weapon)))fail('Dual cannon requires sacrificing other equipment');
      if(list.filter(weapon=>dual.lightAutomaticIds.includes(weapon)).length>1)fail('Dual cannon allows only one light automatic weapon');
    }
  }
  if(cost>budget)fail('Inventory exceeds budget');
  return {inventory:list,selectedWeapon,cost,budget,remaining:budget-cost,rank:rankForXp(xp,ranks)};
}

function damageValue(value){
  const damage={
    id:id(value.id,'damage ID'),victimId:id(value.victimId,'victim ID'),
    victimLife:int(value.victimLife,'victim life',1),
    attackerId:value.attackerId===null?null:id(value.attackerId,'attacker ID'),
    attackerLife:value.attackerId===null?null:int(value.attackerLife,'attacker life',1),
    weapon:int(value.weapon,'damage weapon',-1,51),
    before:int(value.before,'native HP before',1,10000),
    after:int(value.after,'native HP after',-100000,10000),
  };
  if(damage.after>=damage.before)fail('Native damage must reduce HP');
  return damage;
}
function validLethalDamage(damage,death){
  return !!damage&&damage.victimId===death.victimId&&damage.victimLife===death.victimLife&&
    damage.after<=0&&damage.before>0&&damage.attackerId!==null&&
    damage.attackerId!==death.victimId&&damage.attackerId===death.killerId&&damage.weapon===death.weapon;
}

/** Victim-native damage receipts authorize XP; a wire death alone never does.
 * Call sourcePlayerId with the identity bound to that socket, not a packet field.
 * Keep one instance for the host match. Restore its snapshot if resuming it.
 */
export class CombatLedger{
  constructor({matchId,playerIds,snapshot}){
    this.matchId=id(matchId,'match ID');
    this.players=[...new Set(playerIds.map(x=>id(x,'player ID')))];
    if(this.players.length<2||this.players.length>(snapshot?512:8))fail('A LAN match requires two to eight active players');
    this.damage=new Map();this.deaths=new Map();this.lifeWatermarks=new Map();
    if(snapshot){
      if(snapshot.matchId!==this.matchId||JSON.stringify(snapshot.playerIds)!==JSON.stringify(this.players))fail('Combat snapshot identity mismatch');
      for(const entry of snapshot.damage)this.damage.set(entry[0],damageValue(entry[1]));
      for(const receipt of snapshot.deaths){
        validateDeathReceipt(receipt);
        if(receipt.matchId!==this.matchId||!this.players.includes(receipt.victimId))fail('Invalid saved death');
        this.deaths.set(receipt.id,clone(receipt));
        this.lifeWatermarks.set(receipt.victimId,Math.max(this.lifeWatermarks.get(receipt.victimId)||0,receipt.victimLife));
      }
    }
  }
  participant(playerId){if(!this.players.includes(playerId))fail('Unknown player');}
  addParticipant(playerId){
    id(playerId,'player ID');
    if(this.players.includes(playerId))return;
    // Eight is the simultaneous native roster limit; a running deathmatch
    // may have more distinct participants as vacant slots are reused.
    if(this.players.length>=512)fail('Match participant history is full');
    this.players.push(playerId);
  }
  recordDamage(sourcePlayerId,value){
    this.participant(sourcePlayerId);
    const damage=damageValue(value);
    if(damage.victimId!==sourcePlayerId)fail('Only the victim can confirm native HP loss');
    if(damage.attackerId!==null)this.participant(damage.attackerId);
    if(damage.victimLife<=(this.lifeWatermarks.get(sourcePlayerId)||0))return {accepted:false,reason:'finished-life'};
    const damageKey=key(this.matchId,damage.victimId,damage.victimLife,damage.id);
    if(this.damage.has(damageKey)){
      if(JSON.stringify(this.damage.get(damageKey))!==JSON.stringify(damage))fail('Conflicting damage receipt');
      return {accepted:false,reason:'duplicate',damageId:damage.id};
    }
    this.damage.set(damageKey,damage);
    return {accepted:true,damageId:damage.id};
  }
  confirmDeath(sourcePlayerId,{life,killer,weapon,damageId=null,hpAfter}){
    this.participant(sourcePlayerId);int(life,'death life',1);int(weapon,'death weapon',-1,51);
    int(hpAfter,'native death HP',-100000,0);
    if(!['remote','self','environment'].includes(killer))fail('Invalid death classification');
    const deathId=key(this.matchId,sourcePlayerId,life),prior=this.deaths.get(deathId);
    if(prior)return {accepted:false,reason:'duplicate',receipt:clone(prior)};
    if(life<=(this.lifeWatermarks.get(sourcePlayerId)||0))return {accepted:false,reason:'stale-life',receipt:null};
    const damage=damageId===null?null:this.damage.get(key(this.matchId,sourcePlayerId,life,id(damageId,'damage ID')));
    const receipt={id:deathId,matchId:this.matchId,victimId:sourcePlayerId,victimLife:life,
      killerId:killer==='remote'?(damage?.attackerId??(this.players.length===2?this.players.find(player=>player!==sourcePlayerId):null)):killer==='self'?sourcePlayerId:null,
      killer,weapon,hpAfter,damage:damage?clone(damage):null,verified:false};
    receipt.verified=killer==='remote'&&validLethalDamage(damage,receipt);
    this.deaths.set(deathId,receipt);this.lifeWatermarks.set(sourcePlayerId,life);
    // Finished-life proof is preserved inside its immutable death receipt.
    for(const [entry,proof] of this.damage)if(proof.victimId===sourcePlayerId&&proof.victimLife<=life)this.damage.delete(entry);
    return {accepted:true,receipt:clone(receipt)};
  }
  snapshot(){return {matchId:this.matchId,playerIds:[...this.players],damage:[...this.damage].map(clone),deaths:[...this.deaths.values()].map(clone)};}
}

function validateDeathReceipt(receipt){
  id(receipt.matchId,'match ID');id(receipt.victimId,'victim ID');int(receipt.victimLife,'victim life',1);
  if(receipt.id!==key(receipt.matchId,receipt.victimId,receipt.victimLife))fail('Invalid death ID');
  if(receipt.killerId!==null)id(receipt.killerId,'killer ID');
  if(!['remote','self','environment'].includes(receipt.killer))fail('Invalid killer');
  int(receipt.weapon,'death weapon',-1,51);int(receipt.hpAfter,'death HP',-100000,0);
  if(typeof receipt.verified!=='boolean')fail('Invalid death verification');
  if(receipt.damage)damageValue(receipt.damage);
  if(receipt.verified&&(receipt.killer!=='remote'||!validLethalDamage(receipt.damage,receipt)))fail('Missing native lethal damage proof');
  return receipt;
}

export function newProgressProfile(playerId=crypto.randomUUID()){
  return {version:1,playerId:id(playerId,'player ID'),xp:0,kills:0,deaths:0,seenLives:{}};
}
function profileValue(profile){
  if(profile?.version!==1)fail('Unsupported progress profile');
  id(profile.playerId,'player ID');int(profile.xp,'XP');int(profile.kills,'kills');int(profile.deaths,'deaths');
  if(!profile.seenLives||typeof profile.seenLives!=='object'||Array.isArray(profile.seenLives))fail('Invalid processed lives');
  for(const [entry,life] of Object.entries(profile.seenLives)){
    if(!/^[0-9a-f]{64}$/.test(entry))fail('Invalid processed life key');
    int(life,'processed life',1);
  }
  return clone(profile);
}
/** Storage-independent reducer. Future central service can use the same rules. */
export function applyDeathToProfile(profile,receipt){
  const next=profileValue(profile);validateDeathReceipt(receipt);
  if(next.playerId!==receipt.victimId&&next.playerId!==receipt.killerId)return {changed:false,reason:'unrelated',xpGained:0,profile:next};
  const lifeKey=key(receipt.matchId,receipt.victimId);
  if((next.seenLives[lifeKey]||0)>=receipt.victimLife)return {changed:false,reason:'duplicate',xpGained:0,profile:next};
  next.seenLives[lifeKey]=receipt.victimLife;
  let xpGained=0;
  if(next.playerId===receipt.victimId){next.deaths++;if(receipt.verified)xpGained=5;}
  else if(receipt.verified){next.kills++;xpGained=25;}
  next.xp+=xpGained;int(next.xp,'XP');
  return {changed:true,xpGained,profile:next};
}
export function defaultProgressPath(){
  return path.join(process.env.LOCALAPPDATA||path.join(os.homedir(),'.local','share'),'KarmaLAN','progress.json');
}
export function atomicWriteJson(filename,value){
  const absolute=path.resolve(filename);fs.mkdirSync(path.dirname(absolute),{recursive:true});
  const temporary=absolute+'.'+process.pid+'.'+crypto.randomUUID()+'.tmp';
  let descriptor;
  try{
    descriptor=fs.openSync(temporary,'wx',0o600);
    fs.writeFileSync(descriptor,JSON.stringify(value,null,2)+'\n','utf8');
    fs.fsyncSync(descriptor);fs.closeSync(descriptor);descriptor=undefined;
    fs.renameSync(temporary,absolute);
  }catch(error){
    if(descriptor!==undefined)fs.closeSync(descriptor);
    try{fs.unlinkSync(temporary);}catch{}
    throw error;
  }
}
/** One runtime owns this local file. Copy game folders without copying AppData. */
export class FileProgressStore{
  constructor(filename=defaultProgressPath()){
    this.filename=path.resolve(filename);
    if(!fs.existsSync(this.filename))atomicWriteJson(this.filename,newProgressProfile());
    this.read(); // Preserve an invalid existing file and fail, never reset its XP.
  }
  read(){return profileValue(JSON.parse(fs.readFileSync(this.filename,'utf8').replace(/^\uFEFF/,'')));}
  applyDeath(receipt){
    const result=applyDeathToProfile(this.read(),receipt);
    if(result.changed)atomicWriteJson(this.filename,result.profile);
    return result;
  }
}

/** Host-only drop ownership. Claim requests use the host's latest trusted
 * native player snapshot. Identical request IDs replay the same grant.
 */
export class DropLedger{
  constructor({matchId,playerIds,maxDistance=250,snapshot}){
    this.matchId=id(matchId,'match ID');this.players=[...new Set(playerIds.map(x=>id(x,'player ID')))];
    if(this.players.length<2||this.players.length>(snapshot?512:8)||!Number.isFinite(maxDistance)||maxDistance<=0||maxDistance>10000)fail('Invalid drop authority');
    this.maxDistance=maxDistance;this.drops=new Map();this.requests=new Map();this.manualRequests=new Map();
    if(snapshot){
      if(snapshot.matchId!==this.matchId||JSON.stringify(snapshot.playerIds)!==JSON.stringify(this.players))fail('Drop snapshot identity mismatch');
      // Snapshot is host-owned local state, never accepted directly from a peer.
      for(const entry of snapshot.drops)this.drops.set(entry.id,clone(entry));
      for(const [request,value] of snapshot.requests)this.requests.set(request,clone(value));
      for(const [request,value] of snapshot.manualRequests??[])this.manualRequests.set(request,clone(value));
    }
  }
  addParticipant(playerId){
    id(playerId,'player ID');
    if(this.players.includes(playerId))return;
    if(this.players.length>=512)fail('Match participant history is full');
    this.players.push(playerId);
  }
  createDeathDrop(receipt,{selectedWeapon,magazine,reserve,pos,sector}){
    validateDeathReceipt(receipt);
    if(receipt.matchId!==this.matchId||!this.players.includes(receipt.victimId))fail('Death belongs to another match');
    int(selectedWeapon,'dropped weapon',0,51);int(sector,'drop sector',0,65535);
    const dropId='drop-'+receipt.id.slice(0,40);
    if(this.drops.has(dropId))return {created:false,drop:clone(this.drops.get(dropId))};
    const drop={id:dropId,matchId:this.matchId,ownerId:receipt.victimId,ownerLife:receipt.victimLife,
      weapon:selectedWeapon,...ammo({magazine,reserve}),pos:vector(pos),sector,claimedBy:null,grant:null};
    this.drops.set(dropId,drop);
    return {created:true,drop:clone(drop)};
  }
  dropWeapon(playerId,{requestId,life,weapon,magazine,reserve},{state,weapons}){
    if(!this.players.includes(playerId))fail('Unknown player');
    id(requestId,'request ID');int(life,'player life',1);int(weapon,'dropped weapon',0,51);
    const remaining=ammo({magazine,reserve}),requestKey=key(this.matchId,playerId,requestId);
    const deny=reason=>({granted:false,reason});
    if(state.life!==life||!(state.hp>0))return deny('dead-or-stale-life');
    const prior=this.manualRequests.get(requestKey);
    if(prior){
      if(prior.life!==life||prior.weapon!==weapon||prior.drop.magazine!==magazine||prior.drop.reserve!==reserve)return deny('conflicting-request');
      return {granted:true,duplicate:true,grant:clone(prior)};
    }
    const slots=inventory(state.inventory),removeSlot=slots.indexOf(weapon),catalog=new Map(weapons.map(item=>[item.weaponId??item.id,item]));
    if(removeSlot<0||state.selectedWeapon!==weapon)return deny('weapon-not-selected');
    if(weapon===0||catalog.get(weapon)?.isWeapon!==true)return deny('cannot-drop-item');
    const latest=state.ammo?.[weapon];
    if(!latest||latest.magazine!==magazine||latest.reserve!==reserve)return deny('ammo-changed');
    int(state.sector,'drop sector',0,65535);
    slots[removeSlot]=EMPTY_SLOT;
    let selectedWeapon=slots.find(item=>item!==0&&catalog.get(item)?.isWeapon===true);
    if(selectedWeapon===undefined){selectedWeapon=0;if(!slots.includes(0))slots[removeSlot]=0;}
    const drop={id:'manual-'+requestKey.slice(0,40),matchId:this.matchId,ownerId:playerId,ownerLife:life,
      weapon,...remaining,pos:vector(state.pos),sector:state.sector,claimedBy:null,grant:null};
    const grant={id:requestId,requestId,matchId:this.matchId,playerId,life,weapon,removeSlot,selectedWeapon,inventory:slots,drop};
    this.drops.set(drop.id,drop);this.manualRequests.set(requestKey,clone(grant));
    return {granted:true,duplicate:false,grant:clone(grant)};
  }
  claimDrop(playerId,{dropId,requestId,life},{state,character,xp,weapons,ranks=DEFAULT_RANKS,constraints}){
    if(!this.players.includes(playerId))fail('Unknown claimant');
    id(dropId,'drop ID');id(requestId,'request ID');int(life,'claimant life',1);
    const requestKey=key(this.matchId,playerId,requestId),prior=this.requests.get(requestKey);
    if(prior){
      if(prior.dropId!==dropId||prior.life!==life)fail('Conflicting pickup request ID');
      return {granted:true,duplicate:true,grant:clone(prior)};
    }
    const deny=reason=>({granted:false,reason});
    const drop=this.drops.get(dropId);
    if(!drop)return deny('unknown-drop');
    if(drop.claimedBy!==null)return deny('already-claimed');
    if(state.life!==life||!(state.hp>0))return deny('dead-or-stale-life');
    const pos=vector(state.pos);
    if(Math.hypot(...pos.map((n,i)=>n-drop.pos[i]))>this.maxDistance)return deny('out-of-range');
    const slots=inventory(state.inventory);
    if(slots.includes(drop.weapon))return deny('weapon-already-owned');
    let replaceSlot=slots.indexOf(EMPTY_SLOT);
    if(replaceSlot<0)replaceSlot=slots.length;
    if(replaceSlot>=52)return deny('inventory-full');
    const replacedWeapon=slots[replaceSlot]??EMPTY_SLOT;slots[replaceSlot]=drop.weapon;
    try{
      // A single enemy weapon may cross class restrictions. Two-cannon and
      // machine-gun/launcher limits still apply to the entire resulting inventory.
      validateLoadout({inventory:slots,selectedWeapon:drop.weapon,xp,character,weapons,ranks,constraints,checkRole:false,spawn:false});
    }catch(error){return deny('loadout: '+error.message);}
    const grant={id:'grant-'+key(this.matchId,dropId,playerId,life).slice(0,40),
      matchId:this.matchId,dropId,requestId,playerId,life,
      weapon:drop.weapon,magazine:drop.magazine,reserve:drop.reserve,replaceSlot,replacedWeapon};
    drop.claimedBy=playerId;drop.grant=grant;this.requests.set(requestKey,grant);
    return {granted:true,duplicate:false,grant:clone(grant)};
  }
  snapshot(){return {matchId:this.matchId,playerIds:[...this.players],drops:[...this.drops.values()].map(clone),requests:[...this.requests].map(clone),manualRequests:[...this.manualRequests].map(clone)};}
}

/** Native adapter writes only this weapon record after a successful result.
 * Retain appliedIds for the whole match, including reconnects. No ammo addition.
 */
export function applyPickupGrant(state,grant,{playerId,matchId,appliedIds}){
  if(grant.playerId!==playerId||grant.matchId!==matchId)fail('Pickup grant identity mismatch');
  id(grant.id,'grant ID');int(grant.life,'grant life',1);
  if(appliedIds.has(grant.id))return {changed:false,reason:'duplicate',state};
  if(state.life!==grant.life||!(state.hp>0))return {changed:false,reason:'dead-or-stale-life',state};
  const slots=inventory(state.inventory),slot=int(grant.replaceSlot,'replacement slot',0,51);
  const weapon=int(grant.weapon,'pickup weapon',0,51),remaining=ammo(grant);
  if(slot>slots.length||(slots[slot]??EMPTY_SLOT)!==grant.replacedWeapon)return {changed:false,reason:'inventory-changed',state};
  if(slots.some((value,index)=>index!==slot&&value===weapon))return {changed:false,reason:'inventory-changed',state};
  const next=clone(state);next.inventory=slots;next.inventory[slot]=weapon;
  next.selectedWeapon=weapon;next.ammo={...next.ammo};
  if(grant.replacedWeapon!==EMPTY_SLOT&&grant.replacedWeapon!==weapon)delete next.ammo[grant.replacedWeapon];
  next.ammo[weapon]=remaining;
  appliedIds.add(grant.id);
  return {changed:true,state:next};
}
