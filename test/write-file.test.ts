import { test, expect } from "bun:test";
import { mkdtemp, readFile, rm, stat } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { writeFileTool } from "../src/tools/write-file";
import { runAgent } from "../src/core/engine";
import { ToolRegistry } from "../src/tools/registry";
import type { AssistantTurn } from "../src/core/types";
import type { GenerateRequest, ModelProvider } from "../src/providers/provider";

const usage = { inputTokens: 0, outputTokens: 0 };
class Scripted implements ModelProvider {
  readonly name = "scripted";
  private i = 0;
  constructor(private turns: AssistantTurn[]) {}
  async generate(_req: GenerateRequest): Promise<AssistantTurn> {
    return this.turns[this.i++]!;
  }
}

test("writes a file and reports the byte count", async () => {
  const dir = await mkdtemp(join(tmpdir(), "sa-"));
  try {
    const out = await writeFileTool.handler({ path: "out.txt", content: "hello" }, { cwd: dir });
    expect(out).toContain("5 bytes");
    expect(await readFile(join(dir, "out.txt"), "utf8")).toBe("hello");
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

test("creates parent directories as needed", async () => {
  const dir = await mkdtemp(join(tmpdir(), "sa-"));
  try {
    await writeFileTool.handler({ path: "a/b/c.txt", content: "x" }, { cwd: dir });
    expect(await readFile(join(dir, "a/b/c.txt"), "utf8")).toBe("x");
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

test("respects the workspace boundary", async () => {
  const dir = await mkdtemp(join(tmpdir(), "sa-"));
  try {
    await expect(
      writeFileTool.handler({ path: "../evil.txt", content: "x" }, { cwd: dir, workspaceRoot: dir }),
    ).rejects.toThrow(/escapes the workspace/);
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

test("declares low risk (writes run without a prompt under the default policy)", () => {
  expect(writeFileTool.risk).toBe("low");
});

// End-to-end wiring: the engine must route RunOptions.workspaceRoot into the tool
// context so a relative write lands in the workspace, not the launch cwd. Guards
// against a frontend dropping workspaceRoot from its runAgent call.
test("runAgent lands a relative write in workspaceRoot, not the cwd", async () => {
  const ws = await mkdtemp(join(tmpdir(), "sa-ws-"));
  try {
    const provider = new Scripted([
      { message: { role: "assistant", content: [{ type: "tool_use", id: "t1", name: "write_file", input: { path: "note.md", content: "hi" } }] }, stopReason: "tool_use", usage },
      { message: { role: "assistant", content: [{ type: "text", text: "done" }] }, stopReason: "end_turn", usage },
    ]);
    const registry = new ToolRegistry().register(writeFileTool);

    // write_file is low-risk, so the default policy runs it without an approver.
    await runAgent("write it", { provider, registry, workspaceRoot: ws });

    expect(await readFile(join(ws, "note.md"), "utf8")).toBe("hi"); // inside the workspace
    await expect(stat(join(process.cwd(), "note.md"))).rejects.toThrow(); // NOT in the cwd
  } finally {
    await rm(ws, { recursive: true, force: true });
  }
});
