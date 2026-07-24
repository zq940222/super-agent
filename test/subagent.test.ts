import { test, expect } from "bun:test";
import { z } from "zod";
import { runAgent } from "../src/core/engine";
import { EventEmitter, type AgentEvent } from "../src/core/events";
import { createSubagentTool } from "../src/agents/subagent";
import { ToolRegistry, defineTool } from "../src/tools/registry";
import type { GenerateRequest, ModelProvider } from "../src/providers/provider";
import type { AssistantTurn, TextBlock, ToolResultBlock } from "../src/core/types";

const usage = { inputTokens: 0, outputTokens: 0 };
const endTurn = (text: string): AssistantTurn => ({
  message: { role: "assistant", content: [{ type: "text", text }] },
  stopReason: "end_turn",
  usage,
});
const toolUseTurn = (id: string, name: string, input: unknown): AssistantTurn => ({
  message: { role: "assistant", content: [{ type: "tool_use", id, name, input }] },
  stopReason: "tool_use",
  usage,
});

class ScriptedProvider implements ModelProvider {
  readonly name = "scripted";
  calls: GenerateRequest[] = [];
  private i = 0;
  constructor(private turns: AssistantTurn[]) {}
  async generate(req: GenerateRequest): Promise<AssistantTurn> {
    this.calls.push(structuredClone(req));
    const turn = this.turns[this.i++];
    if (!turn) throw new Error("out of turns");
    return turn;
  }
}

const resultBlocks = (req: GenerateRequest): ToolResultBlock[] =>
  req.messages.flatMap((m) => m.content).filter((b): b is ToolResultBlock => b.type === "tool_result");

test("delegates to a child and the parent sees only the child's final text", async () => {
  const provider = new ScriptedProvider([
    toolUseTurn("s1", "spawn_agent", { task: "do X" }),
    endTurn("child answer"),
    endTurn("parent: child answer"),
  ]);
  const registry = new ToolRegistry().register(createSubagentTool({ provider, tools: [] }));

  const res = await runAgent("delegate please", { provider, registry });

  expect(res.text).toBe("parent: child answer");
  expect(provider.calls.length).toBe(3);
  // The result the parent got back for spawn_agent is the child's distilled text.
  expect(resultBlocks(provider.calls[2]!)[0]!.content).toBe("child answer");
});

test("the child runs in an isolated context (only the task, not the parent history)", async () => {
  const provider = new ScriptedProvider([
    toolUseTurn("s1", "spawn_agent", { task: "isolated task" }),
    endTurn("child done"),
    endTurn("parent done"),
  ]);
  const registry = new ToolRegistry().register(createSubagentTool({ provider, tools: [] }));

  await runAgent("parent prompt with lots of history", { provider, registry });

  // calls[1] is the child's first model call — it must contain ONLY the task.
  const childFirst = provider.calls[1]!;
  expect(childFirst.messages.length).toBe(1);
  expect((childFirst.messages[0]!.content[0] as TextBlock).text).toBe("isolated task");
});

test("recursion is capped: a leaf subagent has no spawn_agent tool", async () => {
  const childEvents: AgentEvent[] = [];
  const events = new EventEmitter().on((e) => childEvents.push(e));
  const provider = new ScriptedProvider([
    toolUseTurn("s1", "spawn_agent", { task: "T" }), // parent delegates
    toolUseTurn("s2", "spawn_agent", { task: "T2" }), // child tries to delegate again
    endTurn("child leaf done"), // child recovers after the failed spawn
    endTurn("parent done"),
  ]);
  const registry = new ToolRegistry().register(
    createSubagentTool({ provider, tools: [], maxDepth: 1, events }),
  );

  const res = await runAgent("go", { provider, registry });

  expect(res.text).toBe("parent done");
  // The child's attempt to spawn_agent hit "Unknown tool" (no nested spawn at maxDepth 1).
  const childToolResults = childEvents.filter((e) => e.type === "tool_result");
  expect(childToolResults.some((e) => e.type === "tool_result" && e.content.includes("Unknown tool: spawn_agent"))).toBe(true);
});

test("a child's own high-risk tool call is gated by the inherited policy/approver", async () => {
  const danger = defineTool({
    name: "danger",
    description: "high risk",
    risk: "high",
    schema: z.object({}),
    handler: () => "did it",
  });
  const provider = new ScriptedProvider([
    toolUseTurn("s1", "spawn_agent", { task: "run danger" }),
    toolUseTurn("c1", "danger", {}), // child calls the high-risk tool
    endTurn("child: did it"),
    endTurn("parent done"),
  ]);
  let asked = 0;
  const approve = async () => ((asked += 1), true);
  const registry = new ToolRegistry().register(createSubagentTool({ provider, tools: [danger], approve }));

  const res = await runAgent("go", { provider, registry, approve });

  // spawn_agent is low-risk (not asked); the child's danger call IS gated.
  expect(asked).toBe(1);
  expect(res.text).toBe("parent done");
});
