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
import { readFileTool } from "../tools/read-file";
import { listDirTool } from "../tools/list-dir";
import { ToolRegistry } from "../tools/registry";

const SYSTEM = [
  "You are super-agent, a general-purpose assistant running in a terminal.",
  "You can call tools: list_dir to explore directories and read_file to read files.",
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
  process.stdout.write(`${DIM}(backend: ${provider.name})${RESET}\n`);

  const registry = new ToolRegistry().register(readFileTool).register(listDirTool);
  const events = new EventEmitter().on(render);

  try {
    await runAgent(prompt, { provider, registry, system: SYSTEM, events });
  } catch (err) {
    process.stderr.write(`error: ${err instanceof Error ? err.message : String(err)}\n`);
    process.exit(1);
  }
}

main();
