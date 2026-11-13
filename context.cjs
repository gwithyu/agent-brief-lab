'use strict';
const {tokens,brief,intentDigest,validateIntent,simplify}=require('./index.cjs');
function compactBrief(intent) {
  validateIntent(intent);
  const entries=items=>Object.fromEntries(items.map(({id,text})=>[id,text]));
  return JSON.stringify({intentDigest:intentDigest(intent),request:intent.request,goal:intent.goal,
    allowedFiles:intent.allowedFiles,constraints:entries(intent.constraints),acceptance:entries(intent.acceptance),questions:intent.questions});
}
function packContext(intent,sources,encoding='o200k_base') {
  validateIntent(intent);
  if(!sources || typeof sources!=='object' || Array.isArray(sources)
    || Object.keys(sources).length!==intent.allowedFiles.length
    || intent.allowedFiles.some(file=>!Object.hasOwn(sources,file) || typeof sources[file]!=='string')) {
    throw new Error('Context must contain exactly all allowed source files');
  }
  const files=intent.allowedFiles.slice().sort().map(path=>({path,source:sources[path]}));
  const envelope=(instruction,files)=>({instruction,files});
  const size=value=>{const s=JSON.stringify(value);return {tokens:tokens(s,encoding),bytes:Buffer.byteLength(s)};};
  const baseline=envelope(brief(intent),files),before=size(baseline),raw=size(envelope(intent.request,files));
  let input=baseline,current=before,briefFormat='readable';
  const consider=(candidate,format)=>{
    const measured=size(candidate);
    if(measured.tokens<current.tokens && measured.bytes<current.bytes) {
      input=candidate;current=measured;briefFormat=format;
    }
  };
  consider(envelope(compactBrief(intent),files),'json');
  const rewritten=files.map(file=>{
    if(!/\.(?:[cm]?[jt]s|[jt]sx)$/.test(file.path) || /\.d\.[cm]?ts$/.test(file.path)) return file;
    return {...file,source:simplify(file.source,file.path,encoding).code};
  });
  // Evaluate the entire serialized input: escaping can erase source-only savings.
  consider(envelope(brief(intent),rewritten),'readable');
  consider(envelope(compactBrief(intent),rewritten),'json');
  return {input,metrics:{encoding,briefFormat,beforeTokens:before.tokens,afterTokens:current.tokens,
    tokensSaved:before.tokens-current.tokens,beforeBytes:before.bytes,afterBytes:current.bytes,
    rawRequestBeforeTokens:raw.tokens,addedVersusRawRequest:current.tokens-raw.tokens,
    rewrittenFiles:input.files.filter((file,i)=>file.source!==files[i].source).map(file=>file.path)},
    scope:'One serialized input envelope; preserves every intent field. No execution or full-agent cost measurement'};
}
module.exports={compactBrief,packContext};
