# ADR 0002 — Token streaming: an opt-in provider seam, rendered volatile in the TUI

- **Status:** Accepted
- **Date:** 2026-07-25
- **Deciders:** @zq940222
- **Related:** [P12 — #29](https://github.com/zq940222/super-agent/issues/29), [ADR-0001](0001-interactive-tui-frontend.md) (the TUI this streams into), `docs/agent-research.md` §4.6

## Context

`ModelProvider` exposes only `generate(req): Promise<AssistantTurn>` — one request, one
whole turn. The TUI (ADR-0001) therefore renders at **turn granularity**: a wait while the
model thinks, then the full answer appears at once. Both SDKs we use (`openai`,
`@anthropic-ai/sdk`) support server-sent token streaming; surfacing it makes the TUI feel
live.

The hard part isn't the wire protocol — it's that streaming **breaks the invariant P-tui-3
was built on**. The transcript renderer is *prefix-stable and append-only*: every event maps
to whole line(s) that are never rewritten, so the frontend prints `buffer.slice(prevLen)`.
Token deltas are inherently *sub-line* — they mutate the current line as they arrive. Naively
routing deltas through the line buffer would either reprint or reorder committed output.

## Decision

### 1. Streaming is an explicit opt-in — `RunOptions.stream?: boolean` — main-loop only

The engine streams a turn only when `opts.stream === true` **and** `provider.stream` exists;
otherwise it uses `generate()` exactly as today. `stream` mirrors the optional, backward-
compatible shape of `history`/`signal`.

Crucially, **subagents do not stream.** The TUI sets `stream: true` for the main loop; the
`spawn_agent` tool does not set it, so children fall back to `generate()` and their answers
arrive whole and *indented*, as today. This is deliberate: child text is rendered with a
4-space indent, which cannot be applied cleanly to sub-line delta fragments (the first
fragment of a line needs the indent, mid-line fragments don't, an embedded newline needs
re-indent). Scoping streaming to the un-indented main loop sidesteps that entirely.

### 2. Seam: `stream?(req): AsyncIterable<StreamChunk>`, terminal `done` carries the turn

```ts
type StreamChunk =
  | { type: "text_delta"; text: string }
  | { type: "done"; turn: AssistantTurn };

interface ModelProvider {
  generate(req): Promise<AssistantTurn>;
  stream?(req): AsyncIterable<StreamChunk>;   // optional
}
```

The adapter still owns normalization: it accumulates the SDK's stream and yields the final,
fully-normalized `AssistantTurn` in the terminal `done` chunk. The engine never sees a
vendor shape, and the assembled turn is byte-identical to what `generate()` would return —
so message history, rollout, and tool extraction are unchanged. `signal` is forwarded into
`stream` too (in-flight abort, per ADR-0001 §3).

### 3. v1 streams text only; tool calls arrive whole in the `done` turn

Only `text_delta` is streamed — the visible prose. `tool_use` blocks are assembled and
delivered in the terminal `done` turn (no partial-JSON tool-argument streaming). Tools thus
*appear when complete*, which is the right UX anyway and avoids a large complexity tax for v1.

### 4. Invariant: the engine still emits `done` with the full text in streaming mode

This is the single fact that keeps every non-delta consumer working untouched. In streaming
mode the engine emits `text_delta` events during the turn **and still emits the terminal
`done` event with the complete text** (and `step_complete`, tool events, etc. — unchanged).
The one-shot CLI has a `done` case (bold) and no `text_delta` case, so it ignores the deltas
and prints the final answer on `done`, exactly as today. **No CLI changes; no changes to any
non-TUI consumer.** Streaming is purely a TUI-render concern.

The engine's two paths must produce **identical post-turn state** — push `turn.message`,
record to the rollout, emit `tool_use` blocks. The *only* difference is text emission:
streaming emits `text_delta`s and skips the whole `text` block (the deltas covered it);
non-streaming emits the whole `text` via `emitTurnBlocks`. The shared tail is factored so the
two paths can't drift on rollout behavior.

The **compaction summarizer stays on `generate()`** — it's an internal, non-user-facing model
call; there's nothing to render.

### 5. Renderer: keep the committed buffer; add one volatile `pending` string

The P-tui-3 committed buffer stays exactly as-is (whole lines, prefix-stable). Streaming adds
a single volatile `pending` string alongside it, in the session printer:

- **`text_delta`** → append to `pending` and write the delta through the **same injected
  `write` sink** app.ts already uses (not `process.stdout` directly).
- **Before rendering any non-delta event** (tool_call, permission, step_complete, done, …),
  **and on turn end, and on `cancelled`:** if `pending` is non-empty, write a newline and
  **commit `pending` as one buffer line, then clear it** — *then* render the event.

**The load-bearing invariant: flush-and-commit `pending` before any whole-line event.** It is
the whole correctness argument, the streaming analogue of ADR-0001 §4's done/text dedup.
Routing delta writes through the injected sink (not stdout) is what keeps the P-tui-4
integration test hermetic: a fake streaming provider + a capturing sink asserts
"deltas in order → newline → committed line → tool_call line" with no terminal.

## Consequences

**Positive**
- Live token output in the TUI; the engine and all other frontends are untouched (opt-in +
  the `done`-still-fires invariant).
- The seam is additive and backward-compatible; a provider without `stream` just uses
  `generate()`.
- The committed transcript stays prefix-stable; only one volatile string is added, and its
  commit rule is a single testable invariant.

**Negative / accepted trade-offs**
- Tool-call arguments aren't streamed (tools appear whole). Fine for v1.
- Subagent output isn't streamed (arrives whole, indented). Deliberate — avoids sub-line
  indentation.
- The renderer now has a volatile path; the flush-before-whole-line rule must hold or output
  interleaves wrong — hence it's an explicit, tested invariant.

## Alternatives considered

- **Automatic streaming whenever `provider.stream` exists.** Rejected: it would stream
  subagents too, forcing sub-line indentation. Opt-in is one field and draws a clean scope line.
- **Stream tool-call argument deltas too.** Rejected for v1: partial-JSON reassembly and
  richer events for little UX gain; tools appearing when complete is preferable.
- **`stream()` returns the turn (async-generator return value).** Rejected: a generator's
  return value is awkward to consume; a terminal `done` chunk in the iterated union is
  uniform and easy to test.
- **Fold deltas into the pure `reduce` buffer.** Rejected: it re-introduces sub-line mutation
  into a prefix-stable structure. A separate volatile `pending` keeps the buffer clean.
