import { test, expect } from "bun:test";
import { applyEvent, type Item } from "../web/src/transcript";
import type { AgentEvent } from "../src/core/events";

// The React client's core logic is a pure reducer (web/src/transcript.ts), so it
// gets real coverage here even though the rendering is untested glue.
const fold = (events: AgentEvent[]): Item[] => events.reduce((s, e) => applyEvent(s, e), [] as Item[]);

test("streamed deltas accumulate into one assistant bubble; done adds nothing", () => {
  const items = fold([
    { type: "text_delta", text: "hel" },
    { type: "text_delta", text: "lo" },
    { type: "done", text: "hello", steps: 1 },
  ]);
  expect(items).toEqual([{ kind: "assistant", text: "hello" }]);
});

test("whole text (the non-streaming fallback) also folds into an assistant bubble", () => {
  const items = fold([
    { type: "text", text: "hi there" },
    { type: "done", text: "hi there", steps: 1 },
  ]);
  expect(items).toEqual([{ kind: "assistant", text: "hi there" }]);
});

test("a tool_call starts a fresh bubble; its result correlates by id", () => {
  const items = fold([
    { type: "text_delta", text: "before" },
    { type: "tool_call", id: "t1", name: "echo", input: { v: 1 } },
    { type: "tool_result", toolUseId: "t1", name: "echo", content: "ok", isError: false },
    { type: "text_delta", text: "after" },
  ]);
  expect(items).toEqual([
    { kind: "assistant", text: "before" },
    { kind: "tool", id: "t1", name: "echo", input: { v: 1 }, status: "ok", result: "ok" },
    { kind: "assistant", text: "after" },
  ]);
});

test("an errored tool result marks the tool item error", () => {
  const items = fold([
    { type: "tool_call", id: "t1", name: "boom", input: {} },
    { type: "tool_result", toolUseId: "t1", name: "boom", content: "kaboom", isError: true },
  ]);
  expect(items[0]).toMatchObject({ kind: "tool", status: "error", result: "kaboom" });
});

test("cancelled/error become notices; structural events add nothing", () => {
  expect(fold([{ type: "cancelled", step: 1 }])).toEqual([{ kind: "notice", text: "⏹ cancelled" }]);
  expect(fold([{ type: "error", message: "boom" }])).toEqual([{ kind: "notice", text: "error: boom" }]);
  expect(
    fold([
      { type: "turn_start", step: 1 },
      { type: "permission_request", name: "x", input: {}, risk: "low" },
      { type: "permission_decision", name: "x", decision: "allow" },
    ]),
  ).toEqual([]);
});
