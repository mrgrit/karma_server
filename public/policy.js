/* Account consent and evidence-based administrative decisions. No automatic sanction. */
window.createKarmaPolicy=({state,api,toast,refresh})=>{
 const $=id=>document.getElementById(id),node=(tag,text)=>{const e=document.createElement(tag);if(text!==undefined)e.textContent=text;return e;};
 const money=n=>(Number(n||0)/100).toLocaleString('ko-KR',{maximumFractionDigits:2});
 let rules,loading=false;const keys=new WeakMap();
 const option=(value,label)=>{const o=node('option',label);o.value=value;return o;};
 function documentInto(target){target.replaceChildren();if(!rules){target.textContent='규정을 불러오는 중입니다.';return;}
   target.append(node('h2',rules.title),node('p','규정 버전 '+rules.version));
   for(const s of rules.sections){const d=node('details'),h=node('summary',s.title);d.append(h,node('p',s.text));target.append(d);}
   for(const l of rules.levels)target.append(node('p',`${l.level}단계 · ${l.name}: ${l.permanent?'영구 이용 정지':l.coins+'코인 차감'+(l.days?' + '+l.days+'일 정지':'')} — ${l.examples}`));
   const refs=node('p','참고한 공개 운영 정책: ');for(const r of rules.references){const a=node('a',r.title+' ');a.href=r.url;a.target='_blank';a.rel='noopener';refs.append(a);}target.append(refs);
 }
 async function load(){if(loading)return;loading=true;try{
   if(!rules){rules=await api('/api/game-rules',{anonymous:true});documentInto($('rules-document'));documentInto($('rules-modal-text'));}
   if(state.me){const result=await api(state.me.isAdmin?'/api/admin/conduct':'/api/conduct');renderCases(result.cases||[]);}
   render();
 }catch(e){toast(e.message);}finally{loading=false;}}
 function render(){
   const me=state.me,c=me?.coins,admin=me?.isAdmin===true;
   if(!me)$('conduct-cases').replaceChildren(node('p','로그인하면 본인의 기록을 확인할 수 있습니다.'));
   $('rules-accept').disabled=!$('rules-agree').checked;
   $('policy-notice').hidden=!me?.rulesRequired;
   $('rules-agreement').hidden=!me?.rulesRequired;$('conduct-admin').hidden=!admin;
   $('coin-parts').textContent=c?.available==null?'로그인하면 코인 구분이 표시됩니다.':`총 ${money(c.available)} · 일당 ${money(c.daily)} / ${money(c.dailyCap)} · 보너스 ${money(c.bonus)} · 기본 ${money(c.base)} KARMA`;
   $('coin-refill').textContent=c?.available==null?'':`일당은 한국시간 자정에 한도까지 충전 · 사용분은 접속 여부와 관계없이 30분마다 1개 회복 · 양도·장터·거래는 보너스만 사용${c.penaltyDebt?' · 제재 미납 '+money(c.penaltyDebt)+' KARMA':''}`;
   if(admin){for(const id of ['conduct-user','reset-user']){const prev=$(id).value;$(id).replaceChildren(option('','대상자 선택'),...state.users.filter(u=>u.playerId!==me.playerId).map(u=>option(u.playerId,u.name+' · '+u.email)));$(id).value=prev;}}
   if(rules&&!$('conduct-violation').options.length){$('conduct-violation').replaceChildren(...rules.violations.map(v=>option(v.id,v.name)));$('conduct-level').replaceChildren(...rules.levels.map(l=>option(l.level,`${l.level}단계 · ${l.name} · ${l.permanent?'영구 정지':l.coins+'코인 / '+l.days+'일'}`)));}
 }
 function renderCases(cases){const root=$('conduct-cases');root.replaceChildren();if(!cases.length){root.append(node('p','제재 기록이 없습니다.'));return;}
   for(const c of cases){const card=node('article');card.className='policy-case';
     card.append(node('h3',c.violationName+' · '+c.level+'단계'),node('p',`사건 ${c.id} · 대상 ${state.users.find(u=>u.playerId===c.playerId)?.name||c.playerId} · ${c.state==='revoked'?'취소됨':c.state==='applied'?'적용 완료':'정산 대기'}`),node('p',c.reason),node('p','증거 요약: '+c.evidence),node('p',`${money(c.amount)} KARMA · ${c.permanent?'영구 이용 정지':c.until?'정지 종료 '+new Date(c.until).toLocaleString('ko-KR',{timeZone:'Asia/Seoul'}):'이용 정지 없음'}`));
     for(const a of c.appeals||[])card.append(node('p','소명: '+a.text));
     if(c.revocationNote)card.append(node('p','취소 사유: '+c.revocationNote));
     if(state.me.isAdmin&&c.state==='applied'&&c.playerId!==state.me.playerId){const form=node('form'),input=node('textarea'),button=node('button','제재 취소·차감 코인 반환');input.required=true;input.minLength=5;input.maxLength=500;input.placeholder='검토 결과와 취소 사유';button.type='submit';form.append(input,button);form.addEventListener('submit',async e=>{e.preventDefault();button.disabled=true;try{await api('/api/admin/conduct/revoke',{method:'POST',body:{id:c.id,reason:input.value}});await load();toast('제재 취소를 처리했습니다.');}catch(err){toast(err.message);}finally{button.disabled=false;}});card.append(form);}
     if(c.playerId===state.me.playerId&&c.state!=='revoked'){const form=node('form'),input=node('textarea'),button=node('button','이의신청 제출');input.required=true;input.minLength=5;input.maxLength=2000;input.placeholder='사실관계와 소명 자료를 적어 주세요.';button.type='submit';form.append(input,button);form.addEventListener('submit',async e=>{e.preventDefault();button.disabled=true;try{await api('/api/conduct/appeal',{method:'POST',body:{id:c.id,text:input.value}});await load();toast('이의신청이 접수되었습니다.');}catch(err){toast(err.message);}finally{button.disabled=false;}});card.append(form);}
     root.append(card);
   }
 }
 const open=async()=>{await load();$('rules-dialog').showModal();};
 $('rules-read').onclick=open;$('signup-rules-read').onclick=open;$('rules-close').onclick=()=>$('rules-dialog').close();
 $('policy-notice-button').onclick=()=>{location.hash='rules';};
 $('rules-agree').onchange=()=>{$('rules-accept').disabled=!$('rules-agree').checked;};
 $('rules-accept').onclick=async()=>{if(!$('rules-agree').checked||!rules)return;const button=$('rules-accept');button.disabled=true;try{await api('/auth/rules',{method:'POST',body:{rulesAccepted:true,rulesVersion:rules.version}});$('rules-agree').checked=false;await refresh();toast('규정 동의를 저장했습니다.');}catch(e){toast(e.message);}finally{button.disabled=false;}};
 $('conduct-violation').onchange=()=>{$('conduct-level').value=rules.violations.find(v=>v.id===$('conduct-violation').value).level;};
 $('conduct-form').onsubmit=async e=>{e.preventDefault();const form=e.currentTarget,button=form.querySelector('[type=submit]');button.disabled=true;try{
   const fields=Object.fromEntries(new FormData(form)),body={...fields,level:Number(fields.level),confirmed:fields.confirmed==='on',occurredAt:new Date(fields.occurredAt).getTime()};
   const fingerprint=JSON.stringify(body);let p=keys.get(form);if(!p||p.fingerprint!==fingerprint){p={id:crypto.randomUUID(),fingerprint};keys.set(form,p);}
   await api('/api/admin/conduct',{method:'POST',body:{...body,id:p.id}});keys.delete(form);form.reset();await load();toast('제재와 코인 정산을 기록했습니다.');
 }catch(err){toast(err.message);}finally{button.disabled=false;}};
 $('reset-coins-form').onsubmit=async e=>{e.preventDefault();const form=e.currentTarget,button=form.querySelector('[type=submit]');button.disabled=true;try{
   const f=Object.fromEntries(new FormData(form));if(f.confirm!=='RESET')throw Error('기존 잔액 초기화를 확인하려면 RESET을 입력하세요.');
   const body={playerId:f.playerId,reason:f.reason};const fingerprint=JSON.stringify(body);let p=keys.get(form);if(!p||p.fingerprint!==fingerprint){p={key:crypto.randomUUID(),fingerprint};keys.set(form,p);}
   await api('/api/admin/coins/reset',{method:'POST',body:{...body,key:p.key}});keys.delete(form);form.reset();await refresh();toast('기본 100개와 일당 한도를 지급했습니다.');
 }catch(err){toast(err.message);}finally{button.disabled=false;}};
 load();
 return {render,load,signup(){if(!rules||!$('signup-rules-agree').checked)throw Error('현재 게임·코인 규정을 읽고 동의해 주세요.');return {rulesAccepted:true,rulesVersion:rules.version};}};
};
