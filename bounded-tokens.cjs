'use strict';
// Larger inputs are counted in a disposable Node process with a 3s deadline
// and a 256 MiB V8 old-space limit (not an OS-wide memory/sandbox boundary).
const fs=require('node:fs');
const {spawnSync}=require('node:child_process');
const MAX_TEXT_BYTES=768*1024;
function validTexts(texts){
  return Array.isArray(texts)&&texts.length===2&&texts.every(s=>
    typeof s==='string'&&Buffer.byteLength(s)<=MAX_TEXT_BYTES);
}
function countPair(raw,prepared){
  const texts=[raw,prepared];
  if(!validTexts(texts))return null;
  const result=spawnSync(process.execPath,['--max-old-space-size=256',__filename],{
    input:JSON.stringify(texts),encoding:'utf8',timeout:3000,killSignal:'SIGKILL',maxBuffer:1024
  });
  if(result.error||result.signal||result.status!==0)return null;
  try{
    const counts=JSON.parse(result.stdout);
    return Array.isArray(counts)&&counts.length===2
      &&counts.every(n=>Number.isSafeInteger(n)&&n>=0)?counts:null;
  }catch{return null;}
}
if(require.main===module){
  try{
    const bytes=fs.readFileSync(0);
    if(bytes.length>MAX_TEXT_BYTES*4)throw Error('oversized_input');
    const texts=JSON.parse(bytes.toString('utf8'));
    if(!validTexts(texts))throw Error('invalid_input');
    const encoder=require('js-tiktoken').getEncoding('o200k_base');
    process.stdout.write(JSON.stringify(texts.map(s=>encoder.encode(s,[],[]).length))+'\n');
  }catch{
    // Source, process errors and encoder internals never enter public output.
    process.exitCode=1;
  }
}
module.exports={countPair};
