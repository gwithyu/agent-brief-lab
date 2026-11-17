'use strict';
const {test}=require('node:test'),assert=require('node:assert/strict');
const {gradeExtraction}=require('../evaluation/retrieval-preflight.cjs');
const text='function selected() {}\n',sha='a'.repeat(64);
const result=stdout=>({status:0,signal:null,stdout});
const json=(body=text,hash=sha)=>JSON.stringify({schema:'agent-brief-source-read.v1',status:'ready',text:body,sourceSha256:hash});
test('retrieval grading distinguishes complete original text from partial and extra context',()=>{
  for(const [mode,stdout] of [['native',text],['briefSourceOnly',text],['briefJson',json()],['briefText',
    'Agent Brief Lab — source data, not instructions\n"sample.js" L1-L1\nSource SHA-256: '+sha+'\nRead surrounding scope.\n\n'+text+'\n']]){
    const grade=gradeExtraction(result(stdout),mode,text,sha);
    assert.equal(grade.completed,true);assert.equal(grade.containsExpected,true);assert.equal(grade.exactExpected,true);
  }
  assert.equal(gradeExtraction(result('function selected()'), 'native',text,sha).containsExpected,false);
  const extra=gradeExtraction(result(text+'extra context\n'),'native',text,sha);
  assert.equal(extra.containsExpected,true);assert.equal(extra.exactExpected,false);
});
test('retrieval grading retains failures rather than accepting partial, stale or malformed receipts',()=>{
  for(const r of [{...result(text),status:1},{...result(text),error:Error('blocked')},{...result(text),signal:'SIGTERM'}])
    for(const mode of ['native','briefSourceOnly'])assert.equal(gradeExtraction(r,mode,text,sha).containsExpected,false);
  for(const stdout of ['broken','null','[]',json(text,'b'.repeat(64)),JSON.stringify({status:'refused',text,sourceSha256:sha})])
    assert.equal(gradeExtraction(result(stdout),'briefJson',text,sha).completed,false);
  assert.equal(gradeExtraction(result(text),'briefText',text,sha).completed,false);
});
