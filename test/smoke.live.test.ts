import { test, expect } from "bun:test";
import { OpenAIProvider } from "../src/providers/openai";
import { AnthropicProvider } from "../src/providers/anthropic";
import { userText } from "../src/core/types";
import type { ModelProvider } from "../src/providers/provider";

/**
 * The live smoke tests. They make ONE real API call each, so they are opt-in:
 * they run only when `RUN_LIVE_SMOKE` is set AND the matching key is present.
 * This keeps the default `bun test` hermetic even when a `.env` with keys is
 * loaded (Bun auto-loads `.env`) — filling in a key to *use* the agent should
 * not make the test suite start hitting the network.
 *
 *   RUN_LIVE_SMOKE=1 bun test test/smoke.live.test.ts
 */
const OPT_IN = !!process.env.RUN_LIVE_SMOKE;

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

test.skipIf(!(OPT_IN && process.env.OPENAI_API_KEY))("live: OpenAI generate() returns a normalized turn", async () => {
  await assertLiveTurn(new OpenAIProvider());
});

test.skipIf(!(OPT_IN && process.env.ANTHROPIC_API_KEY))("live: Anthropic generate() returns a normalized turn", async () => {
  await assertLiveTurn(new AnthropicProvider());
});
