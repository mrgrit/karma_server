'use strict';
const $=id=>document.getElementById(id), state={data:null,chain:null,chainError:'',pair:'',register:false,busy:false};
const pending=new WeakMap();let toastTimer;
const el=(tag,text)=>{const n=document.createElement(tag);if(text!==undefined)n.textContent=String(text);return n;};
const money=value=>(Number(value)/100).toLocaleString('ko-KR',{maximumFractionDigits:2});
const time=value=>new Date(value).toLocaleString('ko-KR',{month:'2-digit',day:'2-digit',hour:'2-digit',minute:'2-digit',second:'2-digit'});
const units=(amount,asset)=>asset==='KARMA'?money(amount):Number(amount).toLocaleString('ko-KR');
function minor(value){if(!/^\d+(?:\.\d{1,2})?$/.test(String(value)))throw Error('소수점은 최대 두 자리입니다.');const [a,b='']=String(value).split('.');const n=Number(a)*100+Number(b.padEnd(2,'0'));if(!Number.isSafeInteger(n)||n<=0)throw Error('0보다 큰 수량을 입력하세요.');return n;}
function whole(value){if(!/^\d+$/.test(String(value))||!Number.isSafeInteger(Number(value))||Number(value)<=0)throw Error('수량은 양의 정수여야 합니다.');return Number(value);}
function toast(value){$('toast').textContent=value;$('toast').hidden=false;clearTimeout(toastTimer);toastTimer=setTimeout(()=>$('toast').hidden=true,5000);}
async function api(path,body,key){const r=await fetch(path,{method:body===undefined?'GET':'POST',headers:{...(body===undefined?{}:{'Content-Type':'application/json'}),...(key?{'Idempotency-Key':key}:{})},body:body===undefined?undefined:JSON.stringify(body)});let value;try{value=await r.json();}catch{throw Error('서버 응답을 확인하지 못했습니다. 같은 내용으로 다시 시도하세요.');}if(!r.ok){const e=Error(value.error?.message||'요청을 완료하지 못했습니다.');e.status=r.status;throw e;}return value;}
function table(id,rows,empty='내역이 없습니다.'){const body=$(id);body.replaceChildren();if(!rows.length){const tr=el('tr'),td=el('td',empty);td.colSpan=8;td.className='empty';tr.append(td);body.append(tr);return;}for(const values of rows){const tr=el('tr');for(const v of values){const td=el('td');td.append(v instanceof Node?v:document.createTextNode(String(v)));tr.append(td);}body.append(tr);}}
function color(value,kind){const n=el('span',value);n.className=kind;return n;}
function options(select,items,selected=select.value){select.replaceChildren(...items.map(([value,label])=>{const o=el('option',label);o.value=value;o.selected=value===selected;return o;}));}
function view(name){if(!['market','wallet','issue','admin','chain'].includes(name)||name==='admin'&&state.data?.profile.role!=='admin')name='market';document.querySelectorAll('.view').forEach(e=>e.hidden=e.id!==name);document.querySelectorAll('[data-tab]').forEach(e=>e.classList.toggle('active',e.dataset.tab===name));history.replaceState(null,'','#'+name);}
function render(){
 const d=state.data,me=d?.profile; renderChain(); $('login-open').hidden=!!me;$('logout').hidden=!me;$('admin-tab').hidden=me?.role!=='admin';$('identity').textContent=me?me.name+' 님':'학과 활동을 가치로';
 $('balance').replaceChildren(document.createTextNode(d?money(d.wallet.balances.find(b=>b.symbol==='KARMA')?.available||0)+' ':'— '),el('small','KARMA'));
 $('locked').textContent=d?money(d.wallet.locked.KARMA||0)+' KARMA':'—';$('rank').textContent=me?.rank?.name||'로그인 필요';$('connection').textContent=d?'연결됨 · '+new Date().toLocaleTimeString('ko-KR',{hour:'2-digit',minute:'2-digit'}):'로그인 대기';
 for(const form of document.querySelectorAll('main form'))for(const button of form.querySelectorAll('button[type=submit]'))button.disabled=!me;
 if(!d){for(const id of ['trades','asks','bids','my-orders','holdings','history'])table(id,[],'로그인하면 표시됩니다.');options($('pair'),[['','로그인이 필요합니다.']]);$('chart').replaceChildren();$('chart-empty').hidden=false;return;}
 const coins=d.market.assets.filter(a=>a.symbol!=='KARMA');if(!coins.some(a=>a.symbol===state.pair))state.pair=coins[0]?.symbol||'';
 options($('pair'),coins.length?coins.map(a=>[a.symbol,a.symbol+' · '+a.name]):[['','등록된 코인 없음']],state.pair);
 renderMarket();
 table('holdings',d.wallet.balances.map(b=>[b.name+' ('+b.symbol+')',units(b.available,b.symbol),units(d.wallet.locked[b.symbol]||0,b.symbol)]));
 options($('transfer-asset'),d.wallet.balances.map(b=>[b.symbol,b.symbol+' · '+units(b.available,b.symbol)]));
 options($('recipient'),[['','받는 사람을 선택하세요'],...d.users.filter(u=>u.id!==me.playerId).map(u=>[u.id,u.name+' · '+u.id.slice(0,8)])]);
 const previous=new Set([...$('reward-users').selectedOptions].map(o=>o.value));options($('reward-users'),d.users.map(u=>[u.id,u.name+' · '+u.id.slice(0,8)]));for(const o of $('reward-users').options)o.selected=previous.has(o.value);
 table('history',d.wallet.history.map(h=>[time(h.at),h.reason,h.asset,color((h.destination===me.playerId?'+':'−')+units(h.amount,h.asset),h.destination===me.playerId?'buy':'sell'),h.transactionHash?receiptButton(h.transactionHash,h.chainKind==='migration'?'이관':'거래'):'이관 전']));
 table('my-orders',d.market.myOrders.map(o=>{const cancel=el('button','취소');cancel.disabled=o.status!=='open';cancel.addEventListener('click',async()=>{cancel.disabled=true;try{await api('/api/cancel',{orderId:o.id},crypto.randomUUID());await refresh();toast('미체결 주문을 취소했습니다.');}catch(e){toast(e.message);cancel.disabled=false;}});return[o.asset,color(o.side==='buy'?'매수':'매도',o.side),money(o.price),(o.quantity-o.remaining)+' / '+o.quantity,{open:'미체결',filled:'체결 완료',cancelled:'취소'}[o.status],cancel];}));
}
function renderMarket(){
 const d=state.data;if(!d)return;const trades=d.market.trades.filter(t=>t.asset===state.pair),orders=d.market.orders.filter(o=>o.asset===state.pair);
 $('last-price').textContent=trades.length?money(trades[0].price)+' KARMA':'체결 대기';$('trade-count').textContent='최근 '+trades.length+'건 · '+(state.pair||'코인 선택');
 for(const [side,id] of [['sell','asks'],['buy','bids']]){const aggregate=new Map();for(const o of orders.filter(o=>o.side===side))aggregate.set(o.price,(aggregate.get(o.price)||0)+o.remaining);table(id,[...aggregate].sort((a,b)=>side==='sell'?a[0]-b[0]:b[0]-a[0]).slice(0,8).map(([p,q])=>[color(side==='sell'?'매도':'매수',side),color(money(p),side),q.toLocaleString('ko-KR')]),side==='sell'?'매도 주문 없음':'매수 주문 없음');}
 table('trades',trades.slice(0,15).map(t=>[time(t.at),money(t.price),t.quantity.toLocaleString('ko-KR')]));
 const svg=$('chart');svg.replaceChildren();$('chart-empty').hidden=trades.length>0;
 if(trades.length){const data=trades.slice(0,60).reverse(),low=Math.min(...data.map(t=>t.price)),high=Math.max(...data.map(t=>t.price));const sv=(tag,attributes)=>{const n=document.createElementNS('http://www.w3.org/2000/svg',tag);for(const [k,v] of Object.entries(attributes))n.setAttribute(k,v);return n;};for(let i=0;i<4;i++)svg.append(sv('line',{x1:20,y1:25+i*55,x2:575,y2:25+i*55}));const path=data.map((t,i)=>(i?'L':'M')+(25+i*545/Math.max(1,data.length-1))+','+(high===low?115:195-(t.price-low)/(high-low)*160)).join(' ');svg.append(sv('path',{d:path}));for(const [text,y] of [[money(high),18],[money(low),223]]){const n=sv('text',{x:20,y});n.textContent=text+' KARMA';svg.append(n);}if(data.length===1){const n=sv('text',{x:180,y:115});n.textContent='첫 체결 · '+money(data[0].price)+' KARMA';svg.append(n);}}
}
function receiptButton(hash,label='거래'){
 const button=el('button',label+' '+hash.slice(0,10)+'…');button.className='hash-button';button.title=hash;
 button.addEventListener('click',async()=>{try{const r=await api('/api/chain/transaction/'+hash);$('chain-receipt').textContent=JSON.stringify(r,null,2);$('chain-receipt-panel').hidden=false;view('chain');$('chain-receipt-panel').scrollIntoView({behavior:'smooth',block:'center'});}catch(e){toast(e.message);}});return button;
}
function renderChain(){
 const c=state.chain,w=state.data?.wallet;
 $('chain-status').textContent=c?'블록 생성 정상 · 모든 잔액은 블록체인 확정 후 반영됩니다.':state.chainError||'로그인하면 네트워크 상태가 표시됩니다.';
 $('chain-network').textContent=c?c.network+' · Chain ID '+c.chainId:'—';
 $('chain-block').textContent=c?'#'+c.blockNumber+' · '+time(c.blockTimestamp*1000):'—';
 $('chain-validators').textContent=c?c.validators+'개 · '+c.consensus+' 합의':'—';
 $('chain-wallet').textContent=w?.address||'—';$('chain-token').textContent=c?.karmaToken||'—';
 $('chain-treasury').textContent=c?money(c.treasury)+' KARMA':'— KARMA';$('chain-treasury-address').textContent=c?.treasuryAddress||'—';
 table('chain-transactions',(c?.transactions||[]).map(t=>[time(t.created),'#'+t.blockNumber,receiptButton(t.transactionHash)]),'확정된 거래가 없습니다.');
}
$('chain-receipt-close').addEventListener('click',()=>{$('chain-receipt-panel').hidden=true;});
async function refresh(){if(state.busy)return;state.busy=true;try{state.data=await api('/api/state');state.chain=null;state.chainError='';if(state.data.wallet.chainId){try{state.chain=await api('/api/chain');}catch(error){state.chainError=error.message;}}$('notice').hidden=true;render();}catch(e){if(e.status===401){state.data=null;state.chain=null;render();}else{$('notice').textContent=e.message;$('notice').hidden=false;$('connection').textContent='연결 확인 필요';}}finally{state.busy=false;}}
function submit(id,path,bodyFn,success){const form=$(id);form.addEventListener('submit',async event=>{event.preventDefault();const button=form.querySelector('[type=submit]');button.disabled=true;try{const body=bodyFn(new FormData(form)),fingerprint=JSON.stringify(body);let attempt=pending.get(form);if(!attempt||attempt.fingerprint!==fingerprint){attempt={fingerprint,key:crypto.randomUUID()};pending.set(form,attempt);}const r=await api(path,body,attempt.key);pending.delete(form);toast(typeof success==='function'?success(r):success);await refresh();}catch(e){toast(e.message);}finally{button.disabled=!state.data;}});}
submit('order-form','/api/order',f=>{if(!state.pair)throw Error('먼저 거래할 코인을 선택하세요.');return{asset:state.pair,side:f.get('side'),price:minor(f.get('price')),quantity:whole(f.get('quantity'))};},r=>`${r.filled}개 체결 · ${r.remaining}개 주문 대기`);
submit('transfer-form','/api/transfer',f=>({asset:f.get('asset'),to:f.get('to'),amount:f.get('asset')==='KARMA'?minor(f.get('amount')):whole(f.get('amount')),memo:f.get('memo')}),'코인을 양도했습니다.');
submit('issue-form','/api/issue',f=>({symbol:f.get('symbol').trim(),name:f.get('name').trim(),supply:whole(f.get('supply'))}),'새 코인이 발행됐습니다. 거래소에서 매도 주문을 등록할 수 있습니다.');
submit('reward-form','/api/reward',f=>({recipients:f.getAll('recipients'),amount:minor(f.get('amount')),reason:f.get('reason')}),r=>`${r.recipients}명에게 활동 보상을 지급했습니다.`);
$('order-form').addEventListener('input',()=>{try{const f=new FormData($('order-form'));$('order-total').textContent=money(minor(f.get('price'))*whole(f.get('quantity')))+' KARMA';}catch{$('order-total').textContent='—';}});
$('pair').addEventListener('change',()=>{state.pair=$('pair').value;renderMarket();});
$('transfer-asset').addEventListener('change',()=>{const input=$('transfer-form').elements.amount;input.step=$('transfer-asset').value==='KARMA'?'.01':'1';input.min=input.step;});
document.querySelectorAll('[data-tab]').forEach(b=>b.addEventListener('click',()=>view(b.dataset.tab)));
function authMode(register){state.register=register;$('name-field').hidden=!register;$('auth-form').elements.name.required=register;$('auth-form').elements.password.autocomplete=register?'new-password':'current-password';$('auth-login').classList.toggle('active',!register);$('auth-register').classList.toggle('active',register);$('auth-submit').textContent=register?'가입 신청':'로그인';$('auth-error').textContent='';}
$('login-open').addEventListener('click',()=>{$('auth').showModal();});$('auth-close').addEventListener('click',()=>$('auth').close());$('auth-login').addEventListener('click',()=>authMode(false));$('auth-register').addEventListener('click',()=>authMode(true));
$('auth-form').addEventListener('submit',async e=>{e.preventDefault();$('auth-submit').disabled=true;$('auth-error').textContent='';try{const f=new FormData(e.target);const result=await api(state.register?'/api/register':'/api/login',{email:f.get('email'),password:f.get('password'),name:f.get('name')});if(result.approvalRequired){authMode(false);e.target.elements.password.value='';$('auth-error').textContent=result.message;return;}$('auth').close();e.target.elements.password.value='';await refresh();toast('거래소에 연결됐습니다.');}catch(error){$('auth-error').textContent=error.message;}finally{$('auth-submit').disabled=false;}});
$('auth').addEventListener('close',()=>$('auth-form').elements.password.value='');
$('logout').addEventListener('click',async()=>{try{await api('/api/logout',{});}catch(e){toast(e.message);return;}state.data=null;state.chain=null;render();view('market');});
$('audit-load').addEventListener('click',async()=>{try{const r=await api('/api/admin/audit');$('audit-result').textContent='모든 '+r.supplies.length+'종 코인의 발행량과 지갑·예약 잔액이 일치합니다. 누적 게임 이용료 잔액 '+money(r.treasury)+' KARMA.'+(r.chain?' 블록체인 '+r.verifiedWallets+'개 지갑 검증 완료 · 블록 '+r.chain.blockNumber:'');}catch(e){$('audit-result').textContent=e.message;}});
setInterval(()=>{if(!document.hidden&&!$('auth').open)refresh();},15000);render();view(location.hash.slice(1)||'market');refresh();
