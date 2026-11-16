'use strict';
const {test}=require('node:test'),assert=require('node:assert/strict');
const fs=require('node:fs'),os=require('node:os'),path=require('node:path'),{createHash}=require('node:crypto');
const {spawnSync}=require('node:child_process');
const {readSource,parseArgs}=require('../source-read.cjs');
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
