/**
 * The provider abstraction — the single seam that lets one agent loop drive
 * any backend. The engine depends only on this interface; each backend
 * (OpenAI in P1; Anthropic/local later) implements it and hides two wire-format
 * differences inside the adapter:
 *   1. stop-reason naming  (end_turn/tool_use  vs  stop/tool_calls)
 *   2. tool-result plumbing (a content block  vs  a separate `tool`-role message)
 *
 * See docs/our-agent-design.md §3 and docs/agent-research.md §4.6.
 */

import type { AssistantTurn, Message, ToolSpec } from "../core/types";

export interface GenerateRequest {
  /** Stable prefix — kept first so it can be prompt-cached in later phases. */
  system?: string;
  messages: Message[];
  tools?: ToolSpec[];
  toolChoice?: "auto" | "required" | "none" | { name: string };
  maxTokens?: number;
}

export interface ModelProvider {
  readonly name: string;
  /** One inference → one normalized AssistantTurn. */
  generate(req: GenerateRequest): Promise<AssistantTurn>;
  // stream(req): AsyncIterable<StreamEvent>  — deferred to a later phase.
}
