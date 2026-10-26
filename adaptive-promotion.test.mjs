import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import {AdaptivePromotions,koreaDay,koreaWeek,validateExperience} from './adaptive-promotion.mjs';
import {RANKS,PROMOTION_BASELINES} from './rank-policy.mjs';
import {newProgressProfile} from './progression.mjs';
import {newMastery,masteryProgress,TECHNIQUES} from './mastery.mjs';
import {AuthService} from './auth.mjs';
import {startKarmaServer} from './server.mjs';
import {GAME_RULES,validateRules} from './rules.mjs';
const DAY=86400000,start=Date.parse('2026-10-26T00:00:00+09:00');let now=start;
const profile=id=>({...newProgressProfile(id),name:id});
const db=()=>({profiles:Object.fromEntries(Array.from({length:8},(_,i)=>['p'+i,profile('p'+i)]))});
assert.equal(RANKS.length,14);assert.equal(newMastery(999999).legacyRankXp,10000,'migration cannot grant new officer ranks from XP');
assert.equal(koreaDay(start-1),'2026-10-25');assert.equal(koreaDay(start),'2026-10-26');
assert.equal(koreaWeek(start-1),start-7*DAY);assert.equal(koreaWeek(start+6*DAY),start);
assert.throws(()=>validateExperience({matches:-1}),/Invalid/);
let data=db(),blocked=new Set(),policy=new AdaptivePromotions(data,{now:()=>now,eligible:id=>!blocked.has(id),canPromote:id=>!blocked.has(id)});
assert(policy.review());assert.equal(policy.state.pending,null);assert.equal(policy.state.history.at(-1).type,'insufficient');assert.equal(policy.review(),false);
const makeRoom=(id='match',reason='time-limit')=>({result:{id,reason,players:['p0','p1'],map:0,startedAt:now-180000,endedAt:now,scores:{p0:1,p1:1},deaths:{p0:1,p1:1}},
 room:{phase:'active',combat:{deaths:new Map([['a',{verified:true,killerId:'p0',victimId:'p1'}]])}}});
function prepare(id,reason){const v=makeRoom(id,reason);for(const playerId of v.result.players){policy.start(v.room,{playerId});v.room.promotionPlayers.get(playerId).activeMs=150000;data.profiles[playerId].xp+=30;}return v;}
let {room,result}=prepare('one');policy.observe(result,room);
assert.equal(data.profiles.p0.promotionExperience.matches,1);assert.equal(data.profiles.p0.promotionExperience.activeSeconds,150);
policy.observe(result,room);assert.equal(data.profiles.p0.promotionExperience.matches,1,'match replay cannot credit twice');
({room,result}=prepare('abort','peer-disconnected'));policy.observe(result,room);assert.equal(result.promotionQualified,false);
blocked.add('p1');({room,result}=prepare('admin'));policy.observe(result,room);assert.equal(result.promotionQualified,false);blocked.clear();
({room,result}=prepare('afk'));room.promotionPlayers.get('p1').activeMs=1;policy.observe(result,room);assert.equal(result.promotionQualified,false);
({room,result}=prepare('no-proof'));room.combat.deaths.clear();policy.observe(result,room);assert.equal(result.promotionQualified,false);
for(let i=0;i<10;i++){({room,result}=prepare('daily'+i));policy.observe(result,room);}
assert.equal(policy.state.buckets.filter(b=>b.playerId==='p0').reduce((n,b)=>n+b.matches,0),6,'daily sample cap');
assert.equal(data.profiles.p0.promotionExperience.matches,11,'sample cap does not erase actual clean career experience');
policy.exclude('p0');assert.equal(policy.state.buckets.filter(b=>b.playerId==='p0').length,0);assert.equal(policy.clean('p0'),false);
// Validated state time: no idle, dead, paused, reconnect, respawn or packet burst time.
({room,result}=makeRoom('activity'));policy.start(room,{playerId:'p0'});
let game={life:1,hp:100,pos:[0,0,0]};policy.track(room,{playerId:'p0'},game);
now+=500;policy.track(room,{playerId:'p0'},game);assert.equal(room.promotionPlayers.get('p0').activeMs,0);
now+=500;game.pos=[50,0,0];policy.track(room,{playerId:'p0'},game);assert.equal(room.promotionPlayers.get('p0').activeMs,500);
now+=500;game.paused=true;policy.track(room,{playerId:'p0'},game);assert.equal(room.promotionPlayers.get('p0').activeMs,500);
now+=30000;game.paused=false;game.pos=[100,0,0];policy.track(room,{playerId:'p0'},game);assert.equal(room.promotionPlayers.get('p0').activeMs,500);
now+=500;game.hp=0;policy.track(room,{playerId:'p0'},game);assert.equal(room.promotionPlayers.get('p0').activeMs,500);
policy.start(room,{playerId:'p0'});now+=500;game.hp=100;policy.track(room,{playerId:'p0'},game);assert.equal(room.promotionPlayers.get('p0').activeMs,500);

