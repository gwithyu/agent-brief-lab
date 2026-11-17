'use strict';
const {test}=require('node:test'),assert=require('node:assert/strict');
const fs=require('node:fs'),os=require('node:os'),path=require('node:path'),{spawnSync}=require('node:child_process');
const {analyzeEfficiency,buildChargeTemplate,runCli}=require('../evaluation/cost-quality.cjs');
const {formatEfficiencyMarkdown}=require('../evaluation/cost-quality-markdown.cjs');

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
  assert.equal(result.observedOnThisSample.ownerReportedSavingsCandidate,true);
  assert.equal(result.observedOnThisSample.qualifiesAsMeasuredWin,false);
  assert.equal(result.observedOnThisSample.verifiedSavingsClaim,false);
  assert.equal(result.sample.distinctTaskCount,2);
  assert.equal(result.sample.meets30DistinctTaskGate,false);
  assert.equal(result.sample.evidenceAuthenticatedByProvider,false);
  assert.equal(result.cost.source[0],'provider_export');
  assert.deepEqual(result.cost.rawProviderTokenCounts,{providerInputTokens:200,providerCachedInputTokens:80,providerOutputTokens:40,providerReasoningTokens:10});
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
test('generate a null-cost import template without receipts, secrets or fabricated charges',()=>{
  const report=fixture();
  const template=buildChargeTemplate(report);
  assert.equal(template.schema,'agent-brief-charges.v1');
  assert.equal(template.manifestDigest,report.manifestDigest);
  assert.equal(template.observations.length,4);
  assert.ok(template.observations.every(x=>x.billedCostUsd===null&&x.attemptCount===1));
  const empty=analyzeEfficiency(report,template);
  assert.equal(empty.cost.status,'missing_billed_cost');
  assert.equal(empty.cost.rawTotalUsd,null);
  const dir=fs.mkdtempSync(path.join(os.tmpdir(),'brief-cost-template-'));
  try{
    const file=path.join(dir,'report.json');fs.writeFileSync(file,JSON.stringify(report));
    assert.deepEqual(runCli(['--report',file,'--template']),template);
  }finally{fs.rmSync(dir,{recursive:true,force:true});}
});
test('reported aggregate pass counts and missing model attribution cannot be silently trusted',()=>{
  const wrong=fixture();wrong.passed+=1;
  assert.throws(()=>analyzeEfficiency(wrong),/inconsistent_report_summary/);
  const absent=fixture();absent.runs[0].reportedModel=null;
  assert.throws(()=>analyzeEfficiency(absent),/missing_or_drifted_reported_model/);
});
test('sub-cent charges retain real precision in cost comparisons',()=>{
  const report=fixture(),cost=charges(report,[0.000000001,0.000000001],[0.0000000005,0.0000000005]);
  const x=analyzeEfficiency(report,cost);
  assert.ok(x.cost.rawTotalUsd>0);
  assert.ok(x.cost.preparedTotalUsd>0);
  assert.equal(x.cost.rawUsdPerSuccess,0.000000001);
  assert.equal(x.cost.preparedUsdPerSuccess,0.0000000005);
  assert.equal(x.observedOnThisSample.ownerReportedSavingsCandidate,true);
  assert.equal(x.observedOnThisSample.qualifiesAsMeasuredWin,false);
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

test('human scorecard never labels self-reported amounts as verified savings',()=>{
  const report=fixture();
  const scored=analyzeEfficiency(report,charges(report,[0.1,0.1],[0.05,0.07]));
  assert.equal(scored.observedOnThisSample.ownerReportedSavingsCandidate,true);
  assert.equal(scored.observedOnThisSample.qualifiesAsMeasuredWin,false);
  assert.equal(scored.observedOnThisSample.verifiedSavingsClaim,false);
  const page=formatEfficiencyMarkdown(scored);
  assert.match(page,/Verified real-world savings: NO/);
  assert.match(page,/Owner-declared candidate only — NOT VERIFIED/);
  assert.match(page,/Correct tasks/);
  assert.match(page,/\$0.1000/);
  assert.match(page,/\$0.0600/);
  assert.match(page,/fewer than 30 distinct tasks/);
  assert.match(page,/not independently verified/);
  assert.doesNotMatch(page,/Verified real-world savings: YES/);
});
test('human scorecard marks price unknown without external charges',()=>{
  const report=fixture();
  const text=formatEfficiencyMarkdown(analyzeEfficiency(report));
  assert.match(text,/Cost unknown — no savings claim/);
  assert.match(text,/Owner-declared USD total \| Unknown \| Unknown/);
  assert.match(text,/Local text reduction:\*\* 11\.11%/);
  assert.match(text,/Non-saving input pairs:\*\* 1/);
  assert.match(text,/Sample:\*\* 2 matched pairs \/ 2 distinct tasks/);
});
test('human scorecard shows regressions even when owner enters cheaper total charges',()=>{
  const report=fixture({prepared:[true,false]});
  const page=formatEfficiencyMarkdown(analyzeEfficiency(report,charges(report,[0.1,0.1],[0.07,0.05])));
  assert.match(page,/Quality regression — not recommended/);
  assert.match(page,/Raw-pass \/ prepared-fail regressions:\*\* 1/);
  assert.match(page,/Regression case IDs:\*\* omitted for privacy \(1 regressions/);
  assert.doesNotMatch(page,/task-1/);
  assert.match(page,/Verified real-world savings: NO/);
});
test('markdown only shows aggregate facts; private prompt snippets and paths never render',()=>{
  const report=fixture();
  report.runs[0].prompt='PRIVATE_SOURCE_DO_NOT_PRINT';
  report.runs[0].homeDirectory='/Users/private/demo';
  const summary=analyzeEfficiency(report);
  const page=formatEfficiencyMarkdown(summary);
  assert.doesNotMatch(page,/PRIVATE_SOURCE_DO_NOT_PRINT/);
  assert.doesNotMatch(page,/\/Users\/private/);
  assert.ok(page.length<8000);
});
test('shareable scorecard never emits user-supplied private task identifiers',()=>{
  const report=fixture({raw:[true,false],prepared:[false,true]});
  for(const run of report.runs)
    if(run.case==='task-0')run.case='client-ACME_secret_path_/Users/alice';
  const summary=analyzeEfficiency(report);
  const text=formatEfficiencyMarkdown(summary);
  assert.match(text,/Regression case IDs:\*\* omitted for privacy/);
  assert.doesNotMatch(text,/ACME|alice|secret_path|task-0/);
  assert.equal(summary.quality.regressionCases[0].case,'client-ACME_secret_path_/Users/alice');
});
test('30 synthetic tasks do not unlock a real-world cost-savings claim',()=>{
  const yes=Array(30).fill(true);
  const report=fixture({raw:yes,prepared:yes,rawTokens:Array(30).fill(100),preparedTokens:Array(30).fill(70)});
  const summary=analyzeEfficiency(report,charges(report,Array(30).fill(0.1),Array(30).fill(0.07)));
  assert.equal(summary.sample.distinctTaskCount,30);
  assert.equal(summary.sample.meets30DistinctTaskGate,true);
  assert.equal(summary.sample.isRepresentativeProductionSample,false);
  assert.equal(summary.observedOnThisSample.ownerReportedSavingsCandidate,true);
  assert.equal(summary.observedOnThisSample.qualifiesAsMeasuredWin,false);
  assert.match(formatEfficiencyMarkdown(summary),/Verified real-world savings: NO/);
});
test('markdown command outputs a screenshot-friendly scorecard and never a template',()=>{
  const dir=fs.mkdtempSync(path.join(os.tmpdir(),'brief-human-score-'));
  try{
    const file=path.join(dir,'report.json'),inv=path.join(dir,'charges.json');
    const report=fixture();
    fs.writeFileSync(file,JSON.stringify(report),{mode:0o600});
    fs.writeFileSync(inv,JSON.stringify(charges(report,[0.1,0.1],[0.07,0.07])),{mode:0o600});
    const text=runCli(['--report',file,'--charges',inv,'--markdown']);
    assert.equal(typeof text,'string');
    assert.match(text,/Verified real-world savings: NO/);
    assert.match(runCli(['--report',file,'--markdown']),/Cost unknown/);
    assert.throws(()=>runCli(['--report',file,'--template','--markdown']),/Usage/);
    const command=spawnSync(process.execPath,['evaluation/cost-quality.cjs','--report',file,'--charges',inv,'--markdown'],
      {cwd:path.resolve(__dirname,'..'),encoding:'utf8',timeout:15000});
    assert.equal(command.status,0,command.stderr);
    assert.match(command.stdout,/^# Agent Brief Lab/);
    assert.deepEqual(fs.readdirSync(dir).sort(),['charges.json','report.json']);
  }finally{fs.rmSync(dir,{recursive:true,force:true});}
});
