import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import crypto from 'node:crypto';
import {spawn} from 'node:child_process';
import {once} from 'node:events';
import {createInterface} from 'node:readline';
import {createExchangeClient} from './exchange-client.mjs';
const temp=fs.mkdtempSync(path.join(os.tmpdir(),'karma-exchange-bridge-'));
const child=spawn(process.env.PYTHON||(process.platform==='win32'?'python':'python3'),['exchange/test_bridge_server.py',temp],{stdio:['pipe','pipe','inherit']});
let bridge;
try{
 const lines=createInterface({input:child.stdout});
 const [line]=await Promise.race([once(lines,'line'),once(child,'error').then(([e])=>Promise.reject(e)),once(child,'exit').then(()=>Promise.reject(Error('TLS fixture exited')))]);
 const {port}=JSON.parse(line);lines.close();
 const keyFile=path.join(temp,'key');fs.writeFileSync(keyFile,'test-only-service-key-'+'a'.repeat(48));
 const opts={url:`https://localhost:${port}`,address:'127.0.0.1',caFile:'exchange/test-fixtures/localhost.pem',keyFile,dataDir:temp};
 bridge=createExchangeClient(opts);await bridge.init();
 const players=[0,1].map(i=>({playerId:crypto.randomUUID(),name:'Fixture '+i,role:'user'}));
 const available=async p=>(await bridge.wallet(p)).balances.find(b=>b.symbol==='KARMA').available;
 assert.equal(await available(players[0]),300);
 const paid=crypto.randomUUID();await bridge.charge(paid,players);await bridge.confirm(paid);
 assert.equal(await available(players[0]),200);assert.equal(await available(players[1]),200);
 assert.deepEqual(JSON.parse(fs.readFileSync(path.join(temp,'exchange-pending.json'))),{});
 const interrupted=crypto.randomUUID();await bridge.charge(interrupted,players);assert.equal(await available(players[0]),100);
 bridge.close();bridge=createExchangeClient(opts);await bridge.init();
 assert.equal(await available(players[0]),200,'unfinished start is refunded after game server restart');
 await bridge.refund(interrupted);assert.equal(await available(players[0]),200,'refund is idempotent');
 // A persisted admission decision must finalize after restart, never refund.
 const admitted=crypto.randomUUID();await bridge.charge(admitted,players);
 bridge.close();
 const pendingPath=path.join(temp,'exchange-pending.json'),pending=JSON.parse(fs.readFileSync(pendingPath));
 pending[admitted].phase='finalizing';fs.writeFileSync(pendingPath,JSON.stringify(pending));
 bridge=createExchangeClient(opts);await bridge.init();
 assert.equal(await available(players[0]),100,'admitted match finalizes after restart');
 assert.deepEqual(JSON.parse(fs.readFileSync(pendingPath)),{});
 const last=crypto.randomUUID();await bridge.charge(last,players);await bridge.confirm(last);
 const rejected=crypto.randomUUID();await assert.rejects(bridge.charge(rejected,players),{code:'INSUFFICIENT_FUNDS'});
 assert.equal(await available(players[0]),0);
 await assert.rejects(bridge.request('reserve',{matchId:crypto.randomUUID(),players,expiresAt:Date.now()-1000}),{code:'RESERVATION_EXPIRED'});
 console.log('PASS real TLS exchange: wallet, timestamp reservation, integer fees, commit, durable restart refund, duplicate refund, insufficient balance, expired start.');
}finally{
 bridge?.close();child.stdin.end();await once(child,'exit');fs.rmSync(temp,{recursive:true,force:true});
}
