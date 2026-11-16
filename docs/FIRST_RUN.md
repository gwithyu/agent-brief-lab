# First-run preview (experimental PR)

This is for a developer who has **never used Agent Brief Lab**. It is not
an installation of a ChatGPT plugin, automatic context interception, or a
claim that real API bills decrease.

## Fastest path: one command, no cloning

Install and launch only a **pinned, publicly reviewable GitHub source archive**:

```sh
npm exec --yes --ignore-scripts \
  --package="https://github.com/gwithyu/agent-brief-lab/archive/2dbbcb512215a28829b63287ed1a2dd1eabca21e.tar.gz" \
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

## Step 2: optionally measure your own local data

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

## Privacy and correctness

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

Tell us which mode you tried (`synthetic`, `source`, or `history`);
your Node version; whether the first run worked; and whether the report
was understandable. If you file an issue, **do not paste private prompts,
project code, API credentials or original message histories**. Aggregate
counts and sanitized error codes are sufficient for a first report.

The source is MIT-licensed. Current experimental development is in
[Draft PR #1](https://github.com/gwithyu/agent-brief-lab/pull/1).
