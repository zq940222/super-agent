import { test, expect } from "bun:test";
import {
  fromAnthropicResponse,
  mapAnthropicStopReason,
  toAnthropicMessages,
  toAnthropicTools,
  type AnthResponse,
} from "../src/providers/anthropic";
import type { Message, ToolSpec } from "../src/core/types";

test("maps a text response to an end_turn text turn", () => {
  const resp: AnthResponse = {
    role: "assistant",
    content: [{ type: "text", text: "hi there" }],
    stop_reason: "end_turn",
    usage: { input_tokens: 12, output_tokens: 4 },
  };
  const turn = fromAnthropicResponse(resp);
  expect(turn.stopReason).toBe("end_turn");
  expect(turn.message.content).toEqual([{ type: "text", text: "hi there" }]);
  expect(turn.usage.inputTokens).toBe(12);
  expect(turn.usage.outputTokens).toBe(4);
});

test("maps a tool_use response to a tool_use block and tool_use stop reason", () => {
  const resp: AnthResponse = {
    role: "assistant",
    content: [{ type: "tool_use", id: "tu1", name: "read_file", input: { path: "a.txt" } }],
    stop_reason: "tool_use",
  };
  const turn = fromAnthropicResponse(resp);
  expect(turn.stopReason).toBe("tool_use");
  expect(turn.message.content[0]).toEqual({ type: "tool_use", id: "tu1", name: "read_file", input: { path: "a.txt" } });
});

test("keeps both text and tool_use blocks from a mixed response", () => {
  const resp: AnthResponse = {
    role: "assistant",
    content: [
      { type: "text", text: "let me check" },
      { type: "tool_use", id: "tu1", name: "x", input: {} },
    ],
    stop_reason: "tool_use",
  };
  const turn = fromAnthropicResponse(resp);
  expect(turn.message.content.length).toBe(2);
  expect(turn.stopReason).toBe("tool_use");
});

test("mapAnthropicStopReason maps the wire reasons to our union", () => {
  expect(mapAnthropicStopReason("end_turn")).toBe("end_turn");
  expect(mapAnthropicStopReason("tool_use")).toBe("tool_use");
  expect(mapAnthropicStopReason("max_tokens")).toBe("max_tokens");
  expect(mapAnthropicStopReason("stop_sequence")).toBe("stop_sequence");
  expect(mapAnthropicStopReason(null)).toBe("end_turn");
});

test("renders our messages into Anthropic shape; tool_result → block with is_error", () => {
  const messages: Message[] = [
    { role: "user", content: [{ type: "text", text: "read a.txt" }] },
    { role: "assistant", content: [{ type: "tool_use", id: "tu1", name: "read_file", input: { path: "a.txt" } }] },
    { role: "user", content: [{ type: "tool_result", toolUseId: "tu1", content: "BODY", isError: false }] },
  ];
  const anth = toAnthropicMessages(messages);
  expect(anth).toEqual([
    { role: "user", content: [{ type: "text", text: "read a.txt" }] },
    { role: "assistant", content: [{ type: "tool_use", id: "tu1", name: "read_file", input: { path: "a.txt" } }] },
    { role: "user", content: [{ type: "tool_result", tool_use_id: "tu1", content: "BODY", is_error: false }] },
  ]);
});

test("filters out system messages (system is carried as a top-level param)", () => {
  const messages: Message[] = [
    { role: "system", content: [{ type: "text", text: "SYS" }] },
    { role: "user", content: [{ type: "text", text: "hi" }] },
  ];
  const anth = toAnthropicMessages(messages);
  expect(anth.length).toBe(1);
  expect(anth[0]!.role).toBe("user");
});

test("toAnthropicTools maps ToolSpec to input_schema; empty → undefined", () => {
  const specs: ToolSpec[] = [{ name: "t", description: "d", inputSchema: { type: "object", properties: {} } }];
  const tools = toAnthropicTools(specs)!;
  expect(tools[0]).toEqual({ name: "t", description: "d", input_schema: { type: "object", properties: {} } });
  expect(toAnthropicTools([])).toBeUndefined();
  expect(toAnthropicTools(undefined)).toBeUndefined();
});
