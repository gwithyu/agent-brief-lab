#!/usr/bin/env bash
# Offline-independent acceptance runner; run separately under Node 20 and 24.
set -euo pipefail

fail() { printf 'VERIFICATION BLOCKED: %s\n' "$*" >&2; exit 2; }
root="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
cd "$root"
command -v git >/dev/null 2>&1 || fail 'Git is required'
command -v node >/dev/null 2>&1 || fail 'Node.js is required'
command -v npm >/dev/null 2>&1 || fail 'npm is required'
version="$(node -p 'process.versions.node')"
major="${version%%.*}"
case "$major" in 20|24) ;; *) fail "expected Node 20 or 24, got $version" ;; esac
[[ -f package-lock.json && -f package.json ]] || fail 'run from the complete repository checkout'
[[ -z "$(git status --porcelain --untracked-files=normal)" ]] || fail 'checkout must be clean before testing'
sha="$(git rev-parse --verify HEAD)"
output="$(mktemp -d "${TMPDIR:-/tmp}/agent-brief-test-node${major}.XXXXXX")"
chmod 700 "$output"
printf 'Commit: %s\nNode: %s\nnpm: %s\nLog directory: %s\n' "$sha" "$version" "$(npm --version)" "$output"
printf '%s\n' "$sha" > "$output/commit.txt"
node --version > "$output/node-version.txt"
npm --version > "$output/npm-version.txt"
printf 'RUNNING\n' > "$output/status.txt"
finish() {
  rc=$?
  if (( rc == 0 )); then
    printf 'PASS\n' > "$output/status.txt"
    printf 'VERIFIED: Node %s, commit %s (logs %s)\n' "$version" "$sha" "$output"
  else
    printf 'FAIL (exit %s)\n' "$rc" > "$output/status.txt"
    printf 'NOT VERIFIED: exit %s; inspect %s\n' "$rc" "$output" >&2
  fi
}
trap finish EXIT
npm ci --ignore-scripts --no-audit --no-fund 2>&1 | tee "$output/npm-ci.log"
npm test 2>&1 | tee "$output/npm-test.log"
[[ -z "$(git status --porcelain --untracked-files=normal)" ]] || fail 'test run changed tracked/untracked project files'
