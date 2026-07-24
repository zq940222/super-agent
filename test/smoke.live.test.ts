import { test, expect } from "bun:test";
import { OpenAIProvider } from "../src/providers/openai";
import { AnthropicProvider } from "../src/providers/anthropic";
import { userText } from "../src/core/types";
import type { ModelProvider } from "../src/providers/provider";

/**
 * The live smoke tests. Each is skipped unless its API key is set, so they
 * never run in CI or by default — they exist to prove the real wire path per
 * backend when you deliberately opt in. Each makes ONE cheap call.
 */
async function assertLiveTurn(provider: ModelProvider): Promise<void> {
  const turn = await provider.generate({
    system: "You are a test harness. Reply with a single short word.",
    messages: [userText("Say hello.")],
    maxTokens: 20,
  });
  expect(turn.message.role).toBe("assistant");
  expect(["end_turn", "max_tokens", "stop_sequence", "tool_use"]).toContain(turn.stopReason);
  expect(turn.usage.inputTokens).toBeGreaterThan(0);
}

test.skipIf(!process.env.OPENAI_API_KEY)("live: OpenAI generate() returns a normalized turn", async () => {
  await assertLiveTurn(new OpenAIProvider());
});

test.skipIf(!process.env.ANTHROPIC_API_KEY)("live: Anthropic generate() returns a normalized turn", async () => {
  await assertLiveTurn(new AnthropicProvider());
});
