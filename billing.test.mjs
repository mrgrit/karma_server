import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import crypto from 'node:crypto';
import net from 'node:net';
import {startKarmaServer} from './server.mjs';
const dataDir=fs.mkdtempSync(path.join(os.tmpdir(),'karma-billing-')),clients=[],balances=new Map(),payments=new Map();
let pause=null,fail=false,charges=0,refunds=0;
const exchange={publicUrl:'https://exchange.test.internal',
 wallet:async p=>({balances:[{symbol:'KARMA',available:balances.get(p.playerId)??300}],locked:{}}),
 async charge(id,players){charges++;if(pause)await pause;if(fail)throw Object.assign(Error('코인 부족: Student'),{code:'INSUFFICIENT_FUNDS'});
  for(const p of players)balances.set(p.playerId,(balances.get(p.playerId)??300)-100);payments.set(id,players);return {matchId:id,fee:100};},
 async refund(id){refunds++;for(const p of payments.get(id)||[])balances.set(p.playerId,balances.get(p.playerId)+100);payments.delete(id);},
 confirm(id){payments.delete(id);}};
const server=await startKarmaServer({host:'127.0.0.1',port:0,healthPort:0,dataDir,exchange,logger:()=>{}});
const delay=ms=>new Promise(r=>setTimeout(r,ms));
async function wait(label,fn){for(let i=0;i<300;i++){const r=fn();if(r)return r;await delay(20);}throw Error('Timeout '+label);}
async function join(code,host=false){
 const account=await server.auth.createAccount({email:crypto.randomUUID()+'@test.invalid',password:crypto.randomUUID(),name:'Student'});
 const socket=net.createConnection({host:'127.0.0.1',port:server.port}),c={socket,id:account.playerId,messages:[]};clients.push(c);let buffer='';
 socket.setEncoding('utf8');socket.on('error',()=>{});socket.on('data',chunk=>{buffer+=chunk;let i;while((i=buffer.indexOf('\n'))>=0){c.messages.push(JSON.parse(buffer.slice(0,i)));buffer=buffer.slice(i+1);}});
 c.latest=type=>c.messages.filter(m=>m.type===type).at(-1);c.send=m=>socket.write(JSON.stringify(m)+'\n');
 await new Promise(resolve=>socket.once('connect',resolve));
 c.send({type:'hello',version:2,op:host?'create':'join',authToken:server.auth.issueSession(account).authToken,code,mode:'dm',maxPlayers:8,clientMaxPlayers:8,manualStart:true,config:{map:0,age:0,character:{index:0,camp:0},settings:{build:'karma290-central4'}}});
 const welcome=await wait('welcome',()=>c.latest('welcome'));c.start=()=>c.send({type:'start-match',roomId:welcome.room.roomId});
 c.send({type:'lobby-update',requestId:'test-ready',ready:true});await wait('ready ack',()=>c.latest('lobby-updated'));return c;
}
try{
 const a=await join('931001',true),b=await join('931001');await delay(100);assert.equal(charges,0,'lobby entrance is free');
 let resume;pause=new Promise(r=>resume=r);a.start();await wait('charge pending',()=>charges===1);a.start();a.start();await delay(100);assert.equal(charges,1,'double click cannot debit twice');assert(!a.latest('peer-ready'));
 resume();pause=null;await wait('ready',()=>b.latest('peer-ready'));assert.equal(b.latest('peer-ready').profile.coins.available,200);assert.equal(balances.get(a.id),200);assert.equal(payments.size,0);
 const c=await join('931002',true),d=await join('931002');fail=true;c.start();await wait('insufficient funds denial',()=>c.latest('start-denied'));assert.match(c.latest('start-denied').message,/코인 부족/);assert(!d.latest('peer-ready'));assert(!c.socket.destroyed);
 fail=false;c.start();await wait('retry funded start',()=>d.latest('peer-ready'));assert.equal(balances.get(c.id),200);
 const e=await join('931003',true),f=await join('931003');pause=new Promise(r=>resume=r);const before=charges;e.start();await wait('pending second room',()=>charges===before+1);f.socket.end();await delay(100);resume();pause=null;
 await wait('refund after participant leaves',()=>refunds===1);assert.equal(balances.get(e.id),300);assert.equal(balances.get(f.id),300);assert(!e.latest('peer-ready'));
 const g=await join('931004',true),h=await join('931004');pause=new Promise(r=>resume=r);const readyCharges=charges;g.start();await wait('pending readiness race',()=>charges===readyCharges+1);
 h.send({type:'lobby-update',requestId:'edit-begins',ready:false});await wait('unready accepted during billing',()=>h.messages.some(m=>m.type==='lobby-updated'&&m.requestId==='edit-begins'&&!m.ready));
 h.send({type:'lobby-update',requestId:'edit-finished',ready:true});await wait('ready restored during billing',()=>h.messages.some(m=>m.type==='lobby-updated'&&m.requestId==='edit-finished'&&m.ready));
 resume();pause=null;await wait('readiness revision refunds',()=>refunds===2);await wait('readiness start denied',()=>g.latest('start-denied'));
 assert.equal(balances.get(g.id),300);assert.equal(balances.get(h.id),300);assert(!g.latest('peer-ready'),'Readiness changes during billing must cancel even when everyone readies again');
 g.start();await wait('explicit retry after readiness refund',()=>h.latest('peer-ready'));assert.equal(balances.get(h.id),200);
 console.log('PASS billing: lobby free, one fee per match, duplicate start serialized, funded retry, participant/readiness changes refund before start, restored-ready race cancellation and explicit retry.');
}finally{for(const c of clients)c.socket.destroy();await server.close();fs.rmSync(dataDir,{recursive:true,force:true});}
