'use strict';
const {test} = require('node:test');
const assert = require('node:assert/strict');
const vm = require('node:vm');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const {spawnSync} = require('node:child_process');
const {tokens, simplify, validateIntent, intentDigest, checkPlan, brief} = require('../index.cjs');
const intent = require('../examples/intent.json');
const good = require('../examples/plan-good.json');
const bad = require('../examples/plan-bad.json');

const original = fs.readFileSync(path.join(__dirname,'../examples/boolean-before.js'),'utf8');
function functions(source) { return vm.runInNewContext(source+'; ({visible,hidden})'); }

for (const [name,value] of [
  ['false',false],['true',true],['zero',0],['one',1],['negative',-1],['NaN',NaN],['null',null],['undefined',undefined],
  ['empty string',''],['text','yes'],['object',{}],['array',[]],['function',()=>{}],['symbol',Symbol('value')],['zero BigInt',0n],['BigInt',1n],
]) {
  test(`boolean behavior preserved: ${name}`, () => {
    const result = simplify(original);
    assert.equal(result.edits.length,2);
    const before=functions(original), after=functions(result.code);
    assert.equal(after.visible(value),before.visible(value));
    assert.equal(after.hidden(value),before.hidden(value));
  });
}

test('side effects run once and exceptions preserve identity', () => {
  const source='function run(read) { if (read()) { return true; } else { return false; } }';
  const before=vm.runInNewContext(source+'; run'),after=vm.runInNewContext(simplify(source).code+'; run');
  for (const fn of [before,after]) {
    let count=0;assert.equal(fn(()=>{count++;return [];}),true);assert.equal(count,1);
    const error=new Error('fixture');assert.throws(()=>fn(()=>{throw error;}),value=>value===error);
    assert.equal(fn(()=>({valueOf(){throw Error('Must not coerce object');}})),true);
  }
});

test('await behavior is preserved', async () => {
  const source='async function run(read) { if (await read()) { return true; } else { return false; } }';
  const candidate=simplify(source);assert.equal(candidate.edits.length,1);
  for (const code of [source,candidate.code]) {
    const run=vm.runInNewContext(code+'; run');let calls=0;
    assert.equal(await run(async()=>{calls++;return '';}),false);assert.equal(calls,1);
  }
});

test('yield behavior is preserved', () => {
  const source="function* run() { if (yield 'ready') { return false; } else { return true; } }";
  const candidate=simplify(source);assert.equal(candidate.edits.length,1);
  for(const code of [source,candidate.code]) {
    const run=vm.runInNewContext(code+'; run');const iterator=run();
    assert.equal(iterator.next().value,'ready');assert.equal(iterator.next(0).value,true);
  }
});

for(const source of [
  'function f(x){if(x){ log(); return true; }else{return false;}}',
  'function f(x){if(x){return true;}else{return true;}}',
  'function f(x){if(x){return x;}else{return false;}}',
  'function f(x){if(x){return true;} }',
  'function f(x){if(x){/* important comment */return true;}else{return false;}}',
]) {
  test('unsupported or commented branch is left unchanged: '+source, () => {
    const result=simplify(source);assert.equal(result.code,source);assert.equal(result.metrics.tokensSaved,0);
  });
}

test('leading comments and CRLF outside the patch are preserved', () => {
  const source='// keep this\r\nfunction f(x) {\r\n  if (x) { return true; } else { return false; }\r\n}\r\n';
  const result=simplify(source);assert.equal(result.edits.length,1);
  assert.ok(result.code.startsWith('// keep this\r\n'));assert.ok(result.code.endsWith('}\r\n'));
});

test('TypeScript syntax stays valid and no type names are removed', () => {
  const source='export function visible(value: unknown): boolean { if (value) { return true; } else { return false; } }';
  const result=simplify(source,'sample.ts');assert.equal(result.edits.length,1);
  assert.ok(result.code.includes('value: unknown'));assert.ok(result.code.includes('export function'));
});

test('invalid syntax and declaration files are rejected', () => {
  assert.throws(()=>simplify('function {'),/syntax/);
  assert.throws(()=>simplify('const x: string = "x";','sample.js'),/syntax/);
  assert.throws(()=>simplify('declare const x: string;','sample.d.ts'),/implementation/);
});

for(const encoding of ['o200k_base','cl100k_base']) {
  test(`measured candidate is smaller under ${encoding}`, () => {
    const result=simplify(original,'sample.js',encoding);
    assert.ok(result.metrics.afterBytes<result.metrics.beforeBytes);
    assert.ok(result.metrics.afterTokens<result.metrics.beforeTokens);
    assert.equal(result.metrics.afterTokens,tokens(result.code,encoding));
    assert.equal(result.metrics.tokensSaved,result.metrics.beforeTokens-result.metrics.afterTokens);
    assert.deepEqual(simplify(result.code,'sample.js',encoding).edits,[]);
  });
}

test('token counts use the selected tokenizer, including literal special-token text', () => {
  assert.equal(tokens('hello world'),2);assert.ok(tokens('<|endoftext|>')>1);
  assert.equal(tokens(''),0);assert.throws(()=>tokens('hello','unknown'),/Unsupported/);
});

