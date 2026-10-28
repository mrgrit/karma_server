import {Conduct} from './conduct.mjs';
import {GAME_RULES,RULES_HASH,rulesAccepted} from './rules.mjs';
import net from 'node:net';
import {scenarioForWeapon,ATTACK_CURRICULUM} from './attack-scenarios.mjs';
import {FairPlay} from './fairplay.mjs';
import {LobbyPing} from './lobby-ping.mjs';
import {AdaptivePromotions} from './adaptive-promotion.mjs';
import {RANKS} from './rank-policy.mjs';
import {MapAccess} from './map-access.mjs';
import http from 'node:http';
import https from 'node:https';
import tls from 'node:tls';
import fs from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';
import {fileURLToPath} from 'node:url';
import {validateLanMessage} from './lan-validation.mjs';
import {AuthService,authError} from './auth.mjs';
import {createExchangeClient} from './exchange-client.mjs';
import {serveClientRelease} from './client-release.mjs';
import {createChatFilter,ChatArchive} from './chat-policy.mjs';
import {newMastery,validateMastery,TECHNIQUES,FAMILY_NAMES,techniqueForWeapon} from './mastery.mjs';
import {
  CombatLedger,DropLedger,validateLoadout,rankForXp,loadoutBudget,characterUnlocked,
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
function roomDisplayName(value,fallback){
  if(value===undefined)return fallback.slice(0,32);
  if(typeof value!=='string')reject('BAD_ROOM_NAME','방 이름을 입력해 주세요.');
  const name=value.replace(/[\u0000-\u001f\u007f]/g,' ').replace(/\s+/g,' ').trim().slice(0,32);
  if(!name)reject('BAD_ROOM_NAME','방 이름을 입력해 주세요.');
  return name;
}
function ammoValue(value){
  return {magazine:integer(value.magazine,'magazine',0,65535),reserve:integer(value.reserve,'reserve',0,65535)};
}
function teamScores(room){
  const scores=[0,0];
  for(const client of room.participants?.values()||room.clients)scores[client.team]+=(room.kills?.get(client.playerId)||0);
  return scores;
}
class ProfileDatabase{
  constructor(filename){
    this.filename=filename;
    this.data=fs.existsSync(filename)?readJson(filename):{version:1,profiles:{},matches:{},activity:[]};
    if(this.data.version!==1||!plainObject(this.data.profiles))throw Error('Invalid profiles database; preserving file');
    let migrated=false;
    for(const entry of Object.values(this.data.profiles)){
      // The pure reducer's profile checks also reject invalid XP/counters.
      integer(entry.xp,'stored XP',0,Number.MAX_SAFE_INTEGER);
      integer(entry.kills,'stored kills',0,Number.MAX_SAFE_INTEGER);
      integer(entry.deaths,'stored deaths',0,Number.MAX_SAFE_INTEGER);
      identifier(entry.playerId,'stored player ID');
      if(!plainObject(entry.seenLives))throw Error('Invalid stored profile history');
      if(entry.mastery===undefined){entry.mastery=newMastery(entry.xp);migrated=true;}
      validateMastery(entry.mastery);
    }
    this.data.matches??={};this.data.activity??=[];
    if(migrated){
      // Preserve the complete pre-migration database before the first durable rewrite.
      fs.copyFileSync(filename,filename+'.pre-mastery-'+Date.now()+'.bak',fs.constants.COPYFILE_EXCL);
      this.flush();
    }
  }
  ensure(account){
    const playerId=identifier(account.playerId,'player ID'),existing=this.data.profiles[playerId];
    const profile=existing?{...clone(existing),name:account.name}:
      {...newProgressProfile(playerId),name:account.name,wins:0,losses:0,draws:0,matches:0,loadouts:{}};
    if(!existing||existing.name!==account.name)this.save(profile);
    return profile;
  }
  save(profile){this.onProfile?.(profile);this.data.profiles[profile.playerId]=clone(profile);this.flush();}
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
      if(result.changed){this.onProfile?.(result.profile);this.data.profiles[playerId]=result.profile;updated.push(result.profile);}
    }
    if(updated.length)this.flush();
    return updated;
  }
  finishMatch(room,reason,winnerIds){
    if(this.data.matches[room.id])return this.data.matches[room.id];
    const participants=room.participants?[...room.participants.values()]:room.clients;
    const players=[...new Set(participants.map(client=>client.playerId))],draw=winnerIds.length===0;
    const result={id:room.id,reason,startedAt:room.startedAt,endedAt:Date.now(),players,
      winnerIds,scores:Object.fromEntries(room.kills),draw,mode:room.mode,
      teams:Object.fromEntries(participants.map(c=>[c.playerId,c.team])),teamScores:teamScores(room),roundWins:room.roundWins||null,
      names:Object.fromEntries(players.map(id=>[id,this.data.profiles[id]?.name||'Player'])),
      deaths:Object.fromEntries(room.deaths),points:Object.fromEntries(room.points),
      roomName:room.name,map:room.map,killLimit:room.mode==='tdm'?null:room.killLimit,
      roundWinLimit:room.mode==='tdm'?room.roundWinLimit:null,timeLimitSeconds:room.timeLimitSeconds};
    for(const playerId of players){
      const profile=this.data.profiles[playerId];
      const counter=draw?'draws':winnerIds.includes(playerId)?'wins':'losses';
      profile[counter]=(profile[counter]||0)+1;profile.matches=(profile.matches||0)+1;
    }
    this.data.matches[room.id]=result;
    this.onMatch?.(result,room);
    this.activity('match-ended',{matchId:room.id,playerIds:players,reason,winnerIds,draw});
    this.flush();return result;
  }
}

