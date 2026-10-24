import fs from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';
import {promisify} from 'node:util';
import nodemailer from 'nodemailer';
import {atomicWriteJson} from './progression.mjs';
const scrypt=promisify(crypto.scrypt);
const hash=value=>crypto.createHash('sha256').update(value).digest('hex');
const approvalPending=()=>({ok:true,requiresVerification:false,approvalRequired:true,approvalStatus:'pending',
  message:'가입 신청이 접수되었습니다. 관리자 승인 후 로그인할 수 있습니다.'});
function requireApproved(account){
  if(account.approvalStatus&&account.approvalStatus!=='approved')
    authError(403,'APPROVAL_PENDING','관리자 승인 대기 중입니다. 승인 후 로그인해 주세요.');
}
export function authError(status,code,message){throw Object.assign(new Error(message),{status,code});}
export function emailValue(value){
  const email=typeof value==='string'?value.trim().toLowerCase():'';
  if(email.length>254||!/^[^\s@\u0000-\u001f]+@[^\s@.]+\.[^\s@]+$/.test(email))authError(400,'BAD_EMAIL','올바른 이메일 주소를 입력해 주세요.');
  return email;
}
export function nameValue(value){
  const name=typeof value==='string'?value.trim():'';
  if(!name.length||name.length>32||/[\u0000-\u001f\u007f]/.test(name))authError(400,'BAD_NAME','이름은 1~32자로 입력해 주세요.');
  return name;
}
function passwordValue(value){
  if(typeof value!=='string'||value.length<8||value.length>128)authError(400,'BAD_PASSWORD','비밀번호는 8~128자로 입력해 주세요.');
  return value;
}
export async function passwordHash(password){
  passwordValue(password);const salt=crypto.randomBytes(16).toString('hex');
  const derived=await scrypt(password,salt,64,{N:16384,r:8,p:1,maxmem:64*1024*1024});
  return {algorithm:'scrypt',salt,hash:derived.toString('hex')};
}
async function passwordMatches(password,stored){
  const derived=await scrypt(password,stored.salt,64,{N:16384,r:8,p:1,maxmem:64*1024*1024});
  const expected=Buffer.from(stored.hash,'hex');
  return expected.length===derived.length&&crypto.timingSafeEqual(derived,expected);
}
export function smtpMailer(env=process.env){
  if(!env.SMTP_HOST||!env.SMTP_FROM)return {configured:false};
  const port=Number(env.SMTP_PORT||587);
  if(!Number.isInteger(port)||port<1||port>65535)throw Error('Invalid SMTP_PORT');
  const secure=env.SMTP_SECURE==='true'||env.SMTP_SECURE==='1'||port===465;
  const transport=nodemailer.createTransport({
    host:env.SMTP_HOST,port,secure,requireTLS:!secure,
    ...(env.SMTP_USER?{auth:{user:env.SMTP_USER,pass:env.SMTP_PASS||''}}:{}),
    tls:{rejectUnauthorized:true,minVersion:'TLSv1.2',...(env.SMTP_SERVERNAME?{servername:env.SMTP_SERVERNAME}:{})},
    connectionTimeout:10000,greetingTimeout:10000,socketTimeout:15000,
    logger:false,debug:false,disableFileAccess:true,disableUrlAccess:true,
  });
  return {configured:true,async sendCode(email,code){
    await transport.sendMail({from:env.SMTP_FROM,to:email,subject:'Karma LAN 이메일 인증번호',
      text:`Karma LAN 가입 인증번호: ${code}\n10분 안에 입력해 주세요.\n요청하지 않았다면 이 메일을 무시해 주세요.`});
  }};
}

