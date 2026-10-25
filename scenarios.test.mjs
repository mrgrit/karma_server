import assert from 'node:assert/strict';import {MAP_ATTACK_NAMES,scenarioForWeapon,ATTACK_CURRICULUM} from './attack-scenarios.mjs';
import {newMastery,recordMastery,validateMastery,masteryProgress} from './mastery.mjs';
assert.equal(Object.values(MAP_ATTACK_NAMES).flat().length,345);assert.equal(new Set(Object.values(MAP_ATTACK_NAMES).flat()).size,345);
for(const names of Object.values(MAP_ATTACK_NAMES))assert.equal(names.length,23);
assert.equal(scenarioForWeapon(99,9),null);assert.notEqual(scenarioForWeapon(0,9).name,scenarioForWeapon(7,9).name);
const profile={xp:0,mastery:newMastery(),playerId:'a'};
for(const map of [0,7,4])for(let i=0;i<4;i++)recordMastery(profile,{map,weapon:9,verified:true,killerId:'a',victimId:'b',matchId:'m'+map});
validateMastery(profile.mastery);const p=masteryProgress(profile);
assert.equal(p.techniques.find(t=>t.weaponId===9).successes,12);assert.equal(p.techniques.find(t=>t.weaponId===9).qualified,9);
assert.equal(p.scenarios.length,3);assert(p.scenarios.every(t=>t.successes===4&&t.qualified===3));
assert.equal(p.families.mobile,9,'map changes preserve weapon-family promotion requirements');
const old={...profile,mastery:newMastery(1000)};assert.deepEqual(masteryProgress(old).scenarios,[],'never fabricate historical map counts');
recordMastery(profile,{map:18,weapon:5,verified:true,killerId:'a',victimId:'b',matchId:'new-map'});
validateMastery(profile.mastery);
assert.equal(masteryProgress(profile).scenarios.find(s=>s.map===18).successes,1,'new map records survive after custom labels are assigned');
console.log('PASS scenarios: 345 distinct display labels, unknown map fallback, per-map persisted counts, opponent cap and stable promotion aggregates');

const order=[18,11,12,15,9,8,13,14,19,10,17,16];
assert.deepEqual(ATTACK_CURRICULUM.maps.filter(m=>m.level>0).map(m=>m.map),order);
for(const [i,map] of order.entries())for(let weapon=0;weapon<23;weapon++){
 const scenario=scenarioForWeapon(map,weapon);assert.equal(scenario.level,i+1);assert(scenario.mapped);assert.equal(scenario.id,`${map}:${weapon}`);
}
for(const map of [1,2,3,5,6]){assert.equal(scenarioForWeapon(map,9).mapped,false);assert.equal(scenarioForWeapon(map,9).level,null);}
assert.equal(scenarioForWeapon(18,5).name,'학과 공지 사칭 스피어피싱');
assert.equal(scenarioForWeapon(16,22).name,'BYOVD 커널 권한 상승');
const persisted=JSON.parse(JSON.stringify(profile));const before=JSON.stringify(persisted.mastery);masteryProgress(persisted);assert.equal(JSON.stringify(persisted.mastery),before);
assert.equal(scenarioForWeapon(18,23),null);assert.equal(scenarioForWeapon(18,-1),null);
