import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import crypto from 'node:crypto';
import net from 'node:net';
import {startKarmaServer} from './server.mjs';

const temp=fs.mkdtempSync(path.join(os.tmpdir(),'karma-map-policy-'));
const clients=[],servers=[];
const delay=ms=>new Promise(resolve=>setTimeout(resolve,ms));
const build='karma290-central4';
const catalog=JSON.parse(fs.readFileSync(new URL('loadouts.json',import.meta.url),'utf8').replace(/^\uFEFF/,''));
const base={age:0,character:{index:0,camp:0},inventory:catalog.characters.cpom_050.defaultInventory,
  selectedWeapon:catalog.characters.cpom_050.defaultSelectedWeapon,settings:{build}};
async function wait(label,predicate){
  for(let i=0;i<250;i++){const value=predicate();if(value)return value;await delay(20);}
  throw Error('Timeout: '+label);
}
async function fixture(name,factoryReleased){
  const dataDir=path.join(temp,name);fs.mkdirSync(dataDir);
  const mapFile=path.join(dataDir,'maps.json');
  // Deliberately independent of production release flags and native spawn coordinates.
  fs.writeFileSync(mapFile,JSON.stringify({schemaVersion:1,maps:[
    {id:'NMP_ryuba',name:'Mass of Winter',mapIndex:0,age:0,nativeMode:1,publicReady:true},
    {id:'NMP_rescue',name:'Rescue',mapIndex:4,age:0,nativeMode:1,publicReady:true},
    {id:'NMP_Factory',name:'Factory',mapIndex:7,age:0,nativeMode:1,publicReady:factoryReleased},
  ]}));
  const server=await startKarmaServer({host:'127.0.0.1',port:0,healthPort:0,dataDir,mapFile,logger:()=>{}});
  servers.push(server);return server;
}
async function peer(server,{op='create',code='920001',map=0,role='user',version=build,age=0,spoofAdmin=false}={}){
  const account=await server.auth.createAccount({email:crypto.randomUUID()+'@map-policy.invalid',
    password:crypto.randomUUID(),name:'Map player '+clients.length,role});
  const socket=net.createConnection({host:'127.0.0.1',port:server.port});
  const c={socket,messages:[],closed:false};clients.push(c);let buffer='';
  socket.setEncoding('utf8');socket.on('error',()=>{});socket.on('close',()=>{c.closed=true;});
  socket.on('data',chunk=>{buffer+=chunk;let end;
    while((end=buffer.indexOf('\n'))>=0){c.messages.push(JSON.parse(buffer.slice(0,end)));buffer=buffer.slice(end+1);}});
  c.send=message=>socket.write(JSON.stringify(message)+'\n');
  c.latest=type=>c.messages.filter(message=>message.type===type).at(-1);
  await new Promise((resolve,reject)=>{socket.once('connect',resolve);socket.once('error',reject);});
  c.send({type:'hello',version:2,op,code,mode:'dm',maxPlayers:8,clientMaxPlayers:8,manualStart:true,
    authToken:server.auth.issueSession(account).authToken,
    ...(spoofAdmin?{role:'admin',isAdmin:true}:{}),
    config:{...base,map,age,settings:{build:version},...(spoofAdmin?{isAdmin:true}: {})}});
  c.response=await wait('hello response',()=>c.latest('welcome')||c.latest('error'));
  return c;
}
async function denied(server,options,code){
  const c=await peer(server,options);
  assert.equal(c.response.type,'error',JSON.stringify(options));assert.equal(c.response.code,code);
  assert(!c.latest('welcome'));await wait('denied socket closed',()=>c.closed);
  return c;
}
async function accepted(server,options){
  const c=await peer(server,options);assert.equal(c.response.type,'welcome',JSON.stringify(c.response));
  assert.equal(c.response.profile.xp,0,'Map permission must not require a promoted character');
  return c;
}
async function start(host,guest,map,name){
  assert.equal(host.response.room.map,map);assert.equal(guest.response.room.map,map);
  assert.equal(host.response.room.mapName,name);assert.equal(guest.response.room.mapName,name);
  host.send({type:'start-match',roomId:host.response.room.roomId});
  for(const client of [host,guest]){
    const ready=await wait('map peer-ready',()=>client.latest('peer-ready'));
    assert.equal(ready.map,map);assert.equal(ready.mapName,name);assert.equal(ready.config.map,map);
    assert.equal(ready.config.age,0);assert.equal(ready.config.settings.build,build);
    assert.equal(ready.peers.length,1);assert.equal(ready.peers[0].config.map,map);
    assert.equal(ready.remoteHello.config.map,map);
  }
}
try{
  const server=await fixture('preview',false);
  await denied(server,{map:7},'BAD_CONFIG');
  await denied(server,{map:7,spoofAdmin:true},'BAD_CONFIG');
  for(const map of [4,7])await denied(server,{map,role:'admin',version:'karma290-central3'},'CLIENT_UPDATE_REQUIRED');
  for(const role of ['user','admin']){
    await denied(server,{map:99,role},'BAD_CONFIG');
    await denied(server,{map:0,age:1,role},'BAD_CONFIG');
  }
  await denied(server,{map:'4'},'BAD_CONFIG');
  await denied(server,{map:-1},'BAD_CONFIG');

  const previewHost=await accepted(server,{code:'920007',map:7,role:'admin'});
  await denied(server,{op:'join',code:'920007',map:7},'BAD_CONFIG');
  await denied(server,{op:'join',code:'920007',map:0},'MAP_NOT_RELEASED');
  await denied(server,{op:'join',code:'920007',map:0,spoofAdmin:true},'MAP_NOT_RELEASED');
  const previewGuest=await accepted(server,{op:'join',code:'920007',map:0,role:'admin'});
  await start(previewHost,previewGuest,7,'Factory');

  const publicHost=await accepted(server,{code:'920004',map:4});
  await denied(server,{op:'join',code:'920004',map:0,version:'karma290-central3'},'BUILD_MISMATCH');
  const publicGuest=await accepted(server,{op:'join',code:'920004',map:0});
  await start(publicHost,publicGuest,4,'Rescue');

  const legacy=await accepted(server,{code:'920003',map:0,version:'karma290-central3'});
  assert.equal(legacy.response.room.map,0,'Legacy build retains original map support');
  await denied(server,{op:'join',code:'920003',map:0},'BUILD_MISMATCH');

  const released=await fixture('released',true);
  const factoryHost=await accepted(released,{code:'920017',map:7});
  const factoryGuest=await accepted(released,{op:'join',code:'920017',map:4});
  await start(factoryHost,factoryGuest,7,'Factory');
  assert.equal(factoryHost.response.profile.isAdmin,false);
  assert.equal(factoryGuest.response.profile.isAdmin,false);
  console.log('PASS maps: explicit release fixtures; admin-only preview create/join; role-spoof rejection; unknown/era/type rejection; old-build guard; same-build rooms; host-authoritative Rescue/Factory map; public release access.');
}finally{
  for(const client of clients)client.socket.destroy();
  for(const server of servers)await server.close();
  const target=path.resolve(temp),parent=path.resolve(os.tmpdir());
  assert.equal(path.dirname(target),parent);assert(path.basename(target).startsWith('karma-map-policy-'));
  fs.rmSync(target,{recursive:true,force:true});
}
