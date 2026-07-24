import { test, expect } from "bun:test";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { choiceFromInput, createApprover } from "../src/tui/approver";
import { nextHistory } from "../src/tui/conversation";
import { createPrinter, runRepl } from "../src/tui/app";
import { bootstrap } from "../src/runtime/bootstrap";
import { PermissionPolicy, type PermissionRequest } from "../src/permissions/gate";
import { userText, type AssistantTurn, type Message } from "../src/core/types";
import type { GenerateRequest, ModelProvider, StreamChunk } from "../src/providers/provider";
import type { RunResult } from "../src/core/engine";
import type { RolloutRecorder } from "../src/session/rollout";

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

const userTexts = (messages: Message[]): string[] =>
  messages
    .filter((m) => m.role === "user")
    .flatMap((m) => m.content)
    .filter((b): b is { type: "text"; text: string } => b.type === "text")
    .map((b) => b.text);

const usage = { inputTokens: 0, outputTokens: 0 };
const endTurn = (text: string): AssistantTurn => ({
  message: { role: "assistant", content: [{ type: "text", text }] },
  stopReason: "end_turn",
  usage,
});

class ScriptedProvider implements ModelProvider {
  readonly name = "scripted";
  calls: GenerateRequest[] = [];
  private i = 0;
  constructor(private turns: AssistantTurn[]) {}
  async generate(req: GenerateRequest): Promise<AssistantTurn> {
    // Keep `signal` by reference — AbortSignal isn't structured-cloneable (P-tui-5).
    this.calls.push({ ...req, messages: structuredClone(req.messages) });
    const turn = this.turns[this.i++];
    if (!turn) throw new Error("ScriptedProvider ran out of scripted turns");
    return turn;
  }
}

const tick = (): Promise<void> => new Promise((r) => setTimeout(r, 0));
const req = (name: string): PermissionRequest => ({ name, input: {}, risk: "medium" });

async function withRuntime<T>(provider: ModelProvider, fn: (rt: Awaited<ReturnType<typeof bootstrap>>) => Promise<T>): Promise<T> {
  const base = await mkdtemp(join(tmpdir(), "sa-tui-"));
  const rt = await bootstrap({ provider, loadMcp: false, skillsDir: join(base, "skills") });
  try {
    return await fn(rt);
  } finally {
    await rt.close();
    await rm(base, { recursive: true, force: true });
  }
}

// --- choiceFromInput (pure) ---

test("choiceFromInput maps y/n/a and defaults empty to deny", () => {
  expect(choiceFromInput("y")).toBe("yes");
  expect(choiceFromInput("YES")).toBe("yes");
  expect(choiceFromInput("a")).toBe("always");
  expect(choiceFromInput("n")).toBe("no");
  expect(choiceFromInput("")).toBe("no"); // safe default
  expect(choiceFromInput("huh")).toBeNull(); // re-ask
});

// --- nextHistory (pure) ---

test("nextHistory advances only on end_turn; reverts on cancel/max_steps", () => {
  const before: Message[] = [userText("earlier")];
  const after: Message[] = [...before, { role: "assistant", content: [{ type: "text", text: "new" }] }];
  const mk = (stoppedBy: RunResult["stoppedBy"]): RunResult => ({ text: "", messages: after, steps: 1, stoppedBy });

  expect(nextHistory(before, mk("end_turn"))).toBe(after);
  expect(nextHistory(before, mk("cancelled"))).toBe(before);
  expect(nextHistory(before, mk("max_steps"))).toBe(before);
});

// --- approver: "always" mutates the shared policy ---

test('approver "always" grants a session allow-rule on the shared policy', async () => {
  const policy = new PermissionPolicy(); // default mode
  const approve = createApprover(policy, { ask: async () => "a" });
  expect(policy.decide({ name: "write_file", risk: "medium" })).toBe("ask");

  expect(await approve(req("write_file"))).toBe(true);
  expect(policy.decide({ name: "write_file", risk: "medium" })).toBe("allow");
});

test("approver denies on empty/no and re-asks on garbage", async () => {
  const policy = new PermissionPolicy();
  const answers = ["huh", "n"]; // first unrecognized → re-ask, then deny
  let i = 0;
  const approve = createApprover(policy, { ask: async () => answers[i++]! });
  expect(await approve(req("write_file"))).toBe(false);
  expect(i).toBe(2); // it re-asked
});

