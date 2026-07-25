import { test, expect } from "bun:test";
import { mkdtemp, rm, readFile, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { editFileTool, EDIT_SNIPPET_MAX } from "../src/tools/edit-file";

const ctx = (cwd: string) => ({ cwd });

/** Seed a file in a temp dir, run `fn`, always clean up. */
async function withFile(
  name: string,
  contents: string | Buffer,
  fn: (dir: string, read: () => Promise<string>) => Promise<void>,
): Promise<void> {
  const dir = await mkdtemp(join(tmpdir(), "sa-edit-"));
  try {
    await writeFile(join(dir, name), contents);
    await fn(dir, () => readFile(join(dir, name), "utf8"));
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
}

type Args = { path: string; old_string: string; new_string: string; replace_all?: boolean };
const run = (dir: string, args: Args): Promise<string> =>
  Promise.resolve(editFileTool.handler({ replace_all: false, ...args }, ctx(dir))).then(String);

test("edit_file is low-risk and mutating (like write_file: default runs, readonly denies)", () => {
  expect(editFileTool.risk).toBe("low");
  expect(editFileTool.mutates).toBe(true);
});

// --- the happy path ---

test("replaces a unique occurrence and leaves the rest byte-for-byte", async () => {
  await withFile("f.txt", "line one\nline two\nline three\n", async (dir, read) => {
    const out = await run(dir, { path: "f.txt", old_string: "line two", new_string: "LINE 2" });
    expect(out).toContain("replaced 1 occurrence");
    expect(await read()).toBe("line one\nLINE 2\nline three\n");
  });
});

test("returns a snippet of the updated region for self-verification", async () => {
  await withFile("code.ts", "a\nb\nconst x = 1;\nd\ne\n", async (dir) => {
    const out = await run(dir, { path: "code.ts", old_string: "const x = 1;", new_string: "const x = 42;" });
    expect(out).toContain("--- updated region ---");
    expect(out).toContain("const x = 42;");
  });
});

test("multi-line new_string is inserted verbatim", async () => {
  await withFile("f.txt", "start\nMIDDLE\nend\n", async (dir, read) => {
    await run(dir, { path: "f.txt", old_string: "MIDDLE", new_string: "one\ntwo\nthree" });
    expect(await read()).toBe("start\none\ntwo\nthree\nend\n");
  });
});

test("an empty new_string deletes the matched text", async () => {
  await withFile("f.txt", "keep REMOVE keep", async (dir, read) => {
    await run(dir, { path: "f.txt", old_string: " REMOVE", new_string: "" });
    expect(await read()).toBe("keep keep");
  });
});

// --- unique-match semantics ---

test("refuses an ambiguous match (>1) and does not write", async () => {
  await withFile("f.txt", "x\nx\nx\n", async (dir, read) => {
    const out = await run(dir, { path: "f.txt", old_string: "x", new_string: "y" });
    expect(out).toContain("occurs 3 times");
    expect(await read()).toBe("x\nx\nx\n"); // unchanged
  });
});

test("replace_all replaces every occurrence", async () => {
  await withFile("f.txt", "x\nx\nx\n", async (dir, read) => {
    const out = await run(dir, { path: "f.txt", old_string: "x", new_string: "y", replace_all: true });
    expect(out).toContain("replaced 3 occurrence");
    expect(out).toContain("--- updated region ---\n"); // the replace_all snippet branch
    expect(out).toContain("y"); // snippet shows the first replacement
    expect(await read()).toBe("y\ny\ny\n");
  });
});

test("counts occurrences correctly for overlapping candidates", async () => {
  // 'aa' in 'aaa' is 1 non-overlapping occurrence (split-based count), not 2.
  await withFile("f.txt", "aaa", async (dir) => {
    const out = await run(dir, { path: "f.txt", old_string: "aa", new_string: "b" });
    expect(out).toContain("replaced 1 occurrence"); // unique ⇒ succeeds
  });
});

// --- guards (all refuse before writing) ---

test("reports a missing file and points to write_file", async () => {
  await withFile("exists.txt", "hi", async (dir) => {
    const out = await run(dir, { path: "nope.txt", old_string: "a", new_string: "b" });
    expect(out).toContain("File not found");
    expect(out).toContain("write_file");
  });
});

test("a missing file wins over the no-op check (guard order, ADR-0006 §3)", async () => {
  await withFile("exists.txt", "hi", async (dir) => {
    // old === new AND the file is missing → the more fundamental error should win.
    const out = await run(dir, { path: "gone.txt", old_string: "z", new_string: "z" });
    expect(out).toContain("File not found");
    expect(out).not.toContain("identical");
  });
});

test("reports old_string not found without modifying the file", async () => {
  await withFile("f.txt", "hello world", async (dir, read) => {
    const out = await run(dir, { path: "f.txt", old_string: "absent", new_string: "x" });
    expect(out).toContain("not found");
    expect(await read()).toBe("hello world"); // untouched
  });
});

test("a no-op (old === new) is refused, not written", async () => {
  await withFile("f.txt", "same", async (dir) => {
    const out = await run(dir, { path: "f.txt", old_string: "same", new_string: "same" });
    expect(out).toContain("identical");
  });
});

test("refuses to edit a binary file (NUL byte)", async () => {
  await withFile("bin.dat", Buffer.from([0x61, 0x00, 0x62]), async (dir) => {
    const out = await run(dir, { path: "bin.dat", old_string: "a", new_string: "c" });
    expect(out).toContain("looks binary");
  });
});

test("rejects an empty old_string at the schema layer", () => {
  const v = editFileTool.validate!({ path: "f.txt", old_string: "", new_string: "x" });
  expect(v.ok).toBe(false);
});

// --- workspace boundary (throws, engine turns it into isError) ---

test("a path escaping the workspace throws (not a returned string)", async () => {
  await withFile("f.txt", "x", async (dir) => {
    const escapingCtx = { cwd: dir, workspaceRoot: dir };
    await expect(
      editFileTool.handler({ path: "../outside.txt", old_string: "x", new_string: "y", replace_all: false }, escapingCtx),
    ).rejects.toThrow(/escapes the workspace/);
  });
});

// --- output-size discipline ---

test("caps a huge new_string snippet with the truncation marker", async () => {
  await withFile("f.txt", "before\nTARGET\nafter\n", async (dir) => {
    const huge = "Z".repeat(EDIT_SNIPPET_MAX + 500);
    const out = await run(dir, { path: "f.txt", old_string: "TARGET", new_string: huge });
    expect(out).toContain("replaced 1 occurrence");
    expect(out).toMatch(/truncated \d+ of \d+ chars/);
  });
});
