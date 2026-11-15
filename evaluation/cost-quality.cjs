'use strict';
// Post-run quality and charge accounting. Never invokes a model, executes a
// patch, extrapolates invoice costs from local tokens, or publishes receipts.
const fs=require('node:fs');
const {formatEfficiencyMarkdown}=require('./cost-quality-markdown.cjs');
const MAX_BYTES=2*1024*1024;
const own=(o,k)=>Object.prototype.hasOwnProperty.call(o,k);
const object=o=>o!==null&&typeof o==='object'&&!Array.isArray(o);
const finiteMoney=n=>typeof n==='number'&&Number.isFinite(n)&&n>=0;
const round=n=>Math.round((n+Number.EPSILON)*1e8)/1e8;
// Use integer units of 10^-12 USD to avoid binary floating-point summation
// inventing or erasing changes near the price-of-a-single-token scale.
const USD_SCALE=1000000000000n;
function moneyUnits(value){
  if(!finiteMoney(value)||value>1e9)throw Error('invalid_charge_amount');
  const m=String(value).match(/^(\d+)(?:\.(\d+))?(?:e([+-]?\d+))?$/i);
  if(!m)throw Error('invalid_charge_amount');
  const digits=BigInt(m[1]+(m[2]??''));
  const power=12-(m[2]?.length??0)+Number(m[3]??0);
  if(power>25||power< -330)throw Error('unsupported_charge_precision');
  if(power>=0)return digits*10n**BigInt(power);
  const divisor=10n**BigInt(-power);
  if(digits%divisor!==0n)throw Error('unsupported_charge_precision');
  return digits/divisor;
}
function fromMoneyUnits(units){return Number(units)/Number(USD_SCALE);}

