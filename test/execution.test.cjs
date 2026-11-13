'use strict';
const {test}=require('node:test');
const assert=require('node:assert/strict');
const fs=require('node:fs');
const path=require('node:path');
const os=require('node:os');
const {spawnSync}=require('node:child_process');
const {simplify,intentDigest}=require('../index.cjs');
const {captureBaseline,checkChanges,measureContext}=require('../execution.cjs');
const intent=require('../examples/intent.json');
const plan=require('../examples/plan-good.json');

function repository(fn) {
  const temporary=fs.mkdtempSync(path.join(os.tmpdir(),'agent-workspace-'));
  const root=path.join(temporary,'repo');fs.mkdirSync(root);
  const put=(file,content)=>{const target=path.join(root,file);fs.mkdirSync(path.dirname(target),{recursive:true});fs.writeFileSync(target,content);};
  const git=(...args)=>{
    const result=spawnSync('git',['-c','core.hooksPath=/dev/null','-c','core.fsmonitor=false','-c','user.name=Fixture','-c','user.email=fixture@example.invalid','-c','commit.gpgsign=false',...args],{cwd:root,encoding:'utf8'});
    assert.equal(result.status,0,result.stderr);return result.stdout;
  };
  put('src/navigation.css','.navigation { opacity: 0.8; padding: 12px; }\n');
  put('src/temple.js','export const scene = "original";\n');
  put('src/icons.js','export const icons = ["home", "chat"];\n');
  put('.gitignore','node_modules/\n');
  git('init','-b','main');git('add','.');git('commit','-m','Fixture baseline');
  try {return fn({root,temporary,put,git,base:captureBaseline(intent,root)});}
  finally {fs.rmSync(temporary,{recursive:true,force:true});}
}

test('observes the actual allowed edit and leaves the index unchanged',()=>repository(({root,put,git,base})=>{
  const before=git('ls-files','--stage');
  put('src/navigation.css','.navigation { opacity: 0.5; padding: 8px; }\n');
  const result=checkChanges(intent,plan,base,root);
  assert.equal(result.ok,true,JSON.stringify(result));
  assert.deepEqual(result.changed,[{path:'src/navigation.css',kind:'modified'}]);
  assert.equal(git('ls-files','--stage'),before);
  assert.ok(result.acceptance.startsWith('Not run'));
}));

test('a good declared plan cannot hide an actual temple edit',()=>repository(({root,put,base})=>{
  put('src/temple.js','export const scene = "replaced";\n');
  const result=checkChanges(intent,plan,base,root);
  assert.equal(result.ok,false);
  assert.ok(result.failures.some(x=>x.includes('Actual change outside allowed scope: src/temple.js')));
  assert.ok(result.failures.some(x=>x.includes('absent from plan')));
}));

test('an allowed edit cannot hide a second protected-file edit',()=>repository(({root,put,base})=>{
  put('src/navigation.css','.navigation { opacity: 0.5; }\n');
  put('src/icons.js','export const icons = [];\n');
  const result=checkChanges(intent,plan,base,root);
  assert.equal(result.ok,false);assert.equal(result.changed.length,2);
}));

test('untracked additions and allowed-file deletion are rejected',()=>repository(({root,put,base})=>{
  put('src/new file.js','export {};');
  assert.equal(checkChanges(intent,plan,base,root).ok,false);
  fs.rmSync(path.join(root,'src/new file.js'));fs.rmSync(path.join(root,'src/navigation.css'));
  const result=checkChanges(intent,plan,base,root);
  assert.equal(result.ok,false);assert.equal(result.changed[0].kind,'deleted');assert.equal(result.context,null);
}));

test('renaming a source is observed as a deletion and addition',()=>repository(({root,base})=>{
  fs.renameSync(path.join(root,'src/navigation.css'),path.join(root,'src/renamed.css'));
  const result=checkChanges(intent,plan,base,root);
  assert.equal(result.ok,false);assert.equal(result.changed.length,2);
}));

test('mode changes and symlink substitution cannot pass',()=>repository(({root,temporary,base})=>{
  const file=path.join(root,'src/navigation.css');fs.chmodSync(file,0o755);
  assert.equal(checkChanges(intent,plan,base,root).changed[0].kind,'mode_changed');
  fs.rmSync(file);const outside=path.join(temporary,'outside.css');fs.writeFileSync(outside,'private canary');fs.symlinkSync(outside,file);
  const result=checkChanges(intent,plan,base,root);
  assert.equal(result.ok,false);assert.equal(result.changed[0].kind,'type_changed');
  assert.ok(!JSON.stringify(result).includes('private canary'));
}));