test('no eligible code returns the exact input', () => {
  const source='const answer = 42;\n';const result=simplify(source);
  assert.equal(result.code,source);assert.equal(result.metrics.applied,0);assert.equal(result.metrics.tokensSaved,0);
});

test('complete scoped plan is accepted; changing the temple is rejected', () => {
  assert.equal(checkPlan(intent,good).ok,true);
  const result=checkPlan(intent,bad);assert.equal(result.ok,false);
  assert.ok(result.failures.some(x=>x.includes('src/temple.js')));
  assert.ok(result.failures.some(x=>x.includes('keep_temple')));
  assert.ok(result.failures.some(x=>x.includes('nav_spacing')));
});

test('missing and invented acknowledgements or acceptance checks fail', () => {
  assert.equal(checkPlan(intent,{...good,acknowledgedConstraints:[]}).ok,false);
  assert.equal(checkPlan(intent,{...good,checks:[]}).ok,false);
  assert.equal(checkPlan(intent,{...good,checks:[...good.checks,'invented']}).ok,false);
  assert.equal(checkPlan(intent,{...good,acknowledgedConstraints:[...good.acknowledgedConstraints,'invented']}).ok,false);
});

test('material unresolved questions block a passing plan', () => {
  const result=checkPlan({...intent,questions:['How transparent should the navigation be?']},good);
  assert.equal(result.ok,false);assert.ok(result.failures.some(x=>x.includes('Unresolved question')));
});

test('a changed request invalidates a stale plan', () => {
  assert.equal(checkPlan({...intent,request:intent.request+' 同时改变颜色。'},good).ok,false);
  assert.equal(checkPlan(intent,{...good,intentDigest:'stale'}).ok,false);
});

test('digest is independent of JSON property order', () => {
  const reordered={questions:intent.questions,acceptance:intent.acceptance,constraints:intent.constraints,
    allowedFiles:intent.allowedFiles,goal:intent.goal,request:intent.request};
  assert.equal(intentDigest(reordered),intentDigest(intent));
});

for(const file of ['../private.js','/private.js','src/../private.js','C:\\private.js','src\\navigation.css','src/*','C:private.js','src//navigation.css']) {
  test('noncanonical or ambiguous plan path rejected: '+file, () => {
    assert.throws(()=>checkPlan(intent,{...good,files:[file]}),/schema/);
    assert.throws(()=>validateIntent({...intent,allowedFiles:[file]}),/Invalid intent/);
  });
}

test('malformed schemas and duplicate IDs are rejected', () => {
  for(const value of [null,{}, {...intent,request:''},{...intent,constraints:[...intent.constraints,intent.constraints[0]]}]) assert.throws(()=>validateIntent(value));
  assert.throws(()=>checkPlan(intent,{...good,checks:['nav_spacing','nav_spacing']}),/schema/);
});

test('undeclared intent and plan fields are rejected instead of silently ignored', () => {
  for(const value of [
    {...intent,notes:'This requirement must not disappear from the digest.'},
    {...intent,constraints:intent.constraints.map((item,index)=>index?item:{...item,priority:'must'})},
    {...intent,acceptance:intent.acceptance.map((item,index)=>index?item:{...item,evidence:'required'})},
  ]) assert.throws(()=>validateIntent(value),/schema/);
  for(const value of [
    {...good,command:'npm test'},
    {...good,permissions:['write']},
  ]) assert.throws(()=>checkPlan(intent,value),/schema/);
});

test('brief retains the exact request, every constraint and every acceptance criterion', () => {
  const value=brief(intent);assert.ok(value.includes(intent.request));
  for(const entry of [...intent.constraints,...intent.acceptance])assert.ok(value.includes(entry.text));
  assert.ok(value.includes('src/navigation.css'));
});

test('CLI creates candidates without modifying source and uses correct check exits', () => {
  const root=fs.mkdtempSync(path.join(os.tmpdir(),'agent-brief-'));
  try {
    const file=path.join(root,'input.js');fs.writeFileSync(file,original);
    const cli=path.resolve(__dirname,'../index.cjs');
    const run=args=>spawnSync(process.execPath,[cli,...args],{encoding:'utf8',timeout:30000});
    const compact=run(['compact',file]);assert.equal(compact.status,0,compact.stderr);
    assert.equal(compact.stdout,simplify(original).code);assert.equal(fs.readFileSync(file,'utf8'),original);
    const measure=run(['measure',file]);assert.equal(measure.status,0);assert.ok(JSON.parse(measure.stdout).tokensSaved>0);
    const examples=path.resolve(__dirname,'../examples');
    assert.equal(run(['check',path.join(examples,'intent.json'),path.join(examples,'plan-good.json')]).status,0);
    assert.equal(run(['check',path.join(examples,'intent.json'),path.join(examples,'plan-bad.json')]).status,1);
    assert.equal(run([]).status,2);
  } finally {fs.rmSync(root,{recursive:true,force:true});}
});
