'use strict';
const {test}=require('node:test');
const assert=require('node:assert/strict');
const fs=require('node:fs');
const path=require('node:path');
const os=require('node:os');
const {spawnSync}=require('node:child_process');
const {tokens,intentDigest}=require('../index.cjs');
const {compactBrief,contextVariants,packContext}=require('../context.cjs');
const intent=require('../examples/intent.json');
const source=fs.readFileSync(path.join(__dirname,'../examples/boolean-before.js'),'utf8');
test('compact brief retains exact text, IDs, order, questions and binding',()=>{
  const i={...intent,request:'保留原句\n"引号"\\路径 <|endoftext|>',questions:['要多透明？'],
    constraints:[{id:'constructor',text:'原样保留\n不要改图标。'},...intent.constraints]};
  const parsed=JSON.parse(compactBrief(i));
  assert.equal(parsed.intentDigest,intentDigest(i));
  assert.equal(parsed.request,i.request);assert.equal(parsed.goal,i.goal);
  assert.deepEqual(parsed.allowedFiles,i.allowedFiles);assert.deepEqual(parsed.questions,i.questions);
  for(const key of ['constraints','acceptance']) assert.deepEqual(Object.entries(parsed[key]).map(([id,text])=>({id,text})),i[key]);
});
for(const encoding of ['o200k_base','cl100k_base']) {
  test(`pack never enlarges the complete guided input: ${encoding}`,()=>{
    const i={...intent,allowedFiles:['src/logic.js']},sources={'src/logic.js':source};
    const original=JSON.stringify(sources),p=packContext(i,sources,encoding);
    assert.equal(JSON.stringify(sources),original);
    assert.ok(p.metrics.afterTokens<=p.metrics.beforeTokens);assert.ok(p.metrics.afterBytes<=p.metrics.beforeBytes);
    assert.equal(tokens(JSON.stringify(p.input),encoding),p.metrics.afterTokens);
    assert.equal(Buffer.byteLength(JSON.stringify(p.input)),p.metrics.afterBytes);
    assert.equal(p.metrics.addedVersusRawRequest,p.metrics.afterTokens-p.metrics.rawRequestBeforeTokens);
    assert.deepEqual(p.metrics.rewrittenFiles,['src/logic.js']);assert.match(p.input.files[0].source,/return !!/);
  });
}
for(const encoding of ['o200k_base','cl100k_base']) {
  test('packContext chooses the global smallest eligible token input: '+encoding,()=>{
    const examples=[
      {intent:{...intent,allowedFiles:['src/logic.js']},sources:{'src/logic.js':source}},
      {intent:{...intent,allowedFiles:['a.css']},sources:{'a.css':'.root { padding: 4px; }'}},
      {intent:{...intent,allowedFiles:['a.js','z.css']},
        sources:{'a.js':source,'z.css':'.root { opacity: 0.5; }'}}
    ];
    for(const {intent:i,sources:src} of examples) {
      const variants=contextVariants(i,src,encoding);
      const baseline=JSON.stringify(variants[0].input);
      const original={tokens:tokens(baseline,encoding),bytes:Buffer.byteLength(baseline)};
      let best={input:variants[0].input,...original};
      for(const variant of variants.slice(1)) {
        const candidate=JSON.stringify(variant.input);
        const count={tokens:tokens(candidate,encoding),bytes:Buffer.byteLength(candidate)};
        if(count.tokens>=original.tokens || count.bytes>=original.bytes) continue;
        if(count.tokens<best.tokens || count.tokens===best.tokens && count.bytes<best.bytes) {
          best={input:variant.input,...count};
        }
      }
      const chosen=packContext(i,src,encoding);
      assert.deepEqual(chosen.input,best.input);
      assert.equal(chosen.metrics.afterTokens,best.tokens);
      assert.equal(chosen.metrics.afterBytes,best.bytes);
      assert.ok(chosen.metrics.afterTokens<=chosen.metrics.beforeTokens);
      assert.ok(chosen.metrics.afterBytes<=chosen.metrics.beforeBytes);
    }
  });
}
test('CSS stays intact and brief costs cannot be called net savings',()=>{
  const p=packContext(intent,{'src/navigation.css':'.nav { opacity: .5; }'});
  assert.equal(p.input.files[0].source,'.nav { opacity: .5; }');assert.deepEqual(p.metrics.rewrittenFiles,[]);
  assert.ok(p.metrics.addedVersusRawRequest>0);
});
test('reject missing, extra, non-text sources, invalid intent, encoding and invalid JS',()=>{
  for(const sources of [{},{'src/navigation.css':'','extra.js':''},{'src/navigation.css':null}]) assert.throws(()=>packContext(intent,sources));
  assert.throws(()=>packContext({...intent,constraints:[]},{'src/navigation.css':''}));
  assert.throws(()=>packContext(intent,{'src/navigation.css':''},'fake'));
  assert.throws(()=>packContext({...intent,allowedFiles:['x.js']},{'x.js':'const = ;'}));
});
test('no-op contents stay exact, sorted and deterministic',()=>{
  const i={...intent,allowedFiles:['z.css','a.txt','types.d.ts']};
  const sources={'z.css':'z{}','a.txt':'不要丢掉这段','types.d.ts':'declare const value: boolean;'},p=packContext(i,sources);
  assert.deepEqual(p.input.files.map(x=>x.path),['a.txt','types.d.ts','z.css']);
  for(const file of p.input.files) assert.equal(file.source,sources[file.path]);
  assert.deepEqual(p.metrics.rewrittenFiles,[]);assert.deepEqual(packContext(i,sources),p);
});
test('CLI pack emits candidate without writing or executing project sources',()=>{
  const dir=fs.mkdtempSync(path.join(os.tmpdir(),'brief-pack-'));
  try {
    const sourceFile=path.join(dir,'sources.json');fs.writeFileSync(sourceFile,JSON.stringify({'src/navigation.css':'throw new Error("not executed")'}));
    const r=spawnSync(process.execPath,[path.join(__dirname,'../index.cjs'),'pack',path.join(__dirname,'../examples/intent.json'),sourceFile],{encoding:'utf8'});
    assert.equal(r.status,0,r.stderr);assert.equal(JSON.parse(r.stdout).input.files[0].source,'throw new Error("not executed")');
    assert.deepEqual(fs.readdirSync(dir),['sources.json']);
  }finally{fs.rmSync(dir,{recursive:true,force:true});}
});
