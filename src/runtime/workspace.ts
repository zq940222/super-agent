/**
 * Where the agent's file tools are confined — a dedicated workspace directory,
 * kept separate from the agent's own source (the OpenClaw "per-agent workspace"
 * pattern; see docs/agent-research.md §3.4).
 *
 * Without this, `workspaceRoot` defaults to the launch cwd — and since you run
 * `bun run web/tui/agent` from the repo, generated files land in the source
 * tree. This resolves a dedicated dir instead:
 *   - `$AGENT_WORKSPACE` if set (e.g. point it at a project to work on), else
 *   - `./workspace` relative to the cwd (created here, gitignored).
 *
 * `read_file` / `list_dir` / `write_file` are all bounded to this root
 * (resolveInWorkspace), so both reads and writes stay inside it.
 */

import { mkdirSync } from "node:fs";
import { resolve } from "node:path";

export function resolveWorkspace(): string {
  const root = resolve(process.env.AGENT_WORKSPACE ?? "workspace");
  try {
    mkdirSync(root, { recursive: true });
  } catch (err) {
    throw new Error(
      `Cannot use workspace "${root}": ${err instanceof Error ? err.message : String(err)}. ` +
        `Set AGENT_WORKSPACE to a writable directory.`,
    );
  }
  return root;
}
