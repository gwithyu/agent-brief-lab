'use strict';
const fs=require('node:fs'),os=require('node:os'),path=require('node:path'),{spawnSync}=require('node:child_process');
const {editCases,manifestDigest}=require('./edit-cases.cjs');
const {materializeCase,gradeEdits,inspectTree}=require('./edit-grade.cjs');
function stableJSON(x) {
  if(Array.isArray(x))return '['+x.map(stableJSON).join(',')+']';
  if(x&&typeof x==='object')return '{'+Object.keys(x).sort().map(k=>JSON.stringify(k)+':'+stableJSON(x[k])).join(',')+'}';
  return JSON.stringify(x);
}
function parseTerminal(r,workspace) {
  const bad=(reason,state='invalid')=>({state,reason,elapsedMs:null,reportedModel:null});
  if(!r||r.error||r.status!==0||r.signal)
    return bad(/Workspace Trust Required/i.test(r?.stderr??'')?'workspace_trust_required':'cli_failed','blocked');
  let es;
  try {
    if(!r.stdout?.trim())throw Error('empty');
    es=r.stdout.trim().split(/\r?\n/).map(s=>JSON.parse(s));
  } catch {return bad('invalid_jsonl');}
  const allowedEvents=new Set(['system','user','assistant','tool_call','result']);
  if(!es.length||es.length>2000||es.some(e=>!e||typeof e!=='object'||Array.isArray(e)||!allowedEvents.has(e.type)))
    return bad('invalid_event');
  const init=es.filter(e=>e.type==='system'&&e.subtype==='init'),results=es.filter(e=>e.type==='result');
  if(init.length!==1||results.length!==1||es[0]!==init[0]||es.at(-1)!==results[0]
    ||es.some(e=>e.type==='system'&&e!==init[0]))return bad('incomplete_or_interactive');
  const t=results[0];
  if(t.subtype!=='success'||t.is_error!==false||!Number.isSafeInteger(t.duration_ms)||t.duration_ms<0)
    return bad('failed_terminal');
  if(typeof init[0].model!=='string'||!init[0].model.trim())return bad('missing_model_evidence');
  if(workspace){
    let expected,reported;
    try {
      expected=fs.realpathSync(workspace);
      if(typeof init[0].cwd!=='string'||!init[0].cwd.trim())return bad('missing_workspace_evidence');
      reported=fs.realpathSync(init[0].cwd);
    }catch{return bad('invalid_workspace_evidence');}
    if(reported!==expected)return bad('workspace_mismatch');
    const sid=init[0].session_id;
    if(typeof sid!=='string'||!sid.trim()
      ||es.some(e=>typeof e.session_id!=='string'||e.session_id!==sid))
      return bad('session_mismatch');
  }
  if(es.some(e=>e.type==='assistant'&&(e.tool_call||/^tool_use/i.test(e.subtype??'')
    ||e.message?.content?.some?.(v=>v.type==='tool_use'))))
    return bad('unaudited_assistant_tool');

  // Post-hoc evidence audit. This cannot prevent or undo an operation.
  const types=new Set(['readToolCall','writeToolCall','editToolCall','strReplaceToolCall']);
  const pending=new Map();
  let seen=0;
  for(const e of es.filter(e=>e.type==='tool_call')){
    const v=e.tool_call;
    if(!v||typeof v!=='object'||Array.isArray(v)||Object.keys(v).length!==1)return bad('unknown_tool');
    const [tool]=Object.keys(v);
    if(!types.has(tool))return bad('forbidden_tool_reported');
    const op=v[tool];
    if(!op||typeof op!=='object'||Array.isArray(op)||!op.args||typeof op.args!=='object'
      ||Array.isArray(op.args))return bad('invalid_tool_event');
    const target=op.args.path??op.args.filePath??op.args.targetPath;
    if(typeof target!=='string'||!target.trim()||target.includes('\0'))return bad('unverifiable_tool_path');
    if(!workspace)return bad('unverified_tool_workspace');
    let root,real;
    try {
      root=fs.realpathSync(workspace);
      real=fs.realpathSync(path.resolve(root,target));
    }catch{return bad('unverifiable_tool_path');}
    const rel=path.relative(root,real);
    if(!rel||rel==='..'||rel.startsWith('..'+path.sep)||path.isAbsolute(rel))
      return bad('out_of_workspace_tool_path');
    if(typeof e.call_id!=='string'||!e.call_id.trim())return bad('invalid_tool_event');
    const evidence={tool,rel,args:stableJSON(op.args)};
    if(e.subtype==='started'){
      if(pending.has(e.call_id))return bad('duplicate_tool_start');
      pending.set(e.call_id,evidence);seen++;
    }else if(e.subtype==='completed'){
      if(!pending.has(e.call_id))return bad('unmatched_tool_completion');
      const original=pending.get(e.call_id);
      if(original.tool!==tool||original.rel!==rel||original.args!==evidence.args)
        return bad('tool_event_mismatch');
      pending.delete(e.call_id);
      if(!op.result||typeof op.result!=='object'||!op.result.success
        ||op.result.error||op.result.failure)return bad('tool_failed_or_unverified');
      if(typeof op.result.success.path==='string'){
        let resolved;
        try{resolved=fs.realpathSync(op.result.success.path);}catch{return bad('unverifiable_tool_result_path');}
        const resultRel=path.relative(root,resolved);
        if(!resultRel||resultRel==='..'||resultRel.startsWith('..'+path.sep)||path.isAbsolute(resultRel))
          return bad('out_of_workspace_tool_result');
      }
    }else return bad('unexpected_tool_event');
  }
  if(pending.size)return bad('unfinished_tool_call');
  return {state:'completed',reason:null,elapsedMs:t.duration_ms,
    reportedModel:init[0].model,toolEvents:seen};
}
function evaluateEdits(items,invoke){
  if(!Array.isArray(items)||!items.length||typeof invoke!=='function')throw Error('Nonempty case set and invoker required');
  const runs=[];let stopped=false;
  for(const [i,item] of items.entries())for(const arm of (i%2?['prepared','raw']:['raw','prepared'])){
    const base={case:item.id,kind:item.kind,arm,localInputTextTokens:item.localInputTextTokens[arm],providerInputTokens:null,providerCachedInputTokens:null,providerOutputTokens:null,providerReasoningTokens:null,providerBilledCost:null};
    if(stopped){runs.push({...base,state:'not_run',passed:false,acceptancePassed:null,scopeViolations:[],failureReason:'previous_block'});continue;}
    let outcome;
    try{outcome=invoke(item,arm);}catch{
      // Never hide a harness exception as an ordinary Cursor CLI startup error.
      // Details might include private paths; keep the public reason code stable.
      outcome={execution:{status:-1},grade:null,harnessError:true};
    }
    const completion=outcome.harnessError
      ?{state:'blocked',reason:'harness_exception',elapsedMs:null,reportedModel:null}
      :parseTerminal(outcome.execution,outcome.workspace);
    const grade=outcome.grade??{acceptancePassed:false,scopeViolations:[],wrongAllowed:[]};
    // Disk changes without corresponding audited tool events are evidence
    // gaps, never validated agent edits. Pure no-change tasks may legitimately
    // have zero tool calls. This applies only to real workspace-backed runs.
    const unauditedEdit=!!outcome.workspace && completion.state==='completed'
      &&grade.observedExpectedEdits>0 &&completion.toolEvents===0;
    const passed=completion.state==='completed'&&grade.acceptancePassed&&!unauditedEdit;
    const failureReason=completion.state!=='completed'?completion.reason
      :grade.scopeViolations.length?'scope_violation'
      :unauditedEdit?'unaudited_edit'
      :passed?null:'acceptance_failed';
    runs.push({...base,state:completion.state,passed,acceptancePassed:grade.acceptancePassed,scopeViolations:grade.scopeViolations,
      wrongAllowed:grade.wrongAllowed??[],elapsedMs:completion.elapsedMs,reportedModel:completion.reportedModel??null,
      auditedToolCalls:completion.toolEvents??null,failureReason});
    if(completion.state!=='completed'||grade.scopeViolations.length)stopped=true;
  }
  return {state:stopped?'blocked':runs.every(r=>r.state==='completed')?'completed':'invalid',planned:runs.length,attempted:runs.filter(r=>r.state!=='not_run').length,
    modelCompleted:runs.filter(r=>r.state==='completed').length,passed:runs.filter(r=>r.passed).length,comparisonComplete:runs.every(r=>r.state==='completed'),runs};
}
function parseArgs(args){
  if(!args.length||args.length===1&&args[0]==='--dry-run')return {live:false};
  if(args[0]!=='--live'||args.length%2!==1)throw Error('Usage: --dry-run or --live --model ID --out NEW_TEMP_DIR --confirm-isolated-env YES [--limit 1..30] [--confirm-batch YES]');
  const vals={};for(let i=1;i<args.length;i+=2){if(!['--model','--out','--limit','--confirm-batch','--confirm-isolated-env'].includes(args[i])||!args[i+1]||Object.hasOwn(vals,args[i]))throw Error('Invalid live options');vals[args[i]]=args[i+1];}
  const limit=vals['--limit']===undefined?1:Number(vals['--limit']);
  if(!Number.isInteger(limit)||limit<1||limit>30||!vals['--model']||!vals['--out'])throw Error('Model, output and limit 1..30 required');
  if(vals['--confirm-isolated-env']!=='YES')throw Error('Live editing requires --confirm-isolated-env YES: only run in a disposable OS account/VM without secrets or personal integrations');
  if(limit>5&&vals['--confirm-batch']!=='YES')throw Error('For >5 tasks specify --confirm-batch YES (uses Cursor quota)');
  return {live:true,model:vals['--model'],out:vals['--out'],limit};
}
function runCli(args=process.argv.slice(2),overrides={}){
  const opts=parseArgs(args),items=editCases(),digest=manifestDigest(items);
  if(!opts.live)return {state:'dry_run',modelRuns:0,distinctTasks:items.length,manifestDigest:digest,cases:items.map(i=>({id:i.id,kind:i.kind,allowed:i.allowed,unresolved:!!i.question,localInputTextTokens:i.localInputTextTokens,rewriteRejected:i.rewriteRejected})),scope:'30 synthetic narrow deterministic code edits. No model calls.'};
  const repository=fs.realpathSync(path.resolve(__dirname,'..'));
  const output=path.join(fs.realpathSync(path.dirname(path.resolve(opts.out))),path.basename(opts.out));
  const temp=fs.realpathSync(os.tmpdir());const rel=path.relative(temp,output),inside=path.relative(repository,output);
  if(!rel||rel==='..'||rel.startsWith('..'+path.sep)||path.isAbsolute(rel)||!inside||(!inside.startsWith('..'+path.sep)&&inside!=='..'&&!path.isAbsolute(inside)))throw Error('Output must be a new directory in OS temp, outside repository');
  const head=spawnSync('git',['rev-parse','--verify','HEAD'],{cwd:repository,encoding:'utf8'});
  const status=()=>spawnSync('git',['status','--porcelain','--untracked-files=normal'],{cwd:repository,encoding:'utf8'});
  const before=status();if(head.status!==0||before.status!==0||before.stdout.trim())throw Error('Clean Git checkout required');
  const agent=spawnSync('agent',['--version'],{encoding:'utf8',timeout:10000});
  const auth=spawnSync('agent',['status'],{encoding:'utf8',timeout:10000});
  if(agent.status!==0||auth.status!==0||/not (authenticated|logged in)|please log in/i.test(auth.stdout+'\n'+auth.stderr))throw Error('Cursor CLI must be locally authenticated');
  fs.mkdirSync(output,{mode:0o700});for(const name of ['workspaces','receipts'])fs.mkdirSync(path.join(output,name),{mode:0o700});
  let seq=0;
  const report=evaluateEdits(items.slice(0,opts.limit),(item,arm)=>{
    const id=String(seq++).padStart(3,'0')+'-'+item.id+'-'+arm,job=path.join(output,'workspaces',id);
    materializeCase(job,item,arm);
    const before=inspectTree(job),present=new Set(Object.keys({...item.files,'prompt.txt':item.prompts[arm]}));
    if((fs.statSync(job).mode&0o077)!==0||before.size!==present.size||[...before].some(([p,v])=>!present.has(p)||v.type!=='file'))throw Error('Untrusted workspace layout');
    const result=(overrides.invoke??((j,m)=>spawnSync('agent',['--print','--trust','--mode=agent','--sandbox','enabled','--output-format','stream-json','--model',m,item.prompts[arm]],
      {cwd:j,encoding:'utf8',timeout:120000,maxBuffer:4*1024*1024,killSignal:'SIGKILL'})))(job,opts.model);
    const dest=path.join(output,'receipts',id);fs.mkdirSync(dest,{mode:0o700});
    fs.writeFileSync(path.join(dest,'events.jsonl'),result.stdout??'',{mode:0o600});
    fs.writeFileSync(path.join(dest,'stderr.txt'),result.stderr??'',{mode:0o600});
    let grade;
    try{grade=gradeEdits(job,item,arm);}
    catch{
      // File inspection can fail on unreadable entries or concurrent edits.
      // Never convert that into an accepted run or delete the raw receipts.
      grade={acceptancePassed:false,scopeViolations:['grade_unavailable'],wrongAllowed:[]};
    }
    return {execution:result,grade,workspace:job};
  });
  const later=status(),after=spawnSync('git',['rev-parse','--verify','HEAD'],{cwd:repository,encoding:'utf8'});
  const integrity=later.status===0&&!later.stdout.trim()&&after.status===0&&after.stdout.trim()===head.stdout.trim();
  const outputReport={provider:'cursor-cli',modelRequested:opts.model,cliVersion:agent.stdout.trim(),repositoryCommit:head.stdout.trim(),manifestDigest:digest,distinctTasks:opts.limit,...report,
    gitIntegrity:integrity?'PASS':'FAIL',scope:'Synthetic narrow byte-exact code edits, not a production agent benchmark. Provider token usage and costs unknown (null). Cursor tools are NOT OS-level isolation; only run on a disposable VM/account.'};
  if(!integrity){outputReport.state='invalid';outputReport.reason='git_integrity_failure';}
  fs.writeFileSync(path.join(output,'report.json'),JSON.stringify(outputReport,null,2),{mode:0o600});return outputReport;
}
if(require.main===module)try{const r=runCli();console.log(JSON.stringify(r,null,2));if(r.state!=='dry_run'&&(!r.comparisonComplete||r.passed!==r.planned||r.gitIntegrity!=='PASS'))process.exitCode=1;}catch(e){console.error(e.message);process.exitCode=1;}
module.exports={parseTerminal,evaluateEdits,parseArgs,runCli};
