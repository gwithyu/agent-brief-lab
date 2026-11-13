'use strict';
const fs=require('node:fs'),path=require('node:path'),{spawnSync}=require('node:child_process');
const {isDeepStrictEqual}=require('node:util');
const {cases,schema}=require('./cases.cjs');
function grade(answer,expected) {return isDeepStrictEqual(answer,expected);}
const {parseCompletion,invokeCodex}=require('../codex.cjs');
function parseRun(result,expected) {
  const parsed=parseCompletion(result);
  return {...parsed,passed:parsed.state==='completed' && !parsed.reason && grade(parsed.answer,expected)};
}
function evaluate(items,invoke,repeats=1) {
  if(!Array.isArray(items)||!items.length||typeof invoke!=='function')throw Error('Nonempty cases and an invocation function required');
  if(!Number.isInteger(repeats)||repeats<1||repeats>5)throw Error('repeats must be 1..5');
  const runs=[];let blocked=false;
  for(let n=0;n<repeats;n++) for(let i=0;i<items.length;i++) for(const variant of (i+n)%2?['prepared','raw']:['raw','prepared']) {
    if(blocked){runs.push({case:items[i].id,repeat:n,variant,state:'not_run',passed:false});continue;}
    const result=parseRun(invoke(items[i],variant,n),items[i].expected);
    runs.push({case:items[i].id,repeat:n,variant,inputTextTokens:items[i].inputTextTokens[variant],...result});
    if(result.state==='blocked')blocked=true;
  }
  return {state:blocked?'blocked':runs.every(r=>r.state==='completed')?'completed':'invalid',
    planned:runs.length,attempted:runs.filter(r=>r.state!=='not_run').length,
    modelCompleted:runs.filter(r=>r.state==='completed').length,passed:runs.filter(r=>r.passed).length,
    comparisonComplete:runs.every(r=>r.state==='completed'),runs};
}
if(require.main===module) {
  try {
    const args=process.argv.slice(2),live=args[0]==='--live';
    if(args.length && !live && !(args.length===1&&args[0]==='--dry-run'))throw Error('Use --dry-run or --live --model MODEL --out NEW_DIR [--repeats 1..5]');
    const items=cases();
    if(!live) console.log(JSON.stringify({state:'dry_run',modelRuns:0,cases:items.map(({id,inputTextTokens})=>({id,inputTextTokens})),scope:'Prepared fixtures only; no model result or provider billing evidence'},null,2));
    else {
      const values={};for(let i=1;i<args.length;i+=2){if(!['--model','--out','--repeats'].includes(args[i])||!args[i+1]||values[args[i]])throw Error('Invalid live options');values[args[i]]=args[i+1];}
      const model=values['--model'],out=values['--out'],repeats=values['--repeats']===undefined?1:Number(values['--repeats']);
      if(!model||!model.trim()||model.includes('\0')||!out||!Number.isInteger(repeats)||repeats<1||repeats>5)throw Error('Explicit model, new output directory and repeats 1..5 required');
      const requested=path.resolve(out),root=path.join(fs.realpathSync(path.dirname(requested)),path.basename(requested));
      const packageRoot=fs.realpathSync(path.resolve(__dirname,'..')),ignored=path.join(packageRoot,'evaluation-results');
      const relative=path.relative(packageRoot,root),privateRelative=path.relative(ignored,root);
      const insidePackage=relative===''||(!relative.startsWith('..'+path.sep)&&relative!=='..'&&!path.isAbsolute(relative));
      const insideIgnored=privateRelative===''||(!privateRelative.startsWith('..'+path.sep)&&privateRelative!=='..'&&!path.isAbsolute(privateRelative));
      if(insidePackage&&!insideIgnored)throw Error('Keep run traces outside package source or inside evaluation-results');
      fs.mkdirSync(root,{mode:0o700});
      const cli=spawnSync('codex',['--version'],{encoding:'utf8'});
      const report=evaluate(items,(item,variant,n)=>{
        const job=path.join(root,`${item.id}-${n}-${variant}`);fs.mkdirSync(job,{mode:0o700});
        const schemaPath=path.join(job,'schema.json');fs.writeFileSync(schemaPath,JSON.stringify(schema));
        fs.writeFileSync(path.join(job,'prompt.txt'),item.prompts[variant]);
        const r=invokeCodex(item.prompts[variant],schemaPath,job,model);
        fs.writeFileSync(path.join(job,'events.jsonl'),r.stdout??'');fs.writeFileSync(path.join(job,'stderr.txt'),r.stderr??'');return r;
      },repeats);
      const complete={modelRequested:model,cliVersion:cli.status===0?cli.stdout.trim():null,...report,
        scope:'Read-only structured comprehension probes, not an editing agent or invoice. CLI-reported usage includes harness context; o200k text counts are separate. Local traces may contain private runtime metadata.'};
      fs.writeFileSync(path.join(root,'report.json'),JSON.stringify(complete,null,2));
      console.log(JSON.stringify(complete,null,2));if(!report.comparisonComplete||report.passed!==report.planned)process.exitCode=1;
    }
  }catch(e){console.error(e.message);process.exitCode=1;}
}
module.exports={grade,parseRun,evaluate};
