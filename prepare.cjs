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
  const baselineSerialized=JSON.stringify(baseline);
  const measurements=[{id:'readable/original/raw',tokens:before.tokens,bytes:before.bytes,selected:false,reason:'BASELINE'}];
  const measured=new Map([[baselineSerialized,measurements[0]]]);
  // Compare *complete serialized inputs*. Never include source text or history
  // contents in diagnostics: those can contain private project data.
  for(const [index,variant] of variants.entries()) for(const [historyFormat,h] of [['raw',restored],['dictionary',history.input]]) {
    const candidate={...variant.input,history:h},serialized=JSON.stringify(candidate);
    if(measured.has(serialized)) continue;
    const size=measure(candidate);
    const record={id:`${variant.format}/${index<2?'original':'rewrite-candidate'}/${historyFormat}`,
      tokens:size.tokens,bytes:size.bytes,selected:false,reason:'ELIGIBLE_NOT_SELECTED'};
    if(size.tokens>=before.tokens && size.bytes>=before.bytes) record.reason='NO_GAIN_BOTH';
    else if(size.tokens>=before.tokens) record.reason='NO_TOKEN_GAIN';
    else if(size.bytes>=before.bytes) record.reason='NO_BYTE_GAIN';
    else if(size.tokens<after.tokens || (size.tokens===after.tokens && size.bytes<after.bytes)) {
      input=candidate;after=size;selected={instructionFormat:variant.format,historyFormat};
    }
    measurements.push(record);
    measured.set(serialized,record);
  }
  // Identify the final winner by its exact representation, not a temporary
  // intermediate minimum. No raw input text is included in these diagnostics.
  const winner=measured.get(JSON.stringify(input));
  winner.selected=true;
  winner.reason=JSON.stringify(input)===baselineSerialized?'BASELINE':'SELECTED';
  if(winner!==measurements[0]) measurements[0].reason='ELIGIBLE_NOT_SELECTED';
  const rewrittenFiles=input.files.filter(file=>file.source!==sources[file.path]).map(file=>file.path);
  return {input,metrics:{encoding,rawRequestBeforeTokens:raw.tokens,guidedBeforeTokens:before.tokens,afterTokens:after.tokens,
    tokensSavedWithGuidance:before.tokens-after.tokens,netTokensSavedVersusRawRequest:raw.tokens-after.tokens,
    rawRequestBeforeBytes:raw.bytes,guidedBeforeBytes:before.bytes,afterBytes:after.bytes,
    historyCompressed:!Array.isArray(input.history),historySourceDigest:history.metrics.sourceDigest,
    rewrittenFiles,
    selection:{...selected,reason:after.tokens<before.tokens?'MEASURED_GAIN':'NO_GAIN',
      uniqueCandidatesMeasured:measured.size,baselineTokens:before.tokens,baselineBytes:before.bytes,
      candidates:measurements}},
    scope:'One complete serialized input document. All intent fields retained. Custom history references require executor support; not native model messages, actual billing or a semantic-understanding evaluation.'};
}
module.exports={prepareInput};
