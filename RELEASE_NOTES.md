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
