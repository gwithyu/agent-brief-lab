'use strict';
const fs=require('node:fs');
const path=require('node:path');
const os=require('node:os');
const {spawnSync}=require('node:child_process');
const {captureBaseline,checkChanges}=require('./execution.cjs');
const intent=require('./examples/intent.json');
const plan=require('./examples/plan-good.json');
const {intentDigest}=require('./index.cjs');
const {reviewChanges}=require('./review.cjs');

module.exports=function workspaceDemo() {
  const temporary=fs.mkdtempSync(path.join(os.tmpdir(),'agent-brief-demo-'));
  const root=path.join(temporary,'repo');fs.mkdirSync(path.join(root,'src'),{recursive:true});
  const put=(file,value)=>fs.writeFileSync(path.join(root,file),value);
  const git=(...args)=>{
    const result=spawnSync('git',['-c','core.hooksPath=/dev/null','-c','core.fsmonitor=false','-c','commit.gpgsign=false',
      '-c','user.name=Agent Brief demo','-c','user.email=demo@example.invalid',...args],{cwd:root,encoding:'utf8'});
    if(result.status!==0) throw new Error('Demo Git setup failed');
  };
  try {
    put('src/navigation.css','.navigation { opacity: 0.8; padding: 12px; }\n');
    put('src/temple.js','export const scene="original";\n');
    put('src/icons.js','export const icons=["home","chat"];\n');
    git('init','-b','main');git('add','.');git('commit','-m','Synthetic fixture baseline');
    const baseline=captureBaseline(intent,root);
    const reviewIntent={...intent,acceptance:[{id:'css_opacity',text:'静态确认合成 CSS 的 opacity 为 0.5。'},
      {id:'css_padding',text:'静态确认合成 CSS 的 padding 为 8px。'}]};
    const reviewPlan={...plan,intentDigest:intentDigest(reviewIntent),checks:reviewIntent.acceptance.map(a=>a.id)};
    const reviewBaseline=captureBaseline(reviewIntent,root);
    const manifest={intentDigest:intentDigest(reviewIntent),commands:reviewIntent.acceptance.map(a=>({id:a.id,
      argv:[process.execPath,'-e',`const css=require('node:fs').readFileSync('src/navigation.css','utf8');if(!css.includes('${a.id==='css_opacity'?'opacity: 0.5':'padding: 8px'}'))process.exit(1);`]}))};
    put('src/navigation.css','.navigation { opacity: 0.5; padding: 8px; }\n');
    const actualAllowedEdit=checkChanges(intent,plan,baseline,root);
    const staticAcceptance=reviewChanges(reviewIntent,reviewPlan,reviewBaseline,root,manifest);
    put('src/navigation.css','.navigation { opacity: 0.7; padding: 8px; }\n');
    const failingStaticAcceptance=reviewChanges(reviewIntent,reviewPlan,reviewBaseline,root,manifest);
    put('src/navigation.css','.navigation { opacity: 0.5; padding: 8px; }\n');
    const mutationManifest={...manifest,commands:manifest.commands.map((command,i)=>({...command,
      argv:[process.execPath,'-e',`require('node:fs').writeFileSync('src/navigation.css',${JSON.stringify(i===0?'modified between checks':'.navigation { opacity: 0.5; padding: 8px; }\n')})`]}))};
    const interCommandMutation=reviewChanges(reviewIntent,reviewPlan,reviewBaseline,root,mutationManifest);
    put('src/navigation.css','.navigation { opacity: 0.5; padding: 8px; }\n');
    put('src/temple.js','export const scene="wrongly replaced";\n');
    const concealedTempleEdit=checkChanges(intent,plan,baseline,root);
    return {fixture:'Synthetic isolated Git working tree, not Home or a model-run benchmark',
      baselineFiles:baseline.files.length,actualAllowedEdit,concealedTempleEdit,
      staticAcceptance,failingStaticAcceptance,interCommandMutation,visualAcceptance:'Not run; static CSS checks do not validate appearance or touch targets'};
  } finally {fs.rmSync(temporary,{recursive:true,force:true});}
};
