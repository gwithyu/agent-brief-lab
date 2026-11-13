# Release verification — 0.11.0-alpha.1

Checked 2026-11-13. This is a public-source alpha, not a production-quality or
real-agent cost/understanding guarantee. No GitHub Actions workflow was required
or added; verification ran in the local execution environment.

| Check | Result |
| --- | --- |
| Locked clean install, `npm ci --ignore-scripts` | PASS |
| Node 24.22.1 suite | 108/108; no failures/skips/cancellations |
| Node 20.20.2 suite | 108/108; no failures/skips/cancellations |
| Installed npm tarball suite | 108/108; no failures/skips/cancellations |
| Installed `agent-brief` executable | PASS; 52→23 tokens on boolean fixture |
| Re-run demo against recorded JSON | Identical |
| Dependency versions/licenses | TypeScript 5.9.3 Apache-2.0; js-tiktoken 1.0.21 MIT; base64-js 1.5.1 MIT |
| Bundled dependency/credential/private-source check | Explicit source-file allowlist; none included |
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
