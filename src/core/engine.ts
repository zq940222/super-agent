/**
 * The agent loop — P2.
 *
 * Generalizes P1's single round-trip into a real ReAct loop: repeat
 * `model turn → execute tools → feed results back` until the model answers
 * without calling a tool (`end_turn`), bounded by a hard `maxSteps` cap.
 *
 * Termination:
 *   - `end_turn`        → done, `stoppedBy: "end_turn"`.
 *   - `maxSteps` reached → stop with the partial result, `stoppedBy: "max_steps"`,
 *                          and an `error` event. Always keep the hard cap.
 *
 * Error recovery: a tool that errors (unknown / invalid input / throws) returns
 * a `tool_result` with `isError: true` and the loop CONTINUES, so the model can
 * react — a bad tool call never crashes the run.
 *
 * See docs/our-agent-design.md §4 and issue #3.
 */

import type { AssistantTurn, Message, ToolResultBlock, ToolUseBlock } from "./types";
import { textOf, toolResults, toolUsesOf, userText } from "./types";
import type { ModelProvider } from "../providers/provider";
import type { ToolContext, ToolRegistry } from "../tools/registry";
import { EventEmitter } from "./events";

export interface RunOptions {
  provider: ModelProvider;
  registry: ToolRegistry;
  system?: string;
  cwd?: string;
  maxTokens?: number;
  /** Hard cap on model turns. Default 10. */
  maxSteps?: number;
  events?: EventEmitter;
}

export type StoppedBy = "end_turn" | "max_steps";

export interface RunResult {
  text: string;
  messages: Message[];
  /** Model turns taken. */
  steps: number;
  stoppedBy: StoppedBy;
}

export async function runAgent(userInput: string, opts: RunOptions): Promise<RunResult> {
  const events = opts.events ?? new EventEmitter();
  const ctx: ToolContext = { cwd: opts.cwd ?? process.cwd() };
  const toolSpecs = opts.registry.list();
  const maxSteps = opts.maxSteps ?? 10;
  const messages: Message[] = [userText(userInput)];
  let lastTurn: AssistantTurn | undefined;

  for (let step = 1; step <= maxSteps; step++) {
    events.emit({ type: "turn_start", step });
    const turn = await opts.provider.generate({
      system: opts.system,
      messages,
      tools: toolSpecs,
      maxTokens: opts.maxTokens,
    });
    lastTurn = turn;
    messages.push(turn.message);
    emitTurnBlocks(turn, events);

    if (turn.stopReason !== "tool_use") {
      const text = textOf(turn.message);
      events.emit({ type: "step_complete", step, stopReason: turn.stopReason });
      events.emit({ type: "done", text, steps: step });
      return { text, messages, steps: step, stoppedBy: "end_turn" };
    }

    // Execute every requested tool in parallel; errors come back as results.
    const uses = toolUsesOf(turn.message);
    const results = await Promise.all(uses.map((u) => executeTool(u, opts.registry, ctx, events)));
    messages.push(toolResults(results));
    events.emit({ type: "step_complete", step, stopReason: turn.stopReason });
  }

  // Loop exhausted while the model still wanted tools.
  const text = lastTurn ? textOf(lastTurn.message) : "";
  events.emit({ type: "error", message: `Reached maxSteps (${maxSteps}) without completing.` });
  events.emit({ type: "done", text, steps: maxSteps });
  return { text, messages, steps: maxSteps, stoppedBy: "max_steps" };
}

function emitTurnBlocks(turn: AssistantTurn, events: EventEmitter): void {
  for (const block of turn.message.content) {
    if (block.type === "text" && block.text) {
      events.emit({ type: "text", text: block.text });
    } else if (block.type === "thinking") {
      events.emit({ type: "thinking", text: block.text });
    } else if (block.type === "tool_use") {
      events.emit({ type: "tool_call", id: block.id, name: block.name, input: block.input });
    }
  }
}

async function executeTool(
  use: ToolUseBlock,
  registry: ToolRegistry,
  ctx: ToolContext,
  events: EventEmitter,
): Promise<ToolResultBlock> {
  const tool = registry.get(use.name);
  let block: ToolResultBlock;

  if (!tool) {
    block = { type: "tool_result", toolUseId: use.id, content: `Unknown tool: ${use.name}`, isError: true };
  } else {
    const validation = tool.validate ? tool.validate(use.input) : null;
    if (validation && !validation.ok) {
      block = {
        type: "tool_result",
        toolUseId: use.id,
        content: `Invalid input for ${use.name}: ${validation.error}`,
        isError: true,
      };
    } else {
      const input = validation && validation.ok ? validation.value : use.input;
      try {
        const output = await tool.handler(input, ctx);
        block = { type: "tool_result", toolUseId: use.id, content: String(output), isError: false };
      } catch (err) {
        block = {
          type: "tool_result",
          toolUseId: use.id,
          content: err instanceof Error ? err.message : String(err),
          isError: true,
        };
      }
    }
  }

  events.emit({
    type: "tool_result",
    toolUseId: use.id,
    name: use.name,
    content: block.content,
    isError: block.isError ?? false,
  });
  return block;
}