// --- approver: SERIALIZED (parallel-subagent safety) ---

test("approver presents concurrent requests one at a time", async () => {
  const policy = new PermissionPolicy();
  const pending: Array<() => void> = [];
  let active = 0;
  let maxActive = 0;
  const io = {
    ask: (): Promise<string> =>
      new Promise((resolve) => {
        active++;
        maxActive = Math.max(maxActive, active);
        pending.push(() => {
          active--;
          resolve("y");
        });
      }),
  };
  const approve = createApprover(policy, io);

  const r1 = approve(req("tool_a"));
  const r2 = approve(req("tool_b"));

  await tick();
  expect(pending.length).toBe(1); // only the first prompt is outstanding
  pending.shift()!();
  expect(await r1).toBe(true);

  await tick();
  expect(pending.length).toBe(1); // now the second, not before
  pending.shift()!();
  expect(await r2).toBe(true);

  expect(maxActive).toBe(1); // never two prompts at once
});

// --- printer: main + child funnel, each line written once ---

test("printer interleaves main and child output, writing each line once", () => {
  const lines: string[] = [];
  const printer = createPrinter((l) => lines.push(l));
  printer.user("do it");
  printer.event({ type: "text", text: "working" }, "main");
  printer.event({ type: "text", text: "sub result" }, "child");
  printer.event({ type: "done", text: "working", steps: 1 }, "main"); // dedup: no new line

  expect(lines.length).toBe(3);
  expect(lines[0]).toContain("do it");
  expect(lines[1]).toContain("working");
  expect(lines[2]!.startsWith("    ")).toBe(true); // child indent
  expect(lines[2]).toContain("sub result");
});

// --- streaming render (ADR-0002 §5): volatile pending + flush-before-whole-line ---

test("printer writes deltas raw, then commits them as a line before the next whole-line event", () => {
  const out: string[] = [];
  const printer = createPrinter((s) => out.push(s));

  printer.event({ type: "text_delta", text: "hel" }, "main");
  printer.event({ type: "text_delta", text: "lo" }, "main");
  expect(out).toEqual(["hel", "lo"]); // raw deltas, nothing committed yet

  printer.event({ type: "tool_call", id: "t1", name: "echo", input: {} }, "main");
  expect(out[2]).toBe("\n"); // pending terminated BEFORE the tool line
  const joined = out.join("");
  expect(joined).toContain("hello");
  expect(joined.indexOf("🔧")).toBeGreaterThan(joined.indexOf("hello")); // tool line after
});

test("printer commits a streamed line exactly once (done adds nothing)", () => {
  const out: string[] = [];
  const printer = createPrinter((s) => out.push(s));
  printer.event({ type: "text_delta", text: "answer" }, "main");
  printer.event({ type: "done", text: "answer", steps: 1 }, "main");
  expect(out.join("")).toBe("answer\n"); // streamed once, committed, no duplicate
});

test("printer commits partial streamed text before a cancellation marker", () => {
  const out: string[] = [];
  const printer = createPrinter((s) => out.push(s));
  printer.event({ type: "text_delta", text: "partial" }, "main");
  printer.event({ type: "cancelled", step: 1 }, "main");
  const joined = out.join("");
  expect(joined.startsWith("partial\n")).toBe(true); // partial preserved, then its line ends
  expect(joined).toContain("⏹"); // cancel marker follows on its own line
});

test("printer.notice commits any half-written stream before the ack line", () => {
  const out: string[] = [];
  const printer = createPrinter((s) => out.push(s));
  printer.event({ type: "text_delta", text: "Hello wor" }, "main"); // mid-token, no newline yet
  printer.notice("  ⏹ interrupting…");
  // The ack must NOT glue onto "Hello wor" — pending is flushed first.
  expect(out.join("")).toBe("Hello wor\n  ⏹ interrupting…\n");
});

