'use strict';
const {test}=require('node:test'),assert=require('node:assert/strict');
const {gradeSyntaxCase,normalizeBudgetRefusal}=require('../evaluation/syntax-check.cjs');
const result=(stdout='',stderr='',status=0)=>({stdout,stderr,status,signal:null});
test('syntax diagnostics require exact manual physical lines rather than containment or a successful exit',()=>{
  const task={expectedText:'const selected = () => 1;\r\n'},sha='a'.repeat(64);
  assert.equal(gradeSyntaxCase(result(task.expectedText),'briefSourceOnly',task,sha).passed,true);
  for(const r of [result(task.expectedText+'extra\n'),result(task.expectedText.trim()),result('', '',1),
    result(task.expectedText,'warning'),{...result(task.expectedText),error:Error('blocked')}])
    assert.equal(gradeSyntaxCase(r,'briefSourceOnly',task,sha).passed,false);
});
test('expected refusals require empty stdout and exact errors; JSON budget hints must match observed source and limits',()=>{
  const task={expectedError:'ambiguous_symbol'},stderr='Source read refused: ambiguous_symbol\n';
  assert.equal(gradeSyntaxCase(result('',stderr,1),'briefText',task,'').passed,true);
  for(const r of [result('',stderr,0),result('partial',stderr,1),result('',stderr+'body',1),
    {...result('',stderr,1),signal:'SIGTERM'}])assert.equal(gradeSyntaxCase(r,'briefText',task,'').passed,false);
  const sha='a'.repeat(64),budget={schema:'agent-brief-source-read-refusal.v1',status:'refused',error:'read_budget_exceeded',
    readHint:{sourceSha256:sha,startLine:2,endLine:203,maxLines:200,maxSliceBytes:65536},completeContext:false,modelCalls:0,fileWrites:0};
  assert.equal(normalizeBudgetRefusal(JSON.stringify(budget),sha),'Source read refused: read_budget_exceeded\n');
  for(const bad of ['broken','null',JSON.stringify({...budget,modelCalls:1}),JSON.stringify({...budget,readHint:{...budget.readHint,sourceSha256:'b'.repeat(64)}})])
    assert.equal(normalizeBudgetRefusal(bad,sha),'');
});
