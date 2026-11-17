# First run: counting preview or original-code reads

This is for a developer who has **never used Agent Brief Lab**. It is not
an installation of a ChatGPT plugin, automatic context interception, or a
claim that real API bills decrease.

## Fastest path: one command, no cloning

Install and launch only a **pinned, publicly reviewable GitHub source archive**:

```sh
npm exec --yes --ignore-scripts \
  --package="https://github.com/gwithyu/agent-brief-lab/archive/4d8abe79fdfa159c523298860b754148066cd20d.tar.gz" \
  -- agent-brief try
```

Requires Node 20 or 24, npm and internet access on first run. The pinned
archive was independently run in a clean consumer directory under Node 24,
without cloning or modifying a consumer project. The archive and npm
dependencies execute on your own machine: `--ignore-scripts` prevents npm
install hooks, but it does **not** sandbox the selected executable. Review
the public source before running an untrusted dependency on a sensitive
computer. The tool never automatically accesses personal repositories.

For an explicitly selected, local JS/TS file, add:
`-- agent-brief try --source "/absolute/path/to/file.js"`.
For a normalized tool-history JSON document, use:
`-- agent-brief try --history "/absolute/path/to/messages.json"`.
Only the selected file is read; source text and local paths are not printed.
The command is a **synthetic or local counting preview**, not an AI model
cost or reliability benchmark.

## Alternative: one clean source checkout

Requires Git, npm, Node.js **20 or 24**, and internet access for dependencies.

```sh
git clone --depth 1 --branch experiment/adaptive-evaluation-protocol \
  https://github.com/gwithyu/agent-brief-lab.git
cd agent-brief-lab
npm ci --ignore-scripts --no-audit --no-fund
npm run try
```

**What to expect:** The synthetic example exercises actual code and history
packing, showing a repeated tool-result history with a smaller representation
and an exact reconstruction check. A **no-duplicate control** should save
zero tokens. A complete guided input shows its own net input-token difference.
There are **zero paid model calls and zero file edits**.

This branch is an unmerged Draft PR. The public `main` branch has an
older alpha; do not confuse it with this experiment.

## Read code with your existing coding assistant

After the source checkout above, stay in the `agent-brief-lab` directory and
try its own public source first:

```sh
node index.cjs outline --source source-read.cjs --json
node index.cjs read --source source-read.cjs --symbol readSymbol --json
```

The first command returns supported declaration names, line ranges and a
source fingerprint, without source bodies. The second returns the original
`readSymbol` declaration in `text`, with `selectedSymbol` and
`sourceSha256`. A successful read still has `completeContext: false`.
These are local code reads: no model is launched and no source is executed
or changed.

For a caller that needs only the original text, add `--source-only` instead
of `--json`. It omits headers and metadata without adding a newline; all
read checks remain. Keep the metadata-producing mode when you need an observed
fingerprint/range for later reads. Errors still use stderr and a nonzero exit.

For your actual task:

1. Choose a JS/TS file you authorize your current coding assistant to read.
   Replace `source-read.cjs` with that file's quoted absolute path.
2. Use `outline` to find a relevant declaration, then replace `readSymbol`
   with its exact name. If you already know a unique supported name, you can
   start with `read --symbol`. Use `--container OWNER` for an exact
   class/object match when necessary.
3. Read the imports, callers, surrounding comments and dependencies needed
   for the task through your normal authorized tools. Do not claim a file
   or task was fully read just because one declaration was returned.

If the assistant's terminal is in another project, invoke `node /absolute/path/to/agent-brief-lab/index.cjs ...`
with this checkout's actual absolute path.
The CLI does not install itself into your assistant or alter its context
automatically. [Existing-agent workflow](../ACTIVE_AGENT.md) explains the
separate scoped-edit workflow.

Unlike `try`, **`read` explicitly prints original source** and `outline`
prints identifiers. Only share output with the coding assistant/providers
you intended to use; it is not an aggregate-only preview.

| Read outcome | Next step |
| --- | --- |
| `ambiguous_symbol` | Specify the actual container, or select a real line range from the outline; do not pick the first duplicate. |
| `symbol_not_found` | Check the exact name and supported syntax; use normal authorized reads for unsupported declarations. |
| `read_budget_exceeded` | Named reads exit 1 with empty stdout. With `--json`, parse `readHint` from stderr, then choose smaller explicit line ranges with its source hash. |
| `source_changed` | Locate the current file again before choosing new ranges. |
| `symbol_lookup_unavailable` | The locator is unavailable; use another authorized reader. |

To resume an oversized named read, use the actual hint's coordinates and
hash with `read --source FILE --lines START:END --sha256 HASH --json`.
Each chunk must fit both 200 lines and 64 KiB. A single line over 64 KiB
needs another reader. Preserve the same fingerprint across chunks and stop
on any mismatch; the hint contains no source already read.
[Full range, paging and error contract](OUTLINE.md).

