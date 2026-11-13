# Release verification — 0.11.0-alpha.9

Checked 2026-11-13. This is a public-source alpha, not a production-quality or
real-agent cost/understanding guarantee. No GitHub Actions workflow was required
or added; verification ran in the local execution environment.

| Check | Result |
| --- | --- |
| Locked clean install, `npm ci --ignore-scripts` | PASS |
| Node 24.22.1 suite | 140/140; no failures/skips/cancellations |
| Node 20.20.2 suite | 140/140; no failures/skips/cancellations |
| Installed npm tarball suite | 140/140; no failures/skips/cancellations |
| Installed `agent-brief` executable | PASS; 52→23 tokens on boolean fixture |
| Re-run demo against recorded JSON | Identical |
| Dependency versions/licenses | TypeScript 5.9.3 Apache-2.0; js-tiktoken 1.0.21 MIT; base64-js 1.5.1 MIT |
| Bundled dependency/credential/private-source check | Explicit source-file allowlist; none included |
| Public-source clone with an added link | session_ready; version-2 baseline; probe link removed after check |
| Symlink compatibility | Unchanged/dangling links accepted; mutations and editable links rejected; targets not read |
| Current-agent entry | Returns input/baseline; Git-only PATH test; no nested model |
| Guided host walkthrough | Five behavior tests passed; protected-file negative case rejected; not A/B |
| CLI completion stream | Malformed item envelopes and inconsistent/later unfinished lifecycle reject; normal start events accept |
| Intent/plan schema boundary | Undeclared top-level and entry fields reject; proposal plan projection remains valid |
| CLI discovery | `--help`/`-h` and `--version`/`-V` exit 0 with empty stderr; invalid usage remains exit 2 |
| Proposal schema boundary | Extra receipt/command/mode fields and invalid UTF-8 reject; valid Unicode accepts |
| Proposal adapter | Preview + simulated response/failure tests; no automatic application |
| Default probe dry run | Four cases, zero model calls |
| Live agent model task/A-B comparison | BLOCKED; see EVALUATION.md |
| npm public registry publication | NOT DONE; source GitHub release only |

The installed tarball exercise verifies the executable mapping and that runtime
modules/tests survive packaging, not just execution from a development folder.
Release documentation changes do not alter the measured demo source fixtures.

Review commands are trusted caller configuration, not a security sandbox. Actual
command exit codes and per-command workspace observations are checked; assertions
may still be weak, and unobserved/transient/ignored changes remain limitations.
Working-tree fixtures are temporary synthetic repositories, not a private Home
project or evidence of a live agent successfully editing a real application.


## First-user installation follow-up (same alpha.6 runtime)

The runtime code/version was unchanged for this documentation-only follow-up.
A new directory and explicitly new npm cache fetched public commit
`5677d1901fe4d694dc433fa9cbfd13f110d1e527` via its GitHub archive URL.
No pre-existing local installation or workdir node_modules directory was used to
resolve the npm-exec binary.

| Consumer path | Observed result |
| --- | --- |
| Remote-archive npm exec: measure | PASS; boolean fixture 52→23 text tokens |
| Remote-archive npm exec: session | PASS; session_ready, baseline saved, target source unchanged |
| One-time local prefix install, direct executable | PASS; session_ready without launching npm; source unchanged |
| npm exec --offline with the original remote URL | UNSUPPORTED in this check; ENOTCACHED |

Observed runtime: Node 24.22.1, npm 11.9.0, Linux. Observed dependency versions were
TypeScript 5.9.3, js-tiktoken 1.0.21 and base64-js 1.5.1. These are consumer smoke
checks, not extra unit-test counts or model/billing results. No real model was
launched by these session commands. A direct installed invocation avoids asking
npm to resolve the archive on each launch; the test did not enforce OS-level
network isolation. The source checkout's npm ci remains the lockfile reproduction
path, distinct from convenient archive installation.


## Alpha.7 quick-run pin refresh

After publishing the runtime, an empty consumer directory and new npm cache fetched
`f7111c262d0025d5634e85c0694c3b0953b83eda` through the public archive URL.
The installed helper reported version 0.11.0-alpha.7, its codex.cjs bytes matched
the tested source, and session returned session_ready with a saved baseline and
unchanged target source. The README quick-run URLs were updated only after this
check. No model call or model-performance claim is part of this consumer check.


## Alpha.8 quick-run pin refresh

After publishing the alpha.8 runtime, a new consumer directory and empty npm
cache fetched public commit `c13a0849f411fa37b6893c6858ee3b0b041a9726`
through its archive URL. The installed helper reported version 0.11.0-alpha.8;
its index.cjs and propose.cjs bytes matched the tested source. `session` returned
session_ready, saved its baseline in a mode-700 bundle directory and left the
target source unchanged. A second installed-CLI check supplied an undeclared
intent `notes` field and observed exit 1 with no stdout instead of a silently
truncated brief. The README pins were changed only after these checks. No model
call, billing saving or comprehension improvement is claimed by this smoke test.


## Alpha.9 quick-run pin refresh

A new consumer directory and empty npm cache fetched public runtime commit
`5be0b0cf7ace585b3059cbda87342da13d3c9970`. Remote-archive npm exec returned
0.11.0-alpha.9 for `--version`, rendered the complete help document, and produced
a session_ready bundle from a new synthetic Git project. The target source hash
and Git status remained unchanged. Direct execution of the cache-installed binary
confirmed both discovery commands exit 0 with empty stderr, and its index.cjs
bytes matched the tested runtime. README archive pins were updated only after
these checks. This remains distribution/usability evidence, not a model A/B or
real billing result.
