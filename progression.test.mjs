import assert from 'node:assert/strict';
import fs from 'node:fs';
import {validateLoadout,characterUnlocked,rankForXp,DEFAULT_RANKS,CombatLedger,DropLedger} from './progression.mjs';

const catalog=JSON.parse(fs.readFileSync(new URL('./loadouts.json',import.meta.url),'utf8'));
const options={weapons:catalog.weapons,ranks:catalog.ranks,slotRules:catalog.slots,constraints:catalog.constraints};
const assault=catalog.characters.cpom_050,sniper=catalog.characters.cpoo_030,heavy=catalog.characters.cpom_020;
const dual=[50,9,21,22,255,255,255];
const validate=(character,inventory,xp=0,selectedWeapon=inventory.find(x=>x!==50&&x!==255))=>
 validateLoadout({...options,character,inventory,selectedWeapon,xp});

const thresholds=[0,1000,3000,6000,10000],bonuses=[0,100,200,300,400];
for(const ranks of [catalog.ranks,DEFAULT_RANKS]){
 assert.deepEqual(ranks.map(r=>r.minXp),thresholds,'Rank requirements are ten times the original local thresholds');
 assert.deepEqual(ranks.map(r=>r.budgetBonus),bonuses,'Equipment budget bonuses remain unchanged');
 for(let i=0;i<ranks.length;i++){
  assert.equal(rankForXp(thresholds[i],ranks).id,ranks[i].id,'Exact threshold promotes');
  if(i)assert.equal(rankForXp(thresholds[i]-1,ranks).id,ranks[i-1].id,'One XP short does not promote');
 }
 assert.equal(rankForXp(275,ranks).id,'recruit','Previously earned XP is evaluated against the slower progression');
}
assert.equal(catalog.constraints.dualCannon.minXp,catalog.ranks.find(r=>r.id==='sergeant').minXp,'Dual cannon stays a sergeant unlock');

for(const [id,character] of Object.entries(catalog.characters)){
 assert(['assault','sniper','heavy'].includes(character.role),id);
 assert(thresholds.includes(character.unlockXp),id+' unlock remains aligned to a rank');
 assert.equal(characterUnlocked(character,character.unlockXp),true,id);
 if(character.unlockXp>0){
  assert.equal(characterUnlocked(character,character.unlockXp-1),false,id);
  assert.throws(()=>validate(character,character.defaultInventory,character.unlockXp-1,character.defaultSelectedWeapon),/locked/,id);
 }
 const result=validate(character,character.defaultInventory,character.unlockXp,character.defaultSelectedWeapon);
 assert(result.cost<=result.budget,id+' default exceeds budget');
}
for(const camp of [0,1])assert.deepEqual(
 [...new Set(Object.values(catalog.characters).filter(c=>c.camp===camp&&c.unlockXp===0).map(c=>c.role))].sort(),
 ['assault','heavy','sniper'], 'Every team has all classes immediately');
assert.equal(validate(heavy,dual,6000,21).cost,1405);
assert.equal(validate(heavy,[50,255,21,22,255,255,255],6000,22).cost,850);
assert.doesNotThrow(()=>validate(heavy,[50,14,22,21,255,255,255],6000,22));
assert.throws(()=>validate(heavy,dual,5999,21),/6000 XP/);
for(const character of [assault,sniper])assert.throws(()=>validate(character,dual,10000,21),/unavailable|heavy/);
for(const [slot,item] of [[4,48],[5,23],[6,18]]){
 const loadout=[...dual];loadout[slot]=item;
 assert.throws(()=>validate(heavy,loadout,10000,21),/sacrificing/);
}
assert.throws(()=>validate(heavy,[50,9,21,21,255,255,255],6000,21),/duplicate/);
assert.throws(()=>validate(heavy,[50,16,21,20,255,255,255],10000,16),/Heavy weapon combination/);
assert.throws(()=>validate(heavy,[50,9,21,20,255,255,255],10000,21),/Secondary cannon/);
assert.throws(()=>validate(assault,[50,5,1,0,48,23,18],10000,5),/unavailable/);
assert.throws(()=>validate(sniper,[50,9,1,0,48,23,18],10000,9),/unavailable/);
assert.throws(()=>validate(sniper,[50,255,1,0,48,23,18],10000,1),/Required/);

