/**
 * Event → terminal lines (P-tui-3).
 *
 * `renderEvent` maps ONE `AgentEvent` to the line(s) to append to the terminal,
 * in event order. It is pure and *prefix-stable*: it only ever describes new
 * output and never rewrites an earlier line, so an inline REPL can print
 * `reduce`'s buffer incrementally (see transcript.ts). This is why rendering is
 * per-event rather than model→lines: when two tools in one turn resolve out of
 * order, a whole-model render would reorder already-printed lines.
 *
 * Two deliberate choices (ADR-0001 §4):
 *  - `done` yields no line — the final answer already arrived as a `text` event,
 *    so rendering `done` too would print it twice. The cost is that the final
 *    answer renders as a normal assistant line (no bold): a `text` event can't
 *    be told apart from mid-turn narration, and only `done` knew it was final.
 *  - Subagent (`child`) output is indented; crucially its answer now flows
 *    through the child's `text` event (rendered here), not its `done`.
 *
 * Glyph vocabulary matches the original CLI so the look is familiar.
 */

import type { AgentEvent } from "../core/events";

export type Source = "main" | "child";

const DIM = "\x1b[2m";
const RESET = "\x1b[0m";
const CHILD_INDENT = "    ";

function preview(text: string, n = 80): string {
  const firstLine = text.split("\n")[0] ?? "";
  return firstLine.length > n ? firstLine.slice(0, n) + "…" : firstLine;
}

/** Prefix every line of `text` (handles multi-line assistant answers). */
function indentAll(text: string, indent: string): string {
  if (!indent) return text;
  return text
    .split("\n")
    .map((line) => indent + line)
    .join("\n");
}

/** Dim scaffolding line (tool calls, results, diagnostics). */
function dim(indent: string, body: string): string {
  return `${indent}${DIM}${body}${RESET}`;
}

/**
 * The line(s) an event contributes, or `[]` for events that add nothing to the
 * transcript (`done`, `turn_start`, `step_complete`, `thinking`, empty text).
 */
export function renderEvent(event: AgentEvent, source: Source = "main"): string[] {
  const indent = source === "child" ? CHILD_INDENT : "";
  switch (event.type) {
    case "text": {
      const text = event.text.trim();
      // Assistant prose is the only non-dim content, so it stands out on its own.
      return text ? [indentAll(text, indent)] : [];
    }
    case "tool_call":
      return [dim(indent, `  🔧 ${event.name}(${preview(JSON.stringify(event.input))})`)];
    case "tool_result":
      return [dim(indent, `  ${event.isError ? "✗" : "↳"} ${preview(event.content)}`)];
    case "permission_decision":
      return [dim(indent, `  🔐 ${event.name} → ${event.decision}`)];
    case "compaction":
      return [dim(indent, `  ♻ compacted context ${event.beforeTokens}→${event.afterTokens} tokens`)];
    case "cancelled":
      return [dim(indent, `  ⏹ cancelled`)];
    case "error":
      return [dim(indent, `(${event.message})`)];
    // Structural / not shown in the transcript.
    case "turn_start":
    case "step_complete":
    case "thinking":
    case "permission_request":
    case "done":
      return [];
  }
}

/** The user's own prompt, echoed into the transcript (not an agent event). */
export function renderUser(text: string): string {
  return `› ${text}`;
}
