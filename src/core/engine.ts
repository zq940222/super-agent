/**
 * The agent loop — P2, with the permission gate added in P5.
 *
 * Repeats `model turn → execute tools → feed results back` until the model
 * answers without a tool (`end_turn`), bounded by a hard `maxSteps` cap.
 *
 * Before any tool runs, a PermissionPolicy classifies it as allow / ask / deny
 * (P5). `ask` invokes the HITL `approve` callback; with no approver, `ask` is
 * treated as deny (safe default). A denied tool returns an `isError` result and
 * the loop CONTINUES, so the model is told and can adapt. Permission decisions
 * for a turn are resolved sequentially (so HITL prompts don't interleave);
 * execution of the allowed tools stays parallel.
 *
 * See docs/our-agent-design.md §4, and issues #3 (loop) and #7 (permissions).
 */

import type { AssistantTurn, Message, ToolResultBlock, ToolUseBlock } from "./types";
import { textOf, toolResults, toolUsesOf, userText } from "./types";
import type { ModelProvider } from "../providers/provider";
import type { ToolContext, ToolRegistry } from "../tools/registry";
import { type Approver, PermissionPolicy } from "../permissions/gate";
import { EventEmitter } from "./events";

export interface RunOptions {
  provider: ModelProvider;
  registry: ToolRegistry;
  system?: string;
  cwd?: string;
  /** If set, file tools reject paths escaping it (passed to ToolContext). */
  workspaceRoot?: string;
  maxTokens?: number;
  /** Hard cap on model turns. Default 10. */
  maxSteps?: number;
  /** How tool calls are gated. Default: PermissionPolicy() (mode "default"). */
  policy?: PermissionPolicy;
  /** HITL callback for `ask` decisions. Absent ⇒ `ask` is denied. */
  approve?: Approver;
  events?: EventEmitter;
}

export type StoppedBy = "end_turn" | "max_steps";

export interface RunResult {
  text: string;
  messages: Message[];
  steps: number;
  stoppedBy: StoppedBy;
}

export async function runAgent(userInput: string, opts: RunOptions): Promise<RunResult> {
  const events = opts.events ?? new EventEmitter();
  const ctx: ToolContext = { cwd: opts.cwd ?? process.cwd(), workspaceRoot: opts.workspaceRoot };
  const toolSpecs = opts.registry.list();
  const policy = opts.policy ?? new PermissionPolicy();
  const maxSteps = opts.maxSteps ?? 10;
  const messages: Message[] = [userText(userInput)];
  let lastTurn: AssistantTurn | undefined;

  async function runTurn(step: number): Promise<AssistantTurn> {
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
    return turn;
  }

  for (let step = 1; step <= maxSteps; step++) {
    const turn = await runTurn(step);

    if (turn.stopReason !== "tool_use") {
      const text = textOf(turn.message);
      events.emit({ type: "step_complete", step, stopReason: turn.stopReason });
      events.emit({ type: "done", text, steps: step });
      return { text, messages, steps: step, stoppedBy: "end_turn" };
    }

    const uses = toolUsesOf(turn.message);
    const results = await gateAndExecute(uses, opts.registry, policy, opts.approve, ctx, events);
    messages.push(toolResults(results));
    events.emit({ type: "step_complete", step, stopReason: turn.stopReason });
  }

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

interface Plan {
  use: ToolUseBlock;
  allowed: boolean;
  reason?: string;
}

/**
 * Decide permissions sequentially (HITL prompts must not interleave), then run
 * the allowed tools in parallel. Denied tools become error results.
 */
async function gateAndExecute(
  uses: ToolUseBlock[],
  registry: ToolRegistry,
  policy: PermissionPolicy,
  approve: Approver | undefined,
  ctx: ToolContext,
  events: EventEmitter,
): Promise<ToolResultBlock[]> {
  const plans: Plan[] = [];
  for (const use of uses) {
    const tool = registry.get(use.name);
    // Unknown tool: let executeTool produce the "Unknown tool" error result.
    if (!tool) {
      plans.push({ use, allowed: true });
      continue;
    }

    const decision = policy.decide({ name: use.name, risk: tool.risk });
    if (decision === "allow") {
      plans.push({ use, allowed: true });
      continue;
    }
    if (decision === "deny") {
      events.emit({ type: "permission_decision", name: use.name, decision: "deny" });
      plans.push({ use, allowed: false, reason: "denied by policy" });
      continue;
    }

    // decision === "ask" → human-in-the-loop
    events.emit({ type: "permission_request", name: use.name, input: use.input, risk: tool.risk });
    const ok = approve ? await approve({ name: use.name, input: use.input, risk: tool.risk }) : false;
    events.emit({ type: "permission_decision", name: use.name, decision: ok ? "allow" : "deny" });
    plans.push(
      ok
        ? { use, allowed: true }
        : { use, allowed: false, reason: approve ? "denied by user" : "no approver configured" },
    );
  }

  return Promise.all(
    plans.map(async (p) => {
      if (p.allowed) return executeTool(p.use, registry, ctx, events);
      const block: ToolResultBlock = {
        type: "tool_result",
        toolUseId: p.use.id,
        content: `Permission denied: ${p.use.name} — ${p.reason ?? "not allowed"}`,
        isError: true,
      };
      events.emit({ type: "tool_result", toolUseId: p.use.id, name: p.use.name, content: block.content, isError: true });
      return block;
    }),
  );
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
