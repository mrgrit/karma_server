import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import crypto from 'node:crypto';
import net from 'node:net';
import {startKarmaServer} from './server.mjs';
import {validateRules,GAME_RULES} from './rules.mjs';

const temp=fs.mkdtempSync(path.join(os.tmpdir(),'karma-death-lifecycle-'));
const clients=[],logs=[],delay=ms=>new Promise(resolve=>setTimeout(resolve,ms));
const server=await startKarmaServer({host:'127.0.0.1',port:0,healthPort:0,dataDir:temp,
  roundIntermissionMs:70,dmRespawnMs:60,logger:(event,data)=>logs.push({event,...data})});
const catalog=JSON.parse(fs.readFileSync(new URL('loadouts.json',import.meta.url),'utf8'));
const config={map:0,age:0,character:{index:0,camp:0},inventory:catalog.defaultInventory,selectedWeapon:9,settings:{build:'karma290-central6'}};
async function wait(label,predicate){for(let i=0;i<250;i++){const value=predicate();if(value)return value;await delay(10);}throw Error('Timeout: '+label);}
async function join(code,mode,host=false,maxPlayers=4){
  const account=await server.auth.createAccount({rulesAcceptance:validateRules({rulesAccepted:true,rulesVersion:GAME_RULES.version}),email:crypto.randomUUID()+'@test.invalid',password:crypto.randomUUID(),name:'Lifecycle '+clients.length});
  const socket=net.createConnection({host:'127.0.0.1',port:server.port}),c={socket,id:account.playerId,messages:[],seq:0,life:1};let buffer='';clients.push(c);
  socket.setEncoding('utf8');socket.on('error',()=>{});socket.on('data',chunk=>{buffer+=chunk;let end;while((end=buffer.indexOf('\n'))>=0){c.messages.push(JSON.parse(buffer.slice(0,end)));buffer=buffer.slice(end+1);}});
  c.send=m=>socket.write(JSON.stringify(m)+'\n');c.latest=type=>c.messages.filter(m=>m.type===type).at(-1);
  c.state=(extra={})=>c.send({type:'game',message:{version:1,type:c.life>1?'respawn':'state',life:c.life,seq:++c.seq,pos:[100,200,300],sector:4,weapon:9,selectedWeapon:9,hp:100,yaw:0,pitch:0,inventory:config.inventory,...extra}});
  await new Promise((resolve,reject)=>{socket.once('connect',resolve);socket.once('error',reject);});
  c.send({type:'hello',version:2,op:host?'create':'join',code,mode,config,maxPlayers,clientMaxPlayers:8,manualStart:true,roundWinLimit:10,timeLimitSeconds:1800,authToken:server.auth.issueSession(account).authToken});
  await wait('welcome',()=>c.latest('welcome'));return c;
}
async function room(code,mode,count){
  const group=[];for(let i=0;i<count;i++)group.push(await join(code,mode,i===0,mode==='duel'?2:4));
  for(const c of group)c.send({type:'lobby-update',requestId:'ready',ready:true});
  await wait('ready',()=>group[0].latest('waiting')?.canStart);
  group[0].send({type:'start-match',roomId:group[0].latest('welcome').room.roomId});
  for(const c of group){await wait('start',()=>c.latest('peer-ready'));c.state();}
  await delay(35);return group;
}
async function die(c,extra={}){
  c.send({type:'game',message:{version:1,type:'death',life:c.life,seq:++c.seq,killer:'environment',weapon:-1,hpAfter:0,...extra}});
  await wait('death',()=>c.messages.some(m=>m.type==='death-confirmed'&&m.receipt.victimId===c.id&&m.receipt.victimLife===c.life));
}
function noCascade(group){
  for(const c of group){assert(!c.messages.some(m=>m.type==='game'&&m.message.type==='leave'),'Individual leave must never be relayed');assert(!c.latest('match-ended'),'Match remains active');assert(!c.latest('error'),'No protocol error: '+JSON.stringify(c.latest('error')));assert(!c.socket.destroyed,'Remaining socket stays connected');}
}
try{
  const team=await room('921001','tdm',4);
  // Repeated legitimate team deaths must wait for teammates and advance rounds,
  // never close the room. Environment deaths do not fabricate combat XP.
  for(let round=1;round<=9;round++){
    const losingTeam=round%2,losers=team.filter((_,i)=>i%2===losingTeam);
    await die(losers[0],round===1?{drop:{selectedWeapon:9,magazine:12,reserve:60,pos:[0,0,0],sector:-1}}:{});
    await delay(15);noCascade(team);
    assert(!team[0].messages.some(m=>m.type==='round-ended'&&m.round===round),'A surviving teammate keeps the round running');
    await die(losers[1]);
    const next=await wait('round '+(round+1),()=>team[0].messages.find(m=>m.type==='round-start'&&m.round===round+1));
    for(const c of team){c.life=next.lives[c.id];c.state();}await delay(25);noCascade(team);
  }
  await die(team[0]);team[0].send({type:'game',message:{version:1,type:'leave'}});
  await wait('dead player departs',()=>team[2].latest('peer-left')?.playerId===team[0].id);noCascade(team.slice(1));
  team[2].state();await wait('remaining team still relays',()=>team[1].messages.some(m=>m.type==='game'&&m.senderId===team[2].id&&m.message.life===10));
  team[2].send({type:'game',message:{version:1,type:'leave'}});
  const forfeit=await wait('empty team forfeit',()=>team[1].latest('match-ended'));
  assert.equal(forfeit.result.reason,'forfeit');assert(forfeit.result.winnerIds.includes(team[1].id));
  assert(!team[1].messages.some(m=>m.type==='game'&&m.message.type==='leave'),'Empty team uses result screen, not raw leave');
  const dm=await room('921002','dm',3);await die(dm[0]);dm[0].send({type:'game',message:{version:1,type:'leave'}});
  await wait('DM leave',()=>dm[1].latest('peer-left')?.playerId===dm[0].id);noCascade(dm.slice(1));
  dm[1].send({type:'game',targetId:dm[0].id,message:{version:1,type:'hit',life:1,seq:++dm[1].seq,id:'departed-hit',victimLife:1,weapon:9,kind:'bullet',region:1,direction:[1,0,0]}});
  await delay(20);noCascade(dm.slice(1));
  // Death and an early respawn can cross the client's timer/server receipt
  // boundary. Rejection must not reset inventory before the life is accepted.
  const recovering=dm[1];recovering.state({ammo:{9:{magazine:12,reserve:60}}});
  recovering.send({type:'drop-claim',requestId:'before-death',life:1,weapon:9,magazine:12,reserve:60});
  const dropped=await wait('manual drop',()=>recovering.latest('drop-grant'));
  recovering.state({inventory:dropped.grant.inventory,selectedWeapon:dropped.grant.selectedWeapon,weapon:dropped.grant.selectedWeapon});
  await die(recovering);
  recovering.send({type:'game',message:{version:1,type:'respawn',life:2,seq:++recovering.seq,pos:[100,200,300],sector:4,weapon:9,selectedWeapon:9,hp:100,yaw:0,pitch:0,inventory:config.inventory}});
  recovering.state({hp:0,inventory:dropped.grant.inventory,selectedWeapon:dropped.grant.selectedWeapon,weapon:dropped.grant.selectedWeapon});
  await delay(20);noCascade(dm.slice(1));
  await delay(70);recovering.life=2;recovering.state();
  await wait('accepted respawn after delay',()=>dm[2].messages.some(m=>m.type==='game'&&m.senderId===recovering.id&&m.message.life===2&&m.message.hp===100));noCascade(dm.slice(1));
  dm[1].socket.destroy();await wait('DM disconnect',()=>dm[2].latest('peer-left')?.playerId===dm[1].id);noCascade([dm[2]]);
  const duel=await room('921003','duel',2);duel[0].send({type:'game',message:{version:1,type:'leave'}});
  assert.equal((await wait('duel result',()=>duel[1].latest('match-ended'))).result.reason,'forfeit');
  assert(!duel[1].messages.some(m=>m.type==='game'&&m.message.type==='leave'));
  assert(logs.some(e=>e.event==='player-left'&&e.playerId===team[0].id&&e.reason==='player-leave'&&e.roomContinues&&e.remaining===3));
  assert(logs.some(e=>e.event==='death-drop-rejected'&&e.life===1),'Invalid optional death loot is diagnosed without losing the player');
  assert(!logs.some(e=>e.event==='client-error'),'All exercised legitimate race paths avoid hard disconnects');
  console.log('PASS death lifecycle: nine team rounds, alive-team wait, no leave cascade, invalid death loot discarded, stale departed-target hit ignored, early DM respawn after G preserves inventory, legitimate forfeit results and bounded diagnostics.');
}finally{
  for(const c of clients)c.socket.destroy();await server.close();
  const resolved=fs.realpathSync(temp),temporaryRoot=fs.realpathSync(os.tmpdir());
  assert(path.dirname(resolved)===temporaryRoot&&path.basename(resolved).startsWith('karma-death-lifecycle-'),'Only remove this test temporary directory');
  fs.rmSync(resolved,{recursive:true,force:true});
}
