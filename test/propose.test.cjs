'use strict';
const {test}=require('node:test'),assert=require('node:assert/strict');
const fs=require('node:fs'),path=require('node:path'),os=require('node:os'),{spawnSync}=require('node:child_process');
const {propose}=require('../propose.cjs'),{intentDigest}=require('../index.cjs');
const intent={request:'精简 logic.js，保留函数名，不改 protected.txt。',goal:'简化布尔返回。',allowedFiles:['logic.js'],constraints:[{id:'keep_names',text:'保留函数名，不改 protected.txt。'}],acceptance:[{id:'behavior',text:'人工应用前运行行为验收。'}],questions:[]};
function fixture(fn) {
  const temporary=fs.mkdtempSync(path.join(os.tmpdir(),'proposal-')),root=path.join(temporary,'repo'),out=path.join(temporary,'output');fs.mkdirSync(root);
  const original='function visible(x) { if(x)return true;return false; }\n';fs.writeFileSync(path.join(root,'logic.js'),original);fs.writeFileSync(path.join(root,'protected.txt'),'original');
  for(const args of [['init','-b','main'],['add','.'],['commit','-m','fixture']]) {
    const r=spawnSync('git',['-c','core.hooksPath=/dev/null','-c','user.name=Fixture','-c','user.email=fixture@example.invalid','-c','commit.gpgsign=false',...args],{cwd:root,encoding:'utf8'});assert.equal(r.status,0,r.stderr);
  }
  const proposal={intentDigest:intentDigest(intent),files:['logic.js'],acknowledgedConstraints:['keep_names'],checks:['behavior'],replacements:[{path:'logic.js',source:'function visible(x) { return !!x; }\n'}]};
  const completion=p=>({status:0,stdout:[{type:'item.completed',item:{type:'agent_message',text:JSON.stringify(p)}},{type:'turn.completed',usage:{input_tokens:100,output_tokens:50}}].map(x=>JSON.stringify(x)).join('\n'),stderr:''});
  try{return fn({root,out,temporary,original,proposal,completion});}finally{fs.rmSync(temporary,{recursive:true,force:true});}
}
test('default proposal preview captures inputs without invoking a model or changing source',()=>fixture(({root,out,original})=>{
  const r=propose(intent,root,out,{},()=>{throw Error('must not invoke');});
  assert.equal(r.state,'prepared');assert.equal(r.invocationAttempts,0);assert.equal(r.modelCompleted,0);
  assert.equal(fs.readFileSync(path.join(root,'logic.js'),'utf8'),original);assert.ok(fs.existsSync(path.join(out,'prompt.txt')));
  assert.equal(fs.existsSync(path.join(out,'proposal.json')),false);
}));
test('simulated completion produces a validated proposal, never applies it',()=>fixture(({root,out,original,proposal,completion})=>{
  const r=propose(intent,root,out,{live:true,model:'simulated-test-model'},()=>completion(proposal));
  assert.equal(r.state,'proposal_ready');assert.equal(r.modelCompleted,1);assert.equal(r.validation.ok,true);
  assert.deepEqual(JSON.parse(fs.readFileSync(path.join(out,'proposal.json'))),proposal);
  assert.equal(fs.readFileSync(path.join(root,'logic.js'),'utf8'),original);
}));
test('stale binding, undeclared replacements, out-of-scope paths and no-op proposals reject',()=>{
  for(const change of [p=>{p.intentDigest='stale';},p=>{p.replacements[0].path='protected.txt';},p=>{p.files=['../outside.js'];p.replacements[0].path='../outside.js';},p=>{p.acknowledgedConstraints=[];},p=>{p.replacements.push(p.replacements[0]);}])fixture(({root,out,proposal,completion})=>{
    change(proposal);const r=propose(intent,root,out,{live:true,model:'simulated'},()=>completion(proposal));
    assert.equal(r.state,'rejected');assert.equal(fs.existsSync(path.join(out,'proposal.json')),false);
  });
  fixture(({root,out,original,proposal,completion})=>{proposal.replacements[0].source=original;assert.equal(propose(intent,root,out,{live:true,model:'simulated'},()=>completion(proposal)).state,'rejected');});
});
test('unresolved questions block model invocation',()=>fixture(({root,out})=>{
  const r=propose({...intent,questions:['确认目标？']},root,out,{live:true,model:'simulated'},()=>{throw Error('must not invoke');});
  assert.equal(r.state,'blocked');assert.equal(r.invocationAttempts,0);assert.equal(r.modelCompleted,0);
}));
test('startup failure, malformed responses and thrown invocation never produce a ready proposal',()=>{
  for(const invoke of [()=>({status:1,stdout:'',stderr:'blocked'}),()=>({status:0,stdout:'null',stderr:''}),()=>{throw Error('failed');}])fixture(({root,out})=>{
    const r=propose(intent,root,out,{live:true,model:'simulated'},invoke);assert.notEqual(r.state,'proposal_ready');assert.equal(r.modelCompleted,0);
    assert.equal(fs.existsSync(path.join(out,'proposal.json')),false);assert.ok(fs.existsSync(path.join(out,'report.json')));
  });
});
test('observed source mutations and deletions invalidate even a passing model response',()=>{
  for(const change of [root=>fs.writeFileSync(path.join(root,'protected.txt'),'changed'),root=>fs.rmSync(path.join(root,'logic.js'))])fixture(({root,out,proposal,completion})=>{
    const r=propose(intent,root,out,{live:true,model:'simulated'},()=>{change(root);return completion(proposal);});assert.equal(r.state,'rejected');assert.match(r.reason,/working tree changed/);
  });
});
test('output inside target repo and existing output directories refuse before invocation',()=>fixture(({root,out})=>{
  assert.throws(()=>propose(intent,root,path.join(root,'output')),/outside/);
  fs.mkdirSync(out);assert.throws(()=>propose(intent,root,out),/EEXIST/);
}));
test('proposal CLI preview needs only intent, Git repo and output path',()=>fixture(({root,out,temporary})=>{
  const file=path.join(temporary,'intent.json');fs.writeFileSync(file,JSON.stringify(intent));
  const r=spawnSync(process.execPath,[path.join(__dirname,'../index.cjs'),'propose',file,root,out],{encoding:'utf8'});
  assert.equal(r.status,0,r.stderr);assert.equal(JSON.parse(r.stdout).state,'prepared');
  const usage=spawnSync(process.execPath,[path.join(__dirname,'../index.cjs'),'propose'],{encoding:'utf8'});assert.equal(usage.status,2);
}));
test('undeclared top-level claims cannot enter a validated proposal',()=>{
  for(const key of ['testsPassed','testResults','command'])fixture(({root,out,proposal,completion})=>{
    proposal[key]=key==='testsPassed'?true:'untrusted extra claim';
    const r=propose(intent,root,out,{live:true,model:'simulated'},()=>completion(proposal));
    assert.equal(r.state,'rejected');assert.equal(fs.existsSync(path.join(out,'proposal.json')),false);
  });
});
test('replacement metadata cannot smuggle permissions or commands',()=>{
  for(const key of ['mode','execute','testsPassed'])fixture(({root,out,proposal,completion})=>{
    proposal.replacements[0][key]='untrusted';
    const r=propose(intent,root,out,{live:true,model:'simulated'},()=>completion(proposal));
    assert.equal(r.state,'rejected');assert.equal(fs.existsSync(path.join(out,'proposal.json')),false);
  });
});
test('replacement text must round trip through UTF-8; valid Unicode remains accepted',()=>{
  for(const source of ['\ud800','\udfff','\u0000'])fixture(({root,out,proposal,completion})=>{
    proposal.replacements[0].source=source;
    const r=propose(intent,root,out,{live:true,model:'simulated'},()=>completion(proposal));assert.equal(r.state,'rejected');
    assert.equal(fs.existsSync(path.join(out,'proposal.json')),false);
  });
  fixture(({root,out,proposal,completion})=>{
    proposal.replacements[0].source='// 合法 Unicode 😀\n'+proposal.replacements[0].source;
    assert.equal(propose(intent,root,out,{live:true,model:'simulated'},()=>completion(proposal)).state,'proposal_ready');
  });
});