// Equal player weighting, minimum cohort, notice, bounded changes and persistence.
now=start;data=db();policy=new AdaptivePromotions(data,{now:()=>now});
function cohort(fast=false){
 policy.state.buckets=Array.from({length:8},(_,i)=>({playerId:'p'+i,day:koreaDay(now),at:now,target:18000,seconds:3600,matches:5,
  xp:fast?50000:500,qualified:fast?2000:10,mobile:fast?1000:5,heavy:fast?500:2,special:fast?500:1,
  opponents:{pA:true,pB:true,pC:true},maps:{0:true,1:true},matchIds:Array.from({length:5},(_,j)=>'r'+i+'-'+j)}));
}
now=start+14*DAY;cohort();policy.review();assert(policy.state.pending);assert.equal(policy.rules[5].requiredXp,18000);
assert.equal(policy.state.pending.rules[5].requiredXp,16200);assert.equal(policy.state.pending.effectiveAt,now+DAY);
const publicJson=JSON.stringify(policy.status());assert(!publicJson.includes('playerId'));assert(!publicJson.includes('pA'));
const snapshot=JSON.parse(JSON.stringify(data));policy=new AdaptivePromotions(snapshot,{now:()=>now});
now+=DAY-1;policy.review();assert.equal(policy.state.active.version,1);now++;policy.review();assert.equal(policy.state.active.version,2);assert.equal(policy.rules[5].requiredXp,16200);
policy.review();assert.equal(policy.state.active.version,2,'pending applies once');
const earned=profile('earned'),r=policy.rules[5];earned.xp=r.requiredXp;earned.mastery.legacyRankXp=10000;
for(const t of TECHNIQUES)earned.mastery.successes[t.weaponId]=earned.mastery.qualified[t.weaponId]=100;
earned.promotionExperience={matches:15,activeSeconds:7200,opponents:{a:true,b:true,c:true},maps:{0:true,1:true},days:{a:true,b:true,c:true}};
policy.remember(earned);assert.equal(earned.mastery.earnedRankXp,18000);
assert.equal(masteryProgress(earned,PROMOTION_BASELINES).rankXp,18000,'harder policy cannot demote earned rank');
const noExperience=structuredClone(earned);noExperience.mastery.earnedRankXp=0;delete noExperience.promotionExperience;assert.equal(masteryProgress(noExperience).rankXp,10000);
for(let w=3;w<12;w++){now=start+w*7*DAY;cohort();for(const b of policy.state.buckets)Object.assign(b,{xp:1,qualified:1,mobile:1,heavy:1,special:1});policy.review();now+=DAY;policy.review();}
assert.equal(policy.rules[5].requiredXp,12600,'cumulative ease limited to -30%');
const unchanged=copyRules(policy);now=start+12*7*DAY;cohort(true);policy.review();
for(const [i,r] of (policy.state.pending?.rules||policy.rules).entries())for(const k of ['requiredXp','each','mobile','heavy','special'])if(i>=5){assert(r[k]<=Math.floor(unchanged[i][k]*1.1));assert(r[k]>=Math.ceil(unchanged[i][k]*.9));}
policy.setEnabled(false,'admin');assert.equal(policy.state.pending,null);const version=policy.state.active.version;now+=30*DAY;policy.review();assert.equal(policy.state.active.version,version);
function copyRules(p){return structuredClone(p.rules);}
// One high-volume player cannot override the other seven players' slow rate.
now=start;data=db();policy=new AdaptivePromotions(data,{now:()=>now});now+=14*DAY;cohort();
Object.assign(policy.state.buckets[0],{xp:100000000,qualified:100000,mobile:100000,heavy:100000,special:100000});policy.review();assert(policy.state.pending.rules[5].requiredXp<18000);
now=start;data=db();policy=new AdaptivePromotions(data,{now:()=>now});now+=14*DAY;cohort();policy.state.buckets[0].target=30000;policy.state.buckets[1].target=30000;policy.state.buckets[2].target=30000;policy.review();assert.equal(policy.state.pending,null,'per-rank sample minimum');

const dir=fs.mkdtempSync(path.join(os.tmpdir(),'karma-adaptive-http-'));
try{
 const auth=new AuthService({filename:path.join(dir,'auth.json')});
 const params={password:'fixture-password-only',rulesAcceptance:validateRules({rulesAccepted:true,rulesVersion:GAME_RULES.version})};
 const admin=await auth.createAccount({...params,email:'admin@example.test',name:'Admin',role:'admin'}),user=await auth.createAccount({...params,email:'user@example.test',name:'User'});
 const server=await startKarmaServer({host:'127.0.0.1',port:0,healthPort:0,dataDir:dir,authService:auth,logger:()=>{}});
 try{
  const endpoint=`http://127.0.0.1:${server.healthPort}`,token=a=>({Authorization:'Bearer '+auth.issueSession(a).authToken,'Content-Type':'application/json'});
  assert.equal((await fetch(endpoint+'/api/admin/promotion-policy',{headers:token(user)})).status,403);
  assert.equal((await fetch(endpoint+'/api/admin/promotion-policy',{method:'PATCH',headers:token(admin),body:JSON.stringify({enabled:false,requiredXp:1})})).status,400);
  let response=await fetch(endpoint+'/api/admin/promotion-policy',{method:'PATCH',headers:token(admin),body:'{"enabled":false}'});assert.equal(response.status,200);assert.equal((await response.json()).enabled,false);
  const me=await fetch(endpoint+'/api/me',{headers:token(user)}).then(r=>r.json());assert.equal(me.catalog.ranks.length,14);assert.equal(me.catalog.mastery.policy.enabled,false);assert.equal(me.catalog.mastery.promotions[5].requiredXp,18000);
 }finally{await server.close();}
 assert.equal(JSON.parse(fs.readFileSync(path.join(dir,'profiles.json'))).promotionPolicy.enabled,false);
}finally{fs.rmSync(dir,{recursive:true,force:true});}
console.log('PASS adaptive promotions: 14 ranks, protected earned ranks, clean activity, proof-only matches, sample caps, exclusion, weekly robust calibration, 24h notice, bounded changes, restart idempotency, admin authorization and effective catalog.');
