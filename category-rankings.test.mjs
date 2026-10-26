import {validateRules,GAME_RULES} from './rules.mjs';
import assert from 'node:assert/strict';
import fs from 'node:fs';import os from 'node:os';import path from 'node:path';import crypto from 'node:crypto';
import {startKarmaServer} from './server.mjs';import {newMastery} from './mastery.mjs';
const temp=fs.mkdtempSync(path.join(os.tmpdir(),'karma-category-'));
let server;const options={host:'127.0.0.1',port:0,healthPort:0,dataDir:temp,logger:()=>{}};
try{
 server=await startKarmaServer(options);const users=[];
 for(let i=0;i<3;i++){
  const account=await server.auth.createAccount({rulesAcceptance:validateRules({rulesAccepted:true,rulesVersion:GAME_RULES.version}),email:`rank${i}@test.invalid`,password:crypto.randomUUID(),name:`플레이어${i}`});
  const token=server.auth.issueSession(account).authToken;users.push({account,token});
  await fetch(`http://127.0.0.1:${server.healthPort}/api/me`,{headers:{Authorization:'Bearer '+token}});
 }
 await server.close();server=null;
 const filename=path.join(temp,'profiles.json'),data=JSON.parse(fs.readFileSync(filename,'utf8'));
 users.forEach(({account},i)=>{
  const p=data.profiles[account.playerId];p.xp=i===0?50000:0;p.mastery=newMastery(p.xp);
  p.mastery.successes={'9':[20,8,8][i]};p.mastery.qualified={'9':[2,8,8][i]};
  if(i===2){p.mastery.successes['10']=1;p.mastery.qualified['10']=1;p.mastery.qualified['9']=7;}
 });
 fs.writeFileSync(filename,JSON.stringify(data));server=await startKarmaServer(options);
 const response=await fetch(`http://127.0.0.1:${server.healthPort}/api/leaderboard`,{headers:{Authorization:'Bearer '+users[0].token}});
 assert.equal(response.status,200);const result=await response.json();
 assert.deepEqual(result.categoryRankings.mobile.map(p=>p.playerId),[users[2],users[1],users[0]].map(u=>u.account.playerId));
 assert.equal(result.categoryRankings.mobile[2].successes,20);
 assert.equal(result.categoryRankings.mobile[2].qualified,2);
 assert.deepEqual(result.categoryRankings.precision,[]);
 assert(!JSON.stringify(result.categoryRankings).includes('@test.invalid'));
 console.log('PASS category rankings: qualified counts before XP/raw totals, diversity tie break, independent categories, persisted records and no email exposure');
}finally{if(server)await server.close();fs.rmSync(temp,{recursive:true,force:true});}
