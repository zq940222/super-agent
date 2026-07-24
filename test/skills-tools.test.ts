import { test, expect } from "bun:test";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { runAgent } from "../src/core/engine";
import { ToolRegistry } from "../src/tools/registry";
import { SkillStore } from "../src/skills/store";
import { createSkillTools, skillsCatalog } from "../src/skills/tools";
import type { GenerateRequest, ModelProvider } from "../src/providers/provider";
import type { AssistantTurn, ToolResultBlock } from "../src/core/types";

const tmp = () => mkdtemp(join(tmpdir(), "sa-skills-"));
const toolsByName = (store: SkillStore) => {
  const map = new Map(createSkillTools(store).map((t) => [t.spec.name, t]));
  return map;
};
const ctx = { cwd: process.cwd() };

test("create_skill writes, find_skill finds it, read_skill returns the body", async () => {
  const dir = await tmp();
  try {
    const store = new SkillStore(dir);
    const tools = toolsByName(store);

    await tools.get("create_skill")!.handler(
      { name: "brew-tea", description: "Make a cup of tea", body: "1. Boil water\n2. Steep" },
      ctx,
    );
    expect(await tools.get("find_skill")!.handler({ query: "tea" }, ctx)).toContain("brew-tea");
    expect(await tools.get("read_skill")!.handler({ name: "brew-tea" }, ctx)).toContain("Boil water");
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

test("find_skill reports emptiness helpfully", async () => {
  const dir = await tmp();
  try {
    const tools = toolsByName(new SkillStore(dir));
    expect(await tools.get("find_skill")!.handler({ query: "" }, ctx)).toContain("create_skill");
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

test("create_skill validates the name", () => {
  const tools = toolsByName(new SkillStore("/tmp/whatever"));
  const v = tools.get("create_skill")!.validate!({ name: "Bad Name", description: "d", body: "b" });
  expect(v.ok).toBe(false);
});

test("skillsCatalog lists skills, or invites authoring when empty", async () => {
  const dir = await tmp();
  try {
    const store = new SkillStore(dir);
    expect(await skillsCatalog(store)).toContain("create_skill");
    await store.create({ name: "x", description: "does x", body: "b" });
    const cat = await skillsCatalog(store);
    expect(cat).toContain("- x: does x");
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

// engine integration: create_skill is medium-risk → gated by the permission gate.
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
    const t = this.turns[this.i++];
    if (!t) throw new Error("out of turns");
    return t;
  }
}

test("create_skill goes through the permission gate (asked before writing)", async () => {
  const dir = await tmp();
  try {
    const store = new SkillStore(dir);
    const registry = new ToolRegistry();
    for (const t of createSkillTools(store)) registry.register(t);
    const provider = new ScriptedProvider([
      toolUseTurn("s1", "create_skill", { name: "note", description: "d", body: "b" }),
      endTurn("saved"),
    ]);
    let asked = 0;

    await runAgent("make a skill", { provider, registry, approve: async () => ((asked += 1), true) });

    expect(asked).toBe(1); // medium-risk create_skill required approval
    const tr = provider.calls[1]!.messages
      .flatMap((m) => m.content)
      .find((b): b is ToolResultBlock => b.type === "tool_result")!;
    expect(tr.isError ?? false).toBe(false);
    expect(await store.read("note")).toBeDefined();
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});
