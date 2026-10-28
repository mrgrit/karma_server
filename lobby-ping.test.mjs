import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import net from 'node:net';
import crypto from 'node:crypto';
import {LobbyPing} from './lobby-ping.mjs';
import {startKarmaServer} from './server.mjs';
import {GAME_RULES,validateRules} from './rules.mjs';

let now=0,n=0;const clock={now:()=>now,nonce:()=>String(++n).padStart(24,'0')};
const ping=new LobbyPing(clock),other=new LobbyPing(clock);
assert.deepEqual(ping.snapshot(),{pingMs:null,pingStatus:'measuring'});
const first=ping.probe(),foreign=other.probe();assert.equal(ping.probe(),null,'one outstanding probe');
now=42.4;assert.equal(ping.accept(foreign.token),false,'another connection cannot answer');
assert.equal(ping.accept({token:first.token}),false);assert(ping.accept(first.token));
assert.deepEqual(ping.snapshot(),{pingMs:42,pingStatus:'ok'});
now=1500;assert.equal(ping.accept(first.token),false,'replay cannot overwrite RTT');assert.equal(ping.probe(),null);
now=3000;const second=ping.probe();now=8000;
assert.equal(ping.accept(second.token),false,'expired response cannot revive old latency');assert.equal(ping.snapshot().pingMs,null);
const recovery=ping.probe();assert.equal(ping.snapshot().pingStatus,'timeout');now+=.2;assert(ping.accept(recovery.token));
assert.deepEqual(ping.snapshot(),{pingMs:0,pingStatus:'ok'},'sub-millisecond RTT remains valid');
const fresh=new LobbyPing(clock);assert.equal(fresh.snapshot().pingMs,null,'reconnect never inherits a former RTT');

const temp=fs.mkdtempSync(path.join(os.tmpdir(),'karma-lobby-ping-'));
const server=await startKarmaServer({host:'127.0.0.1',port:0,healthPort:0,dataDir:temp,logger:()=>{}}),clients=[];
const catalog=JSON.parse(fs.readFileSync(new URL('./loadouts.json',import.meta.url),'utf8'));
const config={map:0,age:0,character:{index:0,camp:0},inventory:catalog.defaultInventory,selectedWeapon:9,settings:{build:'karma290-central6'}};
const delay=ms=>new Promise(resolve=>setTimeout(resolve,ms));
async function wait(fn,label){for(let i=0;i<450;i++){const value=fn();if(value)return value;await delay(20);}throw Error('Timeout: '+label);}
async function join(host,supported=true,auto=true){
 const account=await server.auth.createAccount({email:crypto.randomUUID()+'@test.invalid',name:'Ping '+clients.length,password:crypto.randomUUID(),rulesAcceptance:validateRules({rulesAccepted:true,rulesVersion:GAME_RULES.version})});
 const socket=net.createConnection({host:'127.0.0.1',port:server.port}),c={socket,id:account.playerId,messages:[],auto};clients.push(c);
 c.send=m=>socket.write(JSON.stringify(m)+'\n');c.latest=type=>c.messages.filter(m=>m.type===type).at(-1);
 let buffer='';socket.setEncoding('utf8');socket.on('error',()=>{});socket.on('data',chunk=>{
  buffer+=chunk;let end;while((end=buffer.indexOf('\n'))>=0){const m=JSON.parse(buffer.slice(0,end));buffer=buffer.slice(end+1);c.messages.push(m);
   if(m.type==='latency-probe'&&c.auto)setTimeout(()=>{if(!socket.destroyed)c.send({type:'latency-reply',token:m.token,pingMs:0});},40);
  }
 });
 await new Promise(resolve=>socket.once('connect',resolve));
 c.send({type:'hello',version:2,op:host?'create':'join',code:'938101',maxPlayers:8,clientMaxPlayers:8,manualStart:true,mode:'dm',config,authToken:server.auth.issueSession(account).authToken,...(supported?{lobbyPing:1}:{})});
 c.roomId=(await wait(()=>c.latest('welcome'),'welcome')).room.roomId;return c;
}
try{
 const host=await join(true),quiet=await join(false,true,false),legacy=await join(false,false);
 const roster=()=>host.latest('waiting')?.members||[];
 const measured=await wait(()=>roster().find(m=>m.playerId===host.id&&m.pingStatus==='ok'),'RTT visible to room');
 assert(measured.pingMs>=30&&measured.pingMs<5000,'server measures elapsed time, ignores claimed zero');
 assert.equal(roster().find(m=>m.playerId===legacy.id).pingStatus,'unsupported');
 assert.equal(legacy.messages.some(m=>m.type==='latency-probe'),false,'legacy clients never receive an unknown packet');
 for(const c of clients)c.send({type:'lobby-update',requestId:'ready-'+c.id,ready:true});
 await wait(()=>host.latest('waiting')?.canStart,'readiness');
 const revision=host.latest('waiting').roomRevision;
 host.send({type:'latency-reply',token:'forged',pingMs:1});
 await wait(()=>roster().find(m=>m.playerId===quiet.id&&m.pingStatus==='timeout'),'missing response becomes unavailable');
 assert.equal(roster().find(m=>m.playerId===quiet.id).pingMs,null);assert.equal(host.latest('waiting').canStart,true);
 assert.equal(host.latest('waiting').roomRevision,revision);assert(!host.socket.destroyed&&!quiet.socket.destroyed,'measurement never kicks or resets readiness');
 quiet.auto=true;quiet.send({type:'latency-reply',token:quiet.latest('latency-probe').token});
 await wait(()=>roster().find(m=>m.playerId===quiet.id&&m.pingStatus==='ok'),'recovery');
 assert(legacy.latest('waiting').members.some(m=>m.playerId===host.id&&m.pingStatus==='ok'),'legacy roster still usable');
 host.send({type:'start-match',roomId:host.roomId});await wait(()=>clients.every(c=>c.latest('peer-ready')),'start with latency enabled');
 const count=clients.reduce((sum,c)=>sum+c.messages.filter(m=>m.type==='latency-probe').length,0);
 host.send({type:'latency-reply',token:host.latest('latency-probe').token});await delay(3200);
 assert.equal(clients.reduce((sum,c)=>sum+c.messages.filter(m=>m.type==='latency-probe').length,0),count,'lobby probes stop during a match');
 assert(clients.every(c=>!c.socket.destroyed&&!c.messages.some(m=>m.type==='error')));
 console.log('PASS lobby ping: monotonic connection-bound RTT, spoof/replay/expiry rejection, timeout/recovery, mixed versions, room fanout, readiness/settings preserved and no probes during gameplay.');
}finally{for(const c of clients)c.socket.destroy();await server.close();fs.rmSync(temp,{recursive:true,force:true});}
