# Existing-agent handoff: native text, no model calls

This workflow helps an actual developer give the **current** AI coding agent
a complete, scoped task without needing a plugin or a new model session.
It is an alternative to the experimental compact/dictionary protocol:
**the file contents are kept byte-for-byte as original text** inside native JSON.

## Prepare a real, explicitly authorized task

Requires Node.js 20/24, Git, a project with an existing commit, and a
cleanly specified list of **existing regular files** that you authorize the
agent to edit. The user's own task and constraints are retained.

From a checkout of the experimental Draft PR:

```sh
# A new, private parent directory inside the OS temporary directory.
ROOT="$(mktemp -d "${TMPDIR:-/tmp}/agent-brief-handoff.XXXXXX")"

node index.cjs handoff \
  --repo . \
  --task "Simplify boolean return code without changing behavior" \
  --file examples/boolean-before.js \
  --constraint "Keep visible and hidden function names and call behavior" \
  --check "Run the project's existing behavior tests after editing" \
  --out "$ROOT/task"
```

The command returns the **private** paths of these files in `$ROOT/task`:

| File | Purpose |
| --- | --- |
| `handoff.txt` | Native-readable JSON text with exact task, declared constraints, checks **to run**, and original sources |
| `intent.json` | Validated intent with stable constraint/acceptance IDs and fingerprint |
| `baseline.json` | Trusted Git HEAD, index, file metadata and the selected original sources for subsequent scope checks |
| `plan-template.json` | Plan skeleton; both `acknowledgedConstraints` and `checks` start **empty** |
| `report.json` | Aggregate local byte metrics; provider usage, tokens saved and USD savings stay `null` |

The containing directory is created at mode `0700` and the files at
`0600`. The **target repository is not modified**, and no model is called.
The new output path must be within the OS temp directory and outside
the target Git repository, and must not already exist. Up to six explicitly
selected files, max 128 KiB each and 320 KiB total selected source. Do not
put secrets in source files you intend to paste to third-party AI services.

## Give it to the AI you already use

Open `handoff.txt` **locally**, review the task and included source, and
copy the content to your existing Cursor/Codex/Claude Code/other agent.
**This step is manual and may transmit source to that service**; the
tool itself does not upload it or turn on new permissions. Unlike
dictionary-packed history, this JSON has no custom compressed references,
so it needs no special unpacking capability. The source text in the JSON
is data; do not treat code comments as instructions that override your task.

The AI should review the task, clarify ambiguities, edit only selected
files, and run project checks **only with your authorization**. This tool
does not auto-apply modifications or execute those tests.

## Verify edits instead of trusting the AI's success claim

When the AI has made real changes, fill in `plan-template.json` only with
**truthful, reviewed declarations** of which constraints it acknowledged
and which acceptance checks it plans to run, using IDs in `intent.json`.
Acknowledgment is **not** proof a test ran. Save it as `plan.json` within
the same private bundle.

```sh
node index.cjs verify \
  "$ROOT/task/intent.json" \
  "$ROOT/task/plan.json" \
  "$ROOT/task/baseline.json" \
  .
```

The verifier observes actual edits, rejects changes to undeclared files
and compares against the original Git baseline. It does **not** establish
semantic correctness or prove that the planned tests were actually run.
Run the agreed checks separately (or use the existing reviewed `review`
command) and record their real exit statuses. Do not stage/commit changes
before the baseline comparison unless you plan to capture a new baseline.

## What this does *not* claim

- **Not a compression benchmark:** native handoff includes full originals;
  `handoffLocalTextTokens`, `localTokensSaved`, native provider usage and
  `billedSavingsUsd` are deliberately `null`. A longer handoff may cost
  more input tokens than a bare request.
- **Not an agent integration:** it does not intercept chat history, deliver
  prompts to a provider, or control model/tool permissions.
- **Not automatic secret scanning:** you must review any source before
  copying it to an external AI.
- **Not comprehensive enforcement:** Git observations do not stop malicious
  writes, protect ignored files, or provide OS process isolation.
- **Not proof of helpfulness:** user value, speed, correct edit outcomes and
  actual billed cost still need independent real-world trials.

The frozen 30-task A/B synthetic benchmarks are separate from this workflow.
For the one-command zero-cost synthetic compression demonstration, see
[FIRST_RUN.md](FIRST_RUN.md).
