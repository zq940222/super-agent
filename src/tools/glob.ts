/**
 * `glob` — find files by name pattern (P14-4). Pairs with `grep` (content
 * search) and `read_file`/`list_dir` to make the agent's exploration real:
 * locate candidate files, then read or search them.
 *
 * Read-only and `low`-risk, like the other filesystem-read tools. Uses Bun's
 * native `Glob` (no ripgrep/fd dependency — the from-scratch ethos). Matches are
 * bounded to the working directory, and `node_modules`/`.git` are skipped as
 * near-universal noise. Output follows the usual size discipline: sorted, capped,
 * truncated with a visible marker. See ADR-0004 §4.
 */

import { z } from "zod";
import { Glob } from "bun";
import { defineTool } from "./registry";
import { resolveInWorkspace, unsafeGlobPattern } from "./workspace";

/** Most paths shown to the model. */
export const GLOB_MAX_RESULTS = 200;
/** Hard cap on paths scanned, so `**\/*` on a huge tree can't run away. */
export const GLOB_SCAN_CAP = 5_000;

/** Directory segments never worth surfacing (build/vcs noise). */
function isNoise(path: string): boolean {
  return /(^|\/)(node_modules|\.git)\//.test(path);
}

export const globTool = defineTool({
  name: "glob",
  description:
    "Find files by glob pattern (e.g. `**/*.ts`, `src/**/*.test.ts`) and return the matching " +
    "paths, one per line, sorted. Searches within the working directory; `node_modules` and " +
    "`.git` are skipped. Long lists are truncated with a marker.",
  risk: "low",
  schema: z.object({
    pattern: z.string().min(1).describe("Glob pattern, e.g. `**/*.ts`."),
    path: z
      .string()
      .default(".")
      .describe("Directory to search from, relative to the working directory. Defaults to '.'."),
  }),
  handler: async ({ pattern, path }, ctx) => {
    const unsafe = unsafeGlobPattern(pattern);
    if (unsafe) return unsafe;
    // `path` is bounded by resolveInWorkspace (throws on escape when a
    // workspaceRoot is set; unrestricted only in the back-compat no-workspace
    // case, like read_file/list_dir). The *pattern* needs its own guard above
    // because it escapes the base dir even WITH a workspaceRoot set.
    const base = resolveInWorkspace(ctx, path);
    const glob = new Glob(pattern);

    const matches: string[] = [];
    let scanCapped = false;
    for await (const rel of glob.scan({ cwd: base, onlyFiles: true, dot: true })) {
      if (isNoise(rel)) continue;
      matches.push(rel);
      if (matches.length >= GLOB_SCAN_CAP) {
        scanCapped = true;
        break;
      }
    }
    if (matches.length === 0) return `(no files match ${pattern})`;

    matches.sort();
    const shown = matches.slice(0, GLOB_MAX_RESULTS);
    let out = shown.join("\n");
    if (matches.length > GLOB_MAX_RESULTS || scanCapped) {
      const omitted = matches.length - shown.length;
      out += `\n[... ${omitted}${scanCapped ? "+" : ""} more matches omitted — narrow the pattern ...]`;
    }
    return out;
  },
});
