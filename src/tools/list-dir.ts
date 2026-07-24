/**
 * `list_dir` — the second tool. Pairs with `read_file` to make multi-step
 * behavior real: the agent can list a directory, then read a file it found.
 * Follows the same output-capping discipline as `read_file`.
 *
 * See issue #3.
 */

import { z } from "zod";
import { readdir } from "node:fs/promises";
import { defineTool } from "./registry";
import { resolveInWorkspace } from "./workspace";

export const LIST_DIR_MAX_ENTRIES = 200;

export const listDirTool = defineTool({
  name: "list_dir",
  description:
    "List the entries of a directory. Directory entries are suffixed with '/'. " +
    "Long listings are truncated with a marker.",
  risk: "low",
  schema: z.object({
    path: z
      .string()
      .min(1)
      .default(".")
      .describe("Directory path, relative to the working directory or absolute. Defaults to '.'."),
  }),
  handler: async ({ path }, ctx) => {
    const abs = resolveInWorkspace(ctx, path);
    const entries = await readdir(abs, { withFileTypes: true });
    const names = entries.map((e) => (e.isDirectory() ? `${e.name}/` : e.name)).sort();
    if (names.length === 0) return "(empty directory)";

    const shown = names.slice(0, LIST_DIR_MAX_ENTRIES);
    let out = shown.join("\n");
    if (names.length > LIST_DIR_MAX_ENTRIES) {
      out += `\n[... ${names.length - LIST_DIR_MAX_ENTRIES} more entries omitted ...]`;
    }
    return out;
  },
});
