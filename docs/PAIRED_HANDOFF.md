# Native Raw / Prepared A/B export (experimental)

Agent Brief Lab can now prepare **two directly readable versions of the same
existing-agent coding task**, with no model call and no source rewrite.

The purpose is to separate three questions:

1. Is a complete, native-readable input representation smaller?
2. Does the **same pinned model**, on the **same task**, successfully finish
   under both representations?
3. With **actual provider usage/charges**, is cost per **successful** task lower?

This CLI demonstrates **only question 1** until you carry out separately
authorized model trials and record their real outcomes.

## Prepare a task and export matched prompts

From this Draft PR's source checkout, with Node 20/24 and a Git repository:

```sh
ROOT="$(mktemp -d "${TMPDIR:-/tmp}/agent-brief-ab.XXXXXX")"

node index.cjs handoff \
  --repo . \
  --task "Simplify boolean returns but preserve the same behavior" \
  --file examples/boolean-before.js \
  --constraint "Keep function names and behavior" \
  --check "Run behavior tests after editing" \
  --out "$ROOT/handoff"

node index.cjs pair \
  --handoff "$ROOT/handoff" \
  --out "$ROOT/pair"
```

Both directories must be **new, private, within your operating system's
temporary directory**, and outside the code repository. The `pair`
command reads the already generated private bundle. Do not point it at
unrelated folders or private source you have not reviewed.

The `pair` output contains:

| File | Meaning |
| --- | --- |
| `raw.txt` | Exact original `handoff.txt`, with pretty-printed native JSON |
| `prepared.txt` | Equivalent native JSON with structural whitespace compacted, or the **exact raw fallback** |
| `pair-report.json` | Measured local input text counts, SHA-256s, selection reason and explicit cost/quality unknowns |

Both prompts have **the identical prefix/instructions**, task, source files,
constraint IDs/text and acceptance IDs/text. No code simplification, source
omission, rewritten file, custom history reference or model-specific decoding
is used. Structural JSON whitespace is not part of string literals, so the
prepared candidate has the **same decoded JSON values**, verified before it
is written. It may nonetheless influence model behavior, which must be
tested rather than assumed.

The only eligible prepared variant is one that has **fewer local text tokens
and fewer UTF-8 bytes** than raw. Local counts use `o200k_base`, not a
Cursor-native provider usage receipt. If the candidate does not pass both
gates, `prepared.txt` is identical to `raw.txt`.

For safety, if a prompt exceeds **8 KiB** or includes very long repeated
character runs, the program **skips tokenization entirely** to avoid
pathological memory use. It then returns the raw fallback, with
`rawLocalTextTokens`, `preparedLocalTextTokens` and
`localTextTokensSaved` equal to **null** (unknown, not zero). This protects
large-source workflows and does not silently equate byte savings with token
savings.

For one repository example (not representative user data), the exact
raw/prepared prompts measured **380 → 303 local tokens** and
**1531 → 1337 bytes**, with source and intent field-by-field identical.
This synthetic guided coding example contains no observed model result.

## Run an actual fair A/B trial (separately authorized)

1. Open and review `raw.txt` and `prepared.txt` locally before sharing
   any selected source with your AI provider.
2. Use **two independent disposable Git working copies**, restored to the
   identical commit and identical initial files. Do **not** run both on the
   same modified working tree, nor assume the Git scope verifier prevents
   malicious activity or ignored-file modifications.
3. Use the **same model/version, tools, sandbox policy, request and acceptance
   tests**. Randomize or alternate raw/prepared order across tasks to avoid
   order effects. Keep attempts/failures, including interrupted tasks,
   rather than deleting poor outcomes.
4. Let the agent actually make edits, then run the same trusted project
   checks independently; note correct completion, unexpected file changes
   and retries. A plan's `checks` field is **not** proof of executed tests.
5. Use original native provider receipts or invoices to measure input,
   cached input, output, reasoning tokens and actual USD per arm. Do not
   infer real spend from this tool's local tokenizer counts.
6. Report **total spend of all attempts divided by correctly completed
   tasks**. Any baseline-correct/prepared-incorrect regression matters,
   even if a compact prompt used fewer local tokens.

The existing `evaluation/cost-quality.cjs` and its Markdown scorecard
support the **frozen synthetic Cursor A/B runner reports**, but this
standalone `pair` output is **not automatically a provider report or a
compatible result schema**. Do not label a manually copied sample
`provider_export` without an actual external provider record. Never
post private code, prompts, invoice exports or full transcripts to GitHub.

## Security and evidence limits

This tool produces task data; it does not call Cursor/Codex/Claude, edit
project files, upload source or scan for secrets. It reads the authorized
original sources from an existing `handoff` bundle; its trusted Git baseline
also contains private repository file names and hashes. The two exported
prompts and their parent bundle **contain private source** and should
remain on the owner's device, ideally with no credentials or sensitive files
in the selected sources.

The new pair exporter is an experiment, not a guarantee that compact JSON
reduces end-to-end agent costs. It deliberately prefers a safe fallback when
it cannot measure a potential token improvement.

**Real-world quality and invoice-level cost effectiveness remain unverified.**
