'use strict';
const {test}=require('node:test'),assert=require('node:assert/strict');
const fs=require('node:fs'),os=require('node:os'),path=require('node:path'),{createHash}=require('node:crypto');
const {spawnSync}=require('node:child_process');
const {readSource,readSymbol,parseArgs,runCli}=require('../source-read.cjs');
const {outline}=require('../outline.cjs');
const cli=path.resolve(__dirname,'../index.cjs'),hash=s=>createHash('sha256').update(s).digest('hex');
function fixture(fn){const dir=fs.mkdtempSync(path.join(os.tmpdir(),'brief-source-read-'));
  try{return fn(dir)}finally{fs.rmSync(dir,{recursive:true,force:true});}}
function call(args){return spawnSync(process.execPath,[cli,'read',...args],{encoding:'utf8',timeout:10000});}
test('actual outline lookup reads exactly the selected function, retaining the original file',()=>fixture(dir=>{
  const file=path.join(dir,'sample.js');
  const source='const PRIVATE_UNSELECTED = 1;\nfunction entry(v) {\n  return v + 1;\n}\nfunction other() {return 2;}\n';
  fs.writeFileSync(file,source);const before=fs.readdirSync(dir),map=outline(file);
  const selected=map.symbols.find(s=>s.name==='entry');
  const r=readSource({file,startLine:selected.startLine,endLine:selected.endLine,expectedSha256:map.sourceSha256});
  assert.equal(r.text,'function entry(v) {\n  return v + 1;\n}\n');
  assert.equal(r.sliceBytes,Buffer.byteLength(r.text));assert.equal(r.sourceBytes,Buffer.byteLength(source));
  assert.equal(r.completeContext,false);assert.equal(r.modelCalls,0);assert.equal(r.fileWrites,0);
  assert.doesNotMatch(r.text,/PRIVATE_UNSELECTED|function other/);
  assert.equal(fs.readFileSync(file,'utf8'),source);assert.deepEqual(fs.readdirSync(dir),before);
}));
test('changed source refuses before any original code is printed',()=>fixture(dir=>{
  const file=path.join(dir,'PRIVATE_PATH.js'),source='function entry() {return "PRIVATE_BODY";}\n';
  fs.writeFileSync(file,source);const old=hash(source);fs.writeFileSync(file,'// changed\n'+source);
  const r=call(['--source',file,'--lines','1:1','--sha256',old,'--json']);
  assert.equal(r.status,1);assert.equal(r.stdout,'');assert.match(r.stderr,/source_changed/);
  assert.doesNotMatch(r.stderr,/PRIVATE_|function entry|\/tmp\//);
}));
test('BOM, CRLF, bare CR, LS and PS match outline line positions without normalization',()=>fixture(dir=>{
  const file=path.join(dir,'breaks.js');
  const source='\ufeff// header\r\nfunction first() {}\rfunction second() {}\u2028function third() {}\u2029';
  fs.writeFileSync(file,source);const map=outline(file),expectedSha256=hash(Buffer.from(source));
  assert.equal(map.sourceSha256,expectedSha256);assert.equal(map.lineCount,5);
  for(const [name,expected] of [['first','function first() {}\r'],['second','function second() {}\u2028'],['third','function third() {}\u2029']]){
    const s=map.symbols.find(x=>x.name===name);
    const r=readSource({file,startLine:s.startLine,endLine:s.endLine,expectedSha256});
    assert.equal(r.text,expected);assert.equal(r.lineCount,map.lineCount);
  }
  assert.equal(readSource({file,startLine:1,endLine:1,expectedSha256}).text,'\ufeff// header\r\n');
  assert.equal(readSource({file,startLine:5,endLine:5,expectedSha256}).text,'');
}));
test('no trailing newline and UTF-8 multibyte characters preserve the exact selected bytes',()=>fixture(dir=>{
  const file=path.join(dir,'unicode.txt'),source='第一行\n第二行🙂';fs.writeFileSync(file,source);
  const r=readSource({file,startLine:2,endLine:2,expectedSha256:hash(source)});
  assert.equal(r.text,'第二行🙂');assert.equal(r.sliceBytes,Buffer.byteLength('第二行🙂'));
}));
test('explicit line and byte budgets refuse instead of silently truncating',()=>fixture(dir=>{
  const file=path.join(dir,'budget.txt');let source=Array.from({length:201},()=> 'x').join('\n');
  fs.writeFileSync(file,source);
  assert.throws(()=>readSource({file,startLine:1,endLine:201,expectedSha256:hash(source)}),/read_budget_exceeded/);
  source='字'.repeat(22000);fs.writeFileSync(file,source);
  assert.throws(()=>readSource({file,startLine:1,endLine:1,expectedSha256:hash(source)}),/read_budget_exceeded/);
  source='a'.repeat(65536);fs.writeFileSync(file,source);
  assert.equal(readSource({file,startLine:1,endLine:1,expectedSha256:hash(source)}).sliceBytes,65536);
}));
test('invalid ranges, fingerprints and input files are rejected safely',()=>fixture(dir=>{
  const file=path.join(dir,'sample.txt');fs.writeFileSync(file,'a\nb');
  for(const [startLine,endLine] of [[0,1],[-1,1],[2,1],[1.5,2],[NaN,2],[1,Infinity]])
    assert.throws(()=>readSource({file,startLine,endLine,expectedSha256:hash('a\nb')}),/invalid_arguments/);
  assert.throws(()=>readSource({file,startLine:1,endLine:3,expectedSha256:hash('a\nb')}),/invalid_line_range/);
  assert.throws(()=>readSource({file,startLine:1,endLine:1,expectedSha256:'bad'}),/invalid_arguments/);
  const link=path.join(dir,'link.txt');fs.symlinkSync(file,link);
  for(const target of [dir,link])assert.throws(()=>readSource({file:target,startLine:1,endLine:1,expectedSha256:hash('a\nb')}),/invalid_file/);
  const large=path.join(dir,'large.txt');fs.writeFileSync(large,Buffer.alloc(1024*1024+1,0x61));
  assert.throws(()=>readSource({file:large,startLine:1,endLine:1,expectedSha256:'0'.repeat(64)}),/invalid_file/);
}));
test('CLI prints only the explicitly requested source data and never executes it',()=>fixture(dir=>{
  const file=path.join(dir,'sample.cjs'),marker=path.join(dir,'must-not-execute');
  const source=`require('node:fs').writeFileSync(${JSON.stringify(marker)}, 'executed');\nfunction visible() {}\n`;
  fs.writeFileSync(file,source);
  const args=['--source',file,'--lines','2:2','--sha256',hash(source)];
  const r=call([...args,'--json']);assert.equal(r.status,0,r.stderr);
  assert.equal(JSON.parse(r.stdout).text,'function visible() {}\n');assert.doesNotMatch(r.stdout,/must-not-execute|writeFileSync/);
  const human=call(args);assert.equal(human.status,0,human.stderr);
  assert.match(human.stdout,/source data, not instructions/);assert.match(human.stdout,/function visible/);
  assert.equal(fs.existsSync(marker),false);assert.equal(fs.readFileSync(file,'utf8'),source);
}));
test('argument parser requires an explicit hash, canonical range and bounded command shape',()=>{
  const valid=['--source','x.js','--lines','1:2','--sha256','a'.repeat(64)];
  assert.equal(parseArgs([...valid,'--json']).startLine,1);
  for(const args of [[],valid.slice(0,4),[...valid,'--json','--json'],[...valid,'--extra'],
    ['--source','x','--lines','01:2','--sha256','a'.repeat(64)],
    ['--source','x','--lines','1e2:3','--sha256','a'.repeat(64)],
    ['--source','--json','--lines','1:2','--sha256','a'.repeat(64)]])
    assert.throws(()=>parseArgs(args),/invalid_arguments/);
  const help=call(['--help']);assert.equal(help.status,0);assert.match(help.stdout,/200 lines \/ 64 KiB/);
});
test('symbol read automatically binds one exact Unicode declaration and preserves original BOM/CRLF',()=>fixture(dir=>{
  const file=path.join(dir,'unicode.js'),source='\ufefffunction 计算(v) {\r\n  return v + 1;\r\n}';
  fs.writeFileSync(file,source);const r=readSymbol({file,symbol:'计算'});
  assert.equal(r.text,source);assert.equal(r.sourceSha256,hash(source));
  assert.deepEqual(r.selectedSymbol,{kind:'function',name:'计算',container:null,startLine:1,endLine:3});
  assert.equal(r.completeContext,false);assert.equal(r.fileWrites,0);assert.equal(r.modelCalls,0);
  assert.equal(fs.readFileSync(file,'utf8'),source);
}));
test('symbol CLI finds a unique declaration beyond the first directory page in one lookup',()=>fixture(dir=>{
  const file=path.join(dir,'tail.js');
  const source=Array.from({length:520},(_,i)=>`function f${i}() {return ${i};}`).join('\n');fs.writeFileSync(file,source);
  const r=call(['--source',file,'--symbol','f519','--json']);assert.equal(r.status,0,r.stderr);
  const data=JSON.parse(r.stdout);
  assert.equal(data.text,'function f519() {return 519;}');assert.equal(data.selectedSymbol.startLine,520);
  assert.doesNotMatch(r.stdout,/function f0\(|function f518\(/);
}));
test('symbol reads preserve complete physical lines rather than clipping same-line neighbors',()=>fixture(dir=>{
  const file=path.join(dir,'same-line.js'),source='function one(){return 1;} function two(){return 2;}\n';
  fs.writeFileSync(file,source);const r=readSymbol({file,symbol:'one'});
  assert.equal(r.text,source);assert.equal(r.selectedSymbol.name,'one');assert.equal(r.completeContext,false);
}));
test('named reads retain attached JSDoc for declarations, variable bindings, members and CommonJS assignments',()=>fixture(dir=>{
  const file=path.join(dir,'documented.ts');
  const cases=[
    ['entry',null,'/** @param value Must be positive. */\r\nexport function entry(value:number) {return value;}\r\n'],
    ['arrow',null,'/** Returns milliseconds, not seconds. */\r\nexport const arrow=(value:number)=>value;\r\n'],
    ['run','api','  /** Caller must hold the lock. */\r\n  run() {},\r\n'],
    ['field','Client','  /** Call only after connect. */\r\n  field=()=>1;\r\n'],
    ['named','exports','/** Never retry this operation. */\r\nexports.named=()=>1;\r\n'],
    ['other','module.exports','/** Input is already encoded. */\r\nmodule.exports.other=()=>2;\r\n'],
    ['exports','module','/** Owns the returned handle. */\r\nmodule.exports=()=>3;\r\n']
  ];
  const source='\ufeffconst unrelated="PRIVATE_CONTEXT";\r\n'+cases[0][2]+cases[1][2]
    +'const api={\r\n'+cases[2][2]+'};\r\nclass Client {\r\n'+cases[3][2]+'}\r\n'
    +cases.slice(4).map(c=>c[2]).join('');
  fs.writeFileSync(file,source);const map=outline(file);
  assert.equal(map.sourceSha256,hash(source));
  assert.doesNotMatch(JSON.stringify(map),/Must be positive|Caller must|PRIVATE_CONTEXT/);
  for(const [symbol,container,expected] of cases){
    const r=readSymbol({file,symbol,container});assert.equal(r.text,expected,symbol);
    const location=map.symbols.find(s=>s.name===symbol&&s.container===container);
    assert.deepEqual(r.selectedSymbol,location);assert.equal(r.startLine,location.startLine);
    assert.equal(r.sourceSha256,hash(source));assert.equal(r.completeContext,false);
  }
  assert.equal(fs.readFileSync(file,'utf8'),source);
}));
test('statement JSDoc for a later variable binding retains the original prefix rather than stitching fragments',()=>fixture(dir=>{
  const file=path.join(dir,'multiple.js');
  const documented='/** Both inputs must be normalized. */\nconst first=()=>1,\n  second=()=>2;\n';
  const source='const unrelated=0;\n'+documented;fs.writeFileSync(file,source);
  const r=readSymbol({file,symbol:'second'});
  assert.equal(r.text,documented);assert.equal(r.startLine,2);assert.equal(r.endLine,4);
  assert.equal(r.selectedSymbol.name,'second');assert.equal(r.completeContext,false);
}));
test('ordinary leading comments and documentation attached to an earlier statement are not pulled in',()=>fixture(dir=>{
  const file=path.join(dir,'unattached.js');
  fs.writeFileSync(file,'/** PRIVATE_EARLIER */\nconst unrelated=1;\n// PRIVATE_COMMENT\nfunction entry() {}\n');
  const r=readSymbol({file,symbol:'entry'});
  assert.equal(r.text,'function entry() {}\n');assert.doesNotMatch(r.text,/PRIVATE_/);
}));
test('documentation counts toward both read budgets and an oversize documented symbol emits no partial source',()=>fixture(dir=>{
  const file=path.join(dir,'budget.js');
  for(const docs of ['/**\n'+' * required context\n'.repeat(198)+' */\n','/** '+'x'.repeat(65536)+' */\n']){
    fs.writeFileSync(file,docs+'function entry() {}\n');
    const r=call(['--source',file,'--symbol','entry','--json']);
    assert.equal(r.status,1);assert.equal(r.stdout,'');assert.match(r.stderr,/read_budget_exceeded/);
  }
}));
test('documentation-only edits invalidate a pinned symbol read, while explicit line mode keeps its requested range',()=>fixture(dir=>{
  const file=path.join(dir,'changed-docs.js'),code='function entry() {}\n';
  const old='/** Input must be positive. */\n'+code,current='/** Input must be negative. */\n'+code;
  fs.writeFileSync(file,current);
  const r=call(['--source',file,'--symbol','entry','--sha256',hash(old),'--json']);
  assert.equal(r.status,1);assert.equal(r.stdout,'');assert.match(r.stderr,/source_changed/);
  assert.equal(readSource({file,startLine:2,endLine:2,expectedSha256:hash(current)}).text,code);
  assert.equal(readSymbol({file,symbol:'entry'}).text,current);
}));
test('duplicate names across the full file refuse, and an exact container selects the intended method',()=>fixture(dir=>{
  const file=path.join(dir,'duplicate.js');
  const source='function run() {return "PRIVATE_TOP";}\n'
    +Array.from({length:510},(_,i)=>`function f${i}(){}`).join('\n')
    +'\nconst api = {\n  run() { return "selected"; }\n};\n';fs.writeFileSync(file,source);
  const r=call(['--source',file,'--symbol','run','--json']);
  assert.equal(r.status,1);assert.equal(r.stdout,'');assert.match(r.stderr,/ambiguous_symbol/);
  assert.doesNotMatch(r.stderr,/PRIVATE_|\/tmp\//);
  const selected=call(['--source',file,'--symbol','run','--container','api','--json']);
  assert.equal(selected.status,0,selected.stderr);assert.equal(JSON.parse(selected.stdout).text,'  run() { return "selected"; }\n');
  assert.equal(JSON.parse(selected.stdout).selectedSymbol.container,'api');
}));
test('symbol lookup never substitutes a prefix, aliased reference or unsupported nested declaration',()=>fixture(dir=>{
  const file=path.join(dir,'missing.js');
  fs.writeFileSync(file,'function outer() {function hidden(){}}\nconst api={ref: external};\n');
  for(const symbol of ['out','hidden','ref','PRIVATE_UNKNOWN']){
    const r=call(['--source',file,'--symbol',symbol,'--json']);
    assert.equal(r.status,1);assert.equal(r.stdout,'');assert.match(r.stderr,/symbol_not_found/);
    assert.doesNotMatch(r.stderr,/PRIVATE_|\/tmp\//);
  }
}));
test('optional pinned symbol reads reject stale source, while a fresh request observes current bytes',()=>fixture(dir=>{
  const file=path.join(dir,'changed.js'),old='function entry() {return 1;}\n',current='function entry() {return 2;}\n';
  fs.writeFileSync(file,old);const pinned=hash(old);fs.writeFileSync(file,current);
  const r=call(['--source',file,'--symbol','entry','--sha256',pinned,'--json']);
  assert.equal(r.status,1);assert.equal(r.stdout,'');assert.match(r.stderr,/source_changed/);
  const fresh=readSymbol({file,symbol:'entry'});assert.equal(fresh.text,current);assert.equal(fresh.sourceSha256,hash(current));
  assert.equal(fs.readFileSync(file,'utf8'),current);
}));
test('symbol mode retains the exact line and byte budgets without partial source output',()=>fixture(dir=>{
  const file=path.join(dir,'large.js');
  fs.writeFileSync(file,'function large() {\n'+'  // filler\n'.repeat(201)+'}\n');
  const r=call(['--source',file,'--symbol','large','--json']);
  assert.equal(r.status,1);assert.equal(r.stdout,'');assert.match(r.stderr,/read_budget_exceeded/);
  fs.writeFileSync(file,'function large() {return "'+'x'.repeat(70000)+'";}');
  assert.throws(()=>readSymbol({file,symbol:'large'}),/read_budget_exceeded/);
}));
test('oversize named CLI reads return body-free observed coordinates that resume through existing line reads',()=>fixture(dir=>{
  const file=path.join(dir,'PRIVATE_FILE.cjs'),marker=path.join(dir,'PRIVATE_MARKER');
  const selected='/** PRIVATE_REQUIRED_NOTE */\r\nfunction large() {\r\n'
    +'  // PRIVATE_BODY\r\n'.repeat(220)+'}\r\n';
  const source='\ufeff'+`require('node:fs').writeFileSync(${JSON.stringify(marker)}, 'executed');\r\n`+selected;
  fs.writeFileSync(file,source);const before=fs.readdirSync(dir);
  const r=call(['--source',file,'--symbol','large','--json']);
  assert.equal(r.status,1);assert.equal(r.stdout,'');assert.doesNotMatch(r.stderr,/PRIVATE_|\/tmp\//);
  const refused=JSON.parse(r.stderr),hint=refused.readHint;
  assert.equal(refused.schema,'agent-brief-source-read-refusal.v1');assert.equal(refused.status,'refused');
  assert.equal(refused.error,'read_budget_exceeded');assert.equal(refused.completeContext,false);
  assert.equal(refused.modelCalls,0);assert.equal(refused.fileWrites,0);
  assert.deepEqual(hint,{sourceSha256:hash(source),startLine:2,endLine:224,maxLines:200,maxSliceBytes:65536});
  let reconstructed='';
  for(let startLine=hint.startLine;startLine<=hint.endLine;startLine+=hint.maxLines){
    const endLine=Math.min(startLine+hint.maxLines-1,hint.endLine);
    reconstructed+=readSource({file,startLine,endLine,expectedSha256:hint.sourceSha256}).text;
  }
  assert.equal(reconstructed,selected);assert.equal(fs.existsSync(marker),false);
  assert.equal(fs.readFileSync(file,'utf8'),source);assert.deepEqual(fs.readdirSync(dir),before);
  fs.writeFileSync(file,source.replace('PRIVATE_REQUIRED_NOTE','changed'));
  assert.throws(()=>readSource({file,startLine:hint.startLine,endLine:3,expectedSha256:hint.sourceSha256}),/source_changed/);
}));
test('byte-budget hints are available to library and human callers without suggesting a guaranteed readable chunk',()=>fixture(dir=>{
  const file=path.join(dir,'large.js'),source='function large() {return "'+'x'.repeat(70000)+'";}';
  fs.writeFileSync(file,source);let refusal;
  try{readSymbol({file,symbol:'large'})}catch(e){refusal=e}
  assert.equal(refusal.message,'read_budget_exceeded');
  assert.deepEqual(refusal.readHint,{sourceSha256:hash(source),startLine:1,endLine:1,maxLines:200,maxSliceBytes:65536});
  const r=call(['--source',file,'--symbol','large']);assert.equal(r.status,1);assert.equal(r.stdout,'');
  assert.match(r.stderr,/Observed range/);assert.ok(r.stderr.includes(hash(source)));assert.doesNotMatch(r.stderr,/xxx|function large/);
  assert.match(r.stderr,/single line/i);
  assert.throws(()=>readSource({file,startLine:1,endLine:1,expectedSha256:refusal.readHint.sourceSha256}),/read_budget_exceeded/);
}));
test('unresolved or stale symbol lookups do not expose a resumable range',()=>fixture(dir=>{
  const file=path.join(dir,'lookups.js');fs.writeFileSync(file,'function run() {}\nfunction run() {}\n');
  for(const [symbol,expectedSha256,error] of [['run',null,'ambiguous_symbol'],['missing',null,'symbol_not_found'],
    ['run','0'.repeat(64),'source_changed']]){
    const args=['--source',file,'--symbol',symbol,'--json'];if(expectedSha256)args.push('--sha256',expectedSha256);
    const r=call(args);assert.equal(r.status,1);assert.equal(r.stdout,'');assert.match(r.stderr,new RegExp(error));
    assert.doesNotMatch(r.stderr,/readHint|startLine|sourceSha256/);
  }
}));
test('symbol options reject malformed, duplicate or mixed selectors and preserve line-mode hash requirements',()=>fixture(dir=>{
  const file=path.join(dir,'valid.js');fs.writeFileSync(file,'function entry() {}');
  for(const args of [['--source',file,'--symbol'],['--source',file,'--symbol','entry','--lines','1:1'],
    ['--source',file,'--symbol','entry','--container','api','--container','other'],
    ['--source',file,'--symbol','entry','--sha256','a'.repeat(64),'--sha256','b'.repeat(64)],
    ['--source',file,'--lines','1:1']])assert.throws(()=>parseArgs(args),/invalid_arguments/);
  for(const options of [{symbol:''},{symbol:'x'.repeat(129)},{symbol:'entry',container:''},
    {symbol:'entry',container:'x'.repeat(129)},{symbol:'entry',expectedSha256:'bad'}])
    assert.throws(()=>readSymbol({file,...options}),/invalid_arguments/);
  const p=parseArgs(['--source',file,'--symbol','entry','--sha256','a'.repeat(64),'--container','api','--json']);
  assert.equal(p.symbol,'entry');assert.equal(p.container,'api');assert.equal(p.expectedSha256,'a'.repeat(64));
}));

test('named CLI refuses a source edit between lookup and original read without printing code or hints',(t)=>fixture(dir=>{
  const file=path.join(dir,'PRIVATE_RACE.cjs');
  const old='function entry() {return "PRIVATE_OLD_BODY";}\n';
  const current='// shifted after lookup\nfunction entry() {return "PRIVATE_NEW_BODY";}\n';
  fs.writeFileSync(file,old);const originalRead=fs.readSync,identity=fs.statSync(file);let reads=0;
  t.mock.method(fs,'readSync',function(fd,...args){
    const count=originalRead.call(fs,fd,...args),stat=fs.fstatSync(fd);
    if(count===0&&stat.dev===identity.dev&&stat.ino===identity.ino&&++reads===1)fs.writeFileSync(file,current);
    return count;
  });
  const out=[],err=[];
  const status=runCli(['--source',file,'--symbol','entry','--json'],{out:s=>out.push(s),err:s=>err.push(s)});
  assert.equal(status,1);assert.deepEqual(out,[]);assert.equal(reads,2);
  assert.match(err.join('\n'),/source_changed/);
  assert.doesNotMatch(err.join('\n'),/PRIVATE_|readHint|sourceSha256|\/tmp\//);
  assert.equal(fs.readFileSync(file,'utf8'),current);
}));
test('named CLI refuses a path replaced by a symlink after lookup without reading the link target',(t)=>fixture(dir=>{
  const file=path.join(dir,'PRIVATE_RACE.cjs'),target=path.join(dir,'PRIVATE_TARGET.cjs');
  const protectedSource='function entry() {return "PRIVATE_TARGET_BODY";}\n';
  fs.writeFileSync(file,'function entry() {}\n');fs.writeFileSync(target,protectedSource);
  const originalRead=fs.readSync,identity=fs.statSync(file),protectedIdentity=fs.statSync(target);
  let sourceReads=0,targetReads=0;
  t.mock.method(fs,'readSync',function(fd,...args){
    const count=originalRead.call(fs,fd,...args),stat=fs.fstatSync(fd);
    if(count>0&&stat.dev===protectedIdentity.dev&&stat.ino===protectedIdentity.ino)targetReads++;
    if(count===0&&stat.dev===identity.dev&&stat.ino===identity.ino&&++sourceReads===1){fs.unlinkSync(file);fs.symlinkSync(target,file);}
    return count;
  });
  const out=[],err=[];
  const status=runCli(['--source',file,'--symbol','entry','--json'],{out:s=>out.push(s),err:s=>err.push(s)});
  assert.equal(status,1);assert.deepEqual(out,[]);assert.equal(sourceReads,1);assert.equal(targetReads,0);
  assert.match(err.join('\n'),/invalid_file/);
  assert.doesNotMatch(err.join('\n'),/PRIVATE_|readHint|sourceSha256|\/tmp\//);
  assert.equal(fs.lstatSync(file).isSymbolicLink(),true);
  assert.equal(fs.readFileSync(target,'utf8'),protectedSource);
}));
