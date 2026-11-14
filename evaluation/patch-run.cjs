'use strict';
const fs=require('node:fs'),os=require('node:os'),path=require('node:path');
const {spawnSync}=require('node:child_process');
const {parseCursorCompletion,invokeCursor}=require('./cursor.cjs');
const {proposalCases,proposalManifestDigest,gradeProposal}=require('./patch-proposals.cjs');

function parseArgs(args){
  if(!args.length||(args.length===1&&args[0]==='--dry-run'))
    return {live:false};
  if(args[0]!=='--live'||args.length%2!==1)
    throw Error('Usage: --dry-run or --live --model ID --out NEW_TEMP_DIR [--limit 1..30] [--repeats 1..3] [--confirm-batch YES]');
  const vals={};
  for(let i=1;i<args.length;i+=2){
    if(!['--model','--out','--limit','--repeats','--confirm-batch'].includes(args[i])
      ||!args[i+1]||Object.hasOwn(vals,args[i]))throw Error('Invalid live options');
    vals[args[i]]=args[i+1];
  }
  const limit=vals['--limit']===undefined?1:Number(vals['--limit']);
  const repeats=vals['--repeats']===undefined?1:Number(vals['--repeats']);
  if(!Number.isInteger(limit)||limit<1||limit>30||!Number.isInteger(repeats)
    ||repeats<1||repeats>3||!vals['--model']||!vals['--model'].trim()
    ||vals['--model'].includes('\0')||!vals['--out'])
    throw Error('Explicit model, output, --limit 1..30 and --repeats 1..3 required');
  if(limit*repeats>5&&vals['--confirm-batch']!=='YES')
    throw Error('More than five pairs consumes quota: specify --confirm-batch YES');
  return {live:true,model:vals['--model'],out:vals['--out'],limit,repeats};
}
function evaluateProposals(cases,invoke,repeats=1){
  if(!Array.isArray(cases)||!cases.length||typeof invoke!=='function')
    throw Error('Nonempty cases and invoker required');
  if(!Number.isInteger(repeats)||repeats<1||repeats>3)throw Error('Repeats 1..3 required');
  const runs=[];let stopped=false;
  for(let n=0;n<repeats;n++)for(const [i,item] of cases.entries())
    for(const arm of ((i+n)%2?['prepared','raw']:['raw','prepared'])){
      const base={case:item.id,repeat:n,arm,localInputTextTokens:item.localInputTextTokens[arm],
        providerInputTokens:null,providerCachedInputTokens:null,providerOutputTokens:null,
        providerReasoningTokens:null,providerBilledCost:null};
      if(stopped){
        runs.push({...base,state:'not_run',passed:false,reason:'previous_block',elapsedMs:null,reportedModel:null});
        continue;
      }
      let outcome;
      try{outcome=parseCursorCompletion(invoke(item,arm,n));}
      catch{outcome={state:'blocked',reason:'harness_exception',answer:null};}
      const grade=outcome.state==='completed'?gradeProposal(outcome.answer,item):null;
      const passed=!!grade?.passed && outcome.state==='completed'&&!outcome.reason;
      runs.push({...base,state:outcome.state,passed,
        reason:outcome.reason??grade?.reason??null,elapsedMs:outcome.elapsedMs??null,
        reportedModel:outcome.reportedModel??null,
        proposalPaths:passed?grade.expectedPaths:null});
      if(outcome.state!=='completed')stopped=true;
    }
  const models=[...new Set(runs.filter(r=>r.state==='completed').map(r=>r.reportedModel))];
  const sameModel=models.length<=1;
  const complete=runs.every(r=>r.state==='completed')&&sameModel;
  return {state:stopped?'blocked':complete?'completed':'invalid',
    reason:!sameModel?'reported_model_drift':null,
    planned:runs.length,attempted:runs.filter(r=>r.state!=='not_run').length,
    modelCompleted:runs.filter(r=>r.state==='completed').length,
    passed:runs.filter(r=>r.passed).length,comparisonComplete:complete,
    reportedModels:models,runs};
}
function runCli(args=process.argv.slice(2)){
  const opts=parseArgs(args),items=proposalCases(),digest=proposalManifestDigest(items);
  if(!opts.live){
    return {state:'dry_run',modelRuns:0,distinctTasks:items.length,manifestDigest:digest,
      cases:items.map(i=>({id:i.id,kind:i.kind,allowed:i.allowed,needsClarification:!!i.question,
        localInputTextTokens:i.localInputTextTokens})),
      scope:'Read-only Cursor Ask-mode code replacement PROPOSAL A/B; not real editing-agent quality or billed usage.'};
  }
  const root=fs.realpathSync(path.resolve(__dirname,'..'));
  const requested=path.resolve(opts.out),out=path.join(fs.realpathSync(path.dirname(requested)),path.basename(requested));
  const temp=fs.realpathSync(os.tmpdir());
  const relative=path.relative(temp,out),relativeRepo=path.relative(root,out);
  if(!relative||relative==='..'||relative.startsWith('..'+path.sep)||path.isAbsolute(relative)
    ||!relativeRepo||(!relativeRepo.startsWith('..'+path.sep)&&relativeRepo!=='..'&&!path.isAbsolute(relativeRepo)))
    throw Error('Output must be a new directory inside OS temp and outside the Git repo');
  const cmd=(argv)=>spawnSync('git',argv,{cwd:root,encoding:'utf8',timeout:10000});
  const sha=cmd(['rev-parse','--verify','HEAD']);
  const checkStatus=()=>cmd(['status','--porcelain','--untracked-files=normal']);
  const status=checkStatus();
  if(sha.status!==0||status.status!==0||status.stdout.trim())
    throw Error('Clean Git checkout required');
  const cli=spawnSync('agent',['--version'],{cwd:root,encoding:'utf8',timeout:10000});
  const auth=spawnSync('agent',['status'],{cwd:root,encoding:'utf8',timeout:10000});
  if(cli.status!==0||auth.status!==0
    ||/not (authenticated|logged in)|please log in/i.test(auth.stdout+'\n'+auth.stderr))
    throw Error('Locally authenticated Cursor CLI required; never copy credentials into a report');
  fs.mkdirSync(out,{mode:0o700});
  const reports=path.join(out,'receipts');fs.mkdirSync(reports,{mode:0o700});
  let seq=0;
  const report=evaluateProposals(items.slice(0,opts.limit),(item,arm,n)=>{
    const id=String(seq++).padStart(3,'0')+'-'+item.id+'-'+n+'-'+arm;
    const job=path.join(out,id);fs.mkdirSync(job,{mode:0o700});
    fs.writeFileSync(path.join(job,'prompt.txt'),item.prompts[arm],{mode:0o600,flag:'wx'});
    // Reuses the previously demonstrated Cursor Ask-mode invocation.
    // All tools are disallowed by parseCursorCompletion. This is NOT an OS
    // read boundary; use synthetic inputs, no secrets or personal repo context.
    const result=invokeCursor(item.prompts[arm],job,opts.model);
    const receipt=path.join(reports,id);fs.mkdirSync(receipt,{mode:0o700});
    fs.writeFileSync(path.join(receipt,'events.jsonl'),result.stdout??'',{mode:0o600});
    fs.writeFileSync(path.join(receipt,'stderr.txt'),result.stderr??'',{mode:0o600});
    return result;
  },opts.repeats);
  const after=cmd(['rev-parse','--verify','HEAD']),s=checkStatus();
  const integrity=after.status===0&&after.stdout.trim()===sha.stdout.trim()
    &&s.status===0&&!s.stdout.trim();
  const output={provider:'cursor-cli',experiment:'read-only-code-proposals',modelRequested:opts.model,
    cliVersion:cli.stdout.trim(),repositoryCommit:sha.stdout.trim(),manifestDigest:digest,
    distinctTasks:opts.limit,repeats:opts.repeats,...report,gitIntegrity:integrity?'PASS':'FAIL',
    scope:'Exact UTF-8 replacement proposal quality ONLY. Not autonomous edits, a security guarantee, native token usage or billed cost. Provider usage fields are null.'};
  if(!integrity){output.state='invalid';output.reason='git_integrity_failure';}
  fs.writeFileSync(path.join(out,'report.json'),JSON.stringify(output,null,2),{mode:0o600});
  return output;
}
if(require.main===module){
  try{
    const result=runCli();console.log(JSON.stringify(result,null,2));
    if(result.state!=='dry_run'&&(!result.comparisonComplete||result.passed!==result.planned||result.gitIntegrity!=='PASS'))
      process.exitCode=1;
  }catch(error){console.error(error.message);process.exitCode=1;}
}
module.exports={parseArgs,evaluateProposals,runCli};
