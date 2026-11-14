'use strict';
const {test}=require('node:test'),assert=require('node:assert/strict');
const fs=require('node:fs'),os=require('node:os'),path=require('node:path'),{spawnSync}=require('node:child_process');
const {analyzeEfficiency,runCli}=require('../evaluation/cost-quality.cjs');

function fixture({raw=[true,true],prepared=[true,true],rawTokens=[100,80],preparedTokens=[70,90]}={}){
  const runs=[];
  for(let i=0;i<raw.length;i++)for(const arm of ['raw','prepared']){
    const state=arm==='raw'?raw:prepared,local=arm==='raw'?rawTokens:preparedTokens;
    runs.push({case:'task-'+i,repeat:0,arm,state:'completed',passed:state[i],
      reportedModel:'pinned-test-model',localInputTextTokens:local[i]});
  }
  return {provider:'cursor-cli',experiment:'read-only-code-proposals',modelRequested:'pinned-test-model',
    manifestDigest:'locked-manifest',repositoryCommit:'locked-commit',gitIntegrity:'PASS',
    state:'completed',comparisonComplete:true,planned:runs.length,attempted:runs.length,
    modelCompleted:runs.length,passed:runs.filter(x=>x.passed).length,runs};
}
function charges(report,rawAmounts,preparedAmounts,{source='provider_export'}={}){
  return {schema:'agent-brief-charges.v1',manifestDigest:report.manifestDigest,
    repositoryCommit:report.repositoryCommit,modelRequested:report.modelRequested,currency:'USD',
    observations:report.runs.map(r=>({case:r.case,repeat:r.repeat,arm:r.arm,attemptCount:1,
      billedCostUsd:(r.arm==='raw'?rawAmounts:preparedAmounts)[Number(r.case.slice(5))],
      source,providerInputTokens:r.arm==='raw'?100:70,
      providerCachedInputTokens:r.arm==='raw'?40:10,
      providerOutputTokens:20,providerReasoningTokens:5}))};
}
test('without provider invoice/charges, quality is measured but money stays unknown',()=>{
  const report=fixture();
  const result=analyzeEfficiency(report);
  assert.equal(result.pairCount,2);
  assert.equal(result.quality.rawPasses,2);
  assert.equal(result.quality.preparedPasses,2);
  assert.equal(result.quality.regressions,0);
  assert.equal(result.localInputText.rawTokens,180);
  assert.equal(result.localInputText.preparedTokens,160);
  assert.equal(result.localInputText.tokensSaved,20);
  assert.equal(result.localInputText.nonSavingPairs.length,1);
  assert.equal(result.cost.rawTotalUsd,null);
  assert.equal(result.cost.rawUsdPerSuccess,null);
  assert.equal(result.observedOnThisSample.lowerCostPerSuccess,null);
  assert.equal(result.observedOnThisSample.qualifiesAsMeasuredWin,false);
  assert.equal(result.cost.actualInvoiceVerified,false);
});
test('success-normalized cost exposes false savings when compression causes quality regression',()=>{
  const report=fixture({prepared:[true,false]});
  const result=analyzeEfficiency(report,charges(report,[0.10,0.10],[0.07,0.05]));
  assert.equal(result.quality.regressions,1);
  assert.equal(result.cost.rawTotalUsd,0.2);
  assert.equal(result.cost.preparedTotalUsd,0.12);
  assert.equal(result.cost.rawUsdPerSuccess,0.1);
  assert.equal(result.cost.preparedUsdPerSuccess,0.12);
  assert.equal(result.cost.deltaUsdPerSuccess,-0.02);
  assert.equal(result.cost.reductionFractionPerSuccess,-0.2);
  assert.equal(result.observedOnThisSample.qualifiesAsMeasuredWin,false);
  assert.equal(result.cost.actualInvoiceVerified,false);
});
test('same exact quality and lower declared cost may win on this sample only',()=>{
  const report=fixture();
  const result=analyzeEfficiency(report,charges(report,[0.10,0.10],[0.05,0.07]));
  assert.equal(result.cost.rawUsdPerSuccess,0.10);
  assert.equal(result.cost.preparedUsdPerSuccess,0.06);
  assert.equal(result.cost.reductionFractionPerSuccess,0.4);
  assert.equal(result.observedOnThisSample.qualifiesAsMeasuredWin,true);
  assert.equal(result.cost.source[0],'provider_export');
  assert.deepEqual(result.cost.rawBilledTokens,{providerInputTokens:200,providerCachedInputTokens:80,providerOutputTokens:40,providerReasoningTokens:10});
});
test('missing or null charges cannot produce a monetary claim',()=>{
  const report=fixture();
  const short=charges(report,[0.1,0.1],[0.07,0.07]);
  short.observations.pop();
  assert.equal(analyzeEfficiency(report,short).cost.status,'incomplete_charge_coverage');
  assert.equal(analyzeEfficiency(report,short).cost.rawTotalUsd,null);
  const missing=charges(report,[0.1,0.1],[0.07,0.07]);
  missing.observations[0].billedCostUsd=null;
  assert.equal(analyzeEfficiency(report,missing).cost.status,'missing_billed_cost');
  assert.equal(analyzeEfficiency(report,missing).cost.rawTotalUsd,null);
});
test('zero successes cannot imply an infinite or fictional zero cost per success',()=>{
  const report=fixture({raw:[false,false],prepared:[false,false]});
  const result=analyzeEfficiency(report,charges(report,[.1,.1],[.07,.07]));
  assert.equal(result.quality.rawSuccessRate,0);
  assert.equal(result.cost.rawUsdPerSuccess,null);
  assert.equal(result.cost.preparedUsdPerSuccess,null);
  assert.equal(result.cost.reductionFractionPerSuccess,null);
  assert.equal(result.observedOnThisSample.qualifiesAsMeasuredWin,false);
});
test('reject mismatched, invalid, duplicate, fabricated or retry charge evidence',()=>{
  const report=fixture();
  const base=charges(report,[.1,.1],[.07,.07]);
  for(const mutate of [
    x=>{x.manifestDigest='elsewhere';},
    x=>{x.repositoryCommit='other';},
    x=>{x.currency='EUR';},
    x=>{x.observations[0].attemptCount=2;},
    x=>{x.observations[0].billedCostUsd=-0.01;},
    x=>{x.observations[0].providerCachedInputTokens=10000;},
    x=>{x.observations[0].providerInputTokens=-1;},
    x=>{x.observations[0].source='invented_evidence';},
    x=>{x.observations[0].secret='hidden';},
    x=>{x.observations[0].case='unrecognized-task';},
    x=>{x.observations.push({...x.observations[0]});}
  ]){
    const bad=structuredClone(base);mutate(bad);
    assert.throws(()=>analyzeEfficiency(report,bad));
  }
});
test('reject unpaired, incomplete, duplicate, unclean or wrong-experiment model runs',()=>{
  for(const mutate of [
    x=>{x.runs.pop();x.planned--;x.attempted--;},
    x=>{x.runs[0].arm='prepared';},
    x=>{x.runs[0].state='not_run';},
    x=>{x.runs[0].localInputTextTokens=-1;},
    x=>{x.gitIntegrity='FAIL';},
    x=>{x.comparisonComplete=false;},
    x=>{x.experiment='autonomous-agent-edits';},
    x=>{x.runs[1].reportedModel='different';}
  ]){
    const bad=fixture();mutate(bad);
    assert.throws(()=>analyzeEfficiency(bad));
  }
});
test('quality improvements and regression pairs are never hidden by total success count',()=>{
  const report=fixture({raw:[true,false],prepared:[false,true]});
  const result=analyzeEfficiency(report);
  assert.equal(result.quality.rawSuccessRate,.5);
  assert.equal(result.quality.preparedSuccessRate,.5);
  assert.equal(result.quality.regressions,1);
  assert.equal(result.quality.improvements,1);
  assert.deepEqual(result.quality.regressionCases,[{case:'task-0',repeat:0}]);
  assert.equal(result.observedOnThisSample.qualityNonInferior,false);
});
test('read-only command consumes private JSON and writes only sanitized aggregate stdout',()=>{
  const dir=fs.mkdtempSync(path.join(os.tmpdir(),'brief-cost-check-'));
  try{
    const file=path.join(dir,'report.json'),invoice=path.join(dir,'charges.json');
    const report=fixture(),obs=charges(report,[.1,.1],[.07,.07],{source:'invoice_transcription'});
    fs.writeFileSync(file,JSON.stringify(report));
    fs.writeFileSync(invoice,JSON.stringify(obs));
    const value=runCli(['--report',file,'--charges',invoice]);
    assert.equal(value.cost.status,'owner_supplied_complete_unverified');
    assert.equal(value.cost.actualInvoiceVerified,false);
    const proc=spawnSync(process.execPath,['evaluation/cost-quality.cjs','--report',file,'--charges',invoice],
      {cwd:path.resolve(__dirname,'..'),encoding:'utf8',timeout:10000});
    assert.equal(proc.status,0,proc.stderr);
    const parsed=JSON.parse(proc.stdout);
    assert.equal(parsed.pairCount,2);
    assert.ok(!proc.stdout.includes('invoice_transcription:secret'));
    assert.deepEqual(fs.readdirSync(dir).sort(),['charges.json','report.json']);
  }finally{fs.rmSync(dir,{recursive:true,force:true});}
});
