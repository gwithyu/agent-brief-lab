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
test('shared file reader caps bytes consumed if an input grows after descriptor validation',(t)=>temp(dir=>{
  const file=path.join(dir,'growing.js');fs.writeFileSync(file,'valid source');
  const originalFstat=fs.fstatSync,originalRead=fs.readSync;
  let grown=false,openedFd,consumed=0;
  t.mock.method(fs,'fstatSync',function(fd,...args){
    const stat=originalFstat.call(fs,fd,...args);openedFd=fd;
    if(!grown){grown=true;fs.writeFileSync(file,Buffer.alloc(2*1024*1024,0x61));}
    return stat;
  });
  t.mock.method(fs,'readSync',function(...args){const count=originalRead.apply(fs,args);consumed+=count;return count;});
  assert.throws(()=>readFile(file),/invalid_file/);assert.equal(grown,true);
  assert.ok(consumed>0&&consumed<=1024*1024+1,`consumed ${consumed} bytes`);
  assert.throws(()=>originalFstat.call(fs,openedFd),{code:'EBADF'});
}));
test('shared file reader joins short reads before decoding multibyte UTF-8 and BOM',(t)=>temp(dir=>{
  const file=path.join(dir,'short.js'),source='\ufeff说明🙂\r\n第二行';fs.writeFileSync(file,source);
  const originalRead=fs.readSync;let calls=0;
  t.mock.method(fs,'readSync',function(fd,buffer,offset,length,position){
    calls++;return originalRead.call(fs,fd,buffer,offset,Math.min(length,2),position);
  });
  assert.equal(readFile(file,{preserveBom:true}),source);
  assert.equal(readFile(file),source.slice(1));assert.ok(calls>2);
}));
test('shared file reader closes its descriptor when a later bounded read throws',(t)=>temp(dir=>{
  const file=path.join(dir,'failure.js');fs.writeFileSync(file,'valid source');
  const originalFstat=fs.fstatSync,originalRead=fs.readSync,failure=Error('simulated I/O failure');
  let fd,calls=0;
  t.mock.method(fs,'fstatSync',function(selected,...args){fd=selected;return originalFstat.call(fs,selected,...args)});
  t.mock.method(fs,'readSync',function(selected,buffer,offset,length,position){
    if(++calls===2)throw failure;
    return originalRead.call(fs,selected,buffer,offset,Math.min(length,2),position);
  });
  assert.throws(()=>readFile(file),error=>error===failure);assert.equal(calls,2);
  assert.throws(()=>originalFstat.call(fs,fd),{code:'EBADF'});
}));
test('shared file reader refuses a leaf replaced by a symlink after its path check without reading bytes',(t)=>temp(dir=>{
  const file=path.join(dir,'source.js'),target=path.join(dir,'target.js');
  fs.writeFileSync(file,'original source');fs.writeFileSync(target,'PRIVATE_TARGET');
  const originalStat=fs.lstatSync,originalRead=fs.readSync;let swapped=false,reads=0;
  t.mock.method(fs,'lstatSync',function(selected,...args){
    const stat=originalStat.call(fs,selected,...args);
    if(selected===file&&!swapped){swapped=true;fs.unlinkSync(file);fs.symlinkSync(target,file);}
    return stat;
  });
  t.mock.method(fs,'readSync',function(...args){reads++;return originalRead.apply(fs,args)});
  assert.throws(()=>readFile(file),/invalid_file/);assert.equal(swapped,true);assert.equal(reads,0);
}));
test('shared file reader refuses a different regular inode before reading and closes its descriptor',(t)=>temp(dir=>{
  const file=path.join(dir,'source.js'),replacement=path.join(dir,'replacement.js');
  fs.writeFileSync(file,'original source');fs.writeFileSync(replacement,'replaced source');
  const originalStat=fs.lstatSync,originalFstat=fs.fstatSync,originalRead=fs.readSync;
  let swapped=false,openedFd,reads=0;
  t.mock.method(fs,'lstatSync',function(selected,...args){
    const stat=originalStat.call(fs,selected,...args);
    if(selected===file&&!swapped){swapped=true;fs.renameSync(file,file+'.old');fs.renameSync(replacement,file);}
    return stat;
  });
  t.mock.method(fs,'fstatSync',function(fd,...args){openedFd=fd;return originalFstat.call(fs,fd,...args)});
  t.mock.method(fs,'readSync',function(...args){reads++;return originalRead.apply(fs,args)});
  assert.throws(()=>readFile(file),/invalid_file/);assert.equal(swapped,true);assert.equal(reads,0);
  assert.equal(typeof openedFd,'number');assert.throws(()=>originalFstat.call(fs,openedFd),{code:'EBADF'});
}));
test('shared file reader retains the checked open file if its pathname changes afterward and closes on success',(t)=>temp(dir=>{
  const file=path.join(dir,'source.js'),replacement=path.join(dir,'replacement.js');
  fs.writeFileSync(file,'original source');fs.writeFileSync(replacement,'replaced source');
  const originalFstat=fs.fstatSync,originalRead=fs.readFileSync;let swapped=false,openedFd;
  t.mock.method(fs,'fstatSync',function(fd,...args){
    const stat=originalFstat.call(fs,fd,...args);openedFd=fd;
    if(!swapped){swapped=true;fs.renameSync(file,file+'.old');fs.renameSync(replacement,file);}
    return stat;
  });
  assert.equal(readFile(file),'original source');assert.equal(swapped,true);
  assert.equal(originalRead.call(fs,file,'utf8'),'replaced source');
  assert.throws(()=>originalFstat.call(fs,openedFd),{code:'EBADF'});
}));
test('shared file reader checks opened type and size before consuming any bytes',(t)=>temp(dir=>{
  const originalStat=fs.lstatSync,originalRead=fs.readSync;let reads=0;
  t.mock.method(fs,'readSync',function(...args){reads++;return originalRead.apply(fs,args)});
  for(const kind of ['empty','large','directory']){
    const file=path.join(dir,kind);fs.writeFileSync(file,'valid source');let changed=false;
    const mocked=t.mock.method(fs,'lstatSync',function(selected,...args){
      const stat=originalStat.call(fs,selected,...args);
      if(selected===file&&!changed){
        changed=true;
        if(kind==='directory'){fs.unlinkSync(file);fs.mkdirSync(file);}
        else fs.writeFileSync(file,kind==='empty'?'':Buffer.alloc(1024*1024+1,0x61));
      }
      return stat;
    });
    try{assert.throws(()=>readFile(file),/invalid_file/);assert.equal(changed,true);assert.equal(reads,0);}
    finally{mocked.mock.restore();}
  }
}));
test('shared file reader compares inode identities without rounding large integers',(t)=>temp(dir=>{
  const file=path.join(dir,'source.js');fs.writeFileSync(file,'valid source');
  const originalStat=fs.lstatSync,originalFstat=fs.fstatSync;
  const first=2n**53n,second=first+1n;assert.equal(Number(first),Number(second));
  t.mock.method(fs,'lstatSync',function(selected,options){
    const stat=originalStat.call(fs,selected,options);
    if(selected===file)stat.ino=options?.bigint?first:Number(first);
    return stat;
  });
  t.mock.method(fs,'fstatSync',function(fd,options){
    const stat=originalFstat.call(fs,fd,options);stat.ino=options?.bigint?second:Number(second);return stat;
  });
  assert.throws(()=>readFile(file),/invalid_file/);
}));
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
    const exact=path.join(dir,'exact.txt'),text='x'.repeat(1024*1024-2)+'é';
    fs.writeFileSync(exact,text);assert.equal(readFile(exact),text);
    const large=path.join(dir,'large.json');fs.writeFileSync(large,Buffer.alloc(1024*1024+1,0x30));
    assert.throws(()=>readFile(large),/invalid_file/);
    const nul=path.join(dir,'nul.json');fs.writeFileSync(nul,Buffer.from([123,0,125]));
    assert.throws(()=>readFile(nul),/invalid_file/);
    const utf=path.join(dir,'utf.json');fs.writeFileSync(utf,Buffer.from([0xff,0xfe]));
    assert.throws(()=>readFile(utf));
  });
});
test('BOM-prefixed history still parses through the existing preview entry',()=>temp(dir=>{
  const name=path.join(dir,'bom-history.json');
  const bytes=Buffer.concat([Buffer.from([0xef,0xbb,0xbf]),Buffer.from('[]')]);fs.writeFileSync(name,bytes);
  const r=call(['--history',name,'--json']);assert.equal(r.status,0,r.stderr);
  const d=JSON.parse(r.stdout);
  assert.equal(d.measurementStatus,'complete');assert.equal(d.exactRestore,true);assert.equal(d.tokensSaved,0);
  assert.deepEqual(fs.readFileSync(name),bytes);
}));
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

