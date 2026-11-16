'use strict';
// A locator for deliberate source reads, not a replacement for task context.
const fs=require('node:fs'),path=require('node:path'),ts=require('typescript');
const {createHash}=require('node:crypto'),{spawnSync}=require('node:child_process');
const {sourceFile}=require('./index.cjs');
const {readFile}=require('./evaluation/try-it.cjs');
const MAX_BYTES=1024*1024,MAX_SYMBOLS=500;
const kinds=['import','function','class','method','constructor','getter','setter','interface','type','enum','namespace'];
const sha=text=>createHash('sha256').update(text,'utf8').digest('hex');
const identifier=node=>node&&(ts.isIdentifier(node)||ts.isPrivateIdentifier(node))&&node.text.length<=128?node.text:null;
const supported=name=>typeof name==='string'&&/\.(?:[cm]?[jt]s|[jt]sx)$/.test(name)&&!/\.d\.[cm]?ts$/.test(name);
const requireCall=node=>node&&ts.isCallExpression(node)&&ts.isIdentifier(node.expression)
  &&node.expression.text==='require'&&node.arguments.length===1&&ts.isStringLiteral(node.arguments[0]);
const callable=node=>node&&(ts.isArrowFunction(node)||ts.isFunctionExpression(node));
const moduleExports=node=>ts.isPropertyAccessExpression(node)&&ts.isIdentifier(node.expression)
  &&node.expression.text==='module'&&node.name.text==='exports';
const validSelection=s=>s===null||s&&Object.keys(s).sort().join(',')==='container,name'
  &&typeof s.name==='string'&&s.name.length>0&&s.name.length<=128&&!s.name.includes('\0')
  &&(s.container===null||typeof s.container==='string'&&s.container.length>0&&s.container.length<=128&&!s.container.includes('\0'));
