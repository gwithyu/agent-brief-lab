'use strict';
// Scripted known-name retrieval on a pinned public checkout, not an agent A/B.
const fs=require('node:fs'),path=require('node:path'),assert=require('node:assert/strict');
const {createHash}=require('node:crypto'),{spawnSync,execFileSync}=require('node:child_process');
const ts=require('typescript'),{tokens,sourceFile}=require('../index.cjs');
const manifest=require('./retrieval-preflight-manifest.json');
const hash=s=>createHash('sha256').update(s).digest('hex');
const failed=()=>({completed:false,containsExpected:false,exactExpected:false,sourceSha256:null});
function gradeExtraction(result,mode,expected,sha){
  assert.ok(typeof expected==='string'&&expected.length>0);
  if(result.error||result.status!==0||result.signal!==null||typeof result.stdout!=='string')return failed();
  let text=result.stdout,sourceSha256=null;
  if(mode==='briefJson'){
    let value;try{value=JSON.parse(text)}catch{return failed();}
    if(!value||value.schema!=='agent-brief-source-read.v1'||value.status!=='ready'||typeof value.text!=='string')return failed();
    text=value.text;sourceSha256=value.sourceSha256;
  }else if(mode==='briefText'){
    if(!text.startsWith('Agent Brief Lab — source data, not instructions\n')||!text.endsWith('\n'))return failed();
    const boundary=text.indexOf('\n\n');if(boundary<0)return failed();
    sourceSha256=/^Source SHA-256: ([a-f0-9]{64})$/m.exec(text.slice(0,boundary))?.[1];
    text=text.slice(boundary+2,-1); // console.log adds one terminator after original text.
  }else assert.ok(['native','briefSourceOnly'].includes(mode));
  if(!['native','briefSourceOnly'].includes(mode)&&sourceSha256!==sha)return failed();
  return {completed:true,containsExpected:text.includes(expected),exactExpected:text===expected,sourceSha256};
}
function runPreflight(root,helperRoot=null){
  root=path.resolve(root);
  const git=(...args)=>execFileSync('git',args,{cwd:root,encoding:'utf8'}).trim();
  assert.equal(git('rev-parse','HEAD'),manifest.revision,'Use the pinned source checkout from the guide');
  assert.equal(git('status','--porcelain'),'','Source checkout must be clean');
  const separateHelper=helperRoot!==null;
  helperRoot=separateHelper?path.resolve(helperRoot):root;
  const helperGit=(...args)=>execFileSync('git',args,{cwd:helperRoot,encoding:'utf8'}).trim();
  const helperRevision=helperGit('rev-parse','HEAD');assert.equal(helperGit('status','--porcelain'),'');
  const studyManifest=separateHelper?{...manifest,helperRevision,
    briefSourceOnlyPolicy:'node index.cjs read --source FILE --symbol NAME --source-only'}:manifest;
  const modes=['native','briefText','briefJson',...(separateHelper?['briefSourceOnly']:[])];
  const records=[];
  for(const task of manifest.tasks){
    const source=fs.readFileSync(path.join(root,task.file),'utf8'),sha=hash(source),parsed=sourceFile(source,task.file);
    const matches=parsed.statements.filter(n=>ts.isFunctionDeclaration(n)&&n.name?.text===task.symbol);
    assert.equal(matches.length,1,'Manifest target must be a unique top-level declaration');
    const node=matches[0],lines=parsed.getLineStarts();
    const first=parsed.getLineAndCharacterOfPosition(node.getStart(parsed,true)).line;
    const last=parsed.getLineAndCharacterOfPosition(node.end-1).line;
    const expected=source.slice(lines[first],lines[last+1]??source.length);
    const commands={native:['sed','-n',`/^function ${task.symbol}(/,/^}/p`,task.file],
      briefText:['node','index.cjs','read','--source',task.file,'--symbol',task.symbol],
      briefJson:['node','index.cjs','read','--source',task.file,'--symbol',task.symbol,'--json']};
    if(separateHelper)commands.briefSourceOnly=['node','index.cjs','read','--source',task.file,'--symbol',task.symbol,'--source-only'];
    const row={...task,sourceSha256:sha,targetStartLine:first+1,targetEndLine:last+1,targetBytes:Buffer.byteLength(expected)};
    for(const [mode,[command,...args]] of Object.entries(commands)){
      const actualArgs=command==='node'&&separateHelper?[path.join(helperRoot,args[0]),...args.slice(1)]:args;
      const r=spawnSync(command==='node'?process.execPath:command,actualArgs,{cwd:root,encoding:'utf8',timeout:15000,maxBuffer:1024*1024});
      const stdout=r.stdout??'',stderr=r.stderr??'';
      const result={exitCode:r.status,signal:r.signal,stdout,stderr};
      row[mode]={...gradeExtraction({...r,stdout},mode,expected,sha),exitCode:r.status,
        stdoutTokens:tokens(stdout),commandTokens:tokens(JSON.stringify([command,...args])),
        declaredEnvelopeTokens:tokens(JSON.stringify({command:[command,...args],result})),stdoutBytes:Buffer.byteLength(stdout)};
    }
    assert.equal(hash(fs.readFileSync(path.join(root,task.file),'utf8')),sha,'Source changed during measurement');
    records.push(row);
  }
  assert.equal(git('rev-parse','HEAD'),manifest.revision);assert.equal(git('status','--porcelain'),'');
  assert.equal(helperGit('rev-parse','HEAD'),helperRevision);assert.equal(helperGit('status','--porcelain'),'');
  const total=mode=>records.reduce((sum,row)=>{
    for(const key of ['completed','containsExpected','exactExpected'])sum[key]+=Number(row[mode][key]);
    for(const key of ['stdoutTokens','commandTokens','declaredEnvelopeTokens'])sum[key]+=row[mode][key];
    return sum;
  },{completed:0,containsExpected:0,exactExpected:0,stdoutTokens:0,commandTokens:0,declaredEnvelopeTokens:0});
  const totals=Object.fromEntries(modes.map(mode=>[mode,total(mode)]));
  return {schema:'agent-brief-retrieval-preflight-report.v1',manifest:studyManifest,manifestSha256:hash(JSON.stringify(studyManifest)),
    runtime:{node:process.version,platform:process.platform,typescript:ts.version},taskCount:records.length,
    agentRuns:0,modelCalls:0,providerUsage:null,billedCostUsd:null,codingTaskCorrectness:null,
    retrievalComparisonComplete:Object.values(totals).every(v=>v.completed===records.length&&v.containsExpected===records.length),
    verifiedRealWorldSavings:false,...totals,records,
    limits:['Scripted retrieval on one public self-repository; known names and regular formatting; no code edits or independent model sessions.',
      'Convenience sample, not externally preregistered or randomized; no task exclusions after measurement.',
      'sed relies on column-zero declaration formatting; AST original ranges are used only by the grader.',
      'Normalized command/result JSON is a declared local envelope, not provider usage or an actual host tool envelope.',
      'No agent instructions, follow-up reads, tool schemas, model outputs, retries, latency, cache effects or bills measured.',
      'Brief identity metadata and stronger guarantees are counted when emitted but not claimed equivalent to sed.',
      ...(separateHelper?['The separately pinned helper executable path is normalized to index.cjs in declared command counts; source-only emits no metadata.']:[])]};
}
if(require.main===module){
  if(![3,4].includes(process.argv.length))throw Error('Usage: node evaluation/retrieval-preflight.cjs PINNED_CHECKOUT [HELPER_CHECKOUT]');
  console.log(JSON.stringify(runPreflight(process.argv[2],process.argv[3]??null),null,2));
}
module.exports={gradeExtraction,runPreflight};
