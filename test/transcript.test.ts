import { test, expect } from "bun:test";
import { reduce, appendUser, emptyTranscript } from "../src/tui/transcript";
import { renderEvent } from "../src/tui/render";
import type { AgentEvent } from "../src/core/events";

/** Fold a sequence through reduce (the real render path). */
function foldAll(events: AgentEvent[], source: "main" | "child" = "main"): string[] {
  return events.reduce((state, e) => reduce(state, e, source), emptyTranscript());
}

const textEvent = (text: string): AgentEvent => ({ type: "text", text });
const toolCall = (id: string, name: string, input: unknown): AgentEvent => ({ type: "tool_call", id, name, input });
const toolResult = (id: string, name: string, content: string, isError = false): AgentEvent => ({
  type: "tool_result",
  toolUseId: id,
  name,
  content,
  isError,
});
const done = (text: string): AgentEvent => ({ type: "done", text, steps: 1 });

test("done does not duplicate the final answer (already emitted as text)", () => {
  const lines = foldAll([textEvent("the final answer"), done("the final answer")]);
  expect(lines.filter((l) => l.includes("the final answer")).length).toBe(1);
});

test("a tool call and its result render as two ordered lines", () => {
  const lines = foldAll([toolCall("t1", "echo", { value: "hi" }), toolResult("t1", "echo", "echoed: hi")]);
  expect(lines.length).toBe(2);
  expect(lines[0]).toContain("🔧");
  expect(lines[0]).toContain("echo");
  expect(lines[1]).toContain("↳");
  expect(lines[1]).toContain("echoed: hi");
});

test("an errored tool result uses the ✗ glyph", () => {
  const lines = foldAll([toolResult("t1", "boom", "kaboom", true)]);
  expect(lines[0]).toContain("✗");
  expect(lines[0]).toContain("kaboom");
});

test("a subagent's answer is rendered (indented) — not dropped with its done", () => {
  // The old renderChild showed only the child's `done`; now the answer must
  // come through the child's `text` event, indented. If renderEvent didn't
  // render child text, this would be empty — the child's result would vanish.
  const lines = foldAll([textEvent("child result"), done("child result")], "child");
  expect(lines.length).toBe(1);
  expect(lines[0]!.startsWith("    ")).toBe(true); // child indent
  expect(lines[0]).toContain("child result");
});

test("cancellation renders a marker", () => {
  const lines = foldAll([{ type: "cancelled", step: 2 }]);
  expect(lines[0]).toContain("⏹");
});

test("permission decisions are shown", () => {
  const lines = foldAll([{ type: "permission_decision", name: "write_file", decision: "allow" }]);
  expect(lines[0]).toContain("🔐");
  expect(lines[0]).toContain("write_file");
  expect(lines[0]).toContain("allow");
});

test("rendering is prefix-stable even when tools resolve interleaved", () => {
  const seq: AgentEvent[] = [
    toolCall("a", "echo", { value: "A" }),
    toolCall("b", "echo", { value: "B" }),
    toolResult("a", "echo", "res-A"),
    toolResult("b", "echo", "res-B"),
  ];
  let state = emptyTranscript();
  for (const e of seq) {
    const next = reduce(state, e, "main");
    // Every previously-printed line is unchanged (append-only) → safe to stream.
    expect(next.slice(0, state.length)).toEqual(state);
    state = next;
  }
  expect(state.length).toBe(4);
  expect(state[0]).toContain('"A"'); // call A
  expect(state[1]).toContain('"B"'); // call B
  expect(state[2]).toContain("res-A"); // result A
  expect(state[3]).toContain("res-B"); // result B
});

test("structural events contribute no lines", () => {
  const lines = foldAll([
    { type: "turn_start", step: 1 },
    { type: "step_complete", step: 1, stopReason: "tool_use" },
    { type: "thinking", text: "hmm" },
    { type: "permission_request", name: "x", input: {}, risk: "low" },
    done("ignored"),
  ]);
  expect(lines).toEqual([]);
});

test("empty/whitespace text adds no line", () => {
  expect(renderEvent(textEvent("   "))).toEqual([]);
});

test("reduce is immutable and appendUser echoes the prompt", () => {
  const start = emptyTranscript();
  const after = appendUser(start, "list the src dir");
  expect(start).toEqual([]); // input untouched
  expect(after.length).toBe(1);
  expect(after[0]).toContain("list the src dir");
});
