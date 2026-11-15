'use strict';
const {test}=require('node:test'),assert=require('node:assert/strict');
const {parseCodexUsage}=require('../evaluation/codex-usage.cjs');
const start=[{type:'thread.started',thread_id:'unique-thread'},{type:'turn.started'}];
const complete={type:'turn.completed',usage:{input_tokens:100,cached_input_tokens:20,output_tokens:10}};
const encode=events=>events.map(e=>JSON.stringify(e)).join('\n')+'\n';
test('native usage is copied once; cache is not added and answers are not graded',()=>{
  const e=[...start,{type:'item.completed',item:{id:'msg',type:'agent_message',text:'PRIVATE_CODE'}},complete];
  const parsed=parseCodexUsage(encode(e),0);
  assert.deepEqual(parsed,{terminal:'completed',threadId:'unique-thread',
    inputTokens:100,cachedInputTokens:20,outputTokens:10,usageSource:'provider_export'});
  assert.doesNotMatch(JSON.stringify(parsed),/PRIVATE_CODE/);
});
test('usage-only import allows coding tools without executing or approving them',()=>{
  const e=[...start,{type:'item.completed',item:{id:'cmd',type:'command_execution',command:'DO_NOT_RUN'}},complete];
  assert.equal(parseCodexUsage(encode(e),0).inputTokens,100);
});
test('failed and truncated turns never invent usage or task quality',()=>{
  for(const e of [[...start,{type:'turn.failed',error:{message:'private error'}}],start]){
    const p=parseCodexUsage(encode(e),1);
    assert.equal(p.terminal,'blocked');assert.equal(p.inputTokens,null);
    assert.equal(p.usageSource,'unknown');
  }
  assert.throws(()=>parseCodexUsage(encode(start),0),/incomplete_codex_trace/);
});
test('optional native usage stays unknown, with fields independent',()=>{
  let p=parseCodexUsage(encode([...start,{type:'turn.completed'}]),0);
  assert.equal(p.usageSource,'unknown');assert.equal(p.inputTokens,null);
  p=parseCodexUsage(encode([...start,{type:'turn.completed',usage:{input_tokens:3}}]),0);
  assert.equal(p.inputTokens,3);assert.equal(p.outputTokens,null);assert.equal(p.cachedInputTokens,null);
});
test('resumed/multi-turn concatenation or duplicate terminals cannot double-count cumulative usage',()=>{
  const bad=[
    [...start,complete,...start,complete],
    [...start,complete,{type:'turn.started'},complete],
    [...start,complete,complete],
    [start[1],start[0],complete],
    [...start,complete,{type:'item.completed',item:{id:'x',type:'agent_message'}}]
  ];
  for(const e of bad)assert.throws(()=>parseCodexUsage(encode(e),0),/ambiguous_codex_trace/);
});
test('negative, fractional, overflowing and impossible native counts are rejected',()=>{
  for(const usage of [{input_tokens:-1},{input_tokens:.5},{input_tokens:Number.MAX_SAFE_INTEGER+1},
    {input_tokens:1,cached_input_tokens:2},{cached_input_tokens:1},{input_tokens:'1'},[]])
    assert.throws(()=>parseCodexUsage(encode([...start,{type:'turn.completed',usage}]),0),/invalid_codex_usage/);
});
test('nonzero exit or error cannot accompany a successful usage terminal',()=>{
  assert.throws(()=>parseCodexUsage(encode([...start,complete]),1),/inconsistent_codex_exit/);
  assert.throws(()=>parseCodexUsage(encode([...start,{type:'error'},complete]),0),/inconsistent_codex_exit/);
});
test('malformed and unsupported traces fail closed',()=>{
  for(const text of ['', 'bad', 'null',encode([...start,{type:'new.unknown'},complete]),
    encode([...start,{type:'item.completed'},complete])])
    assert.throws(()=>parseCodexUsage(text,0));
  for(const code of [null,-1,256,1.5,'0'])assert.throws(()=>parseCodexUsage(encode([...start,complete]),code));
});
