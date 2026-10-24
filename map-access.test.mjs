import assert from 'node:assert/strict';import fs from 'node:fs';import os from 'node:os';import path from 'node:path';import crypto from 'node:crypto';import net from 'node:net';
import {startKarmaServer} from './server.mjs';import {MapAccess} from './map-access.mjs';
const temp=fs.mkdtempSync(path.join(os.tmpdir(),'karma-map-access-')),sockets=[];let server;
const maps=JSON.parse(fs.readFileSync(new URL('multiplayer-maps.json',import.meta.url))).maps;
const catalog=JSON.parse(fs.readFileSync(new URL('loadouts.json',import.meta.url)));
const config={map:18,age:0,character:{index:0,camp:0},inventory:catalog.defaultInventory,selectedWeapon:9,settings:{build:'karma290-central6'}};
const wait=async fn=>{for(let i=0;i<100;i++){const v=fn();if(v)return v;await new Promise(r=>setTimeout(r,20));}throw Error('timeout');};
async function connect(token,map=18,capacity=8,build='karma290-central6'){
 const socket=net.createConnection({host:'127.0.0.1',port:server.port});sockets.push(socket);socket.on('error',()=>{});let buffer='',result;
 socket.on('data',b=>{buffer+=b;const end=buffer.indexOf('\n');if(end>=0&&!result)result=JSON.parse(buffer.slice(0,end));});
 await new Promise(r=>socket.once('connect',r));socket.write(JSON.stringify({type:'hello',version:2,op:'create',authToken:token,config:{...config,map,settings:{build}},manualStart:true,clientMaxPlayers:8,maxPlayers:capacity,mode:'dm'})+'\n');
 const response=await wait(()=>result);socket.end();await wait(()=>socket.destroyed);return response;
}
try{
 assert.equal(maps.length,20);assert.equal(maps.find(m=>m.mapIndex===18).releaseOrder,1);assert.equal(maps.find(m=>m.mapIndex===19).maxPlayers,4);
 assert(maps.every(m=>m.dmSpawns.length>=(m.maxPlayers||8)&&m.teamSpawns.length===8));
 const original=new MapAccess(path.join(temp,'policy-test.json'),maps);assert(!original.isOpen(18));original.set(18,true,'admin');assert(new MapAccess(path.join(temp,'policy-test.json'),maps).isOpen(18));
 server=await startKarmaServer({host:'127.0.0.1',port:0,healthPort:0,dataDir:temp,logger:()=>{}});
 const admin=await server.auth.createAccount({email:'admin@maps.test',password:crypto.randomUUID(),name:'관리자',role:'admin'}),user=await server.auth.createAccount({email:'user@maps.test',password:crypto.randomUUID(),name:'학생'});
 const ta=server.auth.issueSession(admin).authToken,tu=server.auth.issueSession(user).authToken;
 const api=async(token,body)=>{const r=await fetch(`http://127.0.0.1:${server.healthPort}/api/admin/maps`,{method:'POST',headers:{Authorization:'Bearer '+token,'Content-Type':'application/json'},body:JSON.stringify(body)});return {status:r.status,data:await r.json()};};
 assert.equal((await connect(tu)).code,'BAD_CONFIG');assert.equal((await connect(ta)).type,'welcome','admin can preview closed map');
 assert.equal((await api(tu,{mapIndex:18,open:true})).status,403);assert.equal((await api(ta,{mapIndex:18,open:true})).status,200);
 assert.equal((await connect(tu)).type,'welcome','opening allows new clients');assert.equal((await connect(tu,18,8,'karma290-central5')).code,'CLIENT_UPDATE_REQUIRED');
 assert.equal((await api(ta,{mapIndex:19,open:true})).status,200);assert.equal((await connect(tu,19,8)).code,'MAP_CAPACITY');assert.equal((await connect(tu,19,4)).type,'welcome');
 assert.equal((await api(ta,{mapIndex:18,open:false})).status,200);assert.equal((await connect(tu)).code,'BAD_CONFIG');
 assert.equal((await api(ta,{mapIndex:500,open:true})).status,400);
 console.log('PASS map access: 20 spawn manifests, user release order, closed preview, administrator-only persistent open/close, old-client gate and Honor four-seat capacity');
}finally{for(const s of sockets)s.destroy();if(server)await server.close();fs.rmSync(temp,{recursive:true,force:true});}
