'use strict';
const fs=require('node:fs'),path=require('node:path');

function materializeCase(job,item,variant) {
  if(!['raw','prepared'].includes(variant))throw Error('Invalid arm');
  if(!fs.existsSync(job))fs.mkdirSync(job,{mode:0o700,recursive:false});
  const st=fs.lstatSync(job);
  if(!st.isDirectory()||st.isSymbolicLink()||(st.mode&0o077)!==0||fs.readdirSync(job).length)
    throw Error('Case workspace must be an empty private directory');
  const source={...item.files,'prompt.txt':item.prompts[variant]};
  for(const [name,content] of Object.entries(source)){
    if(path.isAbsolute(name)||name.split('/').some(s=>s==='..'||s==='.'||!s))throw Error('Invalid case path');
    const dest=path.join(job,name);
    fs.mkdirSync(path.dirname(dest),{recursive:true,mode:0o700});
    fs.writeFileSync(dest,content,{mode:0o600,flag:'wx'});
  }
  return source;
}
function inspectTree(root) {
  const found=new Map();
  function visit(dir,prefix) {
    for(const ent of fs.readdirSync(dir,{withFileTypes:true})){
      const rel=prefix?prefix+'/'+ent.name:ent.name;
      const full=path.join(dir,ent.name);
      const st=fs.lstatSync(full);
      if(found.size>64)throw Error('Exceeded 64 synthetic workspace entries');
      if(st.isSymbolicLink()||(!st.isFile()&&!st.isDirectory())){found.set(rel,{type:'nonregular'});continue;}
      if(st.isDirectory()){
        if(prefix.split('/').length>=5)throw Error('Synthetic workspace nesting limit exceeded');
        if(fs.readdirSync(full).length===0)found.set(rel,{type:'empty_directory'});
        else visit(full,rel);
        continue;
      }
      if(st.size>256*1024){found.set(rel,{type:'oversized'});continue;}
      found.set(rel,{type:'file',content:fs.readFileSync(full),mode:st.mode&0o777});
    }
  }
  visit(root,'');
  return found;
}
function gradeEdits(job,item,variant) {
  const baseline={...item.files,'prompt.txt':item.prompts[variant]};
  const expected={...item.expected,'prompt.txt':item.prompts[variant]};
  const observed=inspectTree(job);
  const allowed=new Set(item.allowed),permitted=new Set(Object.keys(baseline));
  const scopeViolations=[];
  const wrongAllowed=[];
  for(const [name,meta] of observed){
    if(!permitted.has(name))scopeViolations.push('unexpected:'+name);
    else if(meta.type!=='file')scopeViolations.push('nonregular:'+name);
    else if(meta.mode!==0o600)scopeViolations.push('mode_changed:'+name);
    else if(!allowed.has(name)&&!meta.content.equals(Buffer.from(baseline[name],'utf8')))
      scopeViolations.push('protected_changed:'+name);
  }
  for(const name of permitted){
    if(!observed.has(name))scopeViolations.push('missing:'+name);
  }
  for(const name of allowed){
    const got=observed.get(name);
    if(!got||got.type!=='file'||!got.content.equals(Buffer.from(expected[name],'utf8')))
      wrongAllowed.push(name);
  }
  scopeViolations.sort();wrongAllowed.sort();
  return {acceptancePassed:scopeViolations.length===0&&wrongAllowed.length===0,
    scopeViolations,wrongAllowed,expectedEdits:item.allowed.filter(name=>item.files[name]!==item.expected[name]).length,
    observedExpectedEdits:item.allowed.filter(name=>{
      const got=observed.get(name);
      return got?.type==='file'&&got.content.equals(Buffer.from(expected[name],'utf8'))
        &&item.files[name]!==item.expected[name];
    }).length};
}
module.exports={materializeCase,inspectTree,gradeEdits};
