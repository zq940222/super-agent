import { test, expect } from "bun:test";
import { runAgent } from "../src/core/engine";
import { compact, providerSummarizer } from "../src/core/compaction";
import { ToolRegistry } from "../src/tools/registry";
import { OpenAIProvider } from "../src/providers/openai";
import { AzureOpenAIProvider } from "../src/providers/azure";
import { AnthropicProvider } from "../src/providers/anthropic";
import type { AssistantTurn, Message } from "../src/core/types";
import type { GenerateRequest, ModelProvider } from "../src/providers/provider";

const userMsg: Message[] = [{ role: "user", content: [{ type: "text", text: "hi" }] }];

// --- engine: mid-flight abort is reported as cancelled, not thrown ---

/** Enters generate, signals that it's in flight, then hangs until aborted. */
class HangUntilAbort implements ModelProvider {
  readonly name = "hang";
  seenSignal?: AbortSignal;
  reached: Promise<void>;
  private markReached!: () => void;
  constructor() {
    this.reached = new Promise((r) => (this.markReached = r));
  }
  generate(req: GenerateRequest): Promise<AssistantTurn> {
    this.seenSignal = req.signal;
    this.markReached();
    return new Promise((_resolve, reject) => {
      req.signal?.addEventListener("abort", () => reject(new DOMException("Aborted", "AbortError")));
    });
  }
}

test("a mid-flight abort is forwarded and reported as cancelled, not thrown", async () => {
  const provider = new HangUntilAbort();
  const controller = new AbortController();

  const p = runAgent("go", { provider, registry: new ToolRegistry(), signal: controller.signal });
  await provider.reached; // generate is now in flight (past the between-steps check)
  controller.abort(); // abort while the model call is outstanding

  const res = await p;
  expect(res.stoppedBy).toBe("cancelled");
  expect(res.steps).toBe(0); // aborted during the first turn
  expect(provider.seenSignal).toBe(controller.signal); // the signal reached the provider
});

test("a provider error that isn't an abort still propagates", async () => {
  const provider: ModelProvider = {
    name: "boom",
    async generate() {
      throw new Error("network down");
    },
  };
  const controller = new AbortController(); // present but never aborted
  await expect(
    runAgent("go", { provider, registry: new ToolRegistry(), signal: controller.signal }),
  ).rejects.toThrow("network down");
});

// --- adapters: each forwards req.signal to its SDK call ---

const okOpenAI = { choices: [{ message: { role: "assistant", content: "ok" }, finish_reason: "stop" }] };
const okAnthropic = {
  role: "assistant",
  content: [{ type: "text", text: "ok" }],
  stop_reason: "end_turn",
  usage: { input_tokens: 0, output_tokens: 0 },
};

test("OpenAIProvider forwards the abort signal to the SDK call", async () => {
  const provider = new OpenAIProvider({ apiKey: "test" });
  let opts: any;
  (provider as any).client.chat.completions.create = async (_body: unknown, o: any) => {
    opts = o;
    return okOpenAI;
  };
  const signal = new AbortController().signal;
  await provider.generate({ messages: userMsg, signal });
  expect(opts?.signal).toBe(signal);
});

test("AzureOpenAIProvider forwards the abort signal to the SDK call", async () => {
  const provider = new AzureOpenAIProvider({
    apiKey: "test",
    endpoint: "https://res.cognitiveservices.azure.com",
    deployment: "dep",
  });
  let opts: any;
  (provider as any).client.chat.completions.create = async (_body: unknown, o: any) => {
    opts = o;
    return okOpenAI;
  };
  const signal = new AbortController().signal;
  await provider.generate({ messages: userMsg, signal });
  expect(opts?.signal).toBe(signal);
});

test("AnthropicProvider forwards the abort signal to the SDK call", async () => {
  const provider = new AnthropicProvider({ apiKey: "test" });
  let opts: any;
  (provider as any).client.messages.create = async (_body: unknown, o: any) => {
    opts = o;
    return okAnthropic;
  };
  const signal = new AbortController().signal;
  await provider.generate({ messages: userMsg, signal });
  expect(opts?.signal).toBe(signal);
});

// --- compaction's own model call is interruptible too ---

test("compact forwards the signal to the summarizer", async () => {
  const many: Message[] = Array.from({ length: 12 }, (_, i) => ({
    role: i % 2 === 0 ? "user" : "assistant",
    content: [{ type: "text", text: `msg ${i}` }],
  }));
  const signal = new AbortController().signal;
  let seen: AbortSignal | undefined;
  await compact(many, async (_msgs, s) => {
    seen = s;
    return "summary";
  }, { keepRecent: 2, signal });
  expect(seen).toBe(signal);
});

test("providerSummarizer forwards the signal to provider.generate", async () => {
  let seen: AbortSignal | undefined;
  const provider: ModelProvider = {
    name: "cap",
    async generate(req) {
      seen = req.signal;
      return { message: { role: "assistant", content: [{ type: "text", text: "s" }] }, stopReason: "end_turn", usage: { inputTokens: 0, outputTokens: 0 } };
    },
  };
  const signal = new AbortController().signal;
  await providerSummarizer(provider)([{ role: "user", content: [{ type: "text", text: "x" }] }], signal);
  expect(seen).toBe(signal);
});
