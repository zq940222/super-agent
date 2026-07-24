import { test, expect } from "bun:test";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createRollout, readSessionMessages } from "../src/session/rollout";
import type { Message } from "../src/core/types";

test("records messages and reads them back (meta filtered out)", async () => {
  const dir = await mkdtemp(join(tmpdir(), "sa-"));
  try {
    const path = join(dir, "s.jsonl");
    const rollout = createRollout(path);
    await rollout.recordMeta({ provider: "test" });
    const m1: Message = { role: "user", content: [{ type: "text", text: "hi" }] };
    const m2: Message = { role: "assistant", content: [{ type: "text", text: "yo" }] };
    await rollout.recordMessage(m1);
    await rollout.recordMessage(m2);

    expect(await readSessionMessages(path)).toEqual([m1, m2]);
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

test("creates parent directories for the session file", async () => {
  const dir = await mkdtemp(join(tmpdir(), "sa-"));
  try {
    const path = join(dir, "nested/deep/s.jsonl");
    const rollout = createRollout(path);
    await rollout.recordMessage({ role: "user", content: [{ type: "text", text: "x" }] });
    expect((await readSessionMessages(path)).length).toBe(1);
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});
