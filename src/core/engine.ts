/**
 * The single-step driver — P1's core.
 *
 * It performs exactly ONE tool-call round-trip to prove the mechanics end to
 * end: model turn → (if a tool is requested) execute tools in parallel → feed
 * the results back → one more model turn → return the final answer. If the very
 * first turn needs no tool, it returns immediately.
 *
 * This is deliberately NOT the generalized loop. The `while`/maxSteps iteration,
 * termination policy, and compaction are P2+. Keeping the tool-execution and
 * event-emission mechanics here means the P2 loop is a small generalization.
 *
 * See docs/our-agent-design.md §4 and the P1 spec (issue #1).
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
  events?: EventEmitter;
}

export interface RunResult {
  text: string;
  messages: Message[];
  /** How many model turns were taken (1 = answered without a tool; 2 = round-trip). */
  turns: number;
}

export async function runToolCall(userInput: string, opts: RunOptions): Promise<RunResult> {
  const events = opts.events ?? new EventEmitter();
  const ctx: ToolContext = { cwd: opts.cwd ?? process.cwd() };
  const toolSpecs = opts.registry.list();
  const messages: Message[] = [userText(userInput)];
  let turns = 0;

  async function runTurn(step: number): Promise<AssistantTurn> {
    events.emit({ type: "turn_start", step });
    const turn = await opts.provider.generate({
      system: opts.system,
      messages,
      tools: toolSpecs,
      maxTokens: opts.maxTokens,
    });
    turns = step;
    messages.push(turn.message);
    for (const block of turn.message.content) {
      if (block.type === "text" && block.text) {
        events.emit({ type: "text", text: block.text });
      } else if (block.type === "thinking") {
        events.emit({ type: "thinking", text: block.text });
      } else if (block.type === "tool_use") {
        events.emit({ type: "tool_call", id: block.id, name: block.name, input: block.input });
      }
    }
    return turn;
  }

  async function executeTool(use: ToolUseBlock): Promise<ToolResultBlock> {
    const tool = opts.registry.get(use.name);
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
          // Recover, don't crash: feed the error back so the model can react.
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

  function finish(turn: AssistantTurn): RunResult {
    const text = textOf(turn.message);
    events.emit({ type: "step_complete", step: turns, stopReason: turn.stopReason });
    events.emit({ type: "done", text, turns });
    return { text, messages, turns };
  }

  const first = await runTurn(1);
  if (first.stopReason !== "tool_use") {
    return finish(first);
  }

  const uses = toolUsesOf(first.message);
  const results = await Promise.all(uses.map((u) => executeTool(u)));
  messages.push(toolResults(results));
  events.emit({ type: "step_complete", step: 1, stopReason: first.stopReason });

  const second = await runTurn(2);
  return finish(second);
}
