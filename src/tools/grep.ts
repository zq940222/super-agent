/**
 * `grep` — search file *contents* by regular expression (P14-4). The content
 * counterpart to `glob` (name search); together they let the agent find where
 * something lives before reading it.
 *
 * Read-only and `low`-risk. Implemented in-process (no ripgrep dependency): Bun's
 * `Glob` enumerates candidate files, each is read and matched line-by-line. It
 * defends the context window and itself with hard caps — files scanned, matches
 * returned, and per-line length — and skips binary/oversized files and
 * `node_modules`/`.git`. Output is `path:line:text`, truncated with a visible
 * marker. See ADR-0004 §4.
 *
 * Accepted limitation: a pathological user regex can backtrack (ReDoS). The
 * pattern comes from the model over its own workspace, matching is line-scoped,
 * and the file cap bounds the work — full protection would need a regex engine
 * with a timeout, which is out of scope for v1.
 */

import { z } from "zod";
import { Glob } from "bun";
import { readFile } from "node:fs/promises";
import { join } from "node:path";
import { defineTool } from "./registry";
import { resolveInWorkspace, unsafeGlobPattern } from "./workspace";

/** Most matching lines shown to the model. */
export const GREP_MAX_MATCHES = 100;
/** Hard cap on files opened, so a broad search can't run away. */
export const GREP_FILE_CAP = 2_000;
/** Skip files larger than this (bytes) — likely data, not source. */
export const GREP_MAX_FILE_BYTES = 1_000_000;
/** Truncate any single matched line to this many characters. */
export const GREP_MAX_LINE = 300;

function isNoise(path: string): boolean {
  return /(^|\/)(node_modules|\.git)\//.test(path);
}

/** Heuristic: a NUL byte in the first chunk ⇒ treat as binary, skip. */
function looksBinary(buf: Buffer): boolean {
  const n = Math.min(buf.byteLength, 1024);
  for (let i = 0; i < n; i++) if (buf[i] === 0) return true;
  return false;
}

export const grepTool = defineTool({
  name: "grep",
  description:
    "Search file contents by regular expression and return matching lines as `path:line:text`. " +
    "Restrict the file set with `glob` (e.g. `**/*.ts`). Searches within the working directory; " +
    "`node_modules`, `.git`, binary, and very large files are skipped. Results are truncated with a marker.",
  risk: "low",
  schema: z.object({
    pattern: z.string().min(1).describe("Regular expression to search for (JavaScript regex syntax)."),
    path: z
      .string()
      .default(".")
      .describe("Directory to search from, relative to the working directory. Defaults to '.'."),
    glob: z
      .string()
      .default("**/*")
      .describe("Glob limiting which files are searched. Defaults to all files."),
    ignore_case: z.boolean().default(false).describe("Case-insensitive match."),
  }),
  handler: async ({ pattern, path, glob, ignore_case }, ctx) => {
    const unsafe = unsafeGlobPattern(glob);
    if (unsafe) return unsafe;

    let re: RegExp;
    try {
      re = new RegExp(pattern, ignore_case ? "i" : "");
    } catch (err) {
      return `Invalid regular expression: ${err instanceof Error ? err.message : String(err)}`;
    }

    // `path` is bounded by resolveInWorkspace (see glob.ts); the `glob` arg needs
    // its own guard above since a pattern escapes the base even with a workspaceRoot.
    const base = resolveInWorkspace(ctx, path);
    const matcher = new Glob(glob);

    const results: string[] = [];
    let filesScanned = 0;
    let fileCapped = false;
    let matchCapped = false;

    outer: for await (const rel of matcher.scan({ cwd: base, onlyFiles: true, dot: true })) {
      if (isNoise(rel)) continue;
      if (filesScanned >= GREP_FILE_CAP) {
        fileCapped = true;
        break;
      }
      filesScanned++;

      let buf: Buffer;
      try {
        buf = await readFile(join(base, rel));
      } catch {
        continue; // unreadable / vanished mid-scan
      }
      if (buf.byteLength > GREP_MAX_FILE_BYTES || looksBinary(buf)) continue;

      const lines = buf.toString("utf8").split("\n");
      for (let i = 0; i < lines.length; i++) {
        if (!re.test(lines[i]!)) continue;
        const text = lines[i]!.length > GREP_MAX_LINE ? lines[i]!.slice(0, GREP_MAX_LINE) + "…" : lines[i]!;
        results.push(`${rel}:${i + 1}:${text}`);
        if (results.length >= GREP_MAX_MATCHES) {
          matchCapped = true;
          break outer;
        }
      }
    }

    if (results.length === 0) return `(no matches for /${pattern}/${ignore_case ? "i" : ""})`;
    let out = results.join("\n");
    if (matchCapped || fileCapped) {
      out += `\n[... truncated at ${results.length} matches — narrow the pattern or glob ...]`;
    }
    return out;
  },
});
