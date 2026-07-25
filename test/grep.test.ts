import { test, expect } from "bun:test";
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { grepTool, GREP_MAX_MATCHES, GREP_MAX_LINE } from "../src/tools/grep";

const ctx = (cwd: string) => ({ cwd });

/** Build a temp tree from {relpath: contents}, run `fn`, always clean up. */
async function withTree(files: Record<string, string | Buffer>, fn: (dir: string) => Promise<void>): Promise<void> {
  const dir = await mkdtemp(join(tmpdir(), "sa-grep-"));
  try {
    for (const [f, content] of Object.entries(files)) {
      const abs = join(dir, f);
      await mkdir(join(abs, ".."), { recursive: true });
      await writeFile(abs, content);
    }
    await fn(dir);
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
}

type Args = { pattern: string; path?: string; glob?: string; ignore_case?: boolean };
const run = (dir: string, args: Args): Promise<string> =>
  Promise.resolve(
    grepTool.handler(
      { path: ".", glob: "**/*", ignore_case: false, ...args },
      ctx(dir),
    ),
  ).then(String);

test("grep is low-risk and non-mutating", () => {
  expect(grepTool.risk).toBe("low");
  expect(grepTool.mutates ?? false).toBe(false);
});

test("returns matches as path:line:text", async () => {
  await withTree({ "a.txt": "alpha\nbeta\ngamma\n", "b.txt": "delta\nbeta\n" }, async (dir) => {
    const out = await run(dir, { pattern: "beta" });
    const lines = out.split("\n").sort();
    expect(lines).toEqual(["a.txt:2:beta", "b.txt:2:beta"]);
  });
});

test("supports regex syntax and reports line numbers", async () => {
  await withTree({ "code.ts": "const x = 1;\nfunction foo() {}\nconst y = 2;\n" }, async (dir) => {
    const out = await run(dir, { pattern: "^const \\w+ =" });
    expect(out).toContain("code.ts:1:const x = 1;");
    expect(out).toContain("code.ts:3:const y = 2;");
    expect(out).not.toContain("function foo");
  });
});

test("ignore_case matches case-insensitively", async () => {
  await withTree({ "a.txt": "Hello WORLD\n" }, async (dir) => {
    expect(await run(dir, { pattern: "world", ignore_case: true })).toContain("a.txt:1:Hello WORLD");
    expect(await run(dir, { pattern: "world", ignore_case: false })).toContain("no matches");
  });
});

test("restricts the file set with the glob argument", async () => {
  await withTree({ "keep.ts": "needle\n", "skip.md": "needle\n" }, async (dir) => {
    const out = await run(dir, { pattern: "needle", glob: "**/*.ts" });
    expect(out).toContain("keep.ts:1:needle");
    expect(out).not.toContain("skip.md");
  });
});

test("skips node_modules / .git", async () => {
  await withTree({ "src/a.ts": "TODO\n", "node_modules/p/b.ts": "TODO\n", ".git/x": "TODO\n" }, async (dir) => {
    const out = await run(dir, { pattern: "TODO" });
    expect(out).toBe("src/a.ts:1:TODO");
  });
});

test("skips binary files (NUL byte)", async () => {
  await withTree({ "text.txt": "match\n", "bin.dat": Buffer.from([0x6d, 0x00, 0x6d, 0x61, 0x74, 0x63, 0x68]) }, async (dir) => {
    const out = await run(dir, { pattern: "match" });
    expect(out).toBe("text.txt:1:match"); // the binary hit is not reported
  });
});

test("refuses a glob argument that escapes the working directory", async () => {
  await withTree({ "ws/inside.txt": "needle\n" }, async (dir) => {
    await writeFile(join(dir, "secret.txt"), "needle\n"); // sibling, outside ws/
    const out = await run(dir, { pattern: "needle", path: "ws", glob: "../*.txt" });
    expect(out).toContain("can't escape");
    expect(out).not.toContain("secret.txt");
  });
});

test("reports an invalid regular expression instead of throwing", async () => {
  await withTree({ "a.txt": "x\n" }, async (dir) => {
    const out = await run(dir, { pattern: "(unclosed" });
    expect(out).toContain("Invalid regular expression");
  });
});

test("distinctly reports no matches", async () => {
  await withTree({ "a.txt": "nothing here\n" }, async (dir) => {
    expect(await run(dir, { pattern: "absent" })).toContain("no matches");
  });
});

test("truncates a very long matched line", async () => {
  await withTree({ "big.txt": "x".repeat(GREP_MAX_LINE + 50) + "\n" }, async (dir) => {
    const out = await run(dir, { pattern: "x" });
    expect(out).toContain("…");
    expect(out.length).toBeLessThan(GREP_MAX_LINE + 50);
  });
});

test("caps the number of matches with a marker", async () => {
  const many = Array.from({ length: GREP_MAX_MATCHES + 20 }, () => "hit").join("\n") + "\n";
  await withTree({ "a.txt": many }, async (dir) => {
    const out = await run(dir, { pattern: "hit" });
    const matchLines = out.split("\n").filter((l) => l.startsWith("a.txt:"));
    expect(matchLines.length).toBe(GREP_MAX_MATCHES);
    expect(out).toContain("truncated at");
  });
});
