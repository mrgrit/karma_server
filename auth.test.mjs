import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import crypto from 'node:crypto';
import net from 'node:net';
import {fileURLToPath} from 'node:url';
import {AuthService} from './auth.mjs';
import {startKarmaServer} from './server.mjs';
const temp=fs.mkdtempSync(path.join(os.tmpdir(),'karma-auth-test-'));
const password=crypto.randomBytes(18).toString('base64url');
const directory=path.dirname(fileURLToPath(import.meta.url));
let server;
const sockets=[];
try{
  let now=Date.now(),sent=[];
  const required=new AuthService({filename:path.join(temp,'required.json'),now:()=>now,
    verificationRequired:true,mailer:{configured:true,async sendCode(email,code){sent.push({email,code});}}});
  const missing=new AuthService({filename:path.join(temp,'missing.json'),verificationRequired:true,mailer:{configured:false}});
  await assert.rejects(()=>missing.registerRequest({email:'a@example.test',password,name:'Tester'},'ip1'),error=>error.status===503);
  const requested=await required.registerRequest({email:' Person@Example.Test ',password,name:' Tester '},'ip1');
  assert.equal(requested.requiresVerification,true);assert.match(sent[0].code,/^\d{6}$/);
  await assert.rejects(()=>required.registerRequest({email:'person@example.test',password,name:'Tester'},'ip1'),error=>error.code==='RESEND_WAIT');
  const wrong=sent[0].code==='000000'?'111111':'000000';
  for(let attempt=1;attempt<=5;attempt++)await assert.rejects(()=>required.registerVerify({email:'person@example.test',code:wrong},'ip1'),
    error=>error.code===(attempt===5?'CODE_LOCKED':'CODE_MISMATCH'));
  await assert.rejects(()=>required.registerVerify({email:'person@example.test',code:sent[0].code},'ip1'),error=>error.code==='CODE_LOCKED');
  now+=61000;
  await required.registerRequest({email:'person@example.test',password,name:'Tester'},'ip2');
  const verified=await required.registerVerify({email:'person@example.test',code:sent.at(-1).code},'ip2');
  assert.equal(verified.approvalRequired,true);assert.equal(verified.authToken,undefined);
  await assert.rejects(()=>required.login({email:'person@example.test',password},'ip3'),error=>error.code==='APPROVAL_PENDING');
  required.approve(required.list()[0].playerId,'test-admin');
  const registered=await required.login({email:'person@example.test',password},'ip3');
  assert.equal(registered.account.emailVerified,true);
  assert.equal(required.authenticate(registered.authToken).name,'Tester');
  const text=fs.readFileSync(path.join(temp,'required.json'),'utf8');
  assert.ok(!text.includes(password));assert.ok(!text.includes(registered.authToken));
  const logged=await required.login({email:'PERSON@EXAMPLE.TEST',password},'ip3');
  required.logout(logged.authToken);
  assert.throws(()=>required.authenticate(logged.authToken),error=>error.code==='SESSION_EXPIRED');
  now+=13*3600000;
  assert.throws(()=>required.authenticate(registered.authToken),error=>error.code==='SESSION_EXPIRED');
  await required.registerRequest({email:'expired@example.test',password,name:'Tester'},'ip4');
  now+=600001;
  await assert.rejects(()=>required.registerVerify({email:'expired@example.test',code:sent.at(-1).code},'ip4'),error=>error.code==='CODE_EXPIRED');
  console.log('PASS: required email code delivery adapter, missing SMTP503, resend60s, five-attempt lock, expiry10m, salted scrypt/no plaintext, login/logout/session expiry.');

  const auth=new AuthService({filename:path.join(temp,'auth.json'),verificationRequired:false,mailer:{configured:false}});
  server=await startKarmaServer({host:'127.0.0.1',port:0,healthPort:0,dataDir:temp,
    authService:auth,logger:()=>{},matchKills:1});
  const base='http://127.0.0.1:'+server.healthPort;
  async function request(route,{method='GET',body,token}={}){
    const response=await fetch(base+route,{method,headers:{...(body?{'Content-Type':'application/json'}:{}),...(token?{Authorization:'Bearer '+token}:{})},
      ...(body?{body:JSON.stringify(body)}:{})});
    return {status:response.status,value:await response.json()};
  }
  const config=await request('/api/auth-config');assert.equal(config.value.emailVerificationRequired,false);
  assert.equal(config.value.registrationApprovalRequired,true);
  let signup=await request('/auth/register/request',{method:'POST',body:{email:'user@example.test',password,name:'일반 사용자'}});
  assert.equal(signup.status,200);assert.equal(signup.value.requiresVerification,false);
  assert.equal(signup.value.approvalRequired,true);assert.equal(signup.value.authToken,undefined);
  const awaiting=auth.list().find(x=>x.email==='user@example.test');
  assert.equal(awaiting.approvalStatus,'pending');assert.equal(Object.keys(auth.read().sessions).length,0);
  const reopened=new AuthService({filename:auth.filename,verificationRequired:false});
  assert.throws(()=>reopened.issueSession(awaiting),error=>error.code==='APPROVAL_PENDING');
  const cached=reopened.read(),cachedToken='a'.repeat(64);
  cached.sessions[crypto.createHash('sha256').update(cachedToken).digest('hex')]={email:awaiting.email,playerId:awaiting.playerId,expiresAt:Date.now()+60000};
  assert.throws(()=>reopened.authenticate(cachedToken,cached),error=>error.code==='APPROVAL_PENDING');
  assert.equal((await request('/auth/login',{method:'POST',body:{email:'user@example.test',password}})).value.error.code,'APPROVAL_PENDING');
  assert.equal((await request('/api/admin/users/'+awaiting.playerId,{method:'PATCH',body:{approvalStatus:'approved'}})).status,401);
  const adminAccount=await auth.createAccount({email:'admin@example.test',password,name:'관리자',role:'admin'});
  const adminLogin=await request('/auth/login',{method:'POST',body:{email:'admin@example.test',password}});
  assert.equal(adminLogin.value.profile.isAdmin,true);
  const admin=adminLogin.value,headers={token:admin.authToken};
  assert.equal((await request('/api/admin/users',headers)).value.users.find(x=>x.playerId===awaiting.playerId).approvalStatus,'pending');
  assert.ok(!(await request('/api/leaderboard',headers)).value.players.some(x=>x.playerId===awaiting.playerId));
  assert.equal((await request('/api/admin/users/'+awaiting.playerId,{...headers,method:'PATCH',body:{approvalStatus:'approved',xp:100}})).status,400);
  const approval=()=>request('/api/admin/users/'+awaiting.playerId,{...headers,method:'PATCH',body:{approvalStatus:'approved'}});
  assert.equal((await approval()).status,200);assert.equal((await approval()).status,200);
  assert.equal(auth.read().accounts['user@example.test'].approvedBy,adminAccount.playerId);
  signup=await request('/auth/login',{method:'POST',body:{email:'user@example.test',password}});
  assert.equal(signup.value.profile.emailVerified,false);assert.equal(signup.value.profile.isAdmin,false);
  assert.equal(signup.value.profile.email,'user@example.test');
  assert.equal(signup.value.profile.progressionVersion,2);
  assert.equal(signup.value.profile.unlockedCharacterIds.length,6);
  assert.equal(signup.value.profile.dualCannonUnlocked,false);
  const user=signup.value;
  assert.equal((await request('/api/me')).status,401);
  assert.equal((await request('/api/admin/users',{token:user.authToken})).status,403);
  assert.equal((await request('/auth/login',{method:'POST',body:{email:'user@example.test',password:password+'wrong'}})).status,401);
  assert.equal((await request('/api/admin/users/'+adminAccount.playerId,{token:user.authToken,method:'PATCH',body:{approvalStatus:'approved'}})).status,403);
  // Existing databases without this field remain usable, including their sessions.
  const legacy=auth.read();delete legacy.accounts['admin@example.test'].approvalStatus;auth.write(legacy);
  assert.equal((await request('/api/me',headers)).status,200);
  let patch=await request('/api/admin/users/'+user.profile.playerId,{...headers,method:'PATCH',body:{xp:275}});
  assert.equal(patch.status,200);assert.equal(patch.value.profile.xp,275);
  assert.equal(patch.value.profile.rank.id,'recruit','Existing XP keeps its value under the higher promotion requirements');
  patch=await request('/api/admin/users/'+user.profile.playerId,{...headers,method:'PATCH',body:{xp:1000,kills:2,deaths:1,wins:1,losses:0,draws:1}});
  assert.equal(patch.status,200);assert.equal(patch.value.profile.matches,2);
  assert.equal((await request('/api/me',{token:user.authToken})).value.profile.rank.id,'private');
  assert.equal((await request('/api/me',{token:user.authToken})).value.profile.email,'user@example.test');
  // Invalid combined admin writes must not leak XP or unlocks into live state.
  patch=await request('/api/admin/users/'+user.profile.playerId,{...headers,method:'PATCH',body:{xp:6000,
    loadouts:{cpom_020:{inventory:[50,9,21,22,48,255,255],selectedWeapon:21}}}});
  assert.equal(patch.status,400);
  assert.equal((await request('/api/me',{token:user.authToken})).value.profile.xp,1000);
  patch=await request('/api/admin/users/'+user.profile.playerId,{...headers,method:'PATCH',body:{xp:6000,
    loadouts:{cpom_020:{inventory:[50,9,21,22,255,255,255],selectedWeapon:21}}}});
  assert.equal(patch.status,200);assert.equal(patch.value.profile.dualCannonUnlocked,true);
  assert.deepEqual(patch.value.profile.loadouts.cpom_020.inventory,[50,9,21,22,255,255,255]);
  patch=await request('/api/admin/users/'+user.profile.playerId,{...headers,method:'PATCH',body:{xp:100}});
  assert.equal(patch.status,200);assert.deepEqual(patch.value.profile.loadouts,{});
  assert.equal(patch.value.profile.dualCannonUnlocked,false,'XP downgrade invalidates the saved dual build');
  const ranking=(await request('/api/leaderboard',{token:user.authToken})).value;
  assert.ok(!JSON.stringify(ranking).includes('@'));
  const users=(await request('/api/admin/users',headers)).value.users;
  assert.equal(users.find(x=>x.playerId===user.profile.playerId).email,'user@example.test');
  patch=await request('/api/admin/users/'+user.profile.playerId,{...headers,method:'PATCH',body:{disabled:true}});
  assert.equal(patch.status,200);
  assert.equal((await request('/api/me',{token:user.authToken})).status,401);
  await request('/api/admin/users/'+user.profile.playerId,{...headers,method:'PATCH',body:{disabled:false}});
  const login=await request('/auth/login',{method:'POST',body:{email:'user@example.test',password}});
  assert.equal(login.status,200);
  const dashboard=(await request('/api/dashboard',headers)).value;
  assert.equal(dashboard.summary.registeredUsers,2);assert.ok(dashboard.activity.some(x=>x.event==='admin-user-update'));
  assert.equal(dashboard.activity.filter(x=>x.event==='admin-user-approved').length,1);
  assert.equal((await request('/api/admin/users/'+adminAccount.playerId,{...headers,method:'PATCH',body:{disabled:true}})).status,400);

  const original=JSON.parse(fs.readFileSync(path.join(directory,'characters.json'),'utf8').replace(/^\uFEFF/,'')).find(x=>x.age===0);
  const cfg={age:0,map:0,character:{index:original.characterIndex,camp:original.camp},inventory:[50,9,1,6,48,24,18],selectedWeapon:9};
  async function peer(token,op){
    const socket=net.createConnection({port:server.port,host:'127.0.0.1'});sockets.push(socket);
    const items=[];let buffer='';
    socket.setEncoding('utf8');socket.on('error',()=>{});
    socket.on('data',text=>{buffer+=text;let at;while((at=buffer.indexOf('\n'))>=0){const item=JSON.parse(buffer.slice(0,at));items.push(item);if(item.type==='welcome'&&item.room)send({type:'lobby-update',requestId:'test-ready',ready:true});buffer=buffer.slice(at+1);}});
    await new Promise(resolve=>socket.once('connect',resolve));
    const send=value=>socket.write(JSON.stringify(value)+'\n');
    send({type:'hello',version:2,authToken:token,op,code:'654321',config:cfg,clientMaxPlayers:2});
    return {socket,send,async wait(type){
      for(let i=0;i<300;i++){const found=items.find(x=>x.type===type);if(found)return found;await new Promise(r=>setTimeout(r,10));}
      throw Error('Missing '+type+' '+JSON.stringify(items));
    }};
  }
  const host=await peer(admin.authToken,'create');await host.wait('welcome');
  const guest=await peer(login.value.authToken,'join');await host.wait('peer-ready');await guest.wait('peer-ready');
  const state={type:'state',version:1,life:1,seq:1,pos:[0,0,0],yaw:0,pitch:0,sector:4,weapon:9,hp:100};
  host.send({type:'game',message:state});guest.send({type:'game',message:state});await host.wait('game');
  host.send({type:'game',message:{type:'hit',version:1,life:1,seq:2,id:1,victimLife:1,weapon:9,kind:'bullet',region:1,direction:[1,0,0]}});
  await guest.wait('game');
  // Native IDs can be numeric; TCP ordering supplies hit evidence before proof.
  await new Promise(resolve=>setTimeout(resolve,20));
  guest.send({type:'damage-proof',proof:{id:1,victimLife:1,attackerId:adminAccount.playerId,attackerLife:1,weapon:9,before:30,after:0}});
  guest.send({type:'game',message:{type:'death',version:1,life:1,seq:2,killer:'remote',weapon:9,damageId:1,hpAfter:0}});
  const ended=await host.wait('match-ended');assert.equal(ended.result.reason,'kill-limit');
  assert.deepEqual(ended.result.winnerIds,[adminAccount.playerId]);
  await new Promise(resolve=>setTimeout(resolve,50));
  const finalAdmin=(await request('/api/me',headers)).value.profile;
  assert.equal(finalAdmin.wins,1);assert.equal(finalAdmin.matches,1);
  assert.equal((await request('/api/me',{token:login.value.authToken})).value.profile.losses,1);
  assert.equal((await request('/api/dashboard',headers)).value.summary.totalMatches,1,'Disconnect after result must not write another match');
  assert.equal((await request('/auth/logout',{method:'POST',token:admin.authToken})).status,200);
  assert.equal((await request('/api/me',headers)).status,401);
  console.log('PASS: email-off signup, authenticated HTTP/TCP identity, admin-only updates/audit, leaderboard privacy, disabled/session revocation, numeric proof ID, kill-limit result and exactly-once W/L, logout.');
}finally{
  for(const socket of sockets)socket.destroy();
  if(server)await server.close();
  for(const file of ['required.json','missing.json','auth.json','profiles.json']){
    const owned=path.join(temp,file);if(fs.existsSync(owned))fs.unlinkSync(owned);
  }
  fs.rmdirSync(temp);
}
