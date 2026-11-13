'use strict';
const fs = require('node:fs');
const path = require('node:path');
const {simplify,tokens,brief,checkPlan}=require('./index.cjs');
const {measureContext}=require('./execution.cjs');
const intent=require('./examples/intent.json');
const good=require('./examples/plan-good.json');
const bad=require('./examples/plan-bad.json');
const source=fs.readFileSync(path.join(__dirname,'examples/boolean-before.js'),'utf8');
const codeIntent={request:'精简 visible 和 hidden 的布尔返回，保留函数名、返回结果、副作用和异常行为。',
  goal:'精简两个布尔返回函数。',allowedFiles:['src/logic.js'],
  constraints:[{id:'keep_interface',text:'保留函数名和接口。'},{id:'keep_evaluation',text:'保留求值次数、结果和异常行为。'}],
  acceptance:[{id:'behavior_tests',text:'执行行为测试。'}],questions:[]};
const {packHistory,unpackHistory}=require('./history.cjs');
const snapshot=fs.readFileSync(path.join(__dirname,'execution.cjs'),'utf8');
const history=[{role:'user',content:'检查实际改动，保留用户原句和全部约束。'},
  ...[1,2,3].map(n=>({role:'tool',tool_call_id:'read-'+n,content:snapshot}))];
const packedHistory=packHistory(history);
if(JSON.stringify(unpackHistory(packedHistory.input))!==JSON.stringify(history)) throw new Error('History reconstruction failed');
const mixedHistory=[...history,...Array.from({length:1800},(_,i)=>({role:'tool',content:i%2?'OK':'',tool_call_id:'tiny-'+i}))];
const packedMixedHistory=packHistory(mixedHistory);
if(JSON.stringify(unpackHistory(packedMixedHistory.input,packedMixedHistory.metrics.sourceDigest))!==JSON.stringify(mixedHistory)) throw new Error('Mixed history reconstruction failed');
const report={
  source:'Synthetic demonstration fixture, not a real-project or full-agent benchmark',
  code:['o200k_base','cl100k_base'].map(encoding=>simplify(source,'sample.js',encoding).metrics),
  guardCode:['o200k_base','cl100k_base'].map(encoding=>simplify(fs.readFileSync(path.join(__dirname,'examples/guard-before.js'),'utf8'),'guard.js',encoding).metrics),
  intent:{rawRequestTokens:tokens(intent.request),briefTokens:tokens(brief(intent)),
    completePlan:checkPlan(intent,good),offScopePlan:checkPlan(intent,bad)},
  inputContext:measureContext(codeIntent,{'src/logic.js':source},{'src/logic.js':simplify(source).code}),
  packedContext:require('./context.cjs').packContext(codeIntent,{'src/logic.js':source}).metrics,
  history:{source:'Synthetic three-read history using this lab execution.cjs; not an observed agent trace',...packedHistory.metrics,roundTripExact:true},
  mixedHistory:{source:'Synthetic three source reads plus 1800 tiny outputs; not an observed agent trace',...packedMixedHistory.metrics,roundTripExact:true},
  preparedInput:{source:'One synthetic code-simplification task with three identical reads of its own source, not an observed agent trace',...require('./prepare.cjs').prepareInput(codeIntent,{'src/logic.js':source},[{role:'user',content:codeIntent.request},...[1,2,3].map(n=>({role:'tool',tool_call_id:'read-'+n,content:source}))]).metrics},
  preparedRepeatedInput:{source:'Same synthetic task with ten identical reads; not an observed agent trace',...require('./prepare.cjs').prepareInput(codeIntent,{'src/logic.js':source},[{role:'user',content:codeIntent.request},...Array.from({length:10},(_,n)=>({role:'tool',tool_call_id:'read-'+(n+1),content:source}))]).metrics},
  workspace:require('./workspace-demo.cjs')(),
  limitations:['Two conservative boolean-return forms','Intent is explicitly structured by a person or agent; not automatically understood',
    'Checks declared plans and observed working-tree files; behavior/visual acceptance is not run',
    'Ignored files, Git internals and concurrent hostile mutation are outside the observer scope',
    'No measured improvement in whole-agent cost, task success or user understanding'],
};
console.log(JSON.stringify(report,null,2));
