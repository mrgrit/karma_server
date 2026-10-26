import fs from 'node:fs';
import crypto from 'node:crypto';
import {atomicWriteJson} from './progression.mjs';
import {GAME_RULES,RULES_HASH} from './rules.mjs';
const reject=(message,code='BAD_CONDUCT',status=400)=>{throw Object.assign(Error(message),{code,status});};
const text=(value,max=1500)=>{if(typeof value!=='string'||value.trim().length<5||value.length>max||/[\x00-\x08\x0b-\x1f]/.test(value))reject('사유와 증거를 5자 이상 입력해 주세요.');return value.trim();};
export class Conduct {
  constructor(filename,now=()=>Date.now()){
    this.filename=filename;this.now=now;this.data=fs.existsSync(filename)?JSON.parse(fs.readFileSync(filename,'utf8')):{version:1,cases:[]};
    if(this.data.version!==1||!Array.isArray(this.data.cases))throw Error('Invalid conduct data; preserving file');
    this.running=new Map();
  }
  save(){atomicWriteJson(this.filename,this.data);}
  summary(playerId){
    const cases=this.data.cases.filter(c=>c.playerId===playerId);
    const active=cases.filter(c=>c.state!=='revoked'&&(c.state!=='applied'||c.permanent||c.until>this.now()));
    return {active:active.length>0,permanent:active.some(c=>c.permanent),until:Math.max(0,...active.map(c=>c.until||0)),pending:active.some(c=>c.state!=='applied'),cases:cases.map(c=>({...c}))};
  }
  create(actor,input){
    if(!/^[0-9a-f-]{36}$/.test(input.id||'')||!/^[0-9a-f-]{36}$/.test(input.playerId||''))reject('사용자와 사건 번호를 확인하세요.');
    if(actor===input.playerId)reject('본인에게 제재를 적용할 수 없습니다.');
    const violation=GAME_RULES.violations.find(v=>v.id===input.violation),level=GAME_RULES.levels.find(v=>v.level===input.level);
    if(!violation||!level||input.confirmed!==true)reject('위반 유형·단계와 관리자 확인이 필요합니다.');
    const occurredAt=Number(input.occurredAt);if(!Number.isSafeInteger(occurredAt)||occurredAt<=0||occurredAt>this.now())reject('실제 위반 발생 시간을 확인해 주세요.');
    const reason=text(input.reason,300),evidence=text(input.evidence),adjustment=input.level!==violation.level?text(input.adjustment,300):'';
    const fingerprint=crypto.createHash('sha256').update(JSON.stringify([actor,input.playerId,violation.id,level.level,reason,evidence,adjustment,occurredAt])).digest('hex');
    const previous=this.data.cases.find(c=>c.id===input.id);
    if(previous){if(previous.fingerprint!==fingerprint)reject('같은 사건 번호의 내용이 다릅니다.','CASE_CONFLICT',409);return previous;}
    const createdAt=this.now();
    const item={id:input.id,playerId:input.playerId,actor,violation:violation.id,violationName:violation.name,level:level.level,
      amount:level.coins*100,permanent:level.permanent,until:level.days?createdAt+level.days*86400000:0,
      reason,evidence,adjustment,occurredAt,createdAt,rulesVersion:GAME_RULES.version,rulesHash:RULES_HASH,
      fingerprint,state:'pending',appeals:[]};
    this.data.cases.push(item);this.save();return item;
  }
  async settle(id,request){
    if(this.running.has(id))return this.running.get(id);
    const task=(async()=>{
      const item=this.data.cases.find(c=>c.id===id);if(!item)reject('사건을 찾을 수 없습니다.','NOT_FOUND',404);
      if(item.state==='applied'||item.state==='revoked')return item;
      const revoking=item.state==='revoking';
      // Remote idempotency + durable pending state recover either side of a crash.
      await request('sanction',{actor:revoking?item.revokedBy:item.actor,key:(revoking?'revoke:':'apply:')+item.id,
        payload:{action:revoking?'revoke':'apply',caseId:item.id,playerId:item.playerId,amount:item.amount,reason:item.reason}});
      item.state=revoking?'revoked':'applied';item.settledAt=this.now();this.save();return item;
    })();
    this.running.set(id,task);try{return await task;}finally{this.running.delete(id);}
  }
  revoke(id,actor,note){
    const item=this.data.cases.find(c=>c.id===id);if(!item)reject('사건을 찾을 수 없습니다.','NOT_FOUND',404);
    if(item.state==='revoked'||item.state==='revoking')return item;
    if(item.state!=='applied')reject('원래 제재 정산을 먼저 완료해 주세요.','CASE_PENDING',409);
    item.revocationNote=text(note,500);item.revokedBy=actor;item.revocationAt=this.now();item.state='revoking';this.save();return item;
  }
  appeal(id,playerId,message){
    const item=this.data.cases.find(c=>c.id===id&&c.playerId===playerId);if(!item)reject('본인의 사건만 소명할 수 있습니다.','NOT_FOUND',404);
    if(item.appeals.length>=5)reject('추가 소명은 관리자에게 문의해 주세요.','APPEAL_LIMIT',409);
    item.appeals.push({at:this.now(),text:text(message,2000)});this.save();return {ok:true};
  }
}
