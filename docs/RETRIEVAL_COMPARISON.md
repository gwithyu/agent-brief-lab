# Known-name retrieval preflight — negative token result

Checked 2026-11-17 on public source snapshot
`ff8548572cbdd63bff34aa6f4dc1c582b53cfd4d`.
This is a **scripted retrieval comparison**, not independent AI coding tasks.
No model ran, no code was edited by an agent, and provider usage/bills remain
unknown. The sample is twelve declarations from this one repository, with
file paths and exact function names supplied to every arm.

## Result

All three modes returned the complete, exact original target text on **12/12**
lookups, checked against top-level TypeScript AST ranges. Human output was
unwrapped only for grading; its entire actual stdout counts toward tokens.

| Mode | Actual stdout tokens | Declared command/result envelope tokens |
| --- | ---: | ---: |
| Native targeted `sed` | 8,088 | 9,399 |
| Agent Brief default text | 8,959 | 10,333 |
| Agent Brief JSON | 11,217 | 12,354 |

Counts use local `o200k_base`. On stdout, default text is **10.77% larger**
than the native baseline; JSON is **38.69% larger**. The declared envelope
is exactly `JSON.stringify({command: [executable, ...args], result:
{exitCode, signal, stdout, stderr}})`, not a real host/provider tool protocol.
Command-only tokens are also retained separately in the raw result; do not
add them again to envelope totals.

The source bodies match after extracting each tool's payload. The extra text
comes from metadata, guidance and JSON representation. The native baseline
does not offer the same syntax handling, fingerprint recheck or explicit
refusal guarantees. These measurements price returned text, not those guarantees.

## Exact policies and sample

The native command is one direct, format-aware read:

```sh
sed -n '/^function readSymbol(/,/^}/p' source-read.cjs
```

The other arms use the same named target with:

```sh
node index.cjs read --source source-read.cjs --symbol readSymbol
node index.cjs read --source source-read.cjs --symbol readSymbol --json
```

The native policy assumes multiline top-level `function NAME(` declarations
and closing braces at column zero. It is **not a general JavaScript parser**;
it can fail on different formatting, nested syntax or lookalike text in strings.
No syntax-stress cases were included in this known-name sample. The tool under
test may be more reliable outside that restricted format; this result does not
measure that possible advantage. It also excludes unknown-name discovery and
cross-file context gathering.

All twelve targets and the policies are in
[the frozen manifest](../evaluation/retrieval-preflight-manifest.json).
All cases, source hashes, ranges, grading results and counts are retained in
[the machine-readable result](../evaluation/retrieval-preflight-results.json).
No poor or failed case was removed. The default-text arm was included alongside
JSON so that the heavier machine-readable representation was not the only
tool output measured. This convenience sample was not externally preregistered
or randomized. It is not representative user-task evidence.

## Reproduce

Requires Node 20 or 24, a full-history Git checkout, `sed` and installed dependencies in the harness
checkout. The recorded run used Node 24.22.1, TypeScript 5.9.3 and GNU sed 4.9
on Linux. A Node 20.20.2 rerun produced identical per-case grades and token
counts. Both clean-checkout software suites passed 360/360 tests. Run the
harness from the checkout containing this guide; it requires
a separate clean source checkout at the exact frozen revision:

```sh
npm ci --ignore-scripts --no-audit --no-fund
RETRIEVAL_HARNESS="$(pwd)"
RETRIEVAL_RUN="$(mktemp -d "${TMPDIR:-/tmp}/brief-retrieval.XXXXXX")"
git worktree add --detach "$RETRIEVAL_RUN/source" ff8548572cbdd63bff34aa6f4dc1c582b53cfd4d
(cd "$RETRIEVAL_RUN/source" && npm ci --ignore-scripts --no-audit --no-fund)
node "$RETRIEVAL_HARNESS/evaluation/retrieval-preflight.cjs" "$RETRIEVAL_RUN/source" > "$RETRIEVAL_RUN/report.json"
git worktree remove "$RETRIEVAL_RUN/source"
```

Keep the resulting `report.json` in the temporary parent directory for review.
The script checks the source revision, clean Git state and before/after source
hashes. The grader uses AST ranges only for validation, never to give the native
arm its line coordinates. Failures remain records and cannot qualify as complete
retrieval. Elapsed time is deliberately not reported as a latency benchmark.

## Implication for the project

**This sample does not support a token-saving advantage over targeted native
reads.** Comparing a selected function only to an entire file is insufficient
to establish an advantage over an existing agent's practical tools. The current
reader should be treated as an optional structure/identity-checking helper,
with additional returned-context cost in this sample.

The separate native Raw/Prepared formatting experiment preserves full source;
this result does not measure that transformation. Before making task-level
claims, run independent same-model coding sessions with ordinary search/range
tools versus the optional helper, retaining acceptance results, follow-up reads,
all retries, actual provider usage and charges. Those model runs remain undone.

## Source-only follow-up

The new optional `--source-only` output was measured against the **same frozen
source snapshot and twelve targets**, using separately pinned helper snapshot
`4d8abe79fdfa159c523298860b754148066cd20d`. No source/task was substituted and
all original controls reproduce exactly. Both Node 20.20.2 and 24.22.1 yielded
identical per-case grades and counts; all four modes returned the exact target
text on 12/12 lookups.

| Mode | Actual stdout tokens | Declared command/result envelope tokens |
| --- | ---: | ---: |
| Native targeted `sed` | 8,088 | 9,399 |
| Default text | 8,959 | 10,333 |
| JSON | 11,217 | 12,354 |
| Source only | 8,088 | 9,474 |

This reaches **source-payload parity**, not a win over the native baseline.
The normalized envelope still contains 75 additional tokens (about 0.8%).
For a separately installed helper, the harness normalizes its executable path
to `index.cjs` in the declared command counts; real invocation paths and host
schemas can cost more. No provider billing conclusion follows.

Source-only skips display metadata, not validation. It retains file/selector,
fingerprint and budget checks and writes exact selected text without an added
newline. It emits no successful hash/range receipt; use default/JSON when
that metadata is needed for follow-up. Its refusal cases remain nonzero with
empty stdout and diagnostics on stderr.

[Full four-mode result](../evaluation/source-only-results.json) retains the
source revision and helper revision separately. The original three-mode data
above is unchanged. To reproduce this follow-up from a full-history harness
checkout with dependencies installed:

```sh
SOURCE_ONLY_RUN="$(mktemp -d "${TMPDIR:-/tmp}/brief-source-only.XXXXXX")"
git worktree add --detach "$SOURCE_ONLY_RUN/source" ff8548572cbdd63bff34aa6f4dc1c582b53cfd4d
git worktree add --detach "$SOURCE_ONLY_RUN/helper" 4d8abe79fdfa159c523298860b754148066cd20d
(cd "$SOURCE_ONLY_RUN/helper" && npm ci --ignore-scripts --no-audit --no-fund)
node evaluation/retrieval-preflight.cjs "$SOURCE_ONLY_RUN/source" "$SOURCE_ONLY_RUN/helper" > "$SOURCE_ONLY_RUN/report.json"
git worktree remove "$SOURCE_ONLY_RUN/source"
git worktree remove "$SOURCE_ONLY_RUN/helper"
```

This remains a scripted, known-name retrieval follow-up, not independent AI
coding tasks. Correctness of code edits, follow-up context, retries, tool
schemas, model usage, cache behavior, latency and bills remain unmeasured.
