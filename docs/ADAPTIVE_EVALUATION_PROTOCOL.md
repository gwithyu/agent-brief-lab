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

## Release gates

1. Deterministic local measurements and negative cases reproducible on supported Node versions.
2. No unacknowledged explicit requirement loss in the preregistered corpus.
3. No regression in paired acceptance/scope outcomes within the chosen tolerance.
4. Measured provider usage and cost claims supported by receipts from actual calls.
5. README claims match observed evidence; until then, describe the project as experimental.

## Current status

Protocol only. No new A/B calls, benchmark results, or billing reductions are claimed by this document.
