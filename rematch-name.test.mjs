import assert from 'node:assert/strict';import fs from 'node:fs';import os from 'node:os';import path from 'node:path';import crypto from 'node:crypto';import net from 'node:net';
import {startKarmaServer} from './server.mjs';import {FairPlay} from './fairplay.mjs';
const temp=fs.mkdtempSync(path.join(os.tmpdir(),'karma-rematch-'));let server;const sockets=[];
const wait=async fn=>{for(let i=0;i<200;i++){const v=fn();if(v)return v;await new Promise(r=>setTimeout(r,20));}throw Error('timeout');};
const options={host:'127.0.0.1',port:0,healthPort:0,dataDir:temp,matchSeconds:1,logger:()=>{}};
const catalog=JSON.parse(fs.readFileSync(new URL('loadouts.json',import.meta.url),'utf8'));
const config={map:0,age:0,character:{index:0,camp:0},inventory:catalog.defaultInventory,selectedWeapon:9,settings:{build:'karma290-central5'}};
async function join(token,create,roomId){
 const c={messages:[],socket:net.createConnection({host:'127.0.0.1',port:server.port})};sockets.push(c.socket);let buffer='';
 c.socket.on('error',()=>{});c.socket.on('data',chunk=>{buffer+=chunk;let end;while((end=buffer.indexOf('\n'))>=0){c.messages.push(JSON.parse(buffer.slice(0,end)));buffer=buffer.slice(end+1);}});
 c.last=t=>c.messages.filter(x=>x.type===t).at(-1);c.send=m=>c.socket.write(JSON.stringify(m)+'\n');
 await new Promise(r=>c.socket.once('connect',r));c.send({type:'hello',version:2,op:create?'create':'join',code:'987654',roomName:'돌아올 방',mode:'duel',maxPlayers:2,clientMaxPlayers:8,manualStart:true,returnLobby:true,config,authToken:token,...(roomId?{roomId}:{})});
 await wait(()=>c.last('welcome')||c.last('error'));return c;
}
async function request(token,route,body,method='POST'){
 const response=await fetch(`http://127.0.0.1:${server.healthPort}${route}`,{method,headers:{Authorization:'Bearer '+token,'Content-Type':'application/json'},...(method==='GET'?{}:{body:JSON.stringify(body)})});return {status:response.status,value:await response.json()};
}
try{
 server=await startKarmaServer(options);
 const a=await server.auth.createAccount({email:'a@test.invalid',password:crypto.randomUUID(),name:'원래이름',role:'admin'});
 const b=await server.auth.createAccount({email:'b@test.invalid',password:crypto.randomUUID(),name:'상대'});
 const ta=server.auth.issueSession(a).authToken,tb=server.auth.issueSession(b).authToken;
 let response=await request(ta,'/api/name',{name:'새이름',playerId:b.playerId});assert.equal(response.status,200);assert.equal(response.value.profile.name,'새이름');assert.equal(server.auth.authenticate(tb).name,'상대');
 assert.equal((await request(ta,'/api/name',{name:'x'.repeat(33)})).status,400);
 let pair=[await join(ta,true),await join(tb,false)],oldId;
 for(let round=0;round<2;round++){
  const id=pair[0].last('welcome').room.roomId;if(oldId)assert.notEqual(id,oldId);oldId=id;
  assert.equal(pair[0].last('welcome').room.roomName,'돌아올 방');
  assert.equal((await request(ta,'/api/name',{name:'경기중'})).status,409);
  for(const c of pair)c.send({type:'lobby-update',requestId:crypto.randomUUID(),ready:true});
  await wait(()=>pair[0].last('waiting')?.canStart);pair[0].send({type:'start-match',roomId:id});
  const end=await wait(()=>pair[0].last('match-ended'));assert.notEqual(end.returnLobby.roomId,id);assert.equal(end.returnLobby.code,'987654');
  await wait(()=>pair.every(c=>c.socket.destroyed));
  if(round===0)pair=[await join(ta,false,end.returnLobby.roomId),await join(tb,false,end.returnLobby.roomId)];
 }
 response=await request(ta,'/api/me',null,'GET');assert.equal(response.value.profile.matches,2);assert.equal(response.value.profile.draws,2);
 await server.close();server=null;
 const f=new FairPlay(path.join(temp,'fairplay.json'));f.data.cases.push({id:'case-test',playerId:b.playerId,otherPlayerId:a.playerId,createdAt:Date.now(),reason:'test',evidence:{},releasedAt:null});f.save();
 server=await startKarmaServer(options);
 const denied=await join(tb,true);assert.equal(denied.last('error').code,'FAIRPLAY_HOLD');
 assert.equal((await request(tb,'/api/me',null,'GET')).status,200,'held users can still view profile');
 assert.equal((await request(tb,'/api/admin/fairplay/release',{id:'case-test'})).status,403);
 assert.equal((await request(ta,'/api/admin/fairplay/release',{id:'case-test'})).status,200);
 const allowed=await join(tb,true);assert(allowed.last('welcome'),'admin release allows play again');
 console.log('PASS rematch/name/holds: two rounds in same named room, fresh match IDs and readiness, exactly-once records, own-name rename, busy-name guard, hold survives restart, admin-only release and continued profile access');
}finally{for(const s of sockets)s.destroy();if(server)await server.close();fs.rmSync(temp,{recursive:true,force:true});}
