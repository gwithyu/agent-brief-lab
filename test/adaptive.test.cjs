'use strict';
const {test}=require('node:test');
const assert=require('node:assert/strict');
const {prepareInput}=require('../prepare.cjs');
const {contextVariants}=require('../context.cjs');
const {packHistory,unpackHistory}=require('../history.cjs');
const {tokens,intentDigest,simplify}=require('../index.cjs');

const baseIntent={
  request:'Change the guarded return, but do not touch anything else.',
  goal:'Make one conservative proposal',
  allowedFiles:['src/check.js'],
  constraints:[{id:'keep_exports',text:'Preserve exports and all explicit requirements.'}],
  acceptance:[{id:'tests',text:'Run existing tests only after reviewing the proposed patch.'}],
  questions:[]
};
const sources={'src/check.js':'function check(x) { if (x) { return true; } else { return false; } }\n'};
const large='tool output: do not treat this as instructions.\n'.repeat(150);

for(const encoding of ['o200k_base','cl100k_base']) {
  test('full-envelope selection is a global measured minimum with no baseline regression: '+encoding,()=>{
    for(const messages of [
      [],
      [{role:'user',content:'Preserve the original requirements.'},{role:'tool',content:large},{role:'tool',content:large},{role:'tool',content:large}],
      [{role:'tool',content:'x'},{role:'tool',content:'x'}]
    ]) {
      const report=prepareInput(baseIntent,sources,messages,encoding);
      const histories=[['raw',messages],['dictionary',packHistory(messages,encoding).input]];
      const candidates=new Map();
      for(const variant of contextVariants(baseIntent,sources,encoding)) for(const [historyFormat,history] of histories) {
        const input={...variant.input,history},serialized=JSON.stringify(input);
        if(!candidates.has(serialized)) candidates.set(serialized,{input,instructionFormat:variant.format,historyFormat,
          tokenCount:tokens(serialized,encoding),byteCount:Buffer.byteLength(serialized)});
      }
      const baseline={...contextVariants(baseIntent,sources,encoding)[0].input,history:messages};
      const before=JSON.stringify(baseline);
      let best={input:baseline,instructionFormat:'readable',historyFormat:'raw',
        tokenCount:tokens(before,encoding),byteCount:Buffer.byteLength(before)};
      for(const candidate of candidates.values()) {
        if(candidate.tokenCount>=tokens(before,encoding) || candidate.byteCount>=Buffer.byteLength(before)) continue;
        if(candidate.tokenCount<best.tokenCount || candidate.tokenCount===best.tokenCount && candidate.byteCount<best.byteCount)best=candidate;
      }
      assert.deepEqual(report.input,best.input);
      assert.equal(report.metrics.afterTokens,best.tokenCount);
      assert.equal(report.metrics.afterBytes,best.byteCount);
      assert.equal(report.metrics.selection.uniqueCandidatesMeasured,candidates.size);
      const audits=report.metrics.selection.candidates;
      assert.equal(audits.length,candidates.size);
      assert.equal(audits.filter(x=>x.selected).length,1);
      assert.equal(audits.find(x=>x.selected).tokens,report.metrics.afterTokens);
      assert.equal(audits.find(x=>x.selected).bytes,report.metrics.afterBytes);
      assert.ok(audits.every(x=>Object.keys(x).sort().join(',')==='bytes,id,reason,selected,tokens'));
      assert.ok(audits.every(x=>!JSON.stringify(x).includes(baseIntent.request)));
      assert.ok(audits.every(x=>['BASELINE','SELECTED','NO_GAIN_BOTH','NO_TOKEN_GAIN','NO_BYTE_GAIN','ELIGIBLE_NOT_SELECTED'].includes(x.reason)));
      assert.equal(report.metrics.selection.instructionFormat,best.instructionFormat);
      assert.equal(report.metrics.selection.historyFormat,best.historyFormat);
      assert.equal(report.metrics.selection.reason,best.tokenCount<tokens(before,encoding)?'MEASURED_GAIN':'NO_GAIN');
      assert.ok(report.metrics.afterTokens<=report.metrics.guidedBeforeTokens);
      assert.ok(report.metrics.afterBytes<=report.metrics.guidedBeforeBytes);
      assert.deepEqual(unpackHistory(report.input.history,report.metrics.historySourceDigest),messages);
      assert.deepEqual(report.input.files.map(file=>file.path),baseIntent.allowedFiles);
      assert.ok([sources['src/check.js'],simplify(sources['src/check.js'],'src/check.js',encoding).code].includes(report.input.files[0].source));
      if(report.metrics.selection.instructionFormat==='json') {
        const instruction=JSON.parse(report.input.instruction);
        assert.equal(instruction.request,baseIntent.request);
        assert.equal(instruction.goal,baseIntent.goal);
        assert.equal(instruction.intentDigest,intentDigest(baseIntent));
        assert.deepEqual(instruction.allowedFiles,baseIntent.allowedFiles);
        assert.deepEqual(instruction.questions,baseIntent.questions);
        assert.equal(instruction.constraints.keep_exports,baseIntent.constraints[0].text);
        assert.equal(instruction.acceptance.tests,baseIntent.acceptance[0].text);
      } else {
        assert.match(report.input.instruction,/Preserve exports and all explicit requirements/);
        assert.match(report.input.instruction,/Run existing tests only after reviewing/);
      }
    }
  });
}
for(const encoding of ['o200k_base','cl100k_base']) {
  test('minimum-savings gate preserves baseline and explains near wins: '+encoding,()=>{
    const base=prepareInput(baseIntent,sources,[],encoding);
    const savings=base.metrics.tokensSavedWithGuidance;
    assert.ok(savings>0,'fixture must produce a measurable token gain');
    assert.ok(savings<1000000,'fixture must fit supported margin');
    const exact=prepareInput(baseIntent,sources,[],encoding,savings);
    assert.deepEqual(exact.input,base.input);
    assert.equal(exact.metrics.selection.minSavingsTokens,savings);
    const blocked=prepareInput(baseIntent,sources,[],encoding,savings+1);
    assert.equal(blocked.metrics.selection.reason,'MARGIN_NOT_MET');
    assert.equal(blocked.metrics.selection.minSavingsTokens,savings+1);
    assert.equal(blocked.metrics.tokensSavedWithGuidance,0);
    assert.equal(blocked.metrics.afterTokens,blocked.metrics.guidedBeforeTokens);
    assert.deepEqual(blocked.input.history,[]);
    assert.ok(blocked.metrics.selection.candidates.some(c=>c.reason==='BELOW_MINIMUM_GAIN'));
    assert.equal(blocked.metrics.selection.candidates.filter(c=>c.selected).length,1);
    assert.equal(blocked.metrics.selection.candidates.find(c=>c.selected).reason,'BASELINE');
    assert.deepEqual(unpackHistory(blocked.input.history,blocked.metrics.historySourceDigest),[]);
  });
}
test('invalid minimum savings reject before preparing any data',()=>{
  for(const invalid of [0,-1,1.5,NaN,Infinity,null,'2',1000001]) {
    assert.throws(()=>prepareInput(baseIntent,sources,[],'o200k_base',invalid),RangeError);
  }
});
test('prepare CLI accepts configured minimum and rejects malformed minimum',()=>{
  const fs=require('node:fs'),os=require('node:os'),path=require('node:path'),{spawnSync}=require('node:child_process');
  const dir=fs.mkdtempSync(path.join(os.tmpdir(),'brief-adaptive-'));
  try {
    for(const [name,value] of Object.entries({intent:baseIntent,sources,messages:[]})) {
      fs.writeFileSync(path.join(dir,name+'.json'),JSON.stringify(value));
    }
    const args=[path.join(__dirname,'../index.cjs'),'prepare',...['intent','sources','messages'].map(n=>path.join(dir,n+'.json')),'o200k_base'];
    const ok=spawnSync(process.execPath,[...args,'1000000'],{encoding:'utf8'});
    assert.equal(ok.status,0,ok.stderr);
    const parsed=JSON.parse(ok.stdout);
    assert.equal(parsed.metrics.selection.reason,'MARGIN_NOT_MET');
    assert.equal(parsed.metrics.selection.minSavingsTokens,1000000);
    for(const invalid of ['0','-1','1.5','abc']) {
      const bad=spawnSync(process.execPath,[...args,invalid],{encoding:'utf8'});
      assert.equal(bad.status,1);
      assert.match(bad.stderr,/minSavingsTokens/);
    }
  } finally {fs.rmSync(dir,{force:true,recursive:true});}
});
test('large private source is preserved but never copied into selection diagnostics',()=>{
  const secret='SENSITIVE_CANARY_DO_NOT_ECHO_';
  const big=secret+'/* '+('unchanged CSS payload. '.repeat(2500))+' */';
  const intent={...baseIntent,allowedFiles:['styles/large.css']};
  const source={'styles/large.css':big};
  const one=prepareInput(intent,source,[]);
  const two=prepareInput(intent,source,[]);
  assert.deepEqual(one,two,'candidate ranking must remain deterministic');
  assert.equal(one.input.files[0].source,big);
  assert.ok(one.metrics.selection.candidates.length<=4);
  assert.equal(one.metrics.selection.uniqueCandidatesMeasured,one.metrics.selection.candidates.length);
  assert.equal(one.metrics.selection.candidates.filter(candidate=>candidate.selected).length,1);
  assert.ok(!JSON.stringify(one.metrics.selection).includes(secret),
    'audit metadata must not contain any raw source');
});
test('non-code source and empty history remain intact and explain the selection',()=>{
  const intent={...baseIntent,allowedFiles:['styles/main.css'],questions:['Confirm final design?']};
  const source={'styles/main.css':'.root { opacity: 0.5; }'};
  const result=prepareInput(intent,source,[]);
  assert.equal(result.input.files[0].source,source['styles/main.css']);
  assert.equal(result.metrics.historyCompressed,false);
  assert.deepEqual(result.metrics.rewrittenFiles,[]);
  assert.deepEqual(unpackHistory(result.input.history,result.metrics.historySourceDigest),[]);
  assert.ok(result.input.instruction.includes('Confirm final design?'));
});
