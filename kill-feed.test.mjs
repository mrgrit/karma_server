import assert from 'node:assert/strict';
import fs from 'node:fs';import os from 'node:os';import path from 'node:path';import crypto from 'node:crypto';import net from 'node:net';
import {startKarmaServer} from './server.mjs';
const temp=fs.mkdtempSync(path.join(os.tmpdir(),'karma-feed-'));
const feedMap=Number(process.env.KARMA_TEST_MAP||0),mapFile=path.join(temp,'maps.json');
const mapData=JSON.parse(fs.readFileSync(new URL('multiplayer-maps.json',import.meta.url),'utf8'));mapData.maps.find(m=>m.mapIndex===feedMap).publicReady=true;fs.writeFileSync(mapFile,JSON.stringify(mapData));
const server=await startKarmaServer({host:'127.0.0.1',port:0,healthPort:0,dataDir:temp,mapFile,logger:()=>{}});
const catalog=JSON.parse(fs.readFileSync(new URL('loadouts.json',import.meta.url),'utf8').replace(/^\uFEFF/,''));
const config={map:feedMap,age:0,character:{index:0,camp:0},inventory:catalog.defaultInventory,selectedWeapon:9,settings:{build:'karma290-central6'}};
const clients=[],delay=ms=>new Promise(r=>setTimeout(r,ms));
async function wait(fn){for(let i=0;i<200;i++){const v=fn();if(v)return v;await delay(15);}throw Error('feed test timeout');}
async function join(code,host){
 const account=await server.auth.createAccount({email:crypto.randomUUID()+'@feed.invalid',password:crypto.randomUUID(),name:'학생 '+clients.length});
 const c={socket:net.createConnection({host:'127.0.0.1',port:server.port}),id:account.playerId,name:account.name,messages:[]};clients.push(c);let buffer='';
 c.socket.setEncoding('utf8');c.socket.on('error',()=>{});c.socket.on('data',chunk=>{buffer+=chunk;let end;while((end=buffer.indexOf('\n'))>=0){c.messages.push(JSON.parse(buffer.slice(0,end)));buffer=buffer.slice(end+1);}});
 c.send=m=>c.socket.write(JSON.stringify(m)+'\n');c.last=t=>c.messages.filter(m=>m.type===t).at(-1);
 await new Promise(r=>c.socket.once('connect',r));c.send({type:'hello',version:2,op:host?'create':'join',code,mode:'duel',maxPlayers:2,clientMaxPlayers:8,manualStart:true,config,authToken:server.auth.issueSession(account).authToken});
 await wait(()=>c.last('welcome'));return c;
}
const state=(life,seq=1)=>({type:'state',version:1,life,seq,pos:[100,0,100],yaw:0,pitch:0,sector:4,weapon:9,hp:100});
try{
 const a=await join('967001',true),b=await join('967001',false),outside=await join('967002',true);
 for(const c of [a,b])c.send({type:'lobby-update',requestId:crypto.randomUUID(),ready:true});
 await wait(()=>a.last('waiting')?.canStart);a.send({type:'start-match',roomId:a.last('welcome').room.roomId});await wait(()=>b.last('peer-ready'));
 for(const [index,kind,region,headshot] of [[1,'bullet',0,true],[2,'bullet',1,false],[3,'pellets',null,false],[4,'projectile',null,false]]){
  a.send({type:'game',message:state(1,index+1)});b.send({type:'game',message:state(index)});
  const hit={type:'hit',version:1,life:1,seq:index+10,id:index,victimLife:index,weapon:9,kind,region,direction:[1,0,0],count:3};
  if(kind==='projectile')a.send({type:'game',message:{...state(1,index+20),shot:{id:index,life:1,weapon:9,origin:[0,0,0],direction:[1,0,0],sector:4,renderSector:4,yaw:0,pitch:0}}});
  else a.send({type:'game',message:hit});
  await wait(()=>b.messages.some(m=>m.type==='game'&&(m.message.id===index||m.message.shot?.id===index)));
  b.send({type:'damage-proof',proof:{id:'damage'+index,shotId:index,victimLife:index,attackerId:a.id,attackerLife:1,weapon:9,before:100,after:0,headshot:true,hitKind:'bullet',hitRegion:0}});
  const death={type:'death',version:1,life:index,seq:2,killer:'remote',weapon:9,damageId:'damage'+index,hpAfter:0};b.send({type:'game',message:death});
  const event=await wait(()=>a.messages.find(m=>m.type==='death-confirmed'&&m.receipt.victimLife===index));
  await wait(()=>b.messages.some(m=>m.feed?.id===event.feed.id));
  assert.equal(event.feed.kind,'kill');assert.equal(event.feed.headshot,headshot);assert.equal(event.feed.killerName,a.name);assert.equal(event.feed.victimName,b.name);
  assert.equal(event.feed.techniqueName,({0:'ARP 스푸핑',18:'MAC 주소 위조',16:'가상 네트워크 제어 평면 탈취'})[feedMap]);assert.equal(event.feed.weaponName,'MP38');assert.equal(event.feed.killerId,a.id);assert(event.receipt.verified);
  assert.equal(event.receipt.damage.hitRegion,kind==='bullet'?region:null);
  b.send({type:'game',message:death});await delay(30);assert.equal(a.messages.filter(m=>m.feed?.id===event.feed.id).length,1);
 }
 b.send({type:'game',message:state(5)});b.send({type:'game',message:{type:'death',version:1,life:5,seq:2,killer:'self',weapon:9,hpAfter:0}});
 assert.equal((await wait(()=>a.messages.find(m=>m.receipt?.victimLife===5))).feed.kind,'self');
 b.send({type:'game',message:state(6)});b.send({type:'game',message:{type:'death',version:1,life:6,seq:2,killer:'remote',weapon:9,hpAfter:0}});
 const unknown=await wait(()=>a.messages.find(m=>m.receipt?.victimLife===6));assert.equal(unknown.feed.kind,'death');assert.equal(unknown.feed.killerId,null);assert.equal(unknown.feed.headshot,false);
 const me=await fetch(`http://127.0.0.1:${server.healthPort}/api/me`,{headers:{Authorization:'Bearer '+server.auth.issueSession(server.auth.list().find(x=>x.playerId===a.id)).authToken}}).then(r=>r.json());
 assert.equal(me.catalog.mastery.curriculum.maps.length,15);
 assert.equal(me.profile.mastery.techniques.find(t=>t.weaponId===9).successes,4);
 assert.equal(me.profile.mastery.techniques.find(t=>t.weaponId===9).qualified,3);
 assert(!outside.messages.some(m=>m.type==='death-confirmed'));
 console.log('PASS kill feed: verified name/weapon/death, head/body/pellet/projectile classification, forged headshot ignored, self/unverified labels, one event per life, both recipients, room isolation.');
}finally{for(const c of clients)c.socket.destroy();await server.close();for(const file of ['auth.json','profiles.json','fairplay.json','maps.json']){const p=path.join(temp,file);if(fs.existsSync(p))fs.unlinkSync(p);}fs.rmdirSync(temp);}
