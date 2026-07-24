import { test, expect } from "bun:test";
import { OpenAIProvider } from "../src/providers/openai";
import { userText } from "../src/core/types";

/**
 * The single live smoke test. Skipped unless OPENAI_API_KEY is set, so it never
 * runs in CI or by default — it exists to prove the real wire path end-to-end
 * when you deliberately opt in with a key. It makes ONE cheap call.
 */
const hasKey = !!process.env.OPENAI_API_KEY;

test.skipIf(!hasKey)("live: OpenAI generate() returns a normalized assistant turn", async () => {
  const provider = new OpenAIProvider();
  const turn = await provider.generate({
    system: "You are a test harness. Reply with a single short word.",
    messages: [userText("Say hello.")],
    maxTokens: 20,
  });

  expect(turn.message.role).toBe("assistant");
  expect(["end_turn", "max_tokens", "stop_sequence", "tool_use"]).toContain(turn.stopReason);
  expect(turn.usage.inputTokens).toBeGreaterThan(0);
});
