import assert from 'node:assert/strict';
import fs from 'node:fs';import os from 'node:os';import path from 'node:path';
import {FairPlay} from './fairplay.mjs';
const temp=fs.mkdtempSync(path.join(os.tmpdir(),'karma-fairplay-'));let now=1000000;
const file=path.join(temp,'fairplay.json');
try{
 const f=new FairPlay(file,()=>now);
 const receipt=(i,attacker='a',victim='b',weapon=i%3)=>({id:attacker+i,verified:true,killerId:attacker,victimId:victim,weapon,matchId:'match'+Math.floor(i/4)});
 for(let i=0;i<30;i++){now+=12000;assert.equal(f.observe(receipt(i,'active'),{passive:false}),null);}
 for(let i=0;i<12;i++){now+=12000;const result=f.observe(receipt(i),{passive:true});assert.equal(!!result,i===11);}
 assert(f.hold('a'));assert(!f.hold('b'),'victim is not automatically punished');assert(!f.hold('active'));
 const count=f.data.events.length;f.observe(receipt(11),{passive:true});assert.equal(f.data.events.length,count,'duplicate receipts ignored');
 const restarted=new FairPlay(file,()=>now);assert(restarted.hold('a'),'hold persists after restart');
 const id=restarted.hold('a').id;restarted.release(id,'admin','수업 중 시연으로 확인');assert(!restarted.hold('a'));
 assert.equal(restarted.data.cases[0].releasedBy,'admin');
 assert.equal(restarted.observe(receipt(99),{passive:true}),null,'release clears old evidence');
 const balanced=new FairPlay(path.join(temp,'balanced.json'),()=>now);
 for(let i=0;i<15;i++){now+=12000;assert.equal(balanced.observe(receipt(i),{passive:true}),null);balanced.observe(receipt(i,'b','a'),{passive:false});}
 now+=21*60000;assert.equal(balanced.observe(receipt(90),{passive:true}),null,'old evidence expires');
 console.log('PASS fairplay: independent signals, active victims and reciprocal fights excluded, duplicate receipt protection, persistent holds, victim not suspended, audited admin release and fresh review window');
}finally{fs.rmSync(temp,{recursive:true,force:true});}
