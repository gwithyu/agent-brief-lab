'use strict';
const fs=require('node:fs'),path=require('node:path');
const {TextDecoder,isDeepStrictEqual}=require('node:util');
const {packHistory,unpackHistory,validateMessages}=require('../history.cjs');
const {spawnSync}=require('node:child_process');
const {simplify}=require('../index.cjs');
const {prepareInput}=require('../prepare.cjs');
const MAX_BYTES=1024*1024;
const SAFE_ERRORS=['invalid_arguments','invalid_file','unsupported_source','invalid_history',
  'invalid_history_json','restore_failure','unexpected_no_gain'];
const errorCode=e=>SAFE_ERRORS.includes(e.message)?e.message:'invalid_input';
const supportedSource=name=>/\.(?:[cm]?[jt]s|[jt]sx)$/.test(name)&&!/\.d\.[cm]?ts$/.test(name);
function parseArgs(args){
  const rest=[...args],index=rest.indexOf('--json');
  if(index>=0)rest.splice(index,1);
  if(rest.includes('--json'))throw Error('invalid_arguments');
  const json=index>=0;
  if(rest.length===0)return {mode:'demo',json};
  if(rest.length===1&&['--help','-h'].includes(rest[0]))return {mode:'help',json};
  if(rest.length!==2||!['--history','--source'].includes(rest[0])
    ||!rest[1]||rest[1].startsWith('--'))throw Error('invalid_arguments');
  return {mode:rest[0].slice(2),file:rest[1],json};
}
function readFile(file,{preserveBom=false}={}){
  const s=fs.lstatSync(file);
  if(!s.isFile()||s.isSymbolicLink()||s.size<1||s.size>MAX_BYTES)throw Error('invalid_file');
  const b=fs.readFileSync(file);
  if(b.length>MAX_BYTES||b.includes(0))throw Error('invalid_file');
  return new TextDecoder('utf-8',{fatal:true,ignoreBOM:preserveBom}).decode(b);
}
function historyResult(messages,kind){
  if(!Array.isArray(messages)||messages.length>4000)throw Error('invalid_history');
  const p=packHistory(messages);
  if(!isDeepStrictEqual(unpackHistory(p.input,p.metrics.sourceDigest),messages))
    throw Error('restore_failure');
  const m=p.metrics;
  return {kind,modelCalls:0,fileWrites:0,historyMessages:messages.length,
    beforeTokens:m.beforeTokens,afterTokens:m.afterTokens,tokensSaved:m.tokensSaved,
    beforeBytes:m.beforeBytes,afterBytes:m.afterBytes,
    dictionaryEntries:m.dictionaryEntries,referencedOccurrences:m.referencedOccurrences,
    exactRestore:true,providerUsage:null,billedSavingsUsd:null};
}
function sourceResult(source,name){
  if(!supportedSource(name))throw Error('unsupported_source');
  const m=simplify(source,name).metrics;
  return {kind:'local_source',modelCalls:0,fileWrites:0,beforeTokens:m.beforeTokens,
    afterTokens:m.afterTokens,tokensSaved:m.tokensSaved,
    beforeBytes:m.beforeBytes,afterBytes:m.afterBytes,
    candidateChanges:m.candidates,acceptedInMemory:m.applied,
    providerUsage:null,billedSavingsUsd:null};
}
function parseHistory(content){
  let messages;
  try{messages=JSON.parse(content)}catch{throw Error('invalid_history_json')}
  if(!Array.isArray(messages)||messages.length>4000)throw Error('invalid_history');
  return validateMessages(messages);
}
function validWorkerValue(value,mode){
  if(!value||typeof value!=='object'||value.kind!=='local_'+mode
    ||value.modelCalls!==0||value.fileWrites!==0||value.providerUsage!==null||value.billedSavingsUsd!==null)
    return false;
  const fields=['kind','modelCalls','fileWrites','providerUsage','billedSavingsUsd',
    'beforeTokens','afterTokens','tokensSaved','beforeBytes','afterBytes',
    ...(mode==='source'?['candidateChanges','acceptedInMemory']
      :['historyMessages','dictionaryEntries','referencedOccurrences','exactRestore'])];
  if(Object.keys(value).sort().join(',')!==fields.sort().join(','))return false;
  const numeric=fields.filter(k=>!['kind','providerUsage','billedSavingsUsd','exactRestore'].includes(k));
  return numeric.every(k=>Number.isSafeInteger(value[k])&&value[k]>=0)
    &&value.beforeTokens-value.afterTokens===value.tokensSaved&&value.afterBytes<=value.beforeBytes
    &&(mode!=='history'||value.exactRestore===true);
}
function preview(mode,content,name){
  if(mode==='source'&&!supportedSource(name))throw Error('unsupported_source');
  const messages=mode==='history'?parseHistory(content):null;
  const bytes=Buffer.byteLength(mode==='source'?content:JSON.stringify(messages));
  const unavailable=()=>({kind:'local_'+mode,modelCalls:0,fileWrites:0,
    beforeTokens:null,afterTokens:null,tokensSaved:null,beforeBytes:bytes,afterBytes:bytes,
    ...(mode==='source'?{candidateChanges:null,acceptedInMemory:null}
      :{historyMessages:messages.length,dictionaryEntries:null,referencedOccurrences:null,exactRestore:null}),
    measurementStatus:'unavailable',measurementMethod:'unavailable',
    reason:'TOKEN_COUNT_NOT_SAFELY_MEASURABLE',providerUsage:null,billedSavingsUsd:null});
  // Known pathological runs skip both AST/candidate work and tokenization.
  if(/([^\s])\1{256}/u.test(content))return unavailable();
  let value,method='inline';
  if(Buffer.byteLength(content)<=8192){
    value=mode==='source'?sourceResult(content,name):historyResult(messages,'local_history');
  }else{
    const result=spawnSync(process.execPath,['--max-old-space-size=256',__filename,'--internal-preview-worker'],{
      input:JSON.stringify({mode,content,name}),encoding:'utf8',timeout:5000,
      killSignal:'SIGKILL',maxBuffer:16*1024
    });
    if(result.error||result.signal||result.status!==0)return unavailable();
    let reply;
    try{reply=JSON.parse(result.stdout)}catch{return unavailable();}
    if(reply?.ok===false)throw Error([...SAFE_ERRORS,'invalid_input'].includes(reply.error)?reply.error:'invalid_input');
    if(reply?.ok!==true||!validWorkerValue(reply.value,mode))return unavailable();
    value=reply.value;method='bounded_worker';
  }
  return {...value,measurementStatus:'complete',measurementMethod:method};
}
function demo(){
  const root=path.resolve(__dirname,'..');
  const name='examples/boolean-before.js';
  const code=fs.readFileSync(path.join(root,name),'utf8');
  const intent=JSON.parse(fs.readFileSync(path.join(root,'examples/propose-intent.json'),'utf8'));
  const messages=[{role:'user',content:intent.request},
    ...Array.from({length:10},(_,i)=>({role:'tool',tool_call_id:'read-'+i,content:code}))];
  const prepared=prepareInput(intent,{[name]:code},messages);
  if(!isDeepStrictEqual(unpackHistory(prepared.input.history,prepared.metrics.historySourceDigest),messages))
    throw Error('restore_failure');
  const repeated=historyResult(messages,'synthetic_repeated_history');
  const noRepeat=historyResult([{role:'user',content:'Keep the requirement'},
    {role:'tool',content:'OK'}],'synthetic_no_repeat');
  if(noRepeat.tokensSaved!==0)throw Error('unexpected_no_gain');
  return {kind:'synthetic_demo',modelCalls:0,fileWrites:0,
    repeated,noRepeat,completeGuidedInput:{
      beforeTokens:prepared.metrics.guidedBeforeTokens,
      afterTokens:prepared.metrics.afterTokens,
      tokensSaved:prepared.metrics.tokensSavedWithGuidance,
      netSavedVersusRawRequest:prepared.metrics.netTokensSavedVersusRawRequest,
      restoredExactly:true},
    providerUsage:null,billedSavingsUsd:null};
}
function run(argv=process.argv.slice(2)){
  const o=parseArgs(argv);
  if(o.mode==='help')return {help:true,json:o.json};
  if(o.mode==='demo')return {value:demo(),json:o.json};
  const content=readFile(o.file);
  return {value:preview(o.mode,content,path.basename(o.file)),json:o.json};
}
const HELP=[
  'Agent Brief Lab — offline first run',
  'node evaluation/try-it.cjs                  (synthetic demo)',
  'node evaluation/try-it.cjs --history FILE   (JSON message array)',
  'node evaluation/try-it.cjs --source FILE    (JS/TS source)',
  'Add --json for aggregate output.',
  'Large inputs use a 5s, V8-heap-limited worker; unavailable measurements stay unknown.',
  'No model/API call. No file modification or source content printed.'
].join('\n');
function display(x){
  if(x.measurementStatus==='unavailable')return [
    'Agent Brief Lab — local '+(x.kind==='local_source'?'source':'history'),
    'Measurement unavailable within preview resource limits; token savings remain unknown.',
    'Original input kept unchanged. No model calls, file edits or provider billing measured.'
  ].join('\n');
  if(x.kind==='synthetic_demo'){
    return ['Agent Brief Lab — synthetic first run, zero model calls',
      'Repeated tool history: '+x.repeated.beforeTokens+' -> '+x.repeated.afterTokens+
        ' tokens ('+x.repeated.tokensSaved+' fewer; exact restore verified)',
      'No-repeat control: '+x.noRepeat.tokensSaved+' saved (correctly falls back)',
      'Complete guided input: '+x.completeGuidedInput.beforeTokens+' -> '+
        x.completeGuidedInput.afterTokens+' ('+x.completeGuidedInput.tokensSaved+' fewer)',
      'Net vs unguided request: '+x.completeGuidedInput.netSavedVersusRawRequest+' tokens',
      'No billed USD savings established. Try --history FILE or --source FILE.'].join('\n');
  }
  return ['Agent Brief Lab — '+(x.kind==='local_source'?'local source':'local history'),
    'Local tokens: '+x.beforeTokens+' -> '+x.afterTokens+
      ' ('+x.tokensSaved+' fewer)',
    'Bytes: '+x.beforeBytes+' -> '+x.afterBytes,
    x.kind==='local_history'?'Exact reconstruction: '+x.exactRestore:
      'In-memory accepted boolean changes: '+x.acceptedInMemory,
    'No file content printed, files changed or provider billing measured.'].join('\n');
}
function runCli(args=process.argv.slice(2),io={out:console.log,err:console.error}){
  try{
    const r=run(args);
    io.out(r.help?HELP:r.json?JSON.stringify(r.value,null,2):display(r.value));
    return 0;
  }catch(e){
    // Source content, absolute paths and stack traces must not escape.
    io.err('First run refused: '+errorCode(e));
    return 1;
  }
}
function runWorker(){
  try{
    const bytes=fs.readFileSync(0);
    if(bytes.length>MAX_BYTES*8)throw Error('invalid_file');
    const request=JSON.parse(bytes.toString('utf8'));
    if(!request||Object.keys(request).sort().join(',')!=='content,mode,name'
      ||!['source','history'].includes(request.mode)||typeof request.content!=='string'
      ||typeof request.name!=='string'||Buffer.byteLength(request.content)>MAX_BYTES)
      throw Error('invalid_arguments');
    const value=request.mode==='source'?sourceResult(request.content,request.name)
      :historyResult(parseHistory(request.content),'local_history');
    process.stdout.write(JSON.stringify({ok:true,value})+'\n');
  }catch(e){process.stdout.write(JSON.stringify({ok:false,error:errorCode(e)})+'\n');}
}
if(require.main===module){
  if(process.argv.length===3&&process.argv[2]==='--internal-preview-worker')runWorker();
  else process.exitCode=runCli();
}
module.exports={parseArgs,readFile,historyResult,sourceResult,demo,run,display,runCli};
