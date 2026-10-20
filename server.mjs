import net from 'node:net';
import http from 'node:http';
import https from 'node:https';
import tls from 'node:tls';
import fs from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';
import {fileURLToPath} from 'node:url';
import {validateLanMessage} from './lan-validation.mjs';
import {AuthService,authError} from './auth.mjs';
import {
  CombatLedger,DropLedger,validateLoadout,rankForXp,loadoutBudget,
  newProgressProfile,applyDeathToProfile,atomicWriteJson,
} from './progression.mjs';

const directory=path.dirname(fileURLToPath(import.meta.url));
const readJson=file=>JSON.parse(fs.readFileSync(file,'utf8').replace(/^\uFEFF/,''));
const clone=value=>structuredClone(value);
const eventId=value=>Number.isSafeInteger(value)&&value>=0?String(value):identifier(value,'event ID');
function reject(code,message){throw Object.assign(new Error(message),{code});}
function identifier(value,name){
  if(typeof value!=='string'||!/^[a-zA-Z0-9_.:-]{1,96}$/.test(value)||['__proto__','constructor','prototype'].includes(value))reject('BAD_MESSAGE','Invalid '+name);
  return value;
}
function integer(value,name,min,max){
  if(!Number.isSafeInteger(value)||value<min||value>max)reject('BAD_MESSAGE','Invalid '+name);
  return value;
}
function plainObject(value){
  return value&&typeof value==='object'&&!Array.isArray(value)&&
    [Object.prototype,null].includes(Object.getPrototypeOf(value));
}
function displayName(value){
  if(typeof value!=='string'||value.length<1||value.length>32||/[\u0000-\u001f\u007f]/.test(value))reject('BAD_NAME','A name of 1 to 32 characters is required');
  return value;
}
function ammoValue(value){
  return {magazine:integer(value.magazine,'magazine',0,65535),reserve:integer(value.reserve,'reserve',0,65535)};
}
class ProfileDatabase{
  constructor(filename){
    this.filename=filename;
    this.data=fs.existsSync(filename)?readJson(filename):{version:1,profiles:{},matches:{},activity:[]};
    if(this.data.version!==1||!plainObject(this.data.profiles))throw Error('Invalid profiles database; preserving file');
    for(const entry of Object.values(this.data.profiles)){
      // The pure reducer's profile checks also reject invalid XP/counters.
      integer(entry.xp,'stored XP',0,Number.MAX_SAFE_INTEGER);
      integer(entry.kills,'stored kills',0,Number.MAX_SAFE_INTEGER);
      integer(entry.deaths,'stored deaths',0,Number.MAX_SAFE_INTEGER);
      identifier(entry.playerId,'stored player ID');
      if(!plainObject(entry.seenLives))throw Error('Invalid stored profile history');
    }
    this.data.matches??={};this.data.activity??=[];
  }
  ensure(account){
    const playerId=identifier(account.playerId,'player ID'),existing=this.data.profiles[playerId];
    const profile=existing?{...clone(existing),name:account.name}:
      {...newProgressProfile(playerId),name:account.name,wins:0,losses:0,draws:0,matches:0,loadouts:{}};
    if(!existing||existing.name!==account.name)this.save(profile);
    return profile;
  }
  save(profile){this.data.profiles[profile.playerId]=clone(profile);this.flush();}
  flush(){atomicWriteJson(this.filename,this.data);}
  activity(event,details={}){
    this.data.activity.push({time:new Date().toISOString(),event,...details});
    if(this.data.activity.length>500)this.data.activity.splice(0,this.data.activity.length-500);
  }
  award(receipt){
    const updated=[];
    for(const playerId of new Set([receipt.victimId,receipt.killerId])){
      const previous=this.data.profiles[playerId];
      if(!previous)continue;
      const result=applyDeathToProfile(previous,receipt);
      if(result.changed){this.data.profiles[playerId]=result.profile;updated.push(result.profile);}
    }
    if(updated.length)this.flush();
    return updated;
  }
  finishMatch(room,reason,winnerIds){
    if(this.data.matches[room.id])return this.data.matches[room.id];
    const players=room.clients.map(client=>client.playerId),draw=winnerIds.length===0;
    const result={id:room.id,reason,startedAt:room.startedAt,endedAt:Date.now(),players,
      winnerIds,scores:Object.fromEntries(room.kills),draw};
    for(const playerId of players){
      const profile=this.data.profiles[playerId];
      const counter=draw?'draws':winnerIds.includes(playerId)?'wins':'losses';
      profile[counter]=(profile[counter]||0)+1;profile.matches=(profile.matches||0)+1;
    }
    this.data.matches[room.id]=result;
    this.activity('match-ended',{matchId:room.id,playerIds:players,reason,winnerIds,draw});
    this.flush();return result;
  }
}

