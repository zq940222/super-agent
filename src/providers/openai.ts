/**
 * OpenAI adapter (chat_completions wire format).
 *
 * The two wire-format normalizations live here as PURE functions so they can
 * be unit-tested against static fixtures with no network:
 *   - toOpenAIMessages / toOpenAITools : our types  → OpenAI request shape
 *   - fromOpenAIResponse                : OpenAI response → normalized AssistantTurn
 *
 * Local structural types describe the OpenAI shapes so the normalizers (and
 * their tests) don't couple to the SDK's own types. See docs/agent-research.md §4.6.
 */

import OpenAI from "openai";
import type {
  AssistantTurn,
  ContentBlock,
  Message,
  StopReason,
  TextBlock,
  ToolResultBlock,
  ToolSpec,
  ToolUseBlock,
} from "../core/types";
import type { GenerateRequest, ModelProvider, StreamChunk } from "./provider";

// --- structural types for the OpenAI chat-completions wire shape ---

interface OAITextMessage {
  role: "system" | "user";
  content: string;
}
interface OAIToolCall {
  id: string;
  type: "function";
  function: { name: string; arguments: string };
}
interface OAIAssistantMessage {
  role: "assistant";
  content: string | null;
  tool_calls?: OAIToolCall[];
}
interface OAIToolMessage {
  role: "tool";
  tool_call_id: string;
  content: string;
}
export type OAIRequestMessage = OAITextMessage | OAIAssistantMessage | OAIToolMessage;

export interface OAITool {
  type: "function";
  function: { name: string; description: string; parameters: Record<string, unknown> };
}

export type OAIToolChoice =
  | "auto"
  | "required"
  | "none"
  | { type: "function"; function: { name: string } };

export interface OAIResponse {
  choices: Array<{
    message: { role: "assistant"; content: string | null; tool_calls?: OAIToolCall[] };
    finish_reason: string | null;
  }>;
  usage?: {
    prompt_tokens?: number;
    completion_tokens?: number;
    prompt_tokens_details?: { cached_tokens?: number };
  };
}

// --- pure normalizers ---

export function mapFinishReason(finishReason: string | null): StopReason {
  switch (finishReason) {
    case "tool_calls":
      return "tool_use";
    case "length":
      return "max_tokens";
    case "content_filter":
      return "stop_sequence";
    default:
      return "end_turn";
  }
}

function parseToolArguments(raw: string): unknown {
  if (!raw || raw.trim() === "") return {};
  try {
    return JSON.parse(raw);
  } catch {
    // Malformed JSON from the model: surface it rather than throwing, so the
    // tool's validator can reject it and the model can recover.
    return { _unparsed_arguments: raw };
  }
}

export function fromOpenAIResponse(resp: OAIResponse): AssistantTurn {
  const choice = resp.choices[0];
  if (!choice) throw new Error("OpenAI response contained no choices");

  const content: ContentBlock[] = [];
  if (choice.message.content) {
    content.push({ type: "text", text: choice.message.content });
  }
  const toolCalls = choice.message.tool_calls ?? [];
  for (const tc of toolCalls) {
    content.push({
      type: "tool_use",
      id: tc.id,
      name: tc.function.name,
      input: parseToolArguments(tc.function.arguments),
    });
  }

  // If the model asked for tools, that's the stop reason regardless of what
  // finish_reason claims — the presence of tool_use blocks is authoritative.
  const stopReason: StopReason =
    toolCalls.length > 0 ? "tool_use" : mapFinishReason(choice.finish_reason);

  return {
    message: { role: "assistant", content },
    stopReason,
    usage: {
      inputTokens: resp.usage?.prompt_tokens ?? 0,
      outputTokens: resp.usage?.completion_tokens ?? 0,
      cacheReadTokens: resp.usage?.prompt_tokens_details?.cached_tokens,
    },
  };
}

export function toOpenAITools(tools?: ToolSpec[]): OAITool[] | undefined {
  if (!tools || tools.length === 0) return undefined;
  return tools.map((t) => ({
    type: "function",
    function: { name: t.name, description: t.description, parameters: t.inputSchema },
  }));
}

