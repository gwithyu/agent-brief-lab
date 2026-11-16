'use strict';
const {test}=require('node:test'),assert=require('node:assert/strict');
const fs=require('node:fs'),os=require('node:os'),path=require('node:path'),{createHash}=require('node:crypto');
const {spawnSync}=require('node:child_process');
const {analyze,outline,parseArgs}=require('../outline.cjs');
const cli=path.resolve(__dirname,'../index.cjs');
function fixture(fn){const dir=fs.mkdtempSync(path.join(os.tmpdir(),'brief-outline-'));
  try{return fn(dir)}finally{fs.rmSync(dir,{recursive:true,force:true});}}
test('outline locates actual one-based declaration ranges without source strings or function bodies',()=>{
  const source=['// PRIVATE_COMMENT','import value from "PRIVATE_MODULE";',
    'export function hello(v) {','  return "PRIVATE_BODY";','}',
    'export const arrow = (v) => v + 1;',
    'class Client {','  constructor() {}','  run() { return "PRIVATE_METHOD"; }',
    '  get value() { return 1; }','  set value(v) {}','  field = () => 2;',
    '  ["PRIVATE_COMPUTED"]() {}','  #hidden() {}','}',
    'const PRIVATE_BINDING = "PRIVATE_LITERAL";','globalThis.PRIVATE_EXECUTION();',''].join('\n');
  const r=analyze(source,'sample.ts');
  assert.equal(r.lineCount,18);assert.equal(r.totalSymbols,11);assert.equal(r.unlistedTopLevelStatements,2);
  assert.equal(r.completeContext,false);assert.equal(r.modelCalls,0);assert.equal(r.fileWrites,0);
  assert.deepEqual(r.symbols.slice(0,4).map(s=>[s.kind,s.name,s.startLine,s.endLine]),[
    ['import',null,2,2],['function','hello',3,5],['function','arrow',6,6],['class','Client',7,15]
  ]);
  assert.deepEqual(r.symbols.slice(4).map(s=>[s.kind,s.name,s.container]),[
    ['constructor','constructor','Client'],['method','run','Client'],['getter','value','Client'],
    ['setter','value','Client'],['method','field','Client'],['method',null,'Client'],['method','#hidden','Client']
  ]);
  assert.equal(r.sourceSha256,createHash('sha256').update(source).digest('hex'));
  assert.doesNotMatch(JSON.stringify(r),/PRIVATE_/);
});
test('types, enums and namespaces are locators; nested functions do not pretend to be top-level',()=>{
  const source='interface Shape {x:number}\ntype ID = string;\nenum Mode {A,B}\nnamespace N {export function nested() {}}\nfunction outer() { function inner() {} }\n';
  const r=analyze(source,'types.ts');
  assert.deepEqual(r.symbols.map(s=>[s.kind,s.name]),[
    ['interface','Shape'],['type','ID'],['enum','Mode'],['namespace','N'],['function','outer']
  ]);
  assert.equal(r.completeContext,false);
});
test('static CommonJS require locations are visible without exposing module names',()=>{
  const source='const fs=require("PRIVATE_MODULE");\nrequire("PRIVATE_SIDE_EFFECT");\nconst other=require(dynamicName);\n';
  const r=analyze(source,'common.cjs');
  assert.deepEqual(r.symbols.map(s=>[s.kind,s.name,s.startLine,s.endLine]),[
    ['import',null,1,1],['import',null,2,2]
  ]);
  assert.equal(r.unlistedTopLevelStatements,1);assert.doesNotMatch(JSON.stringify(r),/PRIVATE_|dynamicName/);
});
test('top-level object APIs locate direct callables without printing values or scanning nested objects',()=>{
  const source=['const api = {','  run(v) { return "PRIVATE_BODY"; },','  reset: () => true,',
    '  legacy: function () { return false; },','  get value() { return 1; },','  set value(v) {},',
    '  ["PRIVATE_KEY"]() {},','  valueOnly: "PRIVATE_VALUE",','  nested: { hidden() {} },',
    '  reference: existing,','  wrapped: decorate(() => true)', '};'].join('\n');
  const r=analyze(source,'object.js');
  assert.deepEqual(r.symbols.map(s=>[s.kind,s.name,s.container,s.startLine,s.endLine]),[
    ['method','run','api',2,2],['method','reset','api',3,3],['method','legacy','api',4,4],
    ['getter','value','api',5,5],['setter','value','api',6,6],['method',null,'api',7,7]
  ]);
  assert.equal(r.unlistedTopLevelStatements,0);assert.equal(r.completeContext,false);
  assert.doesNotMatch(JSON.stringify(r),/PRIVATE_|hidden|existing|decorate/);
});
test('CommonJS object exports and direct function assignments retain their original binding ranges',()=>{
  const source=['module.exports = {','  run(v) { return v; },','  reset: () => false','};',
    'exports.named = function internal(v) {','  return v;','};',
    'module.exports.other = (v) => v;',
    'module.exports = function defaultEntry() {return 1;};',
    'module.exports = () => 2;'].join('\n');
  const r=analyze(source,'exports.cjs');
  assert.deepEqual(r.symbols.map(s=>[s.kind,s.name,s.container,s.startLine,s.endLine]),[
    ['method','run','module.exports',2,2],['method','reset','module.exports',3,3],
    ['function','named','exports',5,7],['function','other','module.exports',8,8],
    ['function','exports','module',9,9],['function','exports','module',10,10]
  ]);
  assert.equal(r.completeContext,false);
});
test('object shorthand references, wrappers, nested objects and computed export assignments remain unlisted',()=>{
  const source=['const referenced = {run: existing};','const wrapped = decorate({run() {}});',
    'const nested = {inner: {hidden() {}}};','other.run = function () {};',
    'module.exports += function () {};','exports["PRIVATE_KEY"] = () => true;',
    'exports.wrapped = decorate(() => true);'].join('\n');
  const r=analyze(source,'unresolved.cjs');
  assert.equal(r.totalSymbols,0);assert.equal(r.unlistedTopLevelStatements,7);
  assert.equal(r.completeContext,false);assert.doesNotMatch(JSON.stringify(r),/PRIVATE_KEY/);
});
test('object method truncation and omitted long containers preserve metadata size limits',()=>{
  const source='const '+'x'.repeat(200)+' = {\n'+
    Array.from({length:520},(_,i)=>`m${i}() {return ${i};}`).join(',\n')+'\n};';
  const r=analyze(source,'many-object.js');
  assert.equal(r.totalSymbols,520);assert.equal(r.symbols.length,500);assert.equal(r.truncated,true);
  assert.ok(r.symbols.every(s=>s.container===null));assert.equal(r.symbols.at(-1).name,'m499');
  assert.doesNotMatch(JSON.stringify(r),/xxxxx/);
});
test('exported object method lookup feeds the fingerprint reader without executing the module',()=>fixture(dir=>{
  const marker=path.join(dir,'must-not-execute'),file=path.join(dir,'exported.cjs');
  const source=[`require('node:fs').writeFileSync(${JSON.stringify(marker)}, 'PRIVATE_EFFECT');`,
    'module.exports = {','  run(value) {','    return "PRIVATE_BODY" + value;','  },',
    '  other() { return 2; }','};',''].join('\n');
  fs.writeFileSync(file,source);
  const r=spawnSync(process.execPath,[cli,'outline','--source',file,'--json'],{encoding:'utf8',timeout:10000});
  assert.equal(r.status,0,r.stderr);const map=JSON.parse(r.stdout);
  const method=map.symbols.find(s=>s.name==='run'&&s.container==='module.exports');assert.ok(method);
  assert.doesNotMatch(r.stdout,/PRIVATE_|must-not-execute/);
  const read=spawnSync(process.execPath,[cli,'read','--source',file,'--lines',`${method.startLine}:${method.endLine}`,
    '--sha256',map.sourceSha256,'--json'],{encoding:'utf8',timeout:10000});
  assert.equal(read.status,0,read.stderr);
  assert.equal(JSON.parse(read.stdout).text,'  run(value) {\n    return "PRIVATE_BODY" + value;\n  },\n');
  assert.doesNotMatch(read.stdout,/PRIVATE_EFFECT|must-not-execute|other\(\)/);
  assert.equal(fs.existsSync(marker),false);assert.equal(fs.readFileSync(file,'utf8'),source);
}));
test('anonymous defaults, Unicode, CRLF and overloads retain distinct source locations',()=>{
  const source='export default function () {\r\n return 1;\r\n}\r\nfunction 数据(x:string):string;\r\nfunction 数据(x:any){return x;}\r\n';
  const r=analyze(source,'unicode.ts');
  assert.deepEqual(r.symbols.map(s=>[s.name,s.startLine,s.endLine]),[[null,1,3],['数据',4,4],['数据',5,5]]);
});
test('large symbol sets explicitly truncate without claiming a complete context',()=>{
  const source=Array.from({length:520},(_,i)=>`function fn${i}() { return ${i}; }`).join('\n');
  const r=analyze(source,'many.js');
  assert.equal(r.totalSymbols,520);assert.equal(r.symbols.length,500);assert.equal(r.truncated,true);
  assert.equal(r.completeContext,false);assert.equal(r.symbols.at(-1).name,'fn499');
});
test('long identifiers are omitted instead of turning metadata into a huge source payload',()=>{
  const r=analyze('function '+'x'.repeat(500)+'() {return "PRIVATE_BODY";}','long.js');
  assert.equal(r.symbols[0].name,null);assert.doesNotMatch(JSON.stringify(r),/xxxx|PRIVATE_BODY/);
});
test('CLI only reads the selected file and never executes its top-level code',()=>fixture(dir=>{
  const marker=path.join(dir,'must-not-exist'),file=path.join(dir,'sample.cjs');
  const source=`require('node:fs').writeFileSync(${JSON.stringify(marker)}, 'PRIVATE_SIDE_EFFECT');\nfunction entry() {return 'PRIVATE_BODY';}\n`;
  fs.writeFileSync(file,source);const before=fs.readdirSync(dir);
  const r=spawnSync(process.execPath,[cli,'outline','--source',file,'--json'],
    {cwd:os.tmpdir(),encoding:'utf8',timeout:10000});
  assert.equal(r.status,0,r.stderr);const d=JSON.parse(r.stdout);
  assert.equal(d.status,'ready');assert.equal(d.symbols[0].name,'entry');
  assert.equal(d.sourceBytes,Buffer.byteLength(source));assert.equal(fs.readFileSync(file,'utf8'),source);
  assert.equal(fs.existsSync(marker),false);assert.deepEqual(fs.readdirSync(dir),before);
  assert.doesNotMatch(r.stdout,/PRIVATE_|must-not-exist|\/tmp\//);
  const human=spawnSync(process.execPath,[cli,'outline','--source',file],{encoding:'utf8',timeout:10000});
  assert.equal(human.status,0,human.stderr);assert.match(human.stdout,/L2-L2 function "entry"/);
  assert.match(human.stdout,/Read original imports, dependencies and surrounding scope/);
  assert.doesNotMatch(human.stdout,/PRIVATE_/);
}));
test('large literal bodies can be outlined without tokenizing or printing those literals',()=>fixture(dir=>{
  const file=path.join(dir,'large.js');
  fs.writeFileSync(file,'function large() { return "'+'x'.repeat(100000)+'"; }\n');
  const r=outline(file);assert.equal(r.status,'ready');assert.equal(r.symbols.length,1);
  assert.equal(r.symbols[0].name,'large');assert.ok(JSON.stringify(r).length<1000);
}));
test('BOM-prefixed UTF-8 keeps a fingerprint of actual file bytes and correct source lines',()=>fixture(dir=>{
  const file=path.join(dir,'bom.js');
  const bytes=Buffer.concat([Buffer.from([0xef,0xbb,0xbf]),Buffer.from('function entry() {\n return 1;\n}\n')]);
  fs.writeFileSync(file,bytes);
  const r=outline(file);
  assert.equal(r.status,'ready');assert.equal(r.sourceBytes,bytes.length);
  assert.equal(r.sourceSha256,createHash('sha256').update(bytes).digest('hex'));
  assert.equal(r.symbols[0].startLine,1);assert.equal(r.symbols[0].endLine,3);
  assert.deepEqual(fs.readFileSync(file),bytes);
}));
test('syntax errors, invalid files and unsupported input refuse without leaking source or paths',()=>fixture(dir=>{
  const file=path.join(dir,'PRIVATE_FILE.js');fs.writeFileSync(file,'function broken( {');
  const r=spawnSync(process.execPath,[cli,'outline','--source',file,'--json'],{encoding:'utf8',timeout:10000});
  assert.equal(r.status,1);assert.match(r.stderr,/invalid_source/);assert.equal(r.stdout,'');
  assert.doesNotMatch(r.stderr,/PRIVATE_FILE|function broken|\/tmp\//);
  assert.throws(()=>analyze('function f() {}','types.d.ts'),/unsupported_source/);
  assert.throws(()=>analyze('x'.repeat(1024*1024+1),'large.js'),/invalid_file/);
  const valid=path.join(dir,'valid.js');fs.writeFileSync(valid,'function f() {}');
  const link=path.join(dir,'link.js');fs.symlinkSync(valid,link);
  assert.throws(()=>outline(link),/invalid_file/);assert.throws(()=>outline(dir),/invalid_file/);
  const invalid=path.join(dir,'utf.js');fs.writeFileSync(invalid,Buffer.from([0xff]));
  assert.throws(()=>outline(invalid));
}));
test('CLI arguments and help keep the internal worker out of the public command',()=>{
  for(const args of [[],['--source'],['--source','x','--json','--json'],['--history','x'],
    ['--internal-outline-worker'],['--source','--json'],['--source','x','--debug']])
    assert.throws(()=>parseArgs(args),/invalid_arguments/);
  const r=spawnSync(process.execPath,[cli,'outline','--help'],{encoding:'utf8',timeout:5000});
  assert.equal(r.status,0);assert.match(r.stdout,/outline --source/);
  const root=spawnSync(process.execPath,[cli,'--help'],{encoding:'utf8',timeout:5000});
  assert.match(root.stdout,/outline --source FILE/);
});
