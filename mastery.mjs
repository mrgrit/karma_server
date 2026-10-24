import crypto from 'node:crypto';

// Stable weapon IDs, independent of the character holding a looted weapon.
export const TECHNIQUES = Object.freeze([
  [0,'special','악성 USB 주입'],[1,'special','패스워드 추측'],[2,'special','인증 재전송 공격'],
  [3,'mobile','TCP 세션 하이재킹'],[4,'special','DNS 반사 증폭'],[5,'precision','링크 스피어피싱'],
  [6,'special','메신저 스피어피싱'],[7,'mobile','TCP RST 주입'],[8,'precision','첨부파일 스피어피싱'],
  [9,'mobile','ARP 스푸핑'],[10,'mobile','SMB 릴레이'],[11,'mobile','DNS 캐시 포이즈닝'],
  [12,'mobile','중간자 공격 · MITM'],[13,'mobile','패스워드 스프레이'],[14,'mobile','DHCP 스푸핑'],
  [15,'mobile','크리덴셜 스터핑'],[16,'heavy','TCP SYN Flood'],[17,'heavy','HTTP 요청 Flood'],
  [18,'special','논리 폭탄'],[19,'special','압축 폭탄'],[20,'heavy','와이퍼 공격'],
  [21,'heavy','버퍼 오버플로 악용'],[22,'heavy','커널 취약점 악용'],
].map(([weaponId,family,name])=>Object.freeze({weaponId,family,name})));
export const PROMOTIONS = Object.freeze([
  {minXp:0,techniques:0,each:0,mobile:0,heavy:0,special:0},
  {minXp:1000,techniques:3,each:2,mobile:5,heavy:0,special:0},
  {minXp:3000,techniques:5,each:3,mobile:15,heavy:5,special:0},
  {minXp:6000,techniques:7,each:5,mobile:30,heavy:12,special:5},
  {minXp:10000,techniques:10,each:8,mobile:50,heavy:25,special:12},
].map(Object.freeze));
export const FAMILY_NAMES = Object.freeze({precision:'정밀',mobile:'기동',heavy:'중화기',special:'특수·보조'});
export const techniqueForWeapon = weapon => TECHNIQUES.find(t=>t.weaponId===weapon);
const count = n => {if(!Number.isSafeInteger(n)||n<0)throw Error('Invalid mastery counter');return n;};
export function newMastery(legacyXp=0){
  return {version:1,legacyRankXp:PROMOTIONS.filter(r=>r.minXp<=legacyXp).at(-1).minXp,
    successes:{},qualified:{},matchCounts:{}};
}
export function validateMastery(value){
  if(!value||value.version!==1||!PROMOTIONS.some(r=>r.minXp===value.legacyRankXp))throw Error('Invalid mastery version/rank');
  for(const field of ['successes','qualified','matchCounts']){
    const entries=value[field];
    if(!entries||typeof entries!=='object'||Array.isArray(entries))throw Error('Invalid mastery counters');
    for(const [key,n] of Object.entries(entries)){
      if(field==='matchCounts'?!/^[a-f0-9]{64}$/.test(key):!TECHNIQUES.some(t=>String(t.weaponId)===key))throw Error('Invalid mastery key');
      count(n);if(field==='matchCounts'&&n>3)throw Error('Invalid mastery match cap');
      if(field==='qualified'&&n>(value.successes[key]??0))throw Error('Invalid qualified count');
    }
  }
  return value;
}
export function recordMastery(profile,receipt){
  const m=validateMastery(profile.mastery??=newMastery(profile.xp));
  if(!receipt.verified||receipt.killerId!==profile.playerId||receipt.victimId===profile.playerId||!techniqueForWeapon(receipt.weapon))return;
  const weapon=String(receipt.weapon);
  m.successes[weapon]=count((m.successes[weapon]??0)+1);
  const key=crypto.createHash('sha256').update(JSON.stringify([receipt.matchId,receipt.victimId,receipt.weapon])).digest('hex');
  if((m.matchCounts[key]??0)<3){
    m.matchCounts[key]=(m.matchCounts[key]??0)+1;
    m.qualified[weapon]=count((m.qualified[weapon]??0)+1);
  }
}
export function masteryProgress(profile){
  const m=validateMastery(profile.mastery??newMastery(profile.xp));
  const families={precision:0,mobile:0,heavy:0,special:0};
  const techniques=TECHNIQUES.map(t=>{
    const qualified=m.qualified[t.weaponId]??0;
    families[t.family]+=qualified;
    return {...t,successes:m.successes[t.weaponId]??0,qualified};
  });
  const requirements=PROMOTIONS.map(rule=>{
    const completedTechniques=techniques.filter(t=>t.qualified>=rule.each).length;
    const passed=profile.xp>=rule.minXp&&completedTechniques>=rule.techniques&&
      ['mobile','heavy','special'].every(f=>families[f]>=rule[f]);
    return {...rule,completedTechniques,passed};
  });
  const eligible=requirements.filter(r=>profile.xp>=r.minXp&&(r.passed||r.minXp<=m.legacyRankXp)).at(-1);
  return {version:1,rankXp:eligible.minXp,legacyRankXp:m.legacyRankXp,families,techniques,
    next:requirements.find(r=>r.minXp>eligible.minXp)??null,requirements};
}
export const rankXpForProfile = profile => masteryProgress(profile).rankXp;
