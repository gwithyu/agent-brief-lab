'use strict';
// Curated contract diagnostics, not competitive retrieval or model evidence.
const fs=require('node:fs'),os=require('node:os'),path=require('node:path'),assert=require('node:assert/strict');
const {createHash}=require('node:crypto'),{spawnSync,execFileSync}=require('node:child_process');
const {gradeExtraction}=require('./retrieval-preflight.cjs');
const hash=s=>createHash('sha256').update(s).digest('hex');
function gradeSyntaxCase(result,mode,task,sha){
  if(task.expectedError){
    const prefix='Source read refused: '+task.expectedError+'\n';
    return {passed:!result.error&&result.status===1&&result.signal===null&&result.stdout===''
      &&typeof result.stderr==='string'&&(task.expectedError==='read_budget_exceeded'
        ?result.stderr.startsWith(prefix):result.stderr===prefix),expectedRefusal:true};
  }
  const grade=gradeExtraction(result,mode,task.expectedText,sha);
  return {passed:grade.completed&&grade.exactExpected&&result.stderr==='',expectedRefusal:false,...grade};
}
function runSyntaxCheck(){
  const root=path.resolve(__dirname,'..'),git=(...args)=>execFileSync('git',args,{cwd:root,encoding:'utf8'}).trim();
  const revision=git('rev-parse','HEAD');assert.equal(git('status','--porcelain'),'','Commit fixtures and harness before measuring');
  const bytes=fs.readFileSync(path.join(__dirname,'syntax-cases.json')),manifest=JSON.parse(bytes);
  assert.equal(manifest.schema,'agent-brief-syntax-cases.v1');assert.ok(manifest.cases.length>0);
  assert.equal(new Set(manifest.cases.map(t=>t.id)).size,manifest.cases.length);
  const dir=fs.mkdtempSync(path.join(os.tmpdir(),'brief-syntax-')),records=[];
  try{
    for(const task of manifest.cases){
      assert.match(task.file,/^[a-z0-9-]+\.(?:js|cjs|ts)$/);
      assert.equal(typeof task.source,'string');assert.equal(typeof task.symbol,'string');
      assert.equal(Object.hasOwn(task,'expectedText')!==Object.hasOwn(task,'expectedError'),true);
      if(task.expectedText)assert.ok(task.source.includes(task.expectedText));
      const file=path.join(dir,task.file),sha=hash(task.source);fs.writeFileSync(file,task.source);
      const base=[path.join(root,'index.cjs'),'read','--source',file,'--symbol',task.symbol];
      if(task.container)base.push('--container',task.container);
      if(task.expectedSha256)base.push('--sha256',task.expectedSha256);
      const row={id:task.id,sourceSha256:sha,expected:task.expectedError?'refused':'exact physical lines'};
      for(const [mode,flags] of [['briefText',[]],['briefJson',['--json']],['briefSourceOnly',['--source-only']]]){
        const result=spawnSync(process.execPath,[...base,...flags],{cwd:dir,encoding:'utf8',timeout:15000,maxBuffer:1024*1024});
        // Budget refusals use a distinct JSON schema in JSON mode.
        const graded=task.expectedError==='read_budget_exceeded'&&mode==='briefJson'
          ?{...result,stderr:normalizeBudgetRefusal(result.stderr,sha)}:result;
        row[mode]={...gradeSyntaxCase(graded,mode,task,sha),exitCode:result.status,signal:result.signal,
          stdoutBytes:Buffer.byteLength(result.stdout??''),stdoutSha256:hash(result.stdout??''),
          stderrBytes:Buffer.byteLength(result.stderr??'')};
      }
      assert.equal(fs.readFileSync(file,'utf8'),task.source,'Reader changed its source');records.push(row);
    }
    assert.deepEqual(fs.readdirSync(dir).sort(),manifest.cases.map(t=>t.file).sort(),'Reader executed source or wrote files');
  }finally{fs.rmSync(dir,{recursive:true,force:true});}
  assert.equal(git('rev-parse','HEAD'),revision);assert.equal(git('status','--porcelain'),'');
  const modes=['briefText','briefJson','briefSourceOnly'];
  return {schema:'agent-brief-syntax-report.v1',revision,manifestSha256:hash(bytes),runtime:{node:process.version,platform:process.platform},
    caseCount:records.length,expectedReads:manifest.cases.filter(t=>t.expectedText).length,
    expectedRefusals:manifest.cases.filter(t=>t.expectedError).length,
    passedByMode:Object.fromEntries(modes.map(m=>[m,records.filter(r=>r[m].passed).length])),
    allPassed:records.every(r=>modes.every(m=>r[m].passed)),modelCalls:0,providerUsage:null,billedCostUsd:null,
    verifiedRealWorldSavings:false,records,limits:[
      'Hand-authored synthetic syntax cases selected to exercise the documented reader contract; not representative user tasks.',
      'No native-tool arm, unknown-name discovery, edits, retries, provider usage, cost or latency comparison.',
      'Expected text is manually specified and includes whole physical lines, even same-line neighbors.',
      'Passing a deliberate unsupported-wrapper refusal is guard behavior, not retrieval success; failures remain records.',
      'No source code is executed; fixture files and checkout identity are checked after reads.']};
}
function normalizeBudgetRefusal(stderr,sha){
  try{
    const v=JSON.parse(stderr);
    if(v.schema==='agent-brief-source-read-refusal.v1'&&v.status==='refused'&&v.error==='read_budget_exceeded'
      &&v.readHint?.sourceSha256===sha&&v.readHint.startLine===2&&v.readHint.endLine===203
      &&v.readHint.maxLines===200&&v.readHint.maxSliceBytes===65536&&v.completeContext===false
      &&v.modelCalls===0&&v.fileWrites===0)return 'Source read refused: read_budget_exceeded\n';
  }catch{}
  return '';
}
if(require.main===module){
  assert.equal(process.argv.length,2,'Usage: node evaluation/syntax-check.cjs');
  const report=runSyntaxCheck();console.log(JSON.stringify(report,null,2));if(!report.allPassed)process.exitCode=1;
}
module.exports={gradeSyntaxCase,normalizeBudgetRefusal,runSyntaxCheck};
