import {validateRules,GAME_RULES} from './rules.mjs';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import crypto from 'node:crypto';
import net from 'node:net';
import {startKarmaServer} from './server.mjs';

const temp=fs.mkdtempSync(path.join(os.tmpdir(),'karma-lobby-'));
const server=await startKarmaServer({host:'127.0.0.1',port:0,healthPort:0,dataDir:temp,logger:()=>{}});
const catalog=JSON.parse(fs.readFileSync(new URL('loadouts.json',import.meta.url),'utf8').replace(/^\uFEFF/,''));
const config={map:0,age:0,character:{index:0,camp:0},rank:{id:'lieutenant'},inventory:catalog.defaultInventory,selectedWeapon:9,settings:{build:'karma290-central3'}};
const clients=[],delay=ms=>new Promise(r=>setTimeout(r,ms));
async function wait(label,fn){for(let i=0;i<250;i++){const value=fn();if(value)return value;await delay(20);}throw Error('Timeout: '+label);}
async function join(code,mode='dm',host=false,capacity=8,roomName){
  const account=await server.auth.createAccount({rulesAcceptance:validateRules({rulesAccepted:true,rulesVersion:GAME_RULES.version}),email:crypto.randomUUID()+'@test.invalid',password:crypto.randomUUID(),name:'Player '+clients.length});
  const socket=net.createConnection({host:'127.0.0.1',port:server.port}),c={socket,id:account.playerId,messages:[]};let buffer='';clients.push(c);
  socket.setEncoding('utf8');socket.on('error',()=>{});socket.on('data',chunk=>{buffer+=chunk;let end;
    while((end=buffer.indexOf('\n'))>=0){c.messages.push(JSON.parse(buffer.slice(0,end)));buffer=buffer.slice(end+1);}});
  c.send=m=>socket.write(JSON.stringify(m)+'\n');
  c.latest=type=>c.messages.filter(m=>m.type===type).at(-1);
  await new Promise((resolve,reject)=>{socket.once('connect',resolve);socket.once('error',reject);});
  c.send({type:'hello',version:2,op:host?'create':'join',code,roomName,mode,maxPlayers:capacity,clientMaxPlayers:8,manualStart:true,config,authToken:server.auth.issueSession(account).authToken});
  const welcome=await wait('welcome',()=>c.latest('welcome'));c.roomId=welcome.room.roomId;
  c.start=()=>c.send({type:'start-match',roomId:c.roomId});
  await wait('lobby roster',()=>c.latest('waiting'));return c;
}
let updateId=0;
async function update(c,value){
  const requestId='lobby-test-'+(++updateId);c.send({type:'lobby-update',requestId,...value});
  return wait('lobby update',()=>c.messages.find(m=>['lobby-updated','lobby-update-denied'].includes(m.type)&&m.requestId===requestId));
}
async function prepare(group){for(const c of group)assert.equal((await update(c,{ready:true})).ready,true);}
try {
  const host=await join('910001','dm',true,8,'  학과\n  대전\u0000  ');
  assert.equal(host.latest('welcome').room.roomName,'학과 대전');
  assert.equal(host.latest('waiting').canStart,false);host.start();
  assert.match((await wait('one-player rejection',()=>host.latest('start-denied'))).message,/두 명/);
  const guest=await join('910001');
  await wait('two-player roster',()=>host.latest('waiting')?.players===2);
  assert.equal(host.latest('waiting').hostId,host.id);
  assert.deepEqual(host.latest('waiting').members.map(m=>m.name),['Player 0','Player 1']);
  assert(host.latest('waiting').members.every(m=>m.ready===false),'Every entrant including host starts unready');
  guest.start();assert.match((await wait('guest rejection',()=>guest.latest('start-denied'))).message,/방장/);
  host.messages=[];host.send({type:'start-match',roomId:'old-room'});
  assert.match((await wait('stale room rejection',()=>host.latest('start-denied'))).message,/현재 방/);
  host.messages=[];await update(host,{ready:true});host.start();
  assert.match((await wait('unready guest blocks start',()=>host.latest('start-denied'))).message,/준비/);
  await prepare([host,guest]);
  const changed=await update(guest,{config:{...config,selectedWeapon:1},ready:true});
  assert.equal(changed.ready,false,'Changing equipment resets ready even if true is supplied alongside');assert.equal(changed.config.selectedWeapon,1);
  const invalid=await update(guest,{config:{...config,inventory:[50,10,1,6,49,24,18],selectedWeapon:10}});
  assert.equal(invalid.type,'lobby-update-denied');assert(!guest.socket.destroyed);assert.equal(guest.latest('waiting').members.find(m=>m.playerId===guest.id).ready,false);
  await prepare([host,guest]);
  assert.equal((await update(guest,{ready:false})).ready,false,'Editing begins only after unready acknowledgement');
  host.messages=[];host.start();assert.match((await wait('editing race blocks start',()=>host.latest('start-denied'))).message,/준비/);
  await prepare([host,guest]);
  host.start();host.start();
  const ready=await wait('partial-capacity start',()=>host.latest('peer-ready'));
  assert.equal(ready.peers.length,1);assert.equal(ready.maxPlayers,8);
  assert.equal(ready.config.rank.id,'recruit','server replaces client-supplied rank');
  assert.equal(ready.peers[0].config.rank.id,'recruit','remote rank is provided by server');
  assert.equal(ready.peers[0].config.selectedWeapon,1,'Start uses the saved lobby equipment');
  const tooLate=await update(guest,{ready:false});assert.equal(tooLate.code,'MATCH_STARTED');assert.equal(tooLate.lobby.canStart,false);assert(!guest.socket.destroyed);
  await wait('guest ready',()=>guest.latest('peer-ready'));await delay(60);
  assert.equal(host.messages.filter(m=>m.type==='peer-ready').length,1);

  const team=[await join('910002','tdm',true)];team.push(await join('910002','tdm'),await join('910002','tdm'));
  await wait('three team players',()=>team[0].latest('waiting')?.players===3);
  assert.equal(team[0].latest('waiting').canStart,false);team[0].start();
  assert.match((await wait('uneven team rejection',()=>team[0].latest('start-denied'))).message,/양 팀/);
  team[0].socket.end();
  await wait('host transfer',()=>team[1].latest('waiting')?.hostId===team[1].id);
  assert.deepEqual(team[1].latest('waiting').members.map(m=>m.team),[0,1]);
  await prepare(team.slice(1));
  assert.equal(team[1].latest('waiting').canStart,true);team[1].start();
  assert.equal((await wait('new host start',()=>team[1].latest('peer-ready'))).team,0);
  assert.equal((await wait('new guest start',()=>team[2].latest('peer-ready'))).team,1);

  const full=[];for(let i=0;i<8;i++)full.push(await join('910003','dm',i===0));
  await wait('full roster',()=>full[0].latest('waiting')?.players===8);await delay(100);
  assert(full.every(c=>!c.latest('peer-ready')),'manual room must not auto-start at full capacity');
  await prepare(full);
  full[0].start();await wait('all eight started',()=>full.every(c=>c.latest('peer-ready')?.peers.length===7));
  const duel=await join('910004','duel',true,2),duelGuest=await join('910004','duel',false,2);
  await delay(60);assert(!duel.latest('peer-ready'));await prepare([duel,duelGuest]);duel.start();
  await wait('manual duel starts',()=>duelGuest.latest('peer-ready'));
  const waitingHost=await join('910005','dm',true,4,'방'.repeat(50)),waitingGuest=await join('910005');
  assert.equal(waitingHost.latest('welcome').room.roomName.length,32,'Room name is bounded');
  await prepare([waitingHost,waitingGuest]);
  const editingEntrant=await join('910005');
  await wait('third entrant is in lobby',()=>waitingHost.latest('waiting').players===3);waitingHost.start();
  assert.match((await wait('new entrant still editing blocks start',()=>waitingHost.latest('start-denied'))).message,/준비/);
  assert.equal(waitingHost.latest('waiting').members.find(m=>m.playerId===editingEntrant.id).ready,false);
  editingEntrant.socket.end();await wait('cancelled editor leaves',()=>waitingHost.latest('waiting').players===2&&waitingHost.latest('waiting').canStart);
  waitingHost.start();await wait('remaining prepared players start',()=>waitingGuest.latest('peer-ready'));
  console.log('PASS lobby: named/bounded rooms, initial unready host/guest, explicit readiness, saved equipment resets readiness, nonfatal invalid update, ACK-before-edit/start race, late entrant setup blocks start, balanced teams, host transfer and full eight-player manual start.');
} finally {
  for(const c of clients)c.socket.destroy();await server.close();fs.rmSync(temp,{recursive:true,force:true});
}
