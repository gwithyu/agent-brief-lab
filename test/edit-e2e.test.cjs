'use strict';
const {test}=require('node:test'),assert=require('node:assert/strict');
const fs=require('node:fs'),os=require('node:os'),path=require('node:path'),{spawnSync}=require('node:child_process');
const {parseTerminal}=require('../evaluation/edit-run.cjs');
const base={type:'system',subtype:'init',model:'test-model',session_id:'synthetic'};
const finish={type:'result',subtype:'success',is_error:false,duration_ms:17,result:'Done',session_id:'synthetic'};
const stream=items=>({status:0,stdout:items.map(JSON.stringify).join('\n')+'\n',stderr:''});

test('tool audit rejects unsafe operations, mismatched receipts and inaccurate workspace/session evidence',()=>{
  const root=fs.mkdtempSync(path.join(os.tmpdir(),'brief-tool-audit-'));
  try{
    fs.writeFileSync(path.join(root,'source.txt'),'safe');
    fs.writeFileSync(path.join(root,'other.txt'),'other');
    const scoped=items=>parseTerminal(stream(items.map(e=>({
      ...e,session_id:e.session_id??'synthetic',...(e.type==='system'?{cwd:e.cwd??root}:{})
    }))),root);
    const call=(kind,subtype='started',target='source.txt',call_id='x')=>({
      type:'tool_call',subtype,call_id,tool_call:{[kind]:{args:{path:target},
        ...(subtype==='completed'?{result:{success:{}}}:{})}}});
    assert.equal(scoped([base,call('shellToolCall'),finish]).reason,'forbidden_tool_reported');
    assert.equal(scoped([base,call('mysteryToolCall'),finish]).reason,'forbidden_tool_reported');
    assert.equal(scoped([base,call('readToolCall'),finish]).reason,'unfinished_tool_call');
    assert.equal(scoped([base,call('readToolCall','completed'),finish]).reason,'unmatched_tool_completion');
    assert.equal(scoped([base,call('readToolCall','started'),call('readToolCall','started'),finish]).reason,'duplicate_tool_start');
    assert.equal(parseTerminal(stream([base,call('readToolCall'),call('readToolCall','completed'),finish])).reason,'unverified_tool_workspace');
    assert.equal(scoped([base,call('readToolCall','started','../outside'),finish]).reason,'unverifiable_tool_path');
    const clean=scoped([base,call('readToolCall'),call('readToolCall','completed'),finish]);
    assert.equal(clean.state,'completed');assert.equal(clean.toolEvents,1);
    assert.equal(scoped([base,{type:'unexpected'},finish]).reason,'invalid_event');
    assert.equal(scoped([{...base,cwd:os.tmpdir()},finish]).reason,'workspace_mismatch');
    assert.equal(scoped([base,{...finish,session_id:'wrong-session'}]).reason,'session_mismatch');
    assert.equal(scoped([base,{type:'assistant',subtype:'tool_use_start',tool_call:{readToolCall:{}}},finish]).reason,'unaudited_assistant_tool');
    assert.equal(scoped([base,call('readToolCall'),call('readToolCall','completed','other.txt'),finish]).reason,'tool_event_mismatch');
    const noSuccess=call('readToolCall','completed');
    noSuccess.tool_call.readToolCall.result={};
    assert.equal(scoped([base,call('readToolCall'),noSuccess,finish]).reason,'tool_failed_or_unverified');
    const outside=path.join(path.dirname(root),'unrelated-'+path.basename(root)+'.txt');
    fs.writeFileSync(outside,'do not inspect');
    try {
      assert.equal(scoped([base,call('readToolCall','started',outside),finish]).reason,
        'out_of_workspace_tool_path');
      fs.symlinkSync(outside,path.join(root,'link'));
      assert.equal(scoped([base,call('readToolCall','started','link'),finish]).reason,
        'out_of_workspace_tool_path');
      const wrongResult=call('readToolCall','completed');
      wrongResult.tool_call.readToolCall.result.success.path=outside;
      assert.equal(scoped([base,call('readToolCall'),wrongResult,finish]).reason,
        'out_of_workspace_tool_result');
    } finally {fs.rmSync(outside,{force:true});}
  }finally{fs.rmSync(root,{recursive:true,force:true});}
});
function fakeAgentMain(){
  'use strict';
  const fs=require('node:fs'),path=require('node:path');
  const args=process.argv.slice(2);
  if(args[0]==='--version'){console.log('fake-cursor-e2e/1');process.exit(0);}
  if(args[0]==='status'){console.log('Logged in (TEST STUB, NOT A REAL ACCOUNT)');process.exit(0);}
  if(!args.includes('--print')||!args.includes('--trust')||!args.includes('--mode=agent')
    ||args.includes('--force')||args.includes('--yolo')||!args.includes('--sandbox')){
    console.error('Unexpected agent invocation');process.exit(5);
  }
  const mode=process.env.BRIEF_STUB_MODE||'edit';
  const config=path.join(process.cwd(),'src/config.json');
  const data=fs.readFileSync(config,'utf8');
  if(mode==='edit')fs.writeFileSync(config,data.replace('"enabled": false','"enabled": true'));
  if(mode==='scope')fs.writeFileSync(path.join(process.cwd(),'README.md'),'bad protected edit');
  const system={type:'system',subtype:'init',model:'fake-cursor-e2e/1',session_id:'test',cwd:process.cwd()};
  const tool={type:'tool_call',subtype:'started',call_id:'one',session_id:'test',
    tool_call:{writeToolCall:{args:{path:'src/config.json'}}}};
  const done={type:'tool_call',subtype:'completed',call_id:'one',session_id:'test',
    tool_call:{writeToolCall:{args:{path:'src/config.json'},result:{success:{}}}}};
  const end={type:'result',subtype:'success',is_error:false,duration_ms:20,result:'Done',session_id:'test'};
  const events=mode==='no-tools'?[system,end]:[system,tool,done,end];
  process.stdout.write(events.map(x=>JSON.stringify(x)).join('\n')+'\n');
}
function fakeEnvironment(){
  const parent=fs.mkdtempSync(path.join(os.tmpdir(),'brief-cli-e2e-'));
  const bin=path.join(parent,'bin');fs.mkdirSync(bin,{mode:0o700});
  const driver=path.join(parent,'fake-agent.cjs');
  fs.writeFileSync(driver,'('+fakeAgentMain.toString()+')();\n',{mode:0o600});
  const launcher=path.join(bin,'agent');
  fs.writeFileSync(launcher,'#!/bin/sh\nexec "'+process.execPath+'" "'+driver+'" "$@"\n',{mode:0o700});
  const repo=path.resolve(__dirname,'..');
  const run=(mode,limit=1)=>{
    const out=path.join(parent,'results-'+mode+'-'+limit);
    const argv=['evaluation/edit-run.cjs','--live','--model','test-model','--limit',String(limit),'--out',out];
    const result=spawnSync(process.execPath,argv,{cwd:repo,encoding:'utf8',timeout:30000,maxBuffer:1024*1024,
      env:{...process.env,PATH:bin+path.delimiter+process.env.PATH,BRIEF_STUB_MODE:mode}});
    const report=fs.existsSync(path.join(out,'report.json'))
      ?JSON.parse(fs.readFileSync(path.join(out,'report.json'),'utf8')):null;
    return {result,report,out};
  };
  return {parent,run};
}
test('end-to-end CLI invokes fake Cursor twice and grades real disk edits',()=>{
  const env=fakeEnvironment();
  try{
    const {result,report,out}=env.run('edit');
    assert.equal(result.status,0,result.stderr+' '+result.stdout.slice(0,1000));
    assert.equal(report.planned,2);assert.equal(report.attempted,2);
    assert.equal(report.modelCompleted,2);assert.equal(report.passed,2);
    assert.equal(report.state,'completed');assert.equal(report.gitIntegrity,'PASS');
    assert.deepEqual(report.runs.map(x=>x.auditedToolCalls),[1,1]);
    assert.ok(report.runs.every(x=>x.providerInputTokens===null&&x.providerBilledCost===null));
    for(const dir of fs.readdirSync(path.join(out,'workspaces'))){
      const full=path.join(out,'workspaces',dir);
      assert.equal(fs.statSync(full).mode&0o077,0);
      assert.match(fs.readFileSync(path.join(full,'src/config.json'),'utf8'),/"enabled": true/);
    }
  }finally{fs.rmSync(env.parent,{recursive:true,force:true});}
});
test('end-to-end CLI rejects protected-file edit and skips all remaining calls',()=>{
  const env=fakeEnvironment();
  try{
    const {result,report}=env.run('scope',2);
    assert.equal(result.status,1,result.stderr);
    assert.equal(report.state,'blocked');assert.equal(report.attempted,1);
    assert.equal(report.modelCompleted,1);assert.equal(report.passed,0);
    assert.equal(report.runs[0].failureReason,'scope_violation');
    assert.equal(report.runs.filter(x=>x.state==='not_run').length,3);
    assert.equal(report.gitIntegrity,'PASS');
  }finally{fs.rmSync(env.parent,{recursive:true,force:true});}
});
test('end-to-end CLI rejects successful model message without required edits',()=>{
  const env=fakeEnvironment();
  try{
    const {result,report}=env.run('no-tools');
    assert.equal(result.status,1,result.stderr);
    assert.equal(report.modelCompleted,2);assert.equal(report.passed,0);
    assert.equal(report.runs.every(x=>x.failureReason==='acceptance_failed'),true);
  }finally{fs.rmSync(env.parent,{recursive:true,force:true});}
});
