/**
 * The agent loop.
 *
 * Repeats `model turn → execute tools → feed results back` until the model
 * answers without a tool (`end_turn`), bounded by a hard `maxSteps` cap (P2).
 *
 * Before any tool runs, a PermissionPolicy classifies it as allow / ask / deny
 * (P5). `ask` invokes the HITL `approve` callback; with no approver, `ask` is a
 * deny. A denied tool returns an `isError` result and the loop CONTINUES.
 *
 * Between steps, if the estimated context exceeds `maxContextTokens`, the older
 * history is compacted into a summary (P4). When a `rollout` is provided, the
 * raw message stream (pre-compaction) is persisted as append-only JSONL.
 *
 * See docs/our-agent-design.md §4 and issues #3, #7, #9.
 */

import type { AssistantTurn, Message, ToolResultBlock, ToolUseBlock } from "./types";
import { textOf, toolResults, toolUsesOf, userText } from "./types";
import type { GenerateRequest, ModelProvider } from "../providers/provider";
import type { ToolContext, ToolRegistry } from "../tools/registry";
import { type Approver, PermissionPolicy } from "../permissions/gate";
import { type Summarizer, compact, estimateTokens, providerSummarizer } from "./compaction";
import type { RolloutRecorder } from "../session/rollout";
import { EventEmitter } from "./events";

/** Default context budget — high enough to stay dormant on short runs. */
export const DEFAULT_MAX_CONTEXT_TOKENS = 96_000;

export interface RunOptions {
  provider: ModelProvider;
  registry: ToolRegistry;
  system?: string;
  cwd?: string;
  workspaceRoot?: string;
  maxTokens?: number;
  /** Hard cap on model turns. Default 10. */
  maxSteps?: number;
  policy?: PermissionPolicy;
  approve?: Approver;
  /** Compact when the estimate exceeds this. Default DEFAULT_MAX_CONTEXT_TOKENS. */
  maxContextTokens?: number;
  /** Recent messages kept verbatim during compaction. */
  keepRecent?: number;
  /** Override the summarizer (default: provider-based). */
  summarize?: Summarizer;
  /** If set, the raw message stream is persisted here. */
  rollout?: RolloutRecorder;
  events?: EventEmitter;
  /**
   * Prior conversation to continue (multi-turn frontends like the TUI). The new
   * user input is appended after it. When set, this run is a *continuation*: only
   * the delta is recorded to the rollout (see below) and no fresh meta line is
   * written — the same rollout spans the whole conversation. See ADR-0001 §2.
   */
  history?: Message[];
  /**
   * Cancellation. Checked between steps and forwarded to the provider call, so a
   * model request already in flight aborts too (ADR-0001 §3). On abort the loop
   * stops and emits a `cancelled` event.
   */
  signal?: AbortSignal;
  /**
   * Opt in to token streaming (main-loop frontends like the TUI). When set and
   * `provider.stream` exists, the engine consumes the stream and emits
   * `text_delta` events; otherwise it uses `generate()`. Subagents leave this
   * off, so their output arrives whole. See ADR-0002.
   */
  stream?: boolean;
}

