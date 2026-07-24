/**
 * Anthropic adapter (Messages API / `anthropic_messages` wire format).
 *
 * This is the payoff of the provider abstraction: the SAME `runAgent` loop now
 * drives Anthropic with zero engine changes. Our internal model was designed
 * after Anthropic's, so the mapping is nearly 1:1 — the interesting differences
 * are: `system` is a top-level param (not a message), field names are snake_case
 * (`tool_use_id`, `is_error`, `input_schema`), and `max_tokens` is REQUIRED.
 *
 * Pure normalizers are exported for offline fixture tests. See issue #5.
 */

import Anthropic from "@anthropic-ai/sdk";
import type {
  AssistantTurn,
  ContentBlock,
  Message,
  StopReason,
  ToolSpec,
} from "../core/types";
import type { GenerateRequest, ModelProvider } from "./provider";

// --- structural types for the Anthropic wire shape ---

interface AnthTextBlock {
  type: "text";
  text: string;
}
interface AnthToolUseBlock {
  type: "tool_use";
  id: string;
  name: string;
  input: unknown;
}
interface AnthToolResultBlock {
  type: "tool_result";
  tool_use_id: string;
  content: string;
  is_error?: boolean;
}
export type AnthContentBlock = AnthTextBlock | AnthToolUseBlock | AnthToolResultBlock;

export interface AnthMessage {
  role: "user" | "assistant";
  content: AnthContentBlock[];
}

export interface AnthTool {
  name: string;
  description: string;
  input_schema: Record<string, unknown>;
}

export type AnthToolChoice =
  | { type: "auto" }
  | { type: "any" }
  | { type: "tool"; name: string };

export interface AnthResponse {
  role: "assistant";
  content: Array<{ type: string; text?: string; id?: string; name?: string; input?: unknown }>;
  stop_reason: string | null;
  usage?: { input_tokens?: number; output_tokens?: number; cache_read_input_tokens?: number };
}

// --- pure normalizers ---

export function mapAnthropicStopReason(reason: string | null): StopReason {
  switch (reason) {
    case "tool_use":
      return "tool_use";
    case "max_tokens":
      return "max_tokens";
    case "stop_sequence":
      return "stop_sequence";
    default:
      return "end_turn";
  }
}

export function fromAnthropicResponse(resp: AnthResponse): AssistantTurn {
  const content: ContentBlock[] = [];
  let hasToolUse = false;

  for (const block of resp.content) {
    if (block.type === "text" && typeof block.text === "string") {
      content.push({ type: "text", text: block.text });
    } else if (block.type === "tool_use") {
      hasToolUse = true;
      content.push({
        type: "tool_use",
        id: block.id ?? "",
        name: block.name ?? "",
        input: block.input ?? {},
      });
    }
    // other block kinds (e.g. "thinking") are ignored in P6
  }

  const stopReason: StopReason = hasToolUse ? "tool_use" : mapAnthropicStopReason(resp.stop_reason);

  return {
    message: { role: "assistant", content },
    stopReason,
    usage: {
      inputTokens: resp.usage?.input_tokens ?? 0,
      outputTokens: resp.usage?.output_tokens ?? 0,
      cacheReadTokens: resp.usage?.cache_read_input_tokens,
    },
  };
}

function toAnthBlocks(block: ContentBlock): AnthContentBlock[] {
  switch (block.type) {
    case "text":
      return block.text ? [{ type: "text", text: block.text }] : [];
    case "tool_use":
      return [{ type: "tool_use", id: block.id, name: block.name, input: block.input }];
    case "tool_result":
      return [
        { type: "tool_result", tool_use_id: block.toolUseId, content: block.content, is_error: block.isError },
      ];
    case "thinking":
      return []; // not replayed to the model in P6
  }
}

/** System is carried separately (top-level param), so it's filtered out here. */
export function toAnthropicMessages(messages: Message[]): AnthMessage[] {
  return messages
    .filter((m) => m.role !== "system")
    .map((m) => ({
      role: m.role === "assistant" ? "assistant" : "user",
      content: m.content.flatMap(toAnthBlocks),
    }));
}

export function toAnthropicTools(tools?: ToolSpec[]): AnthTool[] | undefined {
  if (!tools || tools.length === 0) return undefined;
  return tools.map((t) => ({ name: t.name, description: t.description, input_schema: t.inputSchema }));
}

export function toAnthropicToolChoice(
  choice: GenerateRequest["toolChoice"],
): AnthToolChoice | undefined {
  if (!choice || choice === "none") return undefined;
  if (choice === "auto") return { type: "auto" };
  if (choice === "required") return { type: "any" };
  return { type: "tool", name: choice.name };
}

// --- the provider ---

export interface AnthropicProviderOptions {
  apiKey?: string;
  model?: string;
  baseURL?: string;
  /** Anthropic requires max_tokens; used when a request omits maxTokens. */
  maxTokens?: number;
}

export class AnthropicProvider implements ModelProvider {
  readonly name = "anthropic";
  private client: Anthropic;
  private model: string;
  private defaultMaxTokens: number;

  constructor(opts: AnthropicProviderOptions = {}) {
    const apiKey = opts.apiKey ?? process.env.ANTHROPIC_API_KEY;
    if (!apiKey) {
      throw new Error(
        "ANTHROPIC_API_KEY is not set. Add it to your environment or a .env file (see .env.example).",
      );
    }
    this.client = new Anthropic({
      apiKey,
      baseURL: opts.baseURL ?? process.env.ANTHROPIC_BASE_URL,
    });
    this.model = opts.model ?? process.env.ANTHROPIC_MODEL ?? "claude-sonnet-5";
    this.defaultMaxTokens = opts.maxTokens ?? 4096;
  }

  async generate(req: GenerateRequest): Promise<AssistantTurn> {
    const params: Record<string, unknown> = {
      model: this.model,
      max_tokens: req.maxTokens ?? this.defaultMaxTokens,
      messages: toAnthropicMessages(req.messages),
    };
    if (req.system) params.system = req.system;
    const tools = toAnthropicTools(req.tools);
    if (tools) {
      params.tools = tools;
      const choice = toAnthropicToolChoice(req.toolChoice);
      if (choice) params.tool_choice = choice;
    }

    // Single cast at the SDK boundary; our structural types match the wire shape.
    const resp = await this.client.messages.create(params as any, { signal: req.signal });
    return fromAnthropicResponse(resp as unknown as AnthResponse);
  }
}
