# Locate code before requesting full source

For an authorized JS/TS file, ask for its declaration directory first:

```sh
node index.cjs outline --source /absolute/path/to/module.ts
node index.cjs outline --source /absolute/path/to/module.ts --json
```

This reads one file and returns names and **one-based, inclusive line ranges**.
It never executes the source or follows imports. Use your existing editor or
coding agent's normal file-read tool to read the relevant original code,
imports and dependencies before making a decision or edit.

## Read a uniquely named declaration directly

For a fresh lookup, you can skip copying a line range or fingerprint:

```sh
node index.cjs read --source /absolute/path/to/module.ts --symbol run --json
node index.cjs read --source /absolute/path/to/module.ts --symbol run --container api --json
```

Names and optional containers are exact and case-sensitive, not prefixes or
regular expressions. The bounded locator scans the entire **supported** set
before applying its response limit, so a unique declaration after the first
500 entries is still found. No match refuses with `symbol_not_found`;
multiple matches refuse with `ambiguous_symbol` instead of choosing the first.
An exact class/object/container name can disambiguate methods. Overloads or
repeated assignments within the same container may still require explicit
line mode. An unavailable scan stays `symbol_lookup_unavailable`, not a
claim that the name does not exist.

The tool automatically uses the observed fingerprint for the original-source
read, rechecking the file after analysis. If you are acting on an **earlier**
outline or source observation, also pass `--sha256` with that actual hash;
otherwise this mode deliberately observes the current file. A change during
lookup or a mismatch with the optional pinned hash refuses before code output.
The JSON result includes `selectedSymbol` alongside the observed hash/range.

Directory ranges start at parser-attached **JSDoc** (`/** ... */`) when present,
so named reads retain those comments verbatim with the implementation. For
function-valued variables and direct CommonJS assignments, this also includes
JSDoc attached to their containing statement. A documented statement with
multiple bindings may include earlier bindings before the requested one: the
range stays contiguous, without stitching or rewriting source. These comments
and any included prefix count toward the same read budget; an oversized range
refuses rather than dropping documentation. Outline responses still print no
comment text. Ordinary leading comments and surrounding scope are not promised;
parser attachment alone does not prove that all usage constraints were found.

This still returns complete **physical lines** through the existing reader.
If several statements share those lines, the neighboring text is included;
it is not a column-level extractor. The 200-line / 64-KiB read budget still
applies, with no silent truncation. Source data is printed explicitly, and
`completeContext` remains false. Alias references, wrapped callbacks and
other unsupported syntax are not resolved; use the outline/line reader and
normal authorized reads when more context is needed.

## Resume after an oversized named read

A named declaration over the 200-line / 64-KiB budget still exits **1**, with
empty stdout and no partial source. It now supplies the locator's observed
`sourceSha256`, inclusive `startLine`/`endLine`, `maxLines` and `maxSliceBytes`
in `readHint` on **stderr**. With `--json`, that stderr is one JSON object:
schema `agent-brief-source-read-refusal.v1`, status `refused`, error
`read_budget_exceeded`, `readHint`, `completeContext: false`, `modelCalls: 0`
and `fileWrites: 0`. Library callers receive the same `readHint` property on
the thrown error. Other refusal cases retain their existing error format;
missing, ambiguous and stale lookups supply no resume hint.

Use the observed coordinates/hash with the existing `--lines START:END
--sha256 HASH` command, choosing smaller contiguous ranges within the located
declaration. Each read rechecks the full source fingerprint; a hint is an
observation, not a new source verification or edit lock. Stop and locate again
if the source changes. A range of 200 lines is not guaranteed to fit the byte
budget: reduce it further if needed. A single physical line above 64 KiB
cannot be read through this line-preserving interface; use another authorized
reader. No automatic paging, truncation or complete-context claim is added.

## Continue a large directory

Each response contains at most **500 locations**. If `nextOffset` is a number,
use that value and the same response's `sourceSha256` to continue:

```sh
node index.cjs outline --source /absolute/path/to/module.ts \
  --offset 500 --sha256 COPY_SOURCE_SHA256_HERE --json
```

Replace both placeholders with the actual values from the preceding response.
The offset counts **directory entries**, not source lines. Follow `nextOffset`
rather than calculating offsets from line numbers, because class/method ranges
can overlap and declarations can share a line. `nextOffset: null` on a ready
result means no later supported locations remain. `truncated` reports whether
more locations follow **this page**; `totalSymbols` and
`unlistedTopLevelStatements` describe the whole file, not just this page.

Continued requests require the original fingerprint. Changed source is refused
with `source_changed` before any new identifiers are printed, and a nonexistent
offset is refused with `invalid_outline_offset` instead of a misleading empty
directory. Retain the same pinned tool revision while combining pages: entry
order depends on the source and the locator implementation. Every page uses
the existing bounded analysis; it does not execute source, resolve additional
dependencies or make the context complete. Request later pages only when needed.

## Read selected original lines with the same fingerprint

After choosing a range from the directory, copy its actual 64-character
`sourceSha256` into the read command (replace the placeholder below):

