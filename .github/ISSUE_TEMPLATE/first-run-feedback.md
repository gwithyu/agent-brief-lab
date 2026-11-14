---
name: First-run feedback (privacy-safe)
about: Share an offline try-it result without uploading code, prompts, secrets or transcripts
title: "[First run] "
labels: []
assignees: []
---

## What did you try?

- [ ] Pinned no-clone `npm exec ... -- agent-brief try`
- [ ] Source checkout with `npm run try`
- [ ] Explicit `--source FILE` measurement (JS/TS only)
- [ ] Explicit `--history FILE` measurement (normalized text history)

## Environment

- Operating system:
- Node.js major version: 20 / 24 / other
- Did the command complete successfully? yes / no
- If not: **sanitized** error code only (please remove names and paths):

## Optional aggregate numbers

Report only numeric totals, never the actual text. For an unmodified dry-run
include original and prepared local tokens if available:

- Before local text tokens:
- After local text tokens:
- Exact history restore (if used): yes / no / not applicable
- No-gain case encountered: yes / no
- Any unexpected project file changes: yes / no / not checked

## Experience

- What was confusing or took unnecessary effort?
- Would you use a privacy-preserving, no-model-call preview again?
- Which feature would make it useful in your actual AI coding workflow?
- Is there one safe-to-share **general category** of task where it failed
  (example: "large repeated test output", not a source snippet)?

## Privacy checklist

- [ ] I have **not** included private source files, file paths, user prompts,
      chat histories, model logs, credentials, customer identifiers, or
      unredacted screenshots.
- [ ] I understand that counts from this trial are **not real provider token
      usage or bill savings**, and the tool does not auto-intercept Cursor,
      Codex or ChatGPT.

Thank you for taking the time to test! Even a zero-savings result is useful
for identifying where this early experiment needs to improve.
