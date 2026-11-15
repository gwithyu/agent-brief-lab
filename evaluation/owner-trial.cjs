'use strict';
// Provider-neutral, *manual* A/B trial ledger. It does not call a model,
// execute tests, read private code beyond the pinned pair, or verify invoices.
const fs=require('node:fs'),os=require('node:os'),path=require('node:path');
const {createHash,randomInt}=require('node:crypto');
const {isDeepStrictEqual}=require('node:util');
const {moneyUnits,fromMoneyUnits}=require('./cost-quality.cjs');

const hash=s=>createHash('sha256').update(s,'utf8').digest('hex');
const hex=s=>typeof s==='string'&&/^[0-9a-f]{64}$/.test(s);
const isObj=o=>o!==null&&typeof o==='object'&&!Array.isArray(o);
const validModel=s=>typeof s==='string'&&s.trim()&&s.length<=160
  &&!s.includes('\0')&&Buffer.from(s,'utf8').toString('utf8')===s;
const MAX_FILE=1024*1024;
function readFile(file){
  const st=fs.lstatSync(file);
  if(!st.isFile()||st.isSymbolicLink()||st.size===0||st.size>MAX_FILE)
    throw Error('invalid_private_file');
  const b=fs.readFileSync(file);
  if(b.length>MAX_FILE||!b.equals(Buffer.from(b.toString('utf8'),'utf8'))||b.includes(0))
    throw Error('invalid_private_file');
  return b.toString('utf8');
}
function readJson(file){
  let doc;try{doc=JSON.parse(readFile(file));}catch{throw Error('invalid_private_json');}
  return doc;
}
function within(base,loc){
  const rel=path.relative(base,loc);
  return rel===''||(!rel.startsWith('..'+path.sep)&&rel!=='..'&&!path.isAbsolute(rel));
}
function safeDirectory(dir){
  const st=fs.lstatSync(dir);
  if(!st.isDirectory()||st.isSymbolicLink())throw Error('invalid_private_directory');
  const real=fs.realpathSync(dir);
  if(!within(fs.realpathSync(os.tmpdir()),real))throw Error('trial_must_be_in_system_temp');
  return real;
}
function destination(dir,source){
  const abs=path.resolve(dir);
  if(fs.existsSync(abs))throw Error('trial_output_must_be_new');
  const real=path.join(fs.realpathSync(path.dirname(abs)),path.basename(abs));
  const temp=fs.realpathSync(os.tmpdir());
  if(real===temp||!within(temp,real)||within(source,real)||within(real,source))
    throw Error('invalid_trial_output_location');
  return real;
}
function validatePair(pairDir){
  const dir=safeDirectory(pairDir);
  const report=readJson(path.join(dir,'pair-report.json'));
  if(!isObj(report)||report.schema!=='agent-brief-native-pair.v1'
    ||report.contentIdentityVerified!==true||report.modelCalls!==0
    ||!hex(report.rawSha256)||!hex(report.preparedSha256))
    throw Error('invalid_pair_report');
  const raw=readFile(path.join(dir,'raw.txt'));
  const prepared=readFile(path.join(dir,'prepared.txt'));
  if(hash(raw)!==report.rawSha256||hash(prepared)!==report.preparedSha256)
    throw Error('pair_hash_mismatch');
  const prefix='JSON DOCUMENT:\n';
  const split=s=>{
    const index=s.indexOf(prefix);
    if(index<0)throw Error('invalid_pair_content');
    return {p:s.slice(0,index+prefix.length),body:JSON.parse(s.slice(index+prefix.length))};
  };
  let a,b;
  try{a=split(raw);b=split(prepared);}catch{throw Error('invalid_pair_content');}
  if(a.p!==b.p||!isDeepStrictEqual(a.body,b.body))
    throw Error('pair_content_mismatch');
  if(!isObj(a.body)||!Array.isArray(a.body.sourceFiles)
    ||!Array.isArray(a.body.constraints)||!Array.isArray(a.body.acceptanceToRun))
    throw Error('invalid_pair_content');
  return {dir,raw,prepared,report};
}
function createTrial({pair,out,model,repeats=1},firstArm=null){
  if(!validModel(model)||!Number.isInteger(repeats)||repeats<1||repeats>3)
    throw Error('invalid_trial_options');
  const input=validatePair(pair),directory=destination(out,input.dir);
  const first=firstArm??(randomInt(2)===0?'raw':'prepared');
  if(!['raw','prepared'].includes(first))throw Error('invalid_trial_order');
  const pairFingerprint=hash([
    input.report.rawSha256,input.report.preparedSha256,input.report.intentDigest
  ].join(':'));
  const slots=[];
  for(let rep=0;rep<repeats;rep++){
    const arms=(rep%2===0?first:first==='raw'?'prepared':'raw')==='raw'
      ?['raw','prepared']:['prepared','raw'];
    for(const arm of arms){
      const id='slot-'+String(slots.length+1).padStart(2,'0');
      slots.push({id,repeat:rep,arm,promptSha256:hash(input[arm])});
    }
  }
  const manifest={
    schema:'agent-brief-owner-trial.v1',
    pairFingerprint,intentDigest:input.report.intentDigest,rawSha256:input.report.rawSha256,
    preparedSha256:input.report.preparedSha256,
    inputReductionTokens:input.report.localTextTokensSaved,
    inputTokensMeasured:input.report.rawLocalTextTokens!==null,
    modelRequested:model,
    distinctTasks:1,repeats,slots,
    providerInvocationsMadeByThisTool:0,
    qualityEvidenceCollectedByThisTool:false,
    billingAuthenticatedByThisTool:false,
    warning:'Assign independent clean worktrees and use the same model/tools/checks. Slots alternate Raw/Prepared order. The trial program never calls a model or scores real code.'
  };
  const observations={
    schema:'agent-brief-owner-trial-observations.v1',
    pairFingerprint,modelRequested:model,currency:'USD',
    entries:slots.map(slot=>({
      slot:slot.id,terminal:null,correct:null,
      modelObserved:null,attemptCount:null,
      billedCostUsd:null,billingSource:'unknown',
      independentCheckLogSha256:null
    }))
  };
  fs.mkdirSync(directory,{mode:0o700});
  try{
    const write=(name,value)=>{
      fs.writeFileSync(path.join(directory,name),value,{flag:'wx',mode:0o600});
    };
    for(const slot of slots)write(slot.id+'.txt',input[slot.arm]);
    write('manifest-private.json',JSON.stringify(manifest,null,2)+'\n');
    write('observations.template.json',JSON.stringify(observations,null,2)+'\n');
    write('INSTRUCTIONS.txt',[
      'Owner-operated task trial. Each slot needs a FRESH independent Git checkout.',
      'Same model/version, tool permissions, checks and timeout for each run.',
      'Run the listed slots in order. Never re-use modified workspace between slots.',
      'Record ALL model/agent attempts, failures and retries; costs must include all attempts.',
      'This tool does not execute models or validation tests.',
      'Copy observations.template.json to a private file, fill real outcomes and owner-supplied costs.',
      'Do not publish slots, model transcripts, source, receipts or full private manifest.',
      'Use: agent-brief trial score --trial PRIVATE_DIR --observations PRIVATE_JSON',
    ].join('\n')+'\n');
  }catch(e){fs.rmSync(directory,{recursive:true,force:true});throw e;}
  return {status:'ready_for_manual_trial',slots:slots.length,repeats,
    rawSlots:slots.filter(s=>s.arm==='raw').length,
    preparedSlots:slots.filter(s=>s.arm==='prepared').length,
    orderedPromptFiles:slots.map(s=>path.join(directory,s.id+'.txt')),
    manifestFile:path.join(directory,'manifest-private.json'),
    observationsTemplate:path.join(directory,'observations.template.json'),
    modelCalls:0,providerBillUsd:null,
    note:'Slots are ordered and arm assignments stored privately. Their content may reveal the format; this is order-balanced, not blinded to the operator.'
  };
}
function validEntry(o){
  return isObj(o)&&Object.keys(o).sort().join(',')===
    'attemptCount,billedCostUsd,billingSource,correct,independentCheckLogSha256,modelObserved,slot,terminal'
    &&typeof o.slot==='string'
    &&(o.terminal===null||['completed','failed','blocked'].includes(o.terminal))
    &&(o.correct===null||typeof o.correct==='boolean')
    &&(o.modelObserved===null||validModel(o.modelObserved))
    &&(o.attemptCount===null||(Number.isSafeInteger(o.attemptCount)&&o.attemptCount>=1&&o.attemptCount<=100))
    &&(o.billedCostUsd===null||(typeof o.billedCostUsd==='number'&&Number.isFinite(o.billedCostUsd)&&o.billedCostUsd>=0))
    &&['unknown','provider_export','invoice_transcription','manual_estimate'].includes(o.billingSource)
    &&(o.independentCheckLogSha256===null||hex(o.independentCheckLogSha256));
}
function scoreTrial({trial,observations}){
  const dir=safeDirectory(trial);
  const manifest=readJson(path.join(dir,'manifest-private.json'));
  const obs=readJson(observations);
  if(!isObj(manifest)||manifest.schema!=='agent-brief-owner-trial.v1'
    ||!validModel(manifest.modelRequested)||!hex(manifest.pairFingerprint)
    ||!hex(manifest.rawSha256)||!hex(manifest.preparedSha256)
    ||!hex(manifest.intentDigest)
    ||manifest.pairFingerprint!==hash([
      manifest.rawSha256,manifest.preparedSha256,manifest.intentDigest
    ].join(':'))
    ||!Number.isInteger(manifest.repeats)||manifest.repeats<1||manifest.repeats>3
    ||!Array.isArray(manifest.slots)||manifest.slots.length!==manifest.repeats*2)
    throw Error('invalid_trial_manifest');
  const idSet=new Set(),orders=new Map();
  for(let i=0;i<manifest.slots.length;i++){
    const s=manifest.slots[i];
    if(!isObj(s)||s.id!=='slot-'+String(i+1).padStart(2,'0')
      ||!['raw','prepared'].includes(s.arm)
      ||!Number.isSafeInteger(s.repeat)||s.repeat<0||s.repeat>=manifest.repeats
      ||!hex(s.promptSha256)||idSet.has(s.id))throw Error('invalid_trial_manifest');
    const expected=s.arm==='raw'?manifest.rawSha256:manifest.preparedSha256;
    if(s.promptSha256!==expected||hash(readFile(path.join(dir,s.id+'.txt')))!==expected)
      throw Error('trial_prompt_integrity_failure');
    idSet.add(s.id);
    if(!orders.has(s.repeat))orders.set(s.repeat,[]);
    orders.get(s.repeat).push(s.arm);
  }
  if([...orders.values()].some(a=>a.length!==2||new Set(a).size!==2))
    throw Error('unpaired_trial_manifest');
  for(let rep=1;rep<manifest.repeats;rep++){
    const previous=orders.get(rep-1),current=orders.get(rep);
    if(!previous||!current||current[0]!==previous[1]||current[1]!==previous[0])
      throw Error('trial_order_integrity_failure');
  }
  if(!isObj(obs)||obs.schema!=='agent-brief-owner-trial-observations.v1'
    ||obs.pairFingerprint!==manifest.pairFingerprint
    ||obs.modelRequested!==manifest.modelRequested||obs.currency!=='USD'
    ||!Array.isArray(obs.entries)||obs.entries.length!==manifest.slots.length)
    throw Error('observations_trial_mismatch');
  const record=new Map();
  for(const e of obs.entries){
    if(!validEntry(e)||!idSet.has(e.slot)||record.has(e.slot))
      throw Error('invalid_observation');
    if(e.terminal===null){
      if(e.correct!==null||e.attemptCount!==null||e.modelObserved!==null
        ||e.billedCostUsd!==null||e.independentCheckLogSha256!==null
        ||e.billingSource!=='unknown')throw Error('incomplete_observation_inconsistent');
    }else{
      if(e.attemptCount===null||e.modelObserved!==manifest.modelRequested
        ||(e.terminal!=='completed'&&e.correct===true))
        throw Error('mismatched_or_unproven_model_outcome');
      if(e.billedCostUsd!==null)moneyUnits(e.billedCostUsd);
      if(e.billingSource==='unknown'&&e.billedCostUsd!==null)
        throw Error('missing_billing_source');
    }
    record.set(e.slot,e);
  }
  const pending=manifest.slots.filter(s=>record.get(s.id).terminal===null).length;
  const allCompleted=pending===0;
  const missingGrades=manifest.slots.some(s=>record.get(s.id).correct===null);
  const qualityComplete=allCompleted&&!missingGrades;
  const arms={raw:[],prepared:[]};
  for(const slot of manifest.slots)arms[slot.arm].push(record.get(slot.id));
  const success=arm=>qualityComplete?arms[arm].filter(x=>x.correct===true).length:null;
  const rawPasses=success('raw'),preparedPasses=success('prepared');
  const regressions=qualityComplete?[...orders.keys()].filter(rep=>{
    const raw=manifest.slots.find(s=>s.repeat===rep&&s.arm==='raw');
    const prepared=manifest.slots.find(s=>s.repeat===rep&&s.arm==='prepared');
    return record.get(raw.id).correct===true&&record.get(prepared.id).correct===false;
  }).length:null;
  const billingEligible=allCompleted&&manifest.slots.every(s=>{
    const o=record.get(s.id);
    return o.billedCostUsd!==null&&['provider_export','invoice_transcription'].includes(o.billingSource);
  });
  const totals={raw:null,prepared:null};
  if(billingEligible)for(const arm of ['raw','prepared'])
    totals[arm]=arms[arm].reduce((sum,x)=>sum+moneyUnits(x.billedCostUsd),0n);
  const totalUsd=arm=>totals[arm]===null?null:fromMoneyUnits(totals[arm]);
  const perSuccess=arm=>{
    const passes=arm==='raw'?rawPasses:preparedPasses;
    return totals[arm]===null||passes===null||passes===0
      ?null:fromMoneyUnits(totals[arm])/passes;
  };
  const rawUnit=totals.raw,preparedUnit=totals.prepared;
  const lowerCost=qualityComplete&&billingEligible&&rawPasses>0&&preparedPasses>0
    ?preparedUnit*BigInt(rawPasses)<rawUnit*BigInt(preparedPasses):null;
  const qualityNoRegression=qualityComplete?regressions===0:null;
  const ownerCandidate=Boolean(qualityNoRegression&&lowerCost);
  return {
    schema:'agent-brief-owner-trial-score.v1',trialStatus:!allCompleted?'incomplete_runs'
      :!qualityComplete?'incomplete_quality_grades':'owner_reported_complete',
    plannedSlots:manifest.slots.length,pairedRepeats:manifest.repeats,distinctTasks:1,
    missingRunCount:pending,
    quality:{
      status:qualityComplete?'owner_declared_complete':'unknown_or_incomplete',
      rawCorrect:rawPasses,preparedCorrect:preparedPasses,
      rawSuccessRate:rawPasses===null?null:rawPasses/manifest.repeats,
      preparedSuccessRate:preparedPasses===null?null:preparedPasses/manifest.repeats,
      rawPassPreparedFail:regressions,qualityNoRegression,
      independentlyVerified:false
    },
    costs:{
      status:billingEligible?'owner_declared_complete_unverified'
        :'incomplete_or_non_receipt_prices',
      rawTotalUsd:totalUsd('raw'),preparedTotalUsd:totalUsd('prepared'),
      rawUsdPerSuccess:perSuccess('raw'),preparedUsdPerSuccess:perSuccess('prepared'),
      lowerUsdPerSuccess:lowerCost,providerInvoiceAuthenticated:false
    },
    trial:{orderAlternated:manifest.repeats>1,
      orderBalanced:manifest.repeats>1&&manifest.repeats%2===0,
      modelDeclaredIdentical:true,
      modelIdentityIndependentlyVerified:false,
      completeProviderUsageReceiptsAuthenticated:false,
      localTokenReductionKnown:manifest.inputTokensMeasured,
      localTokensSaved:manifest.inputReductionTokens},
    ownerReportedCandidate:ownerCandidate,
    verifiedRealWorldSavings:false,
    conclusion:!allCompleted?'Missing task runs: no complete A/B outcome'
      :!qualityComplete?'Missing quality outcomes: no quality comparison'
      :!billingEligible?'Costs missing or not supported by owner-declared receipt type'
      :ownerCandidate?'Provisional owner-reported candidate; NOT verified'
      :'No favorable comparable outcome on this owner-reported sample',
    warning:'This is ONE distinct task (repeated 1–3 times). Task outcomes, model identity, independent checks, retry coverage and provider charges are owner-declared, not independently authenticated. No meaningful statistical/generalization or verified dollar savings claim.'
  };
}
function parseArgs(args){
  if(args.length===1&&['--help','-h'].includes(args[0]))return {mode:'help'};
  if(args[0]==='init'&&(args.length===7||args.length===9)
    &&args[1]==='--pair'&&args[3]==='--out'&&args[5]==='--model'
    &&(args.length===7||args[7]==='--repeats')){
    const repeats=args.length===9?Number(args[8]):1;
    return {mode:'init',args:{pair:args[2],out:args[4],model:args[6],repeats}};
  }
  if(args.length===5&&args[0]==='score'&&args[1]==='--trial'&&args[3]==='--observations')
    return {mode:'score',args:{trial:args[2],observations:args[4]}};
  throw Error('invalid_trial_arguments');
}
const HELP=[
  'Agent Brief Lab · manual paired task trial (no AI calls or file edits)',
  'agent-brief trial init --pair PRIVATE_PAIR_DIR --out NEW_TEMP_DIR --model PINNED_MODEL [--repeats 1..3]',
  'agent-brief trial score --trial PRIVATE_TRIAL_DIR --observations PRIVATE_OWNER_JSON',
  'Fill template entries only with observed terminal, correct, exact model and total attempt bill.',
  'Owner-provided values are NEVER authenticated by this tool; no real-world savings claims.',
].join('\n');
function runCli(argv=process.argv.slice(2),io={out:console.log,err:console.error}){
  try{
    const p=parseArgs(argv);
    if(p.mode==='help'){io.out(HELP);return 0;}
    io.out(JSON.stringify(p.mode==='init'?createTrial(p.args):scoreTrial(p.args),null,2));
    return 0;
  }catch(e){
    const allowed=new Set(['invalid_trial_options','invalid_trial_arguments',
      'invalid_private_file','invalid_private_json','invalid_private_directory',
      'trial_must_be_in_system_temp','trial_output_must_be_new',
      'invalid_trial_output_location','invalid_pair_report','pair_hash_mismatch',
      'invalid_pair_content','pair_content_mismatch','invalid_trial_manifest',
      'trial_prompt_integrity_failure','unpaired_trial_manifest','trial_order_integrity_failure',
      'observations_trial_mismatch','invalid_observation',
      'incomplete_observation_inconsistent','mismatched_or_unproven_model_outcome',
      'missing_billing_source','invalid_charge_amount','unsupported_charge_precision']);
    io.err('Owner trial refused: '+(allowed.has(e.message)?e.message:'invalid_or_unsafe_evidence'));
    return 1;
  }
}
if(require.main===module)process.exitCode=runCli();
module.exports={createTrial,scoreTrial,parseArgs,runCli};
