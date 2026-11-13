#!/usr/bin/env node
'use strict';
const fs = require('node:fs');
const path = require('node:path');
const { createHash } = require('node:crypto');
const ts = require('typescript');
const { getEncoding } = require('js-tiktoken');

const encoders = new Map();
function tokens(text, encoding = 'o200k_base') {
  if (typeof text !== 'string') throw new TypeError('Token input must be text');
  if (!['o200k_base', 'cl100k_base'].includes(encoding)) throw new Error('Unsupported encoding');
  if (!encoders.has(encoding)) encoders.set(encoding, getEncoding(encoding));
  return encoders.get(encoding).encode(text, [], []).length;
}

function sourceFile(source, fileName) {
  if (typeof source !== 'string' || !/\.(?:[cm]?[jt]s|[jt]sx)$/.test(fileName) || /\.d\.[cm]?ts$/.test(fileName)) {
    throw new Error('Expected a JS/TS implementation source');
  }
  const kind = fileName.endsWith('.tsx') ? ts.ScriptKind.TSX : fileName.endsWith('.jsx') ? ts.ScriptKind.JSX
    : /\.[cm]?ts$/.test(fileName) ? ts.ScriptKind.TS : ts.ScriptKind.JS;
  const parsed = ts.createSourceFile(fileName, source, ts.ScriptTarget.Latest, true, kind);
  const diagnostics = ts.transpileModule(source, {fileName, reportDiagnostics:true,
    compilerOptions:{allowJs:true, jsx:ts.JsxEmit.Preserve, module:ts.ModuleKind.ESNext, target:ts.ScriptTarget.ESNext}}).diagnostics ?? [];
  if (parsed.parseDiagnostics.length || diagnostics.some(d => d.category === ts.DiagnosticCategory.Error)) {
    throw new Error('Invalid source syntax');
  }
  return parsed;
}

function containsComment(text) {
  const scanner = ts.createScanner(ts.ScriptTarget.Latest, false, ts.LanguageVariant.Standard, text);
  for (let token = scanner.scan(); token !== ts.SyntaxKind.EndOfFileToken; token = scanner.scan()) {
    if (token === ts.SyntaxKind.SingleLineCommentTrivia || token === ts.SyntaxKind.MultiLineCommentTrivia) return true;
  }
  return false;
}

function booleanReturn(statement) {
  if (!statement) return null;
  if (ts.isBlock(statement)) {
    if (statement.statements.length !== 1) return null;
    statement = statement.statements[0];
  }
  if (!ts.isReturnStatement(statement)) return null;
  if (statement.expression?.kind === ts.SyntaxKind.TrueKeyword) return true;
  if (statement.expression?.kind === ts.SyntaxKind.FalseKeyword) return false;
  return null;
}

function simplify(source, fileName = 'input.js', encoding = 'o200k_base') {
  const parsed = sourceFile(source, fileName);
  const edits = [];
  function walk(node) {
    if (ts.isBlock(node)) {
      for (let i = 0; i < node.statements.length; i++) {
        const current = node.statements[i], next = node.statements[i + 1];
        if (ts.isIfStatement(current) && !current.elseStatement && next && ts.isReturnStatement(next)) {
          const yes = booleanReturn(current.thenStatement), no = booleanReturn(next);
          const start = current.getStart(parsed), end = next.end;
          if (yes !== null && no !== null && yes !== no && !containsComment(source.slice(start, end))) {
            edits.push({start, end, replacement:`return ${yes ? '!!' : '!'}(${current.expression.getText(parsed)});`});
            i++;
            continue;
          }
        }
        walk(current);
      }
      return;
    }
    if (ts.isIfStatement(node)) {
      const yes = booleanReturn(node.thenStatement), no = booleanReturn(node.elseStatement);
      const start = node.getStart(parsed), end = node.end;
      if (yes !== null && no !== null && yes !== no && !containsComment(source.slice(start, end))) {
        edits.push({start, end, replacement:`return ${yes ? '!!' : '!'}(${node.expression.getText(parsed)});`});
        return;
      }
    }
    ts.forEachChild(node, walk);
  }
  walk(parsed);
  let candidate = source;
  for (const edit of [...edits].sort((a,b) => b.start - a.start)) {
    candidate = candidate.slice(0, edit.start) + edit.replacement + candidate.slice(edit.end);
  }
  sourceFile(candidate, fileName);
  const beforeTokens = tokens(source, encoding), proposedTokens = tokens(candidate, encoding);
  const accepted = edits.length > 0 && proposedTokens < beforeTokens && Buffer.byteLength(candidate) < Buffer.byteLength(source);
  const code = accepted ? candidate : source;
  const lines = text => text ? text.replace(/(?:\r\n|\r|\n)$/, '').split(/\r\n|\r|\n/).length : 0;
  return {code, edits:accepted ? edits : [], metrics:{encoding, beforeTokens, afterTokens:accepted ? proposedTokens : beforeTokens,
    tokensSaved:accepted ? beforeTokens - proposedTokens : 0, beforeLines:lines(source), afterLines:lines(code),
    beforeBytes:Buffer.byteLength(source), afterBytes:Buffer.byteLength(code), candidates:edits.length, applied:accepted ? edits.length : 0}};
}

