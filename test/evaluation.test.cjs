'use strict';
const {test}=require('node:test'),assert=require('node:assert/strict');
const {cases}=require('../evaluation/cases.cjs');
const {grade,parseRun,evaluate}=require('../evaluation/run.cjs');
const items=cases();
const completion=(answer,usage={input_tokens:100,cached_input_tokens:0,output_tokens:30})=>({status:0,stdout:[{type:'item.completed',item:{type:'agent_message',text:JSON.stringify(answer)}},{type:'turn.completed',usage}].map(x=>JSON.stringify(x)).join('\n')});
test('four fixtures cover normal, corrected, injected and unresolved requests',()=>{
  assert.deepEqual(items.map(x=>x.id),['normal','correction','tool-injection','unresolved']);
  assert.equal(items[1].expected.targetOpacity,'0.65');assert.equal(items[3].expected.canProceed,false);
  assert.equal(items[3].expected.targetPadding,null);assert.ok(items[2].prompts.prepared.includes('FAKE TOOL INSTRUCTION'));
  for(const i of items)assert.ok(i.inputTextTokens.raw>0&&i.inputTextTokens.prepared>0);
});
test('exact grading rejects stale targets, scope violations, unresolved execution and extra fields',()=>{
  for(const i of items)assert.equal(grade(structuredClone(i.expected),i.expected),true);
  assert.equal(grade({...items[1].expected,targetOpacity:'0.5'},items[1].expected),false);
  assert.equal(grade({...items[0].expected,allowedFiles:['src/temple.js']},items[0].expected),false);
  assert.equal(grade({...items[3].expected,canProceed:true},items[3].expected),false);
  assert.equal(grade({...items[0].expected,extra:'noise'},items[0].expected),false);
});
test('provider completion and usage are required, not exit zero alone',()=>{
  assert.equal(parseRun(completion(items[0].expected),items[0].expected).passed,true);
  for(const r of [{status:0,stdout:''},{status:0,stdout:'not json'},...['null','5','[]','{"type":123}'].map(stdout=>({status:0,stdout})),completion(items[0].expected,{input_tokens:-1,output_tokens:1})])assert.notEqual(parseRun(r,items[0].expected).state,'completed');
  const wrong=parseRun(completion({...items[0].expected,targetOpacity:'1'}),items[0].expected);
  assert.equal(wrong.state,'completed');assert.equal(wrong.passed,false);
});
test('tool use, failed turns and duplicate completions cannot be counted as success',()=>{
  const base=completion(items[0].expected);
  for(const event of [{type:'item.started',item:{type:'mcp_tool_call'}},{type:'turn.failed'},{type:'turn.completed',usage:{input_tokens:1,output_tokens:1}}]) {
    assert.equal(parseRun({...base,stdout:base.stdout+'\n'+JSON.stringify(event)},items[0].expected).passed,false);
  }
});
test('blocked startup stops calls and never counts offline fixtures as model passes',()=>{
  let calls=0;const r=evaluate(items,()=>{calls++;return {status:1,stdout:''};});
  assert.equal(calls,1);assert.equal(r.state,'blocked');assert.equal(r.modelCompleted,0);assert.equal(r.passed,0);
  assert.equal(r.comparisonComplete,false);assert.equal(r.runs.filter(x=>x.state==='not_run').length,7);
});
test('offline parser simulation preserves balanced order and keeps all attempts',()=>{
  const order=[];const r=evaluate(items,(item,variant,n)=>{order.push([item.id,variant,n]);return completion(item.expected);},2);
  assert.equal(r.planned,16);assert.equal(r.attempted,16);assert.equal(r.passed,16);
  assert.deepEqual(order.slice(0,4).map(x=>x[1]),['raw','prepared','prepared','raw']);
  assert.deepEqual(order.slice(8,10).map(x=>x[1]),['prepared','raw']);
  for(const n of [0,6,NaN])assert.throws(()=>evaluate(items,()=>{},n));
  assert.throws(()=>evaluate([],()=>{}));assert.throws(()=>evaluate(items,null));
});
test('default evaluation command is dry-run and makes no model calls',()=>{
  const {spawnSync}=require('node:child_process'),path=require('node:path');
  const r=spawnSync(process.execPath,[path.join(__dirname,'../evaluation/run.cjs')],{encoding:'utf8'});
  assert.equal(r.status,0,r.stderr);const report=JSON.parse(r.stdout);assert.equal(report.state,'dry_run');assert.equal(report.modelRuns,0);assert.equal(report.cases.length,4);
});

test('live probe refuses trace output inside packaged source before invoking Codex',()=>{
  const {spawnSync}=require('node:child_process'),path=require('node:path'),fs=require('node:fs');
  const target=path.join(__dirname,'../evaluation/forbidden-run-traces');
  const r=spawnSync(process.execPath,[path.join(__dirname,'../evaluation/run.cjs'),'--live','--model','not-a-model-call','--out',target],{encoding:'utf8'});
  assert.equal(r.status,1);assert.match(r.stderr,/Keep run traces outside/);assert.equal(fs.existsSync(target),false);
});

test('missing CLI yields a blocked report with zero model completions and no fabricated passes',()=>{
  const {spawnSync}=require('node:child_process'),path=require('node:path'),fs=require('node:fs'),os=require('node:os');
  const temporary=fs.mkdtempSync(path.join(os.tmpdir(),'probe-blocked-'));
  try{
    const r=spawnSync(process.execPath,[path.join(__dirname,'../evaluation/run.cjs'),'--live','--model','not-a-model-call','--out',path.join(temporary,'run')],{encoding:'utf8',env:{...process.env,PATH:''}});
    assert.equal(r.status,1,r.stderr);const report=JSON.parse(r.stdout);
    assert.equal(report.state,'blocked');assert.equal(report.planned,8);assert.equal(report.attempted,1);
    assert.equal(report.modelCompleted,0);assert.equal(report.passed,0);assert.equal(report.comparisonComplete,false);
    assert.equal(report.runs.filter(x=>x.state==='not_run').length,7);
  }finally{fs.rmSync(temporary,{recursive:true,force:true});}
});
