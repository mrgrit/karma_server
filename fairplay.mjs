import fs from 'node:fs';
import crypto from 'node:crypto';
import {atomicWriteJson} from './progression.mjs';
const WINDOW=20*60*1000;
export class FairPlay {
  constructor(filename,now=()=>Date.now()){
    this.filename=filename;this.now=now;
    this.data=fs.existsSync(filename)?JSON.parse(fs.readFileSync(filename,'utf8')):{version:1,events:[],cases:[]};
    if(this.data.version!==1||!Array.isArray(this.data.events)||!Array.isArray(this.data.cases))throw Error('Invalid fair-play database; preserving file');
  }
  save(){atomicWriteJson(this.filename,this.data);}
  hold(playerId){return this.data.cases.find(c=>c.playerId===playerId&&!c.releasedAt);}
  observe(receipt,{map,passive=false}={}){
    if(!receipt.verified||receipt.killerId===receipt.victimId)return null;
    const now=this.now();
    this.data.events=this.data.events.filter(e=>now-e.time<=WINDOW);
    if(this.data.events.some(e=>e.id===receipt.id))return null;
    const e={id:receipt.id,time:now,attacker:receipt.killerId,victim:receipt.victimId,weapon:receipt.weapon,matchId:receipt.matchId,map,passive};
    this.data.events.push(e);this.data.events=this.data.events.slice(-50000);
    const pair=this.data.events.filter(x=>x.attacker===e.attacker&&x.victim===e.victim);
    const reverse=this.data.events.filter(x=>x.attacker===e.victim&&x.victim===e.attacker).length;
    const inactive=pair.filter(x=>x.passive).length,weapons=new Set(pair.map(x=>x.weapon)).size,matches=new Set(pair.map(x=>x.matchId)).size;
    let item=null;
    // Several independent signals, not AFK or a large skill gap alone.
    if(pair.length>=12&&inactive>=10&&inactive/pair.length>=.8&&pair.length/(pair.length+reverse)>=.9&&
       now-pair[0].time>=120000&&(weapons>=3||matches>=3)&&!this.hold(e.attacker)){
      item={id:crypto.randomUUID(),playerId:e.attacker,otherPlayerId:e.victim,createdAt:now,
        reason:'동일 상대 반복 처치 · 비활동 피해자 · 무기/경기 변경 패턴',
        evidence:{windowMinutes:20,kills:pair.length,passiveDeaths:inactive,reverseKills:reverse,weapons,matches,durationSeconds:Math.floor((now-pair[0].time)/1000)},
        receiptIds:pair.map(x=>x.id),releasedAt:null};
      this.data.cases.push(item);
    }
    this.save();return item;
  }
  release(id,adminId,note){
    const item=this.data.cases.find(c=>c.id===id);if(!item)return null;
    if(!item.releasedAt){
      item.releasedAt=this.now();item.releasedBy=adminId;item.releaseNote=String(note||'관리자 확인 후 해제').slice(0,300);
      // A fresh review window starts after release; old evidence cannot immediately re-suspend.
      this.data.events=this.data.events.filter(e=>e.attacker!==item.playerId);this.save();
    }
    return item;
  }
}
