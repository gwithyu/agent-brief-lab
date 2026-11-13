'use strict';
const {brief,tokens}=require('./index.cjs');
const {packContext}=require('./context.cjs');
const {packHistory,unpackHistory}=require('./history.cjs');
function prepareInput(intent,sources,messages,encoding='o200k_base') {
  const context=packContext(intent,sources,encoding),history=packHistory(messages,encoding);
  const restored=unpackHistory(history.input,history.metrics.sourceDigest);
  const originalFiles=intent.allowedFiles.slice().sort().map(path=>({path,source:sources[path]}));
  const originalContext={instruction:brief(intent),files:originalFiles};
  const measure=input=>{const s=JSON.stringify(input);return {tokens:tokens(s,encoding),bytes:Buffer.byteLength(s)};};
  const raw=measure({instruction:intent.request,files:originalFiles,history:restored});
  let input={...originalContext,history:restored};
  const before=measure(input);let after=before;
  for(const c of [originalContext,context.input]) for(const h of [restored,history.input]) {
    const candidate={...c,history:h},size=measure(candidate);
    if(size.tokens<after.tokens && size.bytes<after.bytes) {input=candidate;after=size;}
  }
  return {input,metrics:{encoding,rawRequestBeforeTokens:raw.tokens,guidedBeforeTokens:before.tokens,afterTokens:after.tokens,
    tokensSavedWithGuidance:before.tokens-after.tokens,netTokensSavedVersusRawRequest:raw.tokens-after.tokens,
    rawRequestBeforeBytes:raw.bytes,guidedBeforeBytes:before.bytes,afterBytes:after.bytes,
    historyCompressed:!Array.isArray(input.history),historySourceDigest:history.metrics.sourceDigest,
    rewrittenFiles:input.files.filter(file=>file.source!==sources[file.path]).map(file=>file.path)},
    scope:'One complete serialized input document. All intent fields retained. Custom history references require executor support; not native model messages, actual billing or a semantic-understanding evaluation.'};
}
module.exports={prepareInput};
