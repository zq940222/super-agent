import { test, expect } from "bun:test";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { bootstrap, SYSTEM } from "../src/runtime/bootstrap";
import { type AgentEvent } from "../src/core/events";
import type { GenerateRequest, ModelProvider } from "../src/providers/provider";
import type { AssistantTurn } from "../src/core/types";

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

/** A provider we can script; also lets us inject one so bootstrap needs no API key. */
class ScriptedProvider implements ModelProvider {
  readonly name = "scripted";
  calls: GenerateRequest[] = [];
  private i = 0;
  constructor(private turns: AssistantTurn[]) {}
  async generate(req: GenerateRequest): Promise<AssistantTurn> {
    this.calls.push(structuredClone(req));
    const turn = this.turns[this.i++];
    if (!turn) throw new Error("ScriptedProvider ran out of scripted turns");
    return turn;
  }
}

/** A skills dir that doesn't exist ⇒ deterministic "no skills" catalog. */
async function withTempSkills<T>(fn: (dir: string) => Promise<T>): Promise<T> {
  const base = await mkdtemp(join(tmpdir(), "sa-bootstrap-"));
  try {
    return await fn(join(base, "skills")); // subdir intentionally absent
  } finally {
    await rm(base, { recursive: true, force: true });
  }
}

test("registers the native + skill + spawn_agent tools and builds the system prompt", async () => {
  await withTempSkills(async (skillsDir) => {
    const rt = await bootstrap({
      provider: new ScriptedProvider([]),
      skillsDir,
      loadMcp: false,
    });
    try {
      const names = rt.registry.list().map((t) => t.name).sort();
      expect(names).toEqual(
        ["create_skill", "find_skill", "list_dir", "read_file", "read_skill", "spawn_agent", "web_fetch", "write_file"].sort(),
      );
      expect(rt.system.startsWith(SYSTEM)).toBe(true);
      expect(rt.system).toContain("create_skill"); // the skills catalog got appended
      expect(rt.mode).toBe("default");
      expect(rt.provider.name).toBe("scripted");
    } finally {
      await rt.close();
    }
  });
});

test("close() is safe when no MCP servers were loaded", async () => {
  await withTempSkills(async (skillsDir) => {
    const rt = await bootstrap({ provider: new ScriptedProvider([]), skillsDir, loadMcp: false });
    await rt.close(); // must resolve, not throw or hang
  });
});

test("emits a backend diagnostic line through the log sink", async () => {
  await withTempSkills(async (skillsDir) => {
    const lines: string[] = [];
    const rt = await bootstrap({
      provider: new ScriptedProvider([]),
      skillsDir,
      loadMcp: false,
      mode: "readonly",
      log: (m) => lines.push(m),
    });
    await rt.close();
    expect(lines).toContain("backend: scripted · permissions: readonly");
  });
});

// The load-bearing invariant: spawn_agent captures the toolset BEFORE it is
// itself registered, so a subagent's registry must NOT contain spawn_agent.
// If the capture order regressed, the child would recurse instead of getting
// an "Unknown tool" result — unbounded delegation that maxDepth can't stop.
test("a subagent does not receive the spawn_agent tool (no unbounded recursion)", async () => {
  await withTempSkills(async (skillsDir) => {
    // The child (invoked below) immediately tries to spawn another agent, then answers.
    const provider = new ScriptedProvider([
      toolUseTurn("c1", "spawn_agent", { task: "grandchild" }),
      endTurn("child finished"),
    ]);
    const childEvents: AgentEvent[] = [];
    const rt = await bootstrap({
      provider,
      skillsDir,
      loadMcp: false,
      onChildEvent: (e) => childEvents.push(e),
    });
    try {
      const spawn = rt.registry.get("spawn_agent");
      expect(spawn).toBeDefined();

      const out = await spawn!.handler({ task: "do a thing" }, { cwd: process.cwd() });
      expect(out).toBe("child finished");

      // The child's spawn_agent call resolved to an Unknown-tool error, proving
      // the child registry excluded spawn_agent.
      const spawnResult = childEvents.find(
        (e) => e.type === "tool_result" && e.name === "spawn_agent",
      );
      expect(spawnResult).toBeDefined();
      expect(spawnResult).toMatchObject({ type: "tool_result", isError: true });
      if (spawnResult?.type === "tool_result") expect(spawnResult.content).toContain("Unknown tool");
    } finally {
      await rt.close();
    }
  });
});
