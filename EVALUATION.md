# Live agent evaluation: NOT COMPLETED

A real A/B evaluation remains a limitation of this alpha, not a passing gate.

Readiness was attempted with the installed, signed-in Codex CLI. No task or model
completion was obtained: initial startup failed on read-only runtime state; a
writable isolated runtime reached thread startup but its filesystem sandbox helper
failed because a required NETLINK_ROUTE socket operation was not permitted.
No sandbox/approval bypass was used. Readiness attempts are not counted as model
results or evidence of comprehension.

## Required future comparison

Use the same named model/build, task fixtures, budgets and assertion suite across
independent raw/prepared sessions; record task order and all failures. Start with
normal edits, stale requirements, protected-file temptations and instruction-like
tool output. Have an independent reviewer verify assertions and patch scope.

Record complete input/output/tool trajectories, provider-reported usage (including
cache fields when provided), tools executed, actual files changed, tests/builds,
violations and manual corrections. Keep synthetic tokenizer counts separate from
provider billing. Do not substitute packed-history restoration or unit tests for
model behavior. Include repeated runs and uncertainty before making broad claims.

Do not include credentials, private source, unredacted personal conversations or
runtime authentication material in public evaluation artifacts.


## Runnable protocol (alpha.2)

`npm run evaluate` is a deterministic dry run: four cases, raw/prepared prompt
counts, **zero model calls**. Each raw condition contains the same full intent
brief/constraints as its prepared counterpart; the difference is representation,
not omission of constraints. Repeated snapshots and adversarial strings are
synthetic. The common question/output instructions count in both prompts.

For a compatible, trusted local machine with an authenticated Codex CLI:

```sh
node evaluation/run.cjs --live --model YOUR_MODEL_ID --out evaluation-results
```

Choose the exact supported model ID yourself. Eight independent sessions run by
default; `--repeats 1..5` caps the experiment at 40 calls. Conditions alternate
raw/prepared order across cases and repetitions. The output directory must be new;
when inside this package it must be evaluation-results or a child, which is
excluded from Git and npm package contents. Other source-directory destinations
are refused. Raw traces can include private
runtime metadata: do not commit or share them without reviewing/redacting them.
The runner uses saved local authentication through the CLI, not copied credentials
or a seeded auth file, and is not an example of account-auth CI deployment.

The subprocess uses read-only mode, never grants approvals, and disables apps, plugins and the shell
tool while ignoring user configuration for this independent probe. Existing
managed rules are not disabled. Runtime incompatibility remains blocking; no
fallback broadens sandbox permissions. This retry with the installed legacy
compatibility option also failed: filesystem-restricted execution still requires
bubblewrap socket isolation. It produced no model completion.

### What the report establishes

- Four probes ask only for allowed paths, target CSS values, unresolved-question
  count and whether questions prevent proceeding. Exact answer keys are not put
  in prompts. They test bounded retrieval/constraint handling, not general human
  understanding, implementation quality or application behavior.
- A model-completed result needs one completed turn, one final agent-message JSON
  and nonnegative reported input/output usage. Tool/unknown item activity, missing
  usage, ambiguous completions and malformed streams invalidate a run. A valid
  completion with a wrong answer is a completed failure, not discarded.
- Startup failures stop further calls and leave every remaining planned run as
  not_run. Report counts separate planned, attempted, modelCompleted and passed;
  comparisonComplete stays false for blocked/incomplete runs. No success rate is
  calculated by silently removing failures. All offline fixture simulations are
  unit tests only.
- CLI-reported input/output/cache/reasoning fields are retained per run, separate
  from local o200k prompt-text counts. They can include harness context and do
  not themselves prove invoice savings. The requested model ID and CLI version
  are recorded; backend model revision is not independently verified.

The subprocess adapter follows the official [non-interactive CLI JSONL/schema
documentation](https://learn.chatgpt.com/docs/non-interactive-mode). A live test
must still establish compatibility with the actual installed CLI version.


## Proposal adapter (alpha.3)

`propose` and this probe harness share `codex.cjs` for invocation and completion
parsing. The proposal adapter captures source directly from an exact Git root,
prepares the prompt, and optionally sends it to the chosen model. Its output is a
validated replacement **proposal**, not an applied patch or test receipt.

Programmatic unit-test response injection is explicitly simulated; those temporary
fixtures are removed and never counted in live comparison reports. Startup errors
keep modelCompleted at zero. Any completed response still needs current digest,
complete ID acknowledgements, exact replacement/plan paths, a non-noop change and
an unchanged observed repository before proposal.json is written. End-to-end live
model behavior remains blocked/unverified here.


## Current host session (alpha.4)

ACTIVE_AGENT.md records one guided current-host walkthrough using ordinary tool
calls. Unlike the optional CLI evaluation runner, `session` does not start another
model. Source scope and five actual behavior tests passed, and a protected-file
negative case was rejected. The helper already supplied a rewrite candidate; the
operator knew the intended answer. No model/build was pinned, no independent
control condition ran, and no whole-session usage was measured. These results
must not be mixed with the four-probe model comparison or claimed as a model A/B
improvement. Its output bundle and raw fixture remain private local artifacts.
