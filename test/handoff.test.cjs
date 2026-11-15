'use strict';
const {test}=require('node:test'),assert=require('node:assert/strict');
const fs=require('node:fs'),os=require('node:os'),path=require('node:path');
const {spawnSync}=require('node:child_process');
const {parseArgs,buildHandoff,makeIntent,runCli}=require('../handoff.cjs');
const {checkPlan}=require('../index.cjs');
const cli=path.join(__dirname,'../index.cjs');
function fixture(fn){
  const parent=fs.mkdtempSync(path.join(os.tmpdir(),'agent-brief-handoff-'));
  const repo=path.join(parent,'repo'),dir=path.join(parent,'out');
  fs.mkdirSync(repo);fs.mkdirSync(path.join(repo,'src'));
  const source='const PRIVATE_CLIENT_SOURCE = "keep";\nfunction x(v){if(v)return true;else return false;}\n';
  fs.writeFileSync(path.join(repo,'src','logic.js'),source);
  fs.writeFileSync(path.join(repo,'private.txt'),'PROTECTED_CONTENT');
  for(const cmd of [
    ['init','-b','main'],['add','.'],['-c','user.name=Test','-c','user.email=test@example.invalid',
      '-c','commit.gpgsign=false','-c','core.hooksPath=/dev/null','commit','-m','fixture']
  ]){
    const r=spawnSync('git',cmd,{cwd:repo,encoding:'utf8',timeout:10000});
    assert.equal(r.status,0,r.stderr);
  }
  const options={repo,task:'Refactor logic without changing the API 🦉',out:dir,
    files:['src/logic.js'],constraints:['Keep the exported behavior'],
    checks:['Run the project behavior tests']};
  try{return fn({repo,dir,parent,source,options});}
  finally{fs.rmSync(parent,{recursive:true,force:true})}
}
test('native task handoff creates a private, native-readable and unchanged-source bundle',()=>fixture(({repo,dir,source,options})=>{
  const result=buildHandoff(options);
  assert.equal(result.state,'ready_for_human_review');
  assert.equal(result.modelCalls,0);
  assert.equal(result.sourceWrites,0);
  assert.equal(result.selectedFiles,1);
  const doc=fs.readFileSync(path.join(dir,'handoff.txt'),'utf8');
  assert.ok(doc.startsWith('Agent Brief Lab'));
  assert.match(doc,/JSON DOCUMENT:/);
  const parsed=JSON.parse(doc.split('JSON DOCUMENT:\n')[1]);
  assert.equal(parsed.request,options.task);
  assert.deepEqual(parsed.allowedFiles,['src/logic.js']);
  assert.equal(parsed.sourceFiles[0].source,source,'source is never semantically rewritten');
  assert.deepEqual(parsed.constraints.map(x=>x.id),['declared_scope','user_constraint_1']);
  assert.deepEqual(parsed.acceptanceToRun.map(x=>x.id),['honest_checks','user_check_1']);
  assert.equal(fs.readFileSync(path.join(repo,'src/logic.js'),'utf8'),source);
  assert.equal(fs.readFileSync(path.join(repo,'private.txt'),'utf8'),'PROTECTED_CONTENT');
  const s=spawnSync('git',['status','--porcelain'],{cwd:repo,encoding:'utf8'});
  assert.equal(s.stdout.trim(),'');
  assert.equal(fs.statSync(dir).mode&0o777,0o700);
  for(const name of fs.readdirSync(dir))
    assert.equal(fs.statSync(path.join(dir,name)).mode&0o777,0o600);
  const report=JSON.parse(fs.readFileSync(path.join(dir,'report.json')));
  assert.equal(report.modelCalls,0);
  assert.equal(report.localTokensSaved,null);
  assert.equal(report.billedSavingsUsd,null);
  assert.equal(report.handoffLocalTextTokens,null);
  assert.ok(report.handoffBytes>report.sourceBytes);
}));
test('checks and constraints are declarations, never marked as performed',()=>fixture(({options,dir})=>{
  buildHandoff(options);
  const intent=JSON.parse(fs.readFileSync(path.join(dir,'intent.json')));
  const plan=JSON.parse(fs.readFileSync(path.join(dir,'plan-template.json')));
  assert.equal(plan.acknowledgedConstraints.length,0);
  assert.equal(plan.checks.length,0);
  const v=checkPlan(intent,plan);
  assert.equal(v.ok,false);
  assert.ok(v.failures.some(x=>x.includes('Unacknowledged constraint')));
  assert.ok(v.failures.some(x=>x.includes('Missing acceptance')));
}));
test('CLI creates review bundle without printing private task/source to stdout',()=>fixture(({repo,dir,source,options})=>{
  const a=['handoff','--repo',repo,'--task',options.task,'--file','src/logic.js',
    '--out',dir,'--constraint',options.constraints[0],'--check',options.checks[0]];
  const r=spawnSync(process.execPath,[cli,...a],{encoding:'utf8',timeout:10000});
  assert.equal(r.status,0,r.stderr);
  const result=JSON.parse(r.stdout);
  assert.equal(result.modelCalls,0);
  assert.equal(result.handoffFile,path.join(dir,'handoff.txt'));
  assert.ok(!r.stdout.includes('PRIVATE_CLIENT_SOURCE'));
  assert.ok(!r.stdout.includes(options.task));
  assert.equal(fs.readFileSync(path.join(repo,'src/logic.js'),'utf8'),source);
}));
test('unrequested project files are never included in copy-ready handoff',()=>fixture(({options,dir})=>{
  buildHandoff(options);
  const contents=fs.readFileSync(path.join(dir,'handoff.txt'),'utf8');
  assert.doesNotMatch(contents,/PROTECTED_CONTENT/);
  const b=JSON.parse(fs.readFileSync(path.join(dir,'baseline.json')));
  assert.equal(Object.keys(b.sources).length,1);
  assert.equal(b.files.some(x=>x.path==='private.txt'),true);
}));
test('duplicate flags, unsupported options and invalid scopes fail without a new directory',()=>fixture(({options,dir})=>{
  for(const mutate of [
    x=>{x.files=['src/logic.js','src/logic.js'];},
    x=>{x.files=['../private.txt'];},
    x=>{x.files=[];},
    x=>{x.files=['src/notthere.js'];},
    x=>{x.out=options.repo+'/bundle';},
    x=>{x.out=options.repo;},
  ]){
    const x=structuredClone(options);mutate(x);
    assert.throws(()=>buildHandoff(x));
    assert.equal(fs.existsSync(dir),false);
  }
  assert.throws(()=>parseArgs(['--repo','foo','--repo','bar']),/invalid_arguments|duplicate/);
  assert.throws(()=>parseArgs(['--repo','foo','--task','x','--file','x','--out','y','--unknown','val']),/unsupported/);
}));
test('untrusted symlinks and oversized selected source are not packed',()=>fixture(({options,repo,dir})=>{
  fs.symlinkSync('logic.js',path.join(repo,'src','link.js'));
  const symlink={...options,files:['src/link.js']};
  assert.throws(()=>buildHandoff(symlink));
  assert.equal(fs.existsSync(dir),false);
  fs.writeFileSync(path.join(repo,'src','logic.js'),'a'.repeat(131073));
  assert.throws(()=>buildHandoff(options),/selected_source_too_large/);
  assert.equal(fs.existsSync(dir),false);
}));
test('large repetitive but bounded input cannot trigger expensive tokenizer work',()=>fixture(({repo,options,dir})=>{
  const long='a'.repeat(120000);
  fs.writeFileSync(path.join(repo,'src','logic.js'),long);
  const out=buildHandoff(options);
  assert.equal(out.handoffLocalTextTokens,null);
  assert.equal(out.modelCalls,0);
  assert.equal(fs.readFileSync(path.join(repo,'src','logic.js'),'utf8'),long);
  assert.ok(out.handoffBytes>=long.length);
  assert.equal(fs.statSync(dir).mode&0o777,0o700);
}));
test('existing output, path outside temporary directory, and no output overwrite',()=>fixture(({options,parent})=>{
  // /var/tmp can alias /tmp; give the child its own unambiguous temp boundary.
  const temp=path.join(parent,'isolated-temp');fs.mkdirSync(temp);
  const outside=path.join(parent,'outside');
  const denied=spawnSync(process.execPath,['-e',
    'try{require(process.argv[1]).buildHandoff(JSON.parse(process.argv[2]));}catch(e){console.error(e.message);process.exitCode=1;}',
    require.resolve('../handoff.cjs'),JSON.stringify({...options,out:outside})],
    {encoding:'utf8',timeout:10000,env:{...process.env,TMPDIR:temp,TMP:temp,TEMP:temp}});
  assert.equal(denied.status,1);assert.match(denied.stderr,/output_must_be_under_system_temp/);
  assert.equal(fs.existsSync(outside),false);
  const result=buildHandoff(options);
  assert.equal(fs.existsSync(result.handoffFile),true);
  assert.throws(()=>buildHandoff(options),/output_must_be_new/);
  assert.equal(fs.readFileSync(result.handoffFile,'utf8').includes(options.task),true);
}));
test('end-to-end handoff then actual Git edit verifies authorized scope and rejects protected edits',()=>fixture(({options,repo,dir,source})=>{
  buildHandoff(options);
  const intent=JSON.parse(fs.readFileSync(path.join(dir,'intent.json')));
  const base=JSON.parse(fs.readFileSync(path.join(dir,'baseline.json')));
  const plan=JSON.parse(fs.readFileSync(path.join(dir,'plan-template.json')));
  plan.acknowledgedConstraints=intent.constraints.map(c=>c.id);
  plan.checks=intent.acceptance.map(c=>c.id);
  const planFile=path.join(dir,'plan.json');
  fs.writeFileSync(planFile,JSON.stringify(plan));
  const revised=source.replace('if(v)return true;else return false;','return !!v;');
  assert.notEqual(revised,source);
  fs.writeFileSync(path.join(repo,'src/logic.js'),revised);
  const successful=spawnSync(process.execPath,[cli,'verify',
    path.join(dir,'intent.json'),planFile,path.join(dir,'baseline.json'),repo],
    {encoding:'utf8',timeout:15000});
  assert.equal(successful.status,0,successful.stderr);
  const verdict=JSON.parse(successful.stdout);
  assert.equal(verdict.ok,true);
  assert.deepEqual(verdict.changed,[{path:'src/logic.js',kind:'modified'}]);
  assert.match(verdict.acceptance,/Not run/,'declared checks are NOT observed test execution');
  fs.writeFileSync(path.join(repo,'private.txt'),'MALICIOUS_OUT_OF_SCOPE_EDIT');
  const failed=spawnSync(process.execPath,[cli,'verify',
    path.join(dir,'intent.json'),planFile,path.join(dir,'baseline.json'),repo],
    {encoding:'utf8',timeout:15000});
  assert.equal(failed.status,1);
  const violation=JSON.parse(failed.stdout);
  assert.equal(violation.ok,false);
  assert.ok(violation.failures.some(s=>s.includes('private.txt')));
}));
test('safe CLI errors never print confidential request text or path',()=>fixture(({options})=>{
  const out=[],errs=[];
  const r=runCli(['--repo',options.repo,'--task','PRIVATE_CUSTOMER_TASK','--file','src/missing.js',
    '--out',options.out],{out:x=>out.push(x),err:x=>errs.push(x)});
  assert.equal(r,1);
  assert.equal(out.length,0);
  assert.ok(errs[0].startsWith('Handoff refused:'));
  assert.doesNotMatch(errs[0],/PRIVATE_CUSTOMER_TASK|missing.js|\/tmp/);
}));
