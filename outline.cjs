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
function analyze(source,name){
  if(typeof source!=='string'||Buffer.byteLength(source)>MAX_BYTES)throw Error('invalid_file');
  if(!supported(name))throw Error('unsupported_source');
  let parsed;
  try{parsed=sourceFile(source,name)}catch{throw Error('invalid_source');}
  const symbols=[];let totalSymbols=0,unlistedTopLevelStatements=0;
  const add=(node,kind,name,container=null)=>{
    totalSymbols++;
    if(symbols.length===MAX_SYMBOLS)return;
    const start=node.getStart(parsed),end=Math.max(start,node.end-1);
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
        if(callable(declaration.initializer))add(declaration,'function',identifier(declaration.name));
        else if(declaration.initializer&&ts.isObjectLiteralExpression(declaration.initializer))
          addMembers(declaration.initializer.properties,identifier(declaration.name));
        else if(requireCall(declaration.initializer))add(declaration,'import',null);
      }
    }else if(ts.isExpressionStatement(node)&&requireCall(node.expression))add(node,'import',null);
    else if(ts.isExpressionStatement(node)&&ts.isBinaryExpression(node.expression)
      &&node.expression.operatorToken.kind===ts.SyntaxKind.EqualsToken){
      const {left,right}=node.expression;
      if(moduleExports(left)){
        if(ts.isObjectLiteralExpression(right))addMembers(right.properties,'module.exports');
        else if(callable(right))add(node.expression,'function','exports','module');
      }else if(ts.isPropertyAccessExpression(left)&&callable(right)){
        const owner=left.expression;
        if(ts.isIdentifier(owner)&&owner.text==='exports')add(node.expression,'function',identifier(left.name),'exports');
        else if(moduleExports(owner))add(node.expression,'function',identifier(left.name),'module.exports');
      }
    }
    else if(ts.isInterfaceDeclaration(node))add(node,'interface',name);
    else if(ts.isTypeAliasDeclaration(node))add(node,'type',name);
    else if(ts.isEnumDeclaration(node))add(node,'enum',name);
    else if(ts.isModuleDeclaration(node))add(node,'namespace',name);
    if(totalSymbols===before)unlistedTopLevelStatements++;
  }
  return {schema:'agent-brief-outline.v1',status:'ready',fileName:path.basename(name),
    sourceSha256:sha(source),sourceBytes:Buffer.byteLength(source),lineCount:parsed.getLineStarts().length,
    symbols,totalSymbols,truncated:totalSymbols>symbols.length,unlistedTopLevelStatements,
    completeContext:false,modelCalls:0,fileWrites:0};
}
function validResult(v,source,name){
  const uint=n=>Number.isSafeInteger(n)&&n>=0;
  return v&&Object.keys(v).sort().join(',')===
    'completeContext,fileName,fileWrites,lineCount,modelCalls,schema,sourceBytes,sourceSha256,status,symbols,totalSymbols,truncated,unlistedTopLevelStatements'
    &&v.schema==='agent-brief-outline.v1'&&v.status==='ready'&&v.fileName===name
    &&v.sourceSha256===sha(source)&&v.sourceBytes===Buffer.byteLength(source)
    &&v.completeContext===false&&v.modelCalls===0&&v.fileWrites===0
    &&uint(v.lineCount)&&v.lineCount>0&&uint(v.totalSymbols)&&uint(v.unlistedTopLevelStatements)
    &&Array.isArray(v.symbols)&&v.symbols.length<=MAX_SYMBOLS&&v.totalSymbols>=v.symbols.length
    &&v.truncated===(v.totalSymbols>v.symbols.length)
    &&v.symbols.every(s=>s&&Object.keys(s).sort().join(',')==='container,endLine,kind,name,startLine'
      &&kinds.includes(s.kind)&&[s.name,s.container].every(n=>n===null||typeof n==='string'&&n.length<=128)
      &&uint(s.startLine)&&s.startLine>0&&uint(s.endLine)&&s.endLine>=s.startLine&&s.endLine<=v.lineCount);
}
function outline(file){
  const source=readFile(file,{preserveBom:true}),name=path.basename(file);
  if(!supported(name))throw Error('unsupported_source');
  const r=spawnSync(process.execPath,['--max-old-space-size=256',__filename,'--internal-outline-worker'],{
    input:JSON.stringify({source,name}),encoding:'utf8',timeout:5000,killSignal:'SIGKILL',maxBuffer:512*1024
  });
  const unavailable=()=>({schema:'agent-brief-outline.v1',status:'unavailable',fileName:name,
    sourceSha256:sha(source),sourceBytes:Buffer.byteLength(source),symbols:null,
    completeContext:false,modelCalls:0,fileWrites:0});
  if(r.error||r.signal||r.status!==0)return unavailable();
  let reply;try{reply=JSON.parse(r.stdout)}catch{return unavailable();}
  if(reply?.error==='invalid_source')throw Error('invalid_source');
  return validResult(reply,source,name)?reply:unavailable();
}
function parseArgs(args){
  if(args.length===1&&['--help','-h'].includes(args[0]))return {help:true};
  const rest=[...args],i=rest.indexOf('--json'),json=i>=0;if(json)rest.splice(i,1);
  if(rest.length!==2||rest[0]!=='--source'||!rest[1]||rest[1].startsWith('--'))throw Error('invalid_arguments');
  return {file:rest[1],json};
}
const HELP='agent-brief outline --source FILE [--json]\nRead one JS/TS file and locate declarations, class/object callables and direct CommonJS function assignments. Names and line ranges only; no source bodies, edits or model calls. Read original context before editing.';
function display(v){
  const lines=['Agent Brief Lab — source outline: '+JSON.stringify(v.fileName),'Source SHA-256: '+v.sourceSha256];
  if(v.status==='unavailable')return lines.concat('Outline unavailable within resource limits. No source context was verified.').join('\n');
  lines.push(`${v.symbols.length}/${v.totalSymbols} locations${v.truncated?' (truncated)':''}; ${v.unlistedTopLevelStatements} top-level statements unlisted.`);
  for(const s of v.symbols)lines.push(`L${s.startLine}-L${s.endLine} ${s.kind} `
    +(s.container===null?'':JSON.stringify(s.container)+'.')+(s.name===null?'(unnamed/omitted)':JSON.stringify(s.name)));
  return lines.concat('Locations only. Read original imports, dependencies and surrounding scope before deciding or editing.').join('\n');
}
function runCli(args=process.argv.slice(2),io={out:console.log,err:console.error}){
  try{
    const o=parseArgs(args);
    if(o.help){io.out(HELP);return 0;}
    const result=outline(o.file);io.out(o.json?JSON.stringify(result,null,2):display(result));return 0;
  }catch(e){
    const safe=['invalid_arguments','invalid_file','unsupported_source','invalid_source'];
    io.err('Outline refused: '+(safe.includes(e.message)?e.message:'invalid_input'));return 1;
  }
}
if(require.main===module){
  if(process.argv.length===3&&process.argv[2]==='--internal-outline-worker'){
    try{
      const bytes=fs.readFileSync(0);if(bytes.length>MAX_BYTES*8)throw Error('invalid_input');
      const request=JSON.parse(bytes.toString('utf8'));
      if(!request||Object.keys(request).sort().join(',')!=='name,source')throw Error('invalid_input');
      process.stdout.write(JSON.stringify(analyze(request.source,request.name))+'\n');
    }catch(e){process.stdout.write(JSON.stringify({error:e.message==='invalid_source'?'invalid_source':'invalid_input'})+'\n');}
  }else process.exitCode=runCli();
}
module.exports={analyze,outline,parseArgs,display,runCli};
