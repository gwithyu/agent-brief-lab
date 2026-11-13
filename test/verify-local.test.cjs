'use strict';
const {test}=require('node:test');
const assert=require('node:assert/strict');
const fs=require('node:fs'),os=require('node:os'),path=require('node:path');
const {spawnSync}=require('node:child_process');

const available=process.platform!=='win32' &&
  spawnSync('bash',['--version'],{encoding:'utf8'}).status===0 &&
  spawnSync('git',['--version'],{encoding:'utf8'}).status===0;
function fixture(kind,major='20') {
  const dir=fs.mkdtempSync(path.join(os.tmpdir(),'brief-runner-'));
  const repo=path.join(dir,'repo'),bin=path.join(dir,'bin');
  fs.mkdirSync(path.join(repo,'scripts'),{recursive:true});fs.mkdirSync(bin);
  try {
    fs.copyFileSync(path.join(__dirname,'../scripts/verify-local.sh'),path.join(repo,'scripts/verify-local.sh'));
    fs.writeFileSync(path.join(repo,'package.json'),'{}\n');
    fs.writeFileSync(path.join(repo,'package-lock.json'),'{}\n');
    fs.writeFileSync(path.join(repo,'fixture.txt'),'initial\n');
    fs.writeFileSync(path.join(bin,'node'),`#!/bin/sh\nif [ "$1" = -p ]; then echo ${major}.1.0; else echo v${major}.1.0; fi\n`,{mode:0o755});
    fs.writeFileSync(path.join(bin,'npm'),`#!/bin/bash
case "$1" in
  --version) echo 10.0.0 ;;
  ci)
    if [ "$VERIFY_CASE" = "install_commit" ]; then
      echo changed > fixture.txt; git add fixture.txt
      git -c user.name=Runner -c user.email=runner@example.invalid commit -qm install-commit
    fi
    echo install-ok ;;
  test)
    if [ "$VERIFY_CASE" = "test_commit" ]; then
      echo changed > fixture.txt; git add fixture.txt
      git -c user.name=Runner -c user.email=runner@example.invalid commit -qm test-commit
    fi
    if [ "$VERIFY_CASE" = "dirty" ]; then echo changed > fixture.txt; fi
    if [ "$VERIFY_CASE" = "test_failed" ]; then echo failure; exit 9; fi
    echo tests-ok ;;
  *) exit 3 ;;
esac
`,{mode:0o755});
    for(const args of [
      ['init','-q'],['add','.'],
      ['-c','user.name=Runner','-c','user.email=runner@example.invalid','commit','-qm','initial']
    ]){
      const r=spawnSync('git',args,{cwd:repo,encoding:'utf8'});
      assert.equal(r.status,0,r.stderr);
    }
    const commit=()=>spawnSync('git',['rev-parse','HEAD'],{cwd:repo,encoding:'utf8'}).stdout.trim();
    const before=commit();
    const result=spawnSync('bash',['scripts/verify-local.sh'],{
      cwd:repo,encoding:'utf8',timeout:30000,
      env:{...process.env,PATH:bin+path.delimiter+process.env.PATH,VERIFY_CASE:kind}
    });
    const after=commit();
    return {status:result.status,output:result.stdout+'\n'+result.stderr,before,after};
  } finally {fs.rmSync(dir,{recursive:true,force:true});}
}
const cases=[
  ['clean Node 20 succeeds','clean','20',0,false,true],
  ['clean Node 24 succeeds','clean','24',0,false,true],
  ['wrong Node major is rejected','clean','22',2,false,false],
  ['test-stage HEAD mutation is rejected','test_commit','20',2,true,false],
  ['install-stage HEAD mutation is rejected','install_commit','20',2,true,false],
  ['dirty working tree is rejected','dirty','20',2,false,false],
  ['npm test failure is rejected','test_failed','20',9,false,false]
];
for(const [name,kind,major,status,moved,verified] of cases) {
  test(name,{skip:!available},()=>{
    const r=fixture(kind,major);
    assert.equal(r.status,status,r.output);
    assert.equal(r.before!==r.after,moved);
    assert.equal(/^VERIFIED:/m.test(r.output),verified,r.output);
    if(!verified && major!=='22')assert.match(r.output,/NOT VERIFIED:/);
  });
}
