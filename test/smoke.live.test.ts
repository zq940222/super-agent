import { test, expect } from "bun:test";
import { OpenAIProvider } from "../src/providers/openai";
import { AnthropicProvider } from "../src/providers/anthropic";
import { AzureOpenAIProvider } from "../src/providers/azure";
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

const REQ = {
  system: "You are a test harness. Reply with a single short word.",
  messages: [userText("Say hello.")],
  maxTokens: 20,
};

async function assertLiveTurn(provider: ModelProvider): Promise<void> {
  const turn = await provider.generate(REQ);
  expect(turn.message.role).toBe("assistant");
  expect(["end_turn", "max_tokens", "stop_sequence", "tool_use"]).toContain(turn.stopReason);
  expect(turn.usage.inputTokens).toBeGreaterThan(0);
}

/** Streaming: at least one text delta, ending in a done turn with actual text. */
async function assertLiveStream(provider: ModelProvider): Promise<void> {
  let deltaCount = 0;
  let streamed = "";
  let doneTurn: import("../src/core/types").AssistantTurn | undefined;
  for await (const chunk of provider.stream!(REQ)) {
    if (chunk.type === "text_delta") {
      deltaCount += 1;
      streamed += chunk.text;
    } else {
      doneTurn = chunk.turn;
    }
  }
  expect(deltaCount).toBeGreaterThan(0);
  expect(doneTurn?.message.role).toBe("assistant");
  // The assembled done turn's text should match what streamed delta-by-delta.
  const finalText = (doneTurn?.message.content ?? [])
    .filter((b): b is { type: "text"; text: string } => b.type === "text")
    .map((b) => b.text)
    .join("");
  expect(finalText).toBe(streamed);
  // Token usage must survive streaming too (OpenAI/Azure need include_usage).
  expect(doneTurn?.usage.inputTokens).toBeGreaterThan(0);
}

test.skipIf(!(OPT_IN && process.env.OPENAI_API_KEY))("live: OpenAI generate() returns a normalized turn", async () => {
  await assertLiveTurn(new OpenAIProvider());
});
test.skipIf(!(OPT_IN && process.env.OPENAI_API_KEY))("live: OpenAI stream() emits deltas + a matching done turn", async () => {
  await assertLiveStream(new OpenAIProvider());
});

test.skipIf(!(OPT_IN && process.env.ANTHROPIC_API_KEY))("live: Anthropic generate() returns a normalized turn", async () => {
  await assertLiveTurn(new AnthropicProvider());
});
test.skipIf(!(OPT_IN && process.env.ANTHROPIC_API_KEY))("live: Anthropic stream() emits deltas + a matching done turn", async () => {
  await assertLiveStream(new AnthropicProvider());
});

const azureReady = process.env.AZURE_OPENAI_API_KEY && process.env.AZURE_OPENAI_ENDPOINT && process.env.AZURE_OPENAI_DEPLOYMENT;
test.skipIf(!(OPT_IN && azureReady))("live: Azure OpenAI generate() returns a normalized turn", async () => {
  await assertLiveTurn(new AzureOpenAIProvider());
});
test.skipIf(!(OPT_IN && azureReady))("live: Azure OpenAI stream() emits deltas + a matching done turn", async () => {
  await assertLiveStream(new AzureOpenAIProvider());
});
