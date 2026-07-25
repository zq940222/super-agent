/**
 * `write_file` — create or overwrite a text file.
 *
 * Risk `low`: the maintainer chose to treat writing files as a routine action,
 * so under the default policy it runs WITHOUT an approval prompt. Trade-off to
 * know: `low` also means `readonly` mode allows it (readonly = "low allowed,
 * else deny"), so readonly no longer blocks writes. If readonly must stay
 * strictly no-writes, add a mutation-aware rule in gate.ts. See issue #7.
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
    "Creates parent directories as needed. Use this whenever the user asks you to " +
    "write, save, generate, or create a file — do it directly, don't tell the user to do it.",
  risk: "low",
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
