import { test, expect } from "bun:test";
import { createShellTool, type SpawnArgs, type SpawnResult } from "../src/tools/shell";
import type { ToolContext } from "../src/tools/registry";

const ctx: ToolContext = { cwd: "/work", workspaceRoot: "/work/ws" };

/** An injected spawn that records its args and returns a canned result. */
function stubSpawn(result: Partial<SpawnResult> = {}): { spawn: (a: SpawnArgs) => Promise<SpawnResult>; calls: SpawnArgs[] } {
  const calls: SpawnArgs[] = [];
  const spawn = async (args: SpawnArgs): Promise<SpawnResult> => {
    calls.push(args);
    return { exitCode: 0, signalCode: null, stdout: "", stderr: "", ...result };
  };
  return { spawn, calls };
}

const run = (
  tool: ReturnType<typeof createShellTool>,
  command: string,
  timeout_ms?: number,
  c: ToolContext = ctx,
): Promise<string> => Promise.resolve(tool.handler({ command, timeout_ms }, c)).then(String);

// --- metadata ---

test("shell is high-risk and mutating (default asks; readonly denies)", () => {
  const t = createShellTool();
  expect(t.risk).toBe("high");
  expect(t.mutates).toBe(true);
});

// --- invocation shape ---

test("runs the command through `sh -c`", async () => {
  const { spawn, calls } = stubSpawn();
  await run(createShellTool({ spawn }), "echo hi && ls");
  expect(calls[0]!.cmd).toEqual(["sh", "-c", "echo hi && ls"]);
});

test("cwd defaults to the workspace root when set", async () => {
  const { spawn, calls } = stubSpawn();
  await run(createShellTool({ spawn }), "pwd");
  expect(calls[0]!.cwd).toBe("/work/ws");
});

test("cwd falls back to ctx.cwd when there is no workspace root", async () => {
  const { spawn, calls } = stubSpawn();
  await run(createShellTool({ spawn }), "pwd", undefined, { cwd: "/elsewhere" });
  expect(calls[0]!.cwd).toBe("/elsewhere");
});

// --- timeout ---

test("uses the default timeout when none is given", async () => {
  const { spawn, calls } = stubSpawn();
  await run(createShellTool({ spawn }), "sleep 1");
  expect(calls[0]!.timeoutMs).toBe(30_000);
});

test("honors a caller timeout and clamps it to the 10-min max", async () => {
  const { spawn, calls } = stubSpawn();
  const t = createShellTool({ spawn });
  await run(t, "x", 5_000);
  expect(calls[0]!.timeoutMs).toBe(5_000);
  await run(t, "x", 99_999_999);
  expect(calls[1]!.timeoutMs).toBe(600_000);
});

// --- env allowlist (fail closed) ---

test("does NOT leak secret env vars to the child, but passes PATH", async () => {
  const saved = process.env.OPENAI_API_KEY;
  process.env.OPENAI_API_KEY = "sk-secret";
  try {
    const { spawn, calls } = stubSpawn();
    await run(createShellTool({ spawn }), "env");
    const env = calls[0]!.env;
    expect(env.OPENAI_API_KEY).toBeUndefined(); // scrubbed
    expect(env.PATH).toBeDefined(); // allowlisted
  } finally {
    if (saved === undefined) delete process.env.OPENAI_API_KEY;
    else process.env.OPENAI_API_KEY = saved;
  }
});

test("extraEnv is the opt-in escape hatch", async () => {
  const { spawn, calls } = stubSpawn();
  await run(createShellTool({ spawn, extraEnv: { NODE_ENV: "test" } }), "node -e 0");
  expect(calls[0]!.env.NODE_ENV).toBe("test");
});

test("extraAllowlist appends to the default (keeps PATH, adds the opt-in var)", async () => {
  // Use a neutral, custom name: mutating a networking env var (e.g. HTTP_PROXY)
  // here was observed to break concurrently-running web-server tests, since bun
  // runs test files in one process and the client fetches share process.env.
  const saved = process.env.SA_SHELL_OPTIN;
  process.env.SA_SHELL_OPTIN = "yes-please";
  try {
    const { spawn, calls } = stubSpawn();
    await run(createShellTool({ spawn, extraAllowlist: ["SA_SHELL_OPTIN"] }), "env");
    expect(calls[0]!.env.SA_SHELL_OPTIN).toBe("yes-please"); // opted in
    expect(calls[0]!.env.PATH).toBeDefined(); // default preserved
  } finally {
    if (saved === undefined) delete process.env.SA_SHELL_OPTIN;
    else process.env.SA_SHELL_OPTIN = saved;
  }
});

