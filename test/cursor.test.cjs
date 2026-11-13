'use strict';
const {test}=require('node:test'),assert=require('node:assert/strict');
const {spawnSync}=require('node:child_process');
const fs=require('node:fs'),os=require('node:os'),path=require('node:path');
const {parseCursorCompletion,invokeCursor}=require('../evaluation/cursor.cjs');
const {evaluateCursor}=require('../evaluation/cursor-run.cjs');
const answer={allowedFiles:['src/navigation.css'],targetOpacity:'0.5',targetPadding:'8px',questionCount:0,canProceed:true};
const init={type:'system',subtype:'init',model:'test-model',session_id:'123'};
const success={type:'result',subtype:'success',is_error:false,duration_ms:101,result:JSON.stringify(answer),session_id:'123'};
const encode=events=>({status:0,stdout:events.map(e=>JSON.stringify(e)).join('\n')+'\n',stderr:''});
const pair=[init,success];
test('structured success parses answer and duration without fabricating provider billing',()=>{
  const p=parseCursorCompletion(encode(pair));
  assert.equal(p.state,'completed');assert.equal(p.elapsedMs,101);assert.deepEqual(p.answer,answer);
  assert.equal(p.reportedModel,'test-model');
  for(const k of ['providerInputTokens','providerOutputTokens','providerBilledCost'])assert.equal(p[k],null);
});
test('zero exit alone never proves valid model completion',()=>{
  for(const events of [[],[success],[init],[init,success,success],[success,init],
    [init,{...success,is_error:true}],[init,{...success,duration_ms:-1}],
    [init,{...success,subtype:'error'}],[init,{...success,result:'null'}]]) {
    const p=parseCursorCompletion(encode(events));
    assert.notEqual(p.reason,null);
  }
});
test('tool calls and interactions reject the entire run even with correct final answer',()=>{
  for(const item of [
    {type:'tool_call',subtype:'started',call_id:'tool1',tool_call:{writeToolCall:{}}},
    {type:'error',message:'tool failed'},
    {type:'request',request_id:'approval'},
    {type:'assistant',message:{content:[{type:'tool_use',name:'terminal'}]}}
  ]) {
    const p=parseCursorCompletion(encode([init,item,success]));
    assert.equal(p.state,'invalid');assert.equal(p.reason,'tool_or_interaction_detected');
  }
});
test('errors, malformed JSONL and non-object assistant answers fail closed',()=>{
  for(const result of [{status:1,stdout:''},{status:0,stdout:'not-json\n'},
    {status:0,stdout:'\n'},{status:null,signal:'SIGKILL'},
    {status:0,stdout:JSON.stringify(init)+'\n'+JSON.stringify({...success,result:'"not an object"'})+'\n'}]) {
    const p=parseCursorCompletion(result);assert.notEqual(p.reason,null);
  }
});
const cases=[
  {id:'a',prompts:{raw:'raw1',prepared:'prep1'},inputTextTokens:{raw:30,prepared:20},expected:answer},
  {id:'b',prompts:{raw:'raw2',prepared:'prep2'},inputTextTokens:{raw:40,prepared:22},expected:answer}
];
test('paired order rotates and all completions are graded exactly',()=>{
  const seen=[];const r=evaluateCursor(cases,(item,variant,repeat)=>{seen.push(`${repeat}-${item.id}-${variant}`);return encode(pair);},2);
  assert.deepEqual(seen,['0-a-raw','0-a-prepared','0-b-prepared','0-b-raw','1-a-prepared','1-a-raw','1-b-raw','1-b-prepared']);
  assert.equal(r.state,'completed');assert.equal(r.attempted,8);assert.equal(r.passed,8);
  assert.equal(r.comparisonComplete,true);
  assert.ok(r.runs.every(v=>v.providerBilledCost===null&&v.providerInputTokens===null));
});
test('unexpected tool call stops all later model invocations',()=>{
  let count=0;
  const r=evaluateCursor(cases,()=>{count++;return encode([init,{type:'tool_call'},success]);},2);
  assert.equal(count,1);assert.equal(r.state,'blocked');assert.equal(r.attempted,1);
  assert.equal(r.runs.filter(v=>v.state==='not_run').length,7);
});
test('wrong answers count as failures even when Cursor reports success',()=>{
  const wrong=encode([init,{...success,result:JSON.stringify({...answer,targetOpacity:'1'})}]);
  const r=evaluateCursor(cases,()=>wrong,1);
  assert.equal(r.comparisonComplete,true);assert.equal(r.passed,0);
});
test('invalid repeats and case configurations fail before invoking',()=>{
  for(const n of [0,6,1.5,'2'])assert.throws(()=>evaluateCursor(cases,()=>encode(pair),n));
  assert.throws(()=>evaluateCursor([],()=>encode(pair)));
});
test('Cursor invocation pins sandbox and Ask mode, avoids --force, --resume',()=>{
  const temp=fs.mkdtempSync(path.join(os.tmpdir(),'cursor-invoke-'));
  try {
    const script=path.join(temp,'fake-agent');
    fs.writeFileSync(script,'#!/bin/sh\nprintf "%s\\n" "$@"\n',{mode:0o700});
    const p=invokeCursor('Handle synthetic code only',temp,'sample-model',{command:script,timeoutMs:5000});
    assert.equal(p.status,0,p.stderr);
    const args=p.stdout.trim().split('\n');
    assert.ok(args.includes('--print'));assert.ok(args.includes('--mode=ask'));
    assert.ok(args.includes('--sandbox'));assert.ok(args.includes('enabled'));
    assert.ok(args.includes('stream-json'));assert.ok(args.includes('sample-model'));
    assert.ok(!args.includes('--force')&&!args.includes('--resume'));
  } finally {fs.rmSync(temp,{recursive:true,force:true});}
});
