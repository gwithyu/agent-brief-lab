'use strict';
// Export two directly readable prompts with identical task/source semantics.
// No model invocation, code rewrite, history references or file execution.
const fs=require('node:fs'),os=require('node:os'),path=require('node:path');
const {createHash}=require('node:crypto');
const {isDeepStrictEqual}=require('node:util');
const {validateIntent,intentDigest,tokens}=require('./index.cjs');

const MAX_INPUT=768*1024;
const MAX_SAFE_TOKENIZE_BYTES=8192;
const MARKER='JSON DOCUMENT:\n';
const sha=s=>createHash('sha256').update(s,'utf8').digest('hex');
function regularFile(name){
  const stat=fs.lstatSync(name);
  if(stat.isSymbolicLink()||!stat.isFile()||stat.size>MAX_INPUT||stat.size===0)
    throw Error('invalid_private_file');
  const content=fs.readFileSync(name);
  if(content.length>MAX_INPUT||content.includes(0)||!content.equals(Buffer.from(content.toString('utf8'),'utf8')))
    throw Error('invalid_private_file');
  return content.toString('utf8');
}
function inside(base,other){
  const rel=path.relative(base,other);
  return rel===''||(!rel.startsWith('..'+path.sep)&&rel!=='..'&&!path.isAbsolute(rel));
}
function resolveDirs(input,out){
  const stat=fs.lstatSync(input);
  if(stat.isSymbolicLink()||!stat.isDirectory())throw Error('invalid_private_directory');
  const source=fs.realpathSync(input);
  const temp=fs.realpathSync(os.tmpdir());
  if(!inside(temp,source))throw Error('handoff_must_be_under_system_temp');
  if(fs.existsSync(out)||fs.existsSync(path.resolve(out)))throw Error('output_must_be_new');
  const output=path.join(fs.realpathSync(path.dirname(path.resolve(out))),path.basename(path.resolve(out)));
  if(!inside(temp,output)||output===temp||inside(source,output)||inside(output,source))
    throw Error('invalid_pair_output_location');
  return {source,output};
}
function readHandoff(dir){
  const intent=JSON.parse(regularFile(path.join(dir,'intent.json')));
  validateIntent(intent);
  const baseline=JSON.parse(regularFile(path.join(dir,'baseline.json')));
  if(!baseline||baseline.intentDigest!==intentDigest(intent)
    ||!baseline.sources||typeof baseline.sources!=='object'||Array.isArray(baseline.sources))
    throw Error('handoff_identity_mismatch');
  const text=regularFile(path.join(dir,'handoff.txt'));
  if(!text.startsWith('Agent Brief Lab')||text.indexOf(MARKER)<0)
    throw Error('invalid_native_handoff');
  const cut=text.indexOf(MARKER)+MARKER.length;
  const prefix=text.slice(0,cut);
  const doc=JSON.parse(text.slice(cut));
  const exactFields=['request','allowedFiles','constraints','acceptanceToRun','sourceFiles'];
  if(!doc||Array.isArray(doc)||typeof doc!=='object'
    ||Object.keys(doc).length!==exactFields.length
    ||exactFields.some(k=>!Object.hasOwn(doc,k))
    ||text!==prefix+JSON.stringify(doc,null,2)+'\n')
    throw Error('invalid_native_handoff');
  const originals=intent.allowedFiles.map(file=>({path:file,source:baseline.sources[file]}));
  if(originals.some(x=>typeof x.source!=='string')
    ||!isDeepStrictEqual(doc.request,intent.request)
    ||!isDeepStrictEqual(doc.allowedFiles,intent.allowedFiles)
    ||!isDeepStrictEqual(doc.constraints,intent.constraints)
    ||!isDeepStrictEqual(doc.acceptanceToRun,intent.acceptance)
    ||!isDeepStrictEqual(doc.sourceFiles,originals))
    throw Error('handoff_content_mismatch');
  // Revalidate each selected source against the SHA-256 recorded at capture.
  for(const entry of originals){
    const recorded=baseline.files?.find(x=>x.path===entry.path);
    if(!recorded||recorded.state!=='file'||recorded.sha256!==sha(entry.source))
      throw Error('handoff_source_fingerprint_mismatch');
  }
  return {intent,raw:text,prefix,doc};
}
function planPair(raw,prefix,doc){
  const candidate=prefix+JSON.stringify(doc)+'\n';
  const rawBytes=Buffer.byteLength(raw),candidateBytes=Buffer.byteLength(candidate);
  // Tokenizers can consume pathological RAM on large repeated input. Restrict
  // tokenized data, and don't use byte savings to invent a token reduction.
  const safe=rawBytes<=MAX_SAFE_TOKENIZE_BYTES
    &&candidateBytes<=MAX_SAFE_TOKENIZE_BYTES
    &&!/([^\s])\1{256}/u.test(raw)
    &&!/([^\s])\1{256}/u.test(candidate);
  let rawTokens=null,candidateTokens=null;
  if(safe){
    rawTokens=tokens(raw);
    candidateTokens=tokens(candidate);
  }
  const useCompact=safe&&candidateBytes<rawBytes&&candidateTokens<rawTokens;
  const selected=useCompact?candidate:raw;
  const report={
    schema:'agent-brief-native-pair.v1',
    selection:useCompact?'compact_native_json':'raw_fallback',
    reason:useCompact?'FEWER_LOCAL_TEXT_TOKENS_AND_BYTES':safe?'NO_MEASURED_GAIN':'TOKEN_COUNT_NOT_SAFELY_MEASURABLE',
    contentIdentityVerified:true,sourceCodeRewritten:false,
    customDictionaryReferences:false,modelCalls:0,
    rawBytes,preparedBytes:Buffer.byteLength(selected),
    byteSavings:rawBytes-Buffer.byteLength(selected),
    rawLocalTextTokens:rawTokens,
    preparedLocalTextTokens:useCompact?candidateTokens:rawTokens,
    localTextTokensSaved:rawTokens===null?null:rawTokens-(useCompact?candidateTokens:rawTokens),
    rawSha256:sha(raw),preparedSha256:sha(selected),
    providerInputTokens:null,providerCostUsd:null,
    qualityEvidence:'NO_MODEL_OUTCOMES',
    warning:'Only JSON formatting differs. Identical decoded task, constraints and source text. Local text counts are not provider billing or evidence of equal model behavior.'
  };
  return {raw,prepared:selected,report};
}
function makePair(opts){
  if(!opts||typeof opts!=='object'||typeof opts.handoff!=='string'||typeof opts.out!=='string')
    throw Error('invalid_pair_arguments');
  const {source,output}=resolveDirs(opts.handoff,opts.out);
  const {intent,raw,prefix,doc}=readHandoff(source);
  const result=planPair(raw,prefix,doc);
  const decoded=JSON.parse(result.prepared.slice(prefix.length));
  if(!isDeepStrictEqual(decoded,doc))throw Error('pair_content_mismatch');
  const report={...result.report,intentDigest:intentDigest(intent)};
  fs.mkdirSync(output,{mode:0o700});
  try{
    const write=(name,data)=>fs.writeFileSync(path.join(output,name),data,{flag:'wx',mode:0o600});
    write('raw.txt',result.raw);
    write('prepared.txt',result.prepared);
    write('pair-report.json',JSON.stringify(report,null,2)+'\n');
  }catch(error){
    fs.rmSync(output,{recursive:true,force:true});
    throw error;
  }
  return {
    state:'ready_for_manual_paired_trial',
    rawFile:path.join(output,'raw.txt'),preparedFile:path.join(output,'prepared.txt'),
    selection:report.selection,reason:report.reason,
    rawLocalTextTokens:report.rawLocalTextTokens,
    preparedLocalTextTokens:report.preparedLocalTextTokens,
    localTextTokensSaved:report.localTextTokensSaved,
    modelCalls:0,providerCostUsd:null
  };
}
function parseArgs(args){
  if(args.length===1&&['--help','-h'].includes(args[0]))return {help:true};
  if(args.length!==4||args[0]!=='--handoff'||args[2]!=='--out'
    ||!args[1]||!args[3])throw Error('invalid_pair_arguments');
  return {handoff:args[1],out:args[3]};
}
const HELP=[
  'Compare original vs compact native-JSON task prompts from an existing private handoff.',
  'agent-brief pair --handoff PRIVATE_HANDOFF_DIR --out NEW_PRIVATE_TEMP_DIR',
  'Both variants contain identical task, constraints and source code.',
  'No model calls or USD savings claims. Long/repetitive input falls back to raw.',
].join('\n');
function runCli(args=process.argv.slice(2),io={out:console.log,err:console.error}){
  try{
    const parsed=parseArgs(args);
    if(parsed.help){io.out(HELP);return 0;}
    io.out(JSON.stringify(makePair(parsed),null,2));
    return 0;
  }catch(error){
    const allowed=new Set(['invalid_pair_arguments','invalid_private_file',
      'invalid_private_directory','handoff_must_be_under_system_temp',
      'output_must_be_new','invalid_pair_output_location',
      'handoff_identity_mismatch','invalid_native_handoff',
      'handoff_content_mismatch','handoff_source_fingerprint_mismatch',
      'pair_content_mismatch']);
    io.err('Paired handoff refused: '+(allowed.has(error.message)?error.message:'invalid_or_unsafe_bundle'));
    return 1;
  }
}
if(require.main===module)process.exitCode=runCli();
module.exports={parseArgs,resolveDirs,readHandoff,planPair,makePair,runCli};