function text(value) { return typeof value === 'string' && value.trim().length > 0; }
function list(value) { return Array.isArray(value) && value.every(text) && new Set(value).size === value.length; }
function exactFields(value, names) {
  return value && typeof value === 'object' && !Array.isArray(value)
    && Reflect.ownKeys(value).length === names.length && names.every(name => Object.hasOwn(value, name));
}
function filePath(value) {
  return text(value) && !/[\\:*?\[\]{}\x00-\x1f]/.test(value) && !path.posix.isAbsolute(value) && !path.win32.isAbsolute(value)
    && value !== '.' && !value.split('/').some(part => !part || part === '.' || part === '..')
    && path.posix.normalize(value) === value;
}

function validateIntent(intent) {
  if (!exactFields(intent, ['request','goal','allowedFiles','constraints','acceptance','questions'])
    || !text(intent.request) || !text(intent.goal)
    || !list(intent.allowedFiles) || !intent.allowedFiles.length || !intent.allowedFiles.every(filePath)
    || !Array.isArray(intent.constraints) || !intent.constraints.length
    || !Array.isArray(intent.acceptance) || !intent.acceptance.length || !list(intent.questions)) {
    throw new Error('Invalid intent schema: exactly request, goal, allowedFiles, constraints, acceptance and questions are required');
  }
  const entries = [...intent.constraints, ...intent.acceptance];
  if (entries.some(item => !exactFields(item, ['id','text']) || !/^[a-z][a-z0-9_]*$/.test(item.id) || !text(item.text))
    || new Set(entries.map(item => item.id)).size !== entries.length) throw new Error('Invalid intent entry schema or duplicate IDs');
  return intent;
}

function intentDigest(intent) {
  validateIntent(intent);
  const entries = values => values.map(({id,text}) => ({id,text}));
  return createHash('sha256').update(JSON.stringify({request:intent.request,goal:intent.goal,allowedFiles:intent.allowedFiles,
    constraints:entries(intent.constraints),acceptance:entries(intent.acceptance),questions:intent.questions})).digest('hex');
}

function checkPlan(intent, plan) {
  validateIntent(intent);
  const failures = [];
  if (!exactFields(plan, ['intentDigest','files','acknowledgedConstraints','checks'])
    || !list(plan.files) || !plan.files.length || !plan.files.every(filePath)
    || !list(plan.acknowledgedConstraints) || !list(plan.checks)) throw new Error('Invalid plan schema');
  if (plan.intentDigest !== intentDigest(intent)) failures.push('Plan is not bound to the current intent');
  for (const file of plan.files) if (!intent.allowedFiles.includes(file)) failures.push(`Outside allowed edit scope: ${file}`);
  for (const item of intent.constraints) if (!plan.acknowledgedConstraints.includes(item.id)) failures.push(`Unacknowledged constraint: ${item.id}`);
  for (const item of intent.acceptance) if (!plan.checks.includes(item.id)) failures.push(`Missing acceptance check: ${item.id}`);
  for (const id of plan.acknowledgedConstraints) if (!intent.constraints.some(item => item.id === id)) failures.push(`Unknown constraint: ${id}`);
  for (const id of plan.checks) if (!intent.acceptance.some(item => item.id === id)) failures.push(`Unknown acceptance check: ${id}`);
  for (const question of intent.questions) failures.push(`Unresolved question: ${question}`);
  return {ok:failures.length === 0, failures, scope:'Declared plan only; no proof of execution or semantic understanding'};
}

function brief(intent) {
  validateIntent(intent);
  return `Intent digest: ${intentDigest(intent)}\n\nOriginal request:\n${intent.request}\n\nGoal:\n${intent.goal}\n\nAllowed edit files:\n${intent.allowedFiles.map(x => '- '+x).join('\n')}`
    + `\n\nConstraints:\n${intent.constraints.map(x => '- ['+x.id+'] '+x.text).join('\n')}`
    + `\n\nAcceptance:\n${intent.acceptance.map(x => '- ['+x.id+'] '+x.text).join('\n')}`
    + `\n\nUnresolved questions:\n${intent.questions.length ? intent.questions.map(x => '- '+x).join('\n') : 'None recorded'}\n`;
}

module.exports = {tokens, simplify, validateIntent, intentDigest, checkPlan, brief, filePath};

