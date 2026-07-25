import { test, expect } from "bun:test";
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { globTool, GLOB_MAX_RESULTS } from "../src/tools/glob";

const ctx = (cwd: string) => ({ cwd });

/** Build a temp tree, run `fn`, always clean up. */
async function withTree(files: string[], fn: (dir: string) => Promise<void>): Promise<void> {
  const dir = await mkdtemp(join(tmpdir(), "sa-glob-"));
  try {
    for (const f of files) {
      const abs = join(dir, f);
      await mkdir(join(abs, ".."), { recursive: true });
      await writeFile(abs, "x");
    }
    await fn(dir);
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
}

const run = (dir: string, pattern: string, path = "."): Promise<string> =>
  Promise.resolve(globTool.handler({ pattern, path }, ctx(dir))).then(String);

test("glob is low-risk and non-mutating", () => {
  expect(globTool.risk).toBe("low");
  expect(globTool.mutates ?? false).toBe(false);
});

test("matches by pattern and returns sorted paths", async () => {
  await withTree(["src/a.ts", "src/b.ts", "src/c.js", "readme.md"], async (dir) => {
    const out = await run(dir, "src/**/*.ts");
    expect(out).toBe("src/a.ts\nsrc/b.ts"); // sorted, only .ts
  });
});

test("recursive ** across nested dirs", async () => {
  await withTree(["a/b/c/deep.ts", "top.ts"], async (dir) => {
    const out = await run(dir, "**/*.ts");
    expect(out.split("\n").sort()).toEqual(["a/b/c/deep.ts", "top.ts"]);
  });
});

test("reports no matches distinctly", async () => {
  await withTree(["a.ts"], async (dir) => {
    expect(await run(dir, "**/*.py")).toContain("no files match");
  });
});

test("skips node_modules and .git noise", async () => {
  await withTree(["src/app.ts", "node_modules/pkg/index.ts", ".git/hooks/x.ts"], async (dir) => {
    const out = await run(dir, "**/*.ts");
    expect(out).toBe("src/app.ts");
  });
});

test("refuses a pattern that escapes the working directory (../ )", async () => {
  await withTree(["ws/inside.ts"], async (dir) => {
    // A sibling file outside the search base must never be reachable via `..`.
    await writeFile(join(dir, "secret.ts"), "SECRET");
    const out = await run(dir, "../*.ts", "ws");
    expect(out).toContain("can't escape");
    expect(out).not.toContain("secret.ts");
  });
});

test("refuses an absolute pattern", async () => {
  await withTree(["a.ts"], async (dir) => {
    expect(await run(dir, "/etc/*")).toContain("absolute glob patterns aren't allowed");
  });
});

test("the path argument is bounded when a workspaceRoot is set (production guard)", async () => {
  await withTree(["ws/inside.ts", "secret.ts"], async (dir) => {
    // With a workspaceRoot, resolveInWorkspace throws on a path that escapes it —
    // this is the production wiring (bootstrap always sets workspaceRoot).
    const escapingCtx = { cwd: join(dir, "ws"), workspaceRoot: join(dir, "ws") };
    await expect(globTool.handler({ pattern: "*.ts", path: ".." }, escapingCtx)).rejects.toThrow(/escapes the workspace/);
  });
});

test("truncates a very long list with a marker", async () => {
  const files = Array.from({ length: GLOB_MAX_RESULTS + 25 }, (_, i) => `f${String(i).padStart(4, "0")}.ts`);
  await withTree(files, async (dir) => {
    const out = await run(dir, "*.ts");
    expect(out.split("\n").length).toBe(GLOB_MAX_RESULTS + 1); // results + marker line
    expect(out).toContain("more matches omitted");
  });
});
