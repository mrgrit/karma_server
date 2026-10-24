/* KARMA dashboard: no dependencies, same-origin API, text-only data rendering. */
(() => {
'use strict';
const $=id=>document.getElementById(id);
const titles={
 overview:['종합 현황','COMMAND OVERVIEW','나의 전투 기록과 서버의 현재 상황을 확인하세요.'],
 loadout:['내 장비','PERSONAL LOADOUT','캐릭터에 저장된 시작 장비와 점수 한도를 확인하세요.'],
 leaderboard:['명예의 전당','LEADERBOARD','서버에서 기록한 경험치와 전투 성과를 확인하세요.'],
 activity:['활동 기록','OPERATIONS LOG','최근 경기와 서버의 활동을 확인하세요.'],
 chatlogs:['채팅 기록','CHAT ARCHIVE','전체·팀 채팅과 마스킹 기록을 확인하세요.'],
 admin:['사용자 관리','PERSONNEL MANAGEMENT','사용자 계정, 전적과 저장 장비를 관리하세요.']
};
const state={token:null,me:null,catalog:{},players:[],dashboard:null,activity:[],users:[],
 authMode:'login',verification:false,authConfig:{registrationAvailable:true,emailVerificationRequired:false},
 registration:null,editing:null,loading:false,view:'overview',selectedCharacter:null};
try{state.token=sessionStorage.getItem('karma.auth.v1');}catch{}
let toastTimer,codeTimer;
const number=value=>Number.isFinite(Number(value))?Math.max(0,Number(value)):0;
const count=value=>Math.floor(number(value));
const format=value=>count(value).toLocaleString('ko-KR');
function node(tag,text,className){
 const element=document.createElement(tag);
 if(text!==undefined&&text!==null)element.textContent=String(text);
 if(className)element.className=className;
 return element;
}
function setText(id,text){$(id).textContent=String(text);}
function isAdmin(){return state.me?.isAdmin===true||state.me?.role==='admin';}
function rankName(rank){return typeof rank==='string'?rank:rank?.name||rank?.id||'훈련병';}
function displayName(profile){return profile?.name||profile?.displayName||'이름 없는 사용자';}
function totalMatches(profile){return count(profile?.matches??(count(profile?.wins)+count(profile?.losses)+count(profile?.draws)));}
function kd(profile){
 const kills=count(profile?.kills),deaths=count(profile?.deaths);
 return deaths?(kills/deaths).toFixed(2):kills?`${format(kills)} · 무사망`:'0.00';
}
function dateText(value){
 const d=new Date(value);return Number.isNaN(d.getTime())?'시간 미상':d.toLocaleString('ko-KR',{month:'2-digit',day:'2-digit',hour:'2-digit',minute:'2-digit'});
}
function relativeTime(value){
 const d=new Date(value),delta=Date.now()-d.getTime();
 if(!Number.isFinite(delta))return '';
 if(delta<60000)return '방금 전';
 if(delta<3600000)return `${Math.floor(delta/60000)}분 전`;
 if(delta<86400000)return `${Math.floor(delta/3600000)}시간 전`;
 return dateText(value);
}
function saveToken(token){
 state.token=token||null;
 try{if(token)sessionStorage.setItem('karma.auth.v1',token);else sessionStorage.removeItem('karma.auth.v1');}catch{}
}
function message(id,text){$(id).hidden=!text;$(id).textContent=text||'';}
function toast(text){clearTimeout(toastTimer);message('toast',text);toastTimer=setTimeout(()=>message('toast',''),4500);}
function errorText(error){
 const known={
  INVALID_CREDENTIALS:'이메일 또는 비밀번호를 확인해 주세요.',BAD_CREDENTIALS:'이메일 또는 비밀번호를 확인해 주세요.',
  EMAIL_EXISTS:'이미 가입된 이메일입니다. 로그인해 주세요.',ACCOUNT_DISABLED:'비활성화된 계정입니다. 관리자에게 문의해 주세요.',
  RATE_LIMITED:'요청이 많습니다. 잠시 후 다시 시도해 주세요.',INVALID_CODE:'인증 코드가 올바르지 않거나 만료되었습니다.',
  UNAUTHORIZED:'로그인이 필요합니다.',FORBIDDEN:'이 작업을 수행할 권한이 없습니다.',
  REGISTRATION_DISABLED:'현재 회원가입을 사용할 수 없습니다.'
 };
 return known[error.code]||error.message||'요청을 완료하지 못했습니다.';
}
async function api(endpoint,{method='GET',body,anonymous=false}={}){
 const headers={Accept:'application/json'};
 if(body!==undefined)headers['Content-Type']='application/json';
 if(state.token&&!anonymous)headers.Authorization='Bearer '+state.token;
 let response;
 try{response=await fetch(endpoint,{method,headers,body:body===undefined?undefined:JSON.stringify(body),credentials:'same-origin',cache:'no-store'});}
 catch{throw Object.assign(new Error('서버에 연결할 수 없습니다. 연결 상태를 확인해 주세요.'),{code:'NETWORK'});}
 let result;
 try{result=await response.json();}catch{throw new Error('서버 응답 형식을 확인할 수 없습니다.');}
 if(!response.ok||result.ok===false){
  const details=result.error||{};
  const error=Object.assign(new Error(typeof details==='string'?details:details.message||`요청 실패 (${response.status})`),{
   code:typeof details==='string'?details:details.code,status:response.status});
  if(response.status===401&&state.token&&!anonymous){
   saveToken(null);state.me=null;state.users=[];renderIdentity();
  }
  throw error;
 }
 return result;
}
function setConnection(ok){
 $('connection-label').classList.toggle('online',ok);
 $('connection-label').replaceChildren(node('i'),document.createTextNode(ok?'서버 연결됨':'연결 확인 필요'));
 $('sidebar-status').parentElement.classList.toggle('online',ok);
 setText('sidebar-status',ok?'서버 연결됨':'서버에 연결할 수 없음');
 setText('operation-status',ok?'운영 중':'연결 확인');
}
function empty(target,text){target.replaceChildren(node('div',text,'empty'));}
function view(name,writeHash=true){
 if(!(name in titles))name='overview';
 if(['admin','chatlogs'].includes(name)&&!isAdmin())name='overview';
 state.view=name;
 document.querySelectorAll('.view').forEach(el=>el.hidden=el.id!==`${name}-view`);
 document.querySelectorAll('.nav-item').forEach(el=>{
  const active=el.dataset.view===name;el.classList.toggle('active',active);
  if(active)el.setAttribute('aria-current','page');else el.removeAttribute('aria-current');
 });
 const [title,eyebrow,description]=titles[name];
 setText('page-title',title);setText('breadcrumb-title',title);setText('page-eyebrow',eyebrow);setText('page-description',description);
 if(writeHash&&location.hash!==`#${name}`)history.replaceState(null,'',`#${name}`);
 document.title=`${title} · KARMA`;
 if(name==='admin'&&isAdmin())renderUsers();
 if(name==='chatlogs'&&isAdmin()&&!state.chatLoaded)loadChatLogs(false);
}
function renderIdentity(){
 const p=state.me,logged=!!p;
 $('login-button').hidden=logged;$('logout-button').hidden=!logged;$('admin-nav').hidden=!isAdmin();$('chatlogs-nav').hidden=!isAdmin();
 if(!isAdmin()){state.chatEntries=[];state.chatLoaded=false;state.chatCursor=null;$('chatlog-table').replaceChildren();$('chatlog-original').checked=false;}
 setText('account-name',logged?displayName(p):'방문자');
 setText('account-initial',logged?Array.from(displayName(p))[0]:'—');
 setText('account-role',logged?(isAdmin()?'서버 관리자':rankName(p.rank)):'로그인하고 기록을 확인하세요');
 if(!logged&&['admin','chatlogs'].includes(state.view))view('overview');
}
function rankProgress(profile){
 const ranks=Array.isArray(state.catalog.ranks)?[...state.catalog.ranks].sort((a,b)=>number(a.minXp)-number(b.minXp)):[];
 const xp=count(profile.xp),rankXp=count(profile.rankXp??profile.xp),current=profile.rank||ranks.filter(r=>rankXp>=number(r.minXp)).at(-1)||{};
 const next=ranks.find(r=>number(r.minXp)>rankXp);
 const range=next?number(next.minXp)-number(current.minXp):0;
 return {xp,current,next,percent:next&&range>0?Math.max(0,Math.min(100,(xp-number(current.minXp))/range*100)):ranks.length?100:0};
}
function masterySummary(profile){
 const m=profile.mastery,n=m?.next;
 if(!m)return '아직 기법 실적이 없습니다.';
 if(!n)return '최고 계급 · 기법 실적은 계속 누적됩니다.';
 const rank=state.catalog.ranks?.find(r=>number(r.minXp)===n.minXp);
 return `${rankName(rank)}: XP ${format(profile.xp)}/${format(n.minXp)} · 기법 ${n.completedTechniques}/${n.techniques}종 (각 ${n.each}회) · 기동 ${m.families.mobile}/${n.mobile} · 중화기 ${m.families.heavy}/${n.heavy} · 특수·보조 ${m.families.special}/${n.special}`;
}
function masteryDetails(profile){
 const box=node('details'),summary=node('summary','무기별 누적 숙련');box.append(summary);
 const table=node('table'),head=node('tr');
 ['무기 / 대표 기법 (모든 맵 합산)','계열','전체 성공','승급 인정'].forEach(x=>head.append(node('th',x)));table.append(head);
 for(const t of profile.mastery?.techniques||[]){
  const weapon=state.catalog.weapons?.find(w=>w.id===t.weaponId||w.weaponId===t.weaponId);
  const row=node('tr');row.append(node('td',`${weapon?.name||t.weaponId} · ${t.name}`),node('td',state.catalog.mastery?.families?.[t.family]||t.family),node('td',format(t.successes)),node('td',format(t.qualified)));table.append(row);
 }
 const wrap=node('div',null,'table-wrap');wrap.append(table);box.append(wrap);return box;
}
function renderMastery(){
 const rules=$('promotion-rules');rules.replaceChildren();
 const table=node('table'),head=node('tr');
 ['승급','누적 XP','기법 다양성','기동','중화기','특수·보조'].forEach(x=>head.append(node('th',x)));table.append(head);
 for(const rule of state.catalog.mastery?.promotions||[]){
  if(!rule.minXp)continue;
  const row=node('tr'),rank=state.catalog.ranks?.find(r=>number(r.minXp)===rule.minXp);
  [rankName(rank),format(rule.minXp),`${rule.techniques}종 × 각 ${rule.each}회`,`${rule.mobile}회`,`${rule.heavy}회`,`${rule.special}회`].forEach(x=>row.append(node('td',x)));table.append(row);
 }
 rules.append(table);
 const own=$('mastery-progress');own.replaceChildren(node('p',state.me?masterySummary(state.me):'로그인하면 승급 진행 상황을 확인할 수 있습니다.'));
 if(state.me){own.append(masteryDetails(state.me));
   const entries=state.me.mastery?.scenarios||[];
   if(entries.length){const detail=node('details');detail.append(node('summary','맵별 공격 기법 실적'));
     for(const e of entries)detail.append(node('p',`맵 ${e.map} · ${e.name}: 전체 ${e.successes}회 / 승급 인정 ${e.qualified}회`));own.append(detail);}
 }
}
function savedLoadouts(){
 const value=state.me?.loadouts;
 return value&&typeof value==='object'&&!Array.isArray(value)?Object.entries(value).filter(([,l])=>Array.isArray(l?.inventory)):[];
}
function chosenLoadout(){
 const entries=savedLoadouts();
 return entries.find(([id])=>id===state.selectedCharacter)||entries[0]||null;
}
function characterById(id){
 const characters=state.catalog.characters||{};
 if(!Array.isArray(characters)&&characters[id])return characters[id];
 return (Array.isArray(characters)?characters:Object.values(characters))
  .find(c=>String(c.id??c.catalogId)===String(id));
}
function weaponById(id){return (state.catalog.weapons||[]).find(w=>Number(w.weaponId??w.id)===Number(id));}
function loadoutNumbers(entry){
 if(!entry)return {cost:null,budget:null,character:null};
 const [id,l]=entry,c=characterById(id),records=l.inventory.filter(w=>w!==255).map(weaponById);
 const cost=records.every(Boolean)?records.reduce((sum,w)=>sum+number(w.inventoryCost),0):null;
 const budget=c&&Number.isFinite(Number(c.inventoryCapacity))?number(c.inventoryCapacity)+number(state.me?.rank?.budgetBonus):null;
 return {cost,budget,character:c};
}
function renderProfile(){
 renderIdentity();renderMastery();
 const p=state.me;
 if(!p){
  setText('profile-id','—');setText('profile-name','전투 기록을 연결하세요');setText('profile-rank','로그인이 필요합니다');
  setText('xp-label','경험치 —');setText('next-rank-label','다음 계급 —');setText('rank-progress-detail','전투에 참여하고 계급을 높이세요.');
  $('rank-progress').firstElementChild.style.width='0%';$('rank-progress').setAttribute('aria-valuenow','0');
  for(const id of ['stat-kd','stat-winrate','stat-results','stat-budget'])setText(id,'—');
  setText('stat-kd-ratio','K/D —');setText('stat-matches','로그인하면 전적을 확인할 수 있습니다.');
  setText('stat-budget-detail','캐릭터와 계급에 따라 결정');renderLoadout();return;
 }
 const progress=rankProgress(p),matches=totalMatches(p),equipment=loadoutNumbers(chosenLoadout());
 setText('profile-id',String(p.playerId||p.id||'').slice(0,8).toUpperCase());
 setText('profile-name',displayName(p));setText('profile-rank',rankName(p.rank));
 setText('xp-label',`${format(p.xp)} XP`);setText('next-rank-label',progress.next?`${rankName(progress.next)} · ${format(progress.next.minXp)} XP`:'현재 계급');
 $('rank-progress').firstElementChild.style.width=progress.percent.toFixed(1)+'%';
 $('rank-progress').setAttribute('aria-valuenow',String(Math.round(progress.percent)));
 setText('rank-progress-detail',p.mastery?masterySummary(p):progress.next?`다음 계급까지 ${format(Math.max(0,number(progress.next.minXp)-progress.xp))} XP`:'서버에 저장된 계급과 경험치입니다.');
 $('stat-kd').replaceChildren(document.createTextNode(format(p.kills)+' '),node('small','/ '+format(p.deaths)));
 setText('stat-kd-ratio','K/D '+kd(p));
 $('stat-winrate').replaceChildren(document.createTextNode(matches?(count(p.wins)/matches*100).toFixed(1):'0'),node('small','%'));
 setText('stat-matches',`총 ${format(matches)}경기`);
 $('stat-results').replaceChildren(document.createTextNode(format(p.wins)+' '),node('small',`/ ${format(p.losses)} / ${format(p.draws)}`));
 setText('stat-budget',equipment.budget===null?'—':format(equipment.budget));
 setText('stat-budget-detail',equipment.cost===null?'저장된 캐릭터 장비 기준':`${format(equipment.cost)}점 사용 · ${equipment.budget===null?'한도 정보 없음':format(Math.max(0,equipment.budget-equipment.cost))+'점 남음'}`);
 renderLoadout();
}
function renderLoadout(){
 const list=$('loadout-list'),entry=chosenLoadout(),entries=savedLoadouts();
 list.replaceChildren();
 if(!entry){
  setText('loadout-character','캐릭터 장비');setText('loadout-summary-text',state.me?'저장된 시작 장비가 없습니다. 실행기에서 캐릭터와 장비를 선택하세요.':'로그인하면 저장된 장비 구성을 확인할 수 있습니다.');
  setText('loadout-cost','—');setText('loadout-capacity','/ — 점');
  empty(list,state.me?'저장된 장비 구성이 없습니다.':'로그인 후 확인할 수 있습니다.');
  $('loadout-character-select')?.remove();return;
 }
 const [id,l]=entry,{cost,budget,character}=loadoutNumbers(entry);
 state.selectedCharacter=id;
 setText('loadout-character',character?.name||character?.displayName||id);
 const role=character?.roleName||'병과 정보 없음',unlock=character?.unlockRankName||'훈련병';
 const dual=(state.catalog.constraints?.dualCannon?.cannonIds||[21,22]).filter(id=>l.inventory.includes(id)).length===2;
 setText('loadout-summary-text',`${role} · ${unlock} 해금 · ${dual?'쌍포 구성 · ':''}시작 장비 ${l.inventory.filter(x=>x!==255).length}개 · ${rankName(state.me.rank)} 기준`);
 setText('loadout-cost',cost===null?'—':format(cost));setText('loadout-capacity',`/ ${budget===null?'—':format(budget)} 점`);
 let select=$('loadout-character-select');
 if(entries.length>1){
  if(!select){select=node('select');select.id='loadout-character-select';select.setAttribute('aria-label','저장된 캐릭터 선택');
   select.addEventListener('change',()=>{state.selectedCharacter=select.value;renderProfile();});
   $('loadout-summary-text').after(select);
  }
  select.replaceChildren(...entries.map(([key])=>{const c=characterById(key),option=node('option',c?.name||key);option.value=key;return option;}));
  select.value=id;
 }else select?.remove();
 l.inventory.forEach((id,index)=>{
  const weapon=weaponById(id),selected=id===l.selectedWeapon,card=node('article',undefined,'weapon-card'+(selected?' equipped':''));
  const slot=(state.catalog.slots||[]).find(s=>s.index===index);
  card.append(node('div',`${String(index+1).padStart(2,'0')} / ${slot?.name||'추가 장비'}`,'weapon-slot'));
  card.append(node('h3',id===255?'빈 슬롯':weapon?.name||`장비 #${id}`));
  if(selected)card.append(node('span','시작 무기','equipped-label'));
  const meta=node('div',undefined,'weapon-meta');
  meta.append(node('span',id===255?'미장착':weapon?.category||'등록 장비'),
   node('span',id===255?'0점':weapon?`${format(weapon.inventoryCost)}점`:'점수 정보 없음'));
  card.append(meta);list.append(card);
 });
}
function renderLeaderboard(target,players){
 if(!players.length){empty(target,state.token?'아직 순위 기록이 없습니다.':'로그인하면 순위를 확인할 수 있습니다.');return;}
 const table=node('table'),head=node('thead'),row=node('tr');
 for(const title of ['순위','플레이어','계급','XP','K/D','승 / 패 / 무'])row.append(node('th',title));
 head.append(row);table.append(head);const body=node('tbody');
 players.forEach((p,index)=>{
  const tr=node('tr'),rank=node('td',String(index+1).padStart(2,'0'),'rank-number'+(index<3?' top':''));
  const name=node('td',displayName(p),'name-cell');
  if(state.me&&p.playerId===state.me.playerId)name.append(node('span','나','me-badge'));
  tr.append(rank,name,node('td',rankName(p.rank),'table-muted'),node('td',format(p.xp)),node('td',kd(p)),
   node('td',`${format(p.wins)} / ${format(p.losses)} / ${format(p.draws)}`,'table-muted'));
  body.append(tr);
 });
 table.append(body);target.replaceChildren(table);
}
function activityText(entry){
 const event=String(entry.event||entry.type||'');
 const name=entry.name||entry.playerName||'플레이어';
 const messages={
  'auth-login':[`${name} 님이 로그인했습니다.`,'계정 접속'],login:[`${name} 님이 로그인했습니다.`,'계정 접속'],
  'auth-register':[`${name} 님이 합류했습니다.`,'새로운 계정'],register:[`${name} 님이 합류했습니다.`,'새로운 계정'],
  'room-created':['새로운 대기실이 열렸습니다.',entry.code?`대기실 ${entry.code}`:'대기실 생성'],
  'room-joined':[`${name} 님이 전장에 합류했습니다.`,'게임 접속'],
  'match-started':['새 경기가 시작되었습니다.','전투 시작'],
  'match-ended':[entry.draw?'경기가 무승부로 종료되었습니다.':'경기가 종료되었습니다.','경기 결과 반영'],
  'death-confirmed':['전투 결과가 기록되었습니다.','킬 / 데스 갱신'],
  'profile-updated':['플레이어 기록이 갱신되었습니다.','경험치 · 전적'],
  'admin-user-updated':['관리자가 사용자 기록을 수정했습니다.','관리 작업'],
  'admin-user-approved':['관리자가 신규 가입을 승인했습니다.','가입 승인'],
  'admin-user-update':['관리자가 사용자 기록을 수정했습니다.','관리 작업'],
  'pickup-granted':['전장 장비를 획득했습니다.','장비 습득'],
  'player-disconnected':[`${name} 님이 접속을 종료했습니다.`,'게임 접속']
 };
 const normalized=event.replaceAll('_','-').replaceAll('.','-');
 return messages[normalized]||['서버 활동이 기록되었습니다.',normalized.replace(/[^a-z0-9-]/gi,' ').slice(0,48)||'활동 기록'];
}
function renderActivity(target,entries){
 if(!entries.length){empty(target,'아직 표시할 활동 기록이 없습니다.');return;}
 target.replaceChildren(...entries.map(entry=>{
  const [title,detail]=activityText(entry),item=node('div',undefined,'activity-item'),body=node('div',undefined,'activity-body');
  body.append(node('p',title),node('small',detail));
  const time=node('time',relativeTime(entry.time||entry.createdAt),'activity-time');
  time.title=dateText(entry.time||entry.createdAt);
  item.append(node('span','◈','activity-symbol'),body,time);return item;
 }));
}
function renderDashboard(){
 const d=state.dashboard,s=d?.summary||{};
 setText('online-count',d?format(s.onlinePlayers):'—');setText('room-count',d?format(s.rooms??d.rooms?.length):'—');
 setText('kill-limit',count(d?.rules?.killLimit||10));setText('time-limit',Math.round(number(d?.rules?.timeLimitSeconds||600)/60));
 renderLeaderboard($('leaderboard-preview'),state.players.slice(0,5));
 renderLeaderboard($('leaderboard-table'),state.players);
 const categories=$('category-rankings');categories.replaceChildren();
 for(const [family,label] of Object.entries(state.catalog.mastery?.families||{})){
  categories.append(node('h3',label));const table=node('table'),head=node('tr');
  ['순위','게임 이름','승급 인정','전체 성공','사용 무기'].forEach(h=>head.append(node('th',h)));table.append(head);
  const rows=state.categoryRankings?.[family]||[];
  rows.forEach((p,i)=>{const row=node('tr');[i+1,p.name,format(p.qualified),format(p.successes),`${p.diversity}종`].forEach(v=>row.append(node('td',String(v))));table.append(row);});
  const wrap=node('div',null,'table-wrap');wrap.append(table);categories.append(wrap);if(!rows.length)categories.append(node('p','아직 인정된 실적이 없습니다.'));
 }
 const activity=state.activity.length?state.activity:state.meActivity||[];
 renderActivity($('activity-preview'),activity.slice(0,4));renderActivity($('activity-full'),activity.slice(0,60));
}
function renderMapAccess(maps){
 const box=$('map-access-table');if(!box)return;const table=node('table'),head=node('tr');
 for(const h of ['공개 순서','맵','인원','준비 상태','공개 설정'])head.append(node('th',h));table.append(head);
 for(const m of maps){const row=node('tr'),cell=node('td'),button=node('button',m.open?'공개 중 · 닫기':'비공개 · 공개하기','button secondary');button.type='button';
  button.addEventListener('click',async()=>{button.disabled=true;try{await api('/api/admin/maps',{method:'POST',body:{mapIndex:m.mapIndex,open:!m.open}});await refresh();}catch(error){message('page-notice',error.message);button.disabled=false;}});
  cell.append(button);row.append(node('td',m.releaseOrder?String(m.releaseOrder):'기존/미정'),node('td',m.name+(m.sniperMap?' · 저격맵':'')),node('td',`최대 ${m.maxPlayers}명`),node('td',m.validation),cell);table.append(row);
 }box.replaceChildren(table);
}
function renderFairplay(cases){
 const box=$('fairplay-cases');if(!box)return;box.replaceChildren();
 if(!cases.length){box.append(node('p','탐지된 기록이 없습니다.'));return;}
 for(const c of cases){
  const row=node('div'),e=c.evidence;
  row.append(node('h3',`${c.name} · ${c.releasedAt?'해제됨':'게임 이용 중지'}`));
  row.append(node('p',`${c.reason} / 상대: ${c.otherName}`));
  row.append(node('p',`최근 ${e.windowMinutes}분: 처치 ${e.kills}, 비활동 피해 ${e.passiveDeaths}, 역방향 처치 ${e.reverseKills}, 무기 ${e.weapons}종, 경기 ${e.matches}회 · ${e.durationSeconds}초`));
  if(!c.releasedAt){const button=node('button','관리자 확인 · 이용 중지 해제','button secondary');button.type='button';button.addEventListener('click',async()=>{button.disabled=true;try{await api('/api/admin/fairplay/release',{method:'POST',body:{id:c.id}});await refresh();}catch(error){message('page-notice',error.message);button.disabled=false;}});row.append(button);}
  box.append(row);
 }
}
function renderUsers(){
 if(!isAdmin()){empty($('admin-users'),'관리자 권한이 필요합니다.');return;}
 const query=$('user-search').value.trim().toLocaleLowerCase('ko-KR');
 setText('approval-summary',`승인 대기 ${state.users.filter(u=>u.approvalStatus==='pending').length}명 · 신규 가입자는 승인 후 이용할 수 있습니다.`);
 const users=state.users.filter(u=>[displayName(u),u.email||''].some(v=>v.toLocaleLowerCase('ko-KR').includes(query)))
  .sort((a,b)=>Number(b.approvalStatus==='pending')-Number(a.approvalStatus==='pending')||(a.createdAt||0)-(b.createdAt||0));
 if(!users.length){empty($('admin-users'),query?'검색 결과가 없습니다.':'등록된 사용자가 없습니다.');return;}
 const table=node('table'),head=node('thead'),row=node('tr');
 ['사용자','이메일','계급','XP','킬 / 데스','승 / 패 / 무','상태',''].forEach(t=>row.append(node('th',t)));head.append(row);
 const body=node('tbody');
 users.forEach(u=>{
  const tr=node('tr'),action=node('td'),button=node('button','수정','admin-edit-button');button.type='button';
  button.addEventListener('click',()=>openEdit(u));action.append(button);
  if(u.approvalStatus==='pending'&&!u.disabled){
   const approve=node('button','가입 승인','button small');approve.type='button';
   approve.addEventListener('click',async()=>{
    approve.disabled=true;
    try{await api('/api/admin/users/'+encodeURIComponent(u.playerId),{method:'PATCH',body:{approvalStatus:'approved'}});
     toast(displayName(u)+' 님의 가입을 승인했습니다.');await refresh();}
    catch(error){message('page-notice',errorText(error));approve.disabled=false;}
   });action.prepend(approve);
  }
  tr.append(node('td',displayName(u),'name-cell'),node('td',u.email||'—','table-muted'),node('td',rankName(u.rank)),
   node('td',format(u.xp)),node('td',`${format(u.kills)} / ${format(u.deaths)}`),
   node('td',`${format(u.wins)} / ${format(u.losses)} / ${format(u.draws)}`),
   node('td',u.disabled?'비활성':u.approvalStatus==='pending'?'승인 대기':u.role==='admin'?'관리자':'승인됨',u.disabled?'disabled-tag':'table-muted'),action);
  body.append(tr);
  const detailRow=node('tr'),detailCell=node('td');detailCell.colSpan=8;detailCell.append(node('p',masterySummary(u)),masteryDetails(u));detailRow.append(detailCell);body.append(detailRow);
 });
 table.append(head,body);$('admin-users').replaceChildren(table);
}
async function refresh(){
 if(state.loading)return;
 state.loading=true;$('refresh-button').disabled=true;
 message('page-notice','');
 try{
  const jobs=[['auth',()=>api('/api/auth-config',{anonymous:true})],['leaderboard',()=>api('/api/leaderboard')],['dashboard',()=>api('/api/dashboard')]];
  if(state.token)jobs.push(['me',()=>api('/api/me')]);

  const results=await Promise.allSettled(jobs.map(([,fn])=>fn()));
  let connected=false,failure=null;
  results.forEach((result,index)=>{
   const key=jobs[index][0];
   if(result.status==='rejected'){if(result.reason.status!==401)failure=result.reason;return;}
   connected=true;const data=result.value;
   if(key==='fairplay')renderFairplay(data.cases||[]);
   if(key==='auth'){state.authConfig=data;$('register-tab').hidden=data.registrationAvailable===false;}
   if(key==='leaderboard'){state.players=Array.isArray(data.players)?data.players:[];state.categoryRankings=data.categoryRankings||{};}
   if(key==='dashboard'){state.dashboard=data;state.activity=Array.isArray(data.activity)?data.activity:[];}
   if(key==='me'){state.me=data.profile;state.meActivity=data.activity||[];state.catalog=data.catalog||{};}
  });
  setConnection(connected);
  if(failure)message('page-notice',errorText(failure));
  if(isAdmin()){
   try{const [data,reviews,mapData]=await Promise.all([api('/api/admin/users'),api('/api/admin/fairplay'),api('/api/admin/maps')]);renderMapAccess(mapData.maps||[]);state.users=Array.isArray(data.users)?data.users:[];renderFairplay(reviews.cases||[]);
     const held=reviews.cases.filter(c=>!c.releasedAt).length;if(held)message('page-notice',`실적 작업 의심 ${held}건: 사용자 관리에서 게임 이용 중지 사유를 확인하세요.`);}
   catch(error){message('page-notice',errorText(error));}
  }
  renderProfile();renderDashboard();renderUsers();
  setText('updated-label',connected?`${new Date().toLocaleTimeString('ko-KR',{hour:'2-digit',minute:'2-digit'})} 동기화`:'동기화 실패');
  view(location.hash.slice(1)||state.view,false);
 }finally{state.loading=false;$('refresh-button').disabled=false;}
}
function renderChatLogs(){
 if(!isAdmin()){empty($('chatlog-table'),'관리자 로그인이 필요합니다.');return;}
 const entries=state.chatEntries||[];if(!entries.length){empty($('chatlog-table'),'조건에 맞는 기록이 없습니다.');return;}
 const original=$('chatlog-original').checked,table=node('table'),head=node('thead'),row=node('tr'),body=node('tbody');
 for(const text of ['시각','방 / 상태','발신자','대상','표시 내용',...(original?['원문']:[])])row.append(node('th',text));head.append(row);
 for(const item of entries){
  const tr=node('tr');tr.append(node('td',new Date(item.time).toLocaleString('ko-KR',{timeZone:'Asia/Seoul'}),'table-muted'),
   node('td',`${item.roomName} · ${item.phase==='lobby'?'대기실':'게임 중'}`),node('td',item.name),
   node('td',item.channel==='team'?`팀 ${item.team===0?'RED':'BLUE'}`:'전체'),node('td',item.displayText+(item.moderated?'  [마스킹]':''),'chat-record'));
  if(original)tr.append(node('td',item.originalText,'chat-record'));body.append(tr);
 }
 table.append(head,body);$('chatlog-table').replaceChildren(table);
}
async function loadChatLogs(more){
 if(!isAdmin()||state.chatLoading)return;state.chatLoading=true;const token=state.token;
 $('chatlog-search').disabled=true;$('chatlog-more').disabled=true;
 try{
  if(!more)state.chatQuery={day:$('chatlog-day').value,channel:$('chatlog-channel').value,room:$('chatlog-room').value.trim(),sender:$('chatlog-sender').value.trim(),moderated:$('chatlog-moderated').checked?'1':'0'};
  const query=new URLSearchParams(state.chatQuery);if(more&&state.chatCursor)query.set('cursor',state.chatCursor);
  const data=await api('/api/admin/chat-logs?'+query);
  if(token!==state.token||!isAdmin())return;
  state.chatEntries=more?(state.chatEntries||[]).concat(data.entries):data.entries;state.chatCursor=data.nextCursor;state.chatLoaded=true;
  $('chatlog-day').value=data.day;state.chatQuery.day=data.day;$('chatlog-days').replaceChildren(...data.days.map(day=>{const option=node('option');option.value=day;return option;}));
  $('chatlog-more').hidden=!data.nextCursor;setText('chatlog-notice',`${data.day} · ${state.chatEntries.length}개 표시${data.nextCursor?' · 이전 기록을 더 볼 수 있습니다.':''}`);renderChatLogs();
 }catch(error){message('chatlog-notice',errorText(error));}
 finally{state.chatLoading=false;$('chatlog-search').disabled=false;$('chatlog-more').disabled=false;}
}
function authMode(mode){
 state.authMode=mode;state.verification=false;state.registration=null;clearInterval(codeTimer);
 $('login-tab').setAttribute('aria-selected',String(mode==='login'));
 $('register-tab').setAttribute('aria-selected',String(mode==='register'));
 $('display-name-field').hidden=mode!=='register';$('auth-name').required=mode==='register';
 $('verification-field').hidden=true;$('auth-code').required=false;$('auth-code').value='';
 $('password-field').hidden=false;$('auth-password').required=true;$('auth-password').value='';
 $('auth-email').readOnly=false;$('request-code-button').hidden=true;
 $('auth-password').autocomplete=mode==='login'?'current-password':'new-password';
 setText('auth-submit',mode==='login'?'로그인':'계정 만들기');message('auth-error','');
}
function openAuth(){authMode('login');if(!$('auth-dialog').open)$('auth-dialog').showModal();$('auth-email').focus();}
async function finishAuth(data){
 if(data.approvalRequired){
  authMode('login');message('auth-error',data.message||'가입 신청이 접수되었습니다. 관리자 승인 후 로그인해 주세요.');return;
 }
 if(!data.authToken)throw new Error('로그인 토큰을 받지 못했습니다.');
 saveToken(data.authToken);state.me=data.profile||null;
 $('auth-dialog').close();$('auth-password').value='';state.registration=null;
 await refresh();toast('로그인했습니다.');
}
function verificationStep(data){
 state.verification=true;
 $('verification-field').hidden=false;$('auth-code').required=true;
 $('password-field').hidden=true;$('auth-password').required=false;$('auth-password').value='';
 $('display-name-field').hidden=true;$('auth-name').required=false;$('auth-email').readOnly=true;
 $('request-code-button').hidden=false;setText('auth-submit','인증하고 가입하기');
 message('auth-error','이메일로 인증 코드를 보냈습니다. 받은 코드를 입력해 주세요.');
 $('auth-code').focus();
 clearInterval(codeTimer);const deadline=Date.now()+Math.max(0,number(data.resendAfter??60))*1000;
 const update=()=>{
  const remaining=Math.max(0,Math.ceil((deadline-Date.now())/1000));
  $('request-code-button').disabled=remaining>0;
  setText('request-code-button',remaining?`${remaining}초 후 코드 다시 받기`:'인증 코드 다시 받기');
  if(!remaining)clearInterval(codeTimer);
 };update();codeTimer=setInterval(update,1000);
}
$('auth-form').addEventListener('submit',async event=>{
 event.preventDefault();message('auth-error','');$('auth-submit').disabled=true;
 try{
  const email=$('auth-email').value.trim().toLowerCase();
  if(state.verification){await finishAuth(await api('/auth/register/verify',{method:'POST',anonymous:true,body:{email,code:$('auth-code').value.trim()}}));return;}
  const password=$('auth-password').value;
  if(state.authMode==='login')await finishAuth(await api('/auth/login',{method:'POST',anonymous:true,body:{email,password}}));
  else{
   const name=$('auth-name').value.trim();if(!name)throw new Error('닉네임을 입력해 주세요.');
   state.registration={email,password,name};
   const data=await api('/auth/register/request',{method:'POST',anonymous:true,body:state.registration});
   if(data.requiresVerification)verificationStep(data);else await finishAuth(data);
  }
 }catch(error){message('auth-error',errorText(error));}finally{$('auth-submit').disabled=false;}
});
$('request-code-button').addEventListener('click',async()=>{
 if(!state.registration)return;
 $('request-code-button').disabled=true;
 try{verificationStep(await api('/auth/register/request',{method:'POST',anonymous:true,body:state.registration}));}
 catch(error){message('auth-error',errorText(error));$('request-code-button').disabled=false;}
});
$('auth-dialog').addEventListener('close',()=>{state.registration=null;$('auth-password').value='';$('auth-code').value='';clearInterval(codeTimer);});
$('login-tab').addEventListener('click',()=>authMode('login'));
$('register-tab').addEventListener('click',()=>authMode('register'));
$('login-button').addEventListener('click',openAuth);
$('account-button').addEventListener('click',()=>state.me?view('loadout'):openAuth());
$('logout-button').addEventListener('click',async()=>{
 try{await api('/auth/logout',{method:'POST',body:{}});}catch{}
 saveToken(null);state.me=null;state.users=[];state.catalog={};state.meActivity=[];state.selectedCharacter=null;
 renderProfile();renderDashboard();view('overview');toast('로그아웃했습니다.');refresh();
});
function openEdit(user){
 if(!isAdmin())return;
 state.editing=user;setText('edit-title',displayName(user)+' · 기록 수정');
 for(const field of ['xp','kills','deaths','wins','losses','draws'])$('edit-form').elements[field].value=count(user[field]);
 $('edit-form').elements.disabled.checked=!!user.disabled;
 $('edit-form').elements.loadouts.value=JSON.stringify(user.loadouts||{},null,2);
 message('edit-error','');$('edit-dialog').showModal();
}
function validateLoadouts(value){
 if(!value||typeof value!=='object'||Array.isArray(value))throw new Error('장비 구성은 캐릭터별 JSON 객체여야 합니다.');
 for(const [key,item] of Object.entries(value)){
  if(['__proto__','constructor','prototype'].includes(key))throw new Error('올바르지 않은 캐릭터 ID입니다.');
  if(!item||!Array.isArray(item.inventory)||item.inventory.length!==7||
   !item.inventory.every(v=>Number.isInteger(v)&&(v>=0&&v<=51||v===255)))throw new Error('캐릭터별 장비 ID 7개가 필요합니다. 빈 슬롯은 255입니다.');
  const owned=item.inventory.filter(v=>v!==255);
  if(new Set(owned).size!==owned.length||!owned.includes(item.selectedWeapon))throw new Error('중복 장비를 제거하고 보유 장비 중 시작 무기를 선택해 주세요.');
 }return value;
}
$('edit-form').addEventListener('submit',async event=>{
 event.preventDefault();if(!isAdmin()||!state.editing)return;
 const original=state.editing,form=$('edit-form');message('edit-error','');$('edit-submit').disabled=true;
 try{
  const body={};
  for(const key of ['xp','kills','deaths','wins','losses','draws']){
   const value=Number(form.elements[key].value);
   if(!Number.isSafeInteger(value)||value<0||value>1e9)throw new Error('전적과 경험치는 0 이상의 정수여야 합니다.');
   if(value!==count(original[key]))body[key]=value;
  }
  if(['wins','losses','draws'].some(k=>k in body))body.matches=['wins','losses','draws'].reduce((n,k)=>n+Number(form.elements[k].value),0);
  if(form.elements.disabled.checked!==!!original.disabled)body.disabled=form.elements.disabled.checked;
  let loadouts;
  try{loadouts=JSON.parse(form.elements.loadouts.value);}catch{throw new Error('장비 구성 JSON 문법을 확인해 주세요.');}
  validateLoadouts(loadouts);
  if(JSON.stringify(loadouts)!==JSON.stringify(original.loadouts||{}))body.loadouts=loadouts;
  if(!Object.keys(body).length){$('edit-dialog').close();toast('변경된 항목이 없습니다.');return;}
  await api('/api/admin/users/'+encodeURIComponent(original.playerId||original.id),{method:'PATCH',body});
  $('edit-dialog').close();toast('사용자 기록을 저장했습니다.');await refresh();
 }catch(error){message('edit-error',errorText(error));}finally{$('edit-submit').disabled=false;}
});
document.querySelectorAll('[data-view]').forEach(button=>button.addEventListener('click',()=>view(button.dataset.view)));
document.querySelectorAll('[data-go]').forEach(button=>button.addEventListener('click',()=>view(button.dataset.go)));
document.querySelectorAll('[data-close]').forEach(button=>button.addEventListener('click',()=>$(button.dataset.close).close()));
$('refresh-button').addEventListener('click',refresh);
$('chatlog-form').addEventListener('submit',event=>{event.preventDefault();loadChatLogs(false);});
$('chatlog-more').addEventListener('click',()=>loadChatLogs(true));
$('chatlog-original').addEventListener('change',renderChatLogs);
$('user-search').addEventListener('input',renderUsers);
window.addEventListener('hashchange',()=>view(location.hash.slice(1),false));
document.addEventListener('visibilitychange',()=>{if(!document.hidden)refresh();});
setInterval(()=>{if(!document.hidden&&!$('auth-dialog').open&&!$('edit-dialog').open)refresh();},30000);
renderProfile();renderDashboard();view(location.hash.slice(1)||'overview',false);refresh();
})();
