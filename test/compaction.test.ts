import { test, expect } from "bun:test";
import { compact, estimateTokens } from "../src/core/compaction";
import type { Message, TextBlock } from "../src/core/types";

const userMsg = (t: string): Message => ({ role: "user", content: [{ type: "text", text: t }] });
const asstText = (t: string): Message => ({ role: "assistant", content: [{ type: "text", text: t }] });
const asstTool = (id: string, name: string): Message => ({
  role: "assistant",
  content: [{ type: "tool_use", id, name, input: {} }],
});
const toolRes = (id: string, content: string): Message => ({
  role: "user",
  content: [{ type: "tool_result", toolUseId: id, content }],
});
const textOfFirst = (m: Message): string => (m.content[0] as TextBlock).text;

test("estimateTokens grows with content", () => {
  expect(estimateTokens([userMsg("x".repeat(4000))])).toBeGreaterThan(estimateTokens([userMsg("hi")]));
  expect(estimateTokens([userMsg("x".repeat(4000))])).toBeGreaterThanOrEqual(1000);
});

test("returns the array unchanged when it's already short", async () => {
  const msgs = [userMsg("a"), asstText("b")];
  expect(await compact(msgs, async () => "S", { keepRecent: 6 })).toBe(msgs);
});

test("summarizes the head and keeps the recent tail verbatim", async () => {
  const msgs = [
    userMsg("task"),
    asstText("1"),
    userMsg("2"),
    asstText("3"),
    userMsg("4"),
    asstText("5"),
  ];
  const out = await compact(msgs, async () => "SUMMARY", { keepRecent: 2 });
  expect(out[0]!.role).toBe("user");
  expect(textOfFirst(out[0]!)).toContain("SUMMARY");
  expect(out.slice(1)).toEqual(msgs.slice(msgs.length - 2));
});

test("orphan-safe: never splits a tool_use from its tool_result", async () => {
  const msgs = [userMsg("task"), asstTool("a", "x"), toolRes("a", "ra"), asstTool("b", "x"), toolRes("b", "rb")];
  // keepRecent=1 would put a lone tool_result at the tail head; must pull back to its tool_use.
  const out = await compact(msgs, async () => "S", { keepRecent: 1 });
  const tail = out.slice(1);
  expect(tail[0]!.role).toBe("assistant");
  expect(tail[0]!.content[0]!.type).toBe("tool_use");
  expect(tail.at(-1)!.content.some((b) => b.type === "tool_result")).toBe(true);
});

test("passes the summarizer the head messages only", async () => {
  const msgs = [userMsg("task"), asstText("1"), userMsg("2"), asstText("3")];
  let seen: Message[] = [];
  await compact(msgs, async (head) => ((seen = head), "S"), { keepRecent: 2 });
  expect(seen).toEqual(msgs.slice(0, 2));
});