export class AuthService{
  constructor({filename,mailer=smtpMailer(),now=()=>Date.now(),verificationRequired=process.env.EMAIL_VERIFICATION!=='off'}){
    this.filename=filename;this.mailer=mailer;this.now=now;this.verificationRequired=verificationRequired;
    this.pending=new Map();this.limits=new Map();
    if(!fs.existsSync(filename))atomicWriteJson(filename,{version:1,accounts:{},sessions:{}});
    this.read();
  }
  read(){
    const data=JSON.parse(fs.readFileSync(this.filename,'utf8').replace(/^\uFEFF/,''));
    if(data.version!==1||!data.accounts||!data.sessions)throw Error('Invalid authentication database; preserving file');
    return data;
  }
  write(data){atomicWriteJson(this.filename,data);}
  rate(key,max,period){
    const now=this.now(),previous=this.limits.get(key)||[],recent=previous.filter(at=>at>now-period);
    if(recent.length>=max)authError(429,'RATE_LIMIT','요청이 너무 많습니다. 잠시 후 다시 시도해 주세요.');
    recent.push(now);this.limits.set(key,recent);
    if(this.limits.size>10000)for(const [entry,list] of this.limits)if(list.at(-1)<now-3600000)this.limits.delete(entry);
  }
  async registerRequest({email,password,name},ip){
    if(this.verificationRequired&&!this.mailer.configured)authError(503,'SMTP_UNAVAILABLE','이메일 인증 서버 설정을 기다리고 있습니다.');
    email=emailValue(email);name=nameValue(name);passwordValue(password);
    this.rate('register-ip:'+ip,10,600000);this.rate('register-email:'+email,5,600000);
    if(this.read().accounts[email])authError(409,'EMAIL_EXISTS','이미 가입한 이메일입니다. 로그인해 주세요.');
    if(!this.verificationRequired){
      await this.createAccount({email,password,name,emailVerified:false,approvalStatus:'pending'});
      return approvalPending();
    }
    const previous=this.pending.get(email),now=this.now();
    if(previous&&now-previous.requestedAt<60000)authError(429,'RESEND_WAIT','인증번호 재전송은 60초 후 가능합니다.');
    const nonce=crypto.randomBytes(16).toString('hex'),code=String(crypto.randomInt(0,1000000)).padStart(6,'0');
    const entry={name,requestedAt:now,expiresAt:now+600000,attempts:0,nonce,codeHash:hash(nonce+':'+code),sending:true};
    this.pending.set(email,entry);
    try{
      entry.password=await passwordHash(password);
      await this.mailer.sendCode(email,code);
      entry.sending=false;
    }catch{
      if(this.pending.get(email)===entry)this.pending.delete(email);
      authError(503,'SMTP_FAILED','인증 메일을 보내지 못했습니다. 잠시 후 다시 시도해 주세요.');
    }
    return {ok:true,requiresVerification:true,expiresIn:600,resendAfter:60};
  }
  async registerVerify({email,code},ip){
    email=emailValue(email);this.rate('verify-ip:'+ip,30,600000);
    const entry=this.pending.get(email);
    if(typeof code!=='string'||!/^\d{6}$/.test(code))authError(400,'BAD_CODE','인증번호 6자리를 입력해 주세요.');
    if(!entry||entry.sending||entry.expiresAt<=this.now())authError(400,'CODE_EXPIRED','인증번호가 없거나 만료되었습니다. 다시 요청해 주세요.');
    if(entry.attempts>=5)authError(429,'CODE_LOCKED','인증번호 입력 횟수를 초과했습니다. 다시 요청해 주세요.');
    entry.attempts++;
    if(!crypto.timingSafeEqual(Buffer.from(hash(entry.nonce+':'+code),'hex'),Buffer.from(entry.codeHash,'hex')))
      authError(entry.attempts>=5?429:400,entry.attempts>=5?'CODE_LOCKED':'CODE_MISMATCH','인증번호를 확인해 주세요.');
    const data=this.read();
    if(data.accounts[email])authError(409,'EMAIL_EXISTS','이미 가입한 이메일입니다.');
    const account={email,playerId:crypto.randomUUID(),name:entry.name,password:entry.password,
      role:'user',disabled:false,approvalStatus:'pending',emailVerified:true,verifiedAt:this.now(),createdAt:this.now()};
    data.accounts[email]=account;this.write(data);this.pending.delete(email);
    return approvalPending();
  }
  async login({email,password},ip){
    email=emailValue(email);passwordValue(password);
    this.rate('login-ip:'+ip,30,600000);this.rate('login-email:'+email,10,600000);
    const account=this.read().accounts[email];
    // Unknown accounts also perform the KDF; no plaintext passwords are stored.
    const stored=account?.password||{salt:'00000000000000000000000000000000',hash:'00'.repeat(64)};
    const valid=await passwordMatches(password,stored);
    if(!account||!valid)authError(401,'LOGIN_FAILED','이메일 또는 비밀번호를 확인해 주세요.');
    if(account.disabled)authError(403,'ACCOUNT_DISABLED','사용 중지된 계정입니다.');
    return this.issueSession(account);
  }
  issueSession(account){
    const data=this.read(),current=data.accounts[account.email];
    if(!current||current.disabled)authError(403,'ACCOUNT_DISABLED','사용할 수 없는 계정입니다.');
    requireApproved(current);
    const authToken=crypto.randomBytes(32).toString('hex'),expiresAt=this.now()+12*3600000;
    for(const [key,session] of Object.entries(data.sessions))if(session.expiresAt<=this.now())delete data.sessions[key];
    data.sessions[hash(authToken)]={email:account.email,playerId:account.playerId,expiresAt};
    this.write(data);
    return {ok:true,authToken,expiresAt,account:structuredClone(current)};
  }
  authenticate(authToken,data=this.read()){
    if(typeof authToken!=='string'||!/^[0-9a-f]{64}$/.test(authToken))authError(401,'AUTH_REQUIRED','먼저 로그인해 주세요.');
    const session=data.sessions[hash(authToken)];
    if(!session||session.expiresAt<=this.now())authError(401,'SESSION_EXPIRED','로그인이 만료되었습니다. 다시 로그인해 주세요.');
    const account=data.accounts[session.email];
    if(!account||account.playerId!==session.playerId||account.disabled)authError(403,'ACCOUNT_DISABLED','사용 중지된 계정입니다.');
    requireApproved(account);
    return structuredClone(account);
  }
  rename(authToken,name){
    const data=this.read(),account=this.authenticate(authToken,data);
    const current=data.accounts[account.email];current.name=nameValue(name);this.write(data);
    return {...current,password:undefined};
  }
  logout(authToken){
    const account=this.authenticate(authToken),data=this.read();
    delete data.sessions[hash(authToken)];this.write(data);
    return account;
  }
  async createAccount({email,password,name,role='user',playerId=crypto.randomUUID(),emailVerified=true,approvalStatus='approved'}){
    email=emailValue(email);name=nameValue(name);
    if(!['admin','user'].includes(role))throw Error('Invalid account role');
    if(!['approved','pending'].includes(approvalStatus))throw Error('Invalid approval status');
    const derived=await passwordHash(password),data=this.read();
    if(data.accounts[email])throw Error('Account already exists');
    const account={email,playerId,name,password:derived,role,disabled:false,emailVerified,approvalStatus,
      verifiedAt:emailVerified?this.now():null,createdAt:this.now()};
    data.accounts[email]=account;this.write(data);return structuredClone(account);
  }
  list(){
    return Object.values(this.read().accounts).map(({password,...account})=>({...account,approvalStatus:account.approvalStatus||'approved'}));
  }
  approve(playerId,actorId){
    const data=this.read(),account=Object.values(data.accounts).find(value=>value.playerId===playerId);
    if(!account)authError(404,'USER_NOT_FOUND','사용자를 찾을 수 없습니다.');
    if(account.disabled)authError(409,'ACCOUNT_DISABLED','사용 중지를 해제한 뒤 승인해 주세요.');
    if(account.approvalStatus==='pending'){
      account.approvalStatus='approved';account.approvedAt=this.now();account.approvedBy=actorId;this.write(data);
    }
    return {...account,password:undefined,approvalStatus:account.approvalStatus||'approved'};
  }
  setDisabled(playerId,disabled){
    if(typeof disabled!=='boolean')throw Error('disabled must be boolean');
    const data=this.read(),account=Object.values(data.accounts).find(value=>value.playerId===playerId);
    if(!account)authError(404,'USER_NOT_FOUND','사용자를 찾을 수 없습니다.');
    account.disabled=disabled;
    if(disabled)for(const [key,value] of Object.entries(data.sessions))if(value.playerId===playerId)delete data.sessions[key];
    this.write(data);return {...account,password:undefined};
  }
  async resetPassword(email,password){
    email=emailValue(email);const derived=await passwordHash(password),data=this.read(),account=data.accounts[email];
    if(!account)throw Error('Account not found');
    account.password=derived;
    for(const [key,session] of Object.entries(data.sessions))if(session.playerId===account.playerId)delete data.sessions[key];
    this.write(data);
  }
}
