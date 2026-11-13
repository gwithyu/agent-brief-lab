'use strict';
const fs = require('node:fs');
const path = require('node:path');
const {createHash} = require('node:crypto');
const {spawnSync} = require('node:child_process');
const {tokens,brief,validateIntent,intentDigest,checkPlan,filePath} = require('./index.cjs');

const hash = value => createHash('sha256').update(value).digest('hex');
const hex = value => typeof value === 'string' && /^[0-9a-f]{64}$/.test(value);
function git(root, args) {
  const env={...process.env};
  for(const key of ['GIT_DIR','GIT_WORK_TREE','GIT_INDEX_FILE','GIT_OBJECT_DIRECTORY','GIT_ALTERNATE_OBJECT_DIRECTORIES']) delete env[key];
  const result=spawnSync('git',['--no-optional-locks','-c','core.fsmonitor=false','-c','core.filemode=true','-C',root,...args],
    {env,encoding:'utf8',timeout:15000,maxBuffer:16*1024*1024});
  if(result.error || result.status!==0) throw new Error('Git inspection failed');
  return result.stdout;
}
function projectRoot(root) {
  const real=fs.realpathSync(root);
  if(!fs.statSync(real).isDirectory() || fs.realpathSync(git(real,['rev-parse','--show-toplevel']).trim())!==real) {
    throw new Error('Use the exact Git working-tree root');
  }
  return real;
}
function paths(root) {
  const values=[...new Set(git(root,['ls-files','--cached','--others','--exclude-standard','-z']).split('\0').filter(Boolean))].sort();
  if(values.some(value=>!filePath(value))) throw new Error('Repository contains an unsupported path');
  return values;
}
function observe(root,file,includeSource=false) {
  const absolute=path.join(root,file);
  let stat;
  try { stat=fs.lstatSync(absolute); }
  catch(error) { if(error.code==='ENOENT') return {path:file,state:'missing'};throw new Error(`Cannot inspect: ${file}`); }
  if(stat.isSymbolicLink()) {
    const parent=path.relative(root,fs.realpathSync(path.dirname(absolute)));
    if(parent==='..' || parent.startsWith('..'+path.sep) || path.isAbsolute(parent)) return {path:file,state:'unsupported'};
    const target=fs.readlinkSync(absolute,{encoding:'buffer'});
    return {path:file,state:'symlink',sha256:hash(target),mode:stat.mode & 0o7777,bytes:target.length};
  }
  if(!stat.isFile()) return {path:file,state:'unsupported'};
  const relative=path.relative(root,fs.realpathSync(absolute));
  if(relative==='..' || relative.startsWith('..'+path.sep) || path.isAbsolute(relative)) {
    return {path:file,state:'unsupported'};
  }
  const data=fs.readFileSync(absolute);
  const value={path:file,state:'file',sha256:hash(data),mode:stat.mode & 0o7777,bytes:data.length};
  if(includeSource) {
    const source=data.toString('utf8');
    if(!Buffer.from(source).equals(data) || source.includes('\0')) throw new Error(`Expected UTF-8 text: ${file}`);
    value.source=source;
  }
  return value;
}
function indexDigest(root) { return hash(git(root,['ls-files','--stage','-z'])); }
function head(root) { return git(root,['rev-parse','--verify','HEAD']).trim(); }

function captureBaseline(intent,root) {
  validateIntent(intent);root=projectRoot(root);
  const commit=head(root),index=indexDigest(root),selected=new Set(intent.allowedFiles),sources=Object.create(null);
  const files=paths(root).map(file=>{
    const value=observe(root,file,selected.has(file));
    if(!['file','symlink'].includes(value.state)) throw new Error(`Baseline requires regular files or symlink entries: ${file}`);
    if(selected.has(file) && value.state!=='file') throw new Error(`Allowed edit sources must be regular files: ${file}`);
    if(selected.has(file)) {sources[file]=value.source;delete value.source;}
    return value;
  });
  if(intent.allowedFiles.some(file=>!Object.hasOwn(sources,file))) throw new Error('Every allowed file must exist in the baseline');
  if(commit!==head(root) || index!==indexDigest(root)) throw new Error('Repository changed during baseline capture');
  return {version:files.some(file=>file.state==='symlink')?2:1,intentDigest:intentDigest(intent),head:commit,indexDigest:index,files,sources};
}

