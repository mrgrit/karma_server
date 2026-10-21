import fs from 'node:fs';
import path from 'node:path';
import solc from 'solc';
const name='contracts/KarmaSettlement.sol';
const input={language:'Solidity',sources:{[name]:{content:fs.readFileSync(name,'utf8')}},settings:{optimizer:{enabled:true,runs:200},evmVersion:'london',outputSelection:{'*':{'*':['abi','evm.bytecode.object','evm.deployedBytecode.object']}}}};
const result=JSON.parse(solc.compile(JSON.stringify(input),{import:p=>{try{return{contents:fs.readFileSync(path.join('node_modules',p),'utf8')}}catch{return{error:'Import not found: '+p}}}}));
for(const e of result.errors||[])console.error(e.formattedMessage);
if(result.errors?.some(e=>e.severity==='error'))process.exit(1);
fs.mkdirSync('artifacts',{recursive:true});
for(const [contract,value] of Object.entries(result.contracts[name])){
 fs.writeFileSync(`artifacts/${contract}.json`,JSON.stringify({compiler:solc.version(),evmVersion:'london',abi:value.abi,bytecode:'0x'+value.evm.bytecode.object,runtimeBytecode:'0x'+value.evm.deployedBytecode.object},null,2)+'\n');
 console.log(contract+': '+value.evm.bytecode.object.length/2+' bytes');
}
