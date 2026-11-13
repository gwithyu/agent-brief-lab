'use strict';
const path=require('node:path');
const {spawnSync}=require('node:child_process');
const {validateIntent,intentDigest}=require('./index.cjs');
const {checkChanges,captureBaseline}=require('./execution.cjs');
function reviewChanges(intent,plan,baseline,root,manifest) {
  validateIntent(intent);
  if(!manifest || manifest.intentDigest!==intentDigest(intent) || !Array.isArray(manifest.commands)
    || manifest.commands.length!==intent.acceptance.length
    || new Set(manifest.commands.map(c=>c?.id)).size!==manifest.commands.length
    || manifest.commands.some(c=>!c || !intent.acceptance.some(a=>a.id===c.id)
      || !Array.isArray(c.argv) || !c.argv.length || c.argv.some(a=>typeof a!=='string' || a.includes('\0'))
      || !path.isAbsolute(c.argv[0])
      || (c.timeoutMs!==undefined && (!Number.isInteger(c.timeoutMs) || c.timeoutMs<100 || c.timeoutMs>30000)))) {
    throw new Error('Invalid acceptance manifest: bind every acceptance ID to a trusted absolute executable');
  }
  const before=checkChanges(intent,plan,baseline,root);
  if(!before.ok) return {ok:false,scopeBefore:before,checks:[],scopeAfter:null,acceptance:'Blocked before command execution'};
  const snapshot=captureBaseline(intent,root),checks=[];
  const inspect=()=>{
    try {
      const scope=checkChanges(intent,plan,baseline,root),current=captureBaseline(intent,root);
      if(JSON.stringify(current.files)!==JSON.stringify(snapshot.files) || current.head!==snapshot.head || current.indexDigest!==snapshot.indexDigest) {
        scope.ok=false;scope.failures.push('Working tree changed during acceptance commands');
      }
      return scope;
    } catch(error) {return {ok:false,failures:[error.message]};}
  };
  let after=before;
  for(const command of manifest.commands) {
    if(checks.some(c=>!c.ok)) {checks.push({id:command.id,ok:false,state:'not_run'});continue;}
    const result=spawnSync(command.argv[0],command.argv.slice(1),{cwd:root,shell:false,encoding:'utf8',
      timeout:command.timeoutMs??30000,maxBuffer:64*1024,killSignal:'SIGKILL'});
    after=inspect();
    checks.push({id:command.id,ok:!result.error && result.status===0 && !result.signal && after.ok,
      state:result.error?'error':'completed',exitCode:result.status,signal:result.signal,
      error:result.error?.code??null,stdout:result.stdout??'',stderr:result.stderr??'',
      workspaceUnchanged:after.ok,workspaceFailures:after.failures});
  }
  const ok=checks.every(c=>c.ok) && after.ok;
  return {ok,scopeBefore:before,checks,scopeAfter:after,
    acceptance:ok?'Configured commands passed and observed files stayed unchanged during checks':'Acceptance review failed',
    limitation:'Commands are trusted caller configuration, inherit the process environment and are not sandboxed. Passing does not prove semantic or visual correctness; ignored files and transient changes are outside observation.'};
}
module.exports={reviewChanges};
