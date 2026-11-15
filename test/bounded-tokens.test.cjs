'use strict';
const {test}=require('node:test'),assert=require('node:assert/strict');
const {spawnSync}=require('node:child_process');
const path=require('node:path');
const {tokens}=require('../index.cjs');
const {countPair}=require('../bounded-tokens.cjs');
test('bounded child matches the existing tokenizer, including literal special-token strings',()=>{
  const texts=['用户 source <|endoftext|>\n'.repeat(50),'const answer = 42;\n'.repeat(100)];
  assert.deepEqual(countPair(...texts),texts.map(s=>tokens(s)));
});
test('oversized or non-text inputs return unknown instead of attempting a measurement',()=>{
  for(const args of [[null,'x'],['x',{}],['a'.repeat(768*1024+1),'x']])
    assert.equal(countPair(...args),null);
});
test('worker rejects malformed requests without exposing private input or encoder errors',()=>{
  for(const input of ['PRIVATE_CUSTOMER_SOURCE',JSON.stringify(['only one string']),JSON.stringify([{},'x'])]){
    const r=spawnSync(process.execPath,[path.resolve(__dirname,'../bounded-tokens.cjs')],
      {input,encoding:'utf8',timeout:5000});
    assert.equal(r.status,1);assert.equal(r.stdout,'');assert.equal(r.stderr,'');
  }
});
