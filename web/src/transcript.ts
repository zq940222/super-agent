import type { AgentEvent } from "./events";

/** A rendered item in the chat log. Pure data — the component maps it to DOM. */
export type Item =
  | { kind: "user"; text: string }
  | { kind: "assistant"; text: string }
  | { kind: "tool"; id: string; name: string; input: unknown; status: "pending" | "ok" | "error"; result?: string }
  | { kind: "notice"; text: string };

/**
 * Fold one agent event into the chat log. Pure (so it's unit-testable without a
 * browser). Streamed text (`text_delta`) and whole text (`text`, the
 * non-streaming fallback) both append to the current assistant bubble; `done` is
 * a terminal marker that adds nothing (the text already arrived) — the same
 * dedup rule the TUI uses (ADR-0002 §4). A `tool_call` starts a fresh bubble
 * boundary, so narration before and after a tool renders as separate bubbles.
 */
export function applyEvent(items: Item[], ev: AgentEvent): Item[] {
  switch (ev.type) {
    case "text_delta":
    case "text": {
      if (!ev.text) return items;
      const last = items[items.length - 1];
      if (last?.kind === "assistant") {
        return [...items.slice(0, -1), { kind: "assistant", text: last.text + ev.text }];
      }
      return [...items, { kind: "assistant", text: ev.text }];
    }
    case "tool_call":
      return [...items, { kind: "tool", id: ev.id, name: ev.name, input: ev.input, status: "pending" }];
    case "tool_result":
      return items.map((it) =>
        it.kind === "tool" && it.id === ev.toolUseId
          ? { ...it, status: ev.isError ? "error" : "ok", result: ev.content }
          : it,
      );
    case "compaction":
      return [...items, { kind: "notice", text: `compacted context ${ev.beforeTokens}→${ev.afterTokens} tokens` }];
    case "cancelled":
      return [...items, { kind: "notice", text: "⏹ cancelled" }];
    case "error":
      return [...items, { kind: "notice", text: `error: ${ev.message}` }];
    // turn_start / step_complete / thinking / permission_request / permission_decision / done
    default:
      return items;
  }
}