test("runRepl streams tokens then commits the line (no duplicate)", async () => {
  const provider: ModelProvider = {
    name: "streaming",
    async generate() {
      return endTurn("(unused)");
    },
    async *stream(): AsyncIterable<StreamChunk> {
      yield { type: "text_delta", text: "hel" };
      yield { type: "text_delta", text: "lo" };
      yield { type: "done", turn: endTurn("hello") };
    },
  };
  await withRuntime(provider, async (runtime) => {
    const inputs = ["hi"];
    let i = 0;
    const readLine = async (): Promise<string | null> => (i < inputs.length ? inputs[i++]! : null);
    const out: string[] = [];
    const printer = createPrinter((s) => out.push(s));

    await runRepl({ runtime, approve: async () => true, printer, readLine, stream: true });

    // prompt echo, deltas streamed raw, then a single committed line — done adds nothing.
    expect(out.join("")).toBe("› hi\nhello\n");
  });
});

// --- integration: multi-turn history threading ---

test("runRepl threads history across turns", async () => {
  const provider = new ScriptedProvider([endTurn("A1"), endTurn("A2")]);
  await withRuntime(provider, async (runtime) => {
    const inputs = ["q1", "q2"];
    let i = 0;
    const readLine = async (): Promise<string | null> => (i < inputs.length ? inputs[i++]! : null);
    const lines: string[] = [];
    const printer = createPrinter((l) => lines.push(l));

    await runRepl({ runtime, approve: async () => true, printer, readLine });

    expect(provider.calls.length).toBe(2);
    expect(provider.calls[0]!.messages).toEqual([userText("q1")]);
    // Turn 2 carries turn 1's full exchange.
    expect(provider.calls[1]!.messages).toEqual([
      userText("q1"),
      endTurn("A1").message,
      userText("q2"),
    ]);
    expect(lines.some((l) => l.includes("A1"))).toBe(true);
    expect(lines.some((l) => l.includes("A2"))).toBe(true);
  });
});

// --- integration: a cancelled turn does NOT advance context (#22 carry-forward) ---

test("runRepl does not thread a cancelled turn into the next request", async () => {
  // Only turn 2 reaches the provider (turn 1 is cancelled before its first turn).
  const provider = new ScriptedProvider([endTurn("A2")]);
  await withRuntime(provider, async (runtime) => {
    const inputs = ["q1", "q2"];
    let i = 0;
    const readLine = async (): Promise<string | null> => (i < inputs.length ? inputs[i++]! : null);
    const printer = createPrinter(() => {});

    let run = 0;
    const beginRun = (): AbortSignal | undefined => {
      run++;
      if (run === 1) {
        const c = new AbortController();
        c.abort(); // cancel turn 1 immediately
        return c.signal;
      }
      return undefined;
    };

    await runRepl({ runtime, approve: async () => true, printer, readLine, beginRun, endRun: () => {} });

    // Turn 1 never called the model; turn 2's request has NO trace of q1.
    expect(provider.calls.length).toBe(1);
    expect(provider.calls[0]!.messages).toEqual([userText("q2")]);
  });
});

// Documents the rollout⊇history gap: history reverts on cancel, the log doesn't.
test("the rollout keeps an interrupted turn's messages (orphaned) even though history reverts", async () => {
  const provider = new ScriptedProvider([endTurn("A2")]);
  await withRuntime(provider, async (runtime) => {
    const rollout = new CapturingRollout();
    const inputs = ["q1", "q2"];
    let i = 0;
    const readLine = async (): Promise<string | null> => (i < inputs.length ? inputs[i++]! : null);
    let run = 0;
    const beginRun = (): AbortSignal | undefined => {
      run++;
      if (run === 1) {
        const c = new AbortController();
        c.abort();
        return c.signal;
      }
      return undefined;
    };

    await runRepl({
      runtime,
      approve: async () => true,
      printer: createPrinter(() => {}),
      readLine,
      beginRun,
      endRun: () => {},
      rollout,
    });

    // Turn 1 recorded its prompt before the cancel check fired; turn 2 is again
    // a non-continuation, so meta is written twice. The persisted log therefore
    // holds an orphaned q1 next to q2 — a resume must sanitize this (ADR-0001).
    expect(userTexts(rollout.messages)).toEqual(["q1", "q2"]);
    expect(rollout.metas.length).toBe(2);
  });
});
