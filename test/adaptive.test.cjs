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