function pickup({character=heavy,xp=6000,inventory=[50,9,21,255,255,255,255],weapon=22}){
 const combat=new CombatLedger({matchId:'dual-test',playerIds:['picker','victim']});
 const receipt=combat.confirmDeath('victim',{life:1,killer:'environment',weapon:-1,hpAfter:0}).receipt;
 const ledger=new DropLedger({matchId:'dual-test',playerIds:['picker','victim']});
 const {drop}=ledger.createDeathDrop(receipt,{selectedWeapon:weapon,magazine:0,reserve:7,pos:[0,0,0],sector:4});
 const state={life:1,hp:100,pos:[0,0,0],inventory};
 return ledger.claimDrop('picker',{dropId:drop.id,requestId:'claim',life:1},
  {state,character,xp,weapons:catalog.weapons,ranks:catalog.ranks,constraints:catalog.constraints});
}
assert.equal(pickup({}).granted,true,'Heavy veteran can collect second distinct cannon');
assert.deepEqual([pickup({}).grant.magazine,pickup({}).grant.reserve],[0,7],'Exact remaining ammunition survives');
assert.equal(pickup({xp:5999}).granted,false,'Loot cannot bypass rank');
assert.equal(pickup({character:assault}).granted,false,'Loot cannot bypass heavy-class requirement for two cannons');
assert.equal(pickup({inventory:[50,9,21,255,48,255,255]}).granted,false,'Loot cannot retain armor with two cannons');
assert.equal(pickup({inventory:[50,9,21,22,255,255,255],weapon:14}).granted,false,'Only one light automatic even after loot');
assert.equal(pickup({inventory:[50,9,21,22,255,255,255],weapon:1}).granted,false,'Pistol cannot be added to dual loadout');
assert.equal(pickup({inventory:[50,9,21,255,255,255,255],weapon:9}).reason,'weapon-already-owned','Picking up the same gun cannot replace existing ammunition');
assert.equal(pickup({inventory:[50,16,255,255,255,255,255]}).granted,false,'Machine gun + launcher restriction also covers loot');
assert.equal(pickup({character:assault,xp:0,inventory:[50,9,255,255,255,255,255],weapon:21}).granted,true,
 'A single enemy cannon remains lootable across classes');
const manual=new DropLedger({matchId:'manual-drop',playerIds:['picker','victim']});
const manualState={life:1,hp:100,pos:[1,2,3],sector:4,inventory:[50,9,255,255,48,24,255],selectedWeapon:9,ammo:{9:{magazine:0,reserve:7}}};
const manualRequest={requestId:'drop-1',life:1,weapon:9,magazine:0,reserve:7};
const manualResult=manual.dropWeapon('picker',manualRequest,{state:manualState,weapons:catalog.weapons});
assert.equal(manualResult.granted,true);assert.equal(manualResult.grant.selectedWeapon,0);
assert.equal(manualResult.grant.inventory[1],0,'Last gun is replaced with knife fallback');
assert.deepEqual([manualResult.grant.drop.magazine,manualResult.grant.drop.reserve],[0,7]);
assert.equal(manual.dropWeapon('picker',manualRequest,{state:manualState,weapons:catalog.weapons}).duplicate,true);
assert.equal(manual.drops.size,1,'Duplicate request never creates another drop');
assert.equal(manual.dropWeapon('picker',{...manualRequest,reserve:8},{state:manualState,weapons:catalog.weapons}).reason,'conflicting-request');
assert.equal(manual.dropWeapon('picker',manualRequest,{state:{...manualState,life:2},weapons:catalog.weapons}).reason,'dead-or-stale-life');
assert.equal(manual.dropWeapon('picker',{...manualRequest,requestId:'drop-2',weapon:0},{state:{...manualState,inventory:[0],selectedWeapon:0},weapons:catalog.weapons}).reason,'cannot-drop-item');
const restoredManual=new DropLedger({matchId:'manual-drop',playerIds:['picker','victim'],snapshot:manual.snapshot()});
assert.equal(restoredManual.dropWeapon('picker',manualRequest,{state:manualState,weapons:catalog.weapons}).duplicate,true,'Snapshot preserves manual-drop request idempotency');
console.log('PASS progression: all character defaults/unlock boundaries, all three starter classes per camp, rank/class dual cannon, 1405-point preset, optional light weapon, equipment sacrifice and exact-ammo pickup enforcement.');