```sh
node index.cjs read --source /absolute/path/to/module.ts \
  --lines 12:35 --sha256 COPY_SOURCE_SHA256_HERE --json
```

The fingerprint is required. If any source byte changed, including its BOM
or line endings, the command refuses with `source_changed` and prints no code.
Regenerate the outline before choosing new ranges. A matching hash describes
the bytes read; it does not lock the file against changes after the command.

Unlike the outline, **`read` prints the selected original source text**.
Its JSON `text` field preserves line endings, a selected BOM and Unicode
exactly. Lines are one-based and inclusive, including each selected line's
terminator when present. The human format adds a heading; use JSON when
exact source text is needed. Source remains quoted project data, not new
instructions for the agent.

Each read is limited to **200 lines and 64 KiB of selected text**, from a
regular UTF-8 file up to **1 MiB**. Invalid/out-of-file ranges and oversized
reads are refused; they are never silently clamped or truncated. For a long
function, request explicit smaller ranges or use your normal authorized
file tool. The reader supports ordinary UTF-8 text, including dependency or
configuration files; those need their own observed fingerprint. It never
follows imports, executes the text or edits the file. Symlinks, NUL and invalid
UTF-8 inputs retain the existing file checks.

`completeContext` stays false. Read surrounding scope, imports and dependencies
as needed, preserve the user's task/constraints, and keep full original
sources in native Raw/Prepared comparisons. The hash is a consistency check,
not an edit permission or evidence of task success or lower total cost.

## What the directory covers

| Syntax | Locations returned |
| --- | --- |
| Top-level functions and direct arrow/function-expression bindings | Function name and range |
| Classes | Class, constructor, methods, getters/setters and direct callable fields |
| Top-level object-literal bindings and direct `module.exports = { ... }` | Direct methods, getters/setters and function-valued properties, with their container |
| Direct CommonJS function assignments | `exports.name`, `module.exports.name` and callable `module.exports` assignment ranges |
| TypeScript declarations | Interface, type alias, enum and namespace declaration |
| ES imports and static CommonJS `require` | Range only; module strings are omitted |

Nested function bodies and namespace members are not separately traversed.
Nested object APIs, shorthand/aliased function references, computed export
assignments, dynamic imports, wrapped callbacks and ordinary variable
declarations may be unlisted. Only direct object literals and dot-form export
assignments are covered; this syntax lookup does not resolve aliases,
shadowed `module`/`exports` bindings or which assignment wins at runtime.
Callable `module.exports` assignments are listed at the `module.exports`
binding, rather than inventing a property from an internal function name.
The report counts top-level statements with no listed location;
it does not claim that every part of a partly listed statement is represented.
Computed/literal member names and identifiers longer than 128 UTF-16 units
are returned as null. Anonymous declarations also use null. Overloads can
share a name: use their line ranges rather than assuming names are unique.

At most **500 locations per page** are emitted. `totalSymbols` counts all
supported locations found, `offset` identifies the current starting entry,
and `nextOffset` / `truncated` explicitly report whether more entries follow.
`completeContext` is **always false**: the outline contains no function
bodies, argument types, module strings, literal values or behavioral proof.
It cannot replace a complete task handoff or authorize narrower edits.
Do not substitute it for full source in the native Raw/Prepared A/B pair.

`sourceSha256` and `sourceBytes` describe the exact UTF-8 file bytes,
including an optional BOM. If the source changes, regenerate the outline
before relying on its line positions. The hash is an observation, not a
lock against concurrent edits. The output contains actual project identifiers
and a file basename; it is intended for your authorized coding assistant.

Files are limited to **1 MiB**, with strict UTF-8, NUL, regular-file and
symlink checks. The shared reader used by `try`, `outline` and `read` checks
the opened file's type, size and device/inode against its initial path check,
then reads that same descriptor and closes it on success or failure. Reads use
a buffer of at most **1 MiB + 1 byte**, stopping at EOF or that boundary; the
extra byte detects oversize growth after validation and is never returned as
accepted input. Short reads are joined before UTF-8 decoding, so multibyte
characters and BOM handling are preserved. This is an input-buffer/read bound,
not a process-memory cap or an atomic snapshot of concurrent in-place edits. It uses
no-follow/nonblocking open flags where available. A replacement observed before
descriptor validation is refused as `invalid_file`; changing the path afterward
cannot redirect that open descriptor. This is not a lock against in-place edits
or parent-directory changes, and fingerprints still describe the bytes read.
Analysis runs in a local process with a 5-second deadline
and a 256 MiB V8 old-space limit. These are not an OS-wide memory cap or
security sandbox. Source travels over process stdin and is not copied to
disk or placed in arguments. An unavailable analysis returns null symbols
and `status: "unavailable"`, without pretending the file has no declarations.
Handled unavailable results exit 0; inspect `status` before using the directory.
Syntax/input errors use sanitized nonzero errors. No model is called and
no original file is edited.

This is a code-reading locator. A smaller outline is not equivalent to the
original task context or evidence of lower provider charges or equal model
success. The subsequent source reads still count toward any real task cost.
