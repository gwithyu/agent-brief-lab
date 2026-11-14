'use strict';
const {test}=require('node:test'),assert=require('node:assert/strict');
const fs=require('node:fs'),os=require('node:os'),path=require('node:path');
const {spawnSync}=require('node:child_process');
const {proposalCases,proposalManifestDigest,gradeProposal}=require('../evaluation/patch-proposals.cjs');
const {parseArgs,evaluateProposals,runCli}=require('../evaluation/patch-run.cjs');
const cases=proposalCases();
const correct=item=>({needsClarification:!!item.question,
  replacements:item.expectedPaths.map(path=>({path,source:item.expected[path]}))});
const stream=(answer,model='test-model',extra=[])=>({
  status:0,stdout:[{type:'system',subtype:'init',model,session_id:'test-session'},
    ...extra,{type:'result',subtype:'success',is_error:false,
      duration_ms:20,result:JSON.stringify(answer),session_id:'test-session'}]
    .map(JSON.stringify).join('\n')+'\n',stderr:''
});
test('all 30 patch tasks match the existing edit corpus and have stable manifest digest',()=>{
  assert.equal(cases.length,30);
  assert.equal(new Set(cases.map(c=>c.id)).size,30);
  assert.equal(proposalManifestDigest(cases),proposalManifestDigest(proposalCases()));
  assert.equal(cases.filter(x=>x.question).length,2);
  assert.ok(cases.every(x=>x.localInputTextTokens.raw>0&&x.localInputTextTokens.prepared>0));
  const tampered=cases.map(c=>({...c,prompts:{...c.prompts}}));
  tampered[0].prompts.raw+='wrong';
  assert.notEqual(proposalManifestDigest(tampered),proposalManifestDigest(cases));
});
test('all 30 expected full-source proposal answers grade correctly without editing files',()=>{
  for(const c of cases){
    assert.deepEqual(gradeProposal(correct(c),c).passed,true,c.id);
    assert.ok(c.prompts.raw.includes('DOCUMENT:'));
    assert.ok(c.prompts.prepared.includes('DOCUMENT:'));
    assert.match(c.prompts.raw,/Never invoke tools/);
    assert.match(c.prompts.prepared,/Return exactly ONE JSON object/);
  }
});
test('wrong bytes, omitted edits, extra files, duplicate paths and fabricated schema fail',()=>{
  const c=cases.find(x=>x.kind==='json');
  const ok=correct(c);
  const failures=[
    {...ok,replacements:[]},
    {...ok,replacements:[{path:c.expectedPaths[0],source:'wrong'}]},
    {...ok,replacements:[{path:'README.md',source:'do not edit'}]},
    {...ok,replacements:[...ok.replacements,...ok.replacements]},
    {...ok,claimedSuccess:true},
    {...ok,needsClarification:true},
    {needsClarification:false,replacements:[{path:c.expectedPaths[0],source:c.expected[c.expectedPaths[0]],extra:1}]},
    null,'model said success'
  ];
  for(const f of failures)assert.equal(gradeProposal(f,c).passed,false,JSON.stringify(f).slice(0,90));
});
test('unresolved tasks require clarification with zero replacements',()=>{
  const c=cases.find(x=>x.kind==='no_change');
  assert.equal(gradeProposal({needsClarification:true,replacements:[]},c).passed,true);
  assert.equal(gradeProposal({needsClarification:false,replacements:[]},c).passed,false);
  assert.equal(gradeProposal({needsClarification:true,replacements:[{path:c.allowed[0],source:c.expected[c.allowed[0]]}]},c).passed,false);
});
test('paired order alternates and the exact model answer fields are independently graded',()=>{
  const seen=[];
  const r=evaluateProposals(cases.slice(0,2),(c,arm,n)=>{
    seen.push(n+'-'+c.id+'-'+arm);return stream(correct(c));
  },2);
  assert.deepEqual(seen,['0-'+cases[0].id+'-raw','0-'+cases[0].id+'-prepared',
    '0-'+cases[1].id+'-prepared','0-'+cases[1].id+'-raw',
    '1-'+cases[0].id+'-prepared','1-'+cases[0].id+'-raw',
    '1-'+cases[1].id+'-raw','1-'+cases[1].id+'-prepared']);
  assert.equal(r.passed,8);assert.equal(r.modelCompleted,8);
  assert.equal(r.comparisonComplete,true);assert.equal(r.state,'completed');
  assert.ok(r.runs.every(x=>x.providerBilledCost===null&&x.providerInputTokens===null));
});
test('malformed stream or a tool call stops subsequent calls without claiming quality evidence',()=>{
  let n=0;
  const r=evaluateProposals(cases.slice(0,3),()=>{n++;return stream(correct(cases[0]),'test-model',[{type:'tool_call',subtype:'started'}]);});
  assert.equal(n,1);assert.equal(r.state,'blocked');assert.equal(r.modelCompleted,0);
  assert.equal(r.runs.filter(x=>x.state==='not_run').length,5);
});
test('same correct answers from different model identities invalidate the comparison',()=>{
  let n=0;
  const r=evaluateProposals(cases.slice(0,1),c=>stream(correct(c),n++?'model-b':'model-a'));
  assert.equal(r.passed,2);assert.equal(r.comparisonComplete,false);
  assert.equal(r.reason,'reported_model_drift');
});
test('wrong answer is recorded as a failure rather than silently dropping remaining pairs',()=>{
  const r=evaluateProposals(cases.slice(0,1),c=>stream({...correct(c),replacements:[]}));
  assert.equal(r.attempted,2);assert.equal(r.modelCompleted,2);
  assert.equal(r.passed,0);assert.equal(r.state,'completed');
  assert.ok(r.runs.every(x=>x.reason==='wrong_file_count'));
});
test('dry run is zero-call; live defaults to one pair and high quota needs confirmation',()=>{
  const d=runCli(['--dry-run']);
  assert.equal(d.modelRuns,0);assert.equal(d.distinctTasks,30);
  assert.equal(parseArgs(['--live','--model','m','--out','/tmp/unique']).limit,1);
  assert.throws(()=>parseArgs(['--live','--model','m','--out','/tmp/unique','--limit','30']),/confirm-batch/);
  assert.equal(parseArgs(['--live','--model','m','--out','/tmp/unique','--limit','30','--confirm-batch','YES']).limit,30);
  assert.throws(()=>parseArgs(['--live','--model','m','--out','/tmp/unique','--repeats','4']));
});
function fakeAgentMain(){
  const fs=require('node:fs');
  const args=process.argv.slice(2);
  if(args[0]==='--version'){console.log('fake-Cursor/1');process.exit(0);}
  if(args[0]==='status'){console.log('Logged in as TEST_STUB');process.exit(0);}
  if(!args.includes('--mode=ask')||!args.includes('--sandbox')||!args.includes('enabled')
    ||!args.includes('--trust')||args.includes('--force')||args.includes('--yolo')){
    console.error('Unsafe test flags');process.exit(4);
  }
  const prompt=args.at(-1),doc=JSON.parse(prompt.split('DOCUMENT:\n').at(-1));
  const source=doc.files[0].source;
  const data={needsClarification:false,replacements:[{path:'src/config.json',
    source:source.replace('"enabled": false','"enabled": true')}]};
  const system={type:'system',subtype:'init',model:'fake-Cursor/1',session_id:'test'};
  const end={type:'result',subtype:'success',is_error:false,duration_ms:11,
    session_id:'test',result:JSON.stringify(data)};
  const events=process.env.STUB_BAD_TOOL
    ?[system,{type:'tool_call',subtype:'started',call_id:'x'},end]
    :[system,end];
  process.stdout.write(events.map(JSON.stringify).join('\n')+'\n');
}
function withFakeAgent(fn){
  const dir=fs.mkdtempSync(path.join(os.tmpdir(),'brief-ask-e2e-'));
  try{
    const bin=path.join(dir,'bin');fs.mkdirSync(bin,{mode:0o700});
    const js=path.join(dir,'stub.cjs');fs.writeFileSync(js,'('+fakeAgentMain.toString()+')();\n',{mode:0o600});
    const agent=path.join(bin,'agent');
    fs.writeFileSync(agent,'#!/bin/sh\nexec "'+process.execPath+'" "'+js+'" "$@"\n',{mode:0o700});
    const run=(name,bad=false)=>{
      const out=path.join(dir,name);
      const r=spawnSync(process.execPath,['evaluation/patch-run.cjs','--live','--model','fake','--out',out],
        {cwd:path.resolve(__dirname,'..'),encoding:'utf8',timeout:30000,
          env:{...process.env,STUB_BAD_TOOL:bad?'1':'',PATH:bin+path.delimiter+process.env.PATH}});
      return {r,report:fs.existsSync(path.join(out,'report.json'))
        ?JSON.parse(fs.readFileSync(path.join(out,'report.json'),'utf8')):null,out};
    };
    return fn(run);
  }finally{fs.rmSync(dir,{recursive:true,force:true});}
}
test('full Ask-mode subprocess E2E handles two correct proposals with zero workspace edits',()=>{
  withFakeAgent(run=>{
    const {r,report,out}=run('success');
    assert.equal(r.status,0,r.stderr+'\n'+r.stdout.slice(0,800));
    assert.equal(report.passed,2);assert.equal(report.modelCompleted,2);
    assert.equal(report.gitIntegrity,'PASS');assert.equal(report.comparisonComplete,true);
    assert.equal(report.experiment,'read-only-code-proposals');
    for(const d of fs.readdirSync(out).filter(x=>x!=='receipts'&&x!=='report.json')){
      const work=path.join(out,d);
      assert.deepEqual(fs.readdirSync(work),['prompt.txt']);
      assert.equal(fs.statSync(work).mode&0o077,0);
    }
  });
});
test('full Ask-mode subprocess E2E blocks if Cursor uses any tool',()=>{
  withFakeAgent(run=>{
    const {r,report}=run('bad-tool',true);
    assert.equal(r.status,1,r.stderr);
    assert.equal(report.attempted,1);
    assert.equal(report.modelCompleted,0);
    assert.equal(report.state,'blocked');
    assert.equal(report.runs[1].state,'not_run');
  });
});
