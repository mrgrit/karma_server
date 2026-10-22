import fs from 'node:fs';
import path from 'node:path';

// Public, immutable release payloads only; never expose arbitrary server files.
export function serveClientRelease(request,response,pathname,root){
  if(!pathname.startsWith('/client-release/'))return false;
  const match=/^\/client-release\/(manifest\.json|files\/([a-f0-9]{64}))$/.exec(pathname);
  const finish=code=>{response.writeHead(code,{'Cache-Control':'no-store'});response.end();return true;};
  if(!['GET','HEAD'].includes(request.method))return finish(405);
  if(!match)return finish(404);
  const file=path.join(root,match[1]);
  let stat;
  try{stat=fs.lstatSync(file);}catch{return finish(404);}
  if(!stat.isFile()||stat.isSymbolicLink()||(!match[2]&&stat.size>8*1024*1024))return finish(404);
  // The files directory is owned by the deployer. Refuse symlinked directories too.
  if(match[2]){try{if(fs.lstatSync(path.join(root,'files')).isSymbolicLink())return finish(404);}catch{return finish(404);}}
  response.writeHead(200,{'Content-Type':match[2]?'application/octet-stream':'application/json',
    'Content-Length':stat.size,'Cache-Control':match[2]?'public, max-age=31536000, immutable':'no-store',
    'X-Content-Type-Options':'nosniff'});
  if(request.method==='HEAD'){response.end();return true;}
  const stream=fs.createReadStream(file);
  stream.on('error',()=>response.destroy());response.on('close',()=>stream.destroy());stream.pipe(response);
  return true;
}
