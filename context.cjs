'use strict';
const {tokens,brief,intentDigest,validateIntent,simplify}=require('./index.cjs');
function compactBrief(intent) {
  validateIntent(intent);
  const entries=items=>Object.fromEntries(items.map(({id,text})=>[id,text]));
  return JSON.stringify({intentDigest:intentDigest(intent),request:intent.request,goal:intent.goal,
    allowedFiles:intent.allowedFiles,constraints:entries(intent.constraints),acceptance:entries(intent.acceptance),questions:intent.questions});
}
// All complete context candidates are exposed so prepare can compare them in
// the final envelope, rather than committing to a context-only winner.
function contextVariants(intent,sources,encoding='o200k_base') {
  validateIntent(intent);
  if(!sources || typeof sources!=='object' || Array.isArray(sources)
    || Object.keys(sources).length!==intent.allowedFiles.length
    || intent.allowedFiles.some(file=>!Object.hasOwn(sources,file) || typeof sources[file]!=='string')) {
    throw new Error('Context must contain exactly all allowed source files');
  }
  const files=intent.allowedFiles.slice().sort().map(path=>({path,source:sources[path]}));
  const rewritten=files.map(file=>{
    if(!/\.(?:[cm]?[jt]s|[jt]sx)$/.test(file.path) || /\.d\.[cm]?ts$/.test(file.path)) return file;
    return {...file,source:simplify(file.source,file.path,encoding).code};
  });
  const readable=brief(intent),json=compactBrief(intent);
  return [
    {format:'readable',input:{instruction:readable,files}},
    {format:'json',input:{instruction:json,files}},
    {format:'readable',input:{instruction:readable,files:rewritten}},
    {format:'json',input:{instruction:json,files:rewritten}}
  ];
}
function packContext(intent,sources,encoding='o200k_base') {
  const variants=contextVariants(intent,sources,encoding);
  const files=variants[0].input.files;
  const size=value=>{const s=JSON.stringify(value);return {tokens:tokens(s,encoding),bytes:Buffer.byteLength(s)};};
  const baseline=variants[0].input,before=size(baseline),raw=size({instruction:intent.request,files});
  let input=baseline,current=before,briefFormat='readable';
  for(const variant of variants.slice(1)) {
    const measured=size(variant.input);
    // The byte budget is anchored to the original guided input. A candidate
    // with fewer tokens must not lose merely because it is slightly larger
    // than an intermediate winner while still beating that original budget.
    if(measured.tokens>=before.tokens || measured.bytes>=before.bytes) continue;
    if(measured.tokens<current.tokens || (measured.tokens===current.tokens && measured.bytes<current.bytes)) {
      input=variant.input;current=measured;briefFormat=variant.format;
    }
  }
  return {input,metrics:{encoding,briefFormat,beforeTokens:before.tokens,afterTokens:current.tokens,
    tokensSaved:before.tokens-current.tokens,beforeBytes:before.bytes,afterBytes:current.bytes,
    rawRequestBeforeTokens:raw.tokens,addedVersusRawRequest:current.tokens-raw.tokens,
    rewrittenFiles:input.files.filter((file,i)=>file.source!==files[i].source).map(file=>file.path)},
    scope:'One serialized input envelope; preserves every intent field. No execution or full-agent cost measurement'};
}
module.exports={compactBrief,contextVariants,packContext};
