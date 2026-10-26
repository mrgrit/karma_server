import {validateRules,GAME_RULES} from './rules.mjs';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import {CombatLedger,newProgressProfile,applyDeathToProfile,FileProgressStore} from './progression.mjs';
import {newMastery,masteryProgress,rankXpForProfile,TECHNIQUES,PROMOTIONS} from './mastery.mjs';
import {startKarmaServer} from './server.mjs';
import {AuthService} from './auth.mjs';

const temp=fs.mkdtempSync(path.join(os.tmpdir(),'karma-mastery-'));
function receipt(match,life,weapon=9,verified=true){
 const ledger=new CombatLedger({matchId:match,playerIds:['attacker','victim']});
 if(verified)ledger.recordDamage('victim',{id:'damage',victimId:'victim',victimLife:life,attackerId:'attacker',attackerLife:1,weapon,before:10,after:0});
 return ledger.confirmDeath('victim',{life,killer:'remote',weapon,damageId:verified?'damage':null,hpAfter:0}).receipt;
}
try{
 const profile=newProgressProfile('attacker');profile.xp=10000;
 assert.equal(rankXpForProfile(profile),0,'XP alone must not promote');
 assert.equal(TECHNIQUES.length,23);assert.equal(new Set(TECHNIQUES.map(t=>t.weaponId)).size,23);
 let p=profile;
 for(let life=1;life<=5;life++)p=applyDeathToProfile(p,receipt('match1',life)).profile;
 assert.equal(p.mastery.successes[9],5);assert.equal(p.mastery.qualified[9],3);
 assert.equal(p.xp,10125,'cap does not reduce XP');
 assert.deepEqual(applyDeathToProfile(p,receipt('match1',5)).profile,p,'receipt replay is idempotent');
 p=JSON.parse(JSON.stringify(p));
 p=applyDeathToProfile(p,receipt('match1',6)).profile;
 assert.equal(p.mastery.qualified[9],3,'cap survives serialization/reconnect');
 p=applyDeathToProfile(p,receipt('match2',1)).profile;
 assert.equal(p.mastery.qualified[9],4,'new match has independent cap');
 const before=structuredClone(p.mastery);
 p=applyDeathToProfile(p,receipt('match2',2,9,false)).profile;
 assert.deepEqual(p.mastery,before,'unverified deaths do not teach techniques');
 const victim=applyDeathToProfile(newProgressProfile('victim'),receipt('match3',1)).profile;
 assert.deepEqual(victim.mastery.qualified,{},'victim receives no attack credit');
 for(const rule of PROMOTIONS.slice(1)){
  const q=newProgressProfile('threshold');q.xp=rule.minXp;
  // Include three families, satisfying each cumulative threshold exactly or above.
  const ids=[9,14,16,1,3,7,10,17,18,21,...TECHNIQUES.map(t=>t.weaponId).filter(id=>![9,14,16,1,3,7,10,17,18,21].includes(id))].slice(0,rule.techniques);
  q.promotionExperience={matches:rule.matches,activeSeconds:rule.activeMinutes*60,
   opponents:Object.fromEntries(Array.from({length:rule.opponents},(_,i)=>['p'+i,true])),
   maps:Object.fromEntries(Array.from({length:rule.maps},(_,i)=>[i,true])),
   days:Object.fromEntries(Array.from({length:rule.activeDays},(_,i)=>['day'+i,true]))};
  for(const id of ids)q.mastery.successes[id]=q.mastery.qualified[id]=rule.each;
  for(const [id,family] of [[9,'mobile'],[16,'heavy'],[1,'special']]){
   const total=masteryProgress(q).families[family];
   if(total<rule[family])q.mastery.successes[id]=q.mastery.qualified[id]=(q.mastery.qualified[id]??0)+rule[family]-total;
  }
  assert.equal(rankXpForProfile(q),rule.minXp,'all requirements promote');
  q.xp--;assert(rankXpForProfile(q)<rule.minXp,'XP threshold enforced');q.xp++;
  q.mastery.qualified[9]=0;assert(rankXpForProfile(q)<rule.minXp,'diversity/family requirement enforced');
 }
 fs.writeFileSync(path.join(temp,'single.json'),JSON.stringify(newProgressProfile('attacker')));
 const store=new FileProgressStore(path.join(temp,'single.json'));
 store.applyDeath(receipt('persistent',1,5));
 const reopened=new FileProgressStore(path.join(temp,'single.json'));
 assert.equal(reopened.read().mastery.qualified[5],1);
 reopened.applyDeath(receipt('persistent',1,5));assert.equal(reopened.read().mastery.qualified[5],1);

 // Actual database startup performs a single backed-up legacy migration.
 const legacy=newProgressProfile('legacy');legacy.xp=6000;delete legacy.mastery;
 fs.writeFileSync(path.join(temp,'profiles.json'),JSON.stringify({version:1,profiles:{legacy},matches:{},activity:[]}));
 let server=await startKarmaServer({host:'127.0.0.1',port:0,healthPort:0,dataDir:temp,logger:()=>{}});
 await server.close();
 let saved=JSON.parse(fs.readFileSync(path.join(temp,'profiles.json'))).profiles.legacy;
 assert.equal(rankXpForProfile(saved),6000);assert.deepEqual(saved.mastery.successes,{});
 saved.xp=10000;assert.equal(rankXpForProfile(saved),6000,'legacy rank does not grant future promotions');
 assert.equal(fs.readdirSync(temp).filter(n=>n.includes('pre-mastery')).length,1);
 server=await startKarmaServer({host:'127.0.0.1',port:0,healthPort:0,dataDir:temp,logger:()=>{}});
 await server.close();assert.equal(fs.readdirSync(temp).filter(n=>n.includes('pre-mastery')).length,1,'migration is one-time');
 const auth=new AuthService({filename:path.join(temp,'auth.json')});
 const earned=await auth.createAccount({rulesAcceptance:validateRules({rulesAccepted:true,rulesVersion:GAME_RULES.version}),email:'earned@example.test',password:'test-fixture-password',name:'실습 완료',playerId:'earned'});
 const qualified={...newProgressProfile(earned.playerId),name:earned.name,xp:6000};
 for(const [id,n] of [[9,25],[14,5],[16,7],[17,5],[1,5],[5,5],[6,5]])qualified.mastery.successes[id]=qualified.mastery.qualified[id]=n;
 const db=JSON.parse(fs.readFileSync(path.join(temp,'profiles.json')));db.profiles.earned=qualified;
 fs.writeFileSync(path.join(temp,'profiles.json'),JSON.stringify(db));
 server=await startKarmaServer({host:'127.0.0.1',port:0,healthPort:0,dataDir:temp,authService:auth,logger:()=>{}});
 try{
  const me=await fetch(`http://127.0.0.1:${server.healthPort}/api/me`,{headers:{Authorization:'Bearer '+auth.issueSession(earned).authToken}}).then(r=>r.json());
  assert.equal(me.profile.rank.id,'sergeant');assert.equal(me.profile.rank.budgetBonus,300);
  assert.equal(me.profile.dualCannonUnlocked,true);assert.equal(me.profile.mastery.next.minXp,10000);
  assert.equal(me.profile.mastery.techniques.find(t=>t.weaponId===9).qualified,25);
 }finally{await server.close();}
 console.log('PASS mastery: 23 stable techniques; all promotion boundaries; XP-only rejection; verified/idempotent counts; opponent cap, serialization and disk persistence; backed-up legacy migration and future-rank gating.');
}finally{fs.rmSync(temp,{recursive:true,force:true});}