function sourceMap(intent,sources) {
  if(!sources || typeof sources!=='object' || Array.isArray(sources)
    || Object.keys(sources).length!==intent.allowedFiles.length
    || intent.allowedFiles.some(file=>!Object.hasOwn(sources,file) || typeof sources[file]!=='string')) {
    throw new Error('Context must contain exactly all allowed source files');
  }
}
function measureContext(intent,before,after,encoding='o200k_base') {
  validateIntent(intent);sourceMap(intent,before);sourceMap(intent,after);
  const envelope=(instruction,sources)=>JSON.stringify({instruction,files:[...intent.allowedFiles].sort().map(file=>({path:file,source:sources[file]}))});
  const raw=tokens(envelope(intent.request,before),encoding);
  const guidedBefore=tokens(envelope(brief(intent),before),encoding);
  const guidedAfter=tokens(envelope(brief(intent),after),encoding);
  return {encoding,scope:'This complete JSON input envelope only; no agent output, tools, reasoning, cache or billing',
    rawRequestBefore:raw,guidedBefore,guidedAfter,savedWithSameGuidance:guidedBefore-guidedAfter,
    addedVersusRawRequest:guidedAfter-raw,inputSavingsVersusRawRequest:raw-guidedAfter};
}

function validateBaseline(intent,base) {
  if(!base || ![1,2].includes(base.version) || !hex(base.intentDigest) || !hex(base.indexDigest)
    || typeof base.head!=='string' || !/^(?:[0-9a-f]{40}|[0-9a-f]{64})$/.test(base.head)
    || !Array.isArray(base.files) || !base.files.length) throw new Error('Invalid baseline');
  if(base.files.some(file=>!file || !filePath(file.path) || !(base.version===1?['file']:['file','symlink']).includes(file.state) || !hex(file.sha256)
    || !Number.isInteger(file.mode) || file.mode<0 || file.mode>0o7777)
    || new Set(base.files.map(file=>file.path)).size!==base.files.length) throw new Error('Invalid baseline files');
  sourceMap(intent,base.sources);
  for(const file of intent.allowedFiles) {
    const recorded=base.files.find(value=>value.path===file);
    if(!recorded || recorded.state!=='file' || hash(base.sources[file])!==recorded.sha256) throw new Error('Baseline source fingerprint mismatch');
  }
}

function checkChanges(intent,plan,base,root,encoding='o200k_base') {
  validateIntent(intent);validateBaseline(intent,base);root=projectRoot(root);
  const failures=[...checkPlan(intent,plan).failures];
  if(base.intentDigest!==intentDigest(intent)) failures.push('Baseline is not bound to the current intent');
  if(base.head!==head(root)) failures.push('Git HEAD changed; committed changes require separate review');
  if(base.indexDigest!==indexDigest(root)) failures.push('Git index changed; staged changes require separate review');
  const before=new Map(base.files.map(file=>[file.path,file]));
  const union=[...new Set([...before.keys(),...paths(root)])].sort(),changed=[],after=Object.create(null);
  for(const file of union) {
    const old=before.get(file),current=observe(root,file,intent.allowedFiles.includes(file));
    if(Object.hasOwn(current,'source')) {after[file]=current.source;delete current.source;}
    if(old && ['file','symlink'].includes(current.state) && old.state===current.state && old.sha256===current.sha256 && old.mode===current.mode) continue;
    const kind=!old?'added':current.state==='missing'?'deleted':current.state==='unsupported'?'unsupported':old.state!==current.state?'type_changed':current.state==='symlink'?'symlink_changed':old.mode!==current.mode?'mode_changed':'modified';
    changed.push({path:file,kind});
    if(!intent.allowedFiles.includes(file)) failures.push(`Actual change outside allowed scope: ${file}`);
    if(!plan.files.includes(file)) failures.push(`Actual change absent from plan: ${file}`);
    if(kind!=='modified') failures.push(`Only existing-file content edits are supported: ${file} (${kind})`);
  }
  if(!changed.length) failures.push('No actual changes were observed');
  const complete=intent.allowedFiles.every(file=>Object.hasOwn(after,file));
  return {ok:failures.length===0,failures,changed,
    context:complete?measureContext(intent,base.sources,after,encoding):null,
    acceptance:'Not run: file-scope verification does not prove behavior, visual correctness or understanding'};
}

module.exports={captureBaseline,checkChanges,measureContext};
