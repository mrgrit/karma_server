import {validateRules,GAME_RULES} from './rules.mjs';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import crypto from 'node:crypto';
import net from 'node:net';
import {startKarmaServer} from './server.mjs';

const temp=fs.mkdtempSync(path.join(os.tmpdir(),'karma-late-join-')),clients=[];
const balances=new Map(),pendingPayments=new Map();let charges=0,refunds=0,gate=null,failCharge=false,resume;
const exchange={publicUrl:'https://exchange.test.invalid',
  wallet:async p=>({balances:[{symbol:'KARMA',available:balances.get(p.playerId)??300}],locked:{}}),
  async charge(id,players){charges++;if(gate)await gate;
    if(failCharge)throw Object.assign(Error('코인 부족'),{code:'INSUFFICIENT_FUNDS'});
    for(const p of players)balances.set(p.playerId,(balances.get(p.playerId)??300)-100);
    pendingPayments.set(id,players);return {matchId:id,fee:100};},
  async refund(id){refunds++;for(const p of pendingPayments.get(id)||[])balances.set(p.playerId,balances.get(p.playerId)+100);pendingPayments.delete(id);},
  confirm(id){pendingPayments.delete(id);},
};
const mapFile=path.join(temp,'maps.json');
fs.writeFileSync(mapFile,JSON.stringify({maps:[
  {id:'winter',name:'Mass of Winter',mapIndex:0,age:0,nativeMode:1,publicReady:true},
  {id:'rescue',name:'Rescue',mapIndex:4,age:0,nativeMode:1,publicReady:true},
  {id:'factory',name:'Factory',mapIndex:7,age:0,nativeMode:1,publicReady:false},
]}));
const server=await startKarmaServer({host:'127.0.0.1',port:0,healthPort:0,dataDir:temp,mapFile,exchange,matchSeconds:120,logger:()=>{}});
const sleep=ms=>new Promise(resolve=>setTimeout(resolve,ms));
async function wait(label,predicate){for(let i=0;i<300;i++){const value=predicate();if(value)return value;await sleep(10);}throw Error('Timeout: '+label);}
async function account(role='user'){const value=await server.auth.createAccount({rulesAcceptance:validateRules({rulesAccepted:true,rulesVersion:GAME_RULES.version}),email:crypto.randomUUID()+'@test.invalid',password:crypto.randomUUID(),name:'Player '+clients.length,role});return {...value,token:server.auth.issueSession(value).authToken};}
async function peer({code='941001',host=false,capacity=3,mode='dm',build='karma290-central5',map=0,roomId,identity}={}){
  identity??=await account();
  const socket=net.createConnection({host:'127.0.0.1',port:server.port}),c={socket,identity,id:identity.playerId,messages:[],seq:0};clients.push(c);
  let buffer='';socket.setEncoding('utf8');socket.on('error',()=>{});socket.on('data',chunk=>{buffer+=chunk;let i;while((i=buffer.indexOf('\n'))>=0){c.messages.push(JSON.parse(buffer.slice(0,i)));buffer=buffer.slice(i+1);}});
  c.latest=type=>c.messages.filter(m=>m.type===type).at(-1);c.send=m=>socket.write(JSON.stringify(m)+'\n');
  c.find=(label,predicate)=>wait(label,()=>c.messages.find(predicate));
  await new Promise(resolve=>socket.once('connect',resolve));
  c.send({type:'hello',version:2,op:host?'create':'join',authToken:identity.token,code,roomId,mode,maxPlayers:capacity,clientMaxPlayers:8,manualStart:true,
    config:{map,age:0,character:{index:0,camp:0},settings:{build}}});return c;
}
async function admitted(options){const c=await peer(options);await wait('welcome',()=>c.latest('welcome')||c.latest('error'));assert(!c.latest('error'),JSON.stringify(c.latest('error')));return c;}
async function denied(options,code){const c=await peer(options);assert.equal((await wait('error',()=>c.latest('error'))).code,code);return c;}
async function start(host){
  const roomId=host.latest('welcome').room.roomId;
  for(const c of clients.filter(c=>!c.socket.destroyed&&c.latest('welcome')?.room.roomId===roomId)){
    c.send({type:'lobby-update',requestId:'test-ready',ready:true});await wait('ready ack',()=>c.latest('lobby-updated'));
  }
  host.send({type:'start-match',roomId});await wait('started',()=>host.latest('peer-ready'));
}
async function leave(c){if(!c.socket.destroyed){c.socket.end();await new Promise(resolve=>c.socket.once('close',resolve));}await sleep(30);}
async function rooms(identity){return await(await fetch('http://127.0.0.1:'+server.healthPort+'/api/rooms',{headers:identity?{Authorization:'Bearer '+identity.token}:{}})).json();}
function state(c,extra={}){const ready=c.latest('peer-ready');return {type:'state',version:1,seq:++c.seq,life:ready.initialLife,weapon:9,selectedWeapon:9,pos:[10,20,30],yaw:0.2,pitch:0.3,sector:1,hp:100,inventory:ready.config.inventory,ammo:{9:{magazine:11,reserve:42}},...extra};}
try{
  assert.equal((await rooms()).error.code,'AUTH_REQUIRED');
  const a=await admitted({host:true}),b=await admitted();const roomId=a.latest('welcome').room.roomId;
  let list=(await rooms(a.identity)).rooms;assert.equal(list.length,1);assert.equal(list[0].joinable,true);assert.equal(list[0].state,'waiting');assert.equal(list[0].maxPlayers,3);
  assert(!JSON.stringify(list).includes(a.id));assert(!JSON.stringify(list).includes(a.identity.email));assert(!JSON.stringify(list).includes(a.identity.token));
  await denied({roomId:'old-room'},'ROOM_CHANGED');await start(a);
  assert.equal(charges,1);assert.equal(balances.get(a.id),200);
  a.send({type:'game',message:state(a,{shot:{id:1,life:1,weapon:9,origin:[10,20,30],direction:[1,0,0],sector:1,renderSector:1,yaw:0.2,pitch:0.3}})});
  b.send({type:'game',message:state(b)});
  await b.find('shot received',m=>m.type==='game'&&m.message.shot?.id===1);
  b.send({type:'damage-proof',proof:{id:'damage-b',shotId:1,victimLife:1,attackerId:a.id,attackerLife:1,weapon:9,before:100,after:-1}});
  b.send({type:'game',message:{type:'death',version:1,life:1,seq:++b.seq,killer:'remote',weapon:9,damageId:'damage-b',hpAfter:-1,
    drop:{selectedWeapon:9,magazine:0,reserve:7,pos:[10,20,30],sector:1}}});
  await a.find('death',m=>m.type==='death-confirmed');
  const deathDrop=await wait('drop',()=>a.latest('drop'));
  await sleep(1100);
  list=(await rooms(a.identity)).rooms;assert.equal(list[0].state,'playing');assert.equal(list[0].joinable,true);assert(list[0].remainingSeconds<120);
  const c=await admitted({roomId});await wait('late ready',()=>c.latest('peer-ready'));
  assert.equal(c.latest('peer-ready').lateJoin,true);assert.equal(c.latest('peer-ready').slot,2);assert.equal(c.latest('peer-ready').peers.length,2);
  await a.find('peer joined',m=>m.type==='peer-joined'&&m.peer.playerId===c.id);
  const snapshot=await wait('snapshot',()=>c.latest('match-snapshot'));assert.equal(snapshot.players.find(p=>p.playerId===a.id).kills,1);assert.equal(snapshot.players.find(p=>p.playerId===b.id).deaths,1);
  assert(snapshot.remainingSeconds<120);assert.equal(balances.get(c.id),200);
  const replay=await c.find('pose replay',m=>m.type==='game'&&m.senderId===a.id);assert.equal(replay.message.yaw,0.2);assert(!replay.message.shot);
  assert.equal((await c.find('dead pose',m=>m.type==='game'&&m.senderId===b.id)).message.hp,0);
  assert.equal((await c.find('unclaimed drop replay',m=>m.type==='drop'&&m.drop.id===deathDrop.drop.id)).drop.reserve,7);
  assert.equal((await rooms(a.identity)).rooms[0].state,'full');await denied({},'ROOM_FULL');
  await leave(b);await a.find('peer left',m=>m.type==='peer-left'&&m.playerId===b.id);
  const rejoined=await admitted({identity:b.identity});await wait('rejoin ready',()=>rejoined.latest('peer-ready'));
  assert.equal(rejoined.latest('peer-ready').initialLife,2);assert.equal(rejoined.latest('peer-ready').slot,1);assert.equal(balances.get(b.id),200,'rejoin has no additional fee');
  assert.equal((await wait('rejoin snapshot',()=>rejoined.latest('match-snapshot'))).players.find(p=>p.playerId===b.id).deaths,1);
  await leave(rejoined);
  for(let i=0;i<8;i++){const replacement=await admitted();await wait('replacement ready',()=>replacement.latest('peer-ready'));assert.equal(replacement.latest('peer-ready').slot,1);await leave(replacement);}
  assert.equal(server.stats().players,2,'more than eight historical users do not consume active slots');

  // The last slot is reserved before asynchronous coin debiting begins.
  gate=new Promise(resolve=>resume=resolve);const before=charges,pending=await peer();await wait('pending charge',()=>charges===before+1);
  await denied({},'ROOM_FULL');assert.equal(charges,before+1);assert.equal((await rooms(a.identity)).rooms[0].joinable,false);
  resume();gate=null;await wait('pending entrant admitted',()=>pending.latest('peer-ready'));await leave(pending);
  failCharge=true;await denied({},'INSUFFICIENT_FUNDS');failCharge=false;assert.equal((await rooms(a.identity)).rooms[0].joinable,true);
  // Disconnect and token expiry during billing both release the slot and refund.
  gate=new Promise(resolve=>resume=resolve);const priorRefunds=refunds,priorCharges=charges,cancelled=await peer();await wait('cancel charge',()=>charges>priorCharges);await leave(cancelled);resume();gate=null;
  await wait('cancel refund',()=>refunds===priorRefunds+1);assert.equal(balances.get(cancelled.id),300);
  gate=new Promise(resolve=>resume=resolve);const revokedCharges=charges,revoked=await peer();await wait('revoked charge',()=>charges>revokedCharges);server.auth.logout(revoked.identity.token);resume();gate=null;
  await wait('expired token refund',()=>refunds===priorRefunds+2);assert.equal(balances.get(revoked.id),300);assert(!revoked.latest('welcome'));

  // Explicit G drop is authoritative, idempotent and preserves exact ammunition.
  a.send({type:'game',message:state(a)});await c.find('latest state',m=>m.type==='game'&&m.senderId===a.id&&m.message.seq===a.seq);
  a.send({type:'drop-claim',requestId:'wrong-ammo',life:1,weapon:9,magazine:99,reserve:42});assert.equal((await wait('drop rejected',()=>a.latest('drop-denied'))).reason,'ammo-changed');
  const request={type:'drop-claim',requestId:'manual-a',life:1,weapon:9,magazine:11,reserve:42};a.send(request);
  const grant=(await wait('drop grant',()=>a.latest('drop-grant'))).grant;assert.equal(grant.inventory[grant.removeSlot],255);assert.equal(grant.drop.reserve,42);assert.equal(grant.drop.magazine,11);assert.equal(grant.selectedWeapon,1);
  a.send(request);assert.equal((await a.find('idempotent drop',m=>m.type==='drop-grant'&&m.replay)).grant.drop.id,grant.drop.id);
  // Reproduce the installed v0.5.0 G crash: native state has switched to the
  // pistol but still carries the old shot from its now-dropped gun.
  a.send({type:'game',message:state(a,{inventory:grant.inventory,weapon:grant.selectedWeapon,selectedWeapon:grant.selectedWeapon,
    ammo:{1:{magazine:8,reserve:32}},shot:{id:1,life:1,weapon:9,origin:[10,20,30],direction:[1,0,0],sector:1,renderSector:1,yaw:0.2,pitch:0.3}})});
  const afterDrop=await c.find('stale shot does not disconnect after G',m=>m.type==='game'&&m.senderId===a.id&&m.message.seq===a.seq);
  assert(!afterDrop.message.shot,'Old shot is not replayed');assert(!a.latest('error'));assert(!a.socket.destroyed);
  c.send({type:'game',message:state(c)});c.send({type:'pickup-claim',requestId:'same-gun',life:1,dropId:grant.drop.id});
  assert.equal((await wait('same gun denied',()=>c.latest('pickup-denied'))).reason,'weapon-already-owned');
  c.send({type:'drop-claim',requestId:'clear-c-slot',life:1,weapon:9,magazine:11,reserve:42});await wait('c drop grant',()=>c.latest('drop-grant'));
  c.send({type:'pickup-claim',requestId:'take-manual',life:1,dropId:grant.drop.id});
  const pickup=(await wait('pickup grant',()=>c.latest('pickup-grant'))).grant;assert.equal(pickup.magazine,11);assert.equal(pickup.reserve,42);
  let liveInventory=grant.inventory;
  for(const weapon of [1,6,18]){
    a.send({type:'game',message:state(a,{inventory:liveInventory,weapon,selectedWeapon:weapon,ammo:{[weapon]:{magazine:0,reserve:7}}})});
    a.send({type:'drop-claim',requestId:'drop-last-'+weapon,life:1,weapon,magazine:0,reserve:7});
    const removed=(await a.find('drop gun '+weapon,m=>m.type==='drop-grant'&&m.grant.id==='drop-last-'+weapon)).grant;
    liveInventory=removed.inventory;
    if(weapon===18){assert.equal(removed.selectedWeapon,0);assert(liveInventory.includes(0));assert(liveInventory.includes(50),'Binocular slot is preserved separately from knife');}
  }
  a.send({type:'game',message:state(a,{inventory:liveInventory,weapon:0,selectedWeapon:0,ammo:{0:{magazine:0,reserve:0}}})});
  const knifePose=await c.find('knife accepted after last gun drop',m=>m.type==='game'&&m.senderId===a.id&&m.message.seq===a.seq);
  assert.equal(knifePose.message.weapon,0);assert.equal(knifePose.message.selectedWeapon,0);assert(!a.latest('error'));
  const later=await admitted();await wait('later ready',()=>later.latest('peer-ready'));await sleep(30);
  assert(!later.messages.some(m=>m.type==='drop'&&m.drop.id===grant.drop.id),'claimed drop is not replayed');await leave(later);
  await leave(c);await sleep(30);assert(!a.latest('match-ended'),'DM remains running with one active player');assert.equal((await rooms(a.identity)).rooms[0].players,1);

  // A room ending while its last spare slot is being charged cannot admit/refuse a refund.
  gate=new Promise(resolve=>resume=resolve);const endedCharges=charges,ended=await peer();await wait('ending charge',()=>charges>endedCharges);await leave(a);resume();gate=null;
  await wait('ended refund',()=>refunds===priorRefunds+3);assert.equal(balances.get(ended.id),300);assert(!ended.latest('welcome'));assert.equal((await rooms(c.identity)).rooms.length,0);
  const disk=JSON.parse(fs.readFileSync(path.join(temp,'profiles.json'),'utf8'));assert.equal(disk.profiles[b.id].matches,1,'rejoining account gets one match result');assert.equal(disk.profiles[a.id].kills,1);

  // Build compatibility and team/duel admission rules are reflected by the directory.
  for(const [code,mode,capacity,build] of [['941002','tdm',4,'karma290-central5'],['941003','duel',2,'karma290-central5'],['941004','dm',3,'karma290-central4']]){
    const host=await admitted({host:true,code,mode,capacity,build}),guest=await admitted({code,build});await start(host);
    const listed=(await rooms(host.identity)).rooms.find(r=>r.code===code);assert.equal(listed.joinable,false);
    await denied({code,build},'ROOM_STARTED');await leave(guest);await leave(host);
  }
  const admin=await account('admin'),preview=await admitted({host:true,code:'941005',map:7,identity:admin}),publicRoom=await admitted({host:true,code:'941006',map:4});
  assert(!(await rooms(publicRoom.identity)).rooms.some(r=>r.map===7));assert((await rooms(admin)).rooms.some(r=>r.map===7));
  assert.equal((await rooms(publicRoom.identity)).rooms.find(r=>r.map===4).mapName,'Rescue');
  console.log('PASS late join: authenticated/private directory, dynamic roster/score/pose/drop sync, safe replay, freed slots and >8 historical users, monotonic rejoin lives, once-per-match coins, concurrent last-slot reservation, cancellation/auth/ended refunds, G exact-ammo drop/E pickup, one-player DM, build/team/duel gates.');
}finally{
  resume?.();gate=null;for(const c of clients)c.socket.destroy();await server.close();fs.rmSync(temp,{recursive:true,force:true});
}
