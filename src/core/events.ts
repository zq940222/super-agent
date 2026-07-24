/**
 * Typed event stream. The driver emits these; front-ends (CLI, future TUI/API)
 * and logs subscribe. This decouples observation of a run from provider
 * internals — a core pattern from Codex (SQ/EQ) and OpenClaw (event streams).
 *
 * See docs/our-agent-design.md §3 (event model).
 */

export type AgentEvent =
  | { type: "turn_start"; step: number }
  | { type: "text"; text: string }
  | { type: "thinking"; text: string }
  | { type: "tool_call"; id: string; name: string; input: unknown }
  | { type: "tool_result"; toolUseId: string; name: string; content: string; isError: boolean }
  | { type: "permission_request"; name: string; input: unknown; risk: string }
  | { type: "permission_decision"; name: string; decision: "allow" | "deny" }
  | { type: "step_complete"; step: number; stopReason: string }
  | { type: "compaction"; beforeTokens: number; afterTokens: number }
  | { type: "done"; text: string; steps: number }
  | { type: "error"; message: string };

export type EventHandler = (event: AgentEvent) => void;

/** Minimal synchronous fan-out emitter — no external dependency needed. */
export class EventEmitter {
  private handlers: EventHandler[] = [];

  on(handler: EventHandler): this {
    this.handlers.push(handler);
    return this;
  }

  emit(event: AgentEvent): void {
    for (const handler of this.handlers) handler(event);
  }
}
