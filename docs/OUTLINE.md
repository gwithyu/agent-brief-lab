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

| Syntax | Locations returned |
| --- | --- |
| Top-level functions and direct arrow/function-expression bindings | Function name and range |
| Classes | Class, constructor, methods, getters/setters and direct callable fields |
| TypeScript declarations | Interface, type alias, enum and namespace declaration |
| ES imports and static CommonJS `require` | Range only; module strings are omitted |

Nested function bodies and namespace members are not separately traversed.
Dynamic imports, wrapped callbacks and ordinary variable declarations may be
unlisted. The report counts top-level statements with no listed location;
it does not claim that every part of a partly listed statement is represented.
Computed/literal member names and identifiers longer than 128 UTF-16 units
are returned as null. Anonymous declarations also use null. Overloads can
share a name: use their line ranges rather than assuming names are unique.

At most **500 locations** are emitted. `totalSymbols` counts all supported
locations found and `truncated` explicitly reports omitted locations.
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
symlink checks. Analysis runs in a local process with a 5-second deadline
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
