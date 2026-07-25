#!/usr/bin/env bun
/**
 * Web UI entry (P13-4) — `bun run web`.
 *
 * Bootstraps a session runtime and serves the built single-file client behind
 * the auth gate. Prints a URL carrying the per-session token; open it in a
 * browser. Localhost, single session. See ADR-0003.
 *
 * Build the client first (one-time): `cd web && bun install && bun run build`.
 */

import { readFileSync } from "node:fs";
import { join } from "node:path";
import { bootstrap, type Runtime } from "../runtime/bootstrap";
import { resolveWorkspace } from "../runtime/workspace";
import { serve } from "./server";
import { createRollout } from "../session/rollout";
import type { PermissionMode } from "../permissions/gate";

async function main(): Promise<void> {
  const mode = (process.env.AGENT_PERMISSION_MODE as PermissionMode) || "default";
  const port = Number(process.env.AGENT_WEB_PORT) || 8787;

  // The built single-file client (ADR-0003 §6).
  let indexHtml: string;
  try {
    indexHtml = readFileSync(join(import.meta.dir, "../../web/dist/index.html"), "utf8");
  } catch {
    process.stderr.write("web client not built. Run: cd web && bun install && bun run build\n");
    process.exit(1);
  }

  // No `approve` here on purpose: subagents' ask-tier tools auto-deny (they don't
  // route through the browser approval bridge in v1 — see ADR-0003 §4). Only the
  // main loop's approvals prompt the browser.
  let runtime: Runtime;
  try {
    runtime = await bootstrap({ mode });
  } catch (err) {
    process.stderr.write(`${err instanceof Error ? err.message : String(err)}\n`);
    process.exit(1);
  }

  const token = crypto.randomUUID();
  const origin = `http://localhost:${port}`;
  const workspaceRoot = resolveWorkspace();
  const rollout = createRollout(`.agent/sessions/web-${Date.now()}.jsonl`);
  serve({ runtime, token, origin, indexHtml, workspaceRoot, rollout, port });

  process.stdout.write(`\nsuper-agent web UI · ${runtime.provider.name} · permissions: ${mode}\n`);
  process.stdout.write(`  open   ${origin}/?token=${token}\n`);
  process.stdout.write(`  files  ${workspaceRoot}\n`);
  process.stdout.write(`  (Ctrl-C to stop)\n\n`);
}

main();
