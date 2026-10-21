import https from 'node:https';
import fs from 'node:fs';
import path from 'node:path';
import net from 'node:net';
import {atomicWriteJson} from './progression.mjs';

export function createExchangeClient({url,caFile,keyFile,dataDir,address,logger=()=>{}}){
  const base=new URL(url);if(base.protocol!=='https:')throw Error('Exchange HTTPS is required');
  if(address&&!net.isIP(address))throw Error('Invalid exchange address');
  const ca=fs.readFileSync(caFile),key=fs.readFileSync(keyFile,'utf8').trim();
  if(key.length<40)throw Error('Missing exchange service key');
  const file=path.join(dataDir,'exchange-pending.json');
  let pending=fs.existsSync(file)?JSON.parse(fs.readFileSync(file,'utf8')):{};
  const save=()=>atomicWriteJson(file,pending);
  const request=(action,payload)=>new Promise((resolve,reject)=>{
    const body=JSON.stringify(payload),target=new URL('/service/'+action,base);
    const req=https.request(target,{method:'POST',ca,minVersion:'TLSv1.2',
      ...(address?{lookup:(_host,options,callback)=>callback(null,options?.all?[{address,family:net.isIP(address)}]:address,net.isIP(address))}:{}),
      headers:{Authorization:'Bearer '+key,'Content-Type':'application/json','Content-Length':Buffer.byteLength(body)}},res=>{
      let data='';res.setEncoding('utf8');res.on('data',chunk=>{data+=chunk;if(data.length>1024*1024)req.destroy(Error('Exchange response too large'));});
      res.on('end',()=>{try{const result=JSON.parse(data);if(res.statusCode!==200)throw Object.assign(Error(result.error?.message||'거래소 요청 실패'),{code:result.error?.code});resolve(result);}catch(error){reject(error);}});
      res.on('error',reject);
    });
    req.setTimeout(30000,()=>req.destroy(Object.assign(Error('블록체인 정산 응답이 지연됩니다. 잠시 후 다시 시작하세요.'),{code:'EXCHANGE_UNAVAILABLE'})));
    req.on('error',reject);req.end(body);
  });
  async function refund(id){
    try{await request('refund',{matchId:id});delete pending[id];save();return true;}
    catch(error){if(error.code==='NOT_FOUND'&&Date.now()>pending[id]?.expiresAt){delete pending[id];save();return true;}logger('exchange-refund-pending',{matchId:id});return false;}
  }
  let recovering=false;
  async function recover(){if(recovering)return;recovering=true;try{for(const id of Object.keys(pending))if(!active.has(id))await refund(id);}finally{recovering=false;}}
  const active=new Set();const timer=setInterval(recover,10000);timer.unref();
  return {
    publicUrl:base.origin,request,
    async init(){await recover();},
    async wallet(profile){return request('wallet',{profile:{playerId:profile.playerId,name:profile.name,role:profile.role}});},
    async charge(id,players){
      active.add(id);pending[id]={expiresAt:Date.now()+90000};save();
      try{await request('reserve',{matchId:id,expiresAt:pending[id].expiresAt,players:players.map(p=>({playerId:p.playerId,name:p.name,role:p.role}))});await request('commit',{matchId:id});return {matchId:id,fee:100};}
      catch(error){await refund(id);active.delete(id);throw error;}
    },
    async refund(id){active.delete(id);return refund(id);},
    confirm(id){delete pending[id];active.delete(id);try{save();}catch{logger('exchange-confirm-persistence-failed',{matchId:id});}},
    close(){clearInterval(timer);},
  };
}
