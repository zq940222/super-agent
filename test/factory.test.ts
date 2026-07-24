import { test, expect } from "bun:test";
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

test("defaults to openai when AGENT_PROVIDER is empty", () => {
  withEnv({ AGENT_PROVIDER: "", OPENAI_API_KEY: "test-key" }, () => {
    expect(createProvider().name).toBe("openai");
  });
});

test("defaults to openai when AGENT_PROVIDER is unset", () => {
  withEnv({ AGENT_PROVIDER: undefined, OPENAI_API_KEY: "test-key" }, () => {
    expect(createProvider().name).toBe("openai");
  });
});

test("selects anthropic (case-insensitive, trimmed)", () => {
  withEnv({ AGENT_PROVIDER: "  Anthropic  ", ANTHROPIC_API_KEY: "test-key" }, () => {
    expect(createProvider().name).toBe("anthropic");
  });
});

test("an explicit name overrides the env", () => {
  withEnv({ AGENT_PROVIDER: "openai", ANTHROPIC_API_KEY: "test-key" }, () => {
    expect(createProvider("anthropic").name).toBe("anthropic");
  });
});

test("throws a helpful error on an unknown provider", () => {
  expect(() => createProvider("bogus")).toThrow(/Unknown provider "bogus"/);
});
