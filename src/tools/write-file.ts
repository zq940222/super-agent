/**
 * `write_file` — the first high-risk (write) tool. It's the concrete thing the
 * permission gate guards: under the default policy it triggers an approval
 * prompt before anything is written. See issue #7.
 */

import { z } from "zod";
import { mkdir, writeFile } from "node:fs/promises";
import { dirname } from "node:path";
import { defineTool } from "./registry";
import { resolveInWorkspace } from "./workspace";

export const writeFileTool = defineTool({
  name: "write_file",
  description:
    "Create or overwrite a UTF-8 text file with the given content. " +
    "Creates parent directories as needed. Overwrites without asking at the tool level " +
    "(the permission gate decides whether the call runs at all).",
  risk: "high",
  schema: z.object({
    path: z.string().min(1).describe("File path, relative to the working directory or absolute."),
    content: z.string().describe("The full text content to write."),
  }),
  handler: async ({ path, content }, ctx) => {
    const abs = resolveInWorkspace(ctx, path);
    await mkdir(dirname(abs), { recursive: true });
    await writeFile(abs, content, "utf8");
    return `Wrote ${Buffer.byteLength(content, "utf8")} bytes to ${path}`;
  },
});
