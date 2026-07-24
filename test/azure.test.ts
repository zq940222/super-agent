import { test, expect } from "bun:test";
import { AzureOpenAIProvider } from "../src/providers/azure";
import { createProvider } from "../src/providers/factory";

/** Set env vars for the duration of `fn`, then restore. */
function withEnv(vars: Record<string, string | undefined>, fn: () => void): void {
  const prev: Record<string, string | undefined> = {};
  for (const k of Object.keys(vars)) prev[k] = process.env[k];
  try {
    for (const [k, v] of Object.entries(vars)) {
      if (v === undefined) delete process.env[k];
      else process.env[k] = v;
    }
    fn();
  } finally {
    for (const [k, v] of Object.entries(prev)) {
      if (v === undefined) delete process.env[k];
      else process.env[k] = v;
    }
  }
}

const FULL_ENV = {
  AZURE_OPENAI_API_KEY: "test-key",
  AZURE_OPENAI_ENDPOINT: "https://res.cognitiveservices.azure.com",
  AZURE_OPENAI_DEPLOYMENT: "my-deployment",
};

test("constructs with name 'azure' when all env is present", () => {
  withEnv(FULL_ENV, () => {
    expect(new AzureOpenAIProvider().name).toBe("azure");
  });
});

test("accepts a full pasted endpoint URL (reduced to origin)", () => {
  withEnv(
    { ...FULL_ENV, AZURE_OPENAI_ENDPOINT: "https://res.cognitiveservices.azure.com/openai/responses?api-version=2025-04-01-preview" },
    () => {
      // Should not throw — the endpoint is normalized to its origin internally.
      expect(new AzureOpenAIProvider().name).toBe("azure");
    },
  );
});

test("throws a clear error when a required setting is missing", () => {
  withEnv({ ...FULL_ENV, AZURE_OPENAI_API_KEY: undefined }, () => {
    expect(() => new AzureOpenAIProvider()).toThrow(/AZURE_OPENAI_API_KEY/);
  });
  withEnv({ ...FULL_ENV, AZURE_OPENAI_ENDPOINT: undefined }, () => {
    expect(() => new AzureOpenAIProvider()).toThrow(/AZURE_OPENAI_ENDPOINT/);
  });
  withEnv({ ...FULL_ENV, AZURE_OPENAI_DEPLOYMENT: undefined }, () => {
    expect(() => new AzureOpenAIProvider()).toThrow(/AZURE_OPENAI_DEPLOYMENT/);
  });
});

test("the factory selects azure via AGENT_PROVIDER", () => {
  withEnv({ ...FULL_ENV, AGENT_PROVIDER: "azure" }, () => {
    expect(createProvider().name).toBe("azure");
  });
});
