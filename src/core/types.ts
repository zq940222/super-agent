/**
 * Core data model — provider-neutral.
 *
 * Adopts the "role + ordered content blocks" shape (from Anthropic's Messages
 * model) because it cleanly supersets OpenAI's chat format: assistant text,
 * tool calls, and tool results are all representable in one uniform structure.
 * Every provider adapter normalizes its wire format into these types, so the
 * engine never sees a vendor-specific shape.
 *
 * See docs/our-agent-design.md §3.
 */

export type Role = "system" | "user" | "assistant";

/** Plain assistant/user text. */
export interface TextBlock {
  type: "text";
  text: string;
}

/** Model reasoning, kept separate from the answer. Declared for later phases. */
export interface ThinkingBlock {
  type: "thinking";
  text: string;
}

/** The model's request to call a tool. `id` links it to its result. */
export interface ToolUseBlock {
  type: "tool_use";
  id: string;
  name: string;
  input: unknown;
}

/** The result of executing a tool, keyed back to the `tool_use` that asked. */
export interface ToolResultBlock {
  type: "tool_result";
  toolUseId: string;
  content: string;
  isError?: boolean;
}

export type ContentBlock = TextBlock | ThinkingBlock | ToolUseBlock | ToolResultBlock;

export interface Message {
  role: Role;
  content: ContentBlock[];
}

/**
 * Why the model stopped. The adapter maps every backend's stop signal into
 * this union, so the driver can branch on it portably.
 */
export type StopReason = "end_turn" | "tool_use" | "max_tokens" | "stop_sequence";

export interface TokenUsage {
  inputTokens: number;
  outputTokens: number;
  /** Prompt tokens served from cache, when the backend reports it. */
  cacheReadTokens?: number;
}

/** One normalized model inference (one request → one assistant message). */
export interface AssistantTurn {
  message: Message;
  stopReason: StopReason;
  usage: TokenUsage;
}

/**
 * A tool as described to the model: name + natural-language description + a
 * JSON Schema for its input. The description IS prompt engineering — the model
 * routes on it. This exact shape can be handed to any backend and is also what
 * an MCP `tools/list` returns, so native and MCP tools register identically.
 */
export interface ToolSpec {
  name: string;
  description: string;
  inputSchema: Record<string, unknown>;
}

// --- small constructors, to keep call sites readable ---

export function userText(text: string): Message {
  return { role: "user", content: [{ type: "text", text }] };
}

export function toolResults(results: ToolResultBlock[]): Message {
  return { role: "user", content: results };
}

/** Concatenate all text blocks of a message (ignores tool blocks/thinking). */
export function textOf(message: Message): string {
  return message.content
    .filter((b): b is TextBlock => b.type === "text")
    .map((b) => b.text)
    .join("");
}

export function toolUsesOf(message: Message): ToolUseBlock[] {
  return message.content.filter((b): b is ToolUseBlock => b.type === "tool_use");
}