test('a noop does not claim completed editing',()=>repository(({root,base})=>{
  const result=checkChanges(intent,plan,base,root);
  assert.equal(result.ok,false);assert.ok(result.failures.includes('No actual changes were observed'));
}));

test('staging and committing require separate review and cannot hide edits',()=>repository(({root,put,git,base})=>{
  put('src/temple.js','export const scene="changed";');git('add','.');
  let result=checkChanges(intent,plan,base,root);assert.equal(result.ok,false);
  assert.ok(result.failures.some(x=>x.includes('Git index changed')));
  git('commit','-m','Agent changed the wrong source');
  result=checkChanges(intent,plan,base,root);assert.equal(result.ok,false);
  assert.ok(result.failures.some(x=>x.includes('Git HEAD changed')));
  assert.ok(result.changed.some(x=>x.path==='src/temple.js'));
}));

test('stale and corrupted baselines are rejected',()=>repository(({root,put,base})=>{
  put('src/navigation.css','.navigation { opacity: 0.5; }');
  const changed={...intent,request:intent.request+' 另外改变配色。'};
  const updatedPlan={...plan,intentDigest:intentDigest(changed)};
  assert.equal(checkChanges(changed,updatedPlan,base,root).ok,false);
  assert.throws(()=>checkChanges(intent,plan,{...base,sources:{'src/navigation.css':'fabricated'}},root),/fingerprint/);
  assert.throws(()=>checkChanges(intent,plan,{...base,files:[]},root),/baseline/);
}));

test('baseline requires the exact root and regular source files',()=>repository(({root,put})=>{
  assert.throws(()=>captureBaseline(intent,path.join(root,'src')),/exact Git/);
  put('extra.txt','untracked baseline content');
  assert.ok(captureBaseline(intent,root).files.some(x=>x.path==='extra.txt'));
  fs.symlinkSync('src/icons.js',path.join(root,'source-link'));
  assert.equal(captureBaseline(intent,root).files.find(x=>x.path==='source-link').state,'symlink');
}));

test('Git filters and filesystem monitor commands are not executed',()=>repository(({root,put,git})=>{
  put('.gitattributes','src/navigation.css filter=canary\n');git('add','.');git('commit','-m','Attribute fixture');
  git('config','filter.canary.clean','touch filter-executed');git('config','core.fsmonitor','touch monitor-executed');
  const base=captureBaseline(intent,root);
  put('src/navigation.css','.navigation { opacity: 0.4; }');
  assert.equal(checkChanges(intent,plan,base,root).ok,true);
  assert.equal(fs.existsSync(path.join(root,'filter-executed')),false);
  assert.equal(fs.existsSync(path.join(root,'monitor-executed')),false);
}));

test('inherited Git redirection does not inspect another repository',()=>repository(({root})=>{
  const previous=process.env.GIT_DIR;
  try {
    process.env.GIT_DIR='/nonexistent-agent-fixture';
    assert.ok(captureBaseline(intent,root).files.some(x=>x.path==='src/navigation.css'));
  } finally {if(previous===undefined)delete process.env.GIT_DIR;else process.env.GIT_DIR=previous;}
}));

test('ignored files are explicitly outside observed source scope',()=>repository(({root,put,base})=>{
  put('src/navigation.css','.navigation { opacity: 0.5; }');
  put('node_modules/cache.txt','ignored fixture');
  const result=checkChanges(intent,plan,base,root);
  assert.equal(result.ok,true);assert.ok(!result.changed.some(x=>x.path.startsWith('node_modules/')));
}));

test('context accounting includes guidance overhead and exact file envelopes',()=>{
  const source='function visible(value) { if (value) { return true; } else { return false; } }';
  const request={request:'精简 visible 的布尔返回，保持行为。',goal:'精简 visible。',allowedFiles:['src/logic.js'],
    constraints:[{id:'preserve_result',text:'保留返回值和求值次数。'}],acceptance:[{id:'test_behavior',text:'执行行为测试。'}],questions:[]};
  const before={'src/logic.js':source},after={'src/logic.js':simplify(source).code};
  const result=measureContext(request,before,after);
  assert.ok(result.savedWithSameGuidance>0);
  assert.ok(result.addedVersusRawRequest>0);
  assert.equal(result.inputSavingsVersusRawRequest,-result.addedVersusRawRequest);
  assert.equal(measureContext(request,before,before).savedWithSameGuidance,0);
  assert.throws(()=>measureContext(request,{},after),/exactly/);
  assert.throws(()=>measureContext(request,before,{...after,'other.js':'extra'}),/exactly/);
});

