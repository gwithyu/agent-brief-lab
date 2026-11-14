'use strict';
// Post-run quality and charge accounting. Never invokes a model, executes a
// patch, extrapolates invoice costs from local tokens, or publishes receipts.
const fs=require('node:fs');
const MAX_BYTES=2*1024*1024;
const own=(o,k)=>Object.prototype.hasOwnProperty.call(o,k);
const object=o=>o!==null&&typeof o==='object'&&!Array.isArray(o);
const finiteMoney=n=>typeof n==='number'&&Number.isFinite(n)&&n>=0;
const round=n=>Math.round((n+Number.EPSILON)*1e8)/1e8;
function checkKeys(o,required,optional=[]){
  if(!object(o)||required.some(k=>!own(o,k))||Object.keys(o).some(k=>![...required,...optional].includes(k)))
    throw Error('invalid_observation_schema');
}
function analyzeEfficiency(report,charges=null){
  if(!object(report)||report.provider!=='cursor-cli'
    ||!['read-only-code-proposals'].includes(report.experiment)
    ||report.gitIntegrity!=='PASS'||report.comparisonComplete!==true||report.state!=='completed')
    throw Error('incomplete_or_unsupported_report');
  if(!Array.isArray(report.runs)||report.runs.length<2||report.runs.length>180
    ||report.planned!==report.runs.length||report.attempted!==report.runs.length)
    throw Error('incomplete_run_set');
  for(const field of ['manifestDigest','repositoryCommit','modelRequested'])
    if(typeof report[field]!=='string'||!report[field].trim())throw Error('missing_report_identity');
  const map=new Map();
  for(const run of report.runs){
    if(!object(run)||typeof run.case!=='string'||!run.case.trim()
      ||!Number.isSafeInteger(run.repeat??0)||(run.repeat??0)<0
      ||!['raw','prepared'].includes(run.arm)||run.state!=='completed'
      ||typeof run.passed!=='boolean'||!Number.isSafeInteger(run.localInputTextTokens)
      ||run.localInputTextTokens<0)throw Error('invalid_run');
    const key=JSON.stringify([run.case,run.repeat??0]);
    if(!map.has(key))map.set(key,{case:run.case,repeat:run.repeat??0});
    const pair=map.get(key);
    if(pair[run.arm])throw Error('duplicate_arm');
    pair[run.arm]=run;
  }
  const pairs=[...map.values()];
  if(pairs.some(p=>!p.raw||!p.prepared)||pairs.length*2!==report.runs.length)
    throw Error('missing_paired_arm');
  const seenModels=new Set(report.runs.map(r=>r.reportedModel).filter(x=>typeof x==='string'));
  if(seenModels.size>1)throw Error('reported_model_drift');

  const rawPassed=pairs.filter(x=>x.raw.passed).length;
  const preparedPassed=pairs.filter(x=>x.prepared.passed).length;
  const regressions=pairs.filter(x=>x.raw.passed&&!x.prepared.passed);
  const improvements=pairs.filter(x=>!x.raw.passed&&x.prepared.passed);
  const localRaw=pairs.reduce((n,x)=>n+x.raw.localInputTextTokens,0);
  const localPrepared=pairs.reduce((n,x)=>n+x.prepared.localInputTextTokens,0);
  const noGain=pairs.filter(x=>x.prepared.localInputTextTokens>=x.raw.localInputTextTokens)
    .map(x=>({case:x.case,repeat:x.repeat}));
  const output={
    schema:'agent-brief-efficiency.v1',
    evidence:'synthetic_coding_proposal_tasks',
    identity:{manifestDigest:report.manifestDigest,repositoryCommit:report.repositoryCommit,modelRequested:report.modelRequested},
    pairCount:pairs.length,quality:{
      rawPasses:rawPassed,preparedPasses:preparedPassed,
      rawSuccessRate:round(rawPassed/pairs.length),
      preparedSuccessRate:round(preparedPassed/pairs.length),
      regressions:regressions.length,improvements:improvements.length,
      regressionCases:regressions.map(p=>({case:p.case,repeat:p.repeat})),
      improvementCases:improvements.map(p=>({case:p.case,repeat:p.repeat}))
    },
    localInputText:{
      rawTokens:localRaw,preparedTokens:localPrepared,
      tokensSaved:localRaw-localPrepared,
      reductionFraction:localRaw?round((localRaw-localPrepared)/localRaw):null,
      nonSavingPairs:noGain
    },
    cost:{
      status:'unknown_without_complete_external_charges',source:'none',
      rawTotalUsd:null,preparedTotalUsd:null,
      rawUsdPerSuccess:null,preparedUsdPerSuccess:null,
      rawBilledTokens:null,preparedBilledTokens:null,
      deltaUsdPerSuccess:null,reductionFractionPerSuccess:null,
      actualInvoiceVerified:false
    },
    observedOnThisSample:{
      qualityNonInferior:regressions.length===0&&preparedPassed>=rawPassed,
      lowerCostPerSuccess:null,
      qualifiesAsMeasuredWin:false
    },
    warning:'Local tokenizer counts are not provider usage or invoice charges; this is a narrow synthetic proposal benchmark, not autonomous editing. Imported costs are owner-supplied and not independently authenticated.'
  };
  if(charges===null)return output;
  checkKeys(charges,['schema','manifestDigest','repositoryCommit','modelRequested','currency','observations']);
  if(charges.schema!=='agent-brief-charges.v1'||charges.currency!=='USD'
    ||charges.manifestDigest!==report.manifestDigest
    ||charges.repositoryCommit!==report.repositoryCommit
    ||charges.modelRequested!==report.modelRequested
    ||!Array.isArray(charges.observations))throw Error('charge_identity_mismatch');

  const observed=new Map();
  for(const o of charges.observations){
    checkKeys(o,['case','repeat','arm','billedCostUsd','source','attemptCount'],
      ['providerInputTokens','providerCachedInputTokens','providerOutputTokens','providerReasoningTokens']);
    if(typeof o.case!=='string'||!Number.isSafeInteger(o.repeat)||o.repeat<0
      ||!['raw','prepared'].includes(o.arm)||!['provider_export','invoice_transcription'].includes(o.source)
      ||o.attemptCount!==1)throw Error('invalid_charge_observation');
    // The current Cursor harness invokes exactly one CLI process per arm and
    // does not log native retry usage. Refuse fictional retry counts.
    if(o.billedCostUsd!==null&&!finiteMoney(o.billedCostUsd))
      throw Error('invalid_charge_amount');
    const tokenFields=['providerInputTokens','providerCachedInputTokens','providerOutputTokens','providerReasoningTokens'];
    for(const k of tokenFields)
      if(own(o,k)&&o[k]!==null&&(!Number.isSafeInteger(o[k])||o[k]<0))
        throw Error('invalid_provider_token_count');
    if(Number.isSafeInteger(o.providerInputTokens)
      &&Number.isSafeInteger(o.providerCachedInputTokens)
      &&o.providerCachedInputTokens>o.providerInputTokens)throw Error('invalid_cached_token_count');
    const key=JSON.stringify([o.case,o.repeat,o.arm]);
    if(observed.has(key))throw Error('duplicate_charge_observation');
    if(!map.has(JSON.stringify([o.case,o.repeat])))throw Error('unexpected_charge_task');
    observed.set(key,o);
  }
  if(observed.size!==report.runs.length||report.runs.some(r=>!observed.has(JSON.stringify([r.case,r.repeat??0,r.arm])))){
    output.cost.status='incomplete_charge_coverage';
    return output;
  }
  const all=[...observed.values()];
  if(all.some(x=>x.billedCostUsd===null)){
    output.cost.status='missing_billed_cost';
    return output;
  }
  const amounts=arm=>all.filter(x=>x.arm===arm).reduce((n,x)=>n+x.billedCostUsd,0);
  const raw=round(amounts('raw')),prepared=round(amounts('prepared'));
  const rawPer=rawPassed?raw/rawPassed:null;
  const preparedPer=preparedPassed?prepared/preparedPassed:null;
  const advantage=rawPer!==null&&preparedPer!==null&&preparedPer<rawPer;
  const tokenTotals=arm=>{
    const relevant=all.filter(x=>x.arm===arm);
    const fields=['providerInputTokens','providerCachedInputTokens','providerOutputTokens','providerReasoningTokens'];
    if(relevant.some(x=>fields.some(k=>!Number.isSafeInteger(x[k]))))return null;
    return Object.fromEntries(fields.map(k=>[k,relevant.reduce((n,x)=>n+x[k],0)]));
  };
  output.cost={
    status:'owner_supplied_complete_unverified',
    source:[...new Set(all.map(x=>x.source))].sort(),
    rawTotalUsd:raw,preparedTotalUsd:prepared,
    rawUsdPerSuccess:rawPer===null?null:round(rawPer),
    preparedUsdPerSuccess:preparedPer===null?null:round(preparedPer),
    rawBilledTokens:tokenTotals('raw'),preparedBilledTokens:tokenTotals('prepared'),
    deltaUsdPerSuccess:rawPer===null||preparedPer===null?null:round(rawPer-preparedPer),
    reductionFractionPerSuccess:rawPer===null||rawPer<=0||preparedPer===null
      ?null:round((rawPer-preparedPer)/rawPer),
    actualInvoiceVerified:false
  };
  output.observedOnThisSample.lowerCostPerSuccess=rawPer===null||preparedPer===null?null:advantage;
  output.observedOnThisSample.qualifiesAsMeasuredWin=
    output.observedOnThisSample.qualityNonInferior&&advantage;
  return output;
}
function readPrivateJson(name){
  const st=fs.lstatSync(name);
  if(!st.isFile()||st.isSymbolicLink()||st.size>MAX_BYTES||st.size===0)throw Error('invalid_input_file');
  return JSON.parse(fs.readFileSync(name,'utf8'));
}
function runCli(argv=process.argv.slice(2)){
  if(![2,4].includes(argv.length)||argv[0]!=='--report'
    ||(argv.length===4&&argv[2]!=='--charges'))
    throw Error('Usage: node evaluation/cost-quality.cjs --report PRIVATE_REPORT_JSON [--charges PRIVATE_OWNER_SUPPLIED_CHARGES_JSON]');
  return analyzeEfficiency(readPrivateJson(argv[1]),argv.length===4?readPrivateJson(argv[3]):null);
}
if(require.main===module){
  try{console.log(JSON.stringify(runCli(),null,2));}
  catch(e){console.error('Efficiency evaluation refused: '+e.message);process.exitCode=1;}
}
module.exports={analyzeEfficiency,runCli};
