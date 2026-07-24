import { test, expect } from "bun:test";
import { z } from "zod";
import { runToolCall } from "../src/core/engine";
import { EventEmitter, type AgentEvent } from "../src/core/events";
import { ToolRegistry, defineTool } from "../src/tools/registry";
import type { GenerateRequest, ModelProvider } from "../src/providers/provider";
import type { AssistantTurn, ToolResultBlock } from "../src/core/types";

/**
 * The primary test seam: a scripted fake provider. Everything above the
 * provider (engine, registry, tool execution, message assembly, events) is
 * exercised through it, deterministically, with no network.
 */
class ScriptedProvider implements ModelProvider {
  readonly name = "scripted";
  calls: GenerateRequest[] = [];
  private i = 0;
  constructor(private turns: AssistantTurn[]) {}
  async generate(req: GenerateRequest): Promise<AssistantTurn> {
    // Snapshot the request as it was AT CALL TIME (the engine mutates the
    // messages array in place, so we must clone to assert per-turn state).
    this.calls.push(structuredClone(req));
    const turn = this.turns[this.i++];
    if (!turn) throw new Error("ScriptedProvider ran out of scripted turns");
    return turn;
  }
}

const usage = { inputTokens: 0, outputTokens: 0 };

function endTurn(text: string): AssistantTurn {
  return { message: { role: "assistant", content: [{ type: "text", text }] }, stopReason: "end_turn", usage };
}
function toolUseTurn(id: string, name: string, input: unknown): AssistantTurn {
  return {
    message: { role: "assistant", content: [{ type: "tool_use", id, name, input }] },
    stopReason: "tool_use",
    usage,
  };
}

const echoTool = defineTool({
  name: "echo",
  description: "Echo back the given value.",
  schema: z.object({ value: z.string() }),
  handler: ({ value }) => `echoed: ${value}`,
});

function resultBlocks(req: GenerateRequest): ToolResultBlock[] {
  return req.messages
    .flatMap((m) => m.content)
    .filter((b): b is ToolResultBlock => b.type === "tool_result");
}

test("returns text immediately when the model calls no tool", async () => {
  const provider = new ScriptedProvider([endTurn("hello there")]);
  const registry = new ToolRegistry().register(echoTool);

  const res = await runToolCall("hi", { provider, registry });

  expect(res.text).toBe("hello there");
  expect(res.turns).toBe(1);
  expect(provider.calls.length).toBe(1);
  expect(resultBlocks({ messages: res.messages } as GenerateRequest).length).toBe(0);
});

test("executes a requested tool and feeds the result back for a final answer", async () => {
  const provider = new ScriptedProvider([toolUseTurn("t1", "echo", { value: "hey" }), endTurn("done: hey")]);
  const registry = new ToolRegistry().register(echoTool);
  const seen: AgentEvent[] = [];
  const events = new EventEmitter().on((e) => seen.push(e));

  const res = await runToolCall("please echo", { provider, registry, events });

  expect(res.text).toBe("done: hey");
  expect(res.turns).toBe(2);
  expect(provider.calls.length).toBe(2);

  // The SECOND model call must have carried the tool result.
  const second = resultBlocks(provider.calls[1]!);
  expect(second.length).toBe(1);
  expect(second[0]!.toolUseId).toBe("t1");
  expect(second[0]!.content).toBe("echoed: hey");
  expect(second[0]!.isError ?? false).toBe(false);

  // Event stream shape.
  const types = seen.map((e) => e.type);
  expect(types).toContain("tool_call");
  expect(types).toContain("tool_result");
  expect(types.at(-1)).toBe("done");
});

test("an unknown tool becomes an error result, not a crash", async () => {
  const provider = new ScriptedProvider([toolUseTurn("t1", "nope", {}), endTurn("recovered")]);
  const registry = new ToolRegistry().register(echoTool);

  const res = await runToolCall("x", { provider, registry });

  const tr = resultBlocks(provider.calls[1]!)[0]!;
  expect(tr.isError).toBe(true);
  expect(tr.content).toContain("Unknown tool");
  expect(res.text).toBe("recovered");
});

test("a throwing handler is captured as an error result", async () => {
  const boom = defineTool({
    name: "boom",
    description: "Always throws.",
    schema: z.object({}),
    handler: () => {
      throw new Error("kaboom");
    },
  });
  const provider = new ScriptedProvider([toolUseTurn("t1", "boom", {}), endTurn("ok")]);
  const registry = new ToolRegistry().register(boom);

  await runToolCall("x", { provider, registry });

  const tr = resultBlocks(provider.calls[1]!)[0]!;
  expect(tr.isError).toBe(true);
  expect(tr.content).toContain("kaboom");
});

test("invalid tool input is rejected before the handler runs", async () => {
  const provider = new ScriptedProvider([toolUseTurn("t1", "echo", { value: 123 }), endTurn("ok")]);
  const registry = new ToolRegistry().register(echoTool);

  await runToolCall("x", { provider, registry });

  const tr = resultBlocks(provider.calls[1]!)[0]!;
  expect(tr.isError).toBe(true);
  expect(tr.content).toContain("Invalid input");
});

test("multiple tool_use blocks in one turn all execute", async () => {
  const twoTools: AssistantTurn = {
    message: {
      role: "assistant",
      content: [
        { type: "tool_use", id: "a", name: "echo", input: { value: "1" } },
        { type: "tool_use", id: "b", name: "echo", input: { value: "2" } },
      ],
    },
    stopReason: "tool_use",
    usage,
  };
  const provider = new ScriptedProvider([twoTools, endTurn("both done")]);
  const registry = new ToolRegistry().register(echoTool);

  await runToolCall("x", { provider, registry });

  const results = resultBlocks(provider.calls[1]!);
  expect(results.length).toBe(2);
  expect(results.map((r) => r.toolUseId).sort()).toEqual(["a", "b"]);
  expect(results.map((r) => r.content).sort()).toEqual(["echoed: 1", "echoed: 2"]);
});
