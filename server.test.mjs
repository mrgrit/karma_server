import assert from 'node:assert/strict';
import net from 'node:net';
import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import {fileURLToPath} from 'node:url';
import {startKarmaServer} from './server.mjs';

const directory=path.dirname(fileURLToPath(import.meta.url));
const catalog=JSON.parse(fs.readFileSync(path.join(directory,'loadouts.json'),'utf8').replace(/^\uFEFF/,''));
const original=JSON.parse(fs.readFileSync(path.join(directory,'characters.json'),'utf8').replace(/^\uFEFF/,'')).find(x=>x.age===0);
const config={age:0,map:0,character:{index:original.characterIndex,camp:original.camp,model:'ignored.chr',name:'ignored'},
  inventory:catalog.defaultInventory,selectedWeapon:9,settings:{build:'karma290-lan1'}};
const temp=fs.mkdtempSync(path.join(os.tmpdir(),'karma-server-test-'));
const clients=[];
const testCredentials=new Map();
let server;
async function connect(hello){
  let authToken=hello.authToken;
  if(authToken===undefined&&!hello.noAuth){
    let account=server.auth.list().find(item=>item.playerId===hello.playerId);
    if(!account)account=await server.auth.createAccount({email:hello.playerId+'@example.test',
      password:'temporary-test-password-42',name:'LAN Test',playerId:hello.playerId});
    authToken=testCredentials.get(hello.playerId)||server.auth.issueSession(account).authToken;
    testCredentials.set(hello.playerId,authToken);
  }
  const socket=net.createConnection({host:'127.0.0.1',port:server.port});
  const client={socket,messages:[],pending:[],closed:false,authToken};
  let buffer='';
  socket.setEncoding('utf8');
  socket.on('error',()=>{});
  socket.on('close',()=>{client.closed=true;});
  socket.on('data',chunk=>{
    buffer+=chunk;
    let index;
    while((index=buffer.indexOf('\n'))>=0){
      const item=JSON.parse(buffer.slice(0,index));buffer=buffer.slice(index+1);
      client.messages.push(item);
      for(const pending of [...client.pending])if(pending.predicate(item)){
        client.pending.splice(client.pending.indexOf(pending),1);clearTimeout(pending.timer);pending.resolve(item);
      }
    }
  });
  client.send=message=>socket.write(JSON.stringify(message)+'\n');
  client.wait=(predicate,timeout=5000)=>{
    const previous=client.messages.find(predicate);if(previous)return Promise.resolve(previous);
    return new Promise((resolve,reject)=>{
      const pending={predicate,resolve,timer:setTimeout(()=>{
        client.pending.splice(client.pending.indexOf(pending),1);reject(Error('Timed out for '+hello.playerId+': '+JSON.stringify(client.messages.slice(-3))));
      },timeout)};client.pending.push(pending);
    });
  };
  client.type=type=>client.wait(message=>message.type===type);
  await new Promise((resolve,reject)=>{socket.once('connect',resolve);socket.once('error',reject);});
  clients.push(client);client.send({type:'hello',version:2,name:'LAN Test',config,clientMaxPlayers:2,...hello,authToken});
  return client;
}
const state=(life=1,seq=1,extra={})=>({type:'state',version:1,life,seq,pos:[100,0,100],
  yaw:0,pitch:0,sector:4,weapon:9,hp:100,inventory:[...config.inventory],
  selectedWeapon:9,ammo:{9:{magazine:30,reserve:90}},...extra});
