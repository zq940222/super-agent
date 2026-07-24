# ADR 0001 — Interactive TUI frontend: an inline REPL over the event stream

- **Status:** Accepted
- **Date:** 2026-07-24
- **Deciders:** @zq940222
- **Related:** [P11 — #22](https://github.com/zq940222/super-agent/issues/22), `docs/our-agent-design.md` §2 (thin-client frontend), `docs/agent-research.md` §UI-decoupling

## Context

Today the only frontend is a **one-shot CLI** (`src/cli/main.ts`): it reads a single
prompt from `argv`/stdin, runs `runAgent` once, prints the typed event stream to the
terminal, and exits. There is no way to hold a conversation, and HITL approval is a
blocking `prompt()` that denies on non-TTY.

We want an **interactive** frontend: a persistent, multi-turn session the user can talk
to, with visible tool activity, in-line approval, and the ability to interrupt a running
task — without changing what the agent *is*. The design already anticipates this: the
frontend is a **thin client** that only (a) subscribes to the `AgentEvent` stream and
(b) supplies an `approve` callback. The engine is UI-agnostic.

Two forces shape the decision:

1. **Project ethos — from-scratch, minimal dependencies.** The runtime has 3 deps
   (`@anthropic-ai/sdk`, `openai`, `zod`); `EventEmitter` and the MCP client are
   hand-rolled. A frontend that drags in React + Ink would invert that.
2. **What real coding agents actually do.** Claude Code and Codex CLI are, in practice,
   *inline* REPLs — they append to the terminal scrollback with a fixed input area at the
   bottom — not full-screen alt-screen pane layouts. Inline preserves native scrollback,
   copy-paste, and resize for free.

## Decision

### 1. Form: an inline REPL rendered with raw ANSI, zero new dependencies

A persistent read→run→render loop. The event stream is appended to the terminal (as the
one-shot CLI already does), a fixed input line lives at the bottom, and `Ctrl-C`
interrupts the current task rather than killing the process. No alt-screen, no pane
layout, no Ink/React. Line-editing uses Node's built-in `readline`; the approval modal
and interrupt handling use `setRawMode`.

Full-screen panes (which would justify Ink) are explicitly **rejected** for v1: with an
inline model, Ink's flexbox/relayout value mostly evaporates, and the dependency cost
contradicts force (1).

### 2. Multi-turn: seed `history`, record only the delta

`runAgent` currently hardcodes `messages = [userText(userInput)]`, so it cannot continue a
conversation. We extend `RunOptions` with an optional `history?: Message[]` and seed:

```ts
const newUser = userText(userInput);
let messages = [...(opts.history ?? []), newUser];
```

The frontend keeps the returned `result.messages` (post-compaction) as the `history` for
the next turn — so context stays bounded across a long conversation for free.

**Rollout continuation contract (the subtle part).** With seeded history, the old
`record(messages[0])` would re-record the *oldest history message* and never record the
new user input, and `recordMeta` would run every turn. The contract is therefore:

- **One rollout file per conversation.**
- `runAgent` records only the **delta**: the *new* user message (always
  `record(newUser)`, never `messages[0]`), plus the assistant/tool messages produced this
  run (unchanged).
- **Meta is written once**, at session start — i.e. only when this is *not* a continuation
  (`(opts.history?.length ?? 0) === 0`).

This keeps the JSONL a faithful, replayable transcript of the whole conversation.

### 3. Cancellation: cooperative, between-steps, for v1

`runAgent` gains an optional `signal?: AbortSignal`. The loop checks `signal.aborted` at
the top of each step and after tool execution; on abort it stops cleanly and emits a new
`{ type: "cancelled"; step }` event. `Ctrl-C` in the REPL aborts the current run and
returns to the prompt.

**Known limitation, stated on purpose:** `ModelProvider.generate()` returns a whole turn
and `GenerateRequest` has no `signal`, so a model call already **in flight** finishes
before the abort takes effect (a few seconds of lag). Snappy, in-flight interruption
requires threading `AbortSignal` through `GenerateRequest` and all three adapters
(openai / anthropic / azure) — deferred to a follow-up (P-tui-5).

### 4. Rendering rule: render `text`, treat `done` as a terminal marker

The final answer is emitted **twice** by the engine — once as a `text` event
(`emitTurnBlocks`) and again as `done` (same `textOf`). The one-shot CLI avoids
double-printing only by having no `case "text"`, which also means it silently drops the
model's *narration between tool calls*. The TUI wants that narration, so the transcript
reducer **renders `text`** and treats **`done` as an end-of-run marker only** (never a
second thing to print).

### 5. Session-scoped policy; subagent event attribution

- The `PermissionPolicy` (and provider/registry) are **hoisted into a shared bootstrap**
  so an approver "always allow this tool" decision persists across turns of one session.
- Subagent nesting is currently expressed only by *which emitter fired*
  (`events` vs `childEvents`); `AgentEvent` carries no agent id. The transcript reducer
  tags each event by **source** (`main` | `child`) at subscribe time so nested work
  renders indented rather than flat.

## Consequences

**Positive**

- Frontend stays a thin client; the engine remains UI-agnostic and one-shot-compatible.
- All engine changes are **optional, backward-compatible fields** — the existing CLI and
  every test keep working untouched.
- Zero new runtime dependencies; consistent with the from-scratch ethos.
- The pure reducer + approver logic are unit-testable without a terminal, matching the
  project's hermetic-test discipline.

**Negative / accepted trade-offs**

- Ctrl-C is laggy while a model call is in flight (see §3) until the follow-up lands.
- No token-level streaming (providers don't stream yet) — the TUI renders at turn
  granularity: a spinner while the model thinks, then text appears. Streaming is a
  separate, larger effort.
- Raw-ANSI input-mode toggling (readline line-edit ↔ raw single-key for the modal /
  Ctrl-C) is fiddly; it is kept a thin, untested glue layer with logic pushed down into
  the tested reducer/approver.

## Alternatives considered

- **Ink + React full-screen panes.** More "dashboard"-like, gives flexbox layout and
  independent scroll regions. Rejected for v1: heavy deps against the project ethos, and
  the value collapses under the chosen inline model.
- **Per-prompt `runAgent` with no engine change**, reconstructing history from
  `result.messages`. Rejected: `runAgent` hardcodes the seed and the rollout recording,
  so continuation is impossible without the §2 change anyway — and doing it in the
  frontend would silently corrupt the rollout.
- **In-flight cancellation now.** Correct end state, but it touches the provider seam and
  three adapters; sequenced as a follow-up so multi-turn (the actual unlock) ships first.
