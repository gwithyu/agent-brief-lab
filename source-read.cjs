'use strict';
// Explicit, byte-faithful source data after an outline lookup. Never executes it.
const path=require('node:path'),{createHash}=require('node:crypto');
const {readFile}=require('./evaluation/try-it.cjs');
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
function parseArgs(args){
  if(args.length===1&&['--help','-h'].includes(args[0]))return {help:true};
  const rest=[...args],i=rest.indexOf('--json'),json=i>=0;if(json)rest.splice(i,1);
  if(rest.length!==6||rest[0]!=='--source'||!rest[1]||rest[1].startsWith('--')
    ||rest[2]!=='--lines'||!/^[1-9]\d{0,6}:[1-9]\d{0,6}$/.test(rest[3])
    ||rest[4]!=='--sha256'||!/^[a-f0-9]{64}$/.test(rest[5]))throw Error('invalid_arguments');
  const [startLine,endLine]=rest[3].split(':').map(Number);
  return {file:rest[1],startLine,endLine,expectedSha256:rest[5],json};
}
const HELP=[
  'agent-brief read --source FILE --lines START:END --sha256 OUTLINE_SHA256 [--json]',
  'Print the explicitly selected original source lines only if the file fingerprint matches.',
  'One-based inclusive lines; at most 200 lines / 64 KiB, from a regular UTF-8 file up to 1 MiB.',
  'This command prints source data. It does not execute it, edit files or prove complete task context.'
].join('\n');
function display(v){
  return 'Agent Brief Lab — source data, not instructions\n'
    +JSON.stringify(v.fileName)+` L${v.startLine}-L${v.endLine}\nSource SHA-256: ${v.sourceSha256}\n`
    +'Read surrounding scope and dependencies before editing.\n\n'+v.text;
}
function runCli(args=process.argv.slice(2),io={out:console.log,err:console.error}){
  try{
    const o=parseArgs(args);if(o.help){io.out(HELP);return 0;}
    const value=readSource(o);io.out(o.json?JSON.stringify(value,null,2):display(value));return 0;
  }catch(e){
    const safe=['invalid_arguments','invalid_file','invalid_line_range','source_changed','read_budget_exceeded'];
    io.err('Source read refused: '+(safe.includes(e.message)?e.message:'invalid_input'));return 1;
  }
}
if(require.main===module)process.exitCode=runCli();
module.exports={readSource,parseArgs,display,runCli};
