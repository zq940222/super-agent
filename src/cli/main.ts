#!/usr/bin/env bun
/**
 * Minimal CLI front-end — a thin client of the agent loop that renders the
 * typed event stream. Usage:
 *   bun run agent "list the src dir, then tell me what engine.ts does"
 *   echo "summarize ./README.md" | bun run agent
 */

import { runAgent } from "../core/engine";
import { EventEmitter, type AgentEvent } from "../core/events";
import { createProvider } from "../providers/factory";
import type { ModelProvider } from "../providers/provider";
import { PermissionPolicy, type PermissionMode, type PermissionRequest } from "../permissions/gate";
import { readFileTool } from "../tools/read-file";
import { listDirTool } from "../tools/list-dir";
import { writeFileTool } from "../tools/write-file";
import { ToolRegistry } from "../tools/registry";

const SYSTEM = [
  "You are super-agent, a general-purpose assistant running in a terminal.",
  "You can call tools: list_dir to explore directories, read_file to read files,",
  "and write_file to create or overwrite files.",
  "Break the task into steps, use tools to gather what you need,",
  "and when you have enough information, answer the user directly and concisely.",
].join(" ");

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
    case "done":
      process.stdout.write(`\n${BOLD}${event.text}${RESET}\n`);
      break;
    case "error":
      process.stderr.write(`${DIM}(${event.message})${RESET}\n`);
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

  let provider: ModelProvider;
  try {
    provider = createProvider();
  } catch (err) {
    process.stderr.write(`${err instanceof Error ? err.message : String(err)}\n`);
    process.exit(1);
  }
  const mode = (process.env.AGENT_PERMISSION_MODE as PermissionMode) || "default";
  process.stdout.write(`${DIM}(backend: ${provider.name} · permissions: ${mode})${RESET}\n`);

  const registry = new ToolRegistry()
    .register(readFileTool)
    .register(listDirTool)
    .register(writeFileTool);
  const policy = new PermissionPolicy({ mode });
  const events = new EventEmitter().on(render);

  try {
    await runAgent(prompt, {
      provider,
      registry,
      system: SYSTEM,
      policy,
      approve,
      workspaceRoot: process.cwd(),
      events,
    });
  } catch (err) {
    process.stderr.write(`error: ${err instanceof Error ? err.message : String(err)}\n`);
    process.exit(1);
  }
}

/** HITL approver: prompt on the terminal. Non-interactive (piped) ⇒ deny. */
async function approve(req: PermissionRequest): Promise<boolean> {
  if (!process.stdin.isTTY) return false;
  const answer = prompt(`${BOLD}🔐 Allow ${req.name}(${preview(JSON.stringify(req.input), 60)})? [y/N]${RESET}`);
  return (answer ?? "").trim().toLowerCase().startsWith("y");
}

main();
