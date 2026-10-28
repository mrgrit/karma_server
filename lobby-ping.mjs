import crypto from 'node:crypto';
import {performance} from 'node:perf_hooks';

export const PING_INTERVAL_MS=3000,PING_TIMEOUT_MS=5000;
// One connection-bound challenge at a time. Never accept a client-supplied RTT
// or wall clock; application scheduling and the actual TCP/TLS path are included.
export class LobbyPing{
 constructor({now=()=>performance.now(),nonce=()=>crypto.randomBytes(12).toString('hex')}={}){
  this.now=now;this.nonce=nonce;this.pending=null;this.sentAt=-Infinity;this.rttMs=null;this.failed=false;
 }
 probe(){
  const now=this.now();
  if(this.pending){
   if(now-this.pending.at<PING_TIMEOUT_MS)return null;
   this.pending=null;this.failed=true;
  }
  if(now-this.sentAt<PING_INTERVAL_MS)return null;
  const token=this.nonce();this.pending={token,at:now};this.sentAt=now;
  return {type:'latency-probe',version:2,token};
 }
 accept(token){
  if(typeof token!=='string'||token!==this.pending?.token)return false;
  const elapsed=this.now()-this.pending.at;
  if(elapsed<0||elapsed>=PING_TIMEOUT_MS)return false;
  this.rttMs=Math.round(elapsed);this.failed=false;this.pending=null;return true;
 }
 snapshot(){
  const expired=this.pending&&this.now()-this.pending.at>=PING_TIMEOUT_MS;
  if(this.failed||expired)return {pingMs:null,pingStatus:'timeout'};
  return this.rttMs===null?{pingMs:null,pingStatus:'measuring'}:{pingMs:this.rttMs,pingStatus:'ok'};
 }
}
