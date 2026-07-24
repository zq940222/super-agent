import { test, expect } from "bun:test";
import { z } from "zod";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { runAgent } from "../src/core/engine";
import { EventEmitter, type AgentEvent } from "../src/core/events";
import { createRollout, readSessionMessages } from "../src/session/rollout";
import { ToolRegistry, defineTool } from "../src/tools/registry";
import type { GenerateRequest, ModelProvider } from "../src/providers/provider";
import type { AssistantTurn } from "../src/core/types";

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

const echoTool = defineTool({
  name: "echo",
  description: "echo",
  risk: "low",
  schema: z.object({ v: z.string() }),
  handler: ({ v }) => v,
});

test("compacts between steps when over the context budget, and keeps going", async () => {
  const provider = new ScriptedProvider([
    toolUseTurn("t1", "echo", { v: "a" }),
    toolUseTurn("t2", "echo", { v: "b" }),
    endTurn("done"),
  ]);
  const registry = new ToolRegistry().register(echoTool);
  const seen: AgentEvent[] = [];
  const events = new EventEmitter().on((e) => seen.push(e));
  let summarizeCalls = 0;

  const res = await runAgent("go", {
    provider,
    registry,
    events,
    maxContextTokens: 1, // force compaction whenever there's more than keepRecent
    keepRecent: 2,
    summarize: async () => ((summarizeCalls += 1), "SUMMARY"),
  });

  expect(res.stoppedBy).toBe("end_turn");
  expect(res.steps).toBe(3);
  expect(seen.some((e) => e.type === "compaction")).toBe(true);
  expect(summarizeCalls).toBeGreaterThan(0);
});

test("does not compact under a generous budget (summarizer untouched)", async () => {
  const provider = new ScriptedProvider([toolUseTurn("t1", "echo", { v: "a" }), endTurn("done")]);
  const registry = new ToolRegistry().register(echoTool);
  let summarizeCalls = 0;

  await runAgent("go", {
    provider,
    registry,
    maxContextTokens: 1_000_000,
    summarize: async () => ((summarizeCalls += 1), "S"),
  });

  expect(summarizeCalls).toBe(0);
});

test("records the raw message stream to the rollout", async () => {
  const dir = await mkdtemp(join(tmpdir(), "sa-"));
  try {
    const provider = new ScriptedProvider([toolUseTurn("t1", "echo", { v: "hi" }), endTurn("done")]);
    const registry = new ToolRegistry().register(echoTool);
    const path = join(dir, "s.jsonl");
    const rollout = createRollout(path);

    await runAgent("go", { provider, registry, rollout });

    const recorded = await readSessionMessages(path);
    // user("go") → assistant(tool_use) → user(tool_result) → assistant("done")
    expect(recorded.length).toBe(4);
    expect(recorded[0]!.role).toBe("user");
    expect(recorded[1]!.content[0]!.type).toBe("tool_use");
    expect(recorded[2]!.content[0]!.type).toBe("tool_result");
    expect(recorded[3]!.content[0]!.type).toBe("text");
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});
