# Agent Brief Lab

**Public alpha · 0.11.0-alpha.3 · MIT · Node.js 20+**

Local experiments for preparing smaller coding-agent inputs while keeping explicit user constraints, and checking what changed in a Git working tree.

This is an experimental CLI/library, **not a proven agent-cost optimizer or a natural-language understanding system**. It does not intercept ChatGPT or automatically change any agent's context. Live agent A/B testing is blocked in the release environment; see [EVALUATION.md](EVALUATION.md).

## Install from source

```sh
git clone https://github.com/gwithyu/agent-brief-lab.git
cd agent-brief-lab
npm ci --ignore-scripts
npm test
npm run demo
```

Requires Git for working-tree checks and workspace demos. Dependencies are installed separately; they are not bundled. This release is published as GitHub source; it is not published on the npm registry (`private: true` is intentional).

## What it does

- Rewrites two conservative boolean-return forms, only when source bytes and selected-tokenizer tokens both decrease. Outputs candidates without overwriting source.
- Preserves the original request, goal, exact allowed files, constraint/check IDs, unresolved questions and intent fingerprint in a brief. Intent fields must be supplied explicitly.
- Packs identical tool-output strings into a reversible history dictionary, while preserving every message's position, role and metadata. Short results remain inline when references would cost more.
- Counts an entire prepared input, including formatting, instructions, references and fingerprints. Reports both savings against a fully guided baseline and net change against the original request.
- Checks actual tracked and nonignored working-tree files against a trusted baseline. Optionally runs caller-reviewed acceptance commands and checks the tree after **each** command.

## One-command Codex proposal adapter

From a fresh clone, preview a real bundled source file without invoking a model:

```sh
node index.cjs propose examples/propose-intent.json . ../agent-brief-preview
```

To send the prepared task to your authenticated, compatible local Codex CLI:

```sh
node index.cjs propose examples/propose-intent.json . ../agent-brief-live --live --model YOUR_MODEL_ID
```

For your own project, supply an intent JSON with its exact allowed paths and
replace `.` with that project's Git root. Output must be a **new directory outside
the target repository**. No manual sources/history JSON is needed: the adapter
captures a baseline and reads all allowed source files automatically.

Preview creates private input/baseline/prompt/report files, with zero invocation
attempts. Live mode explicitly sends the request and allowed source contents to
the selected model and can consume quota; review what you permit first. It uses
the same read-only Codex adapter as the evaluator: apps, plugins and the shell
tool are disabled, and unexpected tool events invalidate responses. It does not copy
credentials or change global settings. Unresolved intent questions block calls.

Only a completed, parseable model response can reach validation. The response
must bind the current intent digest, acknowledge all constraint/check IDs and
provide complete replacements for exactly its declared in-scope files. Stale,
missing, duplicate, out-of-scope and no-op proposals fail. The observed target
snapshot must remain unchanged, including when the model startup fails.

A valid result is saved as `proposal.json` **for human review**; the adapter never
applies it, runs project code, or treats named checks as executed tests. Review the
patch and apply it only in your chosen isolated checkout; run real project checks
before merging. Existing
ignored/transient/concurrent-change limitations still apply. Private output bundles
can contain source and runtime metadata; do not commit them.

This first adapter has no prior chat-history capture and does not intercept an
existing agent session. Brief/schema/CLI overhead can increase cost; measurements
separate prompt-text counts from CLI-reported usage. The real Codex end-to-end
call remains unverified in this host because sandbox startup is blocked. Unit
tests simulate responses and failures; they are not real model-success evidence.

## Quick examples

```sh
node index.cjs measure examples/boolean-before.js
node index.cjs compact examples/boolean-before.js > candidate.js
node index.cjs brief examples/intent.json
node index.cjs check examples/intent.json examples/plan-good.json
node index.cjs check examples/intent.json examples/plan-bad.json
```

`compact` only writes a candidate to stdout. `check` checks declarations, not execution or semantic understanding. `plan-bad.json` deliberately fails. CLI success is exit 0, rejected/invalid input or failed checks exit 1, incorrect command usage exit 2.

The default tokenizer is `o200k_base`; measurement commands also accept `cl100k_base`. These counts are text-token measurements, not the current model's bill, reasoning tokens, cache accounting or native message-protocol cost.

## Prepare one complete input

```sh
node index.cjs prepare intent.json sources.json messages.json > report.json
```

`sources.json` maps **every** allowed file path to its complete source string. `messages.json` is an ordered array of explicit-role messages with string `content` and JSON metadata. Attachments/nontext messages are rejected, not silently dropped.

The report's `input` contains `instruction`, `files` and `history`. Measure/transmit the exact compact serialization `JSON.stringify(report.input)` if comparing these numbers. The surrounding report and pretty printing are not counted. File contents may be simplified candidates: review and test them before applying any rewrite.

`metrics.netTokensSavedVersusRawRequest` can be negative. Full constraints are retained even when their extra cost exceeds savings. Unresolved questions remain unresolved. Preparation never edits the project, runs checks or authorizes execution.

History references are a **custom quoted document**, not native model/API messages. An executor must understand the representation and treat tool text as untrusted data. Restoring the history before sending it to a model restores its original token size. Lossless restoration does not prove that a model understands the compact format equally well.

Individual APIs/commands remain available:

