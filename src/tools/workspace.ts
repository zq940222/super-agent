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
