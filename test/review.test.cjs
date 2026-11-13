'use strict';
const {test}=require('node:test');
const assert=require('node:assert/strict');
const fs=require('node:fs'),path=require('node:path'),os=require('node:os'),{spawnSync}=require('node:child_process');
const {reviewChanges}=require('../review.cjs');
const {captureBaseline}=require('../execution.cjs');
const {intentDigest}=require('../index.cjs');
const intent={...require('../examples/intent.json'),acceptance:[
  {id:'nav_transparency',text:'静态确认 CSS opacity 为 .5。'},{id:'nav_spacing',text:'静态确认 CSS padding 为 8px。'}]};
const plan={...require('../examples/plan-good.json'),intentDigest:intentDigest(intent)};
function fixture(fn) {
  const root=fs.mkdtempSync(path.join(os.tmpdir(),'brief-review-'));
  const put=(f,s)=>{fs.mkdirSync(path.dirname(path.join(root,f)),{recursive:true});fs.writeFileSync(path.join(root,f),s);};
  const git=(...args)=>{const r=spawnSync('git',['-c','core.hooksPath=/dev/null','-c','core.fsmonitor=false','-c','user.name=Fixture','-c','user.email=fixture@example.invalid','-c','commit.gpgsign=false',...args],{cwd:root,encoding:'utf8'});assert.equal(r.status,0,r.stderr);};
  put('src/navigation.css','.nav { opacity: .8; padding: 12px; }');put('src/temple.js','original');
  git('init','-b','main');git('add','.');git('commit','-m','baseline');
  const baseline=captureBaseline(intent,root);
  put('src/navigation.css','.nav { opacity: .5; padding: 8px; }');
  const commands=intent.acceptance.map(a=>({id:a.id,argv:[process.execPath,'-e',`const fs=require('node:fs');if(!fs.readFileSync('src/navigation.css','utf8').includes('${a.id==='nav_spacing'?'8px':'.5'}'))process.exit(1);`]}));
  const manifest={intentDigest:intentDigest(intent),commands};
  try{return fn({root,baseline,put,manifest,run:m=>reviewChanges(intent,plan,baseline,root,m??manifest)});}
  finally{fs.rmSync(root,{recursive:true,force:true});}
}
test('actual acceptance commands read the edited file and pass',()=>fixture(({run})=>{
  const r=run();assert.equal(r.ok,true,JSON.stringify(r));assert.equal(r.checks.length,2);assert.ok(r.checks.every(c=>c.ok));
}));
test('wrong CSS fails a real check and later commands do not run',()=>fixture(({run,put})=>{
  put('src/navigation.css','.nav { opacity: .7; padding: 8px; }');const r=run();
  assert.equal(r.ok,false);assert.equal(r.checks[0].exitCode,1);assert.equal(r.checks[1].state,'not_run');
}));
test('scope violation blocks even otherwise passing commands',()=>fixture(({run,put})=>{
  put('src/temple.js','changed');const r=run();assert.equal(r.ok,false);assert.deepEqual(r.checks,[]);
}));
test('stale, incomplete, duplicate and non-absolute command manifests reject',()=>fixture(({run,manifest})=>{
  for(const m of [{...manifest,intentDigest:'stale'},{...manifest,commands:[]},{...manifest,commands:[manifest.commands[0],manifest.commands[0]]},
    {...manifest,commands:manifest.commands.map(c=>({...c,argv:['node','-e','']}))}]) assert.throws(()=>run(m),/manifest/);
}));
test('a passing command cannot leave protected or allowed source mutations behind',()=>{
  for(const file of ['src/temple.js','src/navigation.css'])fixture(({run,manifest})=>{
    manifest.commands[0].argv=[process.execPath,'-e',`require('node:fs').writeFileSync('${file}','modified by test')`];
    const r=run();assert.equal(r.ok,false);assert.equal(r.scopeAfter.ok,false);
    assert.ok(r.scopeAfter.failures.some(f=>f.includes('during acceptance')));
  });
});
test('timeout, missing executable, signal and output overflow cannot pass',()=>{
  for(const argv of [[process.execPath,'-e','while(true){}'],['/nonexistent/brief-check'],
    [process.execPath,'-e','process.kill(process.pid,"SIGTERM")'],[process.execPath,'-e','process.stdout.write("x".repeat(200000))']])fixture(({run,manifest})=>{
      manifest.commands[0]={...manifest.commands[0],argv,timeoutMs:150};
      const r=run();assert.equal(r.ok,false);assert.equal(r.checks[0].ok,false);
  });
});
test('review CLI returns failure for actual failing commands',()=>fixture(({root,baseline,manifest})=>{
  const dir=fs.mkdtempSync(path.join(os.tmpdir(),'review-inputs-'));
  try{
    manifest.commands[0].argv=[process.execPath,'-e','process.exit(3)'];
    for(const [name,value] of Object.entries({intent,plan,baseline,manifest}))fs.writeFileSync(path.join(dir,name+'.json'),JSON.stringify(value));
    const r=spawnSync(process.execPath,[path.join(__dirname,'../index.cjs'),'review',...['intent','plan','baseline'].map(n=>path.join(dir,n+'.json')),root,path.join(dir,'manifest.json')],{encoding:'utf8'});
    assert.equal(r.status,1,r.stderr);assert.equal(JSON.parse(r.stdout).checks[0].exitCode,3);
  }finally{fs.rmSync(dir,{recursive:true,force:true});}
}));
test('one command cannot change source and let a later command hide the mutation',()=>{
  for(const file of ['src/navigation.css','src/temple.js'])fixture(({root,run,manifest})=>{
    const original=fs.readFileSync(path.join(root,file),'utf8');
    manifest.commands[0].argv=[process.execPath,'-e',`require('node:fs').writeFileSync(${JSON.stringify(file)},'changed between commands')`];
    manifest.commands[1].argv=[process.execPath,'-e',`require('node:fs').writeFileSync(${JSON.stringify(file)},${JSON.stringify(original)})`];
    const r=run();assert.equal(r.ok,false);
    assert.equal(r.checks[0].exitCode,0);assert.equal(r.checks[0].ok,false);
    assert.equal(r.checks[1].state,'not_run');
    assert.equal(fs.readFileSync(path.join(root,file),'utf8'),'changed between commands');
  });
});
