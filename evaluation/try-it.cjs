'use strict';
const fs=require('node:fs'),path=require('node:path');
const {TextDecoder,isDeepStrictEqual}=require('node:util');
const {packHistory,unpackHistory}=require('../history.cjs');
const {simplify}=require('../index.cjs');
const {prepareInput}=require('../prepare.cjs');
const MAX_BYTES=1024*1024;
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
function readFile(file){
  const s=fs.lstatSync(file);
  if(!s.isFile()||s.isSymbolicLink()||s.size<1||s.size>MAX_BYTES)throw Error('invalid_file');
  const b=fs.readFileSync(file);
  if(b.length>MAX_BYTES||b.includes(0))throw Error('invalid_file');
  return new TextDecoder('utf-8',{fatal:true}).decode(b);
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
  if(!/\.(?:[cm]?[jt]s|[jt]sx)$/.test(name)||/\.d\.[cm]?ts$/.test(name))
    throw Error('unsupported_source');
  const m=simplify(source,name).metrics;
  return {kind:'local_source',modelCalls:0,fileWrites:0,beforeTokens:m.beforeTokens,
    afterTokens:m.afterTokens,tokensSaved:m.tokensSaved,
    beforeBytes:m.beforeBytes,afterBytes:m.afterBytes,
    candidateChanges:m.candidates,acceptedInMemory:m.applied,
    providerUsage:null,billedSavingsUsd:null};
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
  if(o.mode==='source')return {value:sourceResult(content,path.basename(o.file)),json:o.json};
  let messages;
  try{messages=JSON.parse(content)}catch{throw Error('invalid_history_json')}
  return {value:historyResult(messages,'local_history'),json:o.json};
}
const HELP=[
  'Agent Brief Lab — offline first run',
  'node evaluation/try-it.cjs                  (synthetic demo)',
  'node evaluation/try-it.cjs --history FILE   (JSON message array)',
  'node evaluation/try-it.cjs --source FILE    (JS/TS source)',
  'Add --json for aggregate output.',
  'No model/API call. No file modification or source content printed.'
].join('\n');
function display(x){
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
  return ['Agent Brief Lab — local '+x.kind,
    'Local tokens: '+x.beforeTokens+' -> '+x.afterTokens+
      ' ('+x.tokensSaved+' fewer)',
    'Bytes: '+x.beforeBytes+' -> '+x.afterBytes,
    x.kind==='local_history'?'Exact reconstruction: '+x.exactRestore:
      'In-memory accepted boolean changes: '+x.acceptedInMemory,
    'No file content printed, files changed or provider billing measured.'].join('\n');
}
if(require.main===module){
  try{const r=run();console.log(r.help?HELP:r.json?JSON.stringify(r.value,null,2):display(r.value))}
  catch(e){
    const safe=['invalid_arguments','invalid_file','unsupported_source','invalid_history',
      'invalid_history_json','restore_failure','unexpected_no_gain'];
    console.error('First run refused: '+(safe.includes(e.message)?e.message:'invalid_input'));
    process.exitCode=1;
  }
}
module.exports={parseArgs,readFile,historyResult,sourceResult,demo,run,display};
