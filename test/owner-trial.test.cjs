'use strict';
const {test}=require('node:test'),assert=require('node:assert/strict');
const fs=require('node:fs'),os=require('node:os'),path=require('node:path');
const {spawnSync}=require('node:child_process');
const {buildHandoff}=require('../handoff.cjs');
const {makePair}=require('../paired-handoff.cjs');
const {createTrial,scoreTrial,runCli}=require('../evaluation/owner-trial.cjs');
const cli=path.resolve(__dirname,'../index.cjs');
function fixture(fn,{repeats=2}={}){
  const root=fs.mkdtempSync(path.join(os.tmpdir(),'brief-owner-trial-'));
  const repo=path.join(root,'repo'),handoff=path.join(root,'handoff'),
    pair=path.join(root,'pair'),trial=path.join(root,'trial');
  fs.mkdirSync(repo);fs.writeFileSync(path.join(repo,'logic.js'),
    'function f(v){\n  if (v) return true;\n  else return false;\n}\n');
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
  for(const item of template.entries){
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
  assert.ok(template.entries.every(x=>x.terminal===null&&x.correct===null&&x.billedCostUsd===null));
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
}));
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
  const {manifest}=observations(trial);
  for(const e of template.entries){
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
