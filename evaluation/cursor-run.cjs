'use strict';
const fs=require('node:fs'),path=require('node:path'),{spawnSync}=require('node:child_process');
const {isDeepStrictEqual}=require('node:util');
const {parseCursorCompletion,invokeCursor}=require('./cursor.cjs');

function evaluateCursor(items,invoke,repeats=1) {
  if(!Array.isArray(items)||!items.length||typeof invoke!=='function')throw Error('Nonempty cases and invoker required');
  if(!Number.isInteger(repeats)||repeats<1||repeats>5)throw Error('repeats must be 1..5');
  const runs=[];let blocked=false;
  for(let n=0;n<repeats;n++)for(let i=0;i<items.length;i++)for(const variant of (i+n)%2?['prepared','raw']:['raw','prepared']) {
    const item=items[i];
    if(blocked) {
      runs.push({case:item.id,repeat:n,variant,state:'not_run',passed:false,
        localInputTextTokens:item.inputTextTokens[variant],providerInputTokens:null,
        providerOutputTokens:null,providerBilledCost:null});
      continue;
    }
    const parsed=parseCursorCompletion(invoke(item,variant,n));
    const passed=parsed.state==='completed'&&!parsed.reason&&isDeepStrictEqual(parsed.answer,item.expected);
    runs.push({case:item.id,repeat:n,variant,state:parsed.state,passed,
      localInputTextTokens:item.inputTextTokens[variant],
      elapsedMs:parsed.elapsedMs??null,reportedModel:parsed.reportedModel??null,
      providerInputTokens:null,providerOutputTokens:null,providerBilledCost:null,
      reason:parsed.reason??(passed?null:'incorrect_answer')});
    if(parsed.state!=='completed')blocked=true;
  }
  return {state:blocked?'blocked':runs.every(r=>r.state==='completed')?'completed':'invalid',
    planned:runs.length,attempted:runs.filter(r=>r.state!=='not_run').length,
    modelCompleted:runs.filter(r=>r.state==='completed').length,
    passed:runs.filter(r=>r.passed).length,
    comparisonComplete:runs.every(r=>r.state==='completed'),runs};
}
function runCli(argv=process.argv.slice(2)) {
  const args=argv.slice(),live=args[0]==='--live';
  if(args.length&&!live&&!(args.length===1&&args[0]==='--dry-run'))throw Error('Use --dry-run or --live --model MODEL --out NEW_DIR [--repeats 1..5]');
  const {cases}=require('./cases.cjs');
  const items=cases();
  if(!live) return {state:'dry_run',modelRuns:0,cases:items.map(({id,inputTextTokens})=>({id,inputTextTokens})),
    scope:'Cursor CLI preview only; no live model calls or provider usage claims'};
  const vals={};
  if(args.length%2!==1)throw Error('Options must be key/value pairs');
  for(let i=1;i<args.length;i+=2){
    if(!['--model','--out','--repeats'].includes(args[i])||!args[i+1]||Object.hasOwn(vals,args[i]))throw Error('Invalid live options');
    vals[args[i]]=args[i+1];
  }
  const model=vals['--model'],destination=vals['--out'];
  const repeats=vals['--repeats']===undefined?1:Number(vals['--repeats']);
  if(!model||!model.trim()||model.includes('\0')||!destination||!Number.isInteger(repeats)||repeats<1||repeats>5)throw Error('Explicit model, new output directory and repeats 1..5 required');
  const root=fs.realpathSync(path.resolve(__dirname,'..'));
  const requested=path.resolve(destination);
  const out=path.join(fs.realpathSync(path.dirname(requested)),path.basename(requested));
  const relative=path.relative(root,out);
  if(relative===''||(!relative.startsWith('..'+path.sep)&&relative!=='..'&&!path.isAbsolute(relative)))throw Error('Keep private model traces outside the package repository');
  const head=spawnSync('git',['rev-parse','--verify','HEAD'],{cwd:root,encoding:'utf8'});
  const beforeStatus=spawnSync('git',['status','--porcelain','--untracked-files=normal'],{cwd:root,encoding:'utf8'});
  if(head.status!==0||beforeStatus.status!==0||beforeStatus.stdout.trim())throw Error('Clean Git checkout required');
  const cli=spawnSync('agent',['--version'],{cwd:root,encoding:'utf8',timeout:10000});
  if(cli.status!==0)throw Error('Cursor CLI not installed; see https://cursor.com/docs/cli/overview');
  const auth=spawnSync('agent',['status'],{cwd:root,encoding:'utf8',timeout:10000});
  if(auth.status!==0||/not (authenticated|logged in)|please log in/i.test(auth.stdout+'\n'+auth.stderr)) {
    throw Error('Cursor CLI not authenticated: run `agent login` locally; no credentials are needed here');
  }
  fs.mkdirSync(out,{mode:0o700});
  const report=evaluateCursor(items,(item,variant,n)=>{
    const job=path.join(out,`${item.id}-${n}-${variant}`);
    fs.mkdirSync(job,{mode:0o700});
    fs.writeFileSync(path.join(job,'prompt.txt'),item.prompts[variant],{mode:0o600});
    // Fresh isolated working folder; do not run Agent in the source repository.
    const response=invokeCursor(item.prompts[variant],job,model);
    fs.writeFileSync(path.join(job,'events.jsonl'),response.stdout??'',{mode:0o600});
    fs.writeFileSync(path.join(job,'stderr.txt'),response.stderr??'',{mode:0o600});
    return response;
  },repeats);
  const afterHead=spawnSync('git',['rev-parse','--verify','HEAD'],{cwd:root,encoding:'utf8'});
  const afterStatus=spawnSync('git',['status','--porcelain','--untracked-files=normal'],{cwd:root,encoding:'utf8'});
  const unchanged=afterHead.status===0&&afterHead.stdout.trim()===head.stdout.trim()&&afterStatus.status===0&&!afterStatus.stdout.trim();
  const result={provider:'cursor-cli',modelRequested:model,cliVersion:cli.stdout.trim(),repositoryCommit:head.stdout.trim(),
    ...report,gitIntegrity:unchanged?'PASS':'FAIL',
    scope:'Four fixed synthetic requirement-comprehension pairs. Cursor JSONL is checked for tool calls; tools are disallowed. No coding-agent success metric. Provider token usage and billed costs are UNKNOWN (null), regardless of local input savings.'};
  if(!unchanged){result.state='invalid';result.reason='git_integrity_failure';}
  fs.writeFileSync(path.join(out,'report.json'),JSON.stringify(result,null,2),{mode:0o600});
  return result;
}
if(require.main===module) {
  try {
    const report=runCli();console.log(JSON.stringify(report,null,2));
    if(report.state!=='dry_run'&&(!report.comparisonComplete||report.passed!==report.planned||report.gitIntegrity!=='PASS'))process.exitCode=1;
  } catch(e) {console.error(e.message);process.exitCode=1;}
}
module.exports={evaluateCursor,runCli};
