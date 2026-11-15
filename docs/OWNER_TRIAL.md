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

New trials emit `agent-brief-owner-trial-observations.v2`. For each slot,
fill `terminal` (`"completed"`, `"failed"` or `"blocked"`), `correct`
(`true`, `false` or `null`), and `attempts`. Keep
`independentCheckLogSha256` null unless you retained an independent check
log privately; a hash alone does not prove a check ran.

`attempts` is an ordered list of **every attempt, including failed attempts
and retries** (1–100). Each entry has exactly these fields:

```json
{
  "terminal": "failed",
  "modelObserved": "EXACT_PROVIDER_MODEL_ID",
  "billedCostUsd": null,
  "billingSource": "unknown",
  "inputTokens": null,
  "outputTokens": null,
  "cachedInputTokens": null,
  "usageSource": "unknown"
}
```

- `terminal`: `"completed"`, `"failed"` or `"blocked"`. The final attempt
  must match the slot terminal, except a blocked slot may retain a later
  recovered attempt. A completed model response can still be
  incorrect (`correct: false`). Do not mark a failed/blocked slot correct.
- `modelObserved`: exact actual model ID. Every attempt must match the
  requested model, including retries; switching to a stronger model cannot
  silently qualify as a same-model comparison.
- `billedCostUsd`: actual USD charge for **this attempt**, or `null`.
  `billingSource` is `"provider_export"`, `"invoice_transcription"`,
  `"manual_estimate"` or `"unknown"`. Do not put a slot total in each
  attempt. The scorer sums these amounts using exact integer units;
  one missing charge or manual estimate withholds comparative costs.
- `inputTokens`, `outputTokens`, `cachedInputTokens`: provider-native
  nonnegative integer counts, or `null` individually if unavailable.
  `usageSource` is `"provider_export"` or `"unknown"` (all token fields
  must be null for unknown). **Input includes cached input**: cached
  input is a subset, never added to input again. Normalize a provider's
  uncached-only input count before recording it. Do not insert local
  tokenizer estimates or infer a bill from these counts.

For a failed first attempt followed by a successful retry, retain the failed
entry above with its actual charge/usage, then append the successful entry.
Counts and charges are derived from the list, so there is no separately
entered retry count or total that can disagree with the recorded attempts.
Partial token fields remain unknown independently; a missing output count
need not erase a known input count. Unsafe aggregate token totals stay null.

A `blocked` attempt denotes an infrastructure/auth/tool problem. Mark its
slot `blocked` too, even if a later retry recovered; the whole comparison
then stays **not comparable**. A genuine model failure with valid tools
can be recorded as `failed` with `correct: false` and its actual costs.
Keep original provider receipts locally; never put credentials, raw logs,
customer IDs or receipt contents into this JSON.

**Compatibility:** Existing `agent-brief-owner-trial-observations.v1`
files still accept the original `modelObserved`, `attemptCount`,
`billedCostUsd` (all attempts combined) and `billingSource` fields per
slot. They are explicitly labeled legacy declared totals; provider usage
stays unknown. Do not change only the schema label to migrate: expand the
actual attempts from retained evidence, or keep the original v1 file.

All attempt coverage, source labels and values remain **owner declarations**.
The scorer cannot discover omitted calls or authenticate provider receipts.

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
contains only **aggregate** statistics (including per-arm attempt counts and
provider usage with explicit unknowns), not task source text, prompt
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
non-regressing and cheaper owner-reported sample **only if the Raw/Prepared
prompt hashes differ**. If packing fell back to the exact raw prompt,
`trial.promptTreatmentDistinct` is false: this is an identical-prompt
control, and cheaper observed bills cannot establish a packing effect.
The scorer **always outputs**
`verifiedRealWorldSavings: false`. Neither source labels nor log SHA
values authenticate a provider invoice or actual task quality. Only
one distinct task is tested, so no production savings, typical success
rate or general effectiveness is established.

## 5. Import existing Codex JSONL traces locally

If you already ran the independent slots using `codex exec --json`, the
**offline** importer can copy native usage into v2 observations. It does
not launch Codex, run tools from the logs, or grade the assistant's answer.
It reads the documented `thread.started`, `turn.started`, and
`turn.completed.usage` events from the
[official Codex event types](https://github.com/openai/codex/blob/main/sdk/typescript/src/events.ts).

Keep the run map and logs together in a private temporary directory. Create
`runs.json` from the **current private trial manifest**. This example has two
slots; include every slot exactly once, and every attempt in execution order:

```json
{
  "schema": "agent-brief-codex-trial-import.v1",
  "pairFingerprint": "COPY_FROM_MANIFEST",
  "entries": [
    {
      "slot": "slot-01",
      "promptSha256": "COPY_THIS_SLOTS_HASH",
      "attempts": [
        {
          "eventsFile": "slot-01-attempt-1.jsonl",
          "exitCode": 0,
          "modelObserved": "EXACT_MODEL_ID",
          "freshSession": true
        }
      ]
    },
    {
      "slot": "slot-02",
      "promptSha256": "COPY_THIS_SLOTS_HASH",
      "attempts": [
        {
          "eventsFile": "slot-02-attempt-1.jsonl",
          "exitCode": 0,
          "modelObserved": "EXACT_MODEL_ID",
          "freshSession": true
        }
      ]
    }
  ]
}
```

```sh
node index.cjs trial import-codex \
  --trial "$ROOT/trial" --runs "$ROOT/logs/runs.json" \
  --out "$ROOT/imported"
node index.cjs trial score \
  --trial "$ROOT/trial" --observations "$ROOT/imported/observations.json"
```

The new private output directory contains `observations.json` and
`import-evidence-private.json`, with retained trace SHA-256 fingerprints.
Native input/output/cache counts are copied from each trace, not calculated
from prompt size. Missing usage stays null. Every imported charge and
correctness grade **starts null**, even if the answer says it succeeded.
After reviewing independent checks and receipts, fill those fields in a
private working copy and score it normally.

The importer validates the original trial prompt hashes and the run map's
slot/hash bindings, and rejects duplicate trace content or thread IDs,
concatenated/multi-turn traces, impossible token counts, malformed events,
and paths outside the run map's directory (including symlink escapes).
It accepts at most 1 MiB per log, 32 MiB combined, and 100 attempts per slot.
Successful completion with a nonzero process exit is rejected. Failed or
incomplete nonzero-exit traces retain unknown usage and mark the whole
comparison infrastructure-blocked. A pre-start failure without a usable
thread/turn trace needs a manual blocked observation instead.

**Limits:** The JSONL event stream has no authenticated model, prompt or
fresh-session identity. Those bindings in the run map are **your declarations**,
not facts discovered by the importer. A single resumed trace may look like a
new session: only declare `freshSession: true` for a genuinely new run, never
`resume`, because prior session usage could contaminate the comparison.
Keep attempts in separate fresh sessions, including retries. This small
importer cannot reconstruct cumulative multi-turn billing or detect a call
that was omitted from the run map. Local trace hashes authenticate neither
the provider nor the truth of a log.

## 6. What counts as the next real milestone?

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
