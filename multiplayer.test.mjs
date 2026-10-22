import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import crypto from 'node:crypto';
import net from 'node:net';
import {startKarmaServer} from './server.mjs';

const temp=fs.mkdtempSync(path.join(os.tmpdir(),'karma-multiplayer-'));
const server=await startKarmaServer({host:'127.0.0.1',port:0,healthPort:0,dataDir:temp,matchKills:10,
 roundWinLimit:5,roundIntermissionMs:120,dmRespawnMs:150,logger:()=>{}});
const catalog=JSON.parse(fs.readFileSync(new URL('loadouts.json',import.meta.url),'utf8').replace(/^\uFEFF/,''));
const config={map:0,age:0,character:{index:0,camp:0},inventory:catalog.defaultInventory,selectedWeapon:9,settings:{build:'karma290-central3'}};
const clients=[];
const delay=ms=>new Promise(r=>setTimeout(r,ms));
async function wait(label,predicate){for(let i=0;i<250;i++){const v=predicate();if(v)return v;await delay(20);}throw Error('Timeout: '+label);}
async function client(i,mode,code){
 const account=await server.auth.createAccount({email:`${mode}-${i}@test.invalid`,password:crypto.randomUUID(),name:`Player ${i}`});
 const socket=net.createConnection({host:'127.0.0.1',port:server.port}),c={socket,id:account.playerId,messages:[],seq:0,life:1};let buffer='';
 socket.setEncoding('utf8');socket.on('error',()=>{});socket.on('data',chunk=>{
  buffer+=chunk;let end;while((end=buffer.indexOf('\n'))>=0){c.messages.push(JSON.parse(buffer.slice(0,end)));buffer=buffer.slice(end+1);}
 });
 c.send=m=>socket.write(JSON.stringify(m)+'\n');
 c.state=(extra={})=>c.send({type:'game',message:{version:1,type:c.life>1?'respawn':'state',life:c.life,seq:++c.seq,
  pos:[100,400,100],sector:4,weapon:9,selectedWeapon:9,hp:100,yaw:0,pitch:0,inventory:config.inventory,...extra}});
 await new Promise((resolve,reject)=>{socket.once('connect',resolve);socket.once('error',reject);});clients.push(c);
 c.send({type:'hello',version:2,op:i===0?'create':'join',code,config,mode,maxPlayers:8,clientMaxPlayers:8,killLimit:2,roundWinLimit:2,timeLimitSeconds:60,authToken:server.auth.issueSession(account).authToken});
 await wait('welcome',()=>c.messages.find(m=>m.type==='welcome'));
 c.send({type:'lobby-update',requestId:'test-ready',ready:true});
 return c;
}
async function room(mode,code){
 const group=[];for(let i=0;i<8;i++)group.push(await client(i,mode,code));
 for(const c of group){const ready=await wait('eight ready',()=>c.messages.find(m=>m.type==='peer-ready'));assert.equal(ready.peers.length,7);assert.equal(ready.mode,mode);c.state();}
 await wait('all states',()=>group.every(c=>c.messages.filter(m=>m.type==='game'&&m.message.type==='state').length===7));return group;
}
async function kill(attacker,victim,shotId){
 const damageId='damage:'+victim.life+':'+shotId;
 attacker.send({type:'game',targetId:victim.id,message:{version:1,type:'hit',life:attacker.life,seq:++attacker.seq,id:shotId,
  victimLife:victim.life,weapon:9,kind:'bullet',region:1,direction:[1,0,0]}});
 await wait('targeted hit',()=>victim.messages.some(m=>m.type==='game'&&m.senderId===attacker.id&&m.message.id===shotId));
 victim.send({type:'damage-proof',proof:{id:damageId,shotId,victimLife:victim.life,attackerId:attacker.id,attackerLife:attacker.life,weapon:9,before:100,after:0}});
 victim.send({type:'game',message:{version:1,type:'death',life:victim.life,seq:++victim.seq,killer:'remote',weapon:9,hpAfter:0,damageId}});
 return await wait('death confirmed',()=>victim.messages.find(m=>m.type==='death-confirmed'&&m.receipt.victimId===victim.id&&m.receipt.victimLife===victim.life));
}
try{
 const dm=await room('dm','880001');
 const receipt=await kill(dm[7],dm[3],'shot:1');assert(receipt.receipt.verified);assert.equal(receipt.receipt.killerId,dm[7].id);
 for(const c of dm.filter(c=>c!==dm[3]))assert(!c.messages.some(m=>m.type==='game'&&m.message.type==='hit'),'hit only delivered to named victim');
 dm[2].socket.end();await wait('one peer left',()=>dm[0].messages.some(m=>m.type==='peer-left'&&m.playerId===dm[2].id));
 assert(!dm[0].messages.some(m=>m.type==='match-ended'),'seven remaining players continue');
 dm[3].life++;dm[3].state();await delay(60);
 assert(!dm[0].messages.some(m=>m.type==='game'&&m.senderId===dm[3].id&&m.message.life===2),'early respawn cannot relay');
 await delay(150);dm[3].state();await delay(30);
 await kill(dm[7],dm[3],'shot:2');
 const result=await wait('DM winner',()=>dm[0].messages.find(m=>m.type==='match-ended'));
 assert.deepEqual(result.result.winnerIds,[dm[7].id]);assert.equal(result.result.scores[dm[7].id],2);
 assert.equal(result.result.mode,'dm');
 assert.equal(result.result.killLimit,2);assert.equal(result.result.timeLimitSeconds,60);
 assert.equal(result.result.deaths[dm[3].id],2);assert.equal(result.result.points[dm[7].id],50);assert.equal(result.result.points[dm[3].id],10);
 assert.equal(result.result.names[dm[7].id],'Player 7');assert.equal(result.result.players.length,8,'departed participants remain in final results');
 assert.deepEqual(dm[0].messages.filter(m=>m.type==='match-snapshot').at(-1).players.find(p=>p.playerId===dm[7].id),{playerId:dm[7].id,kills:2,deaths:0,points:50});
 const tdm=await room('tdm','880002');
 for(let i=0;i<8;i++){const ready=tdm[i].messages.find(m=>m.type==='peer-ready');assert.equal(ready.team,i%2);}
 tdm[0].send({type:'game',targetId:tdm[2].id,message:{version:1,type:'hit',life:1,seq:++tdm[0].seq,id:'friendly',victimLife:1,weapon:9,kind:'bullet',region:1,direction:[1,0,0]}});
 tdm[2].send({type:'damage-proof',proof:{id:'friendly-proof',shotId:'friendly',victimLife:1,attackerId:tdm[0].id,attackerLife:1,weapon:9,before:100,after:0}});
 await wait('friendly proof rejected',()=>tdm[2].messages.some(m=>m.type==='proof-rejected'&&m.reason==='friendly-fire-disabled'));
 assert(!tdm[2].messages.some(m=>m.type==='game'&&m.message.id==='friendly'));
 for(let round=1;round<=2;round++){
  for(let n=0;n<4;n++){
   await kill(tdm[n*2],tdm[n*2+1],`enemy:${round}:${n}`);
   if(n<3)assert(!tdm[0].messages.some(m=>m.type==='round-ended'&&m.round===round),'one death must not end the round');
  }
  await wait('team elimination round end',()=>tdm[0].messages.some(m=>m.type==='round-ended'&&m.round===round));
  if(round===1){
   const dead=tdm[1];dead.life=2;dead.state();await delay(40);
   assert(!tdm[0].messages.some(m=>m.type==='game'&&m.senderId===dead.id&&m.message.life===2),'team player cannot respawn during round break');
   const next=await wait('next team round',()=>tdm[0].messages.find(m=>m.type==='round-start'&&m.round===2));
   for(const c of tdm){c.life=next.lives[c.id];c.state();}await delay(60);
  }
 }
 const teamResult=await wait('team victory',()=>tdm[0].messages.find(m=>m.type==='match-ended'));
 assert.deepEqual(new Set(teamResult.result.winnerIds),new Set(tdm.filter((_,i)=>i%2===0).map(c=>c.id)));
 assert.deepEqual(teamResult.result.teamScores,[8,0]);assert.deepEqual(teamResult.result.roundWins,[2,0]);assert.equal(teamResult.result.mode,'tdm');
 assert.equal(teamResult.result.roundWinLimit,2);assert.equal(teamResult.result.killLimit,null);
 console.log('PASS: 8-player DM targeted hit/slot7 kill, survivor continuation, enforced respawn delay, individual winner; 4:4 friendly fire rejection, no mid-round respawn, team elimination, next-round lives and four match winners.');
}finally{
 for(const c of clients)c.socket.destroy();await server.close();
 for(const name of ['profiles.json','auth.json']){const file=path.join(temp,name);if(fs.existsSync(file))fs.unlinkSync(file);}fs.rmdirSync(temp);
}
