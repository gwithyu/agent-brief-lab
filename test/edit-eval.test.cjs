'use strict';
const {test}=require('node:test'),assert=require('node:assert/strict');
const fs=require('node:fs'),os=require('node:os'),path=require('node:path');
const {editCases,manifestDigest}=require('../evaluation/edit-cases.cjs');
const {materializeCase,gradeEdits}=require('../evaluation/edit-grade.cjs');
const {parseTerminal,evaluateEdits,parseArgs,runCli}=require('../evaluation/edit-run.cjs');
const cases=editCases();
const good={type:'result',subtype:'success',is_error:false,duration_ms:1200,result:'Done'};
const init={type:'system',subtype:'init',model:'synthetic-test-model'};
const completed=()=>({status:0,stdout:[init,good].map(JSON.stringify).join('\n')+'\n',stderr:''});
function withJob(item,variant,fn){
  const parent=fs.mkdtempSync(path.join(os.tmpdir(),'brief-edit-test-')),job=path.join(parent,'job');
  try{materializeCase(job,item,variant);return fn(job);}finally{fs.rmSync(parent,{recursive:true,force:true});}
}
test('manifest has 30 distinct preregistered tasks and immutable fingerprint',()=>{
  assert.equal(cases.length,30);assert.equal(new Set(cases.map(c=>c.id)).size,30);
  assert.equal(manifestDigest(cases),manifestDigest(editCases()));
  assert.equal(cases.filter(c=>c.kind==='no_change').length,2);
  assert.equal(cases.filter(c=>c.kind==='multi').length,2);
  assert.equal(cases.filter(c=>c.historyRepeats===0).length,6);
  const priorDigest=manifestDigest(cases);
  const copy=cases.map(c=>({...c,prompts:{...c.prompts}}));
  copy[0].prompts.raw+='tampered';
  assert.notEqual(manifestDigest(copy),priorDigest,'Entire prompt is part of benchmark fingerprint');
  for(const c of cases){
    assert.ok(c.allowed.length);
    for(const prompt of Object.values(c.prompts)){
      const document=JSON.parse(prompt.split('DOCUMENT:').at(-1).trim());
      const readable=document.instruction;
      let embedded;try{embedded=JSON.parse(readable).request;}catch{embedded=readable;}
      assert.ok(embedded.includes(c.intent.request),c.id);
    }
    assert.ok(c.localInputTextTokens.raw>0&&c.localInputTextTokens.prepared>0);
    assert.equal(c.rewriteRejected,false,'Source-code transforms must not be silently included');
  }
});
test('all 30 expected edits pass by inspecting actual fixture files, not model claims',()=>{
  for(const c of cases)withJob(c,'prepared',job=>{
    for(const file of c.allowed)fs.writeFileSync(path.join(job,file),c.expected[file]);
    const r=gradeEdits(job,c,'prepared');
    assert.equal(r.acceptancePassed,true,JSON.stringify({case:c.id,grade:r}));
    assert.deepEqual(r.scopeViolations,[]);
    assert.deepEqual(r.wrongAllowed,[]);
  });
});
test('no-op baseline passes only unresolved tasks, changes required elsewhere',()=>{
  for(const c of cases)withJob(c,'raw',job=>{
    const r=gradeEdits(job,c,'raw');
    assert.equal(r.acceptancePassed,c.kind==='no_change',c.id);
  });
});
test('extra file, protected edit, deletion, symlink and mode drift all fail closed',()=>{
  const c=cases.find(c=>c.kind==='json');
  for(const fault of ['extra','protected','deleted','symlink','mode']){
    withJob(c,'raw',job=>{
      for(const name of c.allowed)fs.writeFileSync(path.join(job,name),c.expected[name]);
      if(fault==='extra')fs.writeFileSync(path.join(job,'src/rogue.js'),'evil');
      if(fault==='protected')fs.writeFileSync(path.join(job,'README.md'),'changed');
      if(fault==='deleted')fs.unlinkSync(path.join(job,c.allowed[0]));
      if(fault==='symlink'){fs.unlinkSync(path.join(job,c.allowed[0]));fs.symlinkSync('missing-target',path.join(job,c.allowed[0]));}
      if(fault==='mode')fs.chmodSync(path.join(job,c.allowed[0]),0o644);
      const r=gradeEdits(job,c,'raw');assert.equal(r.acceptancePassed,false,fault);
      assert.ok(r.scopeViolations.length,fault);
    });
  }
});
test('model success without edits does not pass required changes',()=>{
  const c=cases.find(c=>c.kind==='javascript');
  withJob(c,'prepared',job=>{
    const grade=gradeEdits(job,c,'prepared');
    const r=evaluateEdits([c],()=>({execution:completed(),grade}));
    assert.equal(r.modelCompleted,2);assert.equal(r.passed,0);
    assert.ok(r.runs.every(x=>x.failureReason==='acceptance_failed'));
  });
});
test('real file grades count both arms independently and keep unknown billing null',()=>{
  const sample=cases.slice(0,2),order=[];
  const r=evaluateEdits(sample,(item,arm)=>{
    order.push(item.id+':'+arm);
    return withJob(item,arm,job=>{
      for(const file of item.allowed)fs.writeFileSync(path.join(job,file),item.expected[file]);
      return {execution:completed(),grade:gradeEdits(job,item,arm)};
    });
  });
  assert.deepEqual(order,[sample[0].id+':raw',sample[0].id+':prepared',sample[1].id+':prepared',sample[1].id+':raw']);
  assert.equal(r.passed,4);assert.equal(r.comparisonComplete,true);
  assert.ok(r.runs.every(x=>x.providerBilledCost===null&&x.providerInputTokens===null));
});
test('first failed CLI response blocks the rest and preserves failed attempt',()=>{
  let n=0;const r=evaluateEdits(cases.slice(0,3),()=>{n++;return {execution:{status:1,stderr:'Workspace Trust Required'},grade:null};});
  assert.equal(n,1);assert.equal(r.state,'blocked');assert.equal(r.attempted,1);
  assert.equal(r.modelCompleted,0);assert.equal(r.runs.filter(x=>x.state==='not_run').length,5);
});
test('out-of-scope patch stops subsequent trials even if model terminal says success',()=>{
  let n=0;const r=evaluateEdits(cases.slice(0,3),()=>{n++;return {execution:completed(),grade:{acceptancePassed:false,scopeViolations:['protected_changed:README.md'],wrongAllowed:[]}};});
  assert.equal(n,1);assert.equal(r.attempted,1);assert.equal(r.runs[0].failureReason,'scope_violation');
});
test('Cursor tool stream terminal checks and forbidden shell evidence',()=>{
  assert.equal(parseTerminal(completed()).state,'completed');
  assert.equal(parseTerminal({status:1,stderr:'Workspace Trust Required'}).reason,'workspace_trust_required');
  assert.equal(parseTerminal({status:0,stdout:'malformed'}).reason,'invalid_jsonl');
  assert.equal(parseTerminal({status:0,stdout:[init,{type:'tool_call',tool_call:{shellToolCall:{command:'ls'}}},good].map(JSON.stringify).join('\n')}).reason,'forbidden_tool_reported');
  assert.equal(parseTerminal({status:0,stdout:[init,{...good,is_error:true}].map(JSON.stringify).join('\n')}).reason,'failed_terminal');
});
test('dry-run never invokes a model and live batch needs deliberate quota confirmation',()=>{
  const r=runCli(['--dry-run']);assert.equal(r.modelRuns,0);assert.equal(r.distinctTasks,30);
  assert.throws(()=>parseArgs(['--live','--model','m','--out','/tmp/example','--limit','30']),/confirm-batch/);
  assert.equal(parseArgs(['--live','--model','m','--out','/tmp/example','--limit','30','--confirm-batch','YES']).limit,30);
  assert.throws(()=>parseArgs(['--live','--model','m','--out','/tmp/example','--limit','31']));
});

test('unexpected empty folder and oversized file cannot evade scope checker',()=>{
  const c=cases.find(c=>c.kind==='css');
  withJob(c,'prepared',job=>{
    for(const file of c.allowed)fs.writeFileSync(path.join(job,file),c.expected[file]);
    fs.mkdirSync(path.join(job,'unexpected_dir'));
    let grade=gradeEdits(job,c,'prepared');
    assert.equal(grade.acceptancePassed,false);
    assert.ok(grade.scopeViolations.some(v=>v.includes('unexpected:unexpected_dir')));
    fs.rmdirSync(path.join(job,'unexpected_dir'));
    fs.writeFileSync(path.join(job,'unwanted.bin'),Buffer.alloc(300*1024));
    grade=gradeEdits(job,c,'prepared');
    assert.equal(grade.acceptancePassed,false);
    assert.ok(grade.scopeViolations.some(v=>v.includes('unexpected:unwanted.bin')));
  });
});
