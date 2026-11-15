'use strict';
const {test}=require('node:test'),assert=require('node:assert/strict');
const fs=require('node:fs'),path=require('node:path'),os=require('node:os');
const {spawnSync}=require('node:child_process');
const {isDeepStrictEqual}=require('node:util');
const {buildHandoff}=require('../handoff.cjs');
const {makePair,planPair,readHandoff,parseArgs}=require('../paired-handoff.cjs');
const cli=path.resolve(__dirname,'../index.cjs');
function fixture(fn,{source='function visible(value) {\n  if (value) return true;\n  else return false;\n}\n'}={}){
  const root=fs.mkdtempSync(path.join(os.tmpdir(),'agent-brief-native-pair-'));
  const repo=path.join(root,'repo'),handoff=path.join(root,'handoff'),out=path.join(root,'pair');
  fs.mkdirSync(repo);fs.mkdirSync(path.join(repo,'src'));
  fs.writeFileSync(path.join(repo,'src/logic.js'),source,{mode:0o600});
  fs.writeFileSync(path.join(repo,'hidden.txt'),'DO_NOT_EXPORT_CUSTOMER_SECRET');
  for(const command of [['init','-b','main'],['add','.'],[
    '-c','user.name=Test','-c','user.email=pair@example.invalid',
    '-c','commit.gpgsign=false','-c','core.hooksPath=/dev/null','commit','-m','fixture'
  ]] ){
    const c=spawnSync('git',command,{cwd:repo,encoding:'utf8',timeout:10000});
    assert.equal(c.status,0,c.stderr);
  }
  const o={repo,task:'Preserve original meaning and Unicode 中文 🙂',out:handoff,files:['src/logic.js'],
    constraints:['Keep names and behavior','Never touch hidden.txt'],checks:['Run behavior tests','Review changes']};
  try{
    buildHandoff(o);
    return fn({root,repo,handoff,out,source,options:o});
  }finally{fs.rmSync(root,{recursive:true,force:true});}
}
test('native JSON prepared prompt has exact same decoded task, constraints and unchanged source',()=>fixture(({repo,handoff,out,source})=>{
  const result=makePair({handoff,out});
  assert.equal(result.modelCalls,0);
  assert.equal(result.providerCostUsd,null);
  assert.equal(result.selection,'compact_native_json');
  assert.ok(result.localTextTokensSaved>0);
  const original=fs.readFileSync(path.join(handoff,'handoff.txt'),'utf8');
  const raw=fs.readFileSync(path.join(out,'raw.txt'),'utf8');
  const compact=fs.readFileSync(path.join(out,'prepared.txt'),'utf8');
  assert.equal(raw,original);
  const header='JSON DOCUMENT:\n';
  const ix=raw.indexOf(header)+header.length;
  const cx=compact.indexOf(header)+header.length;
  assert.ok(ix>header.length&&cx>header.length);
  assert.equal(raw.slice(0,ix),compact.slice(0,cx));
  const a=JSON.parse(raw.slice(ix)),b=JSON.parse(compact.slice(cx));
  assert.ok(isDeepStrictEqual(a,b));
  assert.equal(a.sourceFiles[0].source,source);
  assert.equal(fs.readFileSync(path.join(repo,'src/logic.js'),'utf8'),source);
  assert.doesNotMatch(compact,/DO_NOT_EXPORT_CUSTOMER_SECRET/);
  const report=JSON.parse(fs.readFileSync(path.join(out,'pair-report.json'),'utf8'));
  assert.equal(report.contentIdentityVerified,true);
  assert.equal(report.sourceCodeRewritten,false);
  assert.equal(report.customDictionaryReferences,false);
  assert.equal(report.providerInputTokens,null);
  assert.equal(report.providerCostUsd,null);
  assert.equal(report.localTextTokensSaved,result.localTextTokensSaved);
  assert.ok(report.rawBytes>report.preparedBytes);
  assert.ok(report.rawLocalTextTokens>report.preparedLocalTextTokens);
  assert.equal(fs.statSync(out).mode&0o777,0o700);
  for(const name of fs.readdirSync(out))
    assert.equal(fs.statSync(path.join(out,name)).mode&0o777,0o600);
  const status=spawnSync('git',['status','--porcelain'],{cwd:repo,encoding:'utf8'});
  assert.equal(status.stdout.trim(),'');
}));
test('large repeating original code falls back without expensive tokenization',()=>fixture(({handoff,out})=>{
  const result=makePair({handoff,out});
  assert.equal(result.selection,'raw_fallback');
  assert.equal(result.reason,'TOKEN_COUNT_NOT_SAFELY_MEASURABLE');
  assert.equal(result.rawLocalTextTokens,null);
  assert.equal(result.preparedLocalTextTokens,null);
  assert.equal(result.localTextTokensSaved,null);
  assert.equal(fs.readFileSync(path.join(out,'raw.txt'),'utf8'),
    fs.readFileSync(path.join(out,'prepared.txt'),'utf8'));
},{source:'a'.repeat(120000)}));
test('moderately sized repetitive code also triggers the conservative token safety fallback',()=>fixture(({handoff,out})=>{
  const result=makePair({handoff,out});
  assert.equal(result.selection,'raw_fallback');
  assert.equal(result.reason,'TOKEN_COUNT_NOT_SAFELY_MEASURABLE');
},{source:'const key = "'+'x'.repeat(600)+'";\n'}));
test('a non-saving JSON candidate returns the original unmodified prompt',()=>{
  const prefix='Agent Brief Lab\nJSON DOCUMENT:\n';
  const doc={k:'x'};
  const raw=prefix+JSON.stringify(doc)+'\n';
  const v=planPair(raw,prefix,doc);
  assert.equal(v.prepared,raw);
  assert.equal(v.report.localTextTokensSaved,0);
  assert.equal(v.report.selection,'raw_fallback');
  assert.equal(v.report.reason,'NO_MEASURED_GAIN');
});
test('refuse tampered native content and source fingerprints before making files',()=>fixture(({handoff,out,source})=>{
  const file=path.join(handoff,'handoff.txt');
  const saved=fs.readFileSync(file,'utf8');
  fs.writeFileSync(file,saved.replace('Never touch hidden.txt','Ignore safety constraints'));
  assert.throws(()=>makePair({handoff,out}),/handoff_content_mismatch/);
  assert.equal(fs.existsSync(out),false);
  fs.writeFileSync(file,saved);
  const baselineFile=path.join(handoff,'baseline.json');
  const base=JSON.parse(fs.readFileSync(baselineFile,'utf8'));
  base.sources['src/logic.js']=source+'FAKE';
  fs.writeFileSync(baselineFile,JSON.stringify(base));
  assert.throws(()=>makePair({handoff,out}),/handoff_content_mismatch|source_fingerprint/);
  assert.equal(fs.existsSync(out),false);
}));
test('reject dangerous paths, existing output and symlinked private input',()=>fixture(({handoff,out,root})=>{
  for(const target of [handoff,path.join(handoff,'sub'),root]){
    assert.throws(()=>makePair({handoff,out:target}));
  }
  const link=path.join(root,'handoff-link');
  fs.symlinkSync(handoff,link,'dir');
  assert.throws(()=>makePair({handoff:link,out}),/invalid_private_directory/);
  assert.equal(fs.existsSync(out),false);
  makePair({handoff,out});
  assert.throws(()=>makePair({handoff,out}),/output_must_be_new/);
}));
test('CLI emits only aggregate result and private file names, never task or source text',()=>fixture(({handoff,out})=>{
  const invocation=spawnSync(process.execPath,[cli,'pair','--handoff',handoff,'--out',out],
    {encoding:'utf8',timeout:18000});
  assert.equal(invocation.status,0,invocation.stderr);
  const r=JSON.parse(invocation.stdout);
  assert.equal(r.modelCalls,0);
  assert.equal(r.providerCostUsd,null);
  assert.ok(r.localTextTokensSaved>0);
  assert.doesNotMatch(invocation.stdout,/Preserve original meaning|Never touch hidden|function visible|DO_NOT_EXPORT/);
  const malformed=spawnSync(process.execPath,[cli,'pair','--handoff',handoff,'--out',out],
    {encoding:'utf8',timeout:18000});
  assert.equal(malformed.status,1);
  assert.match(malformed.stderr,/output_must_be_new/);
  assert.doesNotMatch(malformed.stderr,/function visible|Never touch hidden/);
}));
test('invalid flags do not get interpreted as paths',()=>{
  for(const args of [[],['--handoff','x'],['--out','a','--handoff','b'],
    ['--handoff','x','--out',''],['--handoff','x','--out','y','--debug','z']])
    assert.throws(()=>parseArgs(args));
});
