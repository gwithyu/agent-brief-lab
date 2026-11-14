'use strict';

// Human-readable, aggregate-only output. Never exposes source snippets, raw
// model text, invoices, local paths, or unverifiable "bill savings" claims.
function asFinite(n) {
  if(typeof n!=='number'||!Number.isFinite(n))throw Error('invalid_summary_number');
  return n;
}
function count(n){
  if(!Number.isSafeInteger(n)||n<0)throw Error('invalid_summary_count');
  return String(n);
}
function percent(n){
  if(n===null||n===undefined)return 'Unknown';
  return (asFinite(n)*100).toFixed(2)+'%';
}
function money(n){
  if(n===null||n===undefined)return 'Unknown';
  asFinite(n);
  if(n<0)throw Error('invalid_summary_money');
  if(n===0)return '$0.00';
  if(n<1e-6)return '$'+n.toPrecision(5);
  return '$'+n.toFixed(n<0.01?8:4);
}
function safeId(id){
  return String(id).replace(/[^A-Za-z0-9_-]/g,'_').slice(0,64);
}
function flagCases(items){
  if(!Array.isArray(items))throw Error('invalid_cases');
  if(!items.length)return 'None observed';
  return items.slice(0,8).map(x=>safeId(x.case)+' (repeat '+count(x.repeat)+')').join(', ')
    +(items.length>8?' and '+(items.length-8)+' more':'');
}
function formatEfficiencyMarkdown(s){
  if(!s||s.schema!=='agent-brief-efficiency.v1'||!s.quality||!s.localInputText||!s.cost
    ||!s.observedOnThisSample||!s.sample)
    throw Error('invalid_efficiency_summary');
  const q=s.quality,c=s.cost,local=s.localInputText,decision=s.observedOnThisSample;
  const notes=[];
  if(q.regressions>0)notes.push('Quality regression: at least one baseline-passing task failed after preparation.');
  if(!s.sample.meets30DistinctTaskGate)
    notes.push('Sample size: fewer than 30 distinct tasks; no general quality conclusion.');
  if(!s.sample.isRepresentativeProductionSample)
    notes.push('Synthetic coding tasks are not representative production workloads.');
  if(c.status!=='owner_supplied_complete_unverified')
    notes.push('Provider charges incomplete or unavailable: the money comparison is unknown.');
  else
    notes.push('Costs are owner-entered, not independently verified against provider billing.');
  notes.push('These tasks test synthetic '+(s.evidence==='synthetic_coding_agent_edits'?'file editing':'code proposals')+
    '; results do not establish production accuracy or cost savings.');
  const provisional=c.status==='owner_supplied_complete_unverified'
    ?decision.ownerReportedSavingsCandidate?'Owner-declared candidate only — NOT VERIFIED'
      :q.regressions?'Quality regression — not recommended':'No owner-declared saving proven on this sample'
    :'Cost unknown — no savings claim';
  return [
    '# Agent Brief Lab — Cost & quality A/B scorecard',
    '',
    '> **Verified real-world savings: NO.** This is an experimental synthetic-task report.',
    '',
    '**Interpretation:** '+provisional,
    '',
    '| Metric | Raw | Prepared |',
    '| --- | ---: | ---: |',
    '| Correct tasks | '+count(q.rawPasses)+' / '+count(s.pairCount)+' | '+count(q.preparedPasses)+' / '+count(s.pairCount)+' |',
    '| Task success rate | '+percent(q.rawSuccessRate)+' | '+percent(q.preparedSuccessRate)+' |',
    '| Local prompt text tokens | '+count(local.rawTokens)+' | '+count(local.preparedTokens)+' |',
    '| Owner-declared USD total | '+money(c.rawTotalUsd)+' | '+money(c.preparedTotalUsd)+' |',
    '| Owner-declared USD / success | '+money(c.rawUsdPerSuccess)+' | '+money(c.preparedUsdPerSuccess)+' |',
    '',
    '**Local text reduction:** '+percent(local.reductionFraction)+
      ' ('+count(Math.abs(local.tokensSaved))+' tokens '+(local.tokensSaved>=0?'fewer':'more')+').',
    '',
    '**Raw-pass / prepared-fail regressions:** '+count(q.regressions)+
      '. **Prepared-only improvements:** '+count(q.improvements)+'.',
    '',
    '**Regression cases:** '+flagCases(q.regressionCases),
    '',
    '**Non-saving input pairs:** '+count(local.nonSavingPairs.length)+'.',
    '',
    '**Sample:** '+count(s.pairCount)+' matched pairs / '+count(s.sample?.distinctTaskCount??s.sample?.count??s.sampleCount??s.sample?.taskCount??s.pairCount)+' tasks.',
    '',
    '## Evidence limits',
    ...notes.map(n=>'- '+n),
    '',
    '**No actual invoice was authenticated by this tool.** Local tokenizer reductions are not USD savings.',
    ''
  ].join('\n');
}
module.exports={formatEfficiencyMarkdown};
