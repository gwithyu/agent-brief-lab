'use strict';
const {spawnSync}=require('node:child_process');

// The Cursor CLI stream contract is distinct from Codex JSONL. Never infer
// provider usage or cost from the locally counted prompt text or wall clock.
function parseCursorCompletion(result) {
  if(!result || result.error || result.status!==0 || result.signal) {
    return {state:'blocked',reason:result?.error?.code??'cli_failed',answer:null,
      providerInputTokens:null,providerOutputTokens:null,providerBilledCost:null};
  }
  let events;
  try {
    if(typeof result.stdout!=='string'||!result.stdout.trim())throw Error('empty');
    events=result.stdout.trim().split(/\r?\n/).map(line=>JSON.parse(line));
  } catch {
    return {state:'invalid',reason:'invalid_jsonl',answer:null,
      providerInputTokens:null,providerOutputTokens:null,providerBilledCost:null};
  }
  if(events.some(e=>!e||typeof e!=='object'||Array.isArray(e)||typeof e.type!=='string')) {
    return {state:'invalid',reason:'invalid_event',answer:null,
      providerInputTokens:null,providerOutputTokens:null,providerBilledCost:null};
  }
  const system=events.filter(e=>e.type==='system'&&e.subtype==='init');
  const terminals=events.filter(e=>e.type==='result');
  // For these read-only comprehension probes we reject *all* tools, even reads.
  // A JSON-only CLI output could not prove this; stream-json can.
  if(events.some(e=>e.type==='tool_call' || e.type==='error' || e.type==='request'
    || (e.type==='assistant' && e.message?.content?.some?.(c=>c.type==='tool_use')))) {
    return {state:'invalid',reason:'tool_or_interaction_detected',answer:null,
      providerInputTokens:null,providerOutputTokens:null,providerBilledCost:null};
  }
  if(system.length!==1||terminals.length!==1||events[events.length-1]!==terminals[0]) {
    return {state:'invalid',reason:'missing_or_ambiguous_terminal',answer:null,
      providerInputTokens:null,providerOutputTokens:null,providerBilledCost:null};
  }
  const terminal=terminals[0];
  if(terminal.subtype!=='success'||terminal.is_error!==false||typeof terminal.result!=='string'
    ||!Number.isSafeInteger(terminal.duration_ms)||terminal.duration_ms<0) {
    return {state:'invalid',reason:'invalid_terminal',answer:null,
      providerInputTokens:null,providerOutputTokens:null,providerBilledCost:null};
  }
  const base={state:'completed',reason:null,elapsedMs:terminal.duration_ms,
    reportedModel:typeof system[0].model==='string'?system[0].model:null,
    providerInputTokens:null,providerOutputTokens:null,providerBilledCost:null};
  try {
    const answer=JSON.parse(terminal.result);
    if(!answer||typeof answer!=='object'||Array.isArray(answer))throw Error('not object');
    return {...base,answer};
  } catch {
    return {...base,answer:null,reason:'answer_not_json_object'};
  }
}
function invokeCursor(prompt,cwd,model,{command='agent',timeoutMs=120000}={}) {
  if(typeof prompt!=='string'||!prompt.trim()||typeof cwd!=='string'||!cwd
    ||typeof model!=='string'||!model.trim()||model.includes('\0'))throw Error('Prompt, cwd and explicit model are required');
  // Don't use --force or --resume. Ask mode alone isn't isolation: sandbox is
  // explicitly enabled, and callers must supply an empty per-run directory.
  return spawnSync(command,['--print','--mode=ask','--sandbox','enabled',
    '--output-format','stream-json','--model',model,prompt],
    {cwd,encoding:'utf8',timeout:timeoutMs,maxBuffer:2*1024*1024,killSignal:'SIGKILL'});
}
module.exports={parseCursorCompletion,invokeCursor};
