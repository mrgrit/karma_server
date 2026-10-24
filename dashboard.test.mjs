import fs from 'node:fs';
import vm from 'node:vm';
import assert from 'node:assert/strict';
import {fileURLToPath} from 'node:url';
import {newMastery,masteryProgress,PROMOTIONS,TECHNIQUES,FAMILY_NAMES} from './mastery.mjs';
const root=fileURLToPath(new URL('./',import.meta.url));
const html=fs.readFileSync(root+'public/index.html','utf8');
const js=fs.readFileSync(root+'public/app.js','utf8');
const css=fs.readFileSync(root+'public/style.css','utf8');
const server=fs.readFileSync(root+'server.mjs','utf8');
const catalog=JSON.parse(fs.readFileSync(root+'loadouts.json','utf8').replace(/^\uFEFF/,''));
const ids=[...html.matchAll(/\bid="([^"]+)"/g)].map(m=>m[1]);
assert.equal(new Set(ids).size,ids.length,'HTML IDs must be unique');
const dynamic=new Set(['loadout-character-select']);
for(const [,id]of js.matchAll(/\$\('([^']+)'\)/g))
 assert(ids.includes(id)||dynamic.has(id),'Missing DOM target '+id);
for(const [,id]of html.matchAll(/\bdata-close="([^"]+)"/g))assert(ids.includes(id),'Missing dialog '+id);
for(const [,name]of html.matchAll(/\bdata-view="([^"]+)"/g))assert(ids.includes(name+'-view'),'Missing page '+name);
for(const key of ['xp','kills','deaths','wins','losses','draws','disabled','loadouts'])
 assert(html.includes(`name="${key}"`),'Missing admin form field '+key);
for(const endpoint of ['/api/auth-config','/api/me','/api/dashboard','/api/leaderboard','/api/admin/users',
 '/auth/login','/auth/logout','/auth/register/request','/auth/register/verify'])
 assert(server.includes(endpoint)&&js.includes(endpoint),'Unmatched endpoint '+endpoint);
assert(!js.includes('innerHTML')&&!js.includes('insertAdjacentHTML'),'Untrusted API text must never become markup');
assert(!/@import|url\(["']?https?:/i.test(css),'Local dashboard should not depend on remote assets');
assert(!/\blocalStorage\b/.test(js),'Session token must not persist across browser sessions');
class Element{
 constructor(tag){this.tagName=tag;this.children=[];this.attributes={};this.dataset={};}
 set textContent(value){this.value=String(value);this.children=[];}
 get textContent(){return(this.value||'')+this.children.map(x=>x.textContent).join('');}
 append(...nodes){this.children.push(...nodes);}
 replaceChildren(...nodes){this.value='';this.children=[...nodes];}
}
const context={sessionStorage:{getItem:()=>null},
 document:{createElement:t=>new Element(t),createTextNode:text=>({textContent:String(text)}),getElementById:()=>null},
 console,Date,setTimeout,clearTimeout,setInterval:()=>0,clearInterval};
vm.createContext(context);
const prefix=js.slice(0,js.indexOf("$('auth-form').addEventListener"));
const validate=js.slice(js.indexOf('function validateLoadouts(value)'),js.indexOf("$('edit-form').addEventListener"));
vm.runInContext(prefix+validate+
 '\nglobalThis.test={state,rankProgress,rankName,kd,totalMatches,loadoutNumbers,characterById,validateLoadouts,renderLeaderboard,activityText,masterySummary,masteryDetails};})();',context);
const t=context.test;
t.state.catalog=catalog;
const characterId=Object.keys(catalog.characters)[0],character=catalog.characters[characterId];
assert(t.characterById(characterId),'Actual object-shaped catalog.characters must resolve');
t.state.me={playerId:'me',rank:{budgetBonus:100}};
const equipment=t.loadoutNumbers([characterId,{inventory:catalog.defaultInventory,selectedWeapon:9}]);
assert.equal(equipment.cost,catalog.defaultInventoryCost);
assert.equal(equipment.budget,character.inventoryCapacity+100,'Never add character.inventoryBonus twice');
assert.equal(t.kd({kills:0,deaths:0}),'0.00');
assert.equal(t.kd({kills:9,deaths:3}),'3.00');
assert.equal(t.kd({kills:9,deaths:0}),'9 · 무사망');
assert.equal(t.totalMatches({wins:3,losses:2,draws:1}),6);
const progress=t.rankProgress({xp:0,rank:catalog.ranks[0]});
assert(progress.percent>=0&&progress.percent<=100);
const stalled={xp:10000,rankXp:0,rank:catalog.ranks[0],mastery:masteryProgress({xp:10000,mastery:newMastery()})};
assert.equal(t.rankProgress(stalled).next.minXp,1000,'XP above all thresholds still shows the first incomplete rank');
assert.equal(t.rankProgress(stalled).percent,100,'XP progress is clamped');
t.state.catalog.mastery={promotions:PROMOTIONS,techniques:TECHNIQUES,families:FAMILY_NAMES};
assert(t.masterySummary(stalled).includes('기법 0/3종'));
assert(t.masterySummary(stalled).includes('중화기 0/0'));
assert(t.masteryDetails(stalled).textContent.includes('링크 스피어피싱'));
assert(t.masteryDetails(stalled).textContent.includes('승급 인정'));
assert.throws(()=>t.validateLoadouts({bad:{inventory:[9,9,1,6,48,24,18],selectedWeapon:9}}),/중복/);
assert.throws(()=>t.validateLoadouts({bad:{inventory:[50,9,1,6,48,24,18],selectedWeapon:10}}),/시작/);
assert.throws(()=>t.validateLoadouts({bad:{inventory:[50,9,1,6,48,24,-1],selectedWeapon:9}}),/ID/);
assert.doesNotThrow(()=>t.validateLoadouts({[characterId]:{inventory:[50,9,1,6,48,24,18],selectedWeapon:9}}));
const container=new Element('div'),payload='<img src=x onerror=alert(1)>';
t.renderLeaderboard(container,[{playerId:'me',name:payload,rank:{name:'훈련병'},xp:10,kills:1,deaths:2,wins:0,losses:1,draws:0,email:'private@example.com'}]);
assert(container.textContent.includes(payload),'Display name remains literal text');
assert(!container.textContent.includes('private@example.com'),'Public ranking must not leak email');
function tags(node){return[node.tagName,...(node.children||[]).flatMap(tags)];}
assert(!tags(container).includes('img'),'Untrusted name cannot create an image element');
assert(t.activityText({event:'admin-user-update'})[0].includes('관리자'));
console.log('PASS: DOM IDs/forms/navigation; server API contract; object catalog; exact equipment budget; rank/KD/match calculations; loadout validation; safe text rendering; leaderboard email privacy; no remote asset dependency.');
