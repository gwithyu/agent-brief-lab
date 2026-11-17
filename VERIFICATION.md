# Experiment verification — 2026-11-17

Tested snapshot: `145e7f37af1d0d58bba55818d328e4c4d2d0eb3d`.
Both clean-checkout `scripts/verify-local.sh` runs completed with exit 0:
Node 20.20.2 **358/358**, Node 24.22.1 **358/358**, with no failures,
skips or cancellations. Each verifier performed a lockfile install with
scripts disabled and checked that HEAD and the working tree stayed unchanged.
No GitHub Actions workflow or live model was used for this verification.

The shared reader retains descriptor-bound type, size and exact bigint
identity checks, no-follow/nonblocking open flags where available, and
success/failure descriptor closure. It now consumes at most **1 MiB + 1 byte**
from that descriptor, stopping at EOF or the fixed buffer boundary. The extra
byte detects oversize growth and is not returned as accepted input. This bound
applies once in the helper shared by `try`, `outline` and `read`.

A deterministic reproduction against the previous committed reader grew a small
file to 2 MiB after its descriptor metadata check. The old reader consumed all
2,097,152 bytes before refusing it. The new growth regression requires refusal
with no more than 1,048,577 bytes consumed and verifies descriptor closure.
Two more tests cover joining short reads before multibyte UTF-8/BOM decoding
and cleanup after a simulated later I/O error. An existing guard test also
checks acceptance of an exact 1-MiB input ending in a multibyte character.

All eight shared-reader regressions and both lookup/read race regressions pass.
The earlier path-swap, inode identity, opened type/size and integer-precision
checks remain covered; lookup/read race fixtures now observe EOF of bounded
reads. These are temporary-fixture mutations and injected I/O/metadata cases,
not proof against every filesystem race. The bound covers input-buffer size
and returned read bytes, not total process memory or atomic snapshots against
concurrent in-place edits; fingerprints describe the bytes actually read.

## First-run and installed-source checks

The checkout walkthrough and a fresh empty consumer directory each passed
**8 CLI smoke checks** on Node 24.22.1. The consumer used `npm exec --ignore-scripts`
with the immutable tested snapshot's GitHub archive. Checks covered the
published outline/named-read walkthrough, a second public-source lookup,
body-free oversized-read hints, exact CRLF reconstruction in two line reads
and refusal of a stale resume hash. Target source was unexecuted and unchanged
by the tools; the consumer directory stayed unchanged. Fixture changes for the
stale-hash case were made by the test harness. Five installed runtime files
(`index.cjs`, `outline.cjs`, `source-read.cjs`, `evaluation/try-it.cjs`,
`evaluation/owner-trial.cjs`) matched the tested checkout byte-for-byte.
The installed package also passed **10/10 focused regression tests**: eight
shared-reader checks and both lookup/read race checks.

The README and first-run archive links now point to this verified snapshot.
The following documentation-only update does not change product runtime or
the tested source fixtures. The experiment remains a Draft PR.

## Local output-size observations (not a model or billing benchmark)

These two deliberately selected public self-source lookups produced identical
counts from the checkout and installed CLI, using local `o200k_base` tokenization:

| File / selected declaration | Full source text | Named-read stdout | Outline + named-read stdout |
| --- | ---: | ---: | ---: |
| `source-read.cjs` / `readSymbol` | 1,652 | 422 | 943 |
| `evaluation/owner-trial.cjs` / `summarizeUsage` | 6,790 | 360 | 1,541 |

The first column of counts is the complete original file text, without a tool
response wrapper. The other columns count the actual JSON stdout, including
its metadata and whitespace; outline-plus-read is the sum of both outputs.
Tool arguments, agent instructions, later dependency/context reads, retries,
model outputs, provider accounting and bills are excluded. This is an output
size observation on two chosen examples, not equivalent task inputs or a
representative success-rate/total-cost estimate. All reads still report
`completeContext: false`; `verifiedRealWorldSavings` remains false.

---

# Historical release verification — 0.11.0-alpha.10

Checked 2026-11-13. This is a public-source alpha, not a production-quality or
real-agent cost/understanding guarantee. No GitHub Actions workflow was required
or added; verification ran in the local execution environment.

| Check | Result |
| --- | --- |
| Locked clean install, `npm ci --ignore-scripts` | PASS |
| Node 24.22.1 suite | 141/141; no failures/skips/cancellations |
| Node 20.20.2 suite | 141/141; no failures/skips/cancellations |
| Installed npm tarball suite | 141/141; no failures/skips/cancellations |
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
| Prototype-named paths | `__proto__`, `constructor`, `toString` survive baseline JSON; allowed edit passes, protected edit rejects |
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

## Alpha.10 quick-run pin refresh

A new consumer Git fixture containing `__proto__` and an empty npm cache fetched
public commit `34ab09ce88565a0de04e68c47b2d6b6c651cae3a`. The installed
helper reported 0.11.0-alpha.10, returned session_ready and preserved the complete
allowed file as an own source entry in the saved JSON baseline. Target contents
and Git status stayed unchanged. Its execution.cjs bytes matched the tested
runtime. README pins were updated after this check. Synthetic history counts were
regenerated for the changed execution.cjs fixture; no model or billing result is
implied by their change.