Reading less selected source may reduce what your assistant receives on
that step. This walkthrough does not measure a real task's total tokens
or bill: include all later reads, prompts, retries and outputs in any
comparison. Preserve full original sources for native paired-input trials.

## Optional: measure your own local data

To evaluate one JavaScript/TypeScript source file for the two supported
conservative boolean-return patterns, **without changing the source**:

```sh
npm run try -- --source /absolute/path/to/example.js
```

To measure your own **normalized** text message history:

```sh
npm run try -- --history /absolute/path/to/messages.json
```

The JSON file must be a plain array of messages with `role` and string
`content`. Roles are `system`, `developer`, `user`, `assistant` and
`tool`. For example:

```json
[
  {"role": "user", "content": "Preserve the requested behavior"},
  {"role": "tool", "tool_call_id": "read-1", "content": "some long repeated tool output"},
  {"role": "tool", "tool_call_id": "read-2", "content": "some long repeated tool output"}
]
```

This short example usually has **no net compression gain**: references plus
guidance cost tokens. Larger repeated outputs may be compressible. The format
is a test fixture, **not** an automatic export/import format for Cursor,
Codex, Claude Code or ChatGPT sessions.

Add `--json` to receive **aggregate-only** machine-readable output:

```sh
npm run try -- --history /absolute/path/to/messages.json --json
```

## Resource-limited local previews

Explicit local inputs up to **8 KiB** are measured inline. Larger inputs
still have the **1 MiB file limit**, but source analysis/history packing now
runs in a separate local Node process with a **5-second deadline** and a
**256 MiB V8 old-space limit**. This is not an OS-wide memory cap or a
security sandbox. The worker receives content through private process stdin;
no source file is copied to disk and no source text appears in arguments.
Known pathological repeated-character runs skip expensive work immediately.

Successful explicit-file JSON previews include `measurementStatus: "complete"` and
`measurementMethod: "inline"` or `"bounded_worker"`. If work cannot safely
complete, the preview returns **status unavailable**, keeping the original
input unchanged:

```json
{
  "measurementStatus": "unavailable",
  "measurementMethod": "unavailable",
  "beforeTokens": null,
  "afterTokens": null,
  "tokensSaved": null
}
```

Other aggregate fields remain present. Unknown is **not zero savings**.
For an unavailable history preview, `exactRestore`, dictionary entry counts
and referenced-occurrence counts stay null: no reconstruction check was
completed. Such a result exits 0 because the preview was handled safely;
automations should inspect `measurementStatus` before consuming counts.
Malformed input or a detected syntax error still produces a sanitized
nonzero error. An unavailable source measurement does not establish syntax
validity or a valid rewrite candidate. These guards apply to the explicit
`try --source` / `try --history` CLI paths; direct library calls retain their
existing behavior.

## Privacy and correctness of the counting preview

- Only the one explicitly named file is opened. Input is processed **locally
  in memory**. The preview contains no network calls or provider credentials;
  `npm ci` still accesses the package registry during installation.
- The preview does not overwrite, execute, transmit or print original source,
  message text, IDs or local file paths. The output is numbers and status.
  `--source` never applies its suggested boolean change to a file.
- Explicit local inputs are limited to **1 MiB**; directories, symlinks,
  invalid UTF-8 and malformed message schemas are refused. Source syntax is
  checked when source analysis completes; detected errors are refused.
- Completed history de-duplication uses **exact reversible references** and
  verifies reconstruction. The receiving agent or model must actually understand and
  expand those references; shorter JSON is not evidence that it will.
- No duplicate output => a correct result can be **zero tokens saved**.
  Guidance and safety instructions may make a complete request larger.
- No benchmark from this preview verifies model success rate, provider token
  accounting, cache effects, retries, dollar savings, or security against
  hostile local code.

For paired task-quality checks, see
[ADAPTIVE_EVALUATION_PROTOCOL.md](ADAPTIVE_EVALUATION_PROTOCOL.md) and the
`evaluation/patch-run.cjs` **dry-run**. Genuine model A/B tests are opt-in
and require separate, locally authenticated infrastructure.

## Feedback template for outside developers

Open a new issue using the **First-run feedback (privacy-safe)** template
in `.github/ISSUE_TEMPLATE/first-run-feedback.md` (or find it through
the repository's GitHub Issues UI). Include only sanitized error codes,
Node version and optional aggregate counts. Never share original source,
model transcripts, private prompts, names, paths or credentials.

## Feedback that would be most useful

Tell us which mode you tried (`synthetic`, `source`, `history`, `outline`, or `read`);
your Node version; whether the first run worked; and whether the report
was understandable. If you file an issue, **do not paste private prompts,
project code, API credentials or original message histories**. Aggregate
counts and sanitized error codes are sufficient for a first report.

The source is MIT-licensed. Current experimental development is in
[Draft PR #1](https://github.com/gwithyu/agent-brief-lab/pull/1).
