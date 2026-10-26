import fs from 'node:fs';
import crypto from 'node:crypto';
export const GAME_RULES=JSON.parse(fs.readFileSync(new URL('./game-rules.json',import.meta.url),'utf8'));
export const RULES_HASH=crypto.createHash('sha256').update(JSON.stringify(GAME_RULES)).digest('hex');
export function validateRules({rulesAccepted,rulesVersion}={},now=Date.now()){
  if(rulesAccepted!==true||rulesVersion!==GAME_RULES.version)throw Object.assign(Error('현재 게임·코인 운영 규정을 읽고 동의해 주세요.'),{status:400,code:'RULES_REQUIRED'});
  return {version:GAME_RULES.version,hash:RULES_HASH,acceptedAt:now};
}
export const rulesAccepted=account=>account?.rulesAcceptance?.version===GAME_RULES.version&&account?.rulesAcceptance?.hash===RULES_HASH;

