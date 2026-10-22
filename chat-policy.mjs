import fs from 'node:fs';
import path from 'node:path';
const bad=message=>{throw Object.assign(new Error(message),{status:400,code:'BAD_CHAT_QUERY'});};
const escape=value=>value.replace(/[.*+?^${}()|[\]\\]/g,'\\$&');
const normalize=value=>value.normalize('NFKC').toLocaleLowerCase('en-US');
const dayFormat=new Intl.DateTimeFormat('sv-SE',{timeZone:'Asia/Seoul',year:'numeric',month:'2-digit',day:'2-digit'});
export const chatDay=(time=Date.now())=>dayFormat.format(time);
export function createChatFilter(policy){
 const segmenter=new Intl.Segmenter('ko',{granularity:'grapheme'}),gap='[\\p{Z}\\p{P}\\p{Cf}0-9_]{0,3}';
 const patterns=[];
 for(const [key,whole] of [['substringTerms',false],['wordTerms',true]]){
  if(!Array.isArray(policy[key]))throw Error('Invalid chat policy');
  for(const term of policy[key]){
   if(typeof term!=='string'||term.length<1||term.length>40)throw Error('Invalid chat term');
   const body=[...normalize(term)].map(escape).join(gap);
   patterns.push(new RegExp((whole?'(?<![\\p{L}\\p{N}])':'')+body+(whole?'(?![\\p{L}\\p{N}])':''),'gu'));
  }
 }
 const exceptions=(policy.exceptions||[]).map(normalize);
 return text=>{
  let normalized='';const map=[];
  for(const part of segmenter.segment(text)){
   const value=normalize(part.segment);normalized+=value;
   for(let i=0;i<value.length;i++)map.push([part.index,part.index+part.segment.length]);
  }
  const allowed=[];for(const term of exceptions){let at=0;while((at=normalized.indexOf(term,at))>=0){allowed.push([at,at+term.length]);at+=term.length;}}
  const spans=[];
  for(const pattern of patterns){pattern.lastIndex=0;for(const match of normalized.matchAll(pattern)){
   const end=match.index+match[0].length;if(allowed.some(([a,b])=>match.index>=a&&end<=b))continue;
   spans.push([map[match.index][0],map[end-1][1]]);
  }}
  spans.sort((a,b)=>a[0]-b[0]);const merged=[];
  for(const span of spans){const last=merged.at(-1);if(last&&span[0]<=last[1])last[1]=Math.max(last[1],span[1]);else merged.push([...span]);}
  let result='',cursor=0;for(const [start,end] of merged){result+=text.slice(cursor,start)+'***';cursor=end;}result+=text.slice(cursor);
  return {text:result,moderated:merged.length>0};
 };
}

// Private daily append-only journal. No auto-deletion. Persist before fanout;
// if the disk write fails, a message is rejected instead of going unrecorded.
export class ChatArchive {
 constructor(directory){this.directory=path.resolve(directory);}
 append(record){
  fs.mkdirSync(this.directory,{recursive:true,mode:0o700});
  const file=path.join(this.directory,chatDay(record.time)+'.jsonl');
  const fd=fs.openSync(file,'a',0o600);
  try{fs.writeFileSync(fd,JSON.stringify(record)+'\n');fs.fsyncSync(fd);}finally{fs.closeSync(fd);}
 }
 read({day=chatDay(),cursor,limit=100,channel='',room='',sender='',moderatedOnly=false}={}){
  if(!/^\d{4}-\d{2}-\d{2}$/.test(day)||Number.isNaN(Date.parse(day+'T00:00:00Z'))||new Date(day+'T00:00:00Z').toISOString().slice(0,10)!==day)bad('날짜를 확인해 주세요.');
  if(!Number.isInteger(limit)||limit<1||limit>200)bad('한 번에 1~200개를 조회할 수 있습니다.');
  if(!['','all','team'].includes(channel)||typeof room!=='string'||room.length>96||typeof sender!=='string'||sender.length>96)bad('검색 조건을 확인해 주세요.');
  const days=fs.existsSync(this.directory)?fs.readdirSync(this.directory).filter(f=>/^\d{4}-\d{2}-\d{2}\.jsonl$/.test(f)).map(f=>f.slice(0,10)).sort().reverse():[];
  const file=path.join(this.directory,day+'.jsonl');
  if(!fs.existsSync(file))return {day,days,entries:[],nextCursor:null};
  const fd=fs.openSync(file,'r');
  try{
   const size=fs.fstatSync(fd).size;let end=cursor===undefined||cursor===''?size:Number(cursor);
   if(!Number.isSafeInteger(end)||end<0||end>size)bad('기록 위치가 올바르지 않습니다.');
   if(end!==0&&end!==size){const check=Buffer.alloc(1);fs.readSync(fd,check,0,1,end-1);if(check[0]!==10)bad('기록 위치가 올바르지 않습니다.');}
   const start=Math.max(0,end-2*1024*1024),buffer=Buffer.alloc(end-start);fs.readSync(fd,buffer,0,buffer.length,start);
   const first=start>0?buffer.indexOf(10)+1:0;if(start>0&&first===0)throw Error('Invalid chat archive record');
   const lines=[];let at=first;for(let i=first;i<buffer.length;i++)if(buffer[i]===10){if(i>at)lines.push({start:start+at,bytes:buffer.subarray(at,i)});at=i+1;}
   const entries=[];let next=start+first;
   for(let i=lines.length-1;i>=0;i--){const line=lines[i],entry=JSON.parse(line.bytes.toString('utf8'));next=line.start;
    if(channel&&entry.channel!==channel||moderatedOnly&&!entry.moderated||room&&!String(entry.roomName+' '+entry.roomId).toLowerCase().includes(room.toLowerCase())||sender&&!String(entry.name+' '+entry.senderId).toLowerCase().includes(sender.toLowerCase()))continue;
    entries.push(entry);if(entries.length>=limit)break;
   }
   return {day,days,entries,nextCursor:next>0?String(next):null};
  }finally{fs.closeSync(fd);}
 }
}
