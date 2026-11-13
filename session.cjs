'use strict';
const fs=require('node:fs'),path=require('node:path');
const {propose}=require('./propose.cjs');
function startSession(intent,repo,out) {
  const report=propose(intent,repo,out);
  const directory=fs.realpathSync(out);
  return {state:intent.questions.length?'needs_clarification':'session_ready',
    intentDigest:report.intentDigest,baselineFile:path.join(directory,'baseline.json'),
    input:JSON.parse(fs.readFileSync(path.join(directory,'input.json'),'utf8')),
    preparation:report.preparation,
    scope:'Prepared data for the current agent; no new model invocation or project edits. Resolve questions first. Baseline and inputs are private; preserve the baseline outside agent-editable source.'};
}
module.exports={startSession};
