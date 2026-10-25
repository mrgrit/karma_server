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
const config={map:0,age:0,character:{index:0,camp:0},rank:{id:'lieutenant'},inventory:catalog.defaultInventory,selectedWeapon:9,settings:{build:'karma290-central6'}};
const clients=[],delay=ms=>new Promise(r=>setTimeout(r,ms));
async function wait(label,fn){for(let i=0;i<250;i++){const value=fn();if(value)return value;await delay(20);}throw Error('Timeout: '+label);}
async function join(code,mode='dm',host=false,capacity=8,roomName){
  const account=await server.auth.createAccount({email:crypto.randomUUID()+'@test.invalid',password:crypto.randomUUID(),name:'Player '+clients.length});
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
 const host=await join('918001','dm',true,8,'원래 방'),guest=await join('918001'),third=await join('918001');
 await wait('three players',()=>host.latest('waiting')?.players===3);await prepare([host,guest,third]);
 const settings={map:7,roomName:'새 팩토리 방',mode:'dm',maxPlayers:4,killLimit:20,roundWinLimit:4,timeLimitSeconds:900};
 const request=(c,roomSettings=settings,roomRevision=0,roomId=c.roomId)=>update(c,{roomSettings,roomRevision,roomId});
 assert.equal((await request(guest)).code,'HOST_ONLY');assert(host.latest('waiting').members.every(m=>m.ready));
 assert.equal((await request(host,settings,0,'stale')).code,'ROOM_CHANGED');
 assert.equal((await request(host,{...settings,map:18})).code,'BAD_CONFIG','closed maps cannot drag users into admin preview');
 assert.equal((await request(host,{...settings,map:19,maxPlayers:8})).code,'MAP_CAPACITY');
 assert.equal((await request(host,{...settings,maxPlayers:2})).code,'ROOM_CAPACITY');
 assert.equal((await request(host,{...settings,mode:'tdm',maxPlayers:3})).code,'BAD_MODE');
 assert.equal((await request(host,{...settings,timeLimitSeconds:0})).type,'lobby-update-denied');
 assert.equal(host.latest('waiting').map,0,'invalid changes are atomic');
 assert(host.latest('waiting').members.every(m=>m.ready),'failed changes do not reset readiness');
 const changed=await request(host);assert.equal(changed.type,'lobby-updated');assert.equal(changed.config.map,7);
 await wait('all see new map',()=>[host,guest,third].every(c=>c.latest('waiting')?.roomRevision===1));
 for(const c of [host,guest,third]){const l=c.latest('waiting');assert.equal(l.roomName,settings.roomName);assert.equal(l.map,7);assert.equal(l.maxPlayers,4);assert.equal(l.timeLimitSeconds,900);assert(l.members.every(m=>!m.ready));assert.equal(l.canStart,false);}
 assert.equal((await request(host,settings,0)).code,'ROOM_CHANGED','old dialog cannot overwrite a newer change');
 host.socket.end();await wait('host transfer',()=>guest.latest('waiting')?.hostId===guest.id);
 const next={...settings,map:4,mode:'tdm',maxPlayers:2,roomName:'레스큐 팀전'};
 assert.equal((await request(guest,next,1)).type,'lobby-updated');await prepare([guest,third]);guest.start();
 await wait('started on changed map',()=>third.latest('peer-ready'));
 for(const c of [guest,third]){const r=c.latest('peer-ready');assert.equal(r.config.map,4);assert.equal(r.remoteHello.config.map,4);assert.equal(r.mode,'tdm');assert.equal(r.maxPlayers,2);assert.equal(r.roundWinLimit,4);}
 assert.equal((await request(guest,next,2)).code,'MATCH_STARTED');
 console.log('PASS room settings: host authorization, stale revisions, closed maps/capacity validation, atomic failures, all-player unready, host transfer, final map/mode/config at start');
} finally {for(const c of clients)c.socket.destroy();await server.close();fs.rmSync(temp,{recursive:true,force:true});}
