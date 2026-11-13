'use strict';
const {tokens}=require('./index.cjs');
const {contextVariants}=require('./context.cjs');
const {packHistory,unpackHistory}=require('./history.cjs');
function prepareInput(intent,sources,messages,encoding='o200k_base') {
  const variants=contextVariants(intent,sources,encoding),history=packHistory(messages,encoding);
  const restored=unpackHistory(history.input,history.metrics.sourceDigest);
  const originalFiles=variants[0].input.files;
  const measure=input=>{const s=JSON.stringify(input);return {tokens:tokens(s,encoding),bytes:Buffer.byteLength(s)};};
  const raw=measure({instruction:intent.request,files:originalFiles,history:restored});
  const baseline={...variants[0].input,history:restored},before=measure(baseline);
  let input=baseline,after=before,selected={instructionFormat:'readable',historyFormat:'raw'};
  const measured=new Set([JSON.stringify(baseline)]);
  // The minimization target is *complete serialized input*, not the context
  // or dictionary in isolation. Both bytes and tokens must beat the baseline.
  for(const variant of variants) for(const [historyFormat,h] of [['raw',restored],['dictionary',history.input]]) {
    const candidate={...variant.input,history:h},serialized=JSON.stringify(candidate);
    if(measured.has(serialized)) continue;
    measured.add(serialized);
    const size=measure(candidate);
    if(size.tokens>=before.tokens || size.bytes>=before.bytes) continue;
    if(size.tokens<after.tokens || (size.tokens===after.tokens && size.bytes<after.bytes)) {
      input=candidate;after=size;selected={instructionFormat:variant.format,historyFormat};
    }
  }
  const rewrittenFiles=input.files.filter(file=>file.source!==sources[file.path]).map(file=>file.path);
  return {input,metrics:{encoding,rawRequestBeforeTokens:raw.tokens,guidedBeforeTokens:before.tokens,afterTokens:after.tokens,
    tokensSavedWithGuidance:before.tokens-after.tokens,netTokensSavedVersusRawRequest:raw.tokens-after.tokens,
    rawRequestBeforeBytes:raw.bytes,guidedBeforeBytes:before.bytes,afterBytes:after.bytes,
    historyCompressed:!Array.isArray(input.history),historySourceDigest:history.metrics.sourceDigest,
    rewrittenFiles,
    selection:{...selected,reason:after.tokens<before.tokens?'MEASURED_GAIN':'NO_GAIN',
      uniqueCandidatesMeasured:measured.size,baselineTokens:before.tokens,baselineBytes:before.bytes}},
    scope:'One complete serialized input document. All intent fields retained. Custom history references require executor support; not native model messages, actual billing or a semantic-understanding evaluation.'};
}
module.exports={prepareInput};