test("a custom allowlist controls exactly which vars pass through", async () => {
  const saved = process.env.MY_PASSTHROUGH;
  process.env.MY_PASSTHROUGH = "yes";
  try {
    const { spawn, calls } = stubSpawn();
    await run(createShellTool({ spawn, envAllowlist: ["MY_PASSTHROUGH"] }), "env");
    expect(calls[0]!.env.MY_PASSTHROUGH).toBe("yes");
    expect(calls[0]!.env.PATH).toBeUndefined(); // not in the custom allowlist
  } finally {
    if (saved === undefined) delete process.env.MY_PASSTHROUGH;
    else process.env.MY_PASSTHROUGH = saved;
  }
});

// --- output formatting ---

test("reports exit code and both streams", async () => {
  const { spawn } = stubSpawn({ exitCode: 0, stdout: "hello\n", stderr: "" });
  const out = await run(createShellTool({ spawn }), "echo hello");
  expect(out).toContain("exit code: 0");
  expect(out).toContain("--- stdout ---\nhello");
  expect(out).toContain("--- stderr ---\n(empty)");
});

test("surfaces a non-zero exit code and stderr", async () => {
  const { spawn } = stubSpawn({ exitCode: 2, stdout: "", stderr: "boom" });
  const out = await run(createShellTool({ spawn }), "false");
  expect(out).toContain("exit code: 2");
  expect(out).toContain("--- stderr ---\nboom");
});

test("reports a timeout kill as a signal, not a clean exit", async () => {
  const { spawn } = stubSpawn({ exitCode: null, signalCode: "SIGKILL", stdout: "partial", stderr: "" });
  const out = await run(createShellTool({ spawn }), "sleep 999", 100);
  expect(out).toContain("terminated by signal SIGKILL");
  expect(out).toContain("likely the 100ms timeout");
  expect(out).not.toContain("exit code:");
});

test("truncates long output with a visible marker", async () => {
  const { spawn } = stubSpawn({ stdout: "A".repeat(500) });
  const out = await run(createShellTool({ spawn, maxChars: 100 }), "yes");
  expect(out).toMatch(/truncated \d+ of \d+ chars/);
});

// --- errors ---

test("reports a spawn that fails to start instead of throwing", async () => {
  const spawn = async () => {
    throw new Error("ENOENT: sh not found");
  };
  const out = await run(createShellTool({ spawn }), "echo hi");
  expect(out).toContain("shell failed to start");
  expect(out).toContain("ENOENT");
});

// --- real spawn (default Bun.spawn path — guards the actual wiring) ---

const realCtx: ToolContext = { cwd: process.cwd() };

test("[real] runs a command and reports its stdout + exit code", async () => {
  const out = await run(createShellTool(), "echo hello-real", undefined, realCtx);
  expect(out).toContain("exit code: 0");
  expect(out).toContain("hello-real");
});

test("[real] the child's env is scrubbed — a secret is not visible", async () => {
  const saved = process.env.SECRET_XYZ;
  process.env.SECRET_XYZ = "leak";
  try {
    // printenv exits non-zero if unset; `|| echo MISSING` keeps overall exit 0.
    const out = await run(createShellTool(), "printenv SECRET_XYZ || echo MISSING", undefined, realCtx);
    expect(out).toContain("MISSING");
    expect(out).not.toContain("leak");
  } finally {
    if (saved === undefined) delete process.env.SECRET_XYZ;
    else process.env.SECRET_XYZ = saved;
  }
});

test("[real] a command that exceeds its timeout is killed by signal", async () => {
  const out = await run(createShellTool(), "sleep 5", 200, realCtx);
  expect(out).toContain("terminated by signal SIGKILL");
});
