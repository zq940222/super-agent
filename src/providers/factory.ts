/**
 * Provider factory — pick a backend by name/config. This is where "pluggable
 * multi-backend" becomes concrete for callers: the CLI (and any future
 * front-end) selects a provider via `AGENT_PROVIDER` without knowing which SDK
 * is behind it. See issue #5.
 */

import type { ModelProvider } from "./provider";
import { OpenAIProvider } from "./openai";
import { AnthropicProvider } from "./anthropic";
import { AzureOpenAIProvider } from "./azure";

export type ProviderName = "openai" | "anthropic" | "azure";

/** Resolve a provider from an explicit name, else `AGENT_PROVIDER`, else openai.
 * An empty/whitespace value is treated as unset (falls back to openai). */
export function createProvider(name?: string): ModelProvider {
  const resolved = (name || process.env.AGENT_PROVIDER || "openai").trim().toLowerCase();
  switch (resolved) {
    case "openai":
      return new OpenAIProvider();
    case "anthropic":
      return new AnthropicProvider();
    case "azure":
      return new AzureOpenAIProvider();
    default:
      throw new Error(`Unknown provider "${resolved}". Use "openai", "anthropic", or "azure" (set AGENT_PROVIDER).`);
  }
}
