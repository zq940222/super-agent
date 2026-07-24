import { test, expect } from "bun:test";
import { OpenAIProvider } from "../src/providers/openai";
import { AzureOpenAIProvider } from "../src/providers/azure";
import { AnthropicProvider } from "../src/providers/anthropic";
import type { Message } from "../src/core/types";
import type { StreamChunk } from "../src/providers/provider";

const userMsg: Message[] = [{ role: "user", content: [{ type: "text", text: "hi" }] }];

async function collect(iter: AsyncIterable<StreamChunk>): Promise<StreamChunk[]> {
  const out: StreamChunk[] = [];
  for await (const c of iter) out.push(c);
  return out;
}
const textDeltas = (chunks: StreamChunk[]): string[] =>
  chunks.filter((c): c is Extract<StreamChunk, { type: "text_delta" }> => c.type === "text_delta").map((c) => c.text);
const doneTurn = (chunks: StreamChunk[]) => {
  const d = chunks.at(-1);
  if (d?.type !== "done") throw new Error("stream did not end with a done chunk");
  return d.turn;
};

/** A fake OpenAI/Azure ChatCompletionStream: async-iterable of chunks + finalChatCompletion. */
function fakeOpenAIStream(deltas: string[], final: unknown, capture: (body: any, opts: any) => void) {
  return (body: unknown, opts: unknown) => {
    capture(body, opts);
    return {
      async *[Symbol.asyncIterator]() {
        for (const d of deltas) yield { choices: [{ delta: { content: d } }] };
      },
      finalChatCompletion: async () => final,
    };
  };
}

// --- OpenAI ---

test("OpenAIProvider.stream yields text deltas then a normalized done turn, forwarding the signal", async () => {
  const provider = new OpenAIProvider({ apiKey: "test" });
  let opts: any;
  let body: any;
  const final = { choices: [{ message: { role: "assistant", content: "hello" }, finish_reason: "stop" }] };
  (provider as any).client.chat.completions.stream = fakeOpenAIStream(["hel", "lo"], final, (b, o) => {
    body = b;
    opts = o;
  });

  const signal = new AbortController().signal;
  const chunks = await collect(provider.stream!({ messages: userMsg, signal }));

  expect(textDeltas(chunks)).toEqual(["hel", "lo"]);
  expect(doneTurn(chunks).message.content).toEqual([{ type: "text", text: "hello" }]);
  expect(doneTurn(chunks).stopReason).toBe("end_turn");
  expect(opts?.signal).toBe(signal);
  expect(body?.stream_options).toEqual({ include_usage: true }); // usage survives streaming
});

test("OpenAIProvider.stream assembles tool calls into the done turn (tools arrive whole)", async () => {
  const provider = new OpenAIProvider({ apiKey: "test" });
  const final = {
    choices: [
      {
        message: {
          role: "assistant",
          content: null,
          tool_calls: [{ id: "t1", type: "function", function: { name: "echo", arguments: '{"value":"x"}' } }],
        },
        finish_reason: "tool_calls",
      },
    ],
  };
  (provider as any).client.chat.completions.stream = fakeOpenAIStream(["thinking"], final, () => {});

  const turn = doneTurn(await collect(provider.stream!({ messages: userMsg })));
  expect(turn.stopReason).toBe("tool_use");
  expect(turn.message.content).toContainEqual({ type: "tool_use", id: "t1", name: "echo", input: { value: "x" } });
});

// --- Azure (same wire shape as OpenAI) ---

test("AzureOpenAIProvider.stream yields deltas + done and forwards the signal", async () => {
  const provider = new AzureOpenAIProvider({
    apiKey: "test",
    endpoint: "https://res.cognitiveservices.azure.com",
    deployment: "dep",
  });
  let opts: any;
  const final = { choices: [{ message: { role: "assistant", content: "ok" }, finish_reason: "stop" }] };
  (provider as any).client.chat.completions.stream = fakeOpenAIStream(["o", "k"], final, (_b, o) => (opts = o));

  const signal = new AbortController().signal;
  const chunks = await collect(provider.stream!({ messages: userMsg, signal }));

  expect(textDeltas(chunks)).toEqual(["o", "k"]);
  expect(doneTurn(chunks).message.content).toEqual([{ type: "text", text: "ok" }]);
  expect(opts?.signal).toBe(signal);
});

// --- Anthropic ---

test("AnthropicProvider.stream yields text deltas then a normalized done turn, forwarding the signal", async () => {
  const provider = new AnthropicProvider({ apiKey: "test" });
  let opts: any;
  const finalMessage = {
    role: "assistant",
    content: [{ type: "text", text: "hello" }],
    stop_reason: "end_turn",
    usage: { input_tokens: 1, output_tokens: 2 },
  };
  (provider as any).client.messages.stream = (_body: unknown, o: unknown) => {
    opts = o;
    return {
      async *[Symbol.asyncIterator]() {
        yield { type: "content_block_delta", index: 0, delta: { type: "text_delta", text: "hel" } };
        yield { type: "content_block_delta", index: 0, delta: { type: "text_delta", text: "lo" } };
      },
      finalMessage: async () => finalMessage,
    };
  };

  const signal = new AbortController().signal;
  const chunks = await collect(provider.stream!({ messages: userMsg, signal }));

  expect(textDeltas(chunks)).toEqual(["hel", "lo"]);
  expect(doneTurn(chunks).message.content).toEqual([{ type: "text", text: "hello" }]);
  expect(doneTurn(chunks).usage).toMatchObject({ inputTokens: 1, outputTokens: 2 });
  expect(opts?.signal).toBe(signal);
});

test("AnthropicProvider.stream ignores non-text delta events (e.g. tool input_json_delta)", async () => {
  const provider = new AnthropicProvider({ apiKey: "test" });
  const finalMessage = {
    role: "assistant",
    content: [{ type: "tool_use", id: "t1", name: "echo", input: { value: "x" } }],
    stop_reason: "tool_use",
    usage: { input_tokens: 0, output_tokens: 0 },
  };
  (provider as any).client.messages.stream = () => ({
    async *[Symbol.asyncIterator]() {
      yield { type: "content_block_delta", index: 0, delta: { type: "text_delta", text: "let me" } };
      yield { type: "content_block_delta", index: 0, delta: { type: "input_json_delta", partial_json: '{"val' } };
    },
    finalMessage: async () => finalMessage,
  });

  const chunks = await collect(provider.stream!({ messages: userMsg }));
  expect(textDeltas(chunks)).toEqual(["let me"]); // the input_json_delta is not surfaced as text
  expect(doneTurn(chunks).stopReason).toBe("tool_use");
});
