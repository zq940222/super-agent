# ADR 0006 — `edit_file`: surgical edits via exact string replace (not apply_patch, yet)

- **Status:** Accepted
- **Date:** 2026-07-26
- **Deciders:** @zq940222
- **Related:** [P14 — #39](https://github.com/zq940222/super-agent/issues/39), [ADR-0004](0004-capable-tools.md) (§4 output-size discipline), [ADR-0005](0005-shell-exec.md), `docs/agent-research.md` (line 338 "通用 agent 先做通用 fs 工具，patch 后续", §3.3 Codex apply_patch)

## Context

The agent can `read_file`, `list_dir`, `glob`, `grep`, and `write_file` — but the only way it
can *change* a file is `write_file`, which overwrites the whole thing. To fix one line in a
500-line file the model must reproduce all 500 lines, which is slow, token-heavy, and a
correctness hazard (any transcription slip silently rewrites the file). `edit_file` closes the
last gap in the capable-tools arc: a **surgical** edit that changes a target region and leaves
the rest byte-for-byte untouched.

Two established routes for this:
- **Codex** — `apply_patch`, a freeform tool constrained by a Lark grammar: the model emits a
  `*** Begin Patch … *** End Patch` envelope with `@@` hunks and context lines, matched fuzzily.
- **Claude Code** — a dedicated `Edit` tool: exact `old_string` → `new_string` replacement,
  required to match uniquely.

Our own research (line 338) is explicit for a general agent: **do the dedicated fs edit tool
first, `apply_patch` later.** This ADR records that choice and the edit semantics.

## Decision

### 1. Exact string replace, not `apply_patch`

`edit_file({ path, old_string, new_string, replace_all? })` reads the file (UTF-8), finds
`old_string`, replaces it with `new_string`, and writes the file back. No diff envelope, no
grammar, no fuzzy matching. Deterministic and parser-free — it fits the from-scratch ethos and
pairs naturally with the `read_file` → edit loop (the model copies the exact text it just read).

### 2. Unique-match semantics

The occurrence count is `content.split(old_string).length - 1` (not an `indexOf` stride, which
mis-counts overlaps like `"aa"` in `"aaa"`). Then:
- **0** → return "not found" (no write) — the model must re-read and copy the exact text.
- **>1 and not `replace_all`** → return "N occurrences; add surrounding context to make it
  unique, or pass `replace_all`" (no write). Ambiguity is refused, never guessed.
- **`replace_all: true`** (default `false`) → replace every occurrence. Cheap, and it spares a
  rename from becoming N sequential re-reads.
- **exactly 1** → replace it.

### 3. Guards (all refuse cleanly, before any write)

- **File must exist** — else "not found; use write_file to create it" (`edit_file` edits; it
  doesn't create).
- **`old_string` non-empty** — else point to `write_file`; an empty match has no unique-match meaning.
- **`old_string === new_string`** — a no-op; refuse rather than churn the file's mtime.
- **Binary file** (a NUL byte in the first chunk, like `grep`) — refuse; string replacement on
  non-text would corrupt it.

### 4. Own failures return error *strings*; only a path escape throws

`edit_file`'s own refusals (§2/§3) return an error **string**, so the model sees a tool result it
can act on (add context, re-read) rather than a crash. The one exception is a `path` that escapes
the workspace: `resolveInWorkspace` **throws** (the engine catches it → `isError` result), exactly
as `write_file` and the P14-4 tools do. That asymmetry is deliberate — a boundary violation is not
a retryable edit mistake.

### 5. Risk `low`, `mutates: true` — identical to `write_file`

No new risk decision: an edit is a file write. So `default` runs it without a prompt, `readonly`
denies it (mutating), `auto` allows it — **no gate change**. Path is workspace-bounded via
`resolveInWorkspace`.

### 6. Return a confirmation + a **bounded** snippet

Return "Edited `<path>`: replaced N occurrence(s)" plus a short context snippet around the change
so the model can self-verify the edit landed — capped with the same `…[truncated N of M chars]`
marker as the other tools (ADR-0004 §4). `new_string` can be arbitrarily large, so the snippet
must be bounded or a big replacement echoes itself back into the context window.

### 7. Idempotency caveat (documented, not fixed)

Re-running an edit that already landed finds **0** occurrences of `old_string` and returns "not
found" — which reads like a failure though the file is already correct. Acceptable for v1; the
tool description tells the model to **re-read the file before retrying** a seemingly-failed edit.

## Consequences

**Positive**
- Surgical edits: the model changes a region without reproducing the whole file — faster, cheaper,
  and no whole-file-rewrite hazard.
- Zero new risk surface — inherits `write_file`'s gate posture and the workspace boundary.
- Deterministic and unit-testable with real temp files; no parser to maintain.

**Negative / accepted**
- **Brittle to whitespace/context**: the model must reproduce `old_string` byte-exact; a stray
  space or a CRLF/LF mismatch fails the match. The clear "not found / N occurrences" errors steer
  it, but fuzzy matching is genuinely deferred.
- **No atomicity**: direct `writeFile` (matching `write_file`) means a crash mid-write truncates
  the file — and unlike `write_file` (where the model still holds the full content) the *original
  is gone*. The honest cost of not doing temp-file+rename in v1.
- One edit per call (plus `replace_all`); multi-hunk edits are multiple calls until `apply_patch`.

## Alternatives considered

- **`apply_patch` / unified-diff (Codex Lark grammar).** Rejected for v1 per research line 338: the
  envelope parser + `@@` hunk handling + fuzzy context matching is its own phase of work. It's the
  named upgrade path — more robust and multi-hunk in one call — once the simple tool proves out.
- **Line-range replace** (`edit_file({ start_line, end_line, text })`). Rejected: line numbers
  drift as the file changes and force the model to track them across edits; string context is more
  robust and self-describing.
- **Empty `old_string` to create a file** (Claude Code allows it). Rejected: `write_file` already
  owns creation; overloading `edit_file` blurs the two.
