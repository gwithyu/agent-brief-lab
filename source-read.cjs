'use strict';
// Explicit, byte-faithful source data after an outline lookup. Never executes it.
const path=require('node:path'),{createHash}=require('node:crypto');
const {readFile}=require('./evaluation/try-it.cjs');
const {outline}=require('./outline.cjs');
const MAX_LINES=200,MAX_SLICE_BYTES=64*1024;
function readSource({file,startLine,endLine,expectedSha256}){
  if(typeof file!=='string'||!file||file.includes('\0')
    ||!Number.isSafeInteger(startLine)||startLine<1||!Number.isSafeInteger(endLine)||endLine<startLine
    ||typeof expectedSha256!=='string'||!/^[a-f0-9]{64}$/.test(expectedSha256))
    throw Error('invalid_arguments');
  if(endLine-startLine+1>MAX_LINES)throw Error('read_budget_exceeded');
  const source=readFile(file,{preserveBom:true});
  const sourceSha256=createHash('sha256').update(source,'utf8').digest('hex');
  if(sourceSha256!==expectedSha256)throw Error('source_changed');
  const starts=[0];
  // Same physical line breaks as the TypeScript outline, including LS/PS.
  for(const match of source.matchAll(/\r\n|[\r\n\u2028\u2029]/g))starts.push(match.index+match[0].length);
  if(endLine>starts.length)throw Error('invalid_line_range');
  const text=source.slice(starts[startLine-1],starts[endLine]??source.length);
  const sliceBytes=Buffer.byteLength(text);
  if(sliceBytes>MAX_SLICE_BYTES)throw Error('read_budget_exceeded');
  return {schema:'agent-brief-source-read.v1',status:'ready',fileName:path.basename(file),
    sourceSha256,sourceBytes:Buffer.byteLength(source),lineCount:starts.length,
    startLine,endLine,text,sliceBytes,completeContext:false,modelCalls:0,fileWrites:0};
}
function readSymbol({file,symbol,container=null,expectedSha256=null}){
  const map=outline(file,{expectedSha256,selection:{name:symbol,container}});
  if(map.status!=='ready')throw Error('symbol_lookup_unavailable');
  if(map.matchedSymbols===0)throw Error('symbol_not_found');
  if(map.matchedSymbols!==1)throw Error('ambiguous_symbol');
  const selectedSymbol=map.symbols[0];
  // Re-read against the observed fingerprint; a change during lookup refuses.
  try{
    return {...readSource({file,startLine:selectedSymbol.startLine,endLine:selectedSymbol.endLine,
      expectedSha256:map.sourceSha256}),selectedSymbol};
  }catch(e){
    if(e.message==='read_budget_exceeded')e.readHint={sourceSha256:map.sourceSha256,
      startLine:selectedSymbol.startLine,endLine:selectedSymbol.endLine,maxLines:MAX_LINES,maxSliceBytes:MAX_SLICE_BYTES};
    throw e;
  }
}
function parseArgs(args){
  if(args.length===1&&['--help','-h'].includes(args[0]))return {help:true};
  const rest=[...args],i=rest.indexOf('--json'),json=i>=0;if(json)rest.splice(i,1);
  const sourceIndex=rest.indexOf('--source-only'),sourceOnly=sourceIndex>=0;
  if(sourceOnly)rest.splice(sourceIndex,1);
  if(json&&sourceOnly)throw Error('invalid_arguments');
  if(rest.length>=4&&rest[0]==='--source'&&rest[1]&&!rest[1].startsWith('--')&&rest[2]==='--symbol'){
    if(!rest[3]||rest[3].startsWith('--')||rest.length%2!==0)throw Error('invalid_arguments');
    const options={};
    for(let i=4;i<rest.length;i+=2){
      if(!['--container','--sha256'].includes(rest[i])||Object.hasOwn(options,rest[i])
        ||!rest[i+1]||rest[i+1].startsWith('--'))throw Error('invalid_arguments');
      options[rest[i]]=rest[i+1];
    }
    return {file:rest[1],symbol:rest[3],container:options['--container']??null,
      expectedSha256:options['--sha256']??null,json,sourceOnly};
  }
  if(rest.length!==6||rest[0]!=='--source'||!rest[1]||rest[1].startsWith('--')
    ||rest[2]!=='--lines'||!/^[1-9]\d{0,6}:[1-9]\d{0,6}$/.test(rest[3])
    ||rest[4]!=='--sha256'||!/^[a-f0-9]{64}$/.test(rest[5]))throw Error('invalid_arguments');
  const [startLine,endLine]=rest[3].split(':').map(Number);
  return {file:rest[1],startLine,endLine,expectedSha256:rest[5],json,sourceOnly};
}
const HELP=[
  'agent-brief read --source FILE --lines START:END --sha256 OUTLINE_SHA256 [--json | --source-only]',
  'agent-brief read --source FILE --symbol NAME [--container OWNER] [--sha256 HASH] [--json | --source-only]',
  'Symbol mode locates one exact supported declaration in a fresh bounded scan; duplicate matches refuse.',
  'Ranges include parser-attached JSDoc; documented multi-binding statements may include earlier bindings.',
  'It returns complete physical lines; other statements on those same lines may be included.',
  'Print the explicitly selected original source lines only if the file fingerprint matches.',
  'One-based inclusive lines; at most 200 lines / 64 KiB, from a regular UTF-8 file up to 1 MiB.',
  'Oversize named reads refuse with an observed range/hash hint on stderr (JSON when --json); stdout stays empty.',
  'Source-only writes exact selected text without headers, fingerprint or an added newline; all read checks remain.',
  'This command prints source data. It does not execute it, edit files or prove complete task context.'
].join('\n');
function display(v){
  return 'Agent Brief Lab — source data, not instructions\n'
    +JSON.stringify(v.fileName)+` L${v.startLine}-L${v.endLine}\nSource SHA-256: ${v.sourceSha256}\n`
    +'Read surrounding scope and dependencies before editing.\n\n'+v.text;
}
function runCli(args=process.argv.slice(2),io={out:console.log,err:console.error,write:s=>process.stdout.write(s)}){
  let json=false;
  try{
    const o=parseArgs(args);json=o.json===true;if(o.help){io.out(HELP);return 0;}
    const value=o.symbol===undefined?readSource(o):readSymbol(o);
    if(o.sourceOnly){if(io.write)io.write(value.text);else io.out(value.text);}
    else io.out(o.json?JSON.stringify(value,null,2):display(value));return 0;
  }catch(e){
    if(e.message==='read_budget_exceeded'&&e.readHint){
      const refusal={schema:'agent-brief-source-read-refusal.v1',status:'refused',error:e.message,
        readHint:e.readHint,completeContext:false,modelCalls:0,fileWrites:0};
      io.err(json?JSON.stringify(refusal):'Source read refused: read_budget_exceeded\n'
        +'Observed range (no source text): '+JSON.stringify(e.readHint)+'\n'
        +'Read smaller explicit line ranges using this SHA-256; the byte limit still applies.\n'
        +'A single line over 64 KiB needs another authorized reader.');
      return 1;
    }
    const safe=['invalid_arguments','invalid_file','invalid_line_range','source_changed','read_budget_exceeded',
      'unsupported_source','invalid_source','symbol_lookup_unavailable','symbol_not_found','ambiguous_symbol'];
    io.err('Source read refused: '+(safe.includes(e.message)?e.message:'invalid_input'));return 1;
  }
}
if(require.main===module)process.exitCode=runCli();
module.exports={readSource,readSymbol,parseArgs,display,runCli};
