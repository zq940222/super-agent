/**
 * Workspace boundary — a lightweight blast-radius limit for file tools.
 *
 * When a `workspaceRoot` is set on the tool context, resolved paths that escape
 * it are rejected. This bounds what a coerced/confused agent can read or write
 * (a partial mitigation of the "lethal trifecta"). With no `workspaceRoot`,
 * paths are unrestricted (back-compat). See issue #7.
 */

import { isAbsolute, relative, resolve, sep } from "node:path";
import type { ToolContext } from "./registry";

export function resolveInWorkspace(ctx: ToolContext, path: string): string {
  // With no workspace, resolve against cwd and don't restrict (back-compat).
  if (!ctx.workspaceRoot) return resolve(ctx.cwd, path);

  // The workspace IS the agent's effective working directory: a RELATIVE path
  // resolves inside it (so `./notes.md` lands in the workspace, not the launch
  // cwd), and anything that escapes it — via `..` or an absolute path — is rejected.
  const root = resolve(ctx.workspaceRoot);
  const abs = resolve(root, path);
  const rel = relative(root, abs);
  if (isAbsolute(rel) || rel.split(sep)[0] === "..") {
    throw new Error(`Path escapes the workspace root: ${path}`);
  }
  return abs;
}

/**
 * A glob pattern is matched relative to a base dir, but Bun's `Glob.scan` honors
 * `..` segments — so `../*.txt` escapes the base and reads sibling files. The
 * per-path `resolveInWorkspace` guard doesn't cover the *pattern*, so search
 * tools (glob, grep) must reject escaping patterns up front. Returns an error
 * message, or null if the pattern is safe.
 *
 * Deliberately conservative: it rejects any `..` path segment, so a benign
 * `a/../b` is refused too. That's a false-positive, not a hole — the safe
 * alternative (resolve-then-check each match) is what this exists to avoid.
 */
export function unsafeGlobPattern(pattern: string): string | null {
  if (isAbsolute(pattern) || pattern.startsWith("/")) {
    return `Refused: absolute glob patterns aren't allowed ("${pattern}"). Use a path relative to the working directory.`;
  }
  if (pattern.split(/[/\\]/).includes("..")) {
    return `Refused: a glob pattern can't escape the working directory with ".." ("${pattern}").`;
  }
  return null;
}