export async function startKarmaServer({
  host='0.0.0.0',port=29020,healthHost=host,healthPort=29021,
  dataDir=path.join(directory,'data'),catalogFile=path.join(directory,'loadouts.json'),
  characterFile=path.join(directory,'characters.json'),maxRooms=20,maxPlayers=8,
  authService,tlsCert=process.env.TLS_CERT,tlsKey=process.env.TLS_KEY,matchKills=10,matchSeconds=600,
  logger=(event,details)=>console.log(JSON.stringify({time:new Date().toISOString(),event,...details})),
}={}){
  integer(maxRooms,'room limit',1,20);integer(maxPlayers,'player limit',2,8);
  const catalog=readJson(catalogFile),characters=readJson(characterFile);
  const weaponById=new Map(catalog.weapons.map(item=>[item.weaponId??item.id,item]));
  const db=new ProfileDatabase(path.join(path.resolve(dataDir),'profiles.json'));
  const auth=authService||new AuthService({filename:path.join(path.resolve(dataDir),'auth.json')});
  if(!!tlsCert!==!!tlsKey)throw Error('TLS_CERT and TLS_KEY must be configured together');
  const tlsOptions=tlsCert?{cert:fs.readFileSync(tlsCert),key:fs.readFileSync(tlsKey),minVersion:'TLSv1.2'}:null;
  integer(matchKills,'match kill limit',1,1000);integer(matchSeconds,'match time limit',1,86400);
  const rooms=new Map(),online=new Map(),sockets=new Set();
  let closing=false,acceptedMessages=0,relayedMessages=0;
  const log=(event,details={})=>{try{logger(event,details);}catch{}};
  function publicProfile(profile,character,account){
    return {version:1,playerId:profile.playerId,name:profile.name,xp:profile.xp,
      kills:profile.kills,deaths:profile.deaths,rank:rankForXp(profile.xp,catalog.ranks),
      wins:profile.wins||0,losses:profile.losses||0,draws:profile.draws||0,matches:profile.matches||0,
      ...(account?{role:account.role,isAdmin:account.role==='admin',emailVerified:!!account.emailVerified}:{}),
      ...(character?{inventoryCapacity:loadoutBudget({xp:profile.xp,character,ranks:catalog.ranks})}:{}),
      loadouts:clone(profile.loadouts||{})};
  }
  function write(session,message){
    if(session.closed||session.socket.destroyed||session.socket.writableEnded)return false;
    if(session.socket.writableLength>256*1024){session.socket.destroy();return false;}
    session.socket.write(JSON.stringify(message)+'\n');return true;
  }
  function broadcast(room,message,except=null){
    for(const client of room.clients)if(client!==except&&write(client,message))relayedMessages++;
  }
  function roomInfo(room){return {roomId:room.id,code:room.code,maxPlayers:room.maxPlayers};}
  function error(session,code,message){
    write(session,{type:'error',version:2,code,message});
    session.socket.end();const timer=setTimeout(()=>session.socket.destroy(),250);timer.unref();
  }
  function normalizedConfig(value,profile){
    if(!plainObject(value)||Buffer.byteLength(JSON.stringify(value))>16384)reject('BAD_CONFIG','Invalid config');
    if((value.age??0)!==0||(value.map??0)!==0)reject('BAD_CONFIG','This native release supports the past-era LAN map only');
    const offered=value.character;
    if(!plainObject(offered))reject('BAD_CONFIG','Character is required');
    const original=characters.find(item=>item.age===0&&item.characterIndex===offered.index&&item.camp===offered.camp);
    const character=original&&catalog.characters[original.id];
    if(!character)reject('BAD_CONFIG','Unsupported character');
    const equipment=validateLoadout({
      inventory:value.inventory??catalog.defaultInventory,
      selectedWeapon:value.selectedWeapon??catalog.defaultSelectedWeapon,
      xp:profile.xp,character,weapons:catalog.weapons,ranks:catalog.ranks,
      slotRules:catalog.slots,constraints:catalog.constraints,
    });
    const build=value.settings?.build??'karma290-lan1';
    if(typeof build!=='string'||!/^[A-Za-z0-9_.-]{1,96}$/.test(build))reject('BAD_CONFIG','Invalid build');
    const config={map:0,age:0,character:{index:original.characterIndex,camp:original.camp,
      model:path.basename(original.model.replaceAll('\\','/')).toLowerCase(),name:profile.name},
      inventory:equipment.inventory,selectedWeapon:equipment.selectedWeapon,
      settings:{build,mode:1}};
    return {config,character,characterId:original.id};
  }
  function startRoom(room){
    if(room.started||room.clients.length!==room.maxPlayers)return;
    room.started=true;room.startedAt=Date.now();room.kills=new Map(room.clients.map(client=>[client.playerId,0]));
    const playerIds=room.clients.map(client=>client.playerId);
    room.combat=new CombatLedger({matchId:room.id,playerIds});
    room.drops=new DropLedger({matchId:room.id,playerIds,maxDistance:350});
    room.dropOrder=[];room.evidence=new Map();
    for(const client of room.clients){
      const peers=room.clients.filter(other=>other!==client).map(other=>({
        role:other.slot===0?'host':'join',slot:other.slot,playerId:other.playerId,config:clone(other.config),
      }));
      write(client,{type:'peer-ready',version:2,role:client.slot===0?'host':'join',slot:client.slot,
        ...roomInfo(room),config:clone(client.config),remoteHello:peers[0],peers,
        profile:publicProfile(db.data.profiles[client.playerId],client.character,client.account)});
    }
    room.matchTimer=setTimeout(()=>finishRoom(room,'time-limit'),matchSeconds*1000);room.matchTimer.unref();
    log('room-started',{roomCount:rooms.size,players:room.clients.length,capacity:room.maxPlayers});
  }
  function hello(session,message){
    if(message.type!=='hello'||message.version!==2||!['create','join','profile'].includes(message.op))reject('BAD_HELLO','Protocol 2 hello is required');
    const account=auth.authenticate(message.authToken),profile=db.ensure(account);
    const identity={profile};
    session.account=account;session.authToken=message.authToken;
    if(message.op==='profile'){
      db.save(identity.profile);
      clearTimeout(session.handshakeTimer);
      write(session,{type:'welcome',version:2,
        profile:publicProfile(identity.profile,undefined,account),room:null});
      session.socket.end();return;
    }
    const capability=integer(message.clientMaxPlayers??2,'client capability',2,maxPlayers);
    if(online.has(identity.profile.playerId))reject('ALREADY_CONNECTED','This player is already connected');
    const offered=normalizedConfig(message.config,identity.profile);
    let room;
    if(message.op==='create'){
      if(rooms.size>=maxRooms)reject('ROOM_LIMIT','The server has reached its room limit');
      const capacity=integer(message.maxPlayers??2,'room capacity',2,maxPlayers);
      if(capacity>capability)reject('CLIENT_LIMIT','This client cannot enter a room of that size');
      let code=message.code;
      if(code!==undefined&&(!/^\d{6}$/.test(code)||rooms.has(code)))reject('BAD_CODE','Room code is invalid or in use');
      if(code===undefined){do{code=String(crypto.randomInt(100000,1000000));}while(rooms.has(code));}
      room={id:crypto.randomUUID(),code,maxPlayers:capacity,clients:[],started:false,ending:false};
      rooms.set(code,room);
    }else{
      if(typeof message.code!=='string'||!/^\d{6}$/.test(message.code))reject('BAD_CODE','A six-digit room code is required');
      room=rooms.get(message.code);
      if(!room)reject('ROOM_NOT_FOUND','Room not found');
      if(room.started||room.clients.length>=room.maxPlayers)reject('ROOM_FULL','Room is full');
      if(room.maxPlayers>capability)reject('CLIENT_LIMIT','This native client supports only two players');
      if(room.clients[0].config.settings.build!==offered.config.settings.build)reject('BUILD_MISMATCH','Both clients must use the same build');
    }
    session.playerId=identity.profile.playerId;session.character=offered.character;
    session.config=offered.config;session.room=room;session.slot=room.clients.length;
    session.inventory=[...offered.config.inventory];
    session.state={life:1,hp:100,pos:[0,0,0],inventory:[...session.inventory],
      selectedWeapon:offered.config.selectedWeapon,ammo:{},seq:-1};
    session.hasState=false;
    identity.profile.loadouts={...identity.profile.loadouts,[offered.characterId]:{
      inventory:[...offered.config.inventory],selectedWeapon:offered.config.selectedWeapon}};
    try{db.save(identity.profile);}
    catch(error){if(room.clients.length===0)rooms.delete(room.code);throw error;}
    clearTimeout(session.handshakeTimer);room.clients.push(session);online.set(session.playerId,session);
    write(session,{type:'welcome',version:2,
      profile:publicProfile(identity.profile,session.character,account),room:roomInfo(room),
      role:session.slot===0?'host':'join',slot:session.slot});
    if(room.clients.length<room.maxPlayers)broadcast(room,{type:'waiting',version:2,...roomInfo(room),players:room.clients.length});
    startRoom(room);
  }
  function damageProof(session,value){
    if(!plainObject(value))reject('BAD_PROOF','Damage proof is required');
    const proof={...value,id:eventId(value.id),victimId:session.playerId};
    if(session.hasState&&proof.victimLife!==session.state.life)return;
    const evidence=session.room.evidence.get(JSON.stringify([proof.attackerId,proof.attackerLife,proof.id]));
    if(!evidence||evidence.weapon!==proof.weapon||
       (evidence.victimId!==null&&(evidence.victimId!==session.playerId||evidence.victimLife!==proof.victimLife))){
      write(session,{type:'proof-rejected',version:2,id:proof.id,reason:'no-matching-shot-or-hit'});return;
    }
    session.room.combat.recordDamage(session.playerId,proof);
  }
  function updateState(session,message){
    const old=session.state;
    if(message.life<old.life||(message.life===old.life&&message.seq<=old.seq))return false;
    if(message.inventory!==undefined&&JSON.stringify(message.inventory)!==JSON.stringify(session.inventory))
      reject('BAD_INVENTORY','Inventory changes require a server pickup grant');
    const selectedWeapon=message.selectedWeapon??message.weapon;
    if(!session.inventory.includes(selectedWeapon))reject('BAD_INVENTORY','Selected weapon is not owned');
    const ammunition={...old.ammo};
    if(message.ammo!==undefined){
      if(!plainObject(message.ammo))reject('BAD_INVENTORY','Invalid ammunition');
      for(const [weapon,value] of Object.entries(message.ammo)){
        if(!session.inventory.includes(Number(weapon)))reject('BAD_INVENTORY','Ammo for an unowned weapon');
        ammunition[weapon]=ammoValue(value);
      }
    }
    session.state={life:message.life,hp:message.hp,pos:[...message.pos],seq:message.seq,
      inventory:[...session.inventory],selectedWeapon,ammo:ammunition};
    session.hasState=true;
    return true;
  }
  function death(session,message){
    const room=session.room;
    // Older native messages still relay, but cannot create XP or loot without
    // a victim-native death snapshot. New adapters always supply hpAfter.
    if(!Number.isInteger(message.hpAfter)||message.hpAfter>0)return;
    if(session.hasState&&message.life!==session.state.life)return;
    const result=room.combat.confirmDeath(session.playerId,{
      life:message.life,killer:message.killer,weapon:message.weapon??-1,
      damageId:message.damageId==null?null:eventId(message.damageId),hpAfter:message.hpAfter,
    });
    if(!result.accepted)return;
    session.state.hp=0;
    broadcast(room,{type:'death-confirmed',version:2,receipt:result.receipt});
    const changed=db.award(result.receipt);
    for(const profile of changed){
      const client=online.get(profile.playerId);
      if(client)write(client,{type:'profile',version:2,profile:publicProfile(profile,client.character,client.account)});
    }
    if(result.receipt.verified){
      const killer=result.receipt.killerId;
      room.kills.set(killer,(room.kills.get(killer)||0)+1);
      if(room.kills.get(killer)>=matchKills)queueMicrotask(()=>finishRoom(room,'kill-limit',[killer]));
    }
    const dropped=message.drop;
    if(!plainObject(dropped)||!session.inventory.includes(dropped.selectedWeapon)||
       weaponById.get(dropped.selectedWeapon)?.isWeapon!==true)return;
    const created=room.drops.createDeathDrop(result.receipt,dropped);
    if(created.created){
      room.dropOrder.push(created.drop.id);
      // The original world has 40 ground-item slots.
      while(room.dropOrder.length>40){
        const expired=room.dropOrder.shift();
        room.drops.drops.delete(expired);
        broadcast(room,{type:'drop-removed',version:2,dropId:expired,reason:'ground-limit'});
      }
      broadcast(room,{type:'drop',version:2,drop:created.drop});
    }
  }
  function claim(session,message){
    if(!session.hasState){write(session,{type:'pickup-denied',requestId:message.requestId,dropId:message.dropId,reason:'no-player-state'});return;}
    const profile=db.data.profiles[session.playerId];
    const result=session.room.drops.claimDrop(session.playerId,message,{
      state:session.state,character:session.character,xp:profile.xp,
      weapons:catalog.weapons,ranks:catalog.ranks,
    });
    if(!result.granted){write(session,{type:'pickup-denied',version:2,requestId:message.requestId,dropId:message.dropId,reason:result.reason});return;}
    const grant=result.grant;
    session.inventory[grant.replaceSlot]=grant.weapon;
    session.state.inventory=[...session.inventory];
    session.state.ammo[grant.weapon]={magazine:grant.magazine,reserve:grant.reserve};
    session.state.selectedWeapon=grant.weapon;
    if(result.duplicate)write(session,{type:'pickup-grant',version:2,grant,replay:true});
    else broadcast(session.room,{type:'pickup-grant',version:2,grant});
  }
  function receive(session,message){
    acceptedMessages++;
    if(!plainObject(message))reject('BAD_MESSAGE','Expected an object');
    if(!session.playerId){hello(session,message);return;}
    if(message.type==='ping'){write(session,{type:'pong',version:2});return;}
    if(message.type==='leave'){session.socket.end();return;}
    if(!session.room.started)reject('NOT_READY','Waiting for the other players');
    if(message.type==='damage-proof'){damageProof(session,message.proof);return;}
    if(message.type==='pickup-claim'){claim(session,message);return;}
    if(message.type!=='game')reject('BAD_MESSAGE','Unsupported message type');
    const game=validateLanMessage(message.message);
    if(game.type==='state'||game.type==='respawn'){
      if(game.type==='respawn'&&game.life>session.state.life){
        session.inventory=[...session.config.inventory];
        session.state.ammo={};
      }
      if(!updateState(session,game))return;
    }
    let target=null;
    if(message.targetId!==undefined){
      target=online.get(identifier(message.targetId,'target ID'));
      if(!target||target===session||target.room!==session.room)reject('BAD_TARGET','Target is not in this room');
    }
    const room=session.room;
    const evidence=game.type==='hit'?{
      id:game.id,life:game.life,weapon:game.weapon,victimLife:game.victimLife,
      victimId:target?.playerId??(room.clients.length===2?room.clients.find(client=>client!==session).playerId:null),
    }:game.shot?{...game.shot,victimId:null}:null;
    if(evidence){
      if(!session.inventory.includes(evidence.weapon))reject('BAD_INVENTORY','Fired weapon is not owned');
      room.evidence.set(JSON.stringify([session.playerId,evidence.life,eventId(evidence.id)]),evidence);
      while(room.evidence.size>2048)room.evidence.delete(room.evidence.keys().next().value);
    }
    if(game.type==='death')death(session,game);
    const envelope={type:'game',version:2,senderId:session.playerId,slot:session.slot,message:game};
    if(target){if(write(target,envelope))relayedMessages++;}
    else broadcast(session.room,envelope,session);
    if(game.type==='leave')session.socket.end();
  }
  function finishRoom(room,reason,winnerIds){
    if(!room.started||room.ending)return;
    room.ending=true;clearTimeout(room.matchTimer);rooms.delete(room.code);
    if(winnerIds===undefined){
      const best=Math.max(...room.kills.values()),leaders=[...room.kills].filter(([,score])=>score===best).map(([player])=>player);
      winnerIds=leaders.length===1?leaders:[];
    }
    const result=db.finishMatch(room,reason,winnerIds);
    for(const client of room.clients){
      const profile=db.data.profiles[client.playerId];
      write(client,{type:'profile',version:2,profile:publicProfile(profile,client.character,client.account)});
      write(client,{type:'match-ended',version:2,result});
      client.socket.end();const timer=setTimeout(()=>client.socket.destroy(),500);timer.unref();
    }
    log('match-ended',{reason,players:room.clients.length,draw:result.draw});
  }
  function disconnected(session){
    if(session.closed)return;session.closed=true;clearTimeout(session.handshakeTimer);
    sockets.delete(session.socket);
    if(session.playerId&&online.get(session.playerId)===session)online.delete(session.playerId);
    const room=session.room;
    if(!room||room.ending)return;
    if(!room.started){
      room.clients=room.clients.filter(client=>client!==session);
      if(room.clients.length===0)rooms.delete(room.code);
      else{
        room.clients.forEach((client,slot)=>{client.slot=slot;});
        broadcast(room,{type:'waiting',version:2,...roomInfo(room),players:room.clients.length});
      }
      return;
    }
    if(closing){room.ending=true;clearTimeout(room.matchTimer);rooms.delete(room.code);return;}
    finishRoom(room,'forfeit',room.clients.filter(client=>client!==session).map(client=>client.playerId));
    log('room-ended',{roomCount:rooms.size,players:online.size});
  }
  function authResult(result){
    if(!result.account)return result;
    const {account,...rest}=result,profile=db.ensure(account);
    return {...rest,profile:publicProfile(profile,undefined,account)};
  }
  const reply=(response,status,value)=>{
    response.writeHead(status,{'Content-Type':'application/json; charset=utf-8','Cache-Control':'no-store','X-Content-Type-Options':'nosniff'});
    response.end(JSON.stringify(value));
  };
  async function body(request){
    let size=0,chunks=[];
    for await(const chunk of request){
      size+=chunk.length;if(size>16384)authError(413,'TOO_LARGE','요청이 너무 큽니다.');
      chunks.push(chunk);
    }
    let value;
    try{value=JSON.parse(Buffer.concat(chunks).toString('utf8'));}
    catch{authError(400,'BAD_JSON','올바른 JSON 요청이 필요합니다.');}
    if(!plainObject(value))authError(400,'BAD_JSON','JSON 객체가 필요합니다.');
    return value;
  }
  function bearer(request){
    const header=request.headers.authorization;
    if(typeof header!=='string'||!header.startsWith('Bearer '))authError(401,'AUTH_REQUIRED','먼저 로그인해 주세요.');
    return header.slice(7);
  }
  function accountProfile(account){
    return publicProfile(db.ensure(account),undefined,account);
  }
  async function httpRequest(request,response){
    try{
      const url=new URL(request.url,'http://localhost'),route=url.pathname;
      if(request.method==='GET'&&route==='/health'){
        reply(response,200,{ok:true,protocol:2,rooms:rooms.size,players:online.size,maxRooms,maxPlayersPerRoom:maxPlayers,
          nativeClientMaxPlayers:2,acceptedMessages,relayedMessages,uptimeSeconds:Math.floor(process.uptime())});return;
      }
      if(request.method==='GET'&&route==='/api/auth-config'){
        reply(response,200,{emailVerificationRequired:auth.verificationRequired,
          registrationAvailable:!auth.verificationRequired||auth.mailer.configured});return;
      }
      if(request.method==='POST'&&route.startsWith('/auth/')){
        const ip=request.socket.remoteAddress||'unknown';
        if(route==='/auth/register/request'){reply(response,200,authResult(await auth.registerRequest(await body(request),ip)));return;}
        if(route==='/auth/register/verify'){reply(response,200,authResult(await auth.registerVerify(await body(request),ip)));return;}
        if(route==='/auth/login'){reply(response,200,authResult(await auth.login(await body(request),ip)));return;}
        if(route==='/auth/logout'){
          const token=bearer(request),account=auth.logout(token),client=online.get(account.playerId);
          if(client?.authToken===token)client.socket.destroy();
          reply(response,200,{ok:true});return;
        }
      }
      if(route.startsWith('/api/')){
        const account=auth.authenticate(bearer(request));
        if(request.method==='GET'&&route==='/api/me'){
          reply(response,200,{profile:accountProfile(account),activity:db.data.activity.filter(item=>
            item.playerIds?.includes(account.playerId)||item.targetId===account.playerId).slice(-30).reverse(),
            catalog:{characters:catalog.characters,weapons:catalog.weapons,ranks:catalog.ranks,slots:catalog.slots}});return;
        }
        if(request.method==='GET'&&route==='/api/leaderboard'){
          const disabled=new Set(auth.list().filter(item=>item.disabled).map(item=>item.playerId));
          const players=Object.values(db.data.profiles).filter(item=>!disabled.has(item.playerId))
            .sort((a,b)=>b.xp-a.xp||b.kills-a.kills||a.playerId.localeCompare(b.playerId))
            .slice(0,200).map(item=>{
              const {loadouts,...entry}=publicProfile(item);return entry;
            });
          reply(response,200,{players});return;
        }
        if(request.method==='GET'&&route==='/api/dashboard'){
          const roomList=[...rooms.values()].map(room=>({...roomInfo(room),started:room.started,
            elapsedSeconds:room.started?Math.floor((Date.now()-room.startedAt)/1000):0,
            players:room.clients.map(client=>({playerId:client.playerId,name:client.account.name}))}));
          reply(response,200,{summary:{registeredUsers:auth.list().length,onlinePlayers:online.size,rooms:rooms.size,totalMatches:Object.keys(db.data.matches).length},
            rooms:roomList,activity:db.data.activity.slice(-50).reverse()});return;
        }
        if(route.startsWith('/api/admin/')){
          if(account.role!=='admin')authError(403,'ADMIN_REQUIRED','관리자 권한이 필요합니다.');
          if(request.method==='GET'&&route==='/api/admin/users'){
            reply(response,200,{users:auth.list().map(item=>({...accountProfile(item),email:item.email,disabled:item.disabled}))});return;
          }
          const match=route.match(/^\/api\/admin\/users\/([a-zA-Z0-9_.:-]{1,96})$/);
          if(request.method==='PATCH'&&match){
            const playerId=match[1],target=auth.list().find(item=>item.playerId===playerId);
            if(!target)authError(404,'USER_NOT_FOUND','사용자를 찾을 수 없습니다.');
            const update=await body(request),allowed=['disabled','xp','kills','deaths','wins','losses','draws','matches','loadouts'];
            if(!Object.keys(update).length||Object.keys(update).some(key=>!allowed.includes(key)))authError(400,'BAD_UPDATE','수정할 수 없는 필드입니다.');
            if(online.has(playerId)&&Object.keys(update).some(key=>key!=='disabled'))authError(409,'PLAYER_ACTIVE','대전 종료 후 전적이나 장비를 수정해 주세요.');
            const profile=db.ensure(target);
            for(const key of ['xp','kills','deaths','wins','losses','draws','matches']){
              if(update[key]!==undefined)profile[key]=integer(update[key],key,0,Number.MAX_SAFE_INTEGER);
            }
            const sum=(profile.wins||0)+(profile.losses||0)+(profile.draws||0);
            if(update.matches!==undefined&&update.matches!==sum)authError(400,'BAD_COUNTERS','경기 수는 승·패·무 합계와 같아야 합니다.');
            profile.matches=sum;
            if(update.loadouts!==undefined){
              if(!plainObject(update.loadouts))authError(400,'BAD_LOADOUT','장비 설정이 올바르지 않습니다.');
              const loadouts={};
              for(const [characterId,selection] of Object.entries(update.loadouts)){
                const character=catalog.characters[characterId];
                if(!character||!plainObject(selection))authError(400,'BAD_LOADOUT','캐릭터 장비 설정을 확인해 주세요.');
                const valid=validateLoadout({...selection,xp:profile.xp,character,weapons:catalog.weapons,ranks:catalog.ranks,
                  slotRules:catalog.slots,constraints:catalog.constraints});
                loadouts[characterId]={inventory:valid.inventory,selectedWeapon:valid.selectedWeapon};
              }
              profile.loadouts=loadouts;
            }
            if(update.disabled!==undefined){
              if(typeof update.disabled!=='boolean')authError(400,'BAD_UPDATE','disabled는 참 또는 거짓이어야 합니다.');
              if(target.playerId===account.playerId&&update.disabled)authError(400,'SELF_DISABLE','현재 관리자 계정은 사용 중지할 수 없습니다.');
              auth.setDisabled(playerId,update.disabled);
              if(update.disabled)online.get(playerId)?.socket.destroy();
            }
            db.data.profiles[playerId]=profile;
            db.activity('admin-user-update',{actorId:account.playerId,targetId:playerId,fields:Object.keys(update)});db.flush();
            reply(response,200,{ok:true,profile:publicProfile(profile,undefined,target)});return;
          }
        }
        authError(404,'NOT_FOUND','요청한 API를 찾을 수 없습니다.');
      }
      if(request.method==='GET'){
        const files={'/':'index.html','/index.html':'index.html','/app.js':'app.js','/style.css':'style.css'};
        const filename=files[route]&&path.join(directory,'public',files[route]);
        if(filename&&fs.existsSync(filename)){
          const contentType=filename.endsWith('.js')?'text/javascript':filename.endsWith('.css')?'text/css':'text/html';
          response.writeHead(200,{'Content-Type':contentType+'; charset=utf-8','X-Content-Type-Options':'nosniff','Cache-Control':'no-store'});
          response.end(fs.readFileSync(filename));return;
        }
      }
      reply(response,404,{ok:false,error:{code:'NOT_FOUND',message:'Not found'}});
    }catch(problem){
      if(!response.headersSent)reply(response,problem.status||400,{ok:false,error:{code:problem.code||'BAD_REQUEST',message:problem.status||problem instanceof TypeError?problem.message:'요청을 처리하지 못했습니다.'}});
      else response.end();
    }
  }
  const connected=socket=>{
    if(closing){socket.end();return;}
    sockets.add(socket);socket.setNoDelay(true);socket.setKeepAlive(true,10000);
    const session={socket,closed:false,buffer:'',windowAt:Date.now(),messages:0};
    session.handshakeTimer=setTimeout(()=>error(session,'HELLO_TIMEOUT','Connection setup timed out'),5000);
    session.handshakeTimer.unref();socket.setEncoding('utf8');
    socket.on('error',()=>{});socket.on('close',()=>disconnected(session));
    socket.on('data',data=>{
      if(session.closed||socket.writableEnded)return;
      session.buffer+=data;
      if(Buffer.byteLength(session.buffer)>128*1024){error(session,'TOO_LARGE','Message buffer exceeded');return;}
      let index;
      while((index=session.buffer.indexOf('\n'))>=0){
        const line=session.buffer.slice(0,index);session.buffer=session.buffer.slice(index+1);
        if(Buffer.byteLength(line)>64*1024){error(session,'TOO_LARGE','Message exceeded 64 KiB');return;}
        if(!line.trim())continue;
        if(Date.now()-session.windowAt>=1000){session.windowAt=Date.now();session.messages=0;}
        if(++session.messages>500){error(session,'RATE_LIMIT','Too many messages');return;}
        try{receive(session,JSON.parse(line));}
        catch(problem){error(session,problem.code||'BAD_MESSAGE',problem.message);return;}
      }
    });
  };
  const server=tlsOptions?tls.createServer(tlsOptions,connected):net.createServer(connected);
  server.on('tlsClientError',()=>{});
  const health=tlsOptions?https.createServer(tlsOptions,httpRequest):http.createServer(httpRequest);
  health.headersTimeout=5000;health.requestTimeout=5000;
  const listen=(server,port,address)=>new Promise((resolve,reject)=>{
    const onError=error=>reject(error);server.once('error',onError);
    server.listen(port,address,()=>{server.off('error',onError);resolve();});
  });
  try{await listen(server,port,host);await listen(health,healthPort,healthHost);}
  catch(problem){server.close();health.close();throw problem;}
  log('server-started',{port:server.address().port,healthPort:health.address().port,maxRooms,maxPlayers,nativeClientMaxPlayers:2});
  const authTimer=setInterval(()=>{
    try{
      const data=auth.read();
      for(const client of online.values())try{auth.authenticate(client.authToken,data);}catch{client.socket.destroy();}
    }catch{for(const client of online.values())client.socket.destroy();}
  },5000);authTimer.unref();
  return {
    port:server.address().port,healthPort:health.address().port,auth,
    stats:()=>({rooms:rooms.size,players:online.size,acceptedMessages,relayedMessages}),
    async close(){
      if(closing)return;closing=true;clearInterval(authTimer);
      for(const socket of sockets)socket.destroy();
      await Promise.all([new Promise(resolve=>server.close(resolve)),new Promise(resolve=>health.close(resolve))]);
    },
  };
}

if(process.argv[1]&&path.resolve(process.argv[1])===fileURLToPath(import.meta.url)){
  const instance=await startKarmaServer({
    host:process.env.KARMA_HOST||'0.0.0.0',
    port:Number(process.env.KARMA_PORT||29020),
    healthHost:process.env.KARMA_HEALTH_HOST||process.env.KARMA_HOST||'0.0.0.0',
    healthPort:Number(process.env.KARMA_HEALTH_PORT||29021),
    dataDir:process.env.KARMA_DATA_DIR||path.join(directory,'data'),
  });
  let stopping=false;
  const stop=async()=>{if(stopping)return;stopping=true;await instance.close();};
  process.on('SIGINT',stop);process.on('SIGTERM',stop);
}
