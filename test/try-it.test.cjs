'use strict';
const {test}=require('node:test'),assert=require('node:assert/strict');
const fs=require('node:fs'),os=require('node:os'),path=require('node:path');
const {spawnSync}=require('node:child_process');
const {isDeepStrictEqual}=require('node:util');
const {parseArgs,readFile,historyResult,sourceResult,demo,run}=require('../evaluation/try-it.cjs');
const cli=path.resolve(__dirname,'../evaluation/try-it.cjs');
const root=path.resolve(__dirname,'..');
function temp(fn){
  const dir=fs.mkdtempSync(path.join(os.tmpdir(),'agent-brief-first-run-'));
  try{return fn(dir)}finally{fs.rmSync(dir,{recursive:true,force:true})}
}
function call(args,cwd=root){
  return spawnSync(process.execPath,[cli,...args],{cwd,encoding:'utf8',timeout:25000,maxBuffer:128*1024});
}
test('default command runs offline, shows a real reversible compression and a no-gain control',()=>{
  const d=demo();
  assert.equal(d.kind,'synthetic_demo');
  assert.equal(d.modelCalls,0);assert.equal(d.fileWrites,0);
  assert.ok(d.repeated.tokensSaved>0);
  assert.equal(d.repeated.exactRestore,true);
  assert.equal(d.noRepeat.tokensSaved,0);
  assert.ok(d.completeGuidedInput.tokensSaved>0);
  assert.equal(d.providerUsage,null);assert.equal(d.billedSavingsUsd,null);
  const p=call([]);assert.equal(p.status,0,p.stderr);
  assert.match(p.stdout,/first run, zero model calls/);
  assert.match(p.stdout,/exact restore verified/);
  assert.match(p.stdout,/No billed USD savings established/);
  assert.doesNotMatch(p.stdout,/source code content|SECRET/);
});
test('one-command JSON contains aggregates only, independent of current shell directory',()=>{
  const r=call(['--json'],os.tmpdir());
  assert.equal(r.status,0,r.stderr);
  const doc=JSON.parse(r.stdout);
  assert.equal(doc.modelCalls,0);assert.equal(doc.fileWrites,0);
  assert.equal(doc.repeated.exactRestore,true);
  assert.equal(doc.completeGuidedInput.restoredExactly,true);
  assert.ok(!Object.hasOwn(doc,'input'));
  assert.ok(!Object.hasOwn(doc,'content'));
});
test('explicit local history is reconstructed, but neither metadata nor private message text is displayed',()=>{
  temp(dir=>{
    const text='PRIVATE_ACME_SECRET_DO_NOT_PRINT '+('repeated project code '.repeat(80));
    const messages=[{role:'user',content:'USER_SECRET_DO_NOT_PRINT'},
      {role:'tool',content:text,tool_call_id:'PRIVATE_CUSTOMER_ID'},
      {role:'tool',content:text,tool_call_id:'PRIVATE_CUSTOMER_ID_2'}];
    const name=path.join(dir,'confidential.json'),raw=JSON.stringify(messages);
    fs.writeFileSync(name,raw,{mode:0o600});
    const before=fs.readFileSync(name);
    const r=call(['--history',name,'--json']);
    assert.equal(r.status,0,r.stderr);
    const report=JSON.parse(r.stdout);
    assert.equal(report.kind,'local_history');
    assert.equal(report.exactRestore,true);
    assert.ok(report.tokensSaved>0);
    assert.equal(report.historyMessages,3);
    assert.equal(report.billedSavingsUsd,null);
    assert.ok(!r.stdout.includes('PRIVATE_'));
    assert.ok(!r.stdout.includes(name));
    assert.deepEqual(fs.readFileSync(name),before);
  });
});
test('explicit JS source prints measurement but never source bytes, local paths or writes',()=>{
  temp(dir=>{
    const name=path.join(dir,'secret-file.js');
    const source='const PRIVATE_COMPANY_NAME = true;\nfunction f(x){if(x){return true;}else{return false;}}\n';
    fs.writeFileSync(name,source);
    const before=fs.readFileSync(name);
    const r=call(['--source',name,'--json']);
    assert.equal(r.status,0,r.stderr);
    const data=JSON.parse(r.stdout);
    assert.equal(data.kind,'local_source');
    assert.ok(data.tokensSaved>=0);
    assert.equal(data.modelCalls,0);assert.equal(data.fileWrites,0);
    assert.equal(data.billedSavingsUsd,null);
    assert.doesNotMatch(r.stdout,/PRIVATE_COMPANY_NAME|secret-file|\/tmp\//);
    assert.deepEqual(fs.readFileSync(name),before);
  });
});
test('small or no-gain histories remain unchanged rather than create overhead',()=>{
  for(const m of [
    [{role:'user',content:'keep explicit constraints'}],
    [{role:'tool',content:'ok'},{role:'tool',content:'ok'}],
    [],
  ]){
    const x=historyResult(m,'test');
    assert.equal(x.tokensSaved,0);
    assert.equal(x.exactRestore,true);
  }
});
test('reject unsupported source, invalid syntax and malformed history without leaking content or path',()=>{
  temp(dir=>{
    const invalid=path.join(dir,'USER_PRIVATE_PATH.json');
    fs.writeFileSync(invalid,'[{"role":"tool","content":"PRIVATE_HIDDEN"}, broken]');
    const bad=call(['--history',invalid]);
    assert.equal(bad.status,1);
    assert.match(bad.stderr,/invalid_history_json/);
    assert.doesNotMatch(bad.stderr,/USER_PRIVATE_PATH|PRIVATE_HIDDEN/);
    const wrong=path.join(dir,'private-secret.txt');
    fs.writeFileSync(wrong,'function f(){ if(x) return true; else return false;}');
    const rejected=call(['--source',wrong]);
    assert.equal(rejected.status,1);
    assert.match(rejected.stderr,/unsupported_source/);
    assert.doesNotMatch(rejected.stderr,/private-secret/);
    const badSource=path.join(dir,'private-broken.js');
    fs.writeFileSync(badSource,'function x( {');
    const result=call(['--source',badSource]);
    assert.equal(result.status,1);
    assert.match(result.stderr,/invalid_input/);
    assert.doesNotMatch(result.stderr,/private-broken/);
  });
});
test('reject symlinks, directories, oversized files, NUL and invalid UTF-8',()=>{
  temp(dir=>{
    const valid=path.join(dir,'data.json');
    fs.writeFileSync(valid,'[]');
    const link=path.join(dir,'link.json');fs.symlinkSync(valid,link);
    for(const x of [link,dir])assert.throws(()=>readFile(x),/invalid_file/);
    const large=path.join(dir,'large.json');fs.writeFileSync(large,Buffer.alloc(1024*1024+1,0x30));
    assert.throws(()=>readFile(large),/invalid_file/);
    const nul=path.join(dir,'nul.json');fs.writeFileSync(nul,Buffer.from([123,0,125]));
    assert.throws(()=>readFile(nul),/invalid_file/);
    const utf=path.join(dir,'utf.json');fs.writeFileSync(utf,Buffer.from([0xff,0xfe]));
    assert.throws(()=>readFile(utf));
  });
});
test('reject unsupported argument combinations and never invoke local agent',()=>{
  for(const a of [
    ['--source'],['--history'],['--source','--history'],['--json','--json'],
    ['--source','--json'],['--foo','test']
  ]){
    assert.throws(()=>parseArgs(a),/invalid_arguments/);
    const r=call(a);assert.equal(r.status,1);
    assert.doesNotMatch(r.stderr,/\/vercel\/sandbox|\/Users\/private/);
  }
  assert.equal(parseArgs(['--source','x.ts','--json']).mode,'source');
  const help=call(['--help']);assert.equal(help.status,0);assert.match(help.stdout,/--history FILE/);
});

test('npm run try is a working public entrypoint with no paid calls',()=>{
  const p=spawnSync('npm',['run','try','--','--json'],{
    cwd:root,encoding:'utf8',timeout:45000,maxBuffer:256*1024});
  assert.equal(p.status,0,p.stderr);
  const begin=p.stdout.indexOf('{\n');
  assert.ok(begin>=0);
  const d=JSON.parse(p.stdout.slice(begin));
  assert.equal(d.modelCalls,0);assert.equal(d.fileWrites,0);
  assert.equal(d.repeated.exactRestore,true);
  assert.equal(d.noRepeat.tokensSaved,0);
  assert.equal(d.billedSavingsUsd,null);
});
