import assert from 'node:assert/strict';import fs from 'node:fs';import os from 'node:os';import path from 'node:path';
import {createChatFilter,ChatArchive,chatDay} from './chat-policy.mjs';
const filter=createChatFilter(JSON.parse(fs.readFileSync(new URL('chat-policy.json',import.meta.url),'utf8')));
for(const text of ['씨발','시.발','씨 1 발','ㅅㅂ','ㅆㅂ','ㅂㅅ','병\u200b신','ＦＵＣＫ','f.u.c.k','shit','fucking','개새끼']){
 const value=filter('안녕 '+text+' 테스트');assert(value.moderated,text);assert(value.text.includes('***'),text);assert(!value.text.includes(text),text);
}
for(const text of ['시발점에서 시작','시발역 안내','새끼 고양이','ship assignment','classroom','친구랑 같이 해요','푸시 공격'])assert.deepEqual(filter(text),{text,moderated:false});
assert.equal(filter('😀 씨발 ㅅㅂ 한글').text,'😀 *** *** 한글');assert.equal(filter('씨발').text,'***');
const temp=fs.mkdtempSync(path.join(os.tmpdir(),'karma-chat-policy-')),dir=path.join(temp,'chat-logs');
const archive=new ChatArchive(dir),time=Date.parse('2026-10-21T16:00:00Z');assert.equal(chatDay(time),'2026-10-22');
try{
 for(let i=0;i<253;i++)archive.append({id:String(i),time,channel:i%2?'team':'all',roomName:'방 A',roomId:'room-a',name:'학생 가나다',senderId:'user-a',originalText:'씨발 한글 '+i,displayText:'*** 한글 '+i,moderated:true});
 const reopened=new ChatArchive(dir);let cursor,found=[];do{const page=reopened.read({day:'2026-10-22',limit:33,cursor});found.push(...page.entries.map(e=>e.id));cursor=page.nextCursor;}while(cursor);
 assert.equal(found.length,253);assert.equal(new Set(found).size,253);assert.equal(found[0],'252');assert.equal(found.at(-1),'0');
 const page=reopened.read({day:'2026-10-22',channel:'team',sender:'가나다',room:'방',moderatedOnly:true});assert(page.entries.every(e=>e.channel==='team'&&e.originalText.includes('씨발')));
 assert.throws(()=>reopened.read({day:'../../auth'}));assert.throws(()=>reopened.read({day:'2026-02-30'}));assert.throws(()=>reopened.read({day:'2026-10-22',cursor:'2'}));assert.throws(()=>reopened.read({limit:201}));
 assert.equal(reopened.read({day:'2026-10-20'}).entries.length,0);
 console.log('PASS chat moderation/archive: Korean/English/initials/spacing/zero-width/NFKC, common false positives, Unicode preservation, Korea date, durable restart, pagination without gaps/duplicates, filters and traversal/cursor bounds.');
}finally{for(const file of fs.readdirSync(dir))fs.unlinkSync(path.join(dir,file));fs.rmdirSync(dir);fs.rmdirSync(temp);}
