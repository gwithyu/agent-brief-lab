# Live agent evaluation: NOT COMPLETED

A real A/B evaluation remains a limitation of this alpha, not a passing gate.

Readiness was attempted with the installed, signed-in Codex CLI. No task or model
completion was obtained: initial startup failed on read-only runtime state; a
writable isolated runtime reached thread startup but its filesystem sandbox helper
failed because a required NETLINK_ROUTE socket operation was not permitted.
No sandbox/approval bypass was used. Readiness attempts are not counted as model
results or evidence of comprehension.

## Required future comparison

Use the same named model/build, task fixtures, budgets and assertion suite across
independent raw/prepared sessions; record task order and all failures. Start with
normal edits, stale requirements, protected-file temptations and instruction-like
tool output. Have an independent reviewer verify assertions and patch scope.

Record complete input/output/tool trajectories, provider-reported usage (including
cache fields when provided), tools executed, actual files changed, tests/builds,
violations and manual corrections. Keep synthetic tokenizer counts separate from
provider billing. Do not substitute packed-history restoration or unit tests for
model behavior. Include repeated runs and uncertainty before making broad claims.

Do not include credentials, private source, unredacted personal conversations or
runtime authentication material in public evaluation artifacts.
