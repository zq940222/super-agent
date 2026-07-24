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
  const abs = resolve(ctx.cwd, path);
  if (ctx.workspaceRoot) {
    const root = resolve(ctx.workspaceRoot);
    const rel = relative(root, abs);
    const firstSegment = rel.split(sep)[0];
    if (isAbsolute(rel) || firstSegment === "..") {
      throw new Error(`Path escapes the workspace root: ${path}`);
    }
  }
  return abs;
}
