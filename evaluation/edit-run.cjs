'use strict';
const fs=require('node:fs'),os=require('node:os'),path=require('node:path'),{spawnSync}=require('node:child_process');
const {editCases,manifestDigest}=require('./edit-cases.cjs');
const {materializeCase,gradeEdits,inspectTree}=require('./edit-grade.cjs');
function parseTerminal(r){
  const bad=(reason,state='invalid')=>({state,reason,elapsedMs:null,reportedModel:null});
  if(!r||r.error||r.status!==0||r.signal)return bad(/Workspace Trust Required/i.test(r?.stderr??'')?'workspace_trust_required':'cli_failed','blocked');
  let es;try{es=r.stdout.trim().split(/\r?\n/).map(JSON.parse);}catch{return bad('invalid_jsonl');}
  if(!es.length||es.some(e=>!e||typeof e!=='object'||Array.isArray(e)||typeof e.type!=='string'))return bad('invalid_event');
  const init=es.filter(e=>e.type==='system'&&e.subtype==='init');const result=es.filter(e=>e.type==='result');
  if(init.length!==1||result.length!==1||es.at(-1)!==result[0]||es.some(e=>e.type==='request'||e.type==='error'))return bad('incomplete_or_interactive');
  const t=result[0];if(t.subtype!=='success'||t.is_error!==false||!Number.isSafeInteger(t.duration_ms)||t.duration_ms<0)return bad('failed_terminal');
  // After-the-fact audit only; it cannot undo an executed unsafe tool call.
  const tool=es.filter(e=>e.type==='tool_call');
  const forbidden=tool.some(e=>{const v=e.tool_call??{};return /shell|terminal|command|execute|mcp|web|network|browser|subagent|task/i.test([v.name,v.type,...Object.keys(v)].join(' '));});
  return forbidden?bad('forbidden_tool_reported'):{state:'completed',reason:null,elapsedMs:t.duration_ms,reportedModel:init[0].model??null,toolEvents:tool.length};
}
function evaluateEdits(items,invoke){
  if(!Array.isArray(items)||!items.length||typeof invoke!=='function')throw Error('Nonempty case set and invoker required');
  const runs=[];let stopped=false;
  for(const [i,item] of items.entries())for(const arm of (i%2?['prepared','raw']:['raw','prepared'])){
    const base={case:item.id,kind:item.kind,arm,localInputTextTokens:item.localInputTextTokens[arm],providerInputTokens:null,providerCachedInputTokens:null,providerOutputTokens:null,providerReasoningTokens:null,providerBilledCost:null};
    if(stopped){runs.push({...base,state:'not_run',passed:false,acceptancePassed:null,scopeViolations:[],failureReason:'previous_block'});continue;}
    let outcome;try{outcome=invoke(item,arm);}catch{outcome={execution:{status:-1},grade:null};}
    const completion=parseTerminal(outcome.execution);
    const grade=outcome.grade??{acceptancePassed:false,scopeViolations:[],wrongAllowed:[]};
    const passed=completion.state==='completed'&&grade.acceptancePassed;
    const failureReason=completion.state!=='completed'?completion.reason:passed?null:grade.scopeViolations.length?'scope_violation':'acceptance_failed';
    runs.push({...base,state:completion.state,passed,acceptancePassed:grade.acceptancePassed,scopeViolations:grade.scopeViolations,
      wrongAllowed:grade.wrongAllowed??[],elapsedMs:completion.elapsedMs,reportedModel:completion.reportedModel??null,
      failureReason});
    if(completion.state!=='completed'||grade.scopeViolations.length)stopped=true;
  }
  return {state:stopped?'blocked':runs.every(r=>r.state==='completed')?'completed':'invalid',planned:runs.length,attempted:runs.filter(r=>r.state!=='not_run').length,
    modelCompleted:runs.filter(r=>r.state==='completed').length,passed:runs.filter(r=>r.passed).length,comparisonComplete:runs.every(r=>r.state==='completed'),runs};
}
function parseArgs(args){
  if(!args.length||args.length===1&&args[0]==='--dry-run')return {live:false};
  if(args[0]!=='--live'||args.length%2!==1)throw Error('Usage: --dry-run or --live --model ID --out NEW_TEMP_DIR [--limit 1..30] [--confirm-batch YES]');
  const vals={};for(let i=1;i<args.length;i+=2){if(!['--model','--out','--limit','--confirm-batch'].includes(args[i])||!args[i+1]||Object.hasOwn(vals,args[i]))throw Error('Invalid live options');vals[args[i]]=args[i+1];}
  const limit=vals['--limit']===undefined?1:Number(vals['--limit']);
  if(!Number.isInteger(limit)||limit<1||limit>30||!vals['--model']||!vals['--out'])throw Error('Model, output and limit 1..30 required');
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
    return {execution:result,grade:gradeEdits(job,item,arm)};
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
