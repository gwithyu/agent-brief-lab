'use strict';
const {test}=require('node:test'),assert=require('node:assert/strict');
const fs=require('node:fs'),os=require('node:os'),path=require('node:path');
const {spawnSync}=require('node:child_process');
const {buildHandoff}=require('../handoff.cjs');
const {makePair}=require('../paired-handoff.cjs');
const {createTrial,scoreTrial,importCodexTrial,runCli}=require('../evaluation/owner-trial.cjs');
const cli=path.resolve(__dirname,'../index.cjs');
function fixture(fn,{repeats=2,source='function f(v){\n  if (v) return true;\n  else return false;\n}\n'}={}){
  const root=fs.mkdtempSync(path.join(os.tmpdir(),'brief-owner-trial-'));
  const repo=path.join(root,'repo'),handoff=path.join(root,'handoff'),
    pair=path.join(root,'pair'),trial=path.join(root,'trial');
  fs.mkdirSync(repo);fs.writeFileSync(path.join(repo,'logic.js'),source);
  for(const args of [
    ['init','-b','main'],['add','.'],
    ['-c','user.name=Test','-c','user.email=test@example.invalid','-c','commit.gpgsign=false',
      '-c','core.hooksPath=/dev/null','commit','-m','test']
  ]){
    const r=spawnSync('git',args,{cwd:repo,encoding:'utf8',timeout:10000});
    assert.equal(r.status,0,r.stderr);
  }
  buildHandoff({repo,out:handoff,task:'Refactor without changing behavior — CLIENT_SECRET',
    files:['logic.js'],constraints:['Keep f name'],checks:['Run independent test']});
  makePair({handoff,out:pair});
  const r=createTrial({pair,out:trial,model:'test-model-v1',repeats},'raw');
  try{return fn({root,repo,handoff,pair,trial,created:r});}
  finally{fs.rmSync(root,{recursive:true,force:true});}
}
function observations(dir){
  const template=JSON.parse(fs.readFileSync(path.join(dir,'observations.template.json')));
  const manifest=JSON.parse(fs.readFileSync(path.join(dir,'manifest-private.json')));
  return {template,manifest};
}
function fill(dir,{rawPass=true,preparedPass=true,rawCost=.10,preparedCost=.07,attempts=1,source='provider_export'}={}){
  const {template,manifest}=observations(dir);
  // Retain the original aggregate format as a backwards-compatibility fixture.
  template.schema='agent-brief-owner-trial-observations.v1';
  for(const item of template.entries){
    delete item.attempts;
    const job=manifest.slots.find(s=>s.id===item.slot);
    item.terminal='completed';
    item.correct=job.arm==='raw'?rawPass:preparedPass;
    item.modelObserved='test-model-v1';
    item.attemptCount=attempts;
    item.billedCostUsd=job.arm==='raw'?rawCost:preparedCost;
    item.billingSource=source;
  }
  const name=path.join(path.dirname(dir),'owner-observations.json');
  fs.writeFileSync(name,JSON.stringify(template),{mode:0o600});
  return {name,template,manifest};
}
function fillAttempts(dir){
  const {name,template,manifest}=fill(dir);
  template.schema='agent-brief-owner-trial-observations.v2';
  template.entries=template.entries.map(e=>({
    slot:e.slot,terminal:e.terminal,correct:e.correct,independentCheckLogSha256:null,
    attempts:[{
      terminal:'failed',modelObserved:'test-model-v1',billedCostUsd:.02,
      billingSource:'provider_export',usageSource:'provider_export',
      inputTokens:100,outputTokens:10,cachedInputTokens:20
    },{
      terminal:e.terminal,modelObserved:e.modelObserved,billedCostUsd:e.billedCostUsd,
      billingSource:e.billingSource,usageSource:'provider_export',
      inputTokens:200,outputTokens:30,cachedInputTokens:50
    }]
  }));
  fs.writeFileSync(name,JSON.stringify(template));
  return {name,template,manifest};
}
function codexImportFixture(root,trial){
  const {manifest}=observations(trial);
  const spec={schema:'agent-brief-codex-trial-import.v1',pairFingerprint:manifest.pairFingerprint,
    entries:manifest.slots.map((s,i)=>{
      const eventsFile=`trace-${i}.jsonl`;
      fs.writeFileSync(path.join(root,eventsFile),[
        {type:'thread.started',thread_id:`private-thread-${i}`},{type:'turn.started'},
        {type:'item.completed',item:{id:'msg',type:'agent_message',text:'CLIENT_SECRET'}},
        {type:'turn.completed',usage:{input_tokens:100+i,cached_input_tokens:20,output_tokens:10}}
      ].map(x=>JSON.stringify(x)).join('\n')+'\n');
      return {slot:s.id,promptSha256:s.promptSha256,attempts:[{
        eventsFile,exitCode:0,modelObserved:manifest.modelRequested,freshSession:true
      }]};
    })};
  const runs=path.join(root,'import-map.json'),out=path.join(root,'imported');
  fs.writeFileSync(runs,JSON.stringify(spec));
  return {runs,out,spec};
}
test('fresh init creates ordered alternate assignments and private prompt files',()=>fixture(({repo,pair,trial,created})=>{
  assert.equal(created.status,'ready_for_manual_trial');
  assert.equal(created.modelCalls,0);
  assert.equal(created.providerBillUsd,null);
  assert.equal(created.slots,4);
  assert.equal(created.rawSlots,2);
  assert.equal(created.preparedSlots,2);
  const {template,manifest}=observations(trial);
  assert.deepEqual(manifest.slots.map(s=>s.arm),['raw','prepared','prepared','raw']);
  assert.deepEqual(manifest.slots.map(s=>s.repeat),[0,0,1,1]);
  assert.equal(template.schema,'agent-brief-owner-trial-observations.v2');
  assert.ok(template.entries.every(x=>x.terminal===null&&x.correct===null&&x.attempts===null));
  const src=fs.readFileSync(path.join(pair,'raw.txt'),'utf8');
  assert.equal(fs.readFileSync(path.join(trial,'slot-01.txt'),'utf8'),src);
  assert.equal(fs.statSync(trial).mode&0o777,0o700);
  for(const entry of fs.readdirSync(trial))
    assert.equal(fs.statSync(path.join(trial,entry)).mode&0o777,0o600);
  assert.equal(spawnSync('git',['status','--porcelain'],{cwd:repo,encoding:'utf8'}).stdout.trim(),'');
  assert.ok(!fs.readFileSync(path.join(trial,'INSTRUCTIONS.txt'),'utf8').includes('CLIENT_SECRET'));
}));
test('unfilled template never invents success rates, billed prices or money savings',()=>fixture(({trial})=>{
  const scored=scoreTrial({trial,observations:path.join(trial,'observations.template.json')});
  assert.equal(scored.trialStatus,'incomplete_runs');
  assert.equal(scored.missingRunCount,4);
  assert.equal(scored.quality.rawCorrect,null);
  assert.equal(scored.costs.rawTotalUsd,null);
  assert.equal(scored.ownerReportedCandidate,false);
  assert.equal(scored.verifiedRealWorldSavings,false);
}));
test('complete owner observations may suggest provisional cost gain but never verified savings',()=>fixture(({trial})=>{
  const {name}=fill(trial);
  const scored=scoreTrial({trial,observations:name});
  assert.equal(scored.trialStatus,'owner_reported_complete');
  assert.equal(scored.quality.rawCorrect,2);
  assert.equal(scored.quality.preparedCorrect,2);
  assert.equal(scored.quality.rawPassPreparedFail,0);
  assert.equal(scored.costs.rawTotalUsd,0.2);
  assert.equal(scored.costs.preparedTotalUsd,0.14);
  assert.equal(scored.costs.rawUsdPerSuccess,.1);
  assert.equal(scored.costs.preparedUsdPerSuccess,.07);
  assert.equal(scored.costs.lowerUsdPerSuccess,true);
  assert.equal(scored.ownerReportedCandidate,true);
  assert.equal(scored.verifiedRealWorldSavings,false);
  assert.equal(scored.quality.independentlyVerified,false);
  assert.equal(scored.trial.distinctTasks,undefined);
  assert.equal(scored.trial.promptTreatmentDistinct,true);
}));
test('identical fallback prompts are a control, even when declared bills look cheaper',()=>fixture(({trial})=>{
  const {name}=fill(trial);
  const s=scoreTrial({trial,observations:name});
  assert.equal(s.costs.lowerUsdPerSuccess,true);
  assert.equal(s.trial.promptTreatmentDistinct,false);
  assert.equal(s.ownerReportedCandidate,false);
  assert.equal(s.verifiedRealWorldSavings,false);
  assert.match(s.conclusion,/Identical prompts: control trial only/);
},{source:'x'.repeat(600)}));
test('cheaper total cost with one prepared failure is more expensive per success',()=>fixture(({trial})=>{
  const {name,template,manifest}=fill(trial,{rawPass:true,preparedPass:true,rawCost:.1,preparedCost:.06});
  for(const e of template.entries){
    const s=manifest.slots.find(x=>x.id===e.slot);
    if(s.arm==='prepared'&&s.repeat===1)e.correct=false;
  }
  fs.writeFileSync(name,JSON.stringify(template));
  const scored=scoreTrial({trial,observations:name});
  assert.equal(scored.quality.rawCorrect,2);
  assert.equal(scored.quality.preparedCorrect,1);
  assert.equal(scored.quality.rawPassPreparedFail,1);
  assert.equal(scored.costs.rawTotalUsd,.2);
  assert.equal(scored.costs.preparedTotalUsd,.12);
  assert.equal(scored.costs.rawUsdPerSuccess,.1);
  assert.equal(scored.costs.preparedUsdPerSuccess,.12);
  assert.equal(scored.costs.lowerUsdPerSuccess,false);
  assert.equal(scored.ownerReportedCandidate,false);
}));
test('costs are unknown if a receipt is missing or manually estimated',()=>fixture(({trial})=>{
  const {name,template}=fill(trial);
  template.entries[0].billedCostUsd=null;
  fs.writeFileSync(name,JSON.stringify(template));
  let a=scoreTrial({trial,observations:name});
  assert.equal(a.costs.status,'incomplete_or_non_receipt_prices');
  assert.equal(a.costs.rawUsdPerSuccess,null);
  template.entries[0].billedCostUsd=.1;
  template.entries[0].billingSource='manual_estimate';
  fs.writeFileSync(name,JSON.stringify(template));
  a=scoreTrial({trial,observations:name});
  assert.equal(a.costs.status,'incomplete_or_non_receipt_prices');
  assert.equal(a.ownerReportedCandidate,false);
  assert.equal(a.verifiedRealWorldSavings,false);
}));
test('completed run with unknown correctness cannot produce a quality verdict',()=>fixture(({trial})=>{
  const {name,template}=fill(trial);
  template.entries[0].correct=null;
  fs.writeFileSync(name,JSON.stringify(template));
  const a=scoreTrial({trial,observations:name});
  assert.equal(a.trialStatus,'incomplete_quality_grades');
  assert.equal(a.quality.rawCorrect,null);
  assert.equal(a.ownerReportedCandidate,false);
  assert.equal(a.verifiedRealWorldSavings,false);
}));
test('reject invented model, mismatched fingerprint, missing/duplicate job or fake success terminal',()=>fixture(({trial})=>{
  const {name,template}=fill(trial);
  const mutate=[
    x=>{x.modelRequested='different';},
    x=>{x.pairFingerprint='different';},
    x=>{x.entries.pop();},
    x=>{x.entries[1].slot=x.entries[0].slot;},
    x=>{x.entries[0].modelObserved='wrong-model';},
    x=>{x.entries[0].terminal='failed';x.entries[0].correct=true;},
    x=>{x.entries[0].billedCostUsd=-.01;},
    x=>{x.entries[0].attemptCount=0;},
    x=>{x.entries[0].secret='PRIVATE';}
  ];
  for(const edit of mutate){
    const bad=structuredClone(template);edit(bad);
    fs.writeFileSync(name,JSON.stringify(bad));
    assert.throws(()=>scoreTrial({trial,observations:name}));
  }
}));
test('infrastructure-blocked run must not be treated as a fair quality-cost comparison',()=>fixture(({trial})=>{
  const {name,template}=fill(trial);
  template.entries[0].terminal='blocked';
  template.entries[0].correct=false;
  fs.writeFileSync(name,JSON.stringify(template));
  const scored=scoreTrial({trial,observations:name});
  assert.equal(scored.trialStatus,'blocked_infrastructure');
  assert.equal(scored.quality.rawCorrect,null);
  assert.equal(scored.quality.qualityNoRegression,null);
  assert.equal(scored.costs.rawUsdPerSuccess,null);
  assert.equal(scored.ownerReportedCandidate,false);
  assert.equal(scored.verifiedRealWorldSavings,false);
  assert.match(scored.conclusion,/Infrastructure blocked/);
}));
test('tampered prompt bytes and symlinked prompt files are refused',()=>fixture(({trial})=>{
  const {name}=fill(trial);
  const prompt=path.join(trial,'slot-01.txt'),source=fs.readFileSync(prompt);
  fs.writeFileSync(prompt,Buffer.concat([source,Buffer.from('MALICIOUS_INPUT')]));
  assert.throws(()=>scoreTrial({trial,observations:name}),/trial_prompt_integrity_failure/);
  fs.writeFileSync(prompt,source);
  const link=path.join(trial,'slot-01.txt.backup');fs.renameSync(prompt,link);
  fs.symlinkSync(link,prompt);
  assert.throws(()=>scoreTrial({trial,observations:name}),/invalid_private_file/);
}));
test('small billed amounts use exact integer-unit accumulation',()=>fixture(({trial})=>{
  const {name}=fill(trial,{rawCost:0.000000000001,preparedCost:0.0000000000005});
  assert.throws(()=>scoreTrial({trial,observations:name}),/unsupported_charge_precision/);
  const {template}=observations(trial);
  template.schema='agent-brief-owner-trial-observations.v1';
  const {manifest}=observations(trial);
  for(const e of template.entries){
    delete e.attempts;
    const s=manifest.slots.find(x=>x.id===e.slot);
    e.terminal='completed';e.correct=true;e.modelObserved='test-model-v1';
    e.attemptCount=1;e.billingSource='provider_export';
    e.billedCostUsd=s.arm==='raw'?0.000000001:0.0000000005;
  }
  fs.writeFileSync(name,JSON.stringify(template));
  const scored=scoreTrial({trial,observations:name});
  assert.equal(scored.costs.rawTotalUsd,2e-9);
  assert.equal(scored.costs.preparedTotalUsd,1e-9);
  assert.equal(scored.ownerReportedCandidate,true);
}));
test('trial identity is bound to the intent and order alternation is checked',()=>fixture(({trial,pair})=>{
  const {name}=fill(trial);
  const manifestPath=path.join(trial,'manifest-private.json');
  const manifest=JSON.parse(fs.readFileSync(manifestPath));
  const saved=structuredClone(manifest);
  manifest.intentDigest='0'.repeat(64);
  fs.writeFileSync(manifestPath,JSON.stringify(manifest));
  assert.throws(()=>scoreTrial({trial,observations:name}),/invalid_trial_manifest/);
  const changed=structuredClone(saved);
  const third=path.join(trial,'slot-03.txt'),fourth=path.join(trial,'slot-04.txt');
  const raw=fs.readFileSync(path.join(pair,'raw.txt'));
  const prepared=fs.readFileSync(path.join(pair,'prepared.txt'));
  changed.slots[2].arm='raw';changed.slots[2].promptSha256=changed.rawSha256;
  changed.slots[3].arm='prepared';changed.slots[3].promptSha256=changed.preparedSha256;
  fs.writeFileSync(third,raw);fs.writeFileSync(fourth,prepared);
  fs.writeFileSync(manifestPath,JSON.stringify(changed));
  assert.throws(()=>scoreTrial({trial,observations:name}),/trial_order_integrity_failure/);
}));
test('three-repeat trial alternates order but does not claim perfectly balanced order',()=>fixture(({trial})=>{
  const {name}=fill(trial);
  const scored=scoreTrial({trial,observations:name});
  assert.equal(scored.trial.orderAlternated,true);
  assert.equal(scored.trial.orderBalanced,false);
  assert.equal(scored.pairedRepeats,3);
  assert.equal(scored.distinctTasks,1);
},{repeats:3}));
test('reported multiple attempts are allowed only as owner-total charges',()=>fixture(({trial})=>{
  const {name}=fill(trial,{attempts:3,rawCost:.1,preparedCost:.08});
  const scored=scoreTrial({trial,observations:name});
  assert.equal(scored.costs.rawTotalUsd,.2);
  assert.equal(scored.costs.preparedTotalUsd,.16);
  assert.equal(scored.costs.providerInvoiceAuthenticated,false);
  assert.equal(scored.verifiedRealWorldSavings,false);
}));
test('CLI init/score does not echo source text or private task labels',()=>fixture(({root,trial})=>{
  const {name}=fill(trial);
  const score=spawnSync(process.execPath,[cli,'trial','score','--trial',trial,'--observations',name],
    {encoding:'utf8',timeout:10000});
  assert.equal(score.status,0,score.stderr);
  const result=JSON.parse(score.stdout);
  assert.equal(result.verifiedRealWorldSavings,false);
  assert.doesNotMatch(score.stdout,/CLIENT_SECRET|function f|\/tmp\//);
  const usage=spawnSync(process.execPath,[cli,'trial','--help'],{encoding:'utf8',timeout:5000});
  assert.equal(usage.status,0);
  assert.match(usage.stdout,/manual paired task trial/);
  const invalid=spawnSync(process.execPath,[cli,'trial','score','--trial',trial,'--observations',name,'--oops'],
    {encoding:'utf8',timeout:5000});
  assert.equal(invalid.status,1);
}));
test('per-attempt ledger includes failed retry charges and native usage, with cache a subset',()=>fixture(({trial})=>{
  const {name}=fillAttempts(trial);
  const s=scoreTrial({trial,observations:name});
  assert.equal(s.costs.rawTotalUsd,.24);
  assert.equal(s.costs.preparedTotalUsd,.18);
  assert.equal(s.costs.rawUsdPerSuccess,.12);
  assert.equal(s.attempts.rawCount,4);
  assert.equal(s.attempts.preparedCount,4);
  assert.deepEqual(s.providerUsage.raw,{inputTokens:600,outputTokens:80,cachedInputTokens:140});
  assert.equal(s.providerUsage.inputIncludesCachedTokens,true);
  assert.equal(s.providerUsage.authenticated,false);
  assert.equal(s.verifiedRealWorldSavings,false);
}));
test('missing failed-attempt charge withholds all comparative cost claims',()=>fixture(({trial})=>{
  const {name,template}=fillAttempts(trial);
  template.entries[0].attempts[0].billedCostUsd=null;
  template.entries[0].attempts[0].billingSource='unknown';
  fs.writeFileSync(name,JSON.stringify(template));
  const s=scoreTrial({trial,observations:name});
  assert.equal(s.costs.rawTotalUsd,null);
  assert.equal(s.costs.lowerUsdPerSuccess,null);
  assert.equal(s.ownerReportedCandidate,false);
  assert.equal(s.providerUsage.raw.inputTokens,600);
}));
test('manual retry estimate never qualifies as a receipt total',()=>fixture(({trial})=>{
  const {name,template}=fillAttempts(trial);
  template.entries[0].attempts[0].billingSource='manual_estimate';
  fs.writeFileSync(name,JSON.stringify(template));
  const s=scoreTrial({trial,observations:name});
  assert.equal(s.costs.rawTotalUsd,null);
  assert.equal(s.ownerReportedCandidate,false);
}));
test('missing usage fields stay independently unknown and do not invent billing',()=>fixture(({trial})=>{
  const {name,template}=fillAttempts(trial);
  template.entries[0].attempts[0].outputTokens=null;
  fs.writeFileSync(name,JSON.stringify(template));
  let s=scoreTrial({trial,observations:name});
  assert.equal(s.providerUsage.raw.inputTokens,600);
  assert.equal(s.providerUsage.raw.outputTokens,null);
  assert.equal(s.costs.rawTotalUsd,.24);
  Object.assign(template.entries[0].attempts[0],{
    usageSource:'unknown',inputTokens:null,outputTokens:null,cachedInputTokens:null
  });
  fs.writeFileSync(name,JSON.stringify(template));
  s=scoreTrial({trial,observations:name});
  assert.deepEqual(s.providerUsage.raw,{inputTokens:null,outputTokens:null,cachedInputTokens:null});
  assert.equal(s.providerUsage.prepared.inputTokens,600);
}));
test('attempt validation rejects mixed models, impossible cache counts and omitted retry details',()=>fixture(({trial})=>{
  const {name,template}=fillAttempts(trial);
  const mutations=[
    e=>{e.attempts[0].modelObserved='other-model';},
    e=>{e.attempts[0].cachedInputTokens=101;},
    e=>{e.attempts[0].inputTokens=-1;},
    e=>{e.attempts[0].outputTokens=.5;},
    e=>{delete e.attempts[0].usageSource;},
    e=>{e.attempts[0].usageSource='unknown';},
    e=>{e.attempts[0].billingSource='unknown';},
    e=>{e.attempts[0].billedCostUsd=-.1;},
    e=>{e.attempts[0].privateLog='CLIENT_SECRET';},
    e=>{e.attempts.at(-1).terminal='failed';},
    e=>{e.attempts[0].terminal='blocked';},
    e=>{e.attempts=[];},
    e=>{e.attempts=null;},
    e=>{e.terminal=null;},
    e=>{e.attempts=Array.from({length:101},()=>e.attempts[0]);}
  ];
  for(const mutate of mutations){
    const bad=structuredClone(template);mutate(bad.entries[0]);
    fs.writeFileSync(name,JSON.stringify(bad));
    assert.throws(()=>scoreTrial({trial,observations:name}));
  }
}));
test('all-failed slot keeps every retry charge in cost per success',()=>fixture(({trial})=>{
  const {name,template}=fillAttempts(trial);
  const e=template.entries[1];e.terminal='failed';e.correct=false;
  e.attempts.at(-1).terminal='failed';
  fs.writeFileSync(name,JSON.stringify(template));
  const s=scoreTrial({trial,observations:name});
  assert.equal(s.costs.preparedTotalUsd,.18);
  assert.equal(s.costs.preparedUsdPerSuccess,.18);
  assert.equal(s.ownerReportedCandidate,false);
}));
test('legacy totals expose no native token counts or independent retry coverage',()=>fixture(({trial})=>{
  const {name}=fill(trial,{attempts:3});
  const s=scoreTrial({trial,observations:name});
  assert.equal(s.attempts.status,'legacy_owner_declared_totals');
  assert.equal(s.attempts.rawCount,6);
  assert.equal(s.providerUsage.status,'unknown_legacy_totals');
  assert.deepEqual(s.providerUsage.raw,{inputTokens:null,outputTokens:null,cachedInputTokens:null});
}));
test('recovered infrastructure block remains noncomparable with every attempt retained',()=>fixture(({trial})=>{
  const {name,template}=fillAttempts(trial);
  const e=template.entries[0];
  e.attempts[0].terminal='blocked';e.terminal='blocked';e.correct=null;
  fs.writeFileSync(name,JSON.stringify(template));
  const s=scoreTrial({trial,observations:name});
  assert.equal(s.trialStatus,'blocked_infrastructure');
  assert.equal(s.costs.rawTotalUsd,null);
  assert.equal(s.quality.rawSuccessRate,null);
  assert.equal(s.attempts.rawCount,4);
  assert.equal(s.ownerReportedCandidate,false);
}));
test('per-attempt charges preserve small exact amounts and reject unsupported precision',()=>fixture(({trial})=>{
  const {name,template}=fillAttempts(trial);
  for(const e of template.entries)for(const a of e.attempts)a.billedCostUsd=1e-12;
  fs.writeFileSync(name,JSON.stringify(template));
  assert.equal(scoreTrial({trial,observations:name}).costs.rawTotalUsd,4e-12);
  template.entries[0].attempts[0].billedCostUsd=5e-13;
  fs.writeFileSync(name,JSON.stringify(template));
  assert.throws(()=>scoreTrial({trial,observations:name}),/unsupported_charge_precision/);
}));
test('native token aggregate over safe integer range stays unknown',()=>fixture(({trial})=>{
  const {name,template}=fillAttempts(trial);
  template.entries[0].attempts[0].inputTokens=Number.MAX_SAFE_INTEGER;
  fs.writeFileSync(name,JSON.stringify(template));
  const s=scoreTrial({trial,observations:name});
  assert.equal(s.providerUsage.raw.inputTokens,null);
  assert.equal(s.providerUsage.raw.outputTokens,80);
}));
test('per-attempt CLI summary contains no slot labels, model ID or private receipt data',()=>fixture(({trial})=>{
  const {name}=fillAttempts(trial);
  const r=spawnSync(process.execPath,[cli,'trial','score','--trial',trial,'--observations',name],
    {encoding:'utf8',timeout:10000});
  assert.equal(r.status,0,r.stderr);
  assert.equal(JSON.parse(r.stdout).attempts.rawCount,4);
  assert.doesNotMatch(r.stdout,/CLIENT_SECRET|slot-01|test-model-v1|\/tmp\//);
}));
test('offline Codex import emits private ungraded observations, unknown bills and trace fingerprints',()=>fixture(({root,trial})=>{
  const {runs,out}=codexImportFixture(root,trial);
  const r=importCodexTrial({trial,runs,out});
  assert.equal(r.modelCalls,0);assert.equal(r.attempts,4);
  assert.equal(r.trialStatus,'incomplete_quality_grades');
  const obs=JSON.parse(fs.readFileSync(r.observationsFile));
  assert.ok(obs.entries.every(e=>e.correct===null&&e.attempts[0].billedCostUsd===null));
  const score=scoreTrial({trial,observations:r.observationsFile});
  assert.equal(score.costs.rawTotalUsd,null);assert.equal(score.ownerReportedCandidate,false);
  assert.deepEqual(score.providerUsage.raw,{inputTokens:203,outputTokens:20,cachedInputTokens:40});
  assert.equal(fs.statSync(out).mode&0o777,0o700);
  for(const file of fs.readdirSync(out))assert.equal(fs.statSync(path.join(out,file)).mode&0o777,0o600);
  const evidence=fs.readFileSync(path.join(out,'import-evidence-private.json'),'utf8');
  assert.match(evidence,/owner_declared_not_observed_in_trace/);
  assert.doesNotMatch(evidence,/CLIENT_SECRET/);
}));
test('import rejects mismatched prompt bindings, models, session declarations and reused logs',()=>fixture(({root,trial})=>{
  const {runs,out,spec}=codexImportFixture(root,trial);
  for(const mutate of [
    s=>{s.pairFingerprint='0'.repeat(64);},
    s=>{s.entries[0].promptSha256='0'.repeat(64);},
    s=>{s.entries[0].attempts[0].modelObserved='other-model';},
    s=>{s.entries[0].attempts[0].freshSession=false;},
    s=>{s.entries[1].attempts[0].eventsFile=s.entries[0].attempts[0].eventsFile;},
    s=>{s.entries[1].slot=s.entries[0].slot;},
    s=>{s.entries.pop();}
  ]){
    const bad=structuredClone(spec);mutate(bad);fs.writeFileSync(runs,JSON.stringify(bad));
    assert.throws(()=>importCodexTrial({trial,runs,out}));assert.equal(fs.existsSync(out),false);
  }
}));
test('same Codex thread with different trace content is still rejected across slots',()=>fixture(({root,trial})=>{
  const {runs,out}=codexImportFixture(root,trial);
  const file=path.join(root,'trace-1.jsonl');
  fs.writeFileSync(file,fs.readFileSync(file,'utf8').replace('private-thread-1','private-thread-0'));
  assert.throws(()=>importCodexTrial({trial,runs,out}),/reused_codex_trace/);
}));
test('import confines trace paths to run-map directory and refuses symlink escapes',()=>fixture(({root,trial})=>{
  const {runs,out,spec}=codexImportFixture(root,trial);
  const dir=path.join(root,'nested');fs.mkdirSync(dir);
  const nestedRuns=path.join(dir,'map.json');
  spec.entries[0].attempts[0].eventsFile='../trace-0.jsonl';
  fs.writeFileSync(nestedRuns,JSON.stringify(spec));
  assert.throws(()=>importCodexTrial({trial,runs:nestedRuns,out}),/unsafe_codex_trace_path/);
  fs.symlinkSync(root,path.join(dir,'escape'));
  spec.entries[0].attempts[0].eventsFile='escape/trace-0.jsonl';
  fs.writeFileSync(nestedRuns,JSON.stringify(spec));
  assert.throws(()=>importCodexTrial({trial,runs:nestedRuns,out}),/unsafe_codex_trace_path/);
}));
test('failed Codex CLI attempt is retained and invalidates comparison after recovery',()=>fixture(({root,trial})=>{
  const {runs,out,spec}=codexImportFixture(root,trial);
  fs.writeFileSync(path.join(root,'failed.jsonl'),[
    {type:'thread.started',thread_id:'failed-thread'},{type:'turn.started'},
    {type:'turn.failed',error:{message:'network problem'}}
  ].map(e=>JSON.stringify(e)).join('\n'));
  spec.entries[0].attempts.unshift({eventsFile:'failed.jsonl',exitCode:1,
    modelObserved:'test-model-v1',freshSession:true});
  fs.writeFileSync(runs,JSON.stringify(spec));
  const r=importCodexTrial({trial,runs,out});
  assert.equal(r.attempts,5);assert.equal(r.trialStatus,'blocked_infrastructure');
  const score=scoreTrial({trial,observations:r.observationsFile});
  assert.equal(score.providerUsage.raw.inputTokens,null);assert.equal(score.costs.rawTotalUsd,null);
}));
test('import CLI emits only aggregate status and safe refusal codes, preserves existing output',()=>fixture(({root,trial})=>{
  const {runs,out}=codexImportFixture(root,trial);
  const args=['trial','import-codex','--trial',trial,'--runs',runs,'--out',out];
  const r=spawnSync(process.execPath,[cli,...args],{encoding:'utf8',timeout:10000});
  assert.equal(r.status,0,r.stderr);assert.equal(JSON.parse(r.stdout).attempts,4);
  assert.doesNotMatch(r.stdout,/CLIENT_SECRET|private-thread|test-model-v1|slot-01/);
  const saved=fs.readFileSync(path.join(out,'observations.json'),'utf8');
  const again=spawnSync(process.execPath,[cli,...args],{encoding:'utf8',timeout:10000});
  assert.equal(again.status,1);assert.match(again.stderr,/trial_output_must_be_new/);
  assert.equal(fs.readFileSync(path.join(out,'observations.json'),'utf8'),saved);
}));
