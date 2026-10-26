import assert from 'node:assert/strict';
import crypto from 'node:crypto';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import net from 'node:net';
import {Conduct} from './conduct.mjs';
import {GAME_RULES,RULES_HASH,validateRules,rulesAccepted} from './rules.mjs';
import {startKarmaServer} from './server.mjs';
import {AuthService} from './auth.mjs';
const root=fs.mkdtempSync(path.join(os.tmpdir(),'karma-conduct-')),uid=()=>crypto.randomUUID();
const accepted={rulesAccepted:true,rulesVersion:GAME_RULES.version};
const sockets=[];let server;
try{
 for(const invalid of [{},{...accepted,rulesAccepted:false},{...accepted,rulesAccepted:'true'},{...accepted,rulesVersion:'old'}])assert.throws(()=>validateRules(invalid),e=>e.code==='RULES_REQUIRED');
 assert.equal(validateRules(accepted).hash,RULES_HASH);
 let clock=Date.now();const actor=uid(),student=uid();let c=new Conduct(path.join(root,'unit.json'),()=>clock);
 const input={id:uid(),playerId:student,violation:'chat',level:2,adjustment:'반복 위반 기록 확인',reason:'검토한 반복 욕설',evidence:'검증된 채팅 기록 번호',confirmed:true,occurredAt:clock};
 // Use actual catalog identifier so test remains explicit if taxonomy is renamed.
 input.violation=GAME_RULES.violations[0].id;
 assert.throws(()=>c.create(actor,{...input,confirmed:false}));
 assert.throws(()=>c.create(student,input));
 let item=c.create(actor,input);assert.equal(item.amount,3000);assert(c.summary(student).active);
 assert.equal(c.create(actor,input).id,item.id);assert.equal(c.data.cases.length,1);
 assert.throws(()=>c.create(actor,{...input,reason:'다른 제재 사유'}),e=>e.code==='CASE_CONFLICT');
 let calls=0;await assert.rejects(()=>c.settle(item.id,async()=>{calls++;throw Error('lost response');}));
 c=new Conduct(path.join(root,'unit.json'),()=>clock);assert.equal(c.data.cases[0].state,'pending');
 const once=new Set();const settle=async(action,p)=>{calls++;once.add(p.key);assert.equal(action,'sanction');await new Promise(r=>setTimeout(r,10));};
 await Promise.all([c.settle(item.id,settle),c.settle(item.id,settle)]);assert.equal(calls,2);assert.equal(once.size,1);
 await c.settle(item.id,settle);assert.equal(calls,2);
 assert.throws(()=>c.appeal(item.id,actor,'잘못된 사용자 소명'));
 c.appeal(item.id,student,'증거에 대한 추가 소명입니다.');assert.equal(c.summary(student).cases[0].appeals.length,1);
 clock+=2*86400000;assert.equal(c.summary(student).active,false);
 c.revoke(item.id,actor,'검토 결과 오인으로 취소');await c.settle(item.id,settle);assert.equal(once.size,2);assert.equal(c.summary(student).cases[0].state,'revoked');
 const perma=c.create(actor,{...input,id:uid(),level:5,adjustment:'중대한 반복 위반 확인'});await c.settle(perma.id,settle);clock+=9999*86400000;assert(c.summary(student).permanent);

 const requests=[],wallets=[];const exchange={publicUrl:'https://example.invalid',wallet:async p=>{wallets.push(p);return {balances:[{symbol:'KARMA',available:11000}],locked:{},coins:{daily:1000,base:10000,bonus:0}};},request:async(a,p)=>{requests.push({a,p});return {ok:true};},close(){}};
 const authService=new AuthService({filename:path.join(root,'auth.json'),verificationRequired:false});
 server=await startKarmaServer({host:'127.0.0.1',port:0,healthPort:0,dataDir:path.join(root,'integration'),authService,exchange,logger:()=>{}});
 const admin=await server.auth.createAccount({email:'admin@test.invalid',password:uid(),name:'관리자',role:'admin'});
 const a=await server.auth.createAccount({email:'student@test.invalid',password:uid(),name:'학생'});
 const b=await server.auth.createAccount({email:'other@test.invalid',password:uid(),name:'다른학생'});
 const token=p=>server.auth.issueSession(p).authToken,ta=token(a),tb=token(b),tx=token(admin);
 async function api(route,t,body){const r=await fetch('http://127.0.0.1:'+server.healthPort+route,{method:body===undefined?'GET':'POST',headers:{...(t?{Authorization:'Bearer '+t}:{}),...(body?{'Content-Type':'application/json'}:{})},body:body?JSON.stringify(body):undefined});return {status:r.status,body:await r.json()};}
 assert.equal((await api('/api/game-rules')).body.hash,RULES_HASH);
 for(const flag of [undefined,false,'true']){
  const r=await api('/auth/register/request',null,{email:'new@test.invalid',password:uid(),name:'신규',rulesVersion:GAME_RULES.version,rulesAccepted:flag});assert.equal(r.body.error.code,'RULES_REQUIRED');
 }
 assert.equal((await api('/api/me',ta)).body.profile.rulesRequired,true);
 assert.equal((await api('/auth/rules',ta,{...accepted,rulesAccepted:false})).status,400);
 async function hello(t){return new Promise((resolve,reject)=>{const s=net.createConnection({host:'127.0.0.1',port:server.port});sockets.push(s);let buf='';const timer=setTimeout(()=>reject(Error('hello timeout')),3000);s.setEncoding('utf8');s.on('error',reject);s.on('connect',()=>s.write(JSON.stringify({type:'hello',version:2,op:'create',authToken:t,code:'803421',mode:'dm',maxPlayers:8,clientMaxPlayers:8,manualStart:true,config:{map:0,age:0,character:{index:0,camp:0},settings:{build:'karma290-central6'}}})+'\n'));s.on('data',data=>{buf+=data;if(buf.includes('\n')){clearTimeout(timer);resolve(JSON.parse(buf.split('\n')[0]));}});});}
 assert.equal((await hello(ta)).code,'RULES_REQUIRED');
 assert.equal((await api('/auth/rules',ta,accepted)).body.profile.rulesRequired,false);
 const saved=server.auth.list().find(p=>p.playerId===a.playerId).rulesAcceptance;
 assert.equal(saved.hash,RULES_HASH);await api('/auth/rules',ta,accepted);assert.deepEqual(server.auth.list().find(p=>p.playerId===a.playerId).rulesAcceptance,saved);
 const sanction={...input,id:uid(),playerId:a.playerId,occurredAt:Date.now()};
 assert.equal((await api('/api/admin/conduct',tx,{...sanction,occurredAt:saved.acceptedAt-1})).body.error.code,'RULES_NOT_EFFECTIVE');
 assert.equal((await api('/api/admin/conduct',ta,sanction)).status,403);
 assert.equal((await api('/api/admin/conduct',tx,{...sanction,playerId:b.playerId})).body.error.code,'RULES_REQUIRED');
 assert.equal((await api('/api/admin/conduct',tx,sanction)).status,200);
 assert.equal((await api('/api/admin/conduct',tx,sanction)).status,200);assert.equal(requests.filter(r=>r.a==='sanction').length,1);
 assert.equal((await hello(ta)).code,'ACCOUNT_RESTRICTED');
 assert.equal((await api('/api/me',ta)).status,200,'banned users retain explanation and appeal access');
 assert.equal((await api('/api/conduct',tb)).body.cases.length,0);
 assert.equal((await api('/api/conduct/appeal',tb,{id:sanction.id,text:'다른 사람 사건입니다.'})).status,404);
 assert.equal((await api('/api/conduct/appeal',ta,{id:sanction.id,text:'제재 사유에 대해 소명합니다.'})).status,200);
 assert.equal((await api('/api/admin/coins/reset',tx,{playerId:a.playerId,key:uid(),reason:'회피 방지 확인'})).status,409);
 assert.equal((await api('/api/admin/conduct/revoke',tx,{id:sanction.id,reason:'검토 결과 제재를 취소합니다.'})).status,200);
 assert.equal((await api('/api/conduct',ta)).body.active,false);
 assert.equal((await api('/api/admin/coins/reset',ta,{playerId:a.playerId,key:uid(),reason:'권한 없는 리셋'})).status,403);
 assert.equal((await api('/api/admin/coins/reset',tx,{playerId:a.playerId,key:uid(),reason:'검토 후 관리자 리셋'})).status,200);
 assert(wallets.every(p=>p.rankIndex===0));assert(wallets.every(p=>Object.keys(p.sanctions).join(',')==='active'));
 console.log('PASS rules/conduct: explicit current consent, durable acceptance, game gates, manual evidence and overrides, admin permissions, no duplicate sanctions, crash retry, expiry/permanent, private appeals, revocation and guarded resets.');
}finally{for(const s of sockets)s.destroy();await server?.close();fs.rmSync(root,{recursive:true,force:true});}
