import assert from 'node:assert/strict';
import fs from 'node:fs';
import {validateLoadout,characterUnlocked,CombatLedger,DropLedger} from './progression.mjs';

const catalog=JSON.parse(fs.readFileSync(new URL('./loadouts.json',import.meta.url),'utf8'));
const options={weapons:catalog.weapons,ranks:catalog.ranks,slotRules:catalog.slots,constraints:catalog.constraints};
const assault=catalog.characters.cpom_050,sniper=catalog.characters.cpoo_030,heavy=catalog.characters.cpom_020;
const dual=[50,9,21,22,255,255,255];
const validate=(character,inventory,xp=0,selectedWeapon=inventory.find(x=>x!==50&&x!==255))=>
 validateLoadout({...options,character,inventory,selectedWeapon,xp});

for(const [id,character] of Object.entries(catalog.characters)){
 assert(['assault','sniper','heavy'].includes(character.role),id);
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
assert.equal(validate(heavy,dual,600,21).cost,1405);
assert.equal(validate(heavy,[50,255,21,22,255,255,255],600,22).cost,850);
assert.doesNotThrow(()=>validate(heavy,[50,14,22,21,255,255,255],600,22));
assert.throws(()=>validate(heavy,dual,599,21),/600 XP/);
for(const character of [assault,sniper])assert.throws(()=>validate(character,dual,1000,21),/unavailable|heavy/);
for(const [slot,item] of [[4,48],[5,23],[6,18]]){
 const loadout=[...dual];loadout[slot]=item;
 assert.throws(()=>validate(heavy,loadout,1000,21),/sacrificing/);
}
assert.throws(()=>validate(heavy,[50,9,21,21,255,255,255],600,21),/duplicate/);
assert.throws(()=>validate(heavy,[50,16,21,20,255,255,255],1000,16),/Heavy weapon combination/);
assert.throws(()=>validate(heavy,[50,9,21,20,255,255,255],1000,21),/Secondary cannon/);
assert.throws(()=>validate(assault,[50,5,1,0,48,23,18],1000,5),/unavailable/);
assert.throws(()=>validate(sniper,[50,9,1,0,48,23,18],1000,9),/unavailable/);
assert.throws(()=>validate(sniper,[50,255,1,0,48,23,18],1000,1),/Required/);

function pickup({character=heavy,xp=600,inventory=[50,9,21,255,255,255,255],weapon=22}){
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
assert.equal(pickup({xp:599}).granted,false,'Loot cannot bypass rank');
assert.equal(pickup({character:assault}).granted,false,'Loot cannot bypass heavy-class requirement for two cannons');
assert.equal(pickup({inventory:[50,9,21,255,48,255,255]}).granted,false,'Loot cannot retain armor with two cannons');
assert.equal(pickup({inventory:[50,9,21,22,255,255,255],weapon:14}).granted,false,'Only one light automatic even after loot');
assert.equal(pickup({inventory:[50,9,21,22,255,255,255],weapon:1}).granted,false,'Pistol cannot be added to dual loadout');
assert.equal(pickup({inventory:[50,16,255,255,255,255,255]}).granted,false,'Machine gun + launcher restriction also covers loot');
assert.equal(pickup({character:assault,xp:0,inventory:[50,9,255,255,255,255,255],weapon:21}).granted,true,
 'A single enemy cannon remains lootable across classes');
console.log('PASS progression: all character defaults/unlock boundaries, all three starter classes per camp, rank/class dual cannon, 1405-point preset, optional light weapon, equipment sacrifice and exact-ammo pickup enforcement.');