export type StoppedBy = "end_turn" | "max_steps" | "cancelled";

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
  const budget = opts.maxContextTokens ?? DEFAULT_MAX_CONTEXT_TOKENS;
  const summarize = opts.summarize ?? providerSummarizer(opts.provider);

  // Multi-turn (ADR-0001 §2): seed prior history, then this turn's input. On a
  // continuation we record only the delta — the new user message here, plus the
  // assistant/tool messages produced below — and skip the once-per-session meta.
  const isContinuation = (opts.history?.length ?? 0) > 0;
  const newUserMessage = userText(userInput);
  let messages: Message[] = [...(opts.history ?? []), newUserMessage];
  let lastTurn: AssistantTurn | undefined;

  if (!isContinuation) await opts.rollout?.recordMeta({ provider: opts.provider.name });
  await record(newUserMessage);

  async function record(message: Message): Promise<void> {
    await opts.rollout?.recordMessage(message);
  }

  function cancelled(completedSteps: number): RunResult {
    const text = lastTurn ? textOf(lastTurn.message) : "";
    events.emit({ type: "cancelled", step: completedSteps });
    return { text, messages, steps: completedSteps, stoppedBy: "cancelled" };
  }

  async function runTurn(step: number): Promise<AssistantTurn> {
    events.emit({ type: "turn_start", step });
    const req = { system: opts.system, messages, tools: toolSpecs, maxTokens: opts.maxTokens, signal: opts.signal };

    // Stream only when opted in AND the provider supports it; else one whole turn.
    const streaming = Boolean(opts.stream && opts.provider.stream);
    const turn = streaming ? await streamTurn(req) : await opts.provider.generate(req);

    // Shared post-turn tail — identical for both paths, so rollout/history never
    // diverge. The ONLY difference is text emission: a streamed turn already sent
    // its text as deltas, so skip the whole `text` block here (ADR-0002 §4).
    lastTurn = turn;
    messages.push(turn.message);
    await record(turn.message);
    emitTurnBlocks(turn, events, { skipText: streaming });
    return turn;
  }

  /** Consume the provider's stream: emit text deltas, return the assembled turn. */
  async function streamTurn(req: GenerateRequest): Promise<AssistantTurn> {
    let finalTurn: AssistantTurn | undefined;
    for await (const chunk of opts.provider.stream!(req)) {
      if (chunk.type === "text_delta") {
        if (chunk.text) events.emit({ type: "text_delta", text: chunk.text });
      } else {
        finalTurn = chunk.turn;
      }
    }
    if (!finalTurn) throw new Error("provider.stream ended without a done chunk");
    return finalTurn;
  }

  for (let step = 1; step <= maxSteps; step++) {
    if (opts.signal?.aborted) return cancelled(step - 1);

    let turn: AssistantTurn;
    try {
      turn = await runTurn(step);
    } catch (err) {
      // A mid-flight provider abort surfaces as a throw. If it's our signal,
      // report a clean cancellation; any other error is a real failure.
      if (opts.signal?.aborted) return cancelled(step - 1);
      throw err;
    }

    if (turn.stopReason !== "tool_use") {
      const text = textOf(turn.message);
      events.emit({ type: "step_complete", step, stopReason: turn.stopReason });
      events.emit({ type: "done", text, steps: step });
      return { text, messages, steps: step, stoppedBy: "end_turn" };
    }

    const uses = toolUsesOf(turn.message);
    const results = await gateAndExecute(uses, opts.registry, policy, opts.approve, ctx, events);
    const resultsMessage = toolResults(results);
    messages.push(resultsMessage);
    await record(resultsMessage);
    events.emit({ type: "step_complete", step, stopReason: turn.stopReason });

    if (opts.signal?.aborted) return cancelled(step);

    // Compaction (P4): keep the working context under budget between steps.
    if (estimateTokens(messages) > budget) {
      const beforeTokens = estimateTokens(messages);
      try {
        messages = await compact(messages, summarize, { keepRecent: opts.keepRecent, signal: opts.signal });
      } catch (err) {
        // The summarizer is its own in-flight model call; treat its abort as cancel.
        if (opts.signal?.aborted) return cancelled(step);
        throw err;
      }
      const afterTokens = estimateTokens(messages);
      if (afterTokens < beforeTokens) events.emit({ type: "compaction", beforeTokens, afterTokens });
    }
  }

  const text = lastTurn ? textOf(lastTurn.message) : "";
  events.emit({ type: "error", message: `Reached maxSteps (${maxSteps}) without completing.` });
  events.emit({ type: "done", text, steps: maxSteps });
  return { text, messages, steps: maxSteps, stoppedBy: "max_steps" };
}

function emitTurnBlocks(turn: AssistantTurn, events: EventEmitter, opts: { skipText?: boolean } = {}): void {
  for (const block of turn.message.content) {
    if (block.type === "text" && block.text) {
      // When streamed, the text already went out as `text_delta`s — don't re-emit.
      if (!opts.skipText) events.emit({ type: "text", text: block.text });
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

    const decision = policy.decide({ name: use.name, risk: tool.risk, mutates: tool.mutates });
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
