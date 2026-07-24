import { test, expect } from "bun:test";
import { runAgent } from "../src/core/engine";
import { EventEmitter, type AgentEvent } from "../src/core/events";
import { ToolRegistry, defineTool } from "../src/tools/registry";
import { z } from "zod";
import type { GenerateRequest, ModelProvider } from "../src/providers/provider";
import type { AssistantTurn, Message } from "../src/core/types";
import { userText } from "../src/core/types";
import type { RolloutRecorder } from "../src/session/rollout";

const usage = { inputTokens: 0, outputTokens: 0 };

function endTurn(text: string): AssistantTurn {
  return { message: { role: "assistant", content: [{ type: "text", text }] }, stopReason: "end_turn", usage };
}
function toolUseTurn(id: string, name: string, input: unknown): AssistantTurn {
  return {
    message: { role: "assistant", content: [{ type: "tool_use", id, name, input }] },
    stopReason: "tool_use",
    usage,
  };
}

class ScriptedProvider implements ModelProvider {
  readonly name = "scripted";
  calls: GenerateRequest[] = [];
  private i = 0;
  constructor(private turns: AssistantTurn[]) {}
  async generate(req: GenerateRequest): Promise<AssistantTurn> {
    this.calls.push(structuredClone(req));
    const turn = this.turns[this.i++];
    if (!turn) throw new Error("ScriptedProvider ran out of scripted turns");
    return turn;
  }
}

/** Captures every rollout call so we can assert what was (and wasn't) recorded. */
class CapturingRollout implements RolloutRecorder {
  readonly path = "<memory>";
  metas: Record<string, unknown>[] = [];
  messages: Message[] = [];
  async recordMeta(meta: Record<string, unknown>): Promise<void> {
    this.metas.push(meta);
  }
  async recordMessage(message: Message): Promise<void> {
    this.messages.push(message);
  }
}

const echoTool = defineTool({
  name: "echo",
  description: "Echo back the given value.",
  schema: z.object({ value: z.string() }),
  handler: ({ value }) => `echoed: ${value}`,
});

// --- §2: multi-turn history seeding ---

test("history is prepended before the new user input in the model request", async () => {
  const provider = new ScriptedProvider([endTurn("answer 2")]);
  const registry = new ToolRegistry().register(echoTool);
  const history: Message[] = [
    userText("first question"),
    { role: "assistant", content: [{ type: "text", text: "answer 1" }] },
  ];

  const res = await runAgent("second question", { provider, registry, history });

  // The one request the model saw must be history + the new user message.
  expect(provider.calls[0]!.messages).toEqual([...history, userText("second question")]);
  // The returned conversation carries history → new input → this turn's answer.
  expect(res.messages).toEqual([...history, userText("second question"), endTurn("answer 2").message]);
});

// --- §2: rollout continuation contract (delta-only + single meta) ---

test("a continued conversation records only the delta and writes meta once", async () => {
  const registry = new ToolRegistry().register(echoTool);
  const rollout = new CapturingRollout();

  const p1 = new ScriptedProvider([endTurn("a1")]);
  const r1 = await runAgent("q1", { provider: p1, registry, rollout });

  // Turn 2 continues from turn 1's returned messages, same rollout.
  const p2 = new ScriptedProvider([endTurn("a2")]);
  await runAgent("q2", { provider: p2, registry, rollout, history: r1.messages });

  // Meta is a once-per-conversation line — not re-written on the continuation.
  expect(rollout.metas.length).toBe(1);

  // The rollout is the whole transcript with NO duplicated history: each message once.
  expect(rollout.messages).toEqual([
    userText("q1"),
    endTurn("a1").message,
    userText("q2"),
    endTurn("a2").message,
  ]);
});

test("a completed tool-using turn's messages are well-formed as next-turn history", async () => {
  const registry = new ToolRegistry().register(echoTool);

  // Turn 1 calls a tool, then answers — so its messages carry a tool_use/tool_result pair.
  const p1 = new ScriptedProvider([toolUseTurn("t1", "echo", { value: "x" }), endTurn("a1")]);
  const r1 = await runAgent("q1", { provider: p1, registry });
  expect(r1.messages.map((m) => m.content.map((b) => b.type))).toEqual([
    ["text"], // user q1
    ["tool_use"], // assistant
    ["tool_result"], // user (tool results)
    ["text"], // assistant a1
  ]);

  // Turn 2 continues from that full history — the tool blocks must survive intact.
  const p2 = new ScriptedProvider([endTurn("a2")]);
  const r2 = await runAgent("q2", { provider: p2, registry, history: r1.messages });

  expect(p2.calls[0]!.messages).toEqual([...r1.messages, userText("q2")]);
  expect(r2.text).toBe("a2");
});

test("the first turn (no history) still records meta and the initial user message", async () => {
  const registry = new ToolRegistry().register(echoTool);
  const rollout = new CapturingRollout();
  const provider = new ScriptedProvider([endTurn("hi")]);

  await runAgent("hello", { provider, registry, rollout });

  expect(rollout.metas).toEqual([{ provider: "scripted" }]);
  expect(rollout.messages).toEqual([userText("hello"), endTurn("hi").message]);
});

// --- §3: cooperative cancellation ---

test("an already-aborted signal stops before the first model turn", async () => {
  const provider = new ScriptedProvider([endTurn("never reached")]);
  const registry = new ToolRegistry().register(echoTool);
  const controller = new AbortController();
  controller.abort();
  const seen: AgentEvent[] = [];
  const events = new EventEmitter().on((e) => seen.push(e));

  const res = await runAgent("go", { provider, registry, signal: controller.signal, events });

  expect(res.stoppedBy).toBe("cancelled");
  expect(res.steps).toBe(0);
  expect(provider.calls.length).toBe(0); // no model call happened
  expect(seen.map((e) => e.type)).toEqual(["cancelled"]);
  expect(seen.find((e) => e.type === "cancelled")).toEqual({ type: "cancelled", step: 0 });
});

test("aborting during tool execution stops the loop after the current step", async () => {
  const controller = new AbortController();
  // A tool that aborts the run as a side effect — trips the post-tool checkpoint.
  const abortingTool = defineTool({
    name: "abort_now",
    description: "Aborts the run.",
    schema: z.object({}),
    handler: () => {
      controller.abort();
      return "aborted";
    },
  });
  const registry = new ToolRegistry().register(abortingTool);
  // Would keep going to a final answer if not cancelled.
  const provider = new ScriptedProvider([toolUseTurn("t1", "abort_now", {}), endTurn("should not reach")]);
  const seen: AgentEvent[] = [];
  const events = new EventEmitter().on((e) => seen.push(e));

  const res = await runAgent("go", { provider, registry, signal: controller.signal, events });

  expect(res.stoppedBy).toBe("cancelled");
  expect(res.steps).toBe(1);
  expect(provider.calls.length).toBe(1); // only the first (tool_use) turn ran
  expect(seen.at(-1)).toEqual({ type: "cancelled", step: 1 });
  expect(seen.some((e) => e.type === "done")).toBe(false); // cancel is terminal, not "done"
});