test('CLI baseline and actual-change verification work without executing source',()=>repository(({root,temporary,put})=>{
  const cli=path.resolve(__dirname,'../index.cjs');
  const intentPath=path.join(temporary,'intent.json'),planPath=path.join(temporary,'plan.json'),basePath=path.join(temporary,'baseline.json');
  fs.writeFileSync(intentPath,JSON.stringify(intent));fs.writeFileSync(planPath,JSON.stringify(plan));
  const run=args=>spawnSync(process.execPath,[cli,...args],{encoding:'utf8',timeout:30000});
  const capture=run(['baseline',intentPath,root]);assert.equal(capture.status,0,capture.stderr);fs.writeFileSync(basePath,capture.stdout);
  put('src/navigation.css','.navigation { opacity: 0.5; }');
  assert.equal(run(['verify',intentPath,planPath,basePath,root]).status,0);
  put('src/temple.js','throw new Error("Do not execute this source");');
  const verify=run(['verify',intentPath,planPath,basePath,root]);assert.equal(verify.status,1);
  assert.ok(JSON.parse(verify.stdout).changed.some(x=>x.path==='src/temple.js'));
}));
test('unchanged tracked, untracked and dangling symlinks are observed without following them',()=>repository(({root,temporary,put,git})=>{
  const external=path.join(temporary,'outside.txt');fs.writeFileSync(external,'private target contents');
  fs.symlinkSync(external,path.join(root,'external-link'));fs.symlinkSync('missing-target',path.join(root,'dangling-link'));
  git('add','external-link','dangling-link');git('commit','-m','Link fixture');
  fs.symlinkSync('src/icons.js',path.join(root,'untracked-link'));
  const base=captureBaseline(intent,root);assert.equal(base.version,2);
  assert.equal(base.files.filter(x=>x.state==='symlink').length,3);
  assert.equal(JSON.stringify(base).includes('private target contents'),false);
  put('src/navigation.css','.navigation { opacity: 0.5; padding: 8px; }\n');
  const result=checkChanges(intent,plan,base,root);assert.equal(result.ok,true,JSON.stringify(result));
  assert.deepEqual(result.changed,[{path:'src/navigation.css',kind:'modified'}]);
}));
test('retargeting, deleting and replacing an existing symlink cannot pass',()=>{
  for(const kind of ['retarget','delete','replace'])repository(({root,put})=>{
    const link=path.join(root,'kept-link');fs.symlinkSync('src/icons.js',link);
    const base=captureBaseline(intent,root);put('src/navigation.css','.navigation { opacity: .5; }');
    fs.rmSync(link);if(kind==='retarget')fs.symlinkSync('src/navigation.css',link);if(kind==='replace')fs.writeFileSync(link,'regular file');
    const r=checkChanges(intent,plan,base,root);assert.equal(r.ok,false);
    assert.ok(r.changed.some(x=>x.path==='kept-link'));assert.ok(r.failures.some(x=>x.includes('kept-link')));
  });
});
test('allowed edit sources must still be regular files and v1 cannot contain symlink records',()=>repository(({root,put})=>{
  fs.symlinkSync('src/icons.js',path.join(root,'source-link'));
  assert.throws(()=>captureBaseline({...intent,allowedFiles:['source-link']},root),/regular/);
  const base=captureBaseline(intent,root);put('src/navigation.css','.nav{opacity:.5}');
  assert.throws(()=>checkChanges(intent,plan,{...base,version:1},root),/baseline/);
}));
test('symlink target contents are outside observation and never included as source',()=>repository(({root,temporary,put})=>{
  const target=path.join(temporary,'private.txt');fs.writeFileSync(target,'canary-one');fs.symlinkSync(target,path.join(root,'outside-link'));
  const base=captureBaseline(intent,root);fs.writeFileSync(target,'canary-two');
  put('src/navigation.css','.nav{opacity:.5}');const r=checkChanges(intent,plan,base,root);
  assert.equal(r.ok,true);assert.equal(JSON.stringify(base).includes('canary-one'),false);assert.equal(JSON.stringify(r).includes('canary-two'),false);
}));
