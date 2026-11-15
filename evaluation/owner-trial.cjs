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
    ||!hex(report.rawSha256)||!hex(report.preparedSha256)
    ||!hex(report.intentDigest))
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
    schema:'agent-brief-owner-trial-observations.v2',
    pairFingerprint,modelRequested:model,currency:'USD',
    entries:slots.map(slot=>({
      slot:slot.id,terminal:null,correct:null,
      attempts:null,
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
      'Copy observations.template.json; fill actual outcomes and an ordered list of EVERY attempt.',
      'For each attempt record model, terminal, actual USD charge/source and native token counts/source.',
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
const receiptSources=['provider_export','invoice_transcription'];
const tokenCount=n=>n===null||(Number.isSafeInteger(n)&&n>=0);
function normalizeAttempts(o,model){
  if(!isObj(o)||Object.keys(o).sort().join(',')!==
    'attempts,correct,independentCheckLogSha256,slot,terminal')
    throw Error('invalid_observation');
  const base={slot:o.slot,terminal:o.terminal,correct:o.correct,
    independentCheckLogSha256:o.independentCheckLogSha256,
    modelObserved:null,attemptCount:null,billedCostUsd:null,billingSource:'unknown'};
  if(o.attempts===null){
    if(o.terminal!==null)throw Error('missing_attempt_records');
    return base;
  }
  if(o.terminal===null||!Array.isArray(o.attempts)||o.attempts.length<1||o.attempts.length>100)
    throw Error('invalid_attempt_records');
  let total=0n,complete=true;
  for(const a of o.attempts){
    if(!isObj(a)||Object.keys(a).sort().join(',')!==
      'billedCostUsd,billingSource,cachedInputTokens,inputTokens,modelObserved,outputTokens,terminal,usageSource'
      ||!['completed','failed','blocked'].includes(a.terminal)
      ||a.modelObserved!==model
      ||!['unknown','manual_estimate',...receiptSources].includes(a.billingSource)
      ||!['unknown','provider_export'].includes(a.usageSource)
      ||!['inputTokens','outputTokens','cachedInputTokens'].every(k=>tokenCount(a[k]))
      ||(a.usageSource==='unknown'&&[a.inputTokens,a.outputTokens,a.cachedInputTokens].some(n=>n!==null))
      ||(a.cachedInputTokens!==null&&(a.inputTokens===null||a.cachedInputTokens>a.inputTokens)))
      throw Error('invalid_attempt_records');
    if(a.billedCostUsd===null)complete=false;
    else{
      total+=moneyUnits(a.billedCostUsd);
      if(a.billingSource==='unknown')throw Error('missing_billing_source');
    }
  }
  const blocked=o.attempts.some(a=>a.terminal==='blocked');
  if(o.attempts.at(-1).terminal!==o.terminal&&!(blocked&&o.terminal==='blocked'))
    throw Error('attempt_terminal_mismatch');
  // A recovered infrastructure block still breaks the fixed trial conditions.
  if(blocked&&o.terminal!=='blocked')
    throw Error('blocked_attempt_requires_blocked_slot');
  base.modelObserved=model;base.attemptCount=o.attempts.length;
  if(complete){
    base.billedCostUsd=fromMoneyUnits(total);
    // Reject totals that cannot round-trip through the public numeric format.
    if(moneyUnits(base.billedCostUsd)!==total)throw Error('unsupported_charge_precision');
    base.billingSource=o.attempts.some(a=>a.billingSource==='manual_estimate')
      ?'manual_estimate':o.attempts.some(a=>a.billingSource==='invoice_transcription')
        ?'invoice_transcription':'provider_export';
  }
  return base;
}
function summarizeUsage(entries){
  const keys=['inputTokens','outputTokens','cachedInputTokens'];
  const totals=Object.fromEntries(keys.map(k=>[k,null]));
  if(entries.some(e=>!Array.isArray(e.attempts)))return totals;
  const attempts=entries.flatMap(e=>e.attempts);
  for(const key of keys){
    if(attempts.some(a=>a.usageSource!=='provider_export'||a[key]===null))continue;
    const sum=attempts.reduce((n,a)=>n+BigInt(a[key]),0n);
    if(sum<=BigInt(Number.MAX_SAFE_INTEGER))totals[key]=Number(sum);
  }
  return totals;
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
  if(!isObj(obs)||!['agent-brief-owner-trial-observations.v1','agent-brief-owner-trial-observations.v2'].includes(obs.schema)
    ||obs.pairFingerprint!==manifest.pairFingerprint
    ||obs.modelRequested!==manifest.modelRequested||obs.currency!=='USD'
    ||!Array.isArray(obs.entries)||obs.entries.length!==manifest.slots.length)
    throw Error('observations_trial_mismatch');
  const record=new Map();
  const detailed=obs.schema==='agent-brief-owner-trial-observations.v2';
  for(const entry of obs.entries){
    const e=detailed?normalizeAttempts(entry,manifest.modelRequested):entry;
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
  const blockedInfrastructure=manifest.slots.some(s=>record.get(s.id).terminal==='blocked');
  const missingGrades=manifest.slots.some(s=>record.get(s.id).correct===null);
  // Auth/workspace/tool blocks are not model task-quality outcomes; they
  // invalidate comparability rather than counting as a real edit failure.
  const qualityComplete=allCompleted&&!missingGrades&&!blockedInfrastructure;
  const arms={raw:[],prepared:[]};
  for(const slot of manifest.slots)arms[slot.arm].push(record.get(slot.id));
  const success=arm=>qualityComplete?arms[arm].filter(x=>x.correct===true).length:null;
  const rawPasses=success('raw'),preparedPasses=success('prepared');
  const regressions=qualityComplete?[...orders.keys()].filter(rep=>{
    const raw=manifest.slots.find(s=>s.repeat===rep&&s.arm==='raw');
    const prepared=manifest.slots.find(s=>s.repeat===rep&&s.arm==='prepared');
    return record.get(raw.id).correct===true&&record.get(prepared.id).correct===false;
  }).length:null;
  const billingEligible=allCompleted&&!blockedInfrastructure&&manifest.slots.every(s=>{
    const o=record.get(s.id);
    return o.billedCostUsd!==null&&receiptSources.includes(o.billingSource);
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
      :blockedInfrastructure?'blocked_infrastructure'
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
    attempts:{
      status:detailed?'owner_declared_per_attempt':'legacy_owner_declared_totals',
      rawCount:allCompleted?arms.raw.reduce((n,e)=>n+e.attemptCount,0):null,
      preparedCount:allCompleted?arms.prepared.reduce((n,e)=>n+e.attemptCount,0):null,
      coverageIndependentlyVerified:false
    },
    providerUsage:{
      status:detailed?'owner_declared_unverified':'unknown_legacy_totals',
      raw:summarizeUsage(manifest.slots.filter(s=>s.arm==='raw')
        .map(s=>obs.entries.find(e=>e.slot===s.id))),
      prepared:summarizeUsage(manifest.slots.filter(s=>s.arm==='prepared')
        .map(s=>obs.entries.find(e=>e.slot===s.id))),
      inputIncludesCachedTokens:true,
      authenticated:false
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
      :blockedInfrastructure?'Infrastructure blocked: no fair model-quality comparison'
      :!qualityComplete?'Missing quality outcomes: no quality comparison'
      :!billingEligible?'Costs missing or not supported by owner-declared receipt type'
      :ownerCandidate?'Provisional owner-reported candidate; NOT verified'
      :'No favorable comparable outcome on this owner-reported sample',
    warning:'This is ONE distinct task (repeated 1–3 times). Task outcomes, model identity, independent checks, retry coverage and provider charges are owner-declared, not independently authenticated. No meaningful statistical/generalization or verified dollar savings claim.'
  };
}
function importCodexTrial({trial,runs,out}){
  const dir=safeDirectory(trial);
  // Reuse the scorer's prompt, slot, order and manifest validation before importing.
  scoreTrial({trial:dir,observations:path.join(dir,'observations.template.json')});
  const manifest=readJson(path.join(dir,'manifest-private.json')),spec=readJson(runs);
  if(!isObj(spec)||Object.keys(spec).sort().join(',')!=='entries,pairFingerprint,schema'
    ||spec.schema!=='agent-brief-codex-trial-import.v1'
    ||spec.pairFingerprint!==manifest.pairFingerprint||!Array.isArray(spec.entries)
    ||spec.entries.length!==manifest.slots.length)throw Error('invalid_codex_import');
  const root=fs.realpathSync(path.dirname(path.resolve(runs)));
  const records=new Map(),threads=new Set(),traces=new Set(),evidence=[];
  let bytes=0;
  for(const entry of spec.entries){
    const slot=manifest.slots.find(s=>s.id===entry?.slot);
    if(!isObj(entry)||Object.keys(entry).sort().join(',')!=='attempts,promptSha256,slot'
      ||!slot||records.has(slot.id)||entry.promptSha256!==slot.promptSha256
      ||!Array.isArray(entry.attempts)||entry.attempts.length<1||entry.attempts.length>100)
      throw Error('invalid_codex_import');
    const attempts=[];
    for(const a of entry.attempts){
      if(!isObj(a)||Object.keys(a).sort().join(',')!=='eventsFile,exitCode,freshSession,modelObserved'
        ||a.freshSession!==true||a.modelObserved!==manifest.modelRequested
        ||typeof a.eventsFile!=='string'||!a.eventsFile||a.eventsFile.includes('\0')
        ||path.isAbsolute(a.eventsFile))throw Error('invalid_codex_import');
      const file=path.resolve(root,a.eventsFile);
      if(!within(root,file)||!within(root,fs.realpathSync(file)))throw Error('unsafe_codex_trace_path');
      const text=readFile(file);bytes+=Buffer.byteLength(text);
      if(bytes>32*MAX_FILE)throw Error('codex_import_too_large');
      const traceSha256=hash(text);
      const parsed=require('./codex-usage.cjs').parseCodexUsage(text,a.exitCode);
      if(traces.has(traceSha256)||threads.has(parsed.threadId))throw Error('reused_codex_trace');
      traces.add(traceSha256);threads.add(parsed.threadId);
      const {threadId,...usage}=parsed;
      attempts.push({...usage,modelObserved:a.modelObserved,billedCostUsd:null,billingSource:'unknown'});
      evidence.push({slot:slot.id,attempt:attempts.length,traceSha256,threadId,
        promptSha256:slot.promptSha256,exitCode:a.exitCode});
    }
    records.set(slot.id,{slot:slot.id,
      terminal:attempts.some(a=>a.terminal==='blocked')?'blocked':attempts.at(-1).terminal,
      correct:null,attempts,independentCheckLogSha256:null});
  }
  const observations={schema:'agent-brief-owner-trial-observations.v2',
    pairFingerprint:manifest.pairFingerprint,modelRequested:manifest.modelRequested,currency:'USD',
    entries:manifest.slots.map(s=>records.get(s.id))};
  const directory=destination(out,dir);
  fs.mkdirSync(directory,{mode:0o700});
  try{
    const file=path.join(directory,'observations.json');
    fs.writeFileSync(file,JSON.stringify(observations,null,2)+'\n',{flag:'wx',mode:0o600});
    const summary=scoreTrial({trial:dir,observations:file});
    fs.writeFileSync(path.join(directory,'import-evidence-private.json'),JSON.stringify({
      schema:'agent-brief-codex-import-evidence.v1',evidence,
      promptBinding:'owner_declared_hash_not_observed_in_trace',
      modelIdentity:'owner_declared_not_observed_in_trace',
      freshSessions:'owner_declared_not_proven_by_thread_started',
      providerAuthenticated:false
    },null,2)+'\n',{flag:'wx',mode:0o600});
    return {status:'imported_ungraded_codex_traces',slots:observations.entries.length,
      attempts:evidence.length,observationsFile:file,modelCalls:0,
      providerBillUsd:null,verifiedRealWorldSavings:false,
      trialStatus:summary.trialStatus,
      note:'Usage copied from local logs, not authenticated. Prompt/model/fresh-session bindings are owner declarations. Correctness and all charges remain unknown.'};
  }catch(e){fs.rmSync(directory,{recursive:true,force:true});throw e;}
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
  if(args.length===7&&args[0]==='import-codex'&&args[1]==='--trial'&&args[3]==='--runs'&&args[5]==='--out')
    return {mode:'import',args:{trial:args[2],runs:args[4],out:args[6]}};
  throw Error('invalid_trial_arguments');
}
const HELP=[
  'Agent Brief Lab · manual paired task trial (no AI calls or source edits)',
  'agent-brief trial init --pair PRIVATE_PAIR_DIR --out NEW_TEMP_DIR --model PINNED_MODEL [--repeats 1..3]',
  'agent-brief trial score --trial PRIVATE_TRIAL_DIR --observations PRIVATE_OWNER_JSON',
  'agent-brief trial import-codex --trial PRIVATE_TRIAL_DIR --runs PRIVATE_RUN_MAP --out NEW_TEMP_DIR',
  'Fill v2 template entries with observed outcomes and ALL attempt records (model, charge, native usage).',
  'Owner-provided values are NEVER authenticated by this tool; no real-world savings claims.',
].join('\n');
function runCli(argv=process.argv.slice(2),io={out:console.log,err:console.error}){
  try{
    const p=parseArgs(argv);
    if(p.mode==='help'){io.out(HELP);return 0;}
    io.out(JSON.stringify(p.mode==='init'?createTrial(p.args)
      :p.mode==='import'?importCodexTrial(p.args):scoreTrial(p.args),null,2));
    return 0;
  }catch(e){
    const allowed=new Set(['invalid_trial_options','invalid_trial_arguments',
      'invalid_private_file','invalid_private_json','invalid_private_directory',
      'trial_must_be_in_system_temp','trial_output_must_be_new',
      'invalid_trial_output_location','invalid_pair_report','pair_hash_mismatch',
      'invalid_pair_content','pair_content_mismatch','invalid_trial_manifest',
      'trial_prompt_integrity_failure','unpaired_trial_manifest','trial_order_integrity_failure',
      'observations_trial_mismatch','invalid_observation',
      'missing_attempt_records','invalid_attempt_records','attempt_terminal_mismatch',
      'blocked_attempt_requires_blocked_slot',
      'incomplete_observation_inconsistent','mismatched_or_unproven_model_outcome',
      'missing_billing_source','invalid_charge_amount','unsupported_charge_precision']);
    for(const code of ['invalid_codex_trace','ambiguous_codex_trace','inconsistent_codex_exit',
      'invalid_codex_usage','incomplete_codex_trace','invalid_codex_import',
      'unsafe_codex_trace_path','codex_import_too_large','reused_codex_trace'])allowed.add(code);
    io.err('Owner trial refused: '+(allowed.has(e.message)?e.message:'invalid_or_unsafe_evidence'));
    return 1;
  }
}
if(require.main===module)process.exitCode=runCli();
module.exports={createTrial,scoreTrial,importCodexTrial,parseArgs,runCli};