test('agent-brief try binary dispatches default and private file preview with aggregate JSON',()=>{
  const executable=path.join(root,'index.cjs');
  const defaultRun=spawnSync(process.execPath,[executable,'try'],{
    cwd:os.tmpdir(),encoding:'utf8',timeout:25000,maxBuffer:128*1024});
  assert.equal(defaultRun.status,0,defaultRun.stderr);
  assert.match(defaultRun.stdout,/synthetic first run/);
  const r=spawnSync(process.execPath,[executable,'try','--json'],{
    cwd:os.tmpdir(),encoding:'utf8',timeout:25000,maxBuffer:128*1024});
  assert.equal(r.status,0,r.stderr);
  assert.equal(JSON.parse(r.stdout).modelCalls,0);
  temp(dir=>{
    const n=path.join(dir,'customer-secret.js');
    const raw='function f(x){if(x){return true;}else{return false;}}\n';
    fs.writeFileSync(n,raw);
    const result=spawnSync(process.execPath,[executable,'try','--source',n,'--json'],{
      cwd:os.tmpdir(),encoding:'utf8',timeout:25000,maxBuffer:128*1024});
    assert.equal(result.status,0,result.stderr);
    assert.ok(JSON.parse(result.stdout).tokensSaved>0);
    assert.equal(fs.readFileSync(n,'utf8'),raw);
    assert.doesNotMatch(result.stdout,/customer-secret|function f/);
    const rejected=spawnSync(process.execPath,[executable,'try','--source',n,'--json','--unexpected'],{
      cwd:os.tmpdir(),encoding:'utf8',timeout:25000,maxBuffer:128*1024});
    assert.equal(rejected.status,1);
    assert.doesNotMatch(rejected.stderr,/customer-secret|\/tmp\//);
  });
  const help=spawnSync(process.execPath,[executable,'--help'],{encoding:'utf8',timeout:5000});
  assert.equal(help.status,0);
  assert.match(help.stdout,/try \[--history FILE/);
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
test('pathological source preview returns unknown safely instead of hanging or claiming zero savings',()=>temp(dir=>{
  const name=path.join(dir,'private-customer.js');
  const source='const PRIVATE_CLIENT = "'+'x'.repeat(100000)+'";\n';
  fs.writeFileSync(name,source);
  const r=call(['--source',name,'--json']);
  assert.equal(r.status,0,r.stderr);assert.equal(r.signal,null);
  const d=JSON.parse(r.stdout);
  assert.equal(d.measurementStatus,'unavailable');
  assert.equal(d.beforeTokens,null);assert.equal(d.afterTokens,null);assert.equal(d.tokensSaved,null);
  assert.equal(d.acceptedInMemory,null);assert.equal(d.modelCalls,0);assert.equal(d.fileWrites,0);
  assert.equal(d.billedSavingsUsd,null);
  assert.equal(d.beforeBytes,Buffer.byteLength(source));assert.equal(d.afterBytes,d.beforeBytes);
  assert.equal(fs.readFileSync(name,'utf8'),source);
  assert.doesNotMatch(r.stdout,/PRIVATE_CLIENT|private-customer|\/tmp\//);
  const text=call(['--source',name]);
  assert.match(text.stdout,/token savings remain unknown/);
  assert.doesNotMatch(text.stdout,/null fewer|0 fewer|PRIVATE_CLIENT/);
}));
test('unavailable history measurement does not claim an exact reconstruction was checked',()=>temp(dir=>{
  const name=path.join(dir,'history.json');
  const messages=[{role:'tool',content:'PRIVATE_'+'x'.repeat(700)},
    {role:'tool',content:'PRIVATE_'+'x'.repeat(700)}];
  fs.writeFileSync(name,JSON.stringify(messages));
  const r=call(['--history',name,'--json']);assert.equal(r.status,0,r.stderr);
  const d=JSON.parse(r.stdout);
  assert.equal(d.exactRestore,null);assert.equal(d.tokensSaved,null);
  assert.equal(d.dictionaryEntries,null);assert.equal(d.historyMessages,2);
  assert.equal(d.measurementStatus,'unavailable');assert.doesNotMatch(r.stdout,/PRIVATE_/);
}));
test('normal large history is measured in a worker with reconstruction and privacy intact',()=>temp(dir=>{
  const text=Array.from({length:180},(_,i)=>`function item${i}(value) { return value + ${i}; }\n`).join('');
  const messages=[{role:'user',content:'Keep the task'},
    {role:'tool',content:text,tool_call_id:'PRIVATE_ID_1'},
    {role:'tool',content:text,tool_call_id:'PRIVATE_ID_2'}];
  const name=path.join(dir,'large-history.json'),original=JSON.stringify(messages);
  assert.ok(Buffer.byteLength(original)>8192);fs.writeFileSync(name,original);
  const r=call(['--history',name,'--json']);assert.equal(r.status,0,r.stderr);
  const d=JSON.parse(r.stdout);
  assert.equal(d.measurementStatus,'complete');assert.equal(d.measurementMethod,'bounded_worker');
  assert.equal(d.exactRestore,true);assert.ok(d.tokensSaved>0);
  assert.equal(d.providerUsage,null);assert.equal(d.billedSavingsUsd,null);
  assert.doesNotMatch(r.stdout,/PRIVATE_ID|function item|large-history/);
  assert.equal(fs.readFileSync(name,'utf8'),original);
}));
test('normal large source preview retains zero-gain measurements without editing source',()=>temp(dir=>{
  const source=Array.from({length:220},(_,i)=>`export function item${i}(value) { return value + ${i}; }\n`).join('');
  const name=path.join(dir,'large-source.js');fs.writeFileSync(name,source);
  const r=call(['--source',name,'--json']);assert.equal(r.status,0,r.stderr);
  const d=JSON.parse(r.stdout);
  assert.equal(d.measurementStatus,'complete');assert.equal(d.measurementMethod,'bounded_worker');
  assert.equal(d.tokensSaved,0);assert.equal(d.acceptedInMemory,0);
  assert.equal(d.beforeTokens,d.afterTokens);assert.equal(fs.readFileSync(name,'utf8'),source);
}));
test('large syntax errors remain safe errors rather than successful worker measurements',()=>temp(dir=>{
  const name=path.join(dir,'PRIVATE_BROKEN.js');
  fs.writeFileSync(name,'// ordinary filler text\n'.repeat(500)+'function f( {');
  const r=call(['--source',name,'--json']);
  assert.equal(r.status,1);assert.match(r.stderr,/invalid_input/);
  assert.equal(r.stdout,'');assert.doesNotMatch(r.stderr,/PRIVATE_BROKEN|ordinary filler|\/tmp\//);
}));
test('invalid history schema and unsupported files cannot bypass checks through repetition fallback',()=>temp(dir=>{
  const name=path.join(dir,'invalid.json');
  for(const messages of [[{role:'unknown',content:'x'.repeat(700)}],
    [{role:'tool',content:'x'.repeat(700),value:null}]]){
    const raw=JSON.stringify(messages).replace('"value":null','"value":1e400');
    fs.writeFileSync(name,raw);const r=call(['--history',name,'--json']);
    assert.equal(r.status,1);assert.equal(r.stdout,'');
  }
  const wrong=path.join(dir,'unsupported.txt');fs.writeFileSync(wrong,'x'.repeat(700));
  const r=call(['--source',wrong,'--json']);
  assert.equal(r.status,1);assert.match(r.stderr,/unsupported_source/);
}));
test('private worker protocol refuses invalid requests without leaking data or opening a public CLI mode',()=>{
  for(const input of ['PRIVATE_SECRET',JSON.stringify({mode:'source',content:'SECRET',name:'a.js',extra:true}),
    JSON.stringify({mode:'execute',content:'PRIVATE_COMMAND',name:'a.js'})]){
    const r=spawnSync(process.execPath,[cli,'--internal-preview-worker'],
      {input,encoding:'utf8',timeout:5000});
    assert.equal(r.status,0);const reply=JSON.parse(r.stdout);
    assert.equal(reply.ok,false);assert.equal(r.stderr,'');assert.doesNotMatch(r.stdout,/PRIVATE_|SECRET/);
  }
  const r=spawnSync(process.execPath,[path.join(root,'index.cjs'),'try','--internal-preview-worker'],
    {encoding:'utf8',timeout:5000});
  assert.equal(r.status,1);assert.match(r.stderr,/invalid_arguments/);
});
