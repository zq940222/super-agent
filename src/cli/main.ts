#!/usr/bin/env bun
/**
 * Minimal CLI front-end — a thin client of the agent loop that renders the
 * typed event stream. Usage:
 *   bun run agent "list the src dir, then tell me what engine.ts does"
 *   echo "summarize ./README.md" | bun run agent
 */

import { runAgent } from "../core/engine";
import { EventEmitter, type AgentEvent } from "../core/events";
import { type PermissionMode, type PermissionRequest } from "../permissions/gate";
import { bootstrap, type Runtime } from "../runtime/bootstrap";
import { createRollout } from "../session/rollout";

const DIM = "\x1b[2m";
const BOLD = "\x1b[1m";
const RESET = "\x1b[0m";

function preview(text: string, n = 80): string {
  const firstLine = text.split("\n")[0] ?? "";
  return firstLine.length > n ? firstLine.slice(0, n) + "…" : firstLine;
}

function render(event: AgentEvent): void {
  switch (event.type) {
    case "turn_start":
      process.stdout.write(`${DIM}→ turn ${event.step}${RESET}\n`);
      break;
    case "tool_call":
      process.stdout.write(`${DIM}  🔧 ${event.name}(${JSON.stringify(event.input)})${RESET}\n`);
      break;
    case "tool_result": {
      const mark = event.isError ? "✗" : "↳";
      process.stdout.write(`${DIM}  ${mark} ${preview(event.content)}${RESET}\n`);
      break;
    }
    case "permission_decision":
      process.stdout.write(`${DIM}  🔐 ${event.name} → ${event.decision}${RESET}\n`);
      break;
    case "compaction":
      process.stdout.write(`${DIM}  ♻ compacted context ${event.beforeTokens}→${event.afterTokens} tokens${RESET}\n`);
      break;
    case "done":
      process.stdout.write(`\n${BOLD}${event.text}${RESET}\n`);
      break;
    case "error":
      process.stderr.write(`${DIM}(${event.message})${RESET}\n`);
      break;
  }
}

/** Render a subagent's events, indented, so nested work is visible. */
function renderChild(event: AgentEvent): void {
  switch (event.type) {
    case "tool_call":
      process.stdout.write(`${DIM}    ↪ ${event.name}(${preview(JSON.stringify(event.input), 50)})${RESET}\n`);
      break;
    case "tool_result":
      process.stdout.write(`${DIM}    ↪ ${event.isError ? "✗" : "·"} ${preview(event.content, 50)}${RESET}\n`);
      break;
    case "done":
      process.stdout.write(`${DIM}    ↪ ⤶ ${preview(event.text, 60)}${RESET}\n`);
      break;
  }
}

async function readPrompt(): Promise<string> {
  const fromArgs = process.argv.slice(2).join(" ").trim();
  if (fromArgs) return fromArgs;
  if (!process.stdin.isTTY) return (await Bun.stdin.text()).trim();
  return "";
}

async function main(): Promise<void> {
  const prompt = await readPrompt();
  if (!prompt) {
    process.stderr.write('usage: bun run agent "<your question>"\n');
    process.exit(1);
  }

  const mode = (process.env.AGENT_PERMISSION_MODE as PermissionMode) || "default";

  // All session-scoped wiring lives in the shared bootstrap; the CLI keeps only
  // its view (render/renderChild) and the per-run main-loop event emitter.
  let runtime: Runtime;
  try {
    runtime = await bootstrap({
      mode,
      approve,
      onChildEvent: renderChild,
      log: (m) => process.stdout.write(`${DIM}(${m})${RESET}\n`),
      logError: (m) => process.stderr.write(`${DIM}(${m})${RESET}\n`),
    });
  } catch (err) {
    process.stderr.write(`${err instanceof Error ? err.message : String(err)}\n`);
    process.exit(1);
  }

  const events = new EventEmitter().on(render);

  const sessionPath = `.agent/sessions/${Date.now()}.jsonl`;
  const rollout = createRollout(sessionPath);
  const maxContextTokens = Number(process.env.AGENT_MAX_CONTEXT_TOKENS) || undefined;

  try {
    await runAgent(prompt, {
      provider: runtime.provider,
      registry: runtime.registry,
      system: runtime.system,
      policy: runtime.policy,
      approve,
      workspaceRoot: process.cwd(),
      maxContextTokens,
      rollout,
      events,
    });
    process.stdout.write(`${DIM}(session: ${sessionPath})${RESET}\n`);
  } catch (err) {
    process.stderr.write(`error: ${err instanceof Error ? err.message : String(err)}\n`);
    process.exitCode = 1;
  } finally {
    await runtime.close();
  }
}

/** HITL approver: prompt on the terminal. Non-interactive (piped) ⇒ deny. */
async function approve(req: PermissionRequest): Promise<boolean> {
  if (!process.stdin.isTTY) return false;
  const answer = prompt(`${BOLD}🔐 Allow ${req.name}(${preview(JSON.stringify(req.input), 60)})? [y/N]${RESET}`);
  return (answer ?? "").trim().toLowerCase().startsWith("y");
}

main();
