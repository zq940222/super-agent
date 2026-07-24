import { test, expect } from "bun:test";
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { listDirTool } from "../src/tools/list-dir";

const ctx = (cwd: string) => ({ cwd });

test("lists entries and marks directories with a trailing slash", async () => {
  const dir = await mkdtemp(join(tmpdir(), "sa-"));
  try {
    await writeFile(join(dir, "a.txt"), "x");
    await mkdir(join(dir, "sub"));
    const out = await listDirTool.handler({ path: "." }, ctx(dir));
    expect(out).toContain("a.txt");
    expect(out).toContain("sub/");
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

test("reports an empty directory", async () => {
  const dir = await mkdtemp(join(tmpdir(), "sa-"));
  try {
    const out = await listDirTool.handler({ path: "." }, ctx(dir));
    expect(out).toBe("(empty directory)");
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

test("path defaults to '.' when omitted", () => {
  const v = listDirTool.validate!({});
  expect(v.ok).toBe(true);
  expect((v as { ok: true; value: { path: string } }).value.path).toBe(".");
});
