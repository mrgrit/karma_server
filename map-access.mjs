import fs from 'node:fs';
import {atomicWriteJson} from './progression.mjs';
export class MapAccess {
 constructor(filename,maps){
  this.filename=filename;this.maps=maps;
  this.data=fs.existsSync(filename)?JSON.parse(fs.readFileSync(filename,'utf8')):{version:1,overrides:{},audit:[]};
  if(this.data.version!==1||!this.data.overrides||!Array.isArray(this.data.audit))throw Error('Invalid map access database; preserving file');
 }
 isOpen(index){return this.data.overrides[index]?.open??this.maps.find(m=>m.mapIndex===index)?.publicReady===true;}
 list(){return this.maps.map(m=>({id:m.id,name:m.name,mapIndex:m.mapIndex,open:this.isOpen(m.mapIndex),maxPlayers:m.maxPlayers||8,releaseOrder:m.releaseOrder||0,sniperMap:!!m.sniperMap,validation:m.validation||'기존 공개 맵',minClientBuild:m.minClientBuild||null})).sort((a,b)=>(a.releaseOrder||999)-(b.releaseOrder||999)||a.mapIndex-b.mapIndex);}
 set(index,open,actorId){
  if(!Number.isInteger(index)||!this.maps.some(m=>m.mapIndex===index)||typeof open!=='boolean')throw Error('올바른 맵과 공개 상태를 선택하세요.');
  const now=Date.now();this.data.overrides[index]={open,actorId,updatedAt:now};
  this.data.audit.push({mapIndex:index,open,actorId,time:now});this.data.audit=this.data.audit.slice(-2000);atomicWriteJson(this.filename,this.data);
  return this.list().find(m=>m.mapIndex===index);
 }
}
