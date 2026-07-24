import { test, expect } from "bun:test";
import { join } from "node:path";
import { connectMcpServer } from "../src/mcp/register";
import { runAgent } from "../src/core/engine";
import { ToolRegistry } from "../src/tools/registry";
import type { GenerateRequest, ModelProvider } from "../src/providers/provider";
import type { AssistantTurn, ToolResultBlock } from "../src/core/types";

const SERVER = join(import.meta.dir, "fixtures", "mock-mcp-server.ts");

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
const firstResult = (req: GenerateRequest): ToolResultBlock =>
  req.messages.flatMap((m) => m.content).filter((b): b is ToolResultBlock => b.type === "tool_result")[0]!;

test("registers namespaced MCP tools with a working handler", async () => {
  const registry = new ToolRegistry();
  const { client, toolNames } = await connectMcpServer(registry, { name: "mock", command: "bun", args: [SERVER] });
  try {
    expect(toolNames).toContain("mcp__mock__add");
    const tool = registry.get("mcp__mock__add")!;
    expect(tool.risk).toBe("high"); // third-party ⇒ gated by default
    expect(tool.spec.inputSchema).toMatchObject({ type: "object" });
    const out = await tool.handler({ a: 4, b: 5 }, { cwd: process.cwd() });
    expect(out).toBe("9");
  } finally {
    await client.close();
  }
});

test("an MCP tool runs through the engine's permission gate and feeds its result back", async () => {
  const registry = new ToolRegistry();
  const { client } = await connectMcpServer(registry, { name: "mock", command: "bun", args: [SERVER] });
  try {
    const provider = new ScriptedProvider([
      toolUseTurn("t1", "mcp__mock__add", { a: 1, b: 2 }),
      endTurn("the sum is 3"),
    ]);
    let asked = 0;
    const res = await runAgent("add 1 and 2", {
      provider,
      registry,
      approve: async () => ((asked += 1), true),
    });

    expect(asked).toBe(1); // high-risk MCP tool required approval
    expect(firstResult(provider.calls[1]!).content).toBe("3");
    expect(res.text).toBe("the sum is 3");
  } finally {
    await client.close();
  }
});
