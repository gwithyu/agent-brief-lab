# Adaptive compression: preregistered evaluation protocol (draft)

This is an experimental plan, **not** evidence that model costs decrease. It is intentionally separate from current alpha claims.

## Decision rule

Compare the complete *transmitted* input, including instructions, serialization, dictionary entries, references, and safety constraints. Never choose a compact representation based only on the shortened source excerpt.

For each task, produce both a raw/guided baseline and a prepared candidate. Count both with the same tokenizer and the same serialization. Select the candidate only when:

1. Every explicit requirement, constraint ID, acceptance ID, allowed path and unresolved question survives.
2. The candidate is structurally valid and round-trip restoration succeeds wherever lossless encoding is claimed.
3. The complete candidate input is strictly smaller than the complete baseline, with a configurable minimum margin to absorb measurement noise.
4. No unverified source-code rewrite is automatically applied.

Otherwise return the baseline with a reason code: `NO_GAIN`, `MISSING_REQUIREMENT`, `RESTORE_FAILURE`, `UNSUPPORTED_INPUT`, or `UNVERIFIED_REWRITE`.

**Important:** a shorter input is not proof of equal agent comprehension. Until paired outcome experiments pass, adaptive selection is an opt-in preview rather than a default model-facing transform.

## Paired live A/B protocol

- Freeze one repository revision, task statement, acceptance commands, model version, temperature/settings, tool permissions and maximum budget per pair.
- Randomize which arm runs first; use independent fresh worktrees and sessions. Do not allow either arm to see the other's results.
- Run at least 30 paired tasks spanning simple edits, multi-file changes, repeated tool outputs, zero-repeat histories, and explicit-constraint-heavy tasks. Publish the full task manifest and exclusions.
- Record native provider usage (input, cached input, output, reasoning where exposed), billed cost where exposed, wall-clock time, retries, acceptance results and actual out-of-scope changes.
- Separate **local tokenizer counts** from **provider usage** and **invoice/billing**. Never substitute one for another.
- Evaluate requirement preservation by checking explicit IDs and human-reviewed task-specific acceptance, not merely by whether the model says it succeeded.
- Include failure, negative-savings and no-change cases. Report medians and per-task paired deltas, not just the best case.
- If an API cannot expose a cost component, report it as unknown; do not estimate it as zero.

## Result schema (one record per arm)

```json
{
  "taskId": "example-001",
  "arm": "baseline",
  "repositoryCommit": "PINNED_SHA",
  "model": "MODEL_ID",
  "settings": {},
  "tokenizer": "o200k_base",
  "localInputTokens": null,
  "providerInputTokens": null,
  "providerCachedInputTokens": null,
  "providerOutputTokens": null,
  "providerReasoningTokens": null,
  "providerBilledCost": null,
  "elapsedMs": null,
  "acceptancePassed": null,
  "scopeViolations": [],
  "requirementIdsPreserved": [],
  "failureReason": null
}
```

Use `null` for unavailable observations, never zero. Preserve raw run receipts outside public source if they contain secrets or user data. Redact before publication.

## Cursor CLI comprehension smoke adapter

`node evaluation/cursor-run.cjs --dry-run` prepares four fixed synthetic
requirement-comprehension cases without any model calls. The opt-in
`--live --model MODEL --out /private/new/dir` mode uses the owner's
**locally authenticated** Cursor CLI and attempts eight separate
`agent --print --mode=ask --sandbox enabled --output-format stream-json`
sessions by default. It requires an explicitly selected model.

The stream parser checks for exactly one successful terminal event and
rejects recorded tool calls/interactions, missing events, invalid JSON,
wrong answers, dirty Git state or a changing HEAD. All traces are
private by default and each task/arm gets a fresh directory. Cursor
requires workspace trust even when the account is logged in; the runner
uses `--trust` **only** on private 0700 temporary directories containing
only a regular synthetic `prompt.txt`. It does **not** use
`--force` / `--yolo`. Ask mode, workspace trust and Cursor sandbox
settings must **not** be represented as absolute read isolation;
Cursor may read outside the workspace under user settings, and tool
execution could already have occurred before detection. Use only synthetic
data and preferably a disposable OS account or VM without secrets.

