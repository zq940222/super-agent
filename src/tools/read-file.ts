/**
 * `read_file` — the first, representative tool.
 *
 * It is the first concrete instance of the design principle "the thing that
 * fills the context window is tool output, not user input": the result is
 * capped and truncated with an explicit marker, so a large file can't blow out
 * the window. Every future tool should follow this pattern.
 *
 * See docs/agent-research.md §5 (#3) and the P1 spec (issue #1).
 */

import { z } from "zod";
import { readFile } from "node:fs/promises";
import { defineTool } from "./registry";
import { resolveInWorkspace } from "./workspace";

/** Max bytes returned to the model before truncation kicks in. */
export const READ_FILE_MAX_BYTES = 30_000;

export const readFileTool = defineTool({
  name: "read_file",
  description:
    "Read a UTF-8 text file from the local filesystem and return its contents. " +
    "Large files are truncated to the first portion with a marker noting how much was omitted.",
  risk: "low",
  schema: z.object({
    path: z
      .string()
      .min(1)
      .describe("Path to the file, relative to the working directory or absolute."),
  }),
  handler: async ({ path }, ctx) => {
    const abs = resolveInWorkspace(ctx, path);
    const buf = await readFile(abs);
    if (buf.byteLength > READ_FILE_MAX_BYTES) {
      const head = buf.subarray(0, READ_FILE_MAX_BYTES).toString("utf8");
      const omitted = buf.byteLength - READ_FILE_MAX_BYTES;
      return (
        `${head}\n\n` +
        `[... truncated: ${omitted} of ${buf.byteLength} bytes omitted. ` +
        `Ask for a specific section to see more. ...]`
      );
    }
    return buf.toString("utf8");
  },
});
