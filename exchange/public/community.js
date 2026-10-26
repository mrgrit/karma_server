'use strict';
const statusText={open:'모집 중',closed:'모집 마감',claimed:'활동 중',submitted:'검토 대기',approved:'보상 지급 완료',rejected:'미승인',cancelled:'참여 취소',requested:'판매자 수락 대기',accepted:'진행 중',delivered:'구매자 확인 대기',disputed:'관리자 중재 중',paid:'판매자 지급 완료',refunded:'구매자 환불 완료'};
let actionRequest=null;
function actionButton(label,fn,disabled=false){const b=el('button',label);b.type='button';b.disabled=disabled;b.addEventListener('click',fn);return b;}
function paragraph(text,cls=''){const p=el('p',text);p.className=cls;return p;}
function card(title,subtitle){const n=el('article');n.className='community-card';n.append(el('h3',title),paragraph(subtitle,'card-meta'));return n;}
function actions(node,buttons){const group=el('div');group.className='card-actions';group.append(...buttons);node.append(group);}
function emptyCards(id,text){$(id).replaceChildren(paragraph(text,'empty'));}
async function mutationKey(path,body){const digest=await crypto.subtle.digest('SHA-256',new TextEncoder().encode(path+JSON.stringify(body)));const name='karma-pending:'+Array.from(new Uint8Array(digest),b=>b.toString(16).padStart(2,'0')).join('');let key=sessionStorage.getItem(name);if(!key){key=crypto.randomUUID();sessionStorage.setItem(name,key);}return {name,key};}
function openAction(title,path,body,fields=[],description=''){
 actionRequest={path,body};$('action-title').textContent=title;$('action-description').textContent=description;$('action-fields').replaceChildren();$('action-error').textContent='';$('action-submit').disabled=false;
 for(const f of fields){const label=el('label',f.label),input=el(f.type==='select'?'select':f.type==='text'?'input':'textarea');input.name=f.name;input.required=true;if(f.type==='select')options(input,f.options);else{input.maxLength=f.max||2000;input.value=f.value||'';if(input.tagName==='TEXTAREA')input.rows=4;}label.append(input);$('action-fields').append(label);}
 $('community-action').showModal();
}
$('community-action-close').addEventListener('click',()=>{if(!$('action-submit').disabled)$('community-action').close();});
$('community-action').addEventListener('cancel',e=>{if($('action-submit').disabled)e.preventDefault();});
$('community-action-form').addEventListener('submit',async e=>{e.preventDefault();if($('action-submit').disabled)return;$('action-submit').disabled=true;$('action-error').textContent='';try{const body={...actionRequest.body,...Object.fromEntries(new FormData(e.target))},attempt=await mutationKey(actionRequest.path,body);await api(actionRequest.path,body,attempt.key);sessionStorage.removeItem(attempt.name);$('community-action').close();await refresh();toast('처리가 완료되었습니다. 잔액과 상태를 갱신했습니다.');}catch(error){$('action-error').textContent=error.message;}finally{$('action-submit').disabled=false;}});
function reviewForm(id,path,convert,title,describe){$(id).addEventListener('submit',e=>{e.preventDefault();try{const body=convert(new FormData(e.target));openAction(title,path,body,[],describe(body));}catch(error){toast(error.message);}});}
reviewForm('mission-create','/api/mission',f=>({action:'create',title:f.get('title'),description:f.get('description'),reward:minor(f.get('reward')),slots:whole(f.get('slots')),deadline:new Date(f.get('deadline')).getTime()}),'미션 보상금 확보',b=>`${b.title} · ${b.slots}명 × ${money(b.reward)} KARMA = ${money(b.slots*b.reward)} KARMA를 공동 금고에서 확보합니다.`);
reviewForm('service-create','/api/service',f=>({action:'create',title:f.get('title'),description:f.get('description'),price:minor(f.get('price')),days:whole(f.get('days'))}),'서비스 등록',b=>`${b.title} · ${money(b.price)} KARMA · 수락 후 ${b.days}일 이내 제공합니다.`);
reviewForm('treasury-fund','/api/treasury/fund',f=>({amount:minor(f.get('amount')),reason:f.get('reason')}),'공동 금고 운영 예산 입금',b=>`내 지갑에서 ${money(b.amount)} KARMA를 공동 금고로 이체합니다. 사유: ${b.reason}`);
$('economy-refresh').addEventListener('click',refresh);
$('welcome-claim').addEventListener('click',()=>openAction('체험 코인 받기','/api/welcome/claim',{},[],'최초 1회 100 KARMA를 공동 금고에서 받습니다.'));
function renderCommunity(){
 const me=state.data?.profile,c=me?state.community:null,e=me?state.economy:null,admin=me?.role==='admin';
 document.querySelectorAll('.admin-only').forEach(n=>n.hidden=!admin);$('welcome-pending').hidden=!state.data?.wallet.welcomePending;
 $('reward-budget').textContent=e?`공동 금고 지급 가능: ${money(e.spendable)} KARMA · 환불 보호금 ${money(e.refundHeld)} KARMA`:'공동 금고는 로그인 후 확인할 수 있습니다.';
 if(!c){for(const id of ['mission-list','claim-list','service-list','job-list'])emptyCards(id,'로그인하면 참여할 수 있습니다.');}else{
 $('claim-heading').textContent=admin?'미션 참여 검토':'내 미션 참여';$('job-heading').textContent=admin?'장터 주문 · 중재 관리':'내 구매 · 판매';
 $('mission-list').replaceChildren();
 for(const m of c.missions){const mine=c.claims.find(x=>x.mission===m.id&&x.student===me.playerId),live=m.state==='open'&&m.deadline>c.now,n=card(m.title,`${money(m.reward)} KARMA / 인 · ${m.occupied}/${m.slots}명 · ${live?'모집 중':'모집 종료'}`);n.append(paragraph(m.description,'multiline'),paragraph('제출 기한 '+time(m.deadline),'card-meta'));
 const buttons=[];if(!admin&&m.creator!==me.playerId)buttons.push(actionButton(mine&&mine.state!=='cancelled'?statusText[mine.state]:'참여하기',()=>openAction('미션 참여','/api/mission',{action:'claim',missionId:m.id},[],`${m.title} · 완료 승인 후 ${money(m.reward)} KARMA 지급`),!live||m.occupied>=m.slots||!!mine&&mine.state!=='cancelled'));
 if(admin&&m.state==='open')buttons.push(actionButton('모집 마감',()=>openAction('미션 모집 마감','/api/mission',{action:'close',missionId:m.id},[],'미배정 보상금은 공동 금고로 돌아갑니다. 이미 참여 중인 학생의 보상은 검토가 끝날 때까지 남겨 둡니다.')));actions(n,buttons);$('mission-list').append(n);}
 if(!c.missions.length)emptyCards('mission-list',admin?'첫 미션을 등록해 학과 활동의 보상을 준비하세요.':'등록된 미션이 없습니다. 새로운 학과 활동을 기다려 주세요.');
 $('claim-list').replaceChildren();for(const claim of c.claims){const n=card(claim.title,`${claim.studentName} · ${statusText[claim.state]} · ${money(claim.reward)} KARMA`),body={missionId:claim.mission,claimId:claim.id},buttons=[];
 if(claim.evidence)n.append(paragraph('제출 내용\n'+claim.evidence,'multiline'));if(claim.review)n.append(paragraph('검토 의견\n'+claim.review,'multiline'));
 if(claim.student===me.playerId&&claim.state==='claimed'){buttons.push(actionButton('결과 제출',()=>openAction('미션 결과 제출','/api/mission',{...body,action:'submit'},[{name:'evidence',label:'활동 결과 · 증빙 링크'}]),claim.deadline<c.now));buttons.push(actionButton('참여 취소',()=>openAction('미션 참여 취소','/api/mission',{...body,action:'cancel'},[],'참여 자리를 반환합니다.')));}
 if(admin&&claim.student!==me.playerId&&['claimed','submitted'].includes(claim.state)){if(claim.state==='submitted')buttons.push(actionButton('승인 · 보상 지급',()=>openAction('미션 보상 지급','/api/mission',{...body,action:'approve'},[{name:'review',label:'완료 확인 의견',value:'활동 완료 확인',max:500}],`${claim.studentName}에게 확보된 ${money(claim.reward)} KARMA를 지급합니다.`)));buttons.push(actionButton('미승인',()=>openAction('미션 미승인','/api/mission',{...body,action:'reject'},[{name:'review',label:'미승인 사유',max:500}],'제출 내용은 보존되며 학생에게 검토 의견이 표시됩니다.')));}actions(n,buttons);$('claim-list').append(n);}
 if(!c.claims.length)emptyCards('claim-list','아직 참여 내역이 없습니다.');
 $('service-list').replaceChildren();for(const s of c.services){const n=card(s.title,`${s.sellerName} · ${money(s.price)} KARMA · 수락 후 ${s.days}일`);n.append(paragraph(s.description,'multiline'));const buttons=[];
 if(s.state==='open'&&s.seller!==me.playerId)buttons.push(actionButton('구매 요청',()=>openAction('서비스 구매 요청','/api/service',{action:'buy',serviceId:s.id},[{name:'request',label:'원하는 작업과 전달할 내용',max:1000}],`${money(s.price)} KARMA를 보관합니다. 결과를 확인하면 ${s.sellerName}님에게 지급됩니다.`)));
 if(s.state==='open'&&(s.seller===me.playerId||admin))buttons.push(actionButton('판매 종료',()=>openAction('서비스 판매 종료','/api/service',{action:'close',serviceId:s.id},[],'새 주문을 받지 않습니다. 이미 접수한 주문은 계속 처리할 수 있습니다.')));if(s.state==='closed')n.append(paragraph('판매 종료','card-meta'));actions(n,buttons);$('service-list').append(n);}
 if(!c.services.length)emptyCards('service-list','아직 등록된 서비스가 없습니다. 친구에게 제공할 수 있는 도움을 올려 보세요.');
 $('job-list').replaceChildren();for(const j of c.jobs){const buyer=j.buyer===me.playerId,seller=j.seller===me.playerId,n=card(j.title,`${j.buyerName} → ${j.sellerName} · ${money(j.price)} KARMA · ${statusText[j.state]}`),body={jobId:j.id},buttons=[];
 n.append(paragraph('요청\n'+j.request,'multiline'));if(j.deadline)n.append(paragraph('제공 기한 '+time(j.deadline),'card-meta'));for(const [name,text] of [['결과',j.delivery],['중재 사유',j.dispute],['처리 의견',j.resolution]])if(text)n.append(paragraph(name+'\n'+text,'multiline'));
 const act=(label,action,fields=[],description='')=>actionButton(label,()=>openAction(label,'/api/job',{...body,action},fields,description));
 if(seller&&j.state==='requested')buttons.push(act('주문 수락','accept',[],`수락한 시점부터 ${j.days}일 이내 결과를 제출합니다.`));
 if(seller&&j.state==='accepted')buttons.push(act('결과 제출','deliver',[{name:'note',label:'제공한 내용 · 결과물 링크'}]));
 if(buyer&&j.state==='delivered')buttons.push(act('완료 확인 · 지급','complete',[],`${j.sellerName}님에게 보관 중인 ${money(j.price)} KARMA를 지급합니다.`));
 if((buyer||seller)&&!['paid','refunded'].includes(j.state)&&(seller||j.state==='requested'||j.state==='accepted'&&c.now>j.deadline))buttons.push(act('취소 · 환불','cancel',[{name:'note',label:'환불 사유',max:500}],`${j.buyerName}님에게 ${money(j.price)} KARMA를 반환합니다.`));
 if((buyer||seller)&&['accepted','delivered'].includes(j.state))buttons.push(act('관리자 중재 요청','dispute',[{name:'note',label:'중재가 필요한 이유',max:500}],'중재가 끝날 때까지 대금은 보관됩니다.'));
 if(admin&&!buyer&&!seller&&j.state==='disputed')buttons.push(act('중재 처리','resolve',[{name:'decision',label:'처리 방식',type:'select',options:[['refund','구매자에게 전액 환불'],['pay','판매자에게 전액 지급']]},{name:'note',label:'중재 근거와 처리 의견',max:500}]));
 actions(n,buttons);const history=el('details'),summary=el('summary','주문 진행 기록');history.append(summary);for(const h of j.history)history.append(paragraph(`${time(h.at)} · ${{buy:'구매 요청',accept:'수락',deliver:'결과 제출',complete:'완료 확인',cancel:'환불',dispute:'중재 요청',resolve:'중재 처리'}[h.action]||h.action}${h.note?' · '+h.note:''}`,'card-meta multiline'));n.append(history);$('job-list').append(n);}
 if(!c.jobs.length)emptyCards('job-list','아직 주문 내역이 없습니다.');
 }
 $('economy-metrics').replaceChildren();if(e){for(const [label,value,caption] of [['학생 지갑',money(e.studentWallets),'현재 사용 가능한 KARMA'],['공동 금고 지급 가능',money(e.spendable),'환불 보호금 제외'],['7일간 다시 지급',money(e.totals.reissued),'활동 · 미션 · 기본 · 일당 KARMA'],['7일간 서비스 완료',money(e.totals.servicePaid),'완료 확인된 거래 KARMA']]){const n=el('article');n.className='metric';n.append(paragraph(label),el('strong',value),el('small',caption));$('economy-metrics').append(n);}
 $('economy-classes').textContent=e.coinClasses?`사용자 지갑 구성 · 일당 ${money(e.coinClasses.daily)} / 보너스 ${money(e.coinClasses.bonus)} / 기본 ${money(e.coinClasses.base)} KARMA`:'';
 $('economy-total').textContent='총 '+money(e.totalSupply)+' KARMA';
 table('economy-balances',[['학생 사용 가능',e.studentWallets],['관리자 운영 준비금',e.adminWallets],['공동 금고 지급 가능',e.spendable],['공동 금고 환불 보호금',e.refundHeld],['별도 예비금',e.reserve],['확보된 미션 보상금',e.missionEscrow],['장터 보관 대금',e.serviceEscrow],['거래소 주문 예약',e.orderEscrow],['게임 시작 예약',e.gameEscrow],['기타',e.other]].map(([k,v])=>[k,money(v)]));
 table('economy-days',e.days.map(d=>[d.date,...['gameIncome','gameRefunds','reissued','servicePaid','transfers','funding'].map(k=>money(d[k]))]));
 $('economy-policy').textContent=`정상 시작 확정 수입의 80%는 활동 재원, 20%는 예비금으로 남습니다. 현재 미션 보상금 ${money(e.missionEscrow)} KARMA와 장터 대금 ${money(e.serviceEscrow)} KARMA가 별도 보관 중입니다.`;
 $('economy-tasks').replaceChildren(paragraph(`체험 지급 대기 ${e.pendingWelcome}명 · 미션 검토 대기 ${e.pendingClaims}건 · 장터 중재 ${e.disputedJobs}건`),paragraph(`최근 7일 보상 수령·서비스 거래·학생 간 양도 참여 계정 ${e.participants}개`));
 }else{table('economy-balances',[],'로그인하면 표시됩니다.');table('economy-days',[],'로그인하면 표시됩니다.');$('economy-total').textContent='';$('economy-policy').textContent='로그인하면 공동 금고와 실제 순환 현황을 볼 수 있습니다.';$('economy-tasks').replaceChildren();}
}
renderCommunity();
