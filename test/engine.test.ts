import { test, expect } from "bun:test";
import { z } from "zod";
import { runAgent } from "../src/core/engine";
import { EventEmitter, type AgentEvent } from "../src/core/events";
import { ToolRegistry, defineTool } from "../src/tools/registry";
import type { GenerateRequest, ModelProvider } from "../src/providers/provider";
import type { AssistantTurn, ToolResultBlock } from "../src/core/types";

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

/** Primary seam: a scripted fake provider. No network. */
class ScriptedProvider implements ModelProvider {
  readonly name = "scripted";
  calls: GenerateRequest[] = [];
  private i = 0;
  constructor(private turns: AssistantTurn[]) {}
  async generate(req: GenerateRequest): Promise<AssistantTurn> {
    this.calls.push(structuredClone(req)); // snapshot per-turn state
    const turn = this.turns[this.i++];
    if (!turn) throw new Error("ScriptedProvider ran out of scripted turns");
    return turn;
  }
}

/** Never stops calling tools — used to exercise the maxSteps cap. */
class AlwaysToolProvider implements ModelProvider {
  readonly name = "always-tool";
  calls = 0;
  async generate(): Promise<AssistantTurn> {
    this.calls++;
    return toolUseTurn(`t${this.calls}`, "echo", { value: "x" });
  }
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

test("answers in one step when the model calls no tool", async () => {
  const provider = new ScriptedProvider([endTurn("hello there")]);
  const registry = new ToolRegistry().register(echoTool);

  const res = await runAgent("hi", { provider, registry });

  expect(res.text).toBe("hello there");
  expect(res.steps).toBe(1);
  expect(res.stoppedBy).toBe("end_turn");
  expect(provider.calls.length).toBe(1);
});

test("executes a tool and feeds the result back for a final answer", async () => {
  const provider = new ScriptedProvider([toolUseTurn("t1", "echo", { value: "hey" }), endTurn("done: hey")]);
  const registry = new ToolRegistry().register(echoTool);
  const seen: AgentEvent[] = [];
  const events = new EventEmitter().on((e) => seen.push(e));

  const res = await runAgent("please echo", { provider, registry, events });

  expect(res.text).toBe("done: hey");
  expect(res.steps).toBe(2);
  expect(res.stoppedBy).toBe("end_turn");

  const second = resultBlocks(provider.calls[1]!);
  expect(second[0]!.toolUseId).toBe("t1");
  expect(second[0]!.content).toBe("echoed: hey");

  const types = seen.map((e) => e.type);
  expect(types).toContain("tool_call");
  expect(types).toContain("tool_result");
  expect(types.at(-1)).toBe("done");
});

test("loops across multiple tool-calling turns until end_turn", async () => {
  const provider = new ScriptedProvider([
    toolUseTurn("a", "echo", { value: "1" }),
    toolUseTurn("b", "echo", { value: "2" }),
    endTurn("all done"),
  ]);
  const registry = new ToolRegistry().register(echoTool);

  const res = await runAgent("go", { provider, registry });

  expect(res.text).toBe("all done");
  expect(res.steps).toBe(3);
  expect(res.stoppedBy).toBe("end_turn");
  expect(provider.calls.length).toBe(3);
  // The third turn's request must carry the second tool's result.
  expect(resultBlocks(provider.calls[2]!).map((r) => r.content)).toContain("echoed: 2");
});

test("stops at maxSteps when the model keeps calling tools", async () => {
  const provider = new AlwaysToolProvider();
  const registry = new ToolRegistry().register(echoTool);
  const seen: AgentEvent[] = [];
  const events = new EventEmitter().on((e) => seen.push(e));

  const res = await runAgent("go forever", { provider, registry, maxSteps: 3, events });

  expect(res.stoppedBy).toBe("max_steps");
  expect(res.steps).toBe(3);
  expect(provider.calls).toBe(3);
  expect(seen.some((e) => e.type === "error")).toBe(true);
});

test("a tool error does not stop the loop — the model gets to recover", async () => {
  const provider = new ScriptedProvider([toolUseTurn("t1", "nope", {}), endTurn("recovered")]);
  const registry = new ToolRegistry().register(echoTool);

  const res = await runAgent("x", { provider, registry });

  const tr = resultBlocks(provider.calls[1]!)[0]!;
  expect(tr.isError).toBe(true);
  expect(tr.content).toContain("Unknown tool");
  expect(res.text).toBe("recovered");
  expect(res.stoppedBy).toBe("end_turn");
});

test("a throwing handler is captured as an error result, loop continues", async () => {
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

  const res = await runAgent("x", { provider, registry });

  const tr = resultBlocks(provider.calls[1]!)[0]!;
  expect(tr.isError).toBe(true);
  expect(tr.content).toContain("kaboom");
  expect(res.text).toBe("ok");
});

test("invalid tool input is rejected before the handler runs", async () => {
  const provider = new ScriptedProvider([toolUseTurn("t1", "echo", { value: 123 }), endTurn("ok")]);
  const registry = new ToolRegistry().register(echoTool);

  await runAgent("x", { provider, registry });

  const tr = resultBlocks(provider.calls[1]!)[0]!;
  expect(tr.isError).toBe(true);
  expect(tr.content).toContain("Invalid input");
});

test("multiple tool_use blocks in one turn all execute in parallel", async () => {
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

  await runAgent("x", { provider, registry });

  const results = resultBlocks(provider.calls[1]!);
  expect(results.map((r) => r.toolUseId).sort()).toEqual(["a", "b"]);
  expect(results.map((r) => r.content).sort()).toEqual(["echoed: 1", "echoed: 2"]);
});
