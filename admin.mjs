import path from 'node:path';
import {fileURLToPath} from 'node:url';
import {AuthService,emailValue} from './auth.mjs';
const directory=path.dirname(fileURLToPath(import.meta.url));
const auth=new AuthService({filename:path.join(process.env.KARMA_DATA_DIR||path.join(directory,'data'),'auth.json')});
async function secret(){
  if(process.env.KARMA_ADMIN_PASSWORD!==undefined)return process.env.KARMA_ADMIN_PASSWORD;
  if(!process.stdin.isTTY){
    let text='';
    for await(const chunk of process.stdin){
      text+=chunk.toString('utf8');
      if(text.includes('\n'))break;
      if(text.length>512)throw Error('Password input too long');
    }
    return text.replace(/\r?\n.*$/s,'');
  }
  process.stderr.write('Password (hidden): ');
  const previous=process.stdin.isRaw;
  process.stdin.setRawMode(true);process.stdin.resume();process.stdin.setEncoding('utf8');
  try{
    return await new Promise((resolve,reject)=>{
      let value='';
      const done=(error)=>{
        process.stdin.off('data',onData);process.stdin.off('end',onEnd);
        process.stderr.write('\n');error?reject(error):resolve(value);
      };
      const onEnd=()=>done();
      const onData=chunk=>{
        for(const ch of chunk){
          if(ch==='\r'||ch==='\n'){done();return;}
          if(ch==='\u0003'){done(Error('Cancelled'));return;}
          if(ch==='\u007f'||ch==='\b'){value=value.slice(0,-1);continue;}
          if(ch==='\u0004'){done();return;}
          if(ch>=' '){value+=ch;if(value.length>128){done(Error('Password too long'));return;}}
        }
      };
      process.stdin.on('data',onData);process.stdin.once('end',onEnd);
    });
  }finally{process.stdin.setRawMode(previous);process.stdin.pause();}
}
try{
  const [command,email,name]=process.argv.slice(2);
  if(command==='list'){
    console.log(JSON.stringify(auth.list(),null,2));
  }else if(command==='create-admin'){
    const account=await auth.createAccount({email:emailValue(email),password:await secret(),name:name||'Administrator',role:'admin'});
    console.log(JSON.stringify({ok:true,playerId:account.playerId,email:account.email,role:account.role}));
  }else if(command==='disable'||command==='enable'){
    const account=auth.list().find(item=>item.email===emailValue(email));
    if(!account)throw Error('Account not found');
    auth.setDisabled(account.playerId,command==='disable');
    console.log(JSON.stringify({ok:true,playerId:account.playerId,disabled:command==='disable'}));
  }else if(command==='reset-pass'){
    await auth.resetPassword(emailValue(email),await secret());
    console.log(JSON.stringify({ok:true}));
  }else throw Error('Usage: node admin.mjs create-admin EMAIL [NAME] | list | disable EMAIL | enable EMAIL | reset-pass EMAIL');
}catch(error){
  console.error(error.message);process.exitCode=1;
}
