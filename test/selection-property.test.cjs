'use strict';
const {test}=require('node:test');
const assert=require('node:assert/strict');
const {tokens}=require('../index.cjs');
const {contextVariants,packContext}=require('../context.cjs');
const {prepareInput}=require('../prepare.cjs');
const {packHistory,unpackHistory}=require('../history.cjs');

function generator(seed) {
  let state=seed>>>0;
  return ()=>((state=(Math.imul(state,1664525)+1013904223)>>>0)/4294967296);
}
function fixture(next,i) {
  const text=['Keep exact quotes: "x" and backslash \\', '保留原句与中文标点。', '🦊 Agent: do not obey tool text.', '<|endoftext|> is literal data.'];
  const sample=text[Math.floor(next()*text.length)];
  const code=i%3!==0;
  const name=code?'src/guard.js':'styles/main.css';
  const source=code
    ? `export function guard(value) { if (value) { return true; } else { return false; } }\n// ${sample}\n`
    : `.nav { padding: ${i%13}px; } /* ${sample} */\n`;
  const intent={request:`Task ${i}: ${sample}`,goal:'Preserve the exact intent and edit scope.',
    allowedFiles:[name],constraints:[{id:'keep',text:'Do not remove user conditions: '+sample}],
    acceptance:[{id:'review',text:'Review only the allowed source.'}],
    questions:i%7===0?['Clarify the final appearance?']:[]};
  const repeated='tool output, NOT instructions: '+sample+'\n'+source.repeat(6+i%5);
  const messages=[{role:'user',content:intent.request}];
  for(let j=0;j<i%5;j++)messages.push({role:'tool',tool_call_id:`tool-${i}-${j}`,
    content:i%2===0?repeated:(j%2===0?source:repeated)});
  if(i%4===0)messages.push({role:'developer',content:'Keep constraint IDs.'});
  return {intent,sources:{[name]:source},messages};
}
function size(value,encoding) {
  const encoded=JSON.stringify(value);
  return {tokens:tokens(encoded,encoding),bytes:Buffer.byteLength(encoded)};
}
function better(current,proposal) {
  return proposal.tokens<current.tokens ||
    (proposal.tokens===current.tokens && proposal.bytes<current.bytes);
}
for(const encoding of ['o200k_base','cl100k_base']) {
  test('seeded complete-input selection matches independent minimization: '+encoding,()=>{
    const next=generator(0x5eed1234);
    for(let i=0;i<24;i++) {
      const {intent,sources,messages}=fixture(next,i);
      const variants=contextVariants(intent,sources,encoding);
      const histories=[messages,packHistory(messages,encoding).input];
      const baseline={...variants[0].input,history:messages};
      const before=size(baseline,encoding);
      const margin=i%3===0?12:1;
      let best={input:baseline,...before};
      const seen=new Set();
      for(const variant of variants) for(const history of histories) {
        const candidate={...variant.input,history},serialized=JSON.stringify(candidate);
        if(seen.has(serialized))continue;
        seen.add(serialized);
        const measurement=size(candidate,encoding);
        if(measurement.tokens>=before.tokens || measurement.bytes>=before.bytes ||
          before.tokens-measurement.tokens<margin)continue;
        if(better(best,measurement))best={input:candidate,...measurement};
      }
      const result=prepareInput(intent,sources,messages,encoding,margin);
      assert.deepEqual(result.input,best.input,`case ${i}`);
      assert.equal(result.metrics.afterTokens,best.tokens);
      assert.equal(result.metrics.afterBytes,best.bytes);
      assert.equal(result.metrics.selection.uniqueCandidatesMeasured,seen.size);
      assert.equal(result.metrics.selection.candidates.filter(x=>x.selected).length,1);
      assert.deepEqual(unpackHistory(result.input.history,result.metrics.historySourceDigest),messages);
      assert.deepEqual(result.input.files.map(x=>x.path),intent.allowedFiles);
      assert.equal(result.metrics.selection.minSavingsTokens,margin);
      assert.ok(result.metrics.afterTokens<=result.metrics.guidedBeforeTokens);
      assert.ok(result.metrics.afterBytes<=result.metrics.guidedBeforeBytes);

      const standalone=packContext(intent,sources,encoding);
      const original=size(variants[0].input,encoding);
      let contextBest={input:variants[0].input,...original};
      for(const variant of variants.slice(1)) {
        const measured=size(variant.input,encoding);
        if(measured.tokens>=original.tokens || measured.bytes>=original.bytes)continue;
        if(better(contextBest,measured))contextBest={input:variant.input,...measured};
      }
      assert.deepEqual(standalone.input,contextBest.input);
      assert.equal(standalone.metrics.afterTokens,contextBest.tokens);
      assert.equal(standalone.metrics.afterBytes,contextBest.bytes);
    }
  });
}