```sh
node index.cjs pack intent.json sources.json
node index.cjs context intent.json before-sources.json after-sources.json
node index.cjs history messages.json > history-report.json
node index.cjs restore history-input.json EXPECTED_SHA256
```

For `restore`, `history-input.json` is the report's `input`, not the whole report. `EXPECTED_SHA256` is optional; save the original `metrics.sourceDigest` outside the document if using it as a trusted comparison. Embedded SHA-256 detects unsynchronized corruption, not forgery or source authenticity. Packed format v2 refuses legacy v1; use the old decoder to restore legacy data and repack. Raw arrays remain supported.

## Verify actual edits

Create an intent JSON like the example, and keep the baseline and review configuration outside the agent-editable repository:

```sh
node index.cjs baseline intent.json /absolute/repo > /trusted/baseline.json
node index.cjs verify intent.json plan.json /trusted/baseline.json /absolute/repo
node index.cjs review intent.json plan.json /trusted/baseline.json /absolute/repo /trusted/checks.json
```

All allowed files must already exist as regular UTF-8 text. `verify` observes content hashes, modes, additions, deletions, symlinks, HEAD and index changes. Only existing-file content edits are accepted; new/deleted files and staging/committing require separate review. It rejects no-op completion claims and actual out-of-scope edits even if the plan looks correct.

`checks.json` binds every acceptance ID to a caller-reviewed command:

```json
{
  "intentDigest": "COPY_THE_COMPLETE_CURRENT_INTENT_DIGEST",
  "commands": [
    {"id": "YOUR_ACCEPTANCE_ID", "argv": ["/absolute/path/to/node", "test.cjs"], "timeoutMs": 30000}
  ]
}
```

Executables must use absolute paths, with arguments passed separately and no implicit shell. Commands inherit the environment and run in the repo; **this is not a sandbox**. Use trusted test code and trusted configuration. Each command has a 100–30000 ms timeout (30 s default), a 64 KiB Node output-buffer limit, and recorded exit status/output. Failures stop subsequent commands. Any observed tree change after a command rejects it, even if exit 0; a later command cannot restore the file to hide an earlier mutation.

Passing means configured assertions passed, not that their assertions correctly capture a human request. Ignored files, same-command write-and-restore operations, hostile concurrent writes and background descendants are outside the observation guarantee. Pause other writers during capture/checks. Baselines contain selected source text: keep them private. `verify` remains read-only and does not execute test commands.

## Rewrite boundary

Supported forms return opposite boolean literals, either in an `if/else`, or an `if` immediately followed by a fallback `return` in the same block. Comments, extra branch statements, nonliteral results, nonadjacent/cross-block fallbacks and no-savings candidates are skipped. Conditions keep one evaluation; tests cover truthiness, side effects, thrown values, `await`, `yield`, `finally` and TypeScript syntax.

This is not a general refactoring engine or a formal equivalence proof. Source reflection, stack line numbers and other metaprogramming observations can change. Project type checking, builds, tests and human review remain necessary.

## Reproducible comprehension probes

```sh
npm run evaluate
# Dry run only: builds four raw/prepared pairs, zero model calls.
node evaluation/run.cjs --live --model YOUR_MODEL_ID --out evaluation-results
```

The optional live command uses independent read-only Codex CLI sessions and can
consume your model quota. The default is four cases × two variants = eight calls;
`--repeats 1..5` permits up to 40. It requires a compatible local sandbox and
existing local CLI authentication. It does not request/copy credentials, change
global configuration, permit tools in the task, or automatically retry startup
failures. A first blocked startup stops the remaining calls.

These are **structured comprehension probes**, not coding/patch-success tests.
Normal requests, user corrections, instruction-like tool output and unresolved
questions share exact-answer scoring. Both variants receive the same full user
constraints. Local o200k input counts are separate from CLI-reported usage;
run failures and unrun tasks are retained. Dry-run output and offline parser tests
never count as model successes. See [EVALUATION.md](EVALUATION.md) for protocol,
privacy and remaining limitations. No completed live comparison is claimed.

## Evidence, with limits

125 automated tests pass on Node 20.20.2 and 24.22.1, including a fresh install. [VERIFICATION.md](VERIFICATION.md) records release checks.

| Same synthetic task | Original complete input | Prepared input | Net saved tokens |
| --- | ---: | ---: | ---: |
| Three repeated source reads | 388 | 464 | -76 |
| Ten repeated source reads | 962 | 579 | 383 |

Numbers use `o200k_base`, include brief/reference/fingerprint overhead, and are reproduced by `npm run demo`. Read counts are constructed, not an observed agent trace. Five inspected real scanner/dependency files yield **zero source savings**. Do not generalize synthetic percentages to real projects. More history and source observations are in [RESULTS.md](RESULTS.md), `demo-results.json` and `real-source-results.json`.

No live model task-success, semantic-understanding, actual-billing or rework improvement has been demonstrated. The alpha is for review and integration experiments, not a production quality/cost guarantee.

## License

Original code: [MIT](LICENSE). Dependencies: TypeScript 5.9.3 (Apache-2.0), js-tiktoken 1.0.21 (MIT), base64-js 1.5.1 (MIT). See [THIRD_PARTY_NOTICES.md](THIRD_PARTY_NOTICES.md). No third-party implementation source, dependency directory, credentials or private project source is included in the release.
