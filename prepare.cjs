'use strict';
const {tokens}=require('./index.cjs');
const {createHash}=require('node:crypto');
const {contextVariants}=require('./context.cjs');
const {packHistory,unpackHistory}=require('./history.cjs');
function prepareInput(intent,sources,messages,encoding='o200k_base',minSavingsTokens=1) {
  if(!Number.isSafeInteger(minSavingsTokens) || minSavingsTokens<1 || minSavingsTokens>1000000) {
    throw new RangeError('minSavingsTokens must be a positive safe integer at most 1000000');
  }
  const variants=contextVariants(intent,sources,encoding),history=packHistory(messages,encoding);
  const restored=unpackHistory(history.input,history.metrics.sourceDigest);
  const originalFiles=variants[0].input.files;
  const measureSerialized=s=>({tokens:tokens(s,encoding),bytes:Buffer.byteLength(s)});
  const measure=input=>measureSerialized(JSON.stringify(input));
  const digest=s=>createHash('sha256').update(s,'utf8').digest('hex');
  const raw=measure({instruction:intent.request,files:originalFiles,history:restored});
  const baseline={...variants[0].input,history:restored};
  const baselineSerialized=JSON.stringify(baseline),baselineDigest=digest(baselineSerialized);
  const before=measureSerialized(baselineSerialized);
  let input=baseline,after=before,selected={instructionFormat:'readable',historyFormat:'raw'};
  let selectedDigest=baselineDigest;
  const measurements=[{id:'readable/original/raw',tokens:before.tokens,bytes:before.bytes,selected:false,reason:'BASELINE'}];
  // A digest key avoids retaining up to eight complete copies of large source
  // and history documents solely for de-duplication. The original input is
  // still retained separately as the actual candidate; no digest is sent to the model.
  const measured=new Map([[baselineDigest,measurements[0]]]);
  let marginBlocked=false;
  // Compare *complete serialized inputs*. Never include source text or history
  // contents in diagnostics: those can contain private project data.
  for(const [index,variant] of variants.entries()) for(const [historyFormat,h] of [['raw',restored],['dictionary',history.input]]) {
    const candidate={...variant.input,history:h},serialized=JSON.stringify(candidate);
    const key=digest(serialized);
    if(measured.has(key)) continue;
    const size=measureSerialized(serialized);
    const record={id:`${variant.format}/${index<2?'original':'rewrite-candidate'}/${historyFormat}`,
      tokens:size.tokens,bytes:size.bytes,selected:false,reason:'ELIGIBLE_NOT_SELECTED'};
    if(size.tokens>=before.tokens && size.bytes>=before.bytes) record.reason='NO_GAIN_BOTH';
    else if(size.tokens>=before.tokens) record.reason='NO_TOKEN_GAIN';
    else if(size.bytes>=before.bytes) record.reason='NO_BYTE_GAIN';
    else if(before.tokens-size.tokens<minSavingsTokens) {record.reason='BELOW_MINIMUM_GAIN';marginBlocked=true;}
    else if(size.tokens<after.tokens || (size.tokens===after.tokens && size.bytes<after.bytes)) {
      input=candidate;after=size;selectedDigest=key;
      selected={instructionFormat:variant.format,historyFormat};
    }
    measurements.push(record);
    measured.set(key,record);
  }
  // Identify the final winner by its exact representation, not a temporary
  // intermediate minimum. No raw input text is included in these diagnostics.
  const winner=measured.get(selectedDigest);
  winner.selected=true;
  winner.reason=selectedDigest===baselineDigest?'BASELINE':'SELECTED';
  if(winner!==measurements[0]) measurements[0].reason='ELIGIBLE_NOT_SELECTED';
  const rewrittenFiles=input.files.filter(file=>file.source!==sources[file.path]).map(file=>file.path);
  return {input,metrics:{encoding,rawRequestBeforeTokens:raw.tokens,guidedBeforeTokens:before.tokens,afterTokens:after.tokens,
    tokensSavedWithGuidance:before.tokens-after.tokens,netTokensSavedVersusRawRequest:raw.tokens-after.tokens,
    rawRequestBeforeBytes:raw.bytes,guidedBeforeBytes:before.bytes,afterBytes:after.bytes,
    historyCompressed:!Array.isArray(input.history),historySourceDigest:history.metrics.sourceDigest,
    rewrittenFiles,
    selection:{...selected,reason:after.tokens<before.tokens?'MEASURED_GAIN':(marginBlocked?'MARGIN_NOT_MET':'NO_GAIN'),
      minSavingsTokens,uniqueCandidatesMeasured:measured.size,baselineTokens:before.tokens,baselineBytes:before.bytes,
      candidates:measurements}},
    scope:'One complete serialized input document. All intent fields retained. Custom history references require executor support; not native model messages, actual billing or a semantic-understanding evaluation.'};
}
module.exports={prepareInput};