Model provider tokens, cached input tokens, billed cost and reasoning
tokens remain `null` unless independently supported by provider data.
The four synthetic A/B pairs are **not** the preregistered >=30 distinct
coding-agent tasks and cannot satisfy the full release gate.

## Deterministic 30-task coding-edit experiment (synthetic preview)

The frozen generator `evaluation/edit-cases.cjs` creates exactly 30
**distinct narrow synthetic edit instructions** (JSON/CSS/JS single-file,
multi-file and unresolved/no-change). Case input histories deliberately mix
0/1/2/4/8 repeated snapshots, stale user text and untrusted tool text.
`manifestDigest` covers **complete raw/prepared prompts**, case files,
expected output bytes and allowed paths. Each arm receives the exact same
task intent and protected scope; source-code rewrite candidates are rejected
for this benchmark rather than silently shipped to an editing model.

`evaluation/edit-grade.cjs` materializes fixed bytes and checks real
post-run files against expected bytes. Protected-file changes, added/deleted
paths, symlinks and mode changes fail. It deliberately **never runs code
authored by the editing agent**. This byte-for-byte oracle is intentionally
strict and not a substitute for task-specific behavioral tests.

`evaluation/edit-run.cjs --dry-run` (default) makes zero model calls;
live mode is explicitly opted in and limited to one pair by default.
Any live invocation also requires `--confirm-isolated-env YES` to acknowledge
that the caller has prepared a disposable OS account or VM without private
files or personal integrations. This is **not an automatic isolation check**.
>5 pairs additionally require `--confirm-batch YES`. Each arm has an independent
private temporary directory and fresh Cursor CLI session in Agent mode;
model token usage and billing remain `null`. `--trust` only skips workspace
trust; it is not a sandbox or an authorization to run everything.
Cursor might still read outside the workspace under local settings; use a
disposable OS account or VM with no credentials or private files.
The output report includes the manifest fingerprint, code revision,
model selection, per-arm status, exact acceptance and scope results. Cursor
`stream-json` event receipts are audited for a single stable session
ID, CLI-reported working-directory identity, recognized file tools, matching
started/completed call IDs, equal tool arguments and paths located inside
the synthetic workspace. Unknown/forbidden tools, path escapes,
unexpected assistant tool-use events, failed tool receipts or missing
terminal events fail closed. An observed expected file change without an
audited edit tool event is graded `unaudited_edit`, not success.
This is after-the-fact evidence validation; it does not isolate the
process or undo side effects.

Full CLI integration tests launch a synthetic fake `agent` executable
and verify that expected file modifications pass, forbidden protected-file
edits stop all remaining sessions, and unmodified code cannot be passed
by a model success message alone. These are **offline harness tests**, not
real Cursor model trials.

**Caution:** having 30 **fixture tasks** does not itself satisfy the
preregistered >=30 real coding-agent task quality gate. These narrow
synthetic tasks, static byte equality and unavailable provider usage
cannot support claims of general coding reliability, production safety,
or billed savings. The live 30-task edit suite has not yet been run.

## Release gates

1. Deterministic local measurements and negative cases reproducible on supported Node versions.
2. No unacknowledged explicit requirement loss in the preregistered corpus.
3. No regression in paired acceptance/scope outcomes within the chosen tolerance.
4. Measured provider usage and cost claims supported by receipts from actual calls.
5. README claims match observed evidence; until then, describe the project as experimental.

## Current status

The experimental `prepare` CLI compares complete input variants and falls back on no measured token/byte gain, reporting its selection reason. An opt-in local minimum reduction is enforced via `MARGIN_NOT_MET`. Two **authenticated** Cursor CLI comprehension smoke rounds have completed on four synthetic understanding tasks, with **16/16** exact answers across raw and prepared arms; the two local model-produced reports were inspected, but raw events/provider invoices were not independently audited. The separate **30-distinct-task synthetic coding-edit corpus and static grader have been implemented and tested**, with Node 20 and Node 24 full suites as independently recorded for each exact commit in PR #1. The 30-case edit runner has **not** been exercised against a live Cursor editing agent. General model-comprehension equivalence, editing-agent task success, provider-billed token savings and production performance remain unverified.