export function toToolChoice(
  choice: GenerateRequest["toolChoice"],
): OAIToolChoice | undefined {
  if (choice === undefined) return undefined;
  if (typeof choice === "string") return choice;
  return { type: "function", function: { name: choice.name } };
}

/**
 * Flatten our messages into OpenAI's array. The key normalization: our
 * `tool_result` blocks (which we carry inside a user message) become separate
 * `tool`-role messages, and our assistant `tool_use` blocks become an assistant
 * message with `tool_calls`.
 */
export function toOpenAIMessages(messages: Message[], system?: string): OAIRequestMessage[] {
  const out: OAIRequestMessage[] = [];
  if (system) out.push({ role: "system", content: system });

  for (const msg of messages) {
    const text = msg.content
      .filter((b): b is TextBlock => b.type === "text")
      .map((b) => b.text)
      .join("");

    if (msg.role === "assistant") {
      const toolUses = msg.content.filter((b): b is ToolUseBlock => b.type === "tool_use");
      const assistant: OAIAssistantMessage = { role: "assistant", content: text || null };
      if (toolUses.length > 0) {
        assistant.tool_calls = toolUses.map((u) => ({
          id: u.id,
          type: "function",
          function: { name: u.name, arguments: JSON.stringify(u.input ?? {}) },
        }));
      }
      out.push(assistant);
      continue;
    }

    // user / system-in-history: tool results become tool-role messages first,
    // then any plain text as a user message.
    const toolResults = msg.content.filter((b): b is ToolResultBlock => b.type === "tool_result");
    for (const tr of toolResults) {
      out.push({ role: "tool", tool_call_id: tr.toolUseId, content: tr.content });
    }
    if (text) {
      out.push({ role: msg.role === "system" ? "system" : "user", content: text });
    }
  }

  return out;
}

// --- the provider ---

export interface OpenAIProviderOptions {
  apiKey?: string;
  model?: string;
  baseURL?: string;
}

export class OpenAIProvider implements ModelProvider {
  readonly name = "openai";
  private client: OpenAI;
  private model: string;

  constructor(opts: OpenAIProviderOptions = {}) {
    const apiKey = opts.apiKey ?? process.env.OPENAI_API_KEY;
    if (!apiKey) {
      throw new Error(
        "OPENAI_API_KEY is not set. Add it to your environment or a .env file (see .env.example).",
      );
    }
    this.client = new OpenAI({
      apiKey,
      baseURL: opts.baseURL ?? process.env.OPENAI_BASE_URL,
    });
    this.model = opts.model ?? process.env.OPENAI_MODEL ?? "gpt-4o-mini";
  }

  /** Shared request body for both generate and stream — so they can't drift. */
  private buildParams(req: GenerateRequest): Record<string, unknown> {
    const params: Record<string, unknown> = {
      model: this.model,
      messages: toOpenAIMessages(req.messages, req.system),
    };
    const tools = toOpenAITools(req.tools);
    if (tools) {
      params.tools = tools;
      params.tool_choice = toToolChoice(req.toolChoice) ?? "auto";
    }
    if (req.maxTokens) params.max_completion_tokens = req.maxTokens;
    return params;
  }

  async generate(req: GenerateRequest): Promise<AssistantTurn> {
    // Single cast at the SDK boundary; our structural types match the wire shape.
    const resp = await this.client.chat.completions.create(this.buildParams(req) as any, { signal: req.signal });
    return fromOpenAIResponse(resp as unknown as OAIResponse);
  }

  async *stream(req: GenerateRequest): AsyncIterable<StreamChunk> {
    // The SDK's stream() runner reassembles tool_calls into a final ChatCompletion,
    // so we reuse the same normalizer as generate() for `done`. `include_usage`
    // (streaming-only — invalid on a non-streaming create) makes token usage
    // survive streaming, so the `done` turn matches generate().
    const body = { ...this.buildParams(req), stream_options: { include_usage: true } };
    const stream = this.client.chat.completions.stream(body as any, { signal: req.signal });
    for await (const chunk of stream) {
      const delta = chunk.choices[0]?.delta?.content;
      if (delta) yield { type: "text_delta", text: delta };
    }
    const completion = await stream.finalChatCompletion();
    yield { type: "done", turn: fromOpenAIResponse(completion as unknown as OAIResponse) };
  }
}
