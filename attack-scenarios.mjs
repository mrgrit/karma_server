import fs from 'node:fs';
// Stable map:weapon IDs preserve all promotion counters when labels expand.
const data=JSON.parse(fs.readFileSync(new URL('./attack-curriculum.json',import.meta.url),'utf8'));
if(data.schemaVersion!==1||data.maps.length!==15)throw Error('Invalid attack curriculum');
const names=new Set(),ids=new Set();
for(const map of data.maps){
 if(!Number.isInteger(map.map)||map.map<0||map.map>19||ids.has(map.map)||map.names.length!==23||!Number.isInteger(map.level)||map.level<0||map.level>12)throw Error('Invalid curriculum map');
 ids.add(map.map);
 for(const name of map.names){if(typeof name!=='string'||!name.trim()||name.length>80||names.has(name))throw Error('Invalid or duplicate attack label');names.add(name);}
 Object.freeze(map.names);Object.freeze(map);
}
export const ATTACK_CURRICULUM=Object.freeze({...data,maps:Object.freeze(data.maps)});
export const MAP_ATTACK_NAMES=Object.freeze(Object.fromEntries(data.maps.map(m=>[m.map,m.names])));
const metadata=new Map(data.maps.map(m=>[m.map,m]));
export function scenarioForWeapon(map,weapon){
 if(!Number.isInteger(map)||map<0||map>19||!Number.isInteger(weapon)||weapon<0||weapon>22)return null;
 const entry=metadata.get(map),name=(MAP_ATTACK_NAMES[map]||MAP_ATTACK_NAMES[0])[weapon];
 return {id:`${map}:${weapon}`,map,weaponId:weapon,name,mapped:!!entry,level:entry?.level??null,topic:entry?.topic??'공개 순서 미정 · 기초 공통'};
}
