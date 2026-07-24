import { test, expect } from "bun:test";
import {
  fromOpenAIResponse,
  mapFinishReason,
  toOpenAIMessages,
  toOpenAITools,
  type OAIResponse,
} from "../src/providers/openai";
import type { Message, ToolSpec, ToolUseBlock } from "../src/core/types";

test("maps a plain text completion to an end_turn text turn", () => {
  const resp: OAIResponse = {
    choices: [{ message: { role: "assistant", content: "hi there" }, finish_reason: "stop" }],
    usage: { prompt_tokens: 10, completion_tokens: 3 },
  };
  const turn = fromOpenAIResponse(resp);
  expect(turn.stopReason).toBe("end_turn");
  expect(turn.message.content).toEqual([{ type: "text", text: "hi there" }]);
  expect(turn.usage.inputTokens).toBe(10);
  expect(turn.usage.outputTokens).toBe(3);
});

test("maps a tool call to a tool_use block and tool_use stop reason", () => {
  const resp: OAIResponse = {
    choices: [
      {
        message: {
          role: "assistant",
          content: null,
          tool_calls: [{ id: "c1", type: "function", function: { name: "read_file", arguments: '{"path":"a.txt"}' } }],
        },
        finish_reason: "tool_calls",
      },
    ],
  };
  const turn = fromOpenAIResponse(resp);
  expect(turn.stopReason).toBe("tool_use");
  expect(turn.message.content[0]).toEqual({ type: "tool_use", id: "c1", name: "read_file", input: { path: "a.txt" } });
});

test("maps multiple tool calls in one response", () => {
  const resp: OAIResponse = {
    choices: [
      {
        message: {
          role: "assistant",
          content: null,
          tool_calls: [
            { id: "a", type: "function", function: { name: "x", arguments: "{}" } },
            { id: "b", type: "function", function: { name: "y", arguments: "{}" } },
          ],
        },
        finish_reason: "tool_calls",
      },
    ],
  };
  const turn = fromOpenAIResponse(resp);
  const uses = turn.message.content.filter((b): b is ToolUseBlock => b.type === "tool_use");
  expect(uses.map((u) => u.id)).toEqual(["a", "b"]);
});

test("malformed tool arguments do not throw", () => {
  const resp: OAIResponse = {
    choices: [
      {
        message: {
          role: "assistant",
          content: null,
          tool_calls: [{ id: "c1", type: "function", function: { name: "x", arguments: "{not json" } }],
        },
        finish_reason: "tool_calls",
      },
    ],
  };
  const turn = fromOpenAIResponse(resp);
  const use = turn.message.content[0] as ToolUseBlock;
  expect(use.type).toBe("tool_use");
  expect(use.input).toEqual({ _unparsed_arguments: "{not json" });
});

test("mapFinishReason maps the wire reasons to our union", () => {
  expect(mapFinishReason("stop")).toBe("end_turn");
  expect(mapFinishReason("tool_calls")).toBe("tool_use");
  expect(mapFinishReason("length")).toBe("max_tokens");
  expect(mapFinishReason("content_filter")).toBe("stop_sequence");
  expect(mapFinishReason(null)).toBe("end_turn");
});

test("renders our messages into OpenAI shape, incl. tool-role messages", () => {
  const messages: Message[] = [
    { role: "user", content: [{ type: "text", text: "read a.txt" }] },
    { role: "assistant", content: [{ type: "tool_use", id: "c1", name: "read_file", input: { path: "a.txt" } }] },
    { role: "user", content: [{ type: "tool_result", toolUseId: "c1", content: "FILE BODY" }] },
  ];
  const oai = toOpenAIMessages(messages, "SYS");

  expect(oai[0]).toEqual({ role: "system", content: "SYS" });
  expect(oai[1]).toEqual({ role: "user", content: "read a.txt" });
  expect(oai[2]).toEqual({
    role: "assistant",
    content: null,
    tool_calls: [{ id: "c1", type: "function", function: { name: "read_file", arguments: JSON.stringify({ path: "a.txt" }) } }],
  });
  expect(oai[3]).toEqual({ role: "tool", tool_call_id: "c1", content: "FILE BODY" });
});

test("toOpenAITools maps a ToolSpec to a function tool; empty → undefined", () => {
  const specs: ToolSpec[] = [{ name: "t", description: "d", inputSchema: { type: "object", properties: {} } }];
  const tools = toOpenAITools(specs)!;
  expect(tools[0]).toEqual({
    type: "function",
    function: { name: "t", description: "d", parameters: { type: "object", properties: {} } },
  });
  expect(toOpenAITools([])).toBeUndefined();
  expect(toOpenAITools(undefined)).toBeUndefined();
});
