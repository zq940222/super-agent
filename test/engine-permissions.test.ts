import { test, expect } from "bun:test";
import { z } from "zod";
import { runAgent } from "../src/core/engine";
import { EventEmitter, type AgentEvent } from "../src/core/events";
import { PermissionPolicy, type PermissionRequest } from "../src/permissions/gate";
import { ToolRegistry, defineTool } from "../src/tools/registry";
import type { GenerateRequest, ModelProvider } from "../src/providers/provider";
import type { AssistantTurn, ToolResultBlock } from "../src/core/types";

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

const dangerTool = defineTool({
  name: "danger",
  description: "A high-risk tool.",
  risk: "high",
  schema: z.object({}),
  handler: () => "did the dangerous thing",
});
const echoTool = defineTool({
  name: "echo",
  description: "low risk",
  risk: "low",
  schema: z.object({ v: z.string() }),
  handler: ({ v }) => v,
});

const firstResult = (req: GenerateRequest): ToolResultBlock =>
  req.messages.flatMap((m) => m.content).filter((b): b is ToolResultBlock => b.type === "tool_result")[0]!;

test("high-risk tool runs after approval", async () => {
  const provider = new ScriptedProvider([toolUseTurn("t1", "danger", {}), endTurn("done")]);
  const registry = new ToolRegistry().register(dangerTool);
  const asked: PermissionRequest[] = [];

  await runAgent("go", { provider, registry, approve: async (r) => (asked.push(r), true) });

  const tr = firstResult(provider.calls[1]!);
  expect(tr.isError ?? false).toBe(false);
  expect(tr.content).toBe("did the dangerous thing");
  expect(asked.length).toBe(1);
  expect(asked[0]!.name).toBe("danger");
  expect(asked[0]!.risk).toBe("high");
});

test("high-risk tool is denied when the approver rejects", async () => {
  const provider = new ScriptedProvider([toolUseTurn("t1", "danger", {}), endTurn("recovered")]);
  const registry = new ToolRegistry().register(dangerTool);

  const res = await runAgent("go", { provider, registry, approve: async () => false });

  const tr = firstResult(provider.calls[1]!);
  expect(tr.isError).toBe(true);
  expect(tr.content).toContain("denied");
  expect(res.text).toBe("recovered"); // loop continued after the denial
});

test("with no approver, an ask decision is denied (safe default)", async () => {
  const provider = new ScriptedProvider([toolUseTurn("t1", "danger", {}), endTurn("ok")]);
  const registry = new ToolRegistry().register(dangerTool);

  await runAgent("go", { provider, registry });

  expect(firstResult(provider.calls[1]!).isError).toBe(true);
});

test("low-risk tools run without asking", async () => {
  const provider = new ScriptedProvider([toolUseTurn("t1", "echo", { v: "hi" }), endTurn("done")]);
  const registry = new ToolRegistry().register(echoTool);
  let asked = 0;

  await runAgent("go", { provider, registry, approve: async () => ((asked += 1), true) });

  expect(asked).toBe(0);
  expect(firstResult(provider.calls[1]!).content).toBe("hi");
});

test("auto mode runs a high-risk tool without asking", async () => {
  const provider = new ScriptedProvider([toolUseTurn("t1", "danger", {}), endTurn("done")]);
  const registry = new ToolRegistry().register(dangerTool);
  let asked = 0;

  await runAgent("go", {
    provider,
    registry,
    policy: new PermissionPolicy({ mode: "auto" }),
    approve: async () => ((asked += 1), true),
  });

  expect(asked).toBe(0);
  expect(firstResult(provider.calls[1]!).content).toBe("did the dangerous thing");
});

test("emits permission_request and permission_decision on an ask", async () => {
  const provider = new ScriptedProvider([toolUseTurn("t1", "danger", {}), endTurn("done")]);
  const registry = new ToolRegistry().register(dangerTool);
  const seen: AgentEvent[] = [];
  const events = new EventEmitter().on((e) => seen.push(e));

  await runAgent("go", { provider, registry, approve: async () => true, events });

  expect(seen.some((e) => e.type === "permission_request")).toBe(true);
  expect(seen.some((e) => e.type === "permission_decision" && e.decision === "allow")).toBe(true);
});
