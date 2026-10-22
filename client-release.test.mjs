import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import http from 'node:http';
import {serveClientRelease} from './client-release.mjs';
const root=fs.mkdtempSync(path.join(os.tmpdir(),'karma-release-'));
fs.mkdirSync(path.join(root,'files'));
const hash='a'.repeat(64);fs.writeFileSync(path.join(root,'files',hash),'release bytes');fs.writeFileSync(path.join(root,'manifest.json'),'{"signed":true}');
fs.writeFileSync(path.join(root,'secret'),'must not be served');
const server=http.createServer((req,res)=>{if(!serveClientRelease(req,res,new URL(req.url,'http://localhost').pathname,root)){res.writeHead(404);res.end();}});
await new Promise(resolve=>server.listen(0,'127.0.0.1',resolve));const origin='http://127.0.0.1:'+server.address().port;
try{
  let response=await fetch(origin+'/client-release/manifest.json');assert.equal(response.status,200);assert.equal(response.headers.get('cache-control'),'no-store');assert.deepEqual(await response.json(),{signed:true});
  response=await fetch(origin+'/client-release/files/'+hash);assert.equal(await response.text(),'release bytes');assert.match(response.headers.get('cache-control'),/immutable/);
  response=await fetch(origin+'/client-release/files/'+hash,{method:'HEAD'});assert.equal(response.headers.get('content-length'),'13');assert.equal(await response.text(),'');
  for(const url of ['secret','files/../../secret','files/%2e%2e%2fsecret','manifest.json/extra','files/'+hash+'x','files/'+ 'b'.repeat(64)])assert.equal((await fetch(origin+'/client-release/'+url)).status,404,url);
  assert.equal((await fetch(origin+'/client-release/manifest.json',{method:'POST'})).status,405);
  fs.truncateSync(path.join(root,'manifest.json'),8*1024*1024+1);assert.equal((await fetch(origin+'/client-release/manifest.json')).status,404);
  console.log('PASS client release: manifest, streaming, HEAD, cache, traversal/method/size/missing-file rejection');
}finally{await new Promise(resolve=>server.close(resolve));fs.rmSync(root,{recursive:true,force:true});}