export async function startKarmaServer({
  host='0.0.0.0',port=29020,healthHost=host,healthPort=29021,
  dataDir=path.join(directory,'data'),catalogFile=path.join(directory,'loadouts.json'),
  characterFile=path.join(directory,'characters.json'),mapFile=path.join(directory,'multiplayer-maps.json'),maxRooms=20,maxPlayers=8,
  roundWinLimit=5,roundSeconds=180,roundIntermissionMs=5000,dmRespawnMs=10000,
  authService,exchange=null,tlsCert=process.env.TLS_CERT,tlsKey=process.env.TLS_KEY,matchKills=10,matchSeconds=600,
  logger=(event,details)=>console.log(JSON.stringify({time:new Date().toISOString(),event,...details})),
}={}){
  integer(maxRooms,'room limit',1,20);integer(maxPlayers,'player limit',2,8);
  const catalog=readJson(catalogFile),characters=readJson(characterFile);
  catalog.ranks=clone(RANKS);
  const multiplayerMaps=readJson(mapFile).maps;
  const mapAccess=new MapAccess(path.join(path.resolve(dataDir),'map-access.json'),multiplayerMaps);
  const weaponById=new Map(catalog.weapons.map(item=>[item.weaponId??item.id,item]));
  const db=new ProfileDatabase(path.join(path.resolve(dataDir),'profiles.json'));
  const auth=authService||new AuthService({filename:path.join(path.resolve(dataDir),'auth.json')});
  const filterChat=createChatFilter(readJson(path.join(directory,'chat-policy.json')));
  const chatArchive=new ChatArchive(path.join(path.resolve(dataDir),'chat-logs'));
  const conduct=new Conduct(path.join(path.resolve(dataDir),'conduct.json'));
  const fairplay=new FairPlay(path.join(path.resolve(dataDir),'fairplay.json'));
  const unrestricted=id=>!fairplay.hold(id)&&!conduct.summary(id).active;
  if(!db.data.promotionPolicy&&fs.existsSync(db.filename))fs.copyFileSync(db.filename,db.filename+'.pre-officer-policy-'+Date.now()+'.bak',fs.constants.COPYFILE_EXCL);
  const promotions=new AdaptivePromotions(db.data,{
    eligible:id=>{const a=auth.list().find(a=>a.playerId===id);return !!a&&a.role!=='admin'&&!a.disabled&&a.approvalStatus==='approved'&&unrestricted(id);},
    canPromote:id=>{const a=auth.list().find(a=>a.playerId===id);return !!a&&!a.disabled&&a.approvalStatus==='approved'&&unrestricted(id);},
  });
  const masteryProgress=profile=>promotions.progress(profile),rankXpForProfile=profile=>masteryProgress(profile).rankXp;
  db.onProfile=profile=>promotions.remember(profile);db.onMatch=(result,room)=>promotions.observe(result,room);
  promotions.review();db.flush();
  const coinProfiles=new Map();
  function coinIdentity(account){
    const profile=db.ensure(account),rankXp=rankXpForProfile(profile);
    return {...account,rankIndex:Math.max(0,catalog.ranks.findIndex(r=>r.minXp===rankForXp(rankXp,catalog.ranks).minXp)),sanctions:{active:conduct.summary(account.playerId).active}};
  }
  async function refreshCoins(account){
    if(!exchange)return;
    try{const wallet=await exchange.wallet(coinIdentity(account));coinProfiles.set(account.playerId,{...(wallet.coins||{}),available:wallet.balances.find(b=>b.symbol==='KARMA')?.available??0,locked:wallet.locked.KARMA||0,gameFee:100,url:exchange.publicUrl,status:'online'});}
    catch{coinProfiles.set(account.playerId,{available:null,gameFee:100,url:exchange.publicUrl,status:'unavailable'});}
  }
  if(!!tlsCert!==!!tlsKey)throw Error('TLS_CERT and TLS_KEY must be configured together');
  const tlsOptions=tlsCert?{cert:fs.readFileSync(tlsCert),key:fs.readFileSync(tlsKey),minVersion:'TLSv1.2'}:null;
  integer(roundWinLimit,'round win limit',1,100);integer(roundSeconds,'round time',1,3600);
  integer(roundIntermissionMs,'round break',1,30000);integer(dmRespawnMs,'deathmatch respawn',0,60000);
  integer(matchKills,'match kill limit',1,1000);integer(matchSeconds,'match time limit',1,86400);
  const rooms=new Map(),online=new Map(),sockets=new Set(),pendingPlayers=new Map(),admissions=new Set();
  let closing=false,acceptedMessages=0,relayedMessages=0;
  const log=(event,details={})=>{try{logger(event,details);}catch{}};
  function publicProfile(profile,character,account){
    const mastery=masteryProgress(profile),rankXp=mastery.rankXp;
    return {version:1,playerId:profile.playerId,name:profile.name,xp:profile.xp,
      kills:profile.kills,deaths:profile.deaths,rank:rankForXp(rankXp,catalog.ranks),rankIndex:Math.max(0,catalog.ranks.findIndex(r=>r.minXp===rankForXp(rankXp,catalog.ranks).minXp)),
      wins:profile.wins||0,losses:profile.losses||0,draws:profile.draws||0,matches:profile.matches||0,
      ...(account?{email:account.email,role:account.role,isAdmin:account.role==='admin',emailVerified:!!account.emailVerified,rulesRequired:!rulesAccepted(account),rulesVersion:GAME_RULES.version,sanctions:conduct.summary(account.playerId)}:{}),
      ...(character?{inventoryCapacity:loadoutBudget({xp:rankXp,character,ranks:catalog.ranks})}:{}),
      progressionVersion:3,rankXp,mastery,maps:mapAccess.list(),
      unlockedCharacterIds:Object.keys(catalog.characters).filter(id=>characterUnlocked(catalog.characters[id],rankXp)),
      dualCannonUnlocked:rankXp>=(catalog.constraints?.dualCannon?.minXp??Number.MAX_SAFE_INTEGER),
      ...(exchange&&account?{coins:coinProfiles.get(profile.playerId)??{available:null,gameFee:100,url:exchange.publicUrl,status:'unavailable'}}:{}),
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
  function activeClients(room){return room.clients.filter(c=>!c.closed);}
  function lateJoinEnabled(room){return room.mode==='dm'&&['karma290-central5','karma290-central6'].includes(room.build);}
  function remainingSeconds(room){return room.started?Math.max(0,Math.ceil((room.startedAt+room.timeLimitSeconds*1000-Date.now())/1000)):room.timeLimitSeconds;}
  function roomInfo(room){return {roomId:room.id,code:room.code,roomName:room.name,maxPlayers:room.maxPlayers,mode:room.mode,map:room.map,mapName:multiplayerMaps.find(m=>m.mapIndex===room.map)?.name,
    manualStart:room.manualStart===true,hostId:room.clients[0]?.playerId,gameFee:exchange?100:0,exchangeUrl:exchange?.publicUrl,
    killLimit:room.mode==='tdm'?null:room.killLimit,timeLimitSeconds:room.timeLimitSeconds,
    roundWinLimit:room.mode==='tdm'?room.roundWinLimit:null,roundSeconds:room.mode==='tdm'?roundSeconds:null,
    respawnMs:room.mode==='dm'?dmRespawnMs:room.mode==='tdm'?null:4500,
    lateJoinEnabled:lateJoinEnabled(room),remainingSeconds:remainingSeconds(room)};}
  function roomDirectory(account){
    return [...rooms.values()].filter(room=>!room.ending&&activeClients(room).length&&
      (account.role==='admin'||mapAccess.isOpen(room.map))).map(room=>{
      const players=activeClients(room),full=players.length+room.pending.size>=room.maxPlayers;
      const joinable=!room.starting&&!full&&(!room.started||lateJoinEnabled(room));
        return {roomId:room.id,code:room.code,roomName:room.name,hostName:players[0].account.name,map:room.map,
        mapName:multiplayerMaps.find(m=>m.mapIndex===room.map)?.name,mode:room.mode,
        players:players.length,maxPlayers:room.maxPlayers,
        state:room.starting?'starting':full?'full':room.started?'playing':'waiting',joinable,
        build:room.build,gameFee:exchange?100:0,remainingSeconds:remainingSeconds(room),
        killLimit:room.mode==='tdm'?null:room.killLimit,roundWinLimit:room.mode==='tdm'?room.roundWinLimit:null,timeLimitSeconds:room.timeLimitSeconds};
    }).sort((a,b)=>Number(b.joinable)-Number(a.joinable)||a.code.localeCompare(b.code));
  }
  function peerInfo(client){return {role:client.room.clients[0]===client?'host':'join',slot:client.slot,
    team:client.team,playerId:client.playerId,config:clone(client.config)};}
  function ready(client,lateJoin=false){
    const room=client.room,peers=activeClients(room).filter(other=>other!==client).map(peerInfo);
    write(client,{type:'peer-ready',version:2,role:room.clients[0]===client?'host':'join',slot:client.slot,
      ...roomInfo(room),team:client.team,config:clone(client.config),remoteHello:peers[0],peers,
      lateJoin,initialLife:client.state.life,
      profile:publicProfile(db.data.profiles[client.playerId],client.character,client.account)});
  }
  function scoreSnapshot(room){return {type:'match-snapshot',version:2,remainingSeconds:remainingSeconds(room),
    players:activeClients(room).map(c=>({playerId:c.playerId,kills:room.kills.get(c.playerId)||0,deaths:room.deaths.get(c.playerId)||0,points:room.points.get(c.playerId)||0}))};}
  function friendly(a,b){return a!==b&&a.room.mode==='tdm'&&a.team===b.team;}
  function error(session,code,message){
    write(session,{type:'error',version:2,code,message});
    session.socket.end();const timer=setTimeout(()=>session.socket.destroy(),250);timer.unref();
  }
  function normalizedConfig(value,profile,account){
    if(!plainObject(value)||Buffer.byteLength(JSON.stringify(value))>16384)reject('BAD_CONFIG','Invalid config');
    const battlefield=multiplayerMaps.find(m=>m.mapIndex===(value.map??0));
    if((value.age??0)!==0||!battlefield||(!mapAccess.isOpen(battlefield.mapIndex)&&account?.role!=='admin'))reject('BAD_CONFIG','멀티플레이 검증이 완료된 전장을 선택하세요.');
    if(battlefield.mapIndex!==0&&!['karma290-central4','karma290-central5','karma290-central6'].includes(value.settings?.build))reject('CLIENT_UPDATE_REQUIRED','새 전장을 사용하려면 클라이언트를 업데이트하세요.');
    if(battlefield.minClientBuild&&value.settings?.build!==battlefield.minClientBuild)reject('CLIENT_UPDATE_REQUIRED','이 맵을 사용하려면 최신 클라이언트로 업데이트하세요.');
    const offered=value.character;
    if(!plainObject(offered))reject('BAD_CONFIG','Character is required');
    const original=characters.find(item=>item.age===0&&item.characterIndex===offered.index&&item.camp===offered.camp);
    const character=original&&catalog.characters[original.id];
    if(!character)reject('BAD_CONFIG','Unsupported character');
    const equipment=validateLoadout({
      inventory:value.inventory??character.defaultInventory??catalog.defaultInventory,
      selectedWeapon:value.selectedWeapon??character.defaultSelectedWeapon??catalog.defaultSelectedWeapon,
      xp:rankXpForProfile(profile),character,weapons:catalog.weapons,ranks:catalog.ranks,
      slotRules:catalog.slots,constraints:catalog.constraints,
    });
    const build=value.settings?.build??'karma290-lan1';
    if(typeof build!=='string'||!/^[A-Za-z0-9_.-]{1,96}$/.test(build))reject('BAD_CONFIG','Invalid build');
    const config={map:battlefield.mapIndex,age:0,character:{index:original.characterIndex,camp:original.camp,
      model:path.basename(original.model.replaceAll('\\','/')).toLowerCase(),name:profile.name},
      inventory:equipment.inventory,selectedWeapon:equipment.selectedWeapon,rank:rankForXp(rankXpForProfile(profile),catalog.ranks),
      settings:{build,mode:1}};
    return {config,character,characterId:original.id};
  }
  function armRoundTimer(room){
    clearTimeout(room.roundTimer);
    room.roundTimer=setTimeout(()=>endRound(room,'round-time-limit'),roundSeconds*1000);room.roundTimer.unref();
  }
  function endRound(room,reason){
    if(room.mode!=='tdm'||room.phase!=='active'||room.ending)return;
    const alive=[0,0];for(const c of room.clients)if(!c.closed&&c.alive)alive[c.team]++;
    const winner=alive[0]===alive[1]?null:alive[0]>alive[1]?0:1;
    room.phase='intermission';clearTimeout(room.roundTimer);
    if(winner!==null)room.roundWins[winner]++;
    broadcast(room,{type:'round-ended',version:2,round:room.round,winnerTeam:winner,roundWins:[...room.roundWins],reason,nextRoundInMs:roundIntermissionMs});
    if(winner!==null&&room.roundWins[winner]>=room.roundWinLimit){
      finishRoom(room,'round-limit',room.clients.filter(c=>!c.closed&&c.team===winner).map(c=>c.playerId));return;
    }
    room.roundTimer=setTimeout(()=>{
      if(room.ending)return;
      room.round++;room.phase='active';room.evidence.clear();
      const lives={};
      for(const c of room.clients)if(!c.closed){
        c.alive=true;c.deadAt=0;c.roundLife++;lives[c.playerId]=c.roundLife;
        c.inventory=[...c.config.inventory];c.state.ammo={};
      }
      // Ground weapons belong to the finished round.
      for(const id of room.dropOrder)broadcast(room,{type:'drop-removed',version:2,dropId:id,reason:'new-round'});
      room.drops.drops.clear();room.dropOrder=[];
      broadcast(room,{type:'round-start',version:2,round:room.round,roundWins:[...room.roundWins],lives});
      armRoundTimer(room);
    },roundIntermissionMs);room.roundTimer.unref();
  }
  function startReason(room){
    if(room.started||room.ending)return '대전이 이미 시작되었거나 종료되었습니다.';
    if(room.starting)return '거래소에서 참가자 이용료를 확인하고 있습니다.';
    if(room.clients.length<2)return '두 명 이상 접속해야 시작할 수 있습니다.';
    if(room.mode==='tdm'&&room.clients.length%2!==0)return '팀전은 양 팀 인원이 같아야 합니다. 한 명을 더 기다려 주세요.';
    const unready=room.clients.filter(client=>!client.ready);
    if(unready.length)return '모든 참가자가 장비 설정 후 준비 완료를 눌러야 합니다. 미준비: '+unready.slice(0,3).map(client=>client.account.name).join(', ')+(unready.length>3?' 외 '+(unready.length-3)+'명':'');
    return '';
  }
  function lobbyInfo(room){return {type:'waiting',version:2,...roomInfo(room),players:room.clients.length,
    canStart:startReason(room)==='',startReason:startReason(room),
    roomRevision:room.settingsRevision||0,roomSettingsEditable:!room.started&&!room.starting&&!room.ending&&room.pending.size===0,
    availableMaps:multiplayerMaps.filter(m=>room.clients.every(c=>mapAccess.isOpen(m.mapIndex)||c.account.role==='admin')&&(!m.minClientBuild||m.minClientBuild===room.build)).map(m=>({map:m.mapIndex,name:m.name,maxPlayers:m.maxPlayers||8})),
    members:room.clients.map(c=>({playerId:c.playerId,name:c.account.name,slot:c.slot,team:c.team,ready:c.ready===true,
      ...(c.lobbyPing?.snapshot()||{pingMs:null,pingStatus:'unsupported'})}))};}
  function probeLobby(session){
    if(session.closed||!session.room||session.room.started||session.room.ending)return;
    const probe=session.lobbyPing?.probe();if(probe)write(session,probe);
  }
  function changeRoomSettings(session,message){
    const room=session.room,value=message.roomSettings;
    if(room.clients[0]!==session)reject('HOST_ONLY','방장만 방 설정을 변경할 수 있습니다.');
    if(room.started||room.starting||room.ending||room.pending.size)reject('ROOM_BUSY','시작·입장 처리 중이거나 진행 중인 방은 변경할 수 없습니다.');
    if(message.roomId!==room.id||message.roomRevision!==(room.settingsRevision||0))reject('ROOM_CHANGED','방 설정이 변경되었습니다. 창을 다시 열어 주세요.');
    if(!plainObject(value)||message.ready!==undefined||message.config!==undefined)reject('BAD_ROOM_SETTINGS','방 설정만 별도로 요청해 주세요.');
    const map=integer(value.map,'map',0,19),capacity=integer(value.maxPlayers,'room capacity',2,maxPlayers),mode=value.mode;
    const battlefield=multiplayerMaps.find(m=>m.mapIndex===map);
    if(!battlefield||capacity>(battlefield.maxPlayers||8))reject('MAP_CAPACITY','선택한 맵의 최대 인원을 초과했습니다.');
    if(!['duel','dm','tdm'].includes(mode)||(mode==='duel'&&capacity!==2)||(mode==='tdm'&&capacity%2!==0))reject('BAD_MODE','1:1은 2명, 팀전 정원은 짝수로 설정해 주세요.');
    if(capacity<room.clients.length||room.clients.some(c=>capacity>(c.capability||8)))reject('ROOM_CAPACITY','현재 참가자 수 또는 참가자의 지원 인원에 맞지 않습니다.');
    const name=roomDisplayName(value.roomName,session.account.name+'의 방');
    const kills=integer(value.killLimit,'kill limit',1,30),rounds=integer(value.roundWinLimit,'round win limit',1,10),seconds=integer(value.timeLimitSeconds,'match seconds',60,1800);
    // Validate every participant before any mutation, including map access.
    const configurations=room.clients.map(c=>normalizedConfig({...c.config,map},db.data.profiles[c.playerId],auth.authenticate(c.authToken)).config);
    Object.assign(room,{name,map,maxPlayers:capacity,mode,killLimit:kills,roundWinLimit:rounds,timeLimitSeconds:seconds,settingsRevision:(room.settingsRevision||0)+1});room.lobbyRevision++;
    room.clients.forEach((c,index)=>{c.config=configurations[index];c.ready=false;c.slot=index;c.team=index%2;});
    write(session,{type:'lobby-updated',version:2,requestId:message.requestId,roomId:room.id,ready:false,config:clone(session.config)});
    broadcast(room,lobbyInfo(room));
  }
  function lobbyUpdate(session,message){
    const room=session.room,requestId=message.requestId;
    try{
      if(room.started||room.ending)reject('MATCH_STARTED','이미 시작한 대전에서는 대기실 장비나 준비 상태를 변경할 수 없습니다.');
      if(requestId!==undefined)identifier(requestId,'request ID');
      if(message.roomSettings!==undefined){changeRoomSettings(session,message);return;}
      if(message.ready===undefined&&message.config===undefined)reject('BAD_LOBBY_UPDATE','준비 상태나 장비 설정을 선택해 주세요.');
      if(message.ready!==undefined&&typeof message.ready!=='boolean')reject('BAD_LOBBY_UPDATE','준비 상태가 올바르지 않습니다.');
      if(message.config!==undefined){
        session.ready=false;room.lobbyRevision++;
        const account=auth.authenticate(session.authToken),profile=db.ensure(account);
        const offered=normalizedConfig({...message.config,map:room.map},profile,account);
        if(offered.config.settings.build!==room.build)reject('BUILD_MISMATCH','클라이언트 버전이 현재 방과 다릅니다.');
        profile.loadouts={...profile.loadouts,[offered.characterId]:{inventory:[...offered.config.inventory],selectedWeapon:offered.config.selectedWeapon}};
        db.save(profile);
        session.account=account;session.character=offered.character;session.config=offered.config;
        session.inventory=[...offered.config.inventory];session.state.inventory=[...session.inventory];
        session.state.selectedWeapon=offered.config.selectedWeapon;session.state.ammo={};
      }else if(session.ready!==message.ready){session.ready=message.ready;room.lobbyRevision++;}
      write(session,{type:'lobby-updated',version:2,requestId,roomId:room.id,ready:session.ready,config:clone(session.config),
        profile:publicProfile(db.data.profiles[session.playerId],session.character,session.account)});
      broadcast(room,lobbyInfo(room));
      if(!room.manualStart&&room.clients.length===room.maxPlayers)startRoom(room);
    }catch(problem){
      write(session,{type:'lobby-update-denied',version:2,requestId,code:problem.code||'BAD_LOADOUT',message:problem.message,lobby:lobbyInfo(room)});
      if(!room.started&&!room.ending)broadcast(room,lobbyInfo(room));
    }
  }
  async function startRoom(room){
    if(room.started||startReason(room)!=='')return;
    let payment=null;
    if(exchange){
      room.starting=true;const participants=[...room.clients],revision=room.lobbyRevision,paymentId=crypto.randomUUID();
      broadcast(room,lobbyInfo(room));
      try{
        payment=await exchange.charge(paymentId,participants.map(c=>coinIdentity(c.account)));
        if(closing||rooms.get(room.code)!==room||room.lobbyRevision!==revision||participants.length!==room.clients.length||participants.some((c,i)=>c.closed||!c.ready||room.clients[i]!==c))throw Error('참가자나 준비 상태가 변경됐습니다. 다시 시작해 주세요.');
        for(const client of participants)auth.authenticate(client.authToken);
        await Promise.all(participants.map(c=>refreshCoins(c.account)));
        if(closing||rooms.get(room.code)!==room||room.lobbyRevision!==revision||participants.length!==room.clients.length||participants.some((c,i)=>c.closed||!c.ready||room.clients[i]!==c))throw Error('참가자나 준비 상태가 변경됐습니다. 다시 시작해 주세요.');
        for(const client of participants)auth.authenticate(client.authToken);
      }catch(problem){
        if(payment)await exchange.refund(paymentId);
        room.starting=false;
        if(rooms.has(room.code))broadcast(room,{type:'start-denied',version:2,message:problem.code==='INSUFFICIENT_FUNDS'?problem.message:'대전을 시작하지 못했습니다. '+(payment?'이용료를 반환합니다. ':'')+(problem.code?'거래소 연결을 확인하세요.':problem.message),lobby:lobbyInfo(room)});
        return;
      }
      room.starting=false;
    }
    room.started=true;room.startedAt=Date.now();room.phase='active';room.round=1;room.roundWins=[0,0];
    for(const c of room.clients){c.lifeActive=false;c.lifeStartedAt=Date.now();c.activityPos=null;c.activityShot=null;c.alive=true;c.roundLife=1;c.deadAt=0;room.participants.set(c.playerId,{playerId:c.playerId,team:c.team,lastLife:1});room.paid.add(c.playerId);}
    for(const c of room.clients)promotions.start(room,c);
    room.kills=new Map(room.clients.map(client=>[client.playerId,0]));
    room.deaths=new Map(room.clients.map(client=>[client.playerId,0]));
    room.points=new Map(room.clients.map(client=>[client.playerId,0]));
    const playerIds=room.clients.map(client=>client.playerId);
    room.combat=new CombatLedger({matchId:room.id,playerIds});
    room.drops=new DropLedger({matchId:room.id,playerIds,maxDistance:350});
    room.dropOrder=[];room.evidence=new Map();
    for(const client of room.clients)ready(client);
    if(room.mode==='tdm')armRoundTimer(room);
    room.matchTimer=setTimeout(()=>finishRoom(room,'time-limit'),room.timeLimitSeconds*1000);room.matchTimer.unref();
    log('room-started',{roomCount:rooms.size,players:room.clients.length,capacity:room.maxPlayers});
    if(payment)exchange.confirm(payment.matchId);
  }
  async function hello(session,message){
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
    if(!rulesAccepted(account))reject('RULES_REQUIRED','게임 대시보드 https://192.168.12.100:29021/#rules 에서 운영 규정에 먼저 동의해 주세요.');
    if(conduct.summary(account.playerId).active)reject('ACCOUNT_RESTRICTED','규정 위반 제재로 대전 이용이 제한됩니다. 대시보드에서 사유와 소명을 확인하세요.');
    if(fairplay.hold(account.playerId))reject('FAIRPLAY_HOLD','반복 실적 작업 의심으로 게임 이용이 일시 중지되었습니다. 관리자에게 확인을 요청해 주세요.');
    const capability=integer(message.clientMaxPlayers??2,'client capability',2,maxPlayers);
    const playerId=identity.profile.playerId;
    if(online.has(playerId)||pendingPlayers.has(playerId))reject('ALREADY_CONNECTED','This player is already connected');
    const offered=normalizedConfig(message.config,identity.profile,account);
    let room;
    if(message.op==='create'){
      if(rooms.size>=maxRooms)reject('ROOM_LIMIT','The server has reached its room limit');
      const capacity=integer(message.maxPlayers??2,'room capacity',2,maxPlayers);
      if(capacity>(multiplayerMaps.find(m=>m.mapIndex===offered.config.map)?.maxPlayers||8))reject('MAP_CAPACITY','이 맵의 시작 위치 수를 초과했습니다. 맵별 최대 인원을 확인하세요.');
      if(capacity>capability)reject('CLIENT_LIMIT','This client cannot enter a room of that size');
      let code=message.code;
      if(code!==undefined&&(!/^\d{6}$/.test(code)||rooms.has(code)))reject('BAD_CODE','Room code is invalid or in use');
      if(code===undefined){do{code=String(crypto.randomInt(100000,1000000));}while(rooms.has(code));}
      const mode=message.mode??(capacity===2?'duel':'dm');
      if(!['duel','dm','tdm'].includes(mode)||(mode==='duel'&&capacity!==2)||(mode==='tdm'&&capacity%2!==0))
        reject('BAD_MODE','Choose duel (2), deathmatch (2–8), or even-sized team deathmatch');
      room={id:crypto.randomUUID(),code,name:roomDisplayName(message.roomName,account.name+'의 방'),maxPlayers:capacity,mode,map:offered.config.map,build:offered.config.settings.build,lobbyRevision:0,
        manualStart:message.manualStart===true,returnLobby:message.returnLobby===true,
        killLimit:message.killLimit===undefined?Math.min(30,matchKills):integer(message.killLimit,'kill limit (1–30)',1,30),
        roundWinLimit:message.roundWinLimit===undefined?Math.min(10,roundWinLimit):integer(message.roundWinLimit,'round win limit (1–10)',1,10),
        timeLimitSeconds:message.timeLimitSeconds===undefined?Math.min(1800,matchSeconds):integer(message.timeLimitSeconds,'match seconds (60–1800)',60,1800),clients:[],
        pending:new Map(),participants:new Map(),paid:new Set(),started:false,ending:false};
      rooms.set(code,room);
    }else{
      if(typeof message.code!=='string'||!/^\d{6}$/.test(message.code))reject('BAD_CODE','A six-digit room code is required');
      room=rooms.get(message.code);
      if(!room)reject('ROOM_NOT_FOUND','Room not found');
      if(message.roomId!==undefined&&message.roomId!==room.id)reject('ROOM_CHANGED','선택한 방이 종료되거나 변경되었습니다. 방 목록을 새로 고친 뒤 다시 참가하세요.');
      if(room.starting)reject('ROOM_STARTING','대전 시작 처리 중입니다. 잠시 후 다시 참가하세요.');
      if(room.ending||room.started&&!lateJoinEnabled(room))reject('ROOM_STARTED','이미 시작한 방입니다. 개인전 최신 버전에서만 중간 참가할 수 있습니다.');
      if(activeClients(room).length+room.pending.size>=room.maxPlayers)reject('ROOM_FULL','방에 빈자리가 없습니다.');
      if(room.maxPlayers>capability)reject('CLIENT_LIMIT','Update the client to enter this room size');
      if(room.build!==offered.config.settings.build)reject('BUILD_MISMATCH','Both clients must use the same build');
      const hostMap=multiplayerMaps.find(m=>m.mapIndex===room.map);
      if(!mapAccess.isOpen(room.map)&&account.role!=='admin')reject('MAP_NOT_RELEASED','이 전장은 아직 관리자 검증 중입니다.');
      offered.config.map=room.map;
    }
    // Rich results include names and four ID-keyed score tables. Bound history
    // so the final UTF-8 message fits the clients' 64 KiB frame limit.
    if(room.started&&!room.participants.has(playerId)&&room.participants.size>=128)reject('MATCH_HISTORY_FULL','이 대전의 누적 참가자 한도에 도달했습니다. 다음 대전을 이용하세요.');
    const occupied=new Set([...activeClients(room).map(c=>c.slot),...room.pending.values()].map(value=>typeof value==='number'?value:value.slot));
    let slot=0;while(occupied.has(slot))slot++;
    room.pending.set(playerId,{session,slot});pendingPlayers.set(playerId,session);
    clearTimeout(session.handshakeTimer);
    session.handshakeTimer=setTimeout(()=>error(session,'HELLO_TIMEOUT','Connection setup timed out'),25000);session.handshakeTimer.unref();
    let paymentId=null,payment=null,admitted=false;
    const checkAdmission=()=>{
      if(closing||session.closed||session.socket.destroyed||session.socket.writableEnded)reject('JOIN_CANCELLED','참가가 취소되었습니다.');
      if(rooms.get(room.code)!==room||room.ending||room.started&&!lateJoinEnabled(room))reject('ROOM_ENDED','대전이 종료되었습니다. 방 목록을 새로 고쳐 주세요.');
      if(!mapAccess.isOpen(room.map)&&account.role!=='admin')reject('MAP_NOT_RELEASED','이 전장은 아직 관리자 검증 중입니다.');
      return auth.authenticate(message.authToken);
    };
    try{
      if(room.started&&exchange&&!room.paid.has(playerId)){
        paymentId=crypto.randomUUID();payment=await exchange.charge(paymentId,[coinIdentity(account)]);checkAdmission();
        await refreshCoins(account);checkAdmission();
      }
      session.account=checkAdmission();
      const currentProfile=db.ensure(session.account),previous=room.participants.get(playerId);
      const initialLife=previous?previous.lastLife+1:1;
      currentProfile.loadouts={...currentProfile.loadouts,[offered.characterId]:{
        inventory:[...offered.config.inventory],selectedWeapon:offered.config.selectedWeapon}};
      db.save(currentProfile);
      if(room.started){room.combat.addParticipant(playerId);room.drops.addParticipant(playerId);}
      session.playerId=playerId;session.character=offered.character;
      if(message.lobbyPing===1)session.lobbyPing=new LobbyPing();
      session.config=offered.config;session.capability=capability;session.room=room;session.slot=slot;session.team=slot%2;
      session.inventory=[...offered.config.inventory];
      session.state={life:initialLife,hp:100,pos:[0,0,0],inventory:[...session.inventory],
        selectedWeapon:offered.config.selectedWeapon,ammo:{},seq:-1};
      session.hasState=false;session.alive=true;session.roundLife=initialLife;session.deadAt=0;session.ready=false;
      clearTimeout(session.handshakeTimer);room.pending.delete(playerId);room.clients.push(session);online.set(playerId,session);admitted=true;
      write(session,{type:'welcome',version:2,
        profile:publicProfile(currentProfile,session.character,session.account),room:roomInfo(room),
        role:room.clients[0]===session?'host':'join',slot:session.slot,team:session.team});
      if(room.started){
        room.participants.set(playerId,{playerId,team:session.team,lastLife:initialLife});room.paid.add(playerId);
        promotions.start(room,session);
        if(!room.kills.has(playerId))room.kills.set(playerId,0);
        if(!room.deaths.has(playerId))room.deaths.set(playerId,0);
        if(!room.points.has(playerId))room.points.set(playerId,0);
        broadcast(room,{type:'peer-joined',version:2,peer:peerInfo(session)},session);
        ready(session,true);broadcast(room,scoreSnapshot(room));
        for(const other of activeClients(room))if(other!==session&&other.latestPose)
          write(session,{type:'game',version:2,senderId:other.playerId,slot:other.slot,message:clone(other.latestPose)});
        for(const drop of room.drops.drops.values())if(!drop.claimedBy)write(session,{type:'drop',version:2,drop:clone(drop)});
        if(payment)exchange.confirm(paymentId);
      }else{
        room.lobbyRevision++;
        broadcast(room,lobbyInfo(room));
        probeLobby(session);
        if(!room.manualStart&&room.clients.length===room.maxPlayers)startRoom(room);
      }
    }catch(problem){
      if(payment&&!admitted)await exchange.refund(paymentId);
      throw problem;
    }finally{
      room.pending.delete(playerId);
      if(pendingPlayers.get(playerId)===session)pendingPlayers.delete(playerId);
      if(!room.clients.length&&!room.pending.size&&rooms.get(room.code)===room)rooms.delete(room.code);
    }
  }
  function damageProof(session,value){
    if(!plainObject(value))reject('BAD_PROOF','Damage proof is required');
    const attacker=session.room.clients.find(c=>c.playerId===value.attackerId);
    if(attacker&&friendly(session,attacker)){write(session,{type:'proof-rejected',version:2,id:value.id,reason:'friendly-fire-disabled'});return;}
    const proof={...value,id:eventId(value.id),victimId:session.playerId};
    if(session.hasState&&proof.victimLife!==session.state.life)return;
    // shotId belongs to the attacker; id belongs to this victim's damage event.
    // Distinct attackers may both fire shot 1, and one projectile may affect
    // the same victim more than once. Neither is a duplicate damage receipt.
    const shotId=eventId(value.shotId??value.id);
    const evidence=session.room.evidence.get(JSON.stringify([proof.attackerId,proof.attackerLife,shotId,session.playerId]))||
      session.room.evidence.get(JSON.stringify([proof.attackerId,proof.attackerLife,shotId]));
    if(!evidence||evidence.weapon!==proof.weapon||
       (evidence.victimId!==null&&(evidence.victimId!==session.playerId||evidence.victimLife!==proof.victimLife))){
      write(session,{type:'proof-rejected',version:2,id:proof.id,reason:'no-matching-shot-or-hit'});return;
    }
    // Classification comes from the matching relayed hit, never a caller's
    // headshot flag. Projectiles/pellets cannot acquire a bullet headshot.
    proof.hitKind=evidence.kind||'unknown';
    proof.hitRegion=evidence.kind==='bullet'?evidence.region:null;
    session.room.combat.recordDamage(session.playerId,proof);
  }
  function updateState(session,message){
    const old=session.state;
    if(session.room.mode==='tdm'&&(message.life!==session.roundLife||!session.alive))return false;
    if(session.room.mode==='dm'&&message.life>old.life&&(!session.deadAt||Date.now()-session.deadAt<dmRespawnMs))return false;
    if(session.room.mode==='dm'&&session.deadAt&&message.life===old.life&&message.hp>0)return false;
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
    session.state={life:message.life,hp:message.hp,pos:[...message.pos],sector:message.sector,seq:message.seq,
      inventory:[...session.inventory],selectedWeapon,ammo:ammunition};
    session.latestPose={...clone(message),type:'state',inventory:[...session.inventory],selectedWeapon,ammo:clone(ammunition)};
    delete session.latestPose.shot;
    const participant=session.room.participants.get(session.playerId);
    if(participant)participant.lastLife=Math.max(participant.lastLife,message.life);
    session.hasState=true;if(message.life>old.life){session.deadAt=0;session.alive=true;}
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
    session.state.hp=0;session.deadAt=Date.now();session.alive=false;
    if(session.latestPose)session.latestPose.hp=0;
    room.deaths.set(session.playerId,(room.deaths.get(session.playerId)||0)+1);
    if(room.mode==='tdm')queueMicrotask(()=>{
      const living=new Set(room.clients.filter(c=>!c.closed&&c.alive).map(c=>c.team));
      if(living.size<2)endRound(room,'team-eliminated');
    });
    const receipt=result.receipt;receipt.map=room.map;
    const feed={id:receipt.id,kind:receipt.verified?'kill':receipt.killer==='self'?'self':'death',
      killerId:receipt.verified||receipt.killer==='self'?receipt.killerId:null,victimId:receipt.victimId,
      killerName:receipt.verified?(db.data.profiles[receipt.killerId]?.name||'플레이어'):'',
      victimName:session.account.name,techniqueName:receipt.verified?(scenarioForWeapon(room.map,receipt.weapon)?.name||techniqueForWeapon(receipt.weapon)?.name||''): '',weapon:receipt.weapon,weaponName:weaponById.get(receipt.weapon)?.name||'무기',
      headshot:receipt.verified&&receipt.damage?.hitKind==='bullet'&&receipt.damage.hitRegion===0,time:Date.now()};
    broadcast(room,{type:'death-confirmed',version:2,receipt,feed});
    const previousXp=new Map([result.receipt.victimId,result.receipt.killerId].map(id=>[id,db.data.profiles[id]?.xp||0]));
    const review=fairplay.observe(receipt,{map:room.map,passive:session.lifeActive===false&&Date.now()-(session.lifeStartedAt||Date.now())>=8000});
    if(review)promotions.exclude(review.playerId,'fairplay-hold');
    const changed=db.award(result.receipt);
    if(review)queueMicrotask(()=>{
      const suspect=online.get(review.playerId);
      if(suspect)error(suspect,'FAIRPLAY_HOLD','반복 실적 작업 의심으로 게임 이용이 일시 중지되었습니다. 관리자 확인 후 재개할 수 있습니다.');
      db.activity('fairplay-hold',{targetId:review.playerId,caseId:review.id});
    });
    for(const profile of changed){
      room.points.set(profile.playerId,(room.points.get(profile.playerId)||0)+profile.xp-previousXp.get(profile.playerId));
      const client=online.get(profile.playerId);
      if(client)write(client,{type:'profile',version:2,profile:publicProfile(profile,client.character,client.account)});
    }
    if(result.receipt.verified){
      const killer=result.receipt.killerId;
      room.kills.set(killer,(room.kills.get(killer)||0)+1);
      const reached=room.kills.get(killer)>=room.killLimit;
      if(reached&&room.mode!=='tdm')queueMicrotask(()=>finishRoom(room,'kill-limit',[killer]));
    }
    broadcast(room,scoreSnapshot(room));
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
      state:session.state,character:session.character,xp:rankXpForProfile(profile),
      weapons:catalog.weapons,ranks:catalog.ranks,constraints:catalog.constraints,
    });
    if(!result.granted){write(session,{type:'pickup-denied',version:2,requestId:message.requestId,dropId:message.dropId,reason:result.reason});return;}
    const grant=result.grant;
    if(!result.duplicate){
      session.inventory[grant.replaceSlot]=grant.weapon;
      session.state.inventory=[...session.inventory];
      session.state.ammo[grant.weapon]={magazine:grant.magazine,reserve:grant.reserve};
      session.state.selectedWeapon=grant.weapon;
      if(session.latestPose)Object.assign(session.latestPose,{inventory:[...session.inventory],ammo:clone(session.state.ammo),selectedWeapon:grant.weapon,weapon:grant.weapon});
    }
    if(result.duplicate)write(session,{type:'pickup-grant',version:2,grant,replay:true});
    else broadcast(session.room,{type:'pickup-grant',version:2,grant});
  }
  function manualDrop(session,message){
    const deny=reason=>write(session,{type:'drop-denied',version:2,requestId:message.requestId,reason});
    if(!session.hasState)return deny('no-player-state');
    if(session.state.sector<0)return deny('invalid-sector');
    const result=session.room.drops.dropWeapon(session.playerId,message,{state:session.state,weapons:catalog.weapons});
    if(!result.granted)return deny(result.reason);
    const grant=result.grant;
    if(!result.duplicate){
      session.inventory=[...grant.inventory];session.state.inventory=[...grant.inventory];
      session.state.selectedWeapon=grant.selectedWeapon;delete session.state.ammo[grant.weapon];
      if(session.latestPose)Object.assign(session.latestPose,{inventory:[...session.inventory],ammo:clone(session.state.ammo),selectedWeapon:grant.selectedWeapon,weapon:grant.selectedWeapon});
      session.room.dropOrder.push(grant.drop.id);
      while(session.room.dropOrder.length>40){
        const expired=session.room.dropOrder.shift();session.room.drops.drops.delete(expired);
        broadcast(session.room,{type:'drop-removed',version:2,dropId:expired,reason:'ground-limit'});
      }
    }
    write(session,{type:'drop-grant',version:2,grant,replay:result.duplicate});
    if(!result.duplicate)broadcast(session.room,{type:'drop',version:2,drop:grant.drop});
  }
  function chat(session,message){
    try{
      const room=session.room;
      if(!room||room.ending)reject('CHAT_CLOSED','이 방의 채팅이 종료되었습니다.');
      const requestId=identifier(message.requestId,'chat request ID');
      if(!['all','team'].includes(message.channel)||message.channel==='team'&&room.mode!=='tdm')reject('BAD_CHAT_CHANNEL','팀 채팅은 팀전에서만 사용할 수 있습니다.');
      if(typeof message.text!=='string'||message.text.length>200)reject('BAD_CHAT_TEXT','채팅은 1~200자로 입력해 주세요.');
      const text=message.text.replace(/[\u0000-\u001f\u007f]/g,' ').trim();
      if(!text)reject('BAD_CHAT_TEXT','채팅 내용을 입력해 주세요.');
      session.chatSeen??=new Map();
      const previous=session.chatSeen.get(requestId);
      if(previous){
        if(previous.text!==text||previous.channel!==message.channel)reject('CHAT_REPLAY','같은 채팅 요청의 내용이 다릅니다.');
        write(session,previous.item);return;
      }
      const now=Date.now();session.chatTimes=(session.chatTimes||[]).filter(t=>now-t<5000);
      if(session.chatTimes.length>=5)reject('CHAT_RATE_LIMIT','채팅을 너무 빠르게 보냈습니다. 잠시 후 다시 보내세요.');
      session.chatTimes.push(now);
      const filtered=filterChat(text);
      const item={type:'chat',version:2,id:crypto.randomUUID(),requestId,roomId:room.id,
        senderId:session.playerId,name:session.account.name,team:session.team,channel:message.channel,...filtered,time:now};
      try{chatArchive.append({id:item.id,requestId,time:now,roomId:room.id,roomName:room.name,mode:room.mode,
        phase:room.started?'game':'lobby',senderId:session.playerId,name:session.account.name,team:session.team,
        channel:message.channel,originalText:message.text,displayText:filtered.text,moderated:filtered.moderated});}
      catch(problem){logger('chat-storage-error',{code:problem.code||'WRITE_FAILED'});reject('CHAT_STORAGE_UNAVAILABLE','채팅 기록을 저장하지 못해 전송하지 않았습니다. 잠시 후 다시 보내세요.');}
      session.chatSeen.set(requestId,{text,channel:message.channel,item});if(session.chatSeen.size>100)session.chatSeen.delete(session.chatSeen.keys().next().value);
      for(const recipient of activeClients(room))if(item.channel==='all'||recipient.team===session.team)write(recipient,item);
    }catch(problem){write(session,{type:'chat-denied',version:2,requestId:typeof message.requestId==='string'?message.requestId.slice(0,96):'',code:problem.code||'BAD_CHAT',message:problem.message});}
  }
  function receive(session,message){
    acceptedMessages++;
    if(!plainObject(message))reject('BAD_MESSAGE','Expected an object');
    if(!session.playerId){
      if(session.admitting)reject('HELLO_PENDING','Connection setup is already in progress');
      session.admitting=true;
      const admission=hello(session,message).catch(problem=>error(session,problem.code||'BAD_HELLO',problem.message))
        .finally(()=>{session.admitting=false;admissions.delete(admission);});
      admissions.add(admission);return;
    }
    if(message.type==='ping'){write(session,{type:'pong',version:2});return;}
    if(message.type==='latency-reply'){
      if(!session.room.started&&!session.room.ending)session.lobbyPing?.accept(message.token);
      return;
    }
    if(message.type==='leave'){session.socket.end();return;}
    if(message.type==='chat-send'){chat(session,message);return;}
    if(message.type==='lobby-update'){lobbyUpdate(session,message);return;}
    if(message.type==='start-match'){
      const room=session.room;
      if(room.started)return;
      const reason=message.roomId!==room.id?'현재 방의 시작 요청이 아닙니다.':
        room.clients[0]!==session?'방장만 시작할 수 있습니다.':startReason(room);
      if(reason){write(session,{type:'start-denied',version:2,message:reason,lobby:lobbyInfo(room)});return;}
      startRoom(room);return;
    }
    if(!session.room.started)reject('NOT_READY','Waiting for the other players');
    if(session.room.phase==='intermission'&&message.type!=='leave'&&message.message?.type!=='leave')return;
    if(message.type==='damage-proof'){damageProof(session,message.proof);return;}
    if(message.type==='pickup-claim'){claim(session,message);return;}
    if(message.type==='drop-claim'){manualDrop(session,message);return;}
    if(message.type!=='game')reject('BAD_MESSAGE','Unsupported message type');
    const game=validateLanMessage(message.message);
    if(session.room.mode==='tdm'&&['hit','state','respawn','death'].includes(game.type)&&
      (game.life!==session.roundLife||!session.alive&&game.type!=='death'))return;
    if(game.type==='state'||game.type==='respawn'){
      if(session.activityLife!==game.life){session.activityLife=game.life;session.lifeActive=false;session.lifeStartedAt=Date.now();session.activityPos=null;session.activityShot=null;}
      if(session.activityPos&&game.pos.some((v,i)=>Math.abs(v-session.activityPos[i])>40))session.lifeActive=true;
      if(game.shot&&game.shot.id!==session.activityShot){session.lifeActive=true;session.activityShot=game.shot.id;}
      session.activityPos??=[...game.pos];
      if(game.type==='respawn'&&game.life>session.state.life){
        session.inventory=[...session.config.inventory];
        session.state.ammo={};
      }
      if(!updateState(session,game))return;
      promotions.track(session.room,session,game);
    }
    let target=null;
    if(message.targetId!==undefined){
      target=online.get(identifier(message.targetId,'target ID'));
      if(!target||target===session||target.room!==session.room)reject('BAD_TARGET','Target is not in this room');
    }
    const room=session.room;
    if(game.type==='hit'){
      if(!target&&room.maxPlayers>2)reject('BAD_TARGET','Hits in multiplayer require a named victim');
      target??=room.clients.find(c=>c!==session&&!c.closed);
      if(!target||friendly(session,target))return;
    }
    const evidence=game.type==='hit'?{
      id:game.id,life:game.life,weapon:game.weapon,victimLife:game.victimLife,kind:game.kind,region:game.kind==='bullet'?game.region:null,
      victimId:target?.playerId??(room.clients.length===2?room.clients.find(client=>client!==session).playerId:null),
    }:game.shot?{...game.shot,victimId:null}:null;
    if(evidence){
      const key=[session.playerId,evidence.life,eventId(evidence.id)];
      if(evidence.victimId!==null)key.push(evidence.victimId);
      const evidenceKey=JSON.stringify(key),previous=room.evidence.get(evidenceKey);
      if(previous){
        if(previous.weapon!==evidence.weapon||previous.victimLife!==evidence.victimLife)
          reject('BAD_EVIDENCE','Conflicting shot evidence');
        // A native pose can retain its last shot after G has removed that gun.
        // Preserve the original damage evidence, but never replay an old shot
        // or check it against the player's newer inventory.
        if(game.type==='hit')return;
        delete game.shot;
      }else{
        if(!session.inventory.includes(evidence.weapon))reject('BAD_INVENTORY','Fired weapon is not owned');
        room.evidence.set(evidenceKey,evidence);
        while(room.evidence.size>2048)room.evidence.delete(room.evidence.keys().next().value);
      }
    }
    if(game.type==='death')death(session,game);
    const envelope={type:'game',version:2,senderId:session.playerId,slot:session.slot,message:game};
    if(target){if(write(target,envelope))relayedMessages++;}
    else broadcast(session.room,envelope,session);
    if(game.type==='leave')session.socket.end();
  }
  function finishRoom(room,reason,winnerIds){
    if(!room.started||room.ending)return;
    room.ending=true;clearTimeout(room.matchTimer);clearTimeout(room.roundTimer);rooms.delete(room.code);
    if(winnerIds===undefined){
      if(room.mode==='tdm'){
        const scores=room.roundWins,team=scores[0]===scores[1]?-1:scores[0]>scores[1]?0:1;
        winnerIds=room.clients.filter(c=>!c.closed&&c.team===team).map(c=>c.playerId);
      }else{
        const active=room.clients.filter(c=>!c.closed),best=Math.max(...active.map(c=>room.kills.get(c.playerId)||0));
        const leaders=active.filter(c=>(room.kills.get(c.playerId)||0)===best).map(c=>c.playerId);
        winnerIds=leaders.length===1?leaders:[];
      }
    }
    const result=db.finishMatch(room,reason,winnerIds);
    let returnLobby;
    if(room.returnLobby&&!closing&&room.clients.some(c=>!c.closed)){
      const next={id:crypto.randomUUID(),code:room.code,name:room.name,maxPlayers:room.maxPlayers,mode:room.mode,map:room.map,build:room.build,
        lobbyRevision:0,manualStart:true,returnLobby:true,killLimit:room.killLimit,roundWinLimit:room.roundWinLimit,timeLimitSeconds:room.timeLimitSeconds,
        clients:[],pending:new Map(),participants:new Map(),paid:new Set(),started:false,ending:false};
      rooms.set(next.code,next);returnLobby=roomInfo(next);
      const expiry=setTimeout(()=>{if(rooms.get(next.code)===next&&!next.started&&!next.clients.length&&!next.pending.size)rooms.delete(next.code);},600000);expiry.unref();
    }
    for(const client of room.clients){
      const profile=db.data.profiles[client.playerId];
      write(client,{type:'profile',version:2,profile:publicProfile(profile,client.character,client.account)});
      write(client,{type:'match-ended',version:2,result,...(returnLobby?{returnLobby}:{})});
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
      room.lobbyRevision++;
      if(room.clients.length===0)rooms.delete(room.code);
      else{
        room.clients.forEach((client,slot)=>{client.slot=slot;client.team=slot%2;});
        broadcast(room,lobbyInfo(room));
      }
      return;
    }
    if(closing){room.ending=true;clearTimeout(room.matchTimer);clearTimeout(room.roundTimer);rooms.delete(room.code);return;}
    const remaining=room.clients.filter(client=>!client.closed);
    room.clients=remaining;
    broadcast(room,{type:'peer-left',version:2,playerId:session.playerId,slot:session.slot});
    if(room.mode==='duel'||remaining.length===0||room.mode==='tdm'&&new Set(remaining.map(c=>c.team)).size<2)
      finishRoom(room,'forfeit',remaining.map(client=>client.playerId));
    else if(room.mode==='tdm'&&new Set(remaining.filter(c=>c.alive).map(c=>c.team)).size<2)endRound(room,'team-eliminated');
    log('room-ended',{roomCount:rooms.size,players:online.size});
  }
  async function authResult(result){
    if(!result.account)return result;
    const {account,...rest}=result,profile=db.ensure(account);
    await refreshCoins(account);
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
      if(serveClientRelease(request,response,route,path.join(directory,'client-release')))return;
      if(request.method==='GET'&&route==='/health'){
        reply(response,200,{ok:true,protocol:2,rooms:rooms.size,players:online.size,maxRooms,maxPlayersPerRoom:maxPlayers,
          nativeClientMaxPlayers:8,acceptedMessages,relayedMessages,uptimeSeconds:Math.floor(process.uptime())});return;
      }
      if(request.method==='GET'&&route==='/api/game-rules'){reply(response,200,{...GAME_RULES,hash:RULES_HASH});return;}
      if(request.method==='GET'&&route==='/api/auth-config'){
        reply(response,200,{emailVerificationRequired:auth.verificationRequired,registrationApprovalRequired:true,
          registrationAvailable:!auth.verificationRequired||auth.mailer.configured});return;
      }
      if(request.method==='POST'&&route.startsWith('/auth/')){
        const ip=request.socket.remoteAddress||'unknown';
        if(route==='/auth/register/request'){reply(response,200,await authResult(await auth.registerRequest(await body(request),ip)));return;}
        if(route==='/auth/register/verify'){reply(response,200,await authResult(await auth.registerVerify(await body(request),ip)));return;}
        if(route==='/auth/login'){reply(response,200,await authResult(await auth.login(await body(request),ip)));return;}
        if(route==='/auth/rules'){const updated=auth.acceptRules(bearer(request),await body(request));reply(response,200,{ok:true,profile:accountProfile(updated)});return;}
        if(route==='/auth/logout'){
          const token=bearer(request),account=auth.logout(token),client=online.get(account.playerId);
          if(client?.authToken===token)client.socket.destroy();
          reply(response,200,{ok:true});return;
        }
      }
      if(route.startsWith('/api/')){
        const account=auth.authenticate(bearer(request));
        if(request.method==='GET'&&route==='/api/conduct'){reply(response,200,conduct.summary(account.playerId));return;}
        if(request.method==='POST'&&route==='/api/conduct/appeal'){const input=await body(request);reply(response,200,conduct.appeal(input.id,account.playerId,input.text));return;}
        if(request.method==='POST'&&route==='/api/name'){
          if(online.has(account.playerId)||pendingPlayers.has(account.playerId))authError(409,'PLAYER_BUSY','방을 나온 뒤 게임 이름을 변경해 주세요.');
          const input=await body(request),updated=auth.rename(bearer(request),input.name);
          const profile=db.ensure(updated);reply(response,200,{ok:true,profile:publicProfile(profile,undefined,updated)});return;
        }
        if(request.method==='GET'&&route==='/api/rooms'){
          reply(response,200,{rooms:roomDirectory(account),serverTime:Date.now()});return;
        }
        if(request.method==='GET'&&route==='/api/me'){
          if(url.searchParams.get('wallet')!=='0')await refreshCoins(account);
          reply(response,200,{profile:accountProfile(account),activity:db.data.activity.filter(item=>
            item.playerIds?.includes(account.playerId)||item.targetId===account.playerId).slice(-30).reverse(),
            catalog:{characters:catalog.characters,weapons:catalog.weapons,ranks:catalog.ranks,slots:catalog.slots,
              classes:catalog.classes,constraints:catalog.constraints,progressionVersion:3,
              mastery:{curriculum:ATTACK_CURRICULUM,techniques:TECHNIQUES,promotions:promotions.rules,policy:promotions.status(),families:FAMILY_NAMES,perOpponentMatchCap:3}}});return;
        }
        if(request.method==='GET'&&route==='/api/leaderboard'){
          const disabled=new Set(auth.list().filter(item=>item.disabled||item.approvalStatus!=='approved').map(item=>item.playerId));
          const players=Object.values(db.data.profiles).filter(item=>!disabled.has(item.playerId))
            .sort((a,b)=>b.xp-a.xp||b.kills-a.kills||a.playerId.localeCompare(b.playerId))
            .slice(0,200).map(item=>{
              const {loadouts,...entry}=publicProfile(item);return entry;
            });
          const categoryRankings=Object.fromEntries(Object.keys(FAMILY_NAMES).map(family=>[family,
            Object.values(db.data.profiles).filter(item=>!disabled.has(item.playerId)).map(item=>{
              const mastery=masteryProgress(item);
              const techniques=mastery.techniques.filter(t=>t.family===family);
              return {playerId:item.playerId,name:item.name,qualified:techniques.reduce((sum,t)=>sum+t.qualified,0),successes:techniques.reduce((sum,t)=>sum+t.successes,0),diversity:techniques.filter(t=>t.qualified>0).length};
            }).filter(item=>item.qualified>0).sort((a,b)=>b.qualified-a.qualified||b.diversity-a.diversity||a.playerId.localeCompare(b.playerId)).slice(0,200)
          ]));
          reply(response,200,{players,categoryRankings});return;
        }
        if(request.method==='GET'&&route==='/api/dashboard'){
          const roomList=[...rooms.values()].map(room=>({...roomInfo(room),started:room.started,
            elapsedSeconds:room.started?Math.floor((Date.now()-room.startedAt)/1000):0,
            players:room.clients.filter(c=>!c.closed).map(client=>({playerId:client.playerId,name:client.account.name,team:client.team,kills:room.kills?.get(client.playerId)||0}))}));
          reply(response,200,{summary:{registeredUsers:auth.list().length,onlinePlayers:online.size,rooms:rooms.size,totalMatches:Object.keys(db.data.matches).length},
            rooms:roomList,activity:db.data.activity.slice(-50).reverse(),promotionPolicy:promotions.status()});return;
        }
        if(route.startsWith('/api/admin/')){
          if(account.role!=='admin')authError(403,'ADMIN_REQUIRED','관리자 권한이 필요합니다.');
          if(request.method==='GET'&&route==='/api/admin/promotion-policy'){reply(response,200,promotions.status());return;}
          if(request.method==='PATCH'&&route==='/api/admin/promotion-policy'){
            const input=await body(request);
            if(Object.keys(input).length!==1||typeof input.enabled!=='boolean')authError(400,'BAD_UPDATE','자동 조정 여부만 변경할 수 있습니다.');
            promotions.setEnabled(input.enabled,account.playerId);db.flush();reply(response,200,promotions.status());return;
          }
          if(request.method==='GET'&&route==='/api/admin/conduct'){reply(response,200,{cases:conduct.data.cases.slice().reverse(),rules:GAME_RULES});return;}
          if(request.method==='POST'&&route==='/api/admin/conduct'){
            if(!exchange)authError(503,'EXCHANGE_UNAVAILABLE','거래소 연결이 필요합니다.');
            const input=await body(request),target=auth.list().find(a=>a.playerId===input.playerId);
            if(!target)authError(404,'USER_NOT_FOUND','사용자를 찾을 수 없습니다.');
            if(!rulesAccepted(target))authError(409,'RULES_REQUIRED','대상자가 규정에 동의한 뒤 발생한 사건에 적용해 주세요.');
            if(!Number.isSafeInteger(input.occurredAt)||input.occurredAt<target.rulesAcceptance.acceptedAt)authError(400,'RULES_NOT_EFFECTIVE','현 규정에 동의한 이후의 위반 발생 시간을 입력해 주세요.');
            await exchange.wallet(coinIdentity(account));await exchange.wallet(coinIdentity(target));
            const item=conduct.create(account.playerId,input);online.get(target.playerId)?.socket.destroy();
            const result=await conduct.settle(item.id,exchange.request);await refreshCoins(target);
            db.activity('conduct-applied',{actorId:account.playerId,targetId:target.playerId,caseId:item.id});reply(response,200,{ok:true,case:result});return;
          }
          if(request.method==='POST'&&route==='/api/admin/conduct/revoke'){
            if(!exchange)authError(503,'EXCHANGE_UNAVAILABLE','거래소 연결이 필요합니다.');
            const input=await body(request),existing=conduct.data.cases.find(c=>c.id===input.id);
            if(existing?.playerId===account.playerId)authError(403,'CONFLICT_OF_INTEREST','본인 제재의 취소는 다른 관리자가 처리해야 합니다.');
            const item=conduct.revoke(input.id,account.playerId,input.reason);
            const result=await conduct.settle(item.id,exchange.request);reply(response,200,{ok:true,case:result});return;
          }
          if(request.method==='POST'&&route==='/api/admin/coins/reset'){
            if(!exchange)authError(503,'EXCHANGE_UNAVAILABLE','거래소 연결이 필요합니다.');
            const input=await body(request),target=auth.list().find(a=>a.playerId===input.playerId);
            if(!target)authError(404,'USER_NOT_FOUND','사용자를 찾을 수 없습니다.');
            if(online.has(target.playerId)||pendingPlayers.has(target.playerId))authError(409,'PLAYER_ACTIVE','방을 나온 뒤 코인을 리셋해 주세요.');
            if(conduct.summary(target.playerId).active)authError(409,'ACCOUNT_RESTRICTED','제재 중에는 리셋할 수 없습니다.');
            await exchange.wallet(coinIdentity(account));await exchange.wallet(coinIdentity(target));
            const result=await exchange.request('reset',{actor:account.playerId,key:input.key,payload:{playerId:target.playerId,reason:input.reason}});
            await refreshCoins(target);reply(response,200,result);return;
          }
          if(request.method==='GET'&&route==='/api/admin/maps'){reply(response,200,{maps:mapAccess.list(),audit:mapAccess.data.audit.slice(-50).reverse()});return;}
          if(request.method==='POST'&&route==='/api/admin/maps'){
            const input=await body(request);let map;try{map=mapAccess.set(input.mapIndex,input.open,account.playerId);}catch(error){authError(400,'BAD_MAP_ACCESS',error.message);}
            reply(response,200,{ok:true,map});return;
          }
          if(request.method==='GET'&&route==='/api/admin/fairplay'){
            reply(response,200,{cases:fairplay.data.cases.slice().reverse().map(c=>({...c,name:db.data.profiles[c.playerId]?.name||c.playerId,otherName:db.data.profiles[c.otherPlayerId]?.name||c.otherPlayerId}))});return;
          }
          if(request.method==='POST'&&route==='/api/admin/fairplay/release'){
            const input=await body(request),item=fairplay.release(input.id,account.playerId,input.note);
            if(!item)authError(404,'CASE_NOT_FOUND','탐지 기록을 찾을 수 없습니다.');
            db.activity('fairplay-released',{targetId:item.playerId,caseId:item.id,actorId:account.playerId});reply(response,200,{ok:true});return;
          }
          if(request.method==='GET'&&route==='/api/admin/chat-logs'){
            reply(response,200,chatArchive.read({day:url.searchParams.get('day')||undefined,cursor:url.searchParams.get('cursor')??undefined,
              limit:url.searchParams.has('limit')?Number(url.searchParams.get('limit')):100,channel:url.searchParams.get('channel')||'',
              room:url.searchParams.get('room')||'',sender:url.searchParams.get('sender')||'',moderatedOnly:url.searchParams.get('moderated')==='1'}));return;
          }
          if(request.method==='GET'&&route==='/api/admin/users'){
            reply(response,200,{users:auth.list().map(item=>({...accountProfile(item),email:item.email,disabled:item.disabled,
              approvalStatus:item.approvalStatus,createdAt:item.createdAt,approvedAt:item.approvedAt??null}))});return;
          }
          const match=route.match(/^\/api\/admin\/users\/([a-zA-Z0-9_.:-]{1,96})$/);
          if(request.method==='PATCH'&&match){
            const playerId=match[1],target=auth.list().find(item=>item.playerId===playerId);
            if(!target)authError(404,'USER_NOT_FOUND','사용자를 찾을 수 없습니다.');
            const update=await body(request);
            if(update.approvalStatus!==undefined){
              if(Object.keys(update).length!==1||update.approvalStatus!=='approved')authError(400,'BAD_APPROVAL','가입 승인은 별도로 요청해 주세요.');
              const approved=auth.approve(playerId,account.playerId);
              if(target.approvalStatus==='pending'){
                db.activity('admin-user-approved',{actorId:account.playerId,targetId:playerId});db.flush();
              }
              reply(response,200,{ok:true,approvalStatus:approved.approvalStatus});return;
            }
            const allowed=['disabled','xp','kills','deaths','wins','losses','draws','matches','loadouts'];
            if(!Object.keys(update).length||Object.keys(update).some(key=>!allowed.includes(key)))authError(400,'BAD_UPDATE','수정할 수 없는 필드입니다.');
            if(online.has(playerId)&&Object.keys(update).some(key=>key!=='disabled'))authError(409,'PLAYER_ACTIVE','대전 종료 후 전적이나 장비를 수정해 주세요.');
            // Validate a detached candidate so a failed request cannot partially
            // mutate the live profile (including an XP reduction).
            const profile=clone(db.ensure(target));
            for(const key of ['xp','kills','deaths','wins','losses','draws','matches']){
              if(update[key]!==undefined)profile[key]=integer(update[key],key,0,Number.MAX_SAFE_INTEGER);
            }
            const sum=(profile.wins||0)+(profile.losses||0)+(profile.draws||0);
            if(update.matches!==undefined&&update.matches!==sum)authError(400,'BAD_COUNTERS','경기 수는 승·패·무 합계와 같아야 합니다.');
            profile.matches=sum;
            if(update.loadouts!==undefined||update.xp!==undefined){
              if(update.loadouts!==undefined&&!plainObject(update.loadouts))authError(400,'BAD_LOADOUT','장비 설정이 올바르지 않습니다.');
              const loadouts={};
              for(const [characterId,selection] of Object.entries(update.loadouts??profile.loadouts??{})){
                const character=catalog.characters[characterId];
                try{
                  if(!character||!plainObject(selection))authError(400,'BAD_LOADOUT','캐릭터 장비 설정을 확인해 주세요.');
                  const valid=validateLoadout({...selection,xp:rankXpForProfile(profile),character,weapons:catalog.weapons,ranks:catalog.ranks,
                    slotRules:catalog.slots,constraints:catalog.constraints});
                  loadouts[characterId]={inventory:valid.inventory,selectedWeapon:valid.selectedWeapon};
                }catch(problem){
                  // Explicitly supplied equipment must be valid. On an XP-only
                  // downgrade, forget now-locked saved builds; never grant them.
                  if(update.loadouts!==undefined)throw problem;
                }
              }
              profile.loadouts=loadouts;
            }
            if(update.disabled!==undefined){
              if(typeof update.disabled!=='boolean')authError(400,'BAD_UPDATE','disabled는 참 또는 거짓이어야 합니다.');
              if(target.playerId===account.playerId&&update.disabled)authError(400,'SELF_DISABLE','현재 관리자 계정은 사용 중지할 수 없습니다.');
              auth.setDisabled(playerId,update.disabled);
              if(update.disabled)online.get(playerId)?.socket.destroy();
            }
            if(['xp','kills','deaths','wins','losses','draws','matches'].some(k=>update[k]!==undefined))promotions.exclude(playerId);
            promotions.remember(profile);db.data.profiles[playerId]=profile;
            db.activity('admin-user-update',{actorId:account.playerId,targetId:playerId,fields:Object.keys(update)});db.flush();
            reply(response,200,{ok:true,profile:publicProfile(profile,undefined,target)});return;
          }
        }
        authError(404,'NOT_FOUND','요청한 API를 찾을 수 없습니다.');
      }
      if(request.method==='GET'){
        const files={'/':'index.html','/index.html':'index.html','/app.js':'app.js','/policy.js':'policy.js','/style.css':'style.css'};
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
  log('server-started',{port:server.address().port,healthPort:health.address().port,maxRooms,maxPlayers,nativeClientMaxPlayers:8});
  const authTimer=setInterval(()=>{
    try{
      const data=auth.read();
      for(const client of online.values())try{auth.authenticate(client.authToken,data);if(conduct.summary(client.playerId).active)client.socket.destroy();}catch{client.socket.destroy();}
    }catch{for(const client of online.values())client.socket.destroy();}
  },5000);authTimer.unref();
  const conductTimer=setInterval(()=>{if(exchange)for(const c of conduct.data.cases.filter(c=>['pending','revoking'].includes(c.state)))conduct.settle(c.id,exchange.request).catch(()=>log('conduct-settlement-pending',{caseId:c.id}));},10000);conductTimer.unref();
  const promotionTimer=setInterval(()=>{try{if(promotions.review())db.flush();}catch(e){log('promotion-review-error',{message:e.message});}},60000);promotionTimer.unref();
  const lobbyPingTimer=setInterval(()=>{
    for(const room of rooms.values()){
      if(room.started||room.ending)continue;
      for(const client of room.clients)probeLobby(client);
      const summary=JSON.stringify(room.clients.map(c=>[c.playerId,c.lobbyPing?.snapshot()||null]));
      if(room.clients.some(c=>c.lobbyPing)&&summary!==room.lastPingSummary){
        room.lastPingSummary=summary;broadcast(room,{...lobbyInfo(room),latencyOnly:true});
      }
    }
  },1000);lobbyPingTimer.unref();
  return {
    port:server.address().port,healthPort:health.address().port,auth,
    stats:()=>({rooms:rooms.size,players:online.size,acceptedMessages,relayedMessages}),
    async close(){
      if(closing)return;closing=true;clearInterval(authTimer);clearInterval(conductTimer);clearInterval(promotionTimer);clearInterval(lobbyPingTimer);
      for(const room of rooms.values()){clearTimeout(room.matchTimer);clearTimeout(room.roundTimer);}
      for(const socket of sockets)socket.destroy();
      await Promise.allSettled([...admissions]);
      await Promise.all([new Promise(resolve=>server.close(resolve)),new Promise(resolve=>health.close(resolve))]);
    },
  };
}

if(process.argv[1]&&path.resolve(process.argv[1])===fileURLToPath(import.meta.url)){
  const dataDir=process.env.KARMA_DATA_DIR||path.join(directory,'data');
  const exchange=process.env.KARMA_EXCHANGE_URL?createExchangeClient({url:process.env.KARMA_EXCHANGE_URL,
    address:process.env.KARMA_EXCHANGE_ADDRESS,caFile:process.env.KARMA_EXCHANGE_CA,
    keyFile:process.env.KARMA_EXCHANGE_KEY_FILE,dataDir}):null;
  if(exchange)await exchange.init();
  const instance=await startKarmaServer({exchange,
    host:process.env.KARMA_HOST||'0.0.0.0',
    port:Number(process.env.KARMA_PORT||29020),
    healthHost:process.env.KARMA_HEALTH_HOST||process.env.KARMA_HOST||'0.0.0.0',
    healthPort:Number(process.env.KARMA_HEALTH_PORT||29021),
    dataDir:process.env.KARMA_DATA_DIR||path.join(directory,'data'),
  });
  let stopping=false;
  const stop=async()=>{if(stopping)return;stopping=true;await instance.close();exchange?.close();};
  process.on('SIGINT',stop);process.on('SIGTERM',stop);
}
