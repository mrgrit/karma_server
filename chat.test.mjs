import assert from 'node:assert/strict';
import fs from 'node:fs';import os from 'node:os';import path from 'node:path';import crypto from 'node:crypto';import net from 'node:net';
import {startKarmaServer} from './server.mjs';
import {ChatArchive} from './chat-policy.mjs';
const temp=fs.mkdtempSync(path.join(os.tmpdir(),'karma-chat-'));
const server=await startKarmaServer({host:'127.0.0.1',port:0,healthPort:0,dataDir:temp,roundSeconds:1,roundIntermissionMs:2000,logger:()=>{}});
const catalog=JSON.parse(fs.readFileSync(new URL('loadouts.json',import.meta.url),'utf8').replace(/^\uFEFF/,''));
const config={map:0,age:0,character:{index:0,camp:0},inventory:catalog.defaultInventory,selectedWeapon:9,settings:{build:'karma290-central5'}};
const clients=[],delay=ms=>new Promise(r=>setTimeout(r,ms));
async function wait(fn){for(let i=0;i<200;i++){const v=fn();if(v)return v;await delay(20);}throw Error('chat test timeout');}
async function join(code,mode,host){
 const account=await server.auth.createAccount({email:crypto.randomUUID()+'@chat.invalid',password:crypto.randomUUID(),name:'학생 '+clients.length});
 const c={socket:net.createConnection({host:'127.0.0.1',port:server.port}),id:account.playerId,name:account.name,token:server.auth.issueSession(account).authToken,messages:[]};clients.push(c);let buffer='';
 c.socket.setEncoding('utf8');c.socket.on('error',()=>{});c.socket.on('data',chunk=>{buffer+=chunk;let end;while((end=buffer.indexOf('\n'))>=0){c.messages.push(JSON.parse(buffer.slice(0,end)));buffer=buffer.slice(end+1);}});
 c.send=m=>c.socket.write(JSON.stringify(m)+'\n');c.last=t=>c.messages.filter(m=>m.type===t).at(-1);
 await new Promise(r=>c.socket.once('connect',r));c.send({type:'hello',version:2,op:host?'create':'join',code,mode,maxPlayers:4,clientMaxPlayers:8,manualStart:true,config,authToken:server.auth.issueSession(account).authToken});
 await wait(()=>c.last('welcome'));return c;
}
async function chat(c,id,channel,text,extra={}){c.send({type:'chat-send',requestId:id,channel,text,...extra});return await wait(()=>c.messages.find(m=>['chat','chat-denied'].includes(m.type)&&m.requestId===id));}
async function start(group){for(const c of group)c.send({type:'lobby-update',requestId:crypto.randomUUID(),ready:true});await wait(()=>group[0].last('waiting')?.canStart);group[0].send({type:'start-match',roomId:group[0].last('welcome').room.roomId});await wait(()=>group.at(-1).last('peer-ready'));}
try{
 const team=[];for(let i=0;i<4;i++)team.push(await join('966001','tdm',i===0));
 const outside=await join('966002','dm',true);
 const all=await chat(team[0],'lobby-all','all','안녕하세요\n함께 해요',{senderId:'spoof',name:'가짜 이름',team:1});
 assert.equal(all.senderId,team[0].id);assert.equal(all.name,team[0].name);assert.equal(all.team,0);assert.equal(all.text,'안녕하세요 함께 해요');
 await wait(()=>team.every(c=>c.messages.some(m=>m.id===all.id)));assert(!outside.messages.some(m=>m.type==='chat'));
 const privateMessage=await chat(team[0],'lobby-team','team','우리 팀만');await wait(()=>team[2].messages.some(m=>m.id===privateMessage.id));await delay(50);
 assert(team.filter((_,i)=>i%2).every(c=>!c.messages.some(m=>m.id===privateMessage.id)),'opponents never receive team text');
 team[0].send({type:'chat-send',requestId:'lobby-team',channel:'team',text:'우리 팀만'});await delay(50);
 assert.equal(team[2].messages.filter(m=>m.id===privateMessage.id).length,1,'replay is not rebroadcast');
 assert.equal((await chat(outside,'bad-channel','team','invalid')).code,'BAD_CHAT_CHANNEL');
 assert.equal((await chat(outside,'long','all','x'.repeat(201))).code,'BAD_CHAT_TEXT');
 assert.equal((await chat(outside,'blank','all',' \n ')).code,'BAD_CHAT_TEXT');assert(!outside.socket.destroyed);
 await start(team);
 const inGame=await chat(team[0],'game-all','all','게임 중 전체');await wait(()=>team.every(c=>c.messages.some(m=>m.id===inGame.id)));
 const inTeam=await chat(team[0],'game-team','team','게임 중 팀');await wait(()=>team[2].messages.some(m=>m.id===inTeam.id));
 assert(team.filter((_,i)=>i%2).every(c=>!c.messages.some(m=>m.id===inTeam.id)));
 await wait(()=>team[0].last('round-ended'));
 assert.equal((await chat(team[0],'intermission','team','다음 라운드')).type,'chat');
 assert.equal((await chat(team[0],'flood','all','너무 빠름')).code,'CHAT_RATE_LIMIT');assert(!team[0].socket.destroyed);
 const mate=await join('966002','dm',false);await start([outside,mate]);const late=await join('966002','dm',false);await wait(()=>late.last('peer-ready'));
 const lateMessage=await chat(late,'late','all','중간 참가했어요');await wait(()=>outside.messages.some(m=>m.id===lateMessage.id)&&mate.messages.some(m=>m.id===lateMessage.id));
 assert(team.every(c=>!c.messages.some(m=>m.id===lateMessage.id)));
 const masked=await chat(team[1],'masked-team','team','씨.발 같이 하자');assert.equal(masked.text,'*** 같이 하자');assert.equal(masked.moderated,true);
 await wait(()=>team[3].messages.some(m=>m.id===masked.id));assert(!team[0].messages.some(m=>m.id===masked.id));assert(!('originalText' in masked));
 team[1].send({type:'chat-send',requestId:'masked-team',channel:'team',text:'씨.발 같이 하자'});await delay(50);
 assert.equal(team[3].messages.filter(m=>m.id===masked.id).length,1,'masked replay does not rebroadcast');
 const admin=await server.auth.createAccount({email:'admin@chat.invalid',password:crypto.randomUUID(),name:'관리자',role:'admin'});
 const endpoint='http://127.0.0.1:'+server.healthPort+'/api/admin/chat-logs';
 assert.equal((await fetch(endpoint)).status,401);assert.equal((await fetch(endpoint,{headers:{Authorization:'Bearer '+team[1].token}})).status,403);
 const headers={Authorization:'Bearer '+server.auth.issueSession(admin).authToken};
 const records=await(await fetch(endpoint,{headers})).json(),entry=records.entries.find(e=>e.id===masked.id);
 assert.equal(entry.originalText,'씨.발 같이 하자');assert.equal(entry.displayText,'*** 같이 하자');assert.equal(entry.channel,'team');assert.equal(entry.name,team[1].name);
 assert.equal(records.entries.filter(e=>e.id===masked.id).length,1,'replay stored only once');assert(records.entries.some(e=>e.id===all.id&&e.phase==='lobby'));assert(records.entries.some(e=>e.id===inGame.id&&e.phase==='game'));
 assert.equal((await fetch(endpoint+'?day=..%2Fauth',{headers})).status,400);
 const append=ChatArchive.prototype.append;ChatArchive.prototype.append=()=>{throw Object.assign(Error('disk unavailable'),{code:'ENOSPC'});};
 try{assert.equal((await chat(team[1],'storage-failure','all','기록 안되면 전송 안함')).code,'CHAT_STORAGE_UNAVAILABLE');assert(!team[0].messages.some(m=>m.requestId==='storage-failure'));assert(!team[1].socket.destroyed);}finally{ChatArchive.prototype.append=append;}
 console.log('PASS moderated chat: masked team fanout, no raw-text leakage, replay exactly once, private admin archive/API, lobby/game records, disk failure blocks delivery without disconnect.');
 console.log('PASS chat: lobby/game/intermission/late join, all/team routing, no cross-room or opposing-team leak, authoritative identity, normalization, invalid input nonfatal, dedup and rate limits.');
}finally{for(const c of clients)c.socket.destroy();await server.close();for(const file of ['auth.json','profiles.json']){const p=path.join(temp,file);if(fs.existsSync(p))fs.unlinkSync(p);}const logs=path.join(temp,'chat-logs');if(fs.existsSync(logs)){for(const file of fs.readdirSync(logs))fs.unlinkSync(path.join(logs,file));fs.rmdirSync(logs);}fs.rmdirSync(temp);}
