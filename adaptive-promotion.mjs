import {masteryProgress,TECHNIQUES} from './mastery.mjs';
import {PROMOTION_BASELINES,RANKS} from './rank-policy.mjs';

const DAY=86400000,KST=9*3600000,WINDOW=28*DAY;
export const OBSERVATION_LIMITS=Object.freeze({windowDays:28,minimumDays:14,players:8,matches:30,rankPlayers:6,
 playerMatches:3,playerSeconds:900,playerOpponents:3,playerMaps:2,dailyMatches:6,dailySeconds:7200,noticeHours:24});
const copy=x=>structuredClone(x);
export const koreaDay=time=>new Date(time+KST).toISOString().slice(0,10);
export const koreaWeek=time=>Math.floor((time+KST+3*DAY)/(7*DAY))*7*DAY-3*DAY-KST;
const median=values=>{const v=values.slice().sort((a,b)=>a-b),i=Math.floor(v.length/2);return v.length%2?v[i]:(v[i-1]+v[i])/2;};
const adjustable=['requiredXp','each','mobile','heavy','special'];
const counter=n=>Number.isSafeInteger(n)&&n>=0;
function validateRules(rules){
 if(!Array.isArray(rules)||rules.length!==PROMOTION_BASELINES.length)throw Error('Invalid adaptive rank rules');
 for(let i=0;i<rules.length;i++){
  const b=PROMOTION_BASELINES[i],r=rules[i];
  for(const k of Object.keys(b)){
   if(!b.adaptive||!adjustable.includes(k)){if(r[k]!==b[k])throw Error('Invalid fixed promotion requirement');}
   else if(!counter(r[k])||r[k]<Math.ceil(b[k]*.7)||r[k]>Math.floor(b[k]*1.3))throw Error('Invalid adaptive promotion boundary');
  }
  if(i&&adjustable.some(k=>r[k]<rules[i-1][k]))throw Error('Promotion requirements must be ordered');
 }
 return rules;
}
function totals(profile){
 const q=profile.mastery?.qualified||{},v={qualified:0,mobile:0,heavy:0,special:0};
 for(const t of TECHNIQUES){const n=q[t.weaponId]||0;v.qualified+=n;if(t.family in v)v[t.family]+=n;}
 return v;
}
export function validateExperience(e){
 if(e===undefined)return;
 if(!e||!counter(e.matches)||!counter(e.activeSeconds))throw Error('Invalid promotion experience');
 for(const field of ['opponents','maps','days']){
  if(!e[field]||typeof e[field]!=='object'||Array.isArray(e[field])||Object.entries(e[field]).some(([k,v])=>!k||v!==true))throw Error('Invalid promotion experience history');
 }
}

