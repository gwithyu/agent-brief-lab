'use strict';
// Offline import of one fresh exec --json trace; never runs Codex or prices tokens.
const object=o=>o!==null&&typeof o==='object'&&!Array.isArray(o);
function parseCodexUsage(text,exitCode){
  if(typeof text!=='string'||!text.trim()||!Number.isSafeInteger(exitCode)||exitCode<0||exitCode>255)
    throw Error('invalid_codex_trace');
  let events;
  try{events=text.trim().split(/\r?\n/).map(s=>JSON.parse(s));}
  catch{throw Error('invalid_codex_trace');}
  const allowed=new Set(['thread.started','turn.started','turn.completed','turn.failed',
    'item.started','item.updated','item.completed','error']);
  if(events.length>10000||events.some(e=>!object(e)||!allowed.has(e.type)))
    throw Error('invalid_codex_trace');
  const threads=events.filter(e=>e.type==='thread.started');
  const starts=events.filter(e=>e.type==='turn.started');
  const ends=events.filter(e=>['turn.completed','turn.failed'].includes(e.type));
  if(threads.length!==1||events[0]!==threads[0]
    ||typeof threads[0].thread_id!=='string'||!threads[0].thread_id.trim()
    ||threads[0].thread_id.length>200||starts.length!==1||events[1]!==starts[0]
    ||ends.length>1||(ends.length===1&&events.at(-1)!==ends[0])
    ||events.some(e=>e.type.startsWith('item.')&&(!object(e.item)
      ||typeof e.item.id!=='string'||typeof e.item.type!=='string')))
    throw Error('ambiguous_codex_trace');
  const unknown={inputTokens:null,outputTokens:null,cachedInputTokens:null,usageSource:'unknown'};
  const terminal=ends[0];
  if(terminal?.type==='turn.completed'){
    if(exitCode!==0||events.some(e=>e.type==='error'))throw Error('inconsistent_codex_exit');
    const u=terminal.usage;
    if(u===undefined||u===null)return {terminal:'completed',threadId:threads[0].thread_id,...unknown};
    if(!object(u))throw Error('invalid_codex_usage');
    for(const key of ['input_tokens','output_tokens','cached_input_tokens'])
      if(u[key]!==undefined&&(!Number.isSafeInteger(u[key])||u[key]<0))
        throw Error('invalid_codex_usage');
    if(u.cached_input_tokens!==undefined&&(u.input_tokens===undefined||u.cached_input_tokens>u.input_tokens))
      throw Error('invalid_codex_usage');
    const known=['input_tokens','output_tokens','cached_input_tokens'].some(k=>u[k]!==undefined);
    return {terminal:'completed',threadId:threads[0].thread_id,
      inputTokens:u.input_tokens??null,outputTokens:u.output_tokens??null,
      cachedInputTokens:u.cached_input_tokens??null,usageSource:known?'provider_export':'unknown'};
  }
  // An incomplete/failed CLI turn cannot prove model-task quality or total usage.
  if(!terminal&&exitCode===0)throw Error('incomplete_codex_trace');
  return {terminal:'blocked',threadId:threads[0].thread_id,...unknown};
}
module.exports={parseCodexUsage};
