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
  /**
   * Cancels the request already in flight. Adapters forward it to the SDK call;
   * on abort the SDK rejects and the engine reports the run as cancelled. This
   * is what makes Ctrl-C snappy — without it, cancellation only lands between
   * steps, after the current model call returns. See ADR-0001 §3.
   */
  signal?: AbortSignal;
}

/**
 * A streamed inference: zero or more incremental chunks followed by a terminal
 * `done` carrying the fully-normalized turn. The adapter accumulates the SDK's
 * stream and assembles the `done.turn` so it is byte-identical to what
 * `generate()` would return — the engine never sees a vendor shape. v1 streams
 * text only; tool_use blocks arrive whole in `done.turn`. See ADR-0002.
 */
export type StreamChunk =
  | { type: "text_delta"; text: string }
  | { type: "done"; turn: AssistantTurn };

export interface ModelProvider {
  readonly name: string;
  /** One inference → one normalized AssistantTurn. */
  generate(req: GenerateRequest): Promise<AssistantTurn>;
  /**
   * Optional token streaming. When present and the caller opts in
   * (`RunOptions.stream`), the engine consumes this instead of `generate`,
   * emitting `text_delta` events as chunks arrive. Must end with a `done` chunk.
   */
  stream?(req: GenerateRequest): AsyncIterable<StreamChunk>;
}