const delay=ms=>new Promise(resolve=>setTimeout(resolve,ms));
async function statsEventually(expected){
  for(let attempt=0;attempt<100;attempt++){if(server.stats().players===expected)return;await delay(10);}
  assert.equal(server.stats().players,expected);
}
async function disconnectAll(){
  for(const client of clients.splice(0)){for(const pending of client.pending)clearTimeout(pending.timer);client.socket.destroy();}
  await statsEventually(0);
}
try{
  server=await startKarmaServer({host:'127.0.0.1',port:0,healthPort:0,dataDir:temp,logger:()=>{}});
  let host=await connect({op:'create',playerId:'host-profile',code:'123456'});
  const hostWelcome=await host.type('welcome');
  assert.match(host.authToken,/^[0-9a-f]{64}$/);assert.equal(hostWelcome.profile.xp,0);
  assert.equal(hostWelcome.profile.loadouts[original.id].selectedWeapon,9);
  let guest=await connect({op:'join',playerId:'guest-profile',code:'123456'});
  const guestWelcome=await guest.type('welcome');
  const ready=await host.type('peer-ready');await guest.type('peer-ready');
  assert.equal(ready.role,'host');assert.equal(ready.remoteHello.playerId,'guest-profile');
  assert.equal(ready.config.character.model,path.basename(original.model.replaceAll('\\','/')).toLowerCase());
  host.send({type:'game',message:state()});guest.send({type:'game',message:state()});
  assert.equal((await guest.type('game')).senderId,'host-profile');
  await host.type('game');
  // A death with no observed hit/shot + native HP proof has zero XP.
  guest.send({type:'damage-proof',proof:{id:'invented',victimLife:1,attackerId:'host-profile',attackerLife:1,weapon:9,before:10,after:0}});
  assert.equal((await guest.type('proof-rejected')).reason,'no-matching-shot-or-hit');
  // Each attacker may fire shot 1 in the same victim life. Damage event IDs
  // remain unique to the victim, independently of the originating shot ID.
  guest.send({type:'game',message:state(1,2,{shot:{id:1,life:1,weapon:9,origin:[0,0,0],
    direction:[1,0,0],sector:4,renderSector:4,yaw:0,pitch:0}})});
  await host.wait(x=>x.type==='game'&&x.message.shot?.id===1);
  guest.send({type:'damage-proof',proof:{id:'guest:1:1',shotId:1,victimLife:1,
    attackerId:'guest-profile',attackerLife:1,weapon:9,before:100,after:70}});
  const hit={type:'hit',version:1,life:1,seq:2,id:1,victimLife:1,weapon:9,kind:'bullet',region:1,direction:[1,0,0]};
  host.send({type:'game',message:hit});
  await guest.wait(x=>x.type==='game'&&x.message.type==='hit');
  guest.send({type:'damage-proof',proof:{id:'guest:1:2',shotId:1,victimLife:1,
    attackerId:'host-profile',attackerLife:1,weapon:9,before:70,after:30}});
  guest.send({type:'damage-proof',proof:{id:'guest:1:3',shotId:1,victimLife:1,
    attackerId:'host-profile',attackerLife:1,weapon:9,before:30,after:-5}});
  const death={type:'death',version:1,life:1,seq:3,killer:'remote',weapon:9,damageId:'guest:1:3',hpAfter:-5,
    drop:{selectedWeapon:9,magazine:0,reserve:7,pos:[100,0,100],sector:4}};
  guest.send({type:'game',message:death});
  const confirmed=await host.type('death-confirmed');
  assert.equal(confirmed.receipt.verified,true);
  assert.equal((await host.type('profile')).profile.xp,25);
  assert.equal((await guest.type('profile')).profile.xp,5);
  const drop=(await host.type('drop')).drop;assert.equal(drop.magazine,0);assert.equal(drop.reserve,7);
  guest.send({type:'game',message:death});
  host.send({type:'pickup-claim',dropId:drop.id,requestId:'claim-1',life:1});
  const grant=(await host.type('pickup-grant')).grant;
  assert.equal(grant.playerId,'host-profile');assert.equal(grant.magazine,0);assert.equal(grant.reserve,7);
  host.send({type:'pickup-claim',dropId:drop.id,requestId:'claim-1',life:1});
  assert.equal((await host.wait(x=>x.type==='pickup-grant'&&x.replay)).grant.id,grant.id);
  guest.send({type:'pickup-claim',dropId:drop.id,requestId:'other-claim',life:1});
  assert.equal((await guest.type('pickup-denied')).reason,'already-claimed');
  const health=await (await fetch('http://127.0.0.1:'+server.healthPort+'/health')).json();
  assert.equal(health.players,2);assert.equal(health.rooms,1);
  assert.ok(!JSON.stringify(health).includes('profile'));
  assert.equal((await fetch('http://127.0.0.1:'+server.healthPort+'/not-a-route')).status,404);
  const disk=JSON.parse(fs.readFileSync(path.join(temp,'profiles.json'),'utf8'));
  assert.equal(disk.profiles['host-profile'].xp,25);assert.equal(disk.profiles['guest-profile'].xp,5);
  assert.ok(!JSON.stringify(disk).includes(host.authToken),'Tokens are absent from profile storage');
  host.socket.destroy();assert.equal((await guest.type('match-ended')).result.reason,'forfeit');await disconnectAll();

  // Authentication/persistence and initial budget enforcement.
  const badAuth=await connect({op:'create',playerId:'host-profile',code:'123456',noAuth:true});
  assert.equal((await badAuth.type('error')).code,'AUTH_REQUIRED');
  const badBudget=await connect({op:'create',playerId:'too-heavy',code:'123456',
    config:{...config,inventory:[50,10,1,6,49,24,18],selectedWeapon:10}});
  assert.match((await badBudget.type('error')).message,/budget/i);
  const lockedCharacter=await connect({op:'create',playerId:'locked-character',code:'123456',
    config:{...config,character:{camp:0,index:2}}});
  assert.match((await lockedCharacter.type('error')).message,/locked/i);
  const prematureDual=await connect({op:'create',playerId:'premature-dual',code:'123456',
    config:{...config,character:{camp:0,index:4},inventory:[50,9,21,22,255,255,255],selectedWeapon:21}});
  assert.match((await prematureDual.type('error')).message,/600 XP/i);
  const oldId=await connect({op:'create',playerId:'constructor',code:'123456'});
  assert.equal((await oldId.type('error')).code,'BAD_MESSAGE');
  host=await connect({op:'create',playerId:'host-profile',code:'123456'});
  assert.equal((await host.type('welcome')).profile.xp,25);
  await disconnectAll();
  const profileQuery=await connect({op:'profile',playerId:'host-profile'});
  const synced=await profileQuery.type('welcome');
  assert.equal(synced.room,null);assert.equal(synced.profile.xp,25);
  await disconnectAll();
  await server.close();
  server=await startKarmaServer({host:'127.0.0.1',port:0,healthPort:0,dataDir:temp,logger:()=>{}});
  host=await connect({op:'create',playerId:'host-profile',code:'123456'});
  assert.equal((await host.type('welcome')).profile.xp,25,'Server restart preserves XP');
  guest=await connect({op:'join',playerId:'guest-profile',code:'123456'});
  await guest.type('peer-ready');await disconnectAll();
  console.log('PASS: 2-client handshake/relay, identity token, original loadout budget, victim-native hit receipt, XP25/5, death dedup, one-owner pickup with exact 0/7 ammo, HTTP privacy, disconnect, restart persistence.');

  // Server room routing scalability only; this does not claim native 8-player support.
  const start=performance.now(),groups=[];
  for(let room=0;room<20;room++){
    const code=String(200000+room),group=[];
    const leader=await connect({op:'create',playerId:'load-'+room+'-0',code,maxPlayers:8,clientMaxPlayers:8});
    await leader.type('welcome');group.push(leader);
    if(room===0){
      const native=await connect({op:'join',playerId:'native-capability',code,clientMaxPlayers:2});
      assert.equal((await native.type('error')).code,'CLIENT_LIMIT');
    }
    for(let slot=1;slot<8;slot++){
      const client=await connect({op:'join',playerId:'load-'+room+'-'+slot,code,clientMaxPlayers:8});
      await client.type('welcome');group.push(client);
    }
    await Promise.all(group.map(client=>client.type('peer-ready')));groups.push(group);
  }
  await statsEventually(160);
  const extra=await connect({op:'create',playerId:'load-overflow',code:'999999',clientMaxPlayers:8,maxPlayers:8});
  assert.equal((await extra.type('error')).code,'ROOM_LIMIT');
  const baseline=server.stats().relayedMessages;
  for(let tick=1;tick<=10;tick++)for(const group of groups)for(const client of group)client.send({type:'game',message:state(1,tick)});
  const expected=baseline+160*10*7;
  for(let attempt=0;attempt<200&&server.stats().relayedMessages<expected;attempt++)await delay(10);
  assert.equal(server.stats().relayedMessages,expected);
  for(const group of groups)for(const client of group){
    await client.wait(()=>client.messages.filter(item=>item.type==='game').length===70,10000);
    const ready=await client.type('peer-ready');
    assert.equal(ready.peers.length,7);
    const allowed=new Set(ready.peers.map(peer=>peer.playerId));
    assert.ok(client.messages.filter(item=>item.type==='game').every(item=>allowed.has(item.senderId)));
  }
  const result={test:'synthetic-room-routing',rooms:20,clients:160,inboundStates:1600,
    deliveredStates:11200,elapsedMs:Math.round(performance.now()-start),nativeClientMaxPlayers:8};
  console.log('PASS: '+JSON.stringify(result));
  await disconnectAll();
}finally{
  for(const client of clients)client.socket.destroy();
  if(server)await server.close();
  for(const filename of ['profiles.json','auth.json']){
    const owned=path.join(temp,filename);if(fs.existsSync(owned))fs.unlinkSync(owned);
  }
  fs.rmdirSync(temp);
}