if (require.main === module) {
  const args=process.argv.slice(2);
  const [command, file, extra, fourth, fifth, sixth] = args;
  const help=`Usage: agent-brief <command> [options]

Commands:
  measure <source> [encoding]                 Measure a conservative rewrite candidate
  compact <source> [encoding]                 Print a smaller candidate without overwriting source
  brief <intent.json>                         Print the complete explicit intent brief
  check <intent.json> <plan.json>             Validate declared scope, constraints and checks
  baseline <intent.json> <repo>               Capture a trusted Git working-tree baseline
  verify <intent.json> <plan.json> <baseline.json> <repo> [encoding]
                                               Compare actual edits with the bound plan
  review <intent.json> <plan.json> <baseline.json> <repo> <checks.json>
                                               Run caller-reviewed checks after scope validation
  pack <intent.json> <sources.json> [encoding] Pack intent and complete allowed sources
  context <intent.json> <before.json> <after.json> [encoding]
                                               Measure complete before/after input envelopes
  history <messages.json> [encoding]           Pack repeated tool-output strings losslessly
  restore <history-input.json> [expected-sha256]
                                               Restore and verify a packed history document
  prepare <intent.json> <sources.json> <messages.json> [encoding] [min-saving-tokens]
                                               Build one measured input envelope; default minimum 1 token
  session <intent.json> <repo> <new-output-dir>
                                               Prepare a bundle for the current agent; no model call
  propose <intent.json> <repo> <new-output-dir> [--live --model MODEL]
                                               Prepare or request a review-only source proposal

Options:
  -h, --help                                   Show this help and exit
  -V, --version                                Show the installed version and exit

Exit status: 0 success; 1 invalid/rejected/check failure; 2 incorrect CLI usage.
`;
  if(args.length===1 && ['--help','-h'].includes(args[0])) process.stdout.write(help);
  else if(args.length===1 && ['--version','-V'].includes(args[0])) console.log(require('./package.json').version);
  else if(args[0]==='propose') {
    try {
      const [_,intentFile,repo,out,...options]=args;
      if(!intentFile||!repo||!out||!(options.length===0||(options.length===3&&options[0]==='--live'&&options[1]==='--model')))throw Object.assign(new Error('Usage: agent-brief propose <intent.json> <repo> <new-output-dir> [--live --model MODEL]'),{exitCode:2});
      const result=require('./propose.cjs').propose(JSON.parse(fs.readFileSync(intentFile,'utf8')),repo,out,{live:options.length>0,model:options[2]});
      console.log(JSON.stringify(result,null,2));if(!['prepared','proposal_ready'].includes(result.state))process.exitCode=1;
    }catch(error){console.error(error.message);process.exitCode=error.exitCode??1;}
  } else {
  const arity={measure:[2,3],compact:[2,3],check:[3,3],brief:[2,2],baseline:[3,3],verify:[5,6],context:[4,5],pack:[3,4],history:[2,3],restore:[2,3],review:[6,6],prepare:[4,6],session:[4,4]};
  const readJson=name=>JSON.parse(fs.readFileSync(name,'utf8'));
  try {
    if (!arity[command] || args.length<arity[command][0] || args.length>arity[command][1]) {
      console.error('Usage: agent-brief <command> [options]\nRun agent-brief --help for command details.');
      process.exitCode = 2;
    } else if (command === 'measure' || command === 'compact') {
      const result = simplify(fs.readFileSync(file,'utf8'), file, extra ?? 'o200k_base');
      process.stdout.write(command === 'compact' ? result.code : JSON.stringify(result.metrics,null,2)+'\n');
    } else if(command==='session') {
      const result=require('./session.cjs').startSession(readJson(file),extra,fourth);
      console.log(JSON.stringify(result,null,2));
      if(result.state!=='session_ready')process.exitCode=1;
    } else if(command==='prepare') {
      const minimum=sixth===undefined?1:(/^[1-9][0-9]*$/.test(sixth)?Number(sixth):NaN);
      console.log(JSON.stringify(require('./prepare.cjs').prepareInput(readJson(file),readJson(extra),readJson(fourth),fifth??'o200k_base',minimum),null,2));
    } else if(command==='review') {
      const result=require('./review.cjs').reviewChanges(readJson(file),readJson(extra),readJson(fourth),fifth,readJson(sixth));
      console.log(JSON.stringify(result,null,2));
      if(!result.ok) process.exitCode=1;
    } else if(command==='history' || command==='restore') {
      const {packHistory,unpackHistory}=require('./history.cjs');
      console.log(JSON.stringify(command==='history'?packHistory(readJson(file),extra):unpackHistory(readJson(file),extra),null,2));
    } else if(command==='pack') {
      console.log(JSON.stringify(require('./context.cjs').packContext(readJson(file),readJson(extra),fourth),null,2));
    } else if(['baseline','verify','context'].includes(command)) {
      const {captureBaseline,checkChanges,measureContext}=require('./execution.cjs');
      const intent=readJson(file);
      const result=command==='baseline'?captureBaseline(intent,extra)
        :command==='context'?measureContext(intent,readJson(extra),readJson(fourth),fifth)
        :checkChanges(intent,readJson(extra),readJson(fourth),fifth,sixth);
      console.log(JSON.stringify(result,null,2));
      if(result.ok===false) process.exitCode=1;
    } else {
      const intent = JSON.parse(fs.readFileSync(file,'utf8'));
      if (command === 'brief') process.stdout.write(brief(intent));
      else {
        const result = checkPlan(intent, JSON.parse(fs.readFileSync(extra,'utf8')));
        console.log(JSON.stringify(result,null,2));
        if (!result.ok) process.exitCode = 1;
      }
    }
  } catch (error) { console.error(error.message); process.exitCode = 1; }
}
}
