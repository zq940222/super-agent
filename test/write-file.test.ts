import { test, expect } from "bun:test";
import { mkdtemp, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { writeFileTool } from "../src/tools/write-file";

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