function checkKeys(o,required,optional=[]){
  if(!object(o)||required.some(k=>!own(o,k))||Object.keys(o).some(k=>![...required,...optional].includes(k)))
    throw Error('invalid_observation_schema');
}
function analyzeEfficiency(report,charges=null){
  if(!object(report)||report.provider!=='cursor-cli'
    ||!['read-only-code-proposals','synthetic-autonomous-edits'].includes(report.experiment)
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
  const seenModels=new Set(report.runs.map(r=>r.reportedModel));
  if(seenModels.size!==1||[...seenModels].some(m=>typeof m!=='string'||!m.trim()))
    throw Error('missing_or_drifted_reported_model');
  if(report.modelCompleted!==report.runs.length
    ||report.passed!==report.runs.filter(r=>r.passed).length)
    throw Error('inconsistent_report_summary');

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
    evidence:report.experiment==='synthetic-autonomous-edits'?'synthetic_coding_agent_edits':'synthetic_coding_proposal_tasks',
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
      rawProviderTokenCounts:null,preparedProviderTokenCounts:null,
      deltaUsdPerSuccess:null,reductionFractionPerSuccess:null,
      actualInvoiceVerified:false
    },
    sample:{
      distinctTaskCount:new Set(pairs.map(p=>p.case)).size,
      meets30DistinctTaskGate:new Set(pairs.map(p=>p.case)).size>=30,
      isRepresentativeProductionSample:false,
      evidenceAuthenticatedByProvider:false
    },
    observedOnThisSample:{
      qualityNonInferior:regressions.length===0&&preparedPassed>=rawPassed,
      lowerCostPerSuccess:null,
      ownerReportedSavingsCandidate:false,
      // A declaration is never independent evidence. This is deliberately
      // false even if a user-supplied price table looks favorable.
      qualifiesAsMeasuredWin:false,
      verifiedSavingsClaim:false
    },
    warning:'Local tokenizer counts are not provider usage or invoice charges. These are narrow synthetic tasks, not representative production workloads; imported costs are owner-supplied and not independently authenticated.'
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
    if(o.billedCostUsd!==null)moneyUnits(o.billedCostUsd);
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
  const units=arm=>all.filter(x=>x.arm===arm).reduce((n,x)=>n+moneyUnits(x.billedCostUsd),0n);
  const rawUnits=units('raw'),preparedUnits=units('prepared');
  const raw=fromMoneyUnits(rawUnits),prepared=fromMoneyUnits(preparedUnits);
  const rawPer=rawPassed?fromMoneyUnits(rawUnits)/rawPassed:null;
  const preparedPer=preparedPassed?fromMoneyUnits(preparedUnits)/preparedPassed:null;
  const advantage=rawPassed>0&&preparedPassed>0
    &&preparedUnits*BigInt(rawPassed)<rawUnits*BigInt(preparedPassed);
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
    rawUsdPerSuccess:rawPer,preparedUsdPerSuccess:preparedPer,
    rawProviderTokenCounts:tokenTotals('raw'),preparedProviderTokenCounts:tokenTotals('prepared'),
    deltaUsdPerSuccess:rawPer===null||preparedPer===null?null:
      fromMoneyUnits(rawUnits*BigInt(preparedPassed)-preparedUnits*BigInt(rawPassed))
        /(rawPassed*preparedPassed),
    reductionFractionPerSuccess:rawPer===null||rawPer<=0||preparedPer===null
      ?null:round((rawPer-preparedPer)/rawPer),
    actualInvoiceVerified:false
  };
  output.observedOnThisSample.lowerCostPerSuccess=rawPer===null||preparedPer===null?null:advantage;
  output.observedOnThisSample.ownerReportedSavingsCandidate=
    output.observedOnThisSample.qualityNonInferior&&advantage;
  // Owner-imported cost entries are not an authenticated Cursor invoice or
  // native usage receipt. Never upgrade them to a verified savings claim.
  output.observedOnThisSample.qualifiesAsMeasuredWin=false;
  output.observedOnThisSample.verifiedSavingsClaim=false;
  return output;
}
function buildChargeTemplate(report){
  // First require a genuinely comparable recorded A/B experiment. A
  // zero/partial record is not a valid target for cost extrapolation.
  analyzeEfficiency(report);
  return {
    schema:'agent-brief-charges.v1',
    manifestDigest:report.manifestDigest,
    repositoryCommit:report.repositoryCommit,
    modelRequested:report.modelRequested,
    currency:'USD',
    observations:report.runs.map(r=>({
      case:r.case,repeat:r.repeat??0,arm:r.arm,
      attemptCount:1,billedCostUsd:null,source:'provider_export'
    }))
  };
}
function readPrivateJson(name){
  const st=fs.lstatSync(name);
  if(!st.isFile()||st.isSymbolicLink()||st.size>MAX_BYTES||st.size===0)throw Error('invalid_input_file');
  return JSON.parse(fs.readFileSync(name,'utf8'));
}
function runCli(argv=process.argv.slice(2)){
  const markdown=argv.at(-1)==='--markdown';
  const args=markdown?argv.slice(0,-1):argv;
  if(![2,3,4].includes(args.length)||args[0]!=='--report'
    ||(args.length===3&&args[2]!=='--template')
    ||(args.length===4&&args[2]!=='--charges')
    ||(markdown&&args.length===3))
    throw Error('Usage: node evaluation/cost-quality.cjs --report PRIVATE_REPORT_JSON [--template | --charges PRIVATE_OWNER_SUPPLIED_CHARGES_JSON] [--markdown]');
  const report=readPrivateJson(args[1]);
  if(args.length===3)return buildChargeTemplate(report);
  const result=analyzeEfficiency(report,args.length===4?readPrivateJson(args[3]):null);
  return markdown?formatEfficiencyMarkdown(result):result;
}
if(require.main===module){
  try{
    const result=runCli();
    console.log(typeof result==='string'?result:JSON.stringify(result,null,2));
  }
  catch(e){console.error('Efficiency evaluation refused: '+e.message);process.exitCode=1;}
}
module.exports={analyzeEfficiency,buildChargeTemplate,moneyUnits,fromMoneyUnits,runCli};
