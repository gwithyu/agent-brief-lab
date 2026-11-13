'use strict';
const {spawnSync}=require('node:child_process');
function parseCompletion(result) {
  if(result.error || result.status!==0 || result.signal) return {state:'blocked',passed:false,reason:result.error?.code??'cli_failed'};
  let events;
  try{events=result.stdout.trim().split('\n').filter(Boolean).map(line=>JSON.parse(line));}catch{return {state:'invalid',passed:false,reason:'invalid_jsonl'};}
  if(events.some(e=>!e||typeof e!=='object'||Array.isArray(e)||typeof e.type!=='string'))return {state:'invalid',passed:false,reason:'invalid_event'};
  const itemEvents=events.filter(e=>e.type.startsWith('item.'));
  const invalidItems=itemEvents.some(e=>!e.item||typeof e.item!=='object'||Array.isArray(e.item)||!['agent_message','reasoning'].includes(e.item.type));
  if(invalidItems) return {state:'invalid',passed:false,reason:'unexpected_tool_or_item'};
  if(events.some(e=>['error','turn.failed'].includes(e.type))) return {state:'blocked',passed:false,reason:'failed_turn'};
  const completed=events.filter(e=>e.type==='turn.completed'),answers=events.filter(e=>e.type==='item.completed'&&e.item?.type==='agent_message');
  if(completed.length!==1 || answers.length!==1) return {state:'invalid',passed:false,reason:'missing_or_ambiguous_completion'};
  const end=events.indexOf(completed[0]),answerIndex=events.indexOf(answers[0]);
  const threads=events.filter(e=>e.type==='thread.started'),turns=events.filter(e=>e.type==='turn.started');
  if(answerIndex>=end || threads.length>1 || turns.length>1
    || [...threads,...turns].some(e=>events.indexOf(e)>answerIndex)
    || (threads.length && turns.length && events.indexOf(threads[0])>events.indexOf(turns[0]))
    || events.some((e,i)=>i>end && e.type.startsWith('item.'))) return {state:'invalid',passed:false,reason:'invalid_event_order'};
  const usage=completed[0].usage;
  if(!usage || !['input_tokens','output_tokens'].every(k=>Number.isSafeInteger(usage[k])&&usage[k]>=0)
    || ['cached_input_tokens','reasoning_output_tokens'].some(k=>usage[k]!==undefined&&(!Number.isSafeInteger(usage[k])||usage[k]<0))) return {state:'invalid',passed:false,reason:'invalid_or_missing_usage'};
  let answer;
  try{answer=JSON.parse(answers[0].item.text);}catch{return {state:'completed',passed:false,reason:'answer_not_json',usage};}
  return {state:'completed',answer,usage};
}

function invokeCodex(prompt,schemaPath,cwd,model) {
  return spawnSync('codex',['-a','never','exec','--ignore-user-config','--disable','apps','--disable','plugins','--disable','shell_tool','--ephemeral','--sandbox','read-only','--skip-git-repo-check','--model',model,'--json','--output-schema',schemaPath,'-'],
    {cwd,input:prompt,encoding:'utf8',timeout:60000,maxBuffer:2*1024*1024,killSignal:'SIGKILL'});
}
module.exports={parseCompletion,invokeCodex};
