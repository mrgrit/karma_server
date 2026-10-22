import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import net from 'node:net';
import crypto from 'node:crypto';
import {startKarmaServer} from './server.mjs';
const temp=fs.mkdtempSync(path.join(os.tmpdir(),'karma-limits-'));
// A short default proves a room's requested 60-second timer overrides it.
const server=await startKarmaServer({host:'127.0.0.1',port:0,healthPort:0,dataDir:temp,matchSeconds:1,logger:()=>{}});
const catalog=JSON.parse(fs.readFileSync(new URL('loadouts.json',import.meta.url),'utf8').replace(/^\uFEFF/,''));
const config={map:0,age:0,character:{index:0,camp:0},inventory:catalog.defaultInventory,selectedWeapon:9,settings:{build:'karma290-central5'}};
const clients=[],delay=ms=>new Promise(r=>setTimeout(r,ms));
async function wait(fn){for(let i=0;i<200;i++){const v=fn();if(v)return v;await delay(20);}throw Error('Limit test timeout');}
let serial=0;
async function connect(code,create,limits={},account){
 account??=await server.auth.createAccount({email:crypto.randomUUID()+'@limits.invalid',password:crypto.randomUUID(),name:'Limit '+(++serial)});
 const c={socket:net.createConnection({host:'127.0.0.1',port:server.port}),id:account.playerId,messages:[]};clients.push(c);let buffer='';
 c.socket.setEncoding('utf8');c.socket.on('error',()=>{});c.socket.on('data',chunk=>{buffer+=chunk;let end;while((end=buffer.indexOf('\n'))>=0){c.messages.push(JSON.parse(buffer.slice(0,end)));buffer=buffer.slice(end+1);}});
 c.send=value=>c.socket.write(JSON.stringify(value)+'\n');c.last=type=>c.messages.filter(m=>m.type===type).at(-1);
 await new Promise(resolve=>c.socket.once('connect',resolve));
 c.send({type:'hello',version:2,op:create?'create':'join',code,mode:'dm',maxPlayers:8,clientMaxPlayers:8,manualStart:true,config,authToken:server.auth.issueSession(account).authToken,...limits});
 await wait(()=>c.last('welcome')||c.last('error'));return c;
}
async function start(a,b){
 for(const c of [a,b])c.send({type:'lobby-update',requestId:crypto.randomUUID(),ready:true});
 await wait(()=>a.last('waiting')?.canStart);a.send({type:'start-match',roomId:a.last('welcome').room.roomId});
 await wait(()=>b.last('peer-ready'));
}
try{
 const invalid=await server.auth.createAccount({email:'invalid@limits.invalid',password:crypto.randomUUID(),name:'Invalid'});
 for(const [field,values] of Object.entries({killLimit:[0,31,1.5,'30'],roundWinLimit:[0,11,2.5,'10'],timeLimitSeconds:[0,59,1801,60.5,'60']}))for(const value of values){
  const c=await connect('975001',true,{[field]:value},invalid);assert.equal(c.last('error')?.code,'BAD_MESSAGE',field+' '+value);c.socket.destroy();
 }
 const high=await connect('975002',true,{killLimit:30,roundWinLimit:10,timeLimitSeconds:1800});
 const r=high.last('welcome').room;assert.equal(r.killLimit,30);assert.equal(r.timeLimitSeconds,1800);
 const long=await connect('975003',true,{killLimit:1,roundWinLimit:1,timeLimitSeconds:60}),guest=await connect('975003',false,{killLimit:30,timeLimitSeconds:1800});
 await start(long,guest);assert.equal(guest.last('peer-ready').killLimit,1);assert.equal(guest.last('peer-ready').timeLimitSeconds,60,'joiner cannot replace host rules');
 const short=await connect('975004',true),other=await connect('975004',false);await start(short,other);
 const ended=await wait(()=>short.last('match-ended'));
 assert.equal(ended.result.reason,'time-limit');assert.equal(ended.result.draw,true);assert.equal(ended.result.timeLimitSeconds,1);
 assert.deepEqual(Object.values(ended.result.deaths),[0,0]);assert.deepEqual(Object.values(ended.result.points),[0,0]);
 assert(!long.last('match-ended'),'room time limit overrides short server default');
 const late=await connect('975003',false);assert.equal((await wait(()=>late.last('peer-ready'))).timeLimitSeconds,60);
 assert.equal(late.last('peer-ready').killLimit,1);assert(late.last('peer-ready').lateJoin);
 console.log('PASS room limits: bounds/types, host authority, per-room timer, time-limit draw/results, late join rules.');
}finally{
 for(const c of clients)c.socket.destroy();await server.close();
 for(const file of ['auth.json','profiles.json']){const p=path.join(temp,file);if(fs.existsSync(p))fs.unlinkSync(p);}fs.rmdirSync(temp);
}
