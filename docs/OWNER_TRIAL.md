# Owner-operated Raw / Prepared task trial (not a paid model runner)

This experimental workflow closes a missing bookkeeping step: it turns an
existing, **native and byte-bound** `pair` into an order-balanced list of
independent runs, then compares outcomes and externally recorded total
attempt charges.

It does **not** launch Cursor/Codex, authorize a bill, execute a repository's
tests, read a cloud invoice, verify a user's claims, or automatically
determine whether a coding task was done correctly.

## 1. Generate a real task pair

Review [HANDOFF.md](HANDOFF.md) and [PAIRED_HANDOFF.md](PAIRED_HANDOFF.md)
to generate `$ROOT/pair/raw.txt`, `$ROOT/pair/prepared.txt`, and
`pair-report.json`. Source code and user constraints appear in both
prompts and must remain private. The pair program checks exact decoded JSON
equality before it emits either prompt.

## 2. Freeze model label and produce ordered trial slots

```sh
# Run from this experimental Draft PR checkout.
node index.cjs trial init \
  --pair "$ROOT/pair" \
  --out "$ROOT/trial" \
  --model "EXACT_PROVIDER_MODEL_ID" \
  --repeats 2
```

This produces a private `manifest-private.json`,
`observations.template.json`, `INSTRUCTIONS.txt` and
`slot-01.txt` ... `slot-04.txt`. Each slot contains the **entire**
Raw or Prepared native prompt, with a frozen SHA-256 fingerprint. Slots
alternate the order across repeats (for two repeats, AB then BA, where
the first arm is randomized). This reduces a simple *order effect*;
it does not blind the operator because formatting can reveal the arm.

**Use a separate, reset/disposable Git workspace for each slot.** Run
the same exact provider/model version, permissions, tool policy, timeouts,
and independent acceptance checks. Do not reuse edits or cached prompts
from an earlier slot. Do not include private files you have not approved
for that model. `--repeats` supports 1–3. This one-task experiment is
not statistically representative, even if repeated three times.

If you want to stop before any billable model call, stop here; the CLI
has made **zero provider calls and zero source edits**.

## 3. Record actual results, *including failures and retries*

Copy the generated template to a private file; keep the original:

```sh
cp "$ROOT/trial/observations.template.json" "$ROOT/observations.json"
```

For each slot, fill these fields using **your own observed evidence**:

- `terminal`: `"completed"`, `"failed"` or `"blocked"`
- `correct`: `true` only if the independent task acceptance actually
  passed; `false` if it failed; `null` if not assessed
- `modelObserved`: exact model string actually used, matching the
  model requested at initialization
- `attemptCount`: number of attempts (1–100), including retries
- `billedCostUsd`: **total actual charge** for all attempts in that
  slot, in USD, or `null` if it cannot be determined
- `billingSource`: `"provider_export"`, `"invoice_transcription"`,
  `"manual_estimate"` or `"unknown"`
- `independentCheckLogSha256`: optional hash of a privately retained
  independent grader/check log; **a hash alone is not proof that a test ran**

Do not mark a failed/blocked terminal as correct. Record prices even for
failed tasks. A `blocked` terminal indicates an infrastructure/auth/tool
block; the scorer then marks the whole comparison **not comparable** and
withholds cost-per-success and success-rate conclusions. A genuine model
failure after a valid attempt can be recorded as `failed` with
`correct: false` and its actual costs. If the provider reports caching or retry details, keep the
original receipts *locally*; never insert API keys or raw logs into this
JSON file. A provider-export source label is still just **your declaration**.

**No model is called by any of these commands.** The operator is
responsible for actually running the trials and independent checks.

## 4. Produce a quality-and-cost summary

```sh
node index.cjs trial score \
  --trial "$ROOT/trial" \
  --observations "$ROOT/observations.json"
```

It checks that each recorded slot belongs to the current pair,
verifies every slot's prompt SHA-256, rejects mismatched model declarations
and duplicate/missing slots, and refuses inconsistent entries. Output
contains only **aggregate** statistics, not task source text, prompt
content, model logs or private slot identifiers.

If any task has not run, or a correctness judgment is unknown, success
rates stay **null**. Costs stay **null** if a charge is missing or any
entry is only a manual estimate. A zero-success arm cannot have a defined
cost per successful task.

When every slot has a reported charge from a provider export or
invoice transcription, the program calculates:

```text
cost per success =
  sum(all reported USD spent on attempts, including failed attempts)
  / count(successfully completed tasks)
```

For example, *hypothetically*: Raw spending $0.20 and succeeding twice
costs $0.10 per success; Prepared spending $0.12 and succeeding once
costs $0.12 per success. Total spending went down but the successful
task got **more expensive**. The program also reports raw-pass /
prepared-fail regressions and refuses to call that favorable.

The script's `ownerReportedCandidate` can be true on a complete,
non-regressing and cheaper owner-reported sample, but **always outputs**
`verifiedRealWorldSavings: false`. Neither source labels nor log SHA
values authenticate a provider invoice or actual task quality. Only
one distinct task is tested, so no production savings, typical success
rate or general effectiveness is established.

## 5. What counts as the next real milestone?

A completed, independently graded A/B task with actual model outputs
and retained provider native receipts, then a **pre-registered,
diverse multi-task study**, would be stronger evidence. The existing
30-task synthetic Cursor proposal/edit harness remains separate.
This owner-operated ledger cannot silently claim those benchmark results,
and does not substitute for them.

The files created here are private; keep them out of Git history and
social posts. You can share a summarized count/percentage and the
explicit unknowns, but not source, receipt, customer IDs, model secrets
or unredacted logs.
