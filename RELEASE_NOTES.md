# 0.11.0-alpha.4 — current-session agent workflow

Adds `agent-brief session <intent> <repo> <new-output-dir>`: return prepared source,
intent and baseline location directly to an existing terminal-capable agent. It
uses the preview path only and never launches a nested model or edits the target.
Unresolved questions remain visible and exit 1. The Codex executable is not needed
for this entry; that is exercised with Git-only PATH coverage.

ACTIVE_AGENT.md supplies an explicit workflow without automatically modifying any
personal/global instructions. A guided host-session walkthrough made one actual
synthetic source edit, passed five behavior tests and rejected an out-of-scope
mutation. This known-answer exercise is not an independent model A/B test and
has no measured full-session token/understanding benefit. The nested-CLI model
comparison remains blocked. Core unit tests now total 128.

# 0.11.0-alpha.3 — explicit Codex proposal adapter

Adds `agent-brief propose <intent> <repo> <new-output-dir>`: collect allowed source,
prepare one input and save a review bundle. Default preview makes no model calls.
Explicit `--live --model MODEL` calls a shared read-only, tools-disabled Codex CLI
adapter; response validation binds intent, acknowledgements and replacement paths,
then rechecks the observed target. Valid proposals are saved, never auto-applied.

A bundled intent demonstrates the workflow on this repository's boolean fixture.
No manual source/history JSON is required. The suite has 125 tests, including
simulated model responses, rejected scope/digest/output cases and unchanged-source
checks. Simulated responses do not establish live model success. Actual model
execution in this host remains blocked by sandbox startup. No real billing or
understanding improvement is claimed. No npm registry publication is performed.

# 0.11.0-alpha.2 — reproducible comprehension probe harness

Adds a dry-run-first evaluator with four raw/prepared cases: normal intent,
correction, tool-output instruction bait and unresolved questions. An explicit
live command can launch read-only CLI sessions on a compatible local machine,
record provider-reported usage, and retain blocked/invalid/unrun attempts.
Offline parser simulations cannot count as model successes. The live comparison
remains blocked in this environment; no measured comprehension/billing gain is
claimed. This is not an end-to-end code-editing benchmark.

The suite now contains 117 tests. Dependency versions and the core preparation,
rewrite and review behavior are unchanged. No automated model calls or GitHub
Actions workflow is added. The package remains source-only on GitHub, private
on the npm registry. See EVALUATION.md for reproducible usage and limitations.

# 0.11.0-alpha.1 — first public source alpha

Publishes the local input-preparation and edit-review experiment for independent
review. The npm registry package is not published; package.json remains private.

Includes conservative boolean rewrites, lossless repeated tool-history packing,
SHA-256 restoration checks, complete-input tokenizer measurements, intent-bound
plan checks, real working-tree observation and caller-configured acceptance
commands with a scope check after every command.

The suite has 108 tests. Synthetic complete-input examples show both negative and
positive net savings. Five real inspected files show no source savings. Live
agent A/B execution is blocked by the current runtime; no understanding, real
billing, task-success or production-readiness claim is made.

Requires Node.js >=20 and Git for working-tree features. Commands that execute
checks are explicitly caller configured and are not sandboxed. Baselines must
remain outside agent-editable paths. Legacy packed history v1 requires restoration
with its prior decoder before repacking to v2.
