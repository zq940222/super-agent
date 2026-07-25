import { test, expect } from "bun:test";
import { mkdtemp, rm, stat } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { resolveWorkspace } from "../src/runtime/workspace";

test("AGENT_WORKSPACE picks the workspace root and the dir is created", async () => {
  const base = await mkdtemp(join(tmpdir(), "sa-ws-"));
  const target = join(base, "my-workspace");
  const prev = process.env.AGENT_WORKSPACE;
  process.env.AGENT_WORKSPACE = target;
  try {
    const root = resolveWorkspace();
    expect(root).toBe(resolve(target));
    expect((await stat(root)).isDirectory()).toBe(true); // created on resolve
  } finally {
    if (prev === undefined) delete process.env.AGENT_WORKSPACE;
    else process.env.AGENT_WORKSPACE = prev;
    await rm(base, { recursive: true, force: true });
  }
});

test("defaults to ./workspace relative to the cwd when unset", async () => {
  const prev = process.env.AGENT_WORKSPACE;
  delete process.env.AGENT_WORKSPACE;
  const wsPath = resolve("workspace");
  let existedBefore = true;
  try {
    await stat(wsPath);
  } catch {
    existedBefore = false;
  }
  try {
    expect(resolveWorkspace()).toBe(wsPath);
  } finally {
    if (prev !== undefined) process.env.AGENT_WORKSPACE = prev;
    if (!existedBefore) await rm(wsPath, { recursive: true, force: true }); // remove only what the test created
  }
});
