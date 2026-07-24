import { test, expect } from "bun:test";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { READ_FILE_MAX_BYTES, readFileTool } from "../src/tools/read-file";

const ctx = (cwd: string) => ({ cwd });

test("reads a small file's contents", async () => {
  const dir = await mkdtemp(join(tmpdir(), "sa-"));
  try {
    await writeFile(join(dir, "hello.txt"), "hello world");
    const out = await readFileTool.handler({ path: "hello.txt" }, ctx(dir));
    expect(out).toBe("hello world");
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

test("truncates a large file and marks how much was omitted", async () => {
  const dir = await mkdtemp(join(tmpdir(), "sa-"));
  try {
    const big = "x".repeat(READ_FILE_MAX_BYTES + 5000);
    await writeFile(join(dir, "big.txt"), big);
    const out = await readFileTool.handler({ path: "big.txt" }, ctx(dir));
    expect(out.length).toBeLessThan(big.length);
    expect(out).toContain("truncated");
    expect(out).toContain("5000 of");
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

test("a missing file surfaces as a thrown error (engine turns it into an error result)", async () => {
  const dir = await mkdtemp(join(tmpdir(), "sa-"));
  try {
    await expect(readFileTool.handler({ path: "nope.txt" }, ctx(dir))).rejects.toThrow();
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

test("validate rejects a missing path and exposes a JSON Schema", () => {
  const v = readFileTool.validate!({});
  expect(v.ok).toBe(false);

  const schema = readFileTool.spec.inputSchema as { type?: string; properties?: Record<string, unknown> };
  expect(schema.type).toBe("object");
  expect(schema.properties?.path).toBeDefined();
});
