'use strict';
const {test}=require('node:test'),assert=require('node:assert/strict');
const fs=require('node:fs'),path=require('node:path'),os=require('node:os'),{spawnSync}=require('node:child_process');
const {startSession}=require('../session.cjs');
const {intentDigest}=require('../index.cjs');
const intent={request:'Simplify logic.js, keep names and behavior.',goal:'Simplify boolean return.',allowedFiles:['logic.js'],constraints:[{id:'keep_names',text:'Keep exported names and behavior.'}],acceptance:[{id:'tests',text:'Run behavior assertions.'}],questions:[]};
function fixture(fn) {
 const temporary=fs.mkdtempSync(path.join(os.tmpdir(),'active-session-')),root=path.join(temporary,'repo'),out=path.join(temporary,'bundle');fs.mkdirSync(root);
 const source='function visible(x){if(x)return true;else return false;}\n';fs.writeFileSync(path.join(root,'logic.js'),source);
 for(const args of [['init','-b','main'],['add','.'],['commit','-m','fixture']]) {const r=spawnSync('git',['-c','core.hooksPath=/dev/null','-c','user.name=Fixture','-c','user.email=fixture@example.invalid','-c','commit.gpgsign=false',...args],{cwd:root,encoding:'utf8'});assert.equal(r.status,0,r.stderr);}
 try{return fn({root,out,temporary,source});}finally{fs.rmSync(temporary,{recursive:true,force:true});}
}
test('current-agent entry returns source and trusted-baseline location without editing the repo',()=>fixture(({root,out,source})=>{
 const r=startSession(intent,root,out);assert.equal(r.state,'session_ready');assert.equal(r.intentDigest,intentDigest(intent));
 assert.ok(fs.existsSync(r.baselineFile));assert.equal(r.input.files[0].path,'logic.js');assert.match(r.input.instruction,/Keep exported names/);
 assert.equal(fs.readFileSync(path.join(root,'logic.js'),'utf8'),source);
 assert.equal(fs.existsSync(path.join(out,'events.jsonl')),false);assert.equal(fs.existsSync(path.join(out,'proposal.json')),false);
}));
test('unresolved questions remain visible and prevent a ready session',()=>fixture(({root,out})=>{
 const r=startSession({...intent,questions:['Confirm target behavior?']},root,out);assert.equal(r.state,'needs_clarification');assert.match(r.input.instruction,/Confirm target behavior/);
}));
test('session CLI works with no Codex executable in PATH',()=>fixture(({root,out,temporary})=>{
 const file=path.join(temporary,'intent.json');fs.writeFileSync(file,JSON.stringify(intent));
 // Keep Git available while ensuring no Codex executable can be resolved.
 const bin=path.join(temporary,'bin');fs.mkdirSync(bin);const which=spawnSync('which',['git'],{encoding:'utf8'});assert.equal(which.status,0);fs.symlinkSync(which.stdout.trim(),path.join(bin,'git'));
 const r=spawnSync(process.execPath,[path.join(__dirname,'../index.cjs'),'session',file,root,out],{encoding:'utf8',env:{...process.env,PATH:bin}});
 assert.equal(r.status,0,r.stderr);assert.equal(JSON.parse(r.stdout).state,'session_ready');
}));
