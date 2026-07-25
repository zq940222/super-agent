/**
 * `edit_file` — surgical, exact string-replace edits (P14-5, ADR-0006).
 *
 * The counterpart to `write_file` (whole-file overwrite): change a target region
 * and leave the rest byte-for-byte untouched, without the model reproducing the
 * whole file. Exact `old_string` → `new_string`, matched UNIQUELY unless
 * `replace_all` — ambiguity is refused, never guessed. Not a diff/patch parser;
 * `apply_patch` is the named future upgrade.
 *
 * Risk `low`, `mutates: true` — identical to `write_file` (default runs it,
 * `readonly` denies it). The tool's own refusals return error STRINGS the model
 * can act on; only a workspace-escaping path throws (engine → isError).
 */

import { z } from "zod";
import { readFile, writeFile } from "node:fs/promises";
import { defineTool } from "./registry";
import { resolveInWorkspace } from "./workspace";

/** Max chars of the change snippet echoed back for the model to self-verify. */
export const EDIT_SNIPPET_MAX = 2_000;
/** Lines of context shown on each side of the change in that snippet. */
const SNIPPET_CONTEXT_LINES = 3;

/** A NUL byte in the first chunk ⇒ treat as binary, refuse to edit. */
function looksBinary(buf: Buffer): boolean {
  const n = Math.min(buf.byteLength, 1024);
  for (let i = 0; i < n; i++) if (buf[i] === 0) return true;
  return false;
}

function truncate(text: string, max: number): string {
  if (text.length <= max) return text;
  return text.slice(0, max) + `\n…[truncated ${text.length - max} of ${text.length} chars]`;
}

/** A few lines of context around the first occurrence of `needle` in `content`. */
function snippetAround(content: string, index: number, needleLen: number): string {
  const before = content.slice(0, index).split("\n");
  const startLine = Math.max(0, before.length - 1 - SNIPPET_CONTEXT_LINES);
  const afterIdx = index + needleLen;
  const upto = content.slice(0, afterIdx).split("\n").length; // 1-based line of the change end
  const lines = content.split("\n");
  const endLine = Math.min(lines.length, upto + SNIPPET_CONTEXT_LINES);
  return lines.slice(startLine, endLine).join("\n");
}

export const editFileTool = defineTool({
  name: "edit_file",
  description:
    "Make a surgical edit to an existing text file: replace an exact `old_string` with " +
    "`new_string`, leaving the rest of the file unchanged. `old_string` must match EXACTLY " +
    "(whitespace and all) and must be UNIQUE in the file — include enough surrounding context " +
    "to pin it down, or pass `replace_all` to replace every occurrence. Use write_file to create " +
    "a new file or overwrite one wholesale. If an edit reports 'not found', re-read the file " +
    "before retrying — it may already have been applied.",
  risk: "low",
  mutates: true,
  schema: z.object({
    path: z.string().min(1).describe("File path, relative to the working directory or absolute."),
    old_string: z.string().min(1).describe("The exact text to replace (must match uniquely unless replace_all)."),
    new_string: z.string().describe("The replacement text."),
    replace_all: z.boolean().default(false).describe("Replace every occurrence instead of requiring a unique match."),
  }),
  handler: async ({ path, old_string, new_string, replace_all }, ctx) => {
    const abs = resolveInWorkspace(ctx, path); // throws on workspace escape (engine → isError)

    // Guard order matches ADR-0006 §3: file-exists → no-op → binary, so a missing
    // file reports "not found" rather than being masked by a no-op or binary check.
    let buf: Buffer;
    try {
      buf = await readFile(abs);
    } catch {
      return `File not found: ${path}. Use write_file to create a new file.`;
    }
    if (old_string === new_string) {
      return "No change: old_string and new_string are identical.";
    }
    if (looksBinary(buf)) return `Refused: ${path} looks binary — edit_file only edits text files.`;

    const content = buf.toString("utf8");
    const occurrences = content.split(old_string).length - 1;
    if (occurrences === 0) {
      return `old_string not found in ${path}. Re-read the file and copy the exact text (whitespace included).`;
    }
    if (occurrences > 1 && !replace_all) {
      return (
        `old_string occurs ${occurrences} times in ${path}. Add surrounding context to make it ` +
        `unique, or pass replace_all to replace all ${occurrences}.`
      );
    }

    const firstIndex = content.indexOf(old_string);
    const updated = replace_all
      ? content.split(old_string).join(new_string)
      : content.slice(0, firstIndex) + new_string + content.slice(firstIndex + old_string.length);

    await writeFile(abs, updated, "utf8");

    const snippet = truncate(snippetAround(updated, firstIndex, new_string.length), EDIT_SNIPPET_MAX);
    const what = replace_all ? `replaced ${occurrences} occurrence(s)` : "replaced 1 occurrence";
    return `Edited ${path}: ${what}.\n--- updated region ---\n${snippet}`;
  },
});
