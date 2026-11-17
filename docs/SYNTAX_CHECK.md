# Curated source-reader syntax diagnostics

This is a reader-contract check, **not a native-tool comparison, coding-agent
trial, or cost benchmark**. The earlier twelve-target retrieval comparison and
its negative token result remain in [RETRIEVAL_COMPARISON.md](RETRIEVAL_COMPARISON.md).

The [fixed fixtures](../evaluation/syntax-cases.json) contain twelve successful
reads and four expected refusals. Expected text is manually written as complete
physical lines; the production outline and a second parser do not generate the
oracle. The successful cases exercise arrows, function expressions, exported
async generics, explicitly qualified class methods, object methods/fields,
CommonJS assignments, template-literal lookalikes, nested braces, BOM/JSDoc/CRLF,
same-line neighbors and Unicode. A whole physical line can include adjacent
statements; a successful read does not establish complete task context.

The refusal cases are an unqualified duplicate class method, an unsupported
wrapped callable, a stale fingerprint and a declaration over the 200-line
budget. A correct refusal is recorded separately from a successful retrieval.
The wrapper case deliberately documents a feature limit; it does not count as
finding the callable. Resource-exhaustion attacks and parser fuzzing are outside
this small suite.

## Recorded result — 2026-11-17

Both isolated Node 20.20.2 and Node 24.22.1 runs passed **12/12 exact reads**
and **4/4 expected refusals** in each of the three output modes. That is 48
expected CLI outcomes per runtime, not 48 independent tasks. Per-case source
hashes, grades and emitted-output hashes match between runtimes.

The [complete result](../evaluation/syntax-results.json) also retains an earlier
inconclusive exploratory run. It overlapped dependency reinstallation and only
6/16 expected outcomes passed in each mode; the other commands exited 1. Raw
stderr was not retained, so individual failures cannot be independently
attributed. It was rerun serially after installation, using **the exact same
code, fixtures and expectations**. No failed case was removed or rewritten.

The verified code snapshot is
`515f18004c467fe143fdf5ddabb9bda4c4b2297c`, whose tree
`bb68af68a507ebf35fbf51270e9bb508a9507c5b` matches the locally measured
revision `3fe49d6905971b27ddb42e8ed34268c9c69d27ee` recorded in the reports.
The full clean-checkout suites passed **365/365** on each Node version.
This update adds evaluation data, tests and documentation; the production
reader is unchanged, and the existing verified installation pin still applies.

## Protocol and reproduction

Every fixture runs through the actual CLI in default text, JSON and source-only
modes. The grader requires exact original text on successful reads; containment
is insufficient. Refusals require exit 1 and empty stdout. Source hashes, the
fixture hash, the helper Git revision and per-mode results are recorded. Sources
and the temporary directory inventory are checked after all reads. The source
contains a top-level throw to make accidental execution fail. No model runs.

From a **clean committed checkout** with dependencies installed:

```sh
npm ci --ignore-scripts --no-audit --no-fund
node evaluation/syntax-check.cjs > /tmp/brief-syntax-report.json
```

For the recorded protocol, check out the verified code snapshot above first.
Do not install dependencies in that checkout while a diagnostic or test run
is active. A reproduced report records the public snapshot's commit ID rather
than the local pre-publication ID; fixture hashes and per-case results should
match. The later result/documentation commit does not change runtime or harness
code.

The script exits 1 when any expected outcome fails and retains that failed case
in the JSON. It does not omit a failed lookup or count its empty output as token
savings. Temporary fixture files are removed after the check. Keep the report
outside the checkout so the clean-state checks can finish.

These are hand-selected synthetic examples, not representative repository or
user-task evidence. There is no native arm: showing that the old fixed `sed`
policy cannot parse arrows would only demonstrate its documented formatting
limit, not superiority over an agent choosing normal native search/range tools.
Unknown-name discovery, cross-file reasoning, edits, later reads, retries,
provider usage, latency and bills are unmeasured.
