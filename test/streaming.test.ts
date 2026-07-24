import { test, expect } from "bun:test";
import { z } from "zod";
import { runAgent } from "../src/core/engine";
import { EventEmitter, type AgentEvent } from "../src/core/events";
import { ToolRegistry, defineTool } from "../src/tools/registry";
import type { AssistantTurn } from "../src/core/types";
import type { ModelProvider, StreamChunk } from "../src/providers/provider";

const usage = { inputTokens: 0, outputTokens: 0 };
const endTurn = (text: string): AssistantTurn => ({
  message: { role: "assistant", content: [{ type: "text", text }] },
  stopReason: "end_turn",
  usage,
});

const echoTool = defineTool({
  name: "echo",
  description: "Echo back the given value.",
  schema: z.object({ value: z.string() }),
  handler: ({ value }) => `echoed: ${value}`,
});

function collect(): { events: EventEmitter; seen: AgentEvent[] } {
  const seen: AgentEvent[] = [];
  return { events: new EventEmitter().on((e) => seen.push(e)), seen };
}
const deltas = (seen: AgentEvent[]): string[] =>
  seen.filter((e): e is Extract<AgentEvent, { type: "text_delta" }> => e.type === "text_delta").map((e) => e.text);

test("a streamed turn emits text deltas in order, no whole `text`, but `done` still has full text", async () => {
  const turn = endTurn("hello world");
  const provider: ModelProvider = {
    name: "s",
    async generate() {
      return turn;
    },
    async *stream(): AsyncIterable<StreamChunk> {
      yield { type: "text_delta", text: "hello " };
      yield { type: "text_delta", text: "world" };
      yield { type: "done", turn };
    },
  };
  const { events, seen } = collect();

  const res = await runAgent("hi", { provider, registry: new ToolRegistry(), stream: true, events });

  expect(deltas(seen)).toEqual(["hello ", "world"]);
  expect(seen.some((e) => e.type === "text")).toBe(false); // deltas covered it — no double render
  expect(seen.find((e) => e.type === "done")).toMatchObject({ type: "done", text: "hello world" });
  expect(res.text).toBe("hello world");
});

test("without opting in, the engine uses generate() and emits a whole `text` (no deltas)", async () => {
  let genCalled = false;
  let streamCalled = false;
  const provider: ModelProvider = {
    name: "s",
    async generate() {
      genCalled = true;
      return endTurn("whole");
    },
    async *stream(): AsyncIterable<StreamChunk> {
      streamCalled = true;
      yield { type: "done", turn: endTurn("whole") };
    },
  };
  const { events, seen } = collect();

  await runAgent("hi", { provider, registry: new ToolRegistry(), events }); // no stream: true

  expect(genCalled).toBe(true);
  expect(streamCalled).toBe(false);
  expect(deltas(seen)).toEqual([]);
  expect(seen.some((e) => e.type === "text")).toBe(true);
});

test("opting in with a provider that has no stream() falls back to generate()", async () => {
  const provider: ModelProvider = {
    name: "s",
    async generate() {
      return endTurn("fallback");
    },
    // no stream method
  };
  const { events, seen } = collect();

  const res = await runAgent("hi", { provider, registry: new ToolRegistry(), stream: true, events });

  expect(res.text).toBe("fallback");
  expect(deltas(seen)).toEqual([]);
  expect(seen.some((e) => e.type === "text")).toBe(true);
});

test("a streamed tool-using turn still emits tool_use and executes it", async () => {
  const toolTurn: AssistantTurn = {
    message: {
      role: "assistant",
      content: [
        { type: "text", text: "let me check" },
        { type: "tool_use", id: "t1", name: "echo", input: { value: "x" } },
      ],
    },
    stopReason: "tool_use",
    usage,
  };
  const finalTurn = endTurn("done: x");
  let call = 0;
  const provider: ModelProvider = {
    name: "s",
    async generate() {
      return finalTurn;
    },
    async *stream(): AsyncIterable<StreamChunk> {
      if (call++ === 0) {
        yield { type: "text_delta", text: "let me check" };
        yield { type: "done", turn: toolTurn };
      } else {
        yield { type: "text_delta", text: "done: x" };
        yield { type: "done", turn: finalTurn };
      }
    },
  };
  const { events, seen } = collect();

  const res = await runAgent("go", {
    provider,
    registry: new ToolRegistry().register(echoTool),
    stream: true,
    events,
  });

  expect(res.text).toBe("done: x");
  expect(seen.some((e) => e.type === "tool_call" && e.name === "echo")).toBe(true);
  expect(seen.some((e) => e.type === "tool_result" && e.content === "echoed: x")).toBe(true);
  expect(deltas(seen)).toEqual(["let me check", "done: x"]);
  expect(seen.some((e) => e.type === "text")).toBe(false);
});

test("a stream that never sends `done` is an error", async () => {
  const provider: ModelProvider = {
    name: "s",
    async generate() {
      return endTurn("x");
    },
    async *stream(): AsyncIterable<StreamChunk> {
      yield { type: "text_delta", text: "hi" };
      // no done chunk
    },
  };
  await expect(runAgent("hi", { provider, registry: new ToolRegistry(), stream: true })).rejects.toThrow(
    "done chunk",
  );
});

test("aborting mid-stream reports the run as cancelled", async () => {
  const controller = new AbortController();
  const provider: ModelProvider = {
    name: "s",
    async generate() {
      return endTurn("x");
    },
    async *stream(req): AsyncIterable<StreamChunk> {
      yield { type: "text_delta", text: "partial" };
      // hang until the run is aborted (the signal may already be aborted by the
      // time we get here — the delta's emit handler aborts synchronously).
      await new Promise<void>((_resolve, reject) => {
        const s = req.signal;
        const fail = (): void => reject(new DOMException("Aborted", "AbortError"));
        if (s?.aborted) return fail();
        s?.addEventListener("abort", fail, { once: true });
      });
      yield { type: "done", turn: endTurn("never") };
    },
  };
  // Abort as soon as the first delta lands (synchronously during emit).
  const seen: AgentEvent[] = [];
  const events = new EventEmitter().on((e) => {
    seen.push(e);
    if (e.type === "text_delta") controller.abort();
  });

  const res = await runAgent("go", {
    provider,
    registry: new ToolRegistry(),
    stream: true,
    signal: controller.signal,
    events,
  });

  expect(res.stoppedBy).toBe("cancelled");
  expect(deltas(seen)).toEqual(["partial"]);
});
