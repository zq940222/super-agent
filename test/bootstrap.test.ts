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
    // Deterministic regardless of the maintainer's .env: web_search is check-gated
    // on BRAVE_API_KEY, so unset it here to assert the unconfigured toolset.
    const saved = process.env.BRAVE_API_KEY;
    delete process.env.BRAVE_API_KEY;
    let rt: Awaited<ReturnType<typeof bootstrap>>;
    try {
      rt = await bootstrap({ provider: new ScriptedProvider([]), skillsDir, loadMcp: false });
    } finally {
      if (saved !== undefined) process.env.BRAVE_API_KEY = saved;
    }
    try {
      const names = rt.registry.list().map((t) => t.name).sort();
      expect(names).toEqual(
        // web_search is absent: no Brave key ⇒ check() hides it from the model.
        ["create_skill", "find_skill", "glob", "grep", "list_dir", "read_file", "read_skill", "shell", "spawn_agent", "web_fetch", "write_file"].sort(),
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

test("web_search is offered only when BRAVE_API_KEY is configured", async () => {
  await withTempSkills(async (skillsDir) => {
    const saved = process.env.BRAVE_API_KEY;
    process.env.BRAVE_API_KEY = "test-brave-key";
    let rt: Awaited<ReturnType<typeof bootstrap>>;
    try {
      rt = await bootstrap({ provider: new ScriptedProvider([]), skillsDir, loadMcp: false });
    } finally {
      if (saved === undefined) delete process.env.BRAVE_API_KEY;
      else process.env.BRAVE_API_KEY = saved;
    }
    try {
      expect(rt.registry.list().map((t) => t.name)).toContain("web_search");
    } finally {
      await rt.close();
    }
  });
});

// web_search is the first check-gated tool. Subagents receive the toolset via
// registry.all() (unfiltered), but the child's own engine calls registry.list()
// (check-filtered) — so an unconfigured web_search must be hidden from the child
// too, not merely from the top level. Guards the ADR-0004 check-gating claim.
test("a check-gated tool (web_search, no key) is not offered to subagents", async () => {
  await withTempSkills(async (skillsDir) => {
    const saved = process.env.BRAVE_API_KEY;
    delete process.env.BRAVE_API_KEY;
    const provider = new ScriptedProvider([endTurn("child done")]); // child answers at once
    let rt: Awaited<ReturnType<typeof bootstrap>>;
    try {
      rt = await bootstrap({ provider, skillsDir, loadMcp: false });
    } finally {
      if (saved !== undefined) process.env.BRAVE_API_KEY = saved;
    }
    try {
      await rt.registry.get("spawn_agent")!.handler({ task: "anything" }, { cwd: process.cwd() });
      // The child's request to the model must not include web_search.
      const childReq = provider.calls.at(-1)!;
      expect(childReq.tools?.map((t) => t.name)).not.toContain("web_search");
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
