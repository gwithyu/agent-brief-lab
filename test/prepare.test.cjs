'use strict';
const {test}=require('node:test');
const assert=require('node:assert/strict');
const fs=require('node:fs'),path=require('node:path'),os=require('node:os'),{spawnSync}=require('node:child_process');
const {prepareInput}=require('../prepare.cjs');
const {unpackHistory}=require('../history.cjs');
const {tokens,intentDigest}=require('../index.cjs');
const intent={...require('../examples/intent.json'),allowedFiles:['src/logic.js']};
const source=fs.readFileSync(path.join(__dirname,'../examples/boolean-before.js'),'utf8');
const sources={'src/logic.js':source};
const text=source;
const messages=[{role:'user',content:intent.request},...Array.from({length:10},(_,n)=>({role:'tool',tool_call_id:'read-'+n,content:text}))];
for(const encoding of ['o200k_base','cl100k_base'])test('one envelope retains intent and reconstructs history with exact net accounting: '+encoding,()=>{
  const original=JSON.stringify({intent,sources,messages}),r=prepareInput(intent,sources,messages,encoding);
  assert.equal(JSON.stringify({intent,sources,messages}),original);
  assert.equal(tokens(JSON.stringify(r.input),encoding),r.metrics.afterTokens);
  assert.equal(Buffer.byteLength(JSON.stringify(r.input)),r.metrics.afterBytes);
  assert.ok(r.metrics.afterTokens<r.metrics.guidedBeforeTokens);assert.ok(r.metrics.afterBytes<r.metrics.guidedBeforeBytes);
  assert.equal(r.metrics.netTokensSavedVersusRawRequest,r.metrics.rawRequestBeforeTokens-r.metrics.afterTokens);
  assert.ok(r.metrics.netTokensSavedVersusRawRequest>0);
  assert.deepEqual(unpackHistory(r.input.history,r.metrics.historySourceDigest),messages);
  assert.deepEqual(r.metrics.rewrittenFiles,['src/logic.js']);
  const brief=JSON.parse(r.input.instruction);assert.equal(brief.request,intent.request);assert.equal(brief.intentDigest,intentDigest(intent));
  assert.equal(brief.goal,intent.goal);assert.deepEqual(brief.allowedFiles,intent.allowedFiles);assert.deepEqual(brief.questions,intent.questions);
  for(const key of ['constraints','acceptance'])assert.deepEqual(Object.entries(brief[key]).map(([id,text])=>({id,text})),intent[key]);
});
test('small tasks honestly report net input growth while keeping constraints and unresolved questions',()=>{
  const i={...intent,questions:['需要多透明？']},r=prepareInput(i,sources,[]);
  assert.ok(r.metrics.netTokensSavedVersusRawRequest<0);assert.equal(r.metrics.historyCompressed,false);
  assert.match(r.input.instruction,/需要多透明/);assert.deepEqual(unpackHistory(r.input.history),[]);
});
test('malformed inputs reject and non-code files stay unchanged',()=>{
  assert.throws(()=>prepareInput(intent,{},messages));assert.throws(()=>prepareInput(intent,sources,[{role:'tool',content:{}}]));
  assert.throws(()=>prepareInput(intent,sources,messages,'unknown'));
  const i={...intent,allowedFiles:['x.css']},r=prepareInput(i,{'x.css':'.nav{}'},[]);
  assert.equal(r.input.files[0].source,'.nav{}');assert.deepEqual(r.metrics.rewrittenFiles,[]);
});
test('prepare CLI produces one input without altering source or history files',()=>{
  const root=fs.mkdtempSync(path.join(os.tmpdir(),'brief-prepare-'));
  try{
    for(const [name,value] of Object.entries({intent,sources,messages}))fs.writeFileSync(path.join(root,name+'.json'),JSON.stringify(value));
    const before=fs.readdirSync(root).map(name=>fs.readFileSync(path.join(root,name),'utf8'));
    const r=spawnSync(process.execPath,[path.join(__dirname,'../index.cjs'),'prepare',...['intent','sources','messages'].map(n=>path.join(root,n+'.json'))],{encoding:'utf8'});
    assert.equal(r.status,0,r.stderr);assert.ok(JSON.parse(r.stdout).metrics.netTokensSavedVersusRawRequest>0);
    assert.deepEqual(fs.readdirSync(root).map(name=>fs.readFileSync(path.join(root,name),'utf8')),before);
  }finally{fs.rmSync(root,{recursive:true,force:true});}
});
