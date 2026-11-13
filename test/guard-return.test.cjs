'use strict';
const {test}=require('node:test');
const assert=require('node:assert/strict');
const vm=require('node:vm');
const {simplify}=require('../index.cjs');
const run=code=>vm.runInNewContext(code+'; f');
for(const yes of [true,false]) test(`adjacent guard return preserves truthiness and effects: ${yes}`,()=>{
  const source=`function f(read) { if (read()) { return ${yes}; } return ${!yes}; }`;
  const candidate=simplify(source);assert.equal(candidate.metrics.applied,1);
  for(const value of [false,true,0,1,'',null,undefined,NaN,{},[],0n,1n,Symbol('fixture')]) {
    for(const code of [source,candidate.code]) {
      let calls=0;const result=run(code)(()=>{calls++;return value;});
      assert.equal(result,Boolean(value)===yes);assert.equal(calls,1);
    }
  }
  const error=new Error('original');
  assert.throws(()=>run(candidate.code)(()=>{throw error;}),e=>e===error);
  assert.equal(run(candidate.code)(()=>({valueOf(){throw Error('must not coerce');}})),yes);
  assert.equal(simplify(candidate.code).metrics.applied,0);
});
for(const source of [
  'function f(x){if(x)return true;/* keep */return false;}',
  'function f(x){if(x){/* keep */return true;}return false;}',
  'function f(x){if(x)return true;return true;}',
  'function f(x){if(x)return true;log();return false;}',
  'function f(x){if(x)if(other)return true;return false;}',
  'function f(x){if(x)return true;{return false;}}',
  'function f(x){if(x)return true;return x;}',
  'function f(x){if(x)return\ntrue;return false;}',
]) test('unsafe or nonadjacent guard is unchanged: '+source,()=>assert.equal(simplify(source).code,source));
test('guard stays in its original block and keeps finally behavior',()=>{
  const source='function f(read,done) { try { if(read()) return true; return false; } finally { done(); } }';
  const candidate=simplify(source);assert.equal(candidate.metrics.applied,1);
  for(const code of [source,candidate.code]) {
    const f=run(code),events=[];
    assert.equal(f(()=>{events.push('read');return 0;},()=>events.push('finally')),false);
    assert.deepEqual(events,['read','finally']);
    const error=Error('finally');assert.throws(()=>f(()=>true,()=>{throw error;}),e=>e===error);
  }
});
test('await, yield, TypeScript and multiple independent guards',async()=>{
  const asyncSource='async function f(read){if(await read())return true;return false;}';
  const a=simplify(asyncSource);assert.equal(a.metrics.applied,1);assert.equal(await run(a.code)(async()=>0),false);
  const gen='function* f(){if(yield "ready")return false;return true;}';
  const g=simplify(gen);assert.equal(g.metrics.applied,1);const it=run(g.code)();
  assert.equal(it.next().value,'ready');assert.equal(it.next(0).value,true);
  const ts='export function f(x:unknown):boolean{if(x)return true;return false;}';
  assert.equal(simplify(ts,'sample.ts').metrics.applied,1);
  const multi='function f(x){if(x)return true;return false;} function g(x){if(x)return false;return true;}';
  assert.equal(simplify(multi).metrics.applied,2);
});