// All durable state lives in profiles.json. The caller commits a completed match,
// counters, earned ranks and observation buckets in one atomic database write.
export class AdaptivePromotions{
 constructor(data,{now=()=>Date.now(),eligible=()=>true,canPromote=()=>true}={}){
  this.data=data;this.now=now;this.eligible=eligible;this.canPromote=canPromote;
  if(!data.promotionPolicy){
   data.promotionPolicy={version:1,createdAt:now(),enabled:true,active:{version:1,effectiveAt:now(),rules:copy(PROMOTION_BASELINES)},
    pending:null,lastReviewWeek:null,buckets:[],history:[],manualExclusions:{}};
   for(const p of Object.values(data.profiles))p.mastery.earnedRankXp=masteryProgress(p).rankXp;
  }
  this.state=data.promotionPolicy;
  const s=this.state;
  if(s.version!==1||typeof s.enabled!=='boolean'||!counter(s.createdAt)||!counter(s.active?.version)||!Array.isArray(s.buckets)||!Array.isArray(s.history)||!s.manualExclusions)throw Error('Invalid promotion policy; preserving database');
  validateRules(s.active.rules);if(s.pending){validateRules(s.pending.rules);if(!counter(s.pending.effectiveAt))throw Error('Invalid pending policy date');}
  for(const p of Object.values(data.profiles))validateExperience(p.promotionExperience);
  for(const b of s.buckets)if(typeof b.playerId!=='string'||!counter(b.at)||!counter(b.seconds)||!counter(b.matches)||!b.opponents||!b.maps||!counter(b.xp)||['qualified','mobile','heavy','special'].some(k=>!counter(b[k])))throw Error('Invalid promotion observation');
 }
 get rules(){return this.state.active.rules;}
 progress(profile){
  const p=masteryProgress(profile,this.rules);
  if(!this.canPromote(profile.playerId)){
   p.rankXp=Math.max(profile.mastery?.legacyRankXp||0,profile.mastery?.earnedRankXp||0);
   p.next=p.requirements.find(r=>r.minXp>p.rankXp)||null;
  }
  return {...p,policyVersion:this.state.active.version};
 }
 remember(profile){
  const before=Math.max(profile.mastery.earnedRankXp||0,profile.mastery.legacyRankXp),rank=this.progress(profile).rankXp;
  profile.mastery.earnedRankXp=Math.max(before,rank);
  if(rank>before)this.audit({type:'promotion',playerId:profile.playerId,from:before,to:rank,policyVersion:this.state.active.version});
 }
 audit(event){this.state.history.push({at:this.now(),...event});this.state.history=this.state.history.slice(-2000);}
 clean(id){return this.eligible(id)&&!(this.state.manualExclusions[id]>this.now());}
 exclude(id,reason='manual-edit'){this.state.manualExclusions[id]=this.now()+WINDOW;this.state.buckets=this.state.buckets.filter(b=>b.playerId!==id);this.audit({type:'sample-excluded',playerId:id,reason});}
 start(room,session){
  room.promotionPlayers??=new Map();
  if(room.promotionPlayers.has(session.playerId)){room.promotionPlayers.get(session.playerId).lastAt=0;return;}
  const p=this.data.profiles[session.playerId];
  room.promotionPlayers.set(session.playerId,{rankXp:this.progress(p).rankXp,xp:p.xp,totals:totals(p),activeMs:0,lastAt:0,lastAction:0,life:0,pos:null,shot:null});
 }
 track(room,session,game){
  const t=room.promotionPlayers?.get(session.playerId);if(!t)return;
  const now=this.now(),gap=t.lastAt?now-t.lastAt:0;
  if(t.life!==game.life){t.life=game.life;t.lastAt=now;t.lastAction=0;t.pos=[...game.pos];t.shot=game.shot?.id??null;return;}
  const moved=t.pos&&game.pos.some((v,i)=>Math.abs(v-t.pos[i])>40),shot=game.shot&&game.shot.id!==t.shot;
  if(moved||shot){t.lastAction=now;t.pos=[...game.pos];}t.shot=game.shot?.id??t.shot;
  if(room.phase==='active'&&game.hp>0&&game.paused!==true&&t.lastAction&&now-t.lastAction<=15000&&gap>0&&gap<=1000)t.activeMs+=gap;
  t.lastAt=now;
 }
 observe(result,room){
  if(result.promotionObserved)return;
  result.promotionObserved=true;
  const duration=result.endedAt-result.startedAt;
  if(!['kill-limit','round-limit','time-limit'].includes(result.reason)||duration<120000||result.players.some(id=>!this.clean(id))){result.promotionQualified=false;return;}
  const combatPlayers=new Set();
  for(const receipt of room.combat?.deaths.values()||[])if(receipt.verified){combatPlayers.add(receipt.killerId);combatPlayers.add(receipt.victimId);}
  const entries=result.players.map(id=>[id,room.promotionPlayers?.get(id)]).filter(([id,t])=>t&&t.activeMs>=120000&&combatPlayers.has(id));
  if(entries.length<2){result.promotionQualified=false;return;}
  result.promotionQualified=true;
  const now=this.now(),day=koreaDay(now);
  this.state.buckets=this.state.buckets.filter(b=>b.at>=now-WINDOW);
  for(const [id,t] of entries){
   const p=this.data.profiles[id],seconds=Math.min(Math.floor(t.activeMs/1000),Math.floor(duration/1000));
   const e=p.promotionExperience??={matches:0,activeSeconds:0,opponents:{},maps:{},days:{}};
   e.matches++;e.activeSeconds+=seconds;e.maps[result.map]=true;e.days[day]=true;
   const others=entries.filter(([other])=>other!==id).map(([other])=>other);for(const other of others)e.opponents[other]=true;
   const target=this.rules.find(r=>r.minXp>t.rankXp);
   if(target){
    const daily=this.state.buckets.filter(b=>b.playerId===id&&b.day===day),matches=daily.reduce((s,b)=>s+b.matches,0),used=daily.reduce((s,b)=>s+b.seconds,0);
    if(matches<OBSERVATION_LIMITS.dailyMatches&&used<OBSERVATION_LIMITS.dailySeconds){
     const allowed=Math.min(seconds,OBSERVATION_LIMITS.dailySeconds-used),ratio=allowed/seconds,v=totals(p);
     let b=this.state.buckets.find(b=>b.playerId===id&&b.day===day&&b.target===target.minXp);
     if(!b){b={playerId:id,day,at:now,target:target.minXp,seconds:0,matches:0,xp:0,qualified:0,mobile:0,heavy:0,special:0,opponents:{},maps:{},matchIds:[]};this.state.buckets.push(b);}
     b.seconds+=allowed;b.matches++;b.xp+=Math.floor(Math.max(0,p.xp-t.xp)*ratio);b.matchIds.push(result.id);b.maps[result.map]=true;
     for(const other of others)b.opponents[other]=true;
     for(const k of ['qualified','mobile','heavy','special'])b[k]+=Math.floor(Math.max(0,v[k]-t.totals[k])*ratio);
    }
   }
   this.remember(p);
  }
 }
 sample(){
  const now=this.now(),clean=new Map();
  const buckets=this.state.buckets.filter(b=>{if(b.at<now-WINDOW)return false;if(!clean.has(b.playerId))clean.set(b.playerId,this.clean(b.playerId));return clean.get(b.playerId);});
  return {buckets,players:new Set(buckets.map(b=>b.playerId)).size,matches:new Set(buckets.flatMap(b=>b.matchIds)).size,
   observedDays:Math.min(28,Math.floor((now-this.state.createdAt)/DAY))};
 }
 review(){
  const now=this.now(),s=this.state;let changed=false;
  if(s.enabled&&s.pending&&now>=s.pending.effectiveAt){
   for(const p of Object.values(this.data.profiles))this.remember(p);
   s.active={version:s.active.version+1,effectiveAt:now,rules:s.pending.rules};s.pending=null;
   this.audit({type:'applied',policyVersion:s.active.version});
   for(const p of Object.values(this.data.profiles))this.remember(p);changed=true;
  }
  const week=koreaWeek(now);if(!s.enabled||s.pending||s.lastReviewWeek===week)return changed;
  s.lastReviewWeek=week;const sample=this.sample();s.buckets=s.buckets.filter(b=>b.at>=now-WINDOW);
  const details={players:sample.players,matches:sample.matches,observedDays:sample.observedDays};
  if(sample.observedDays<14||sample.players<8||sample.matches<30){this.audit({type:'insufficient',...details});return true;}
  const rules=copy(this.rules),decisions=[];
  for(let i=5;i<rules.length;i++){
   const r=rules[i],old=this.rules[i],prev=this.rules[i-1],base=PROMOTION_BASELINES[i],groups=new Map();
   for(const b of sample.buckets.filter(b=>b.target===r.minXp)){
    const g=groups.get(b.playerId)||{seconds:0,matches:0,xp:0,qualified:0,mobile:0,heavy:0,special:0,opponents:{},maps:{}};
    for(const k of ['seconds','matches','xp','qualified','mobile','heavy','special'])g[k]+=b[k];Object.assign(g.opponents,b.opponents);Object.assign(g.maps,b.maps);groups.set(b.playerId,g);
   }
   const players=[...groups.values()].filter(g=>g.matches>=3&&g.seconds>=900&&Object.keys(g.opponents).length>=3&&Object.keys(g.maps).length>=2);
   if(players.length<6){decisions.push({rank:RANKS[i].id,players:players.length,status:'insufficient'});continue;}
   // One vote per player, not per kill or hour. Estimate incremental work from
   // verified XP and capped technique receipts, never a client-supplied rank.
   const hours=median(players.map(g=>{
    const perHour=k=>g[k]*3600/g.seconds;
    const effort=(n,k)=>n<=0?0:perHour(k)>0?n/perHour(k):r.targetHours*4;
    return Math.max(effort(old.requiredXp-prev.requiredXp,'xp'),effort(old.techniques*old.each-prev.techniques*prev.each,'qualified'),
     ...['mobile','heavy','special'].map(k=>effort(old[k]-prev[k],k)));
   }));
   const direction=hours>r.targetHours*1.25?-1:hours<r.targetHours*.75?1:0;
   for(const k of adjustable){
    const desired=direction>0?Math.floor(old[k]*1.1):direction<0?Math.ceil(old[k]*.9):old[k];
    r[k]=Math.max(Math.ceil(base[k]*.7),rules[i-1][k]+(k==='requiredXp'?1:0),Math.min(Math.floor(base[k]*1.3),desired));
    // Do not let ordering corrections exceed this week's limit.
    if(r[k]>Math.floor(old[k]*1.1)||r[k]<Math.ceil(old[k]*.9))r[k]=old[k];
   }
   decisions.push({rank:RANKS[i].id,players:players.length,estimatedHours:Math.round(hours*10)/10,targetHours:r.targetHours,status:direction<0?'ease':direction>0?'tighten':'stable'});
  }
  validateRules(rules);
  const differs=JSON.stringify(rules)!==JSON.stringify(this.rules);
  if(differs)s.pending={announcedAt:now,effectiveAt:now+DAY,rules,decisions};
  this.audit({type:differs?'proposed':'unchanged',...details,decisions});return true;
 }
 setEnabled(enabled,actor){
  if(typeof enabled!=='boolean')throw Error('enabled must be boolean');
  if(enabled!==this.state.enabled){this.state.enabled=enabled;if(!enabled)this.state.pending=null;this.audit({type:enabled?'enabled':'disabled',actor});}
 }
 status(){
  const {players,matches,observedDays}=this.sample(),s=this.state;
  return {enabled:s.enabled,version:s.active.version,effectiveAt:s.active.effectiveAt,createdAt:s.createdAt,
   observation:{players,matches,observedDays},limits:OBSERVATION_LIMITS,rules:copy(s.active.rules),ranks:RANKS,
   pending:s.pending?copy(s.pending):null,nextReviewAt:(s.lastReviewWeek??koreaWeek(this.now()))+7*DAY,
   history:s.history.filter(e=>!['promotion','manual-edit-excluded','sample-excluded'].includes(e.type)).slice(-20).reverse().map(({actor,...e})=>e),
   explanation:'중위 이상 잠정 기준 · 최근 28일 검증 경기 · 매주 1회 평가 · 주간 ±10%, 초기 기준 ±30% · 적용 24시간 전 예고 · 획득 계급 보존'};
 }
}