function analyze(source,name,{offset=0,selection=null}={}){
  if(typeof source!=='string'||Buffer.byteLength(source)>MAX_BYTES)throw Error('invalid_file');
  if(!supported(name))throw Error('unsupported_source');
  if(!Number.isSafeInteger(offset)||offset<0||!validSelection(selection))throw Error('invalid_arguments');
  let parsed;
  try{parsed=sourceFile(source,name)}catch{throw Error('invalid_source');}
  const symbols=[];let totalSymbols=0,matchedSymbols=0,unlistedTopLevelStatements=0;
  const add=(node,kind,name,container=null,documentationNode=node)=>{
    totalSymbols++;
    if(selection&&(name!==selection.name||selection.container!==null&&container!==selection.container))return;
    matchedSymbols++;
    if(matchedSymbols<=offset||symbols.length===MAX_SYMBOLS)return;
    // Variable/assignment docs belong to the containing statement in the AST.
    // Keep one contiguous range, including any earlier bindings in that statement.
    const start=(documentationNode.jsDoc?.length?documentationNode:node).getStart(parsed,true),end=Math.max(start,node.end-1);
    symbols.push({kind,name,container,
      startLine:parsed.getLineAndCharacterOfPosition(start).line+1,
      endLine:parsed.getLineAndCharacterOfPosition(end).line+1});
  };
  const addMembers=(members,container)=>{
    for(const member of members){
      if(ts.isConstructorDeclaration(member))add(member,'constructor','constructor',container);
      else if(ts.isMethodDeclaration(member))add(member,'method',identifier(member.name),container);
      else if(ts.isGetAccessorDeclaration(member))add(member,'getter',identifier(member.name),container);
      else if(ts.isSetAccessorDeclaration(member))add(member,'setter',identifier(member.name),container);
      else if((ts.isPropertyDeclaration(member)||ts.isPropertyAssignment(member))&&callable(member.initializer))
        add(member,'method',identifier(member.name),container);
    }
  };
  for(const node of parsed.statements){
    const before=totalSymbols,name=identifier(node.name);
    if(ts.isImportDeclaration(node)||ts.isImportEqualsDeclaration(node))add(node,'import',null);
    else if(ts.isFunctionDeclaration(node))add(node,'function',name);
    else if(ts.isClassDeclaration(node)){
      add(node,'class',name);
      addMembers(node.members,name);
    }else if(ts.isVariableStatement(node)){
      for(const declaration of node.declarationList.declarations){
        if(callable(declaration.initializer))add(declaration,'function',identifier(declaration.name),null,node);
        else if(declaration.initializer&&ts.isObjectLiteralExpression(declaration.initializer))
          addMembers(declaration.initializer.properties,identifier(declaration.name));
        else if(requireCall(declaration.initializer))add(declaration,'import',null,null,node);
      }
    }else if(ts.isExpressionStatement(node)&&requireCall(node.expression))add(node,'import',null);
    else if(ts.isExpressionStatement(node)&&ts.isBinaryExpression(node.expression)
      &&node.expression.operatorToken.kind===ts.SyntaxKind.EqualsToken){
      const {left,right}=node.expression;
      if(moduleExports(left)){
        if(ts.isObjectLiteralExpression(right))addMembers(right.properties,'module.exports');
        else if(callable(right))add(node.expression,'function','exports','module',node);
      }else if(ts.isPropertyAccessExpression(left)&&callable(right)){
        const owner=left.expression;
        if(ts.isIdentifier(owner)&&owner.text==='exports')add(node.expression,'function',identifier(left.name),'exports',node);
        else if(moduleExports(owner))add(node.expression,'function',identifier(left.name),'module.exports',node);
      }
    }
    else if(ts.isInterfaceDeclaration(node))add(node,'interface',name);
    else if(ts.isTypeAliasDeclaration(node))add(node,'type',name);
    else if(ts.isEnumDeclaration(node))add(node,'enum',name);
    else if(ts.isModuleDeclaration(node))add(node,'namespace',name);
    if(totalSymbols===before)unlistedTopLevelStatements++;
  }
  if(offset>0&&offset>=matchedSymbols)throw Error('invalid_outline_offset');
  const nextOffset=offset+symbols.length<matchedSymbols?offset+symbols.length:null;
  return {schema:'agent-brief-outline.v1',status:'ready',fileName:path.basename(name),
    sourceSha256:sha(source),sourceBytes:Buffer.byteLength(source),lineCount:parsed.getLineStarts().length,
    symbols,totalSymbols,offset,nextOffset,truncated:nextOffset!==null,unlistedTopLevelStatements,
    ...(selection?{selection,matchedSymbols}:{}),
    completeContext:false,modelCalls:0,fileWrites:0};
}
function validResult(v,source,name,offset,selection){
  const uint=n=>Number.isSafeInteger(n)&&n>=0;
  return v&&Object.keys(v).sort().join(',')===
    (selection?'completeContext,fileName,fileWrites,lineCount,matchedSymbols,modelCalls,nextOffset,offset,schema,selection,sourceBytes,sourceSha256,status,symbols,totalSymbols,truncated,unlistedTopLevelStatements'
      :'completeContext,fileName,fileWrites,lineCount,modelCalls,nextOffset,offset,schema,sourceBytes,sourceSha256,status,symbols,totalSymbols,truncated,unlistedTopLevelStatements')
    &&v.schema==='agent-brief-outline.v1'&&v.status==='ready'&&v.fileName===name
    &&v.sourceSha256===sha(source)&&v.sourceBytes===Buffer.byteLength(source)
    &&v.completeContext===false&&v.modelCalls===0&&v.fileWrites===0
    &&uint(v.lineCount)&&v.lineCount>0&&uint(v.totalSymbols)&&uint(v.unlistedTopLevelStatements)
    &&(!selection||v.selection?.name===selection.name&&v.selection?.container===selection.container
      &&Object.keys(v.selection).sort().join(',')==='container,name'&&uint(v.matchedSymbols)&&v.matchedSymbols<=v.totalSymbols)
    &&v.offset===offset&&(offset===0||offset<(selection?v.matchedSymbols:v.totalSymbols))
    &&Array.isArray(v.symbols)&&v.symbols.length===Math.min(MAX_SYMBOLS,(selection?v.matchedSymbols:v.totalSymbols)-offset)
    &&v.truncated===(offset+v.symbols.length<(selection?v.matchedSymbols:v.totalSymbols))
    &&v.nextOffset===(v.truncated?offset+v.symbols.length:null)
    &&v.symbols.every(s=>s&&Object.keys(s).sort().join(',')==='container,endLine,kind,name,startLine'
      &&kinds.includes(s.kind)&&[s.name,s.container].every(n=>n===null||typeof n==='string'&&n.length<=128)
      &&(!selection||s.name===selection.name&&(selection.container===null||s.container===selection.container))
      &&uint(s.startLine)&&s.startLine>0&&uint(s.endLine)&&s.endLine>=s.startLine&&s.endLine<=v.lineCount);
}
function outline(file,{offset=0,expectedSha256=null,selection=null}={}){
  if(!Number.isSafeInteger(offset)||offset<0
    ||(expectedSha256!==null&&(typeof expectedSha256!=='string'||!/^[a-f0-9]{64}$/.test(expectedSha256)))
    ||(offset>0&&expectedSha256===null)||!validSelection(selection))throw Error('invalid_arguments');
  const source=readFile(file,{preserveBom:true}),name=path.basename(file);
  if(!supported(name))throw Error('unsupported_source');
  if(expectedSha256!==null&&sha(source)!==expectedSha256)throw Error('source_changed');
  const r=spawnSync(process.execPath,['--max-old-space-size=256',__filename,'--internal-outline-worker'],{
    input:JSON.stringify({source,name,offset,selection}),encoding:'utf8',timeout:5000,killSignal:'SIGKILL',maxBuffer:512*1024
  });
  const unavailable=()=>({schema:'agent-brief-outline.v1',status:'unavailable',fileName:name,
    sourceSha256:sha(source),sourceBytes:Buffer.byteLength(source),offset,symbols:null,
    completeContext:false,modelCalls:0,fileWrites:0});
  if(r.error||r.signal||r.status!==0)return unavailable();
  let reply;try{reply=JSON.parse(r.stdout)}catch{return unavailable();}
  if(['invalid_source','invalid_outline_offset'].includes(reply?.error))throw Error(reply.error);
  return validResult(reply,source,name,offset,selection)?reply:unavailable();
}
function parseArgs(args){
  if(args.length===1&&['--help','-h'].includes(args[0]))return {help:true};
  const rest=[...args],i=rest.indexOf('--json'),json=i>=0;if(json)rest.splice(i,1);
  if(![2,6].includes(rest.length)||rest[0]!=='--source'||!rest[1]||rest[1].startsWith('--'))throw Error('invalid_arguments');
  if(rest.length===2)return {file:rest[1],json,offset:0,expectedSha256:null};
  if(rest[2]!=='--offset'||!/^(0|[1-9]\d{0,6})$/.test(rest[3])
    ||rest[4]!=='--sha256'||!/^[a-f0-9]{64}$/.test(rest[5]))throw Error('invalid_arguments');
  return {file:rest[1],json,offset:Number(rest[3]),expectedSha256:rest[5]};
}
const HELP='agent-brief outline --source FILE [--offset N --sha256 HASH] [--json]\nRead one JS/TS file and locate declarations, class/object callables and direct CommonJS function assignments. Names and line ranges only; no source bodies, edits or model calls. Continuations require the same source fingerprint. Read original context before editing.';
function display(v){
  const lines=['Agent Brief Lab — source outline: '+JSON.stringify(v.fileName),'Source SHA-256: '+v.sourceSha256];
  if(v.status==='unavailable')return lines.concat('Outline unavailable within resource limits. No source context was verified.').join('\n');
  lines.push(`${v.symbols.length}/${v.matchedSymbols??v.totalSymbols}${v.selection?' matching':''} locations from offset ${v.offset}${v.truncated?' (more follow)':''}; ${v.unlistedTopLevelStatements} top-level statements unlisted.`);
  if(v.selection)lines.push('Exact selection: '+JSON.stringify(v.selection)+`; ${v.totalSymbols} whole-file locations.`);
  for(const s of v.symbols)lines.push(`L${s.startLine}-L${s.endLine} ${s.kind} `
    +(s.container===null?'':JSON.stringify(s.container)+'.')+(s.name===null?'(unnamed/omitted)':JSON.stringify(s.name)));
  if(v.nextOffset!==null)lines.push(`Continue with --offset ${v.nextOffset} --sha256 ${v.sourceSha256}`);
  return lines.concat('Locations only. Read original imports, dependencies and surrounding scope before deciding or editing.').join('\n');
}
function runCli(args=process.argv.slice(2),io={out:console.log,err:console.error}){
  try{
    const o=parseArgs(args);
    if(o.help){io.out(HELP);return 0;}
    const result=outline(o.file,o);io.out(o.json?JSON.stringify(result,null,2):display(result));return 0;
  }catch(e){
    const safe=['invalid_arguments','invalid_file','unsupported_source','invalid_source','invalid_outline_offset','source_changed'];
    io.err('Outline refused: '+(safe.includes(e.message)?e.message:'invalid_input'));return 1;
  }
}
if(require.main===module){
  if(process.argv.length===3&&process.argv[2]==='--internal-outline-worker'){
    try{
      const bytes=fs.readFileSync(0);if(bytes.length>MAX_BYTES*8)throw Error('invalid_input');
      const request=JSON.parse(bytes.toString('utf8'));
      if(!request||Object.keys(request).sort().join(',')!=='name,offset,selection,source')throw Error('invalid_input');
      process.stdout.write(JSON.stringify(analyze(request.source,request.name,{offset:request.offset,selection:request.selection}))+'\n');
    }catch(e){process.stdout.write(JSON.stringify({error:['invalid_source','invalid_outline_offset'].includes(e.message)?e.message:'invalid_input'})+'\n');}
  }else process.exitCode=runCli();
}
module.exports={analyze,outline,parseArgs,display,runCli};
