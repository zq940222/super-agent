import { test, expect } from "bun:test";
import { mkdtemp, rm } from "node:fs/promises";
import { existsSync, realpathSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  sandboxMechanism,
  sandboxModeFromEnv,
  buildSeatbeltProfile,
  applySandbox,
  describeSandbox,
} from "../src/tools/sandbox";
import { createShellTool } from "../src/tools/shell";
import type { SpawnArgs } from "../src/tools/shell";

const baseArgs: SpawnArgs = { cmd: ["sh", "-c", "echo hi"], cwd: "/ws", env: {}, timeoutMs: 1000 };
const idResolve = (p: string) => p; // identity: keep tests off the real filesystem

// --- mechanism / mode parsing ---

test("sandboxMechanism: seatbelt on darwin, null elsewhere", () => {
  expect(sandboxMechanism("darwin")).toBe("seatbelt");
  expect(sandboxMechanism("linux")).toBe(null);
  expect(sandboxMechanism("win32")).toBe(null);
});

test("sandboxModeFromEnv: recognizes off/require, defaults everything else to auto", () => {
  expect(sandboxModeFromEnv("off")).toBe("off");
  expect(sandboxModeFromEnv("require")).toBe("require");
  expect(sandboxModeFromEnv("REQUIRE")).toBe("require");
  expect(sandboxModeFromEnv("auto")).toBe("auto");
  expect(sandboxModeFromEnv(undefined)).toBe("auto");
  expect(sandboxModeFromEnv("nonsense")).toBe("auto");
});

// --- profile generation (pure) ---

test("buildSeatbeltProfile denies default + network and allows writes under each root", () => {
  const p = buildSeatbeltProfile(["/ws", "/private/tmp"]);
  expect(p).toContain("(deny default)");
  expect(p).toContain("(deny network*)");
  expect(p).toContain("(allow file-read*)");
  expect(p).toContain('(subpath "/ws")');
  expect(p).toContain('(subpath "/private/tmp")');
});

test("buildSeatbeltProfile escapes quotes/backslashes in a path", () => {
  const p = buildSeatbeltProfile(['/od\\d"ws']);
  expect(p).toContain('(subpath "/od\\\\d\\"ws")'); // \ → \\ and " → \"
});

// --- applySandbox: mode + mechanism branching ---

test("mode off returns the args unchanged", () => {
  const r = applySandbox(baseArgs, { mode: "off", mechanism: "seatbelt", resolvePath: idResolve });
  expect(r).toEqual({ args: baseArgs });
});

test("no mechanism: auto runs unsandboxed, require fails closed", () => {
  const auto = applySandbox(baseArgs, { mode: "auto", mechanism: null });
  expect(auto).toEqual({ args: baseArgs });

  const required = applySandbox(baseArgs, { mode: "require", mechanism: null });
  expect("error" in required).toBe(true);
  if ("error" in required) expect(required.error).toContain("require");
});

test("seatbelt wraps the command in sandbox-exec with a profile covering the cwd", () => {
  const r = applySandbox(baseArgs, {
    mode: "auto",
    mechanism: "seatbelt",
    resolvePath: idResolve,
    writeRoots: [], // no temp roots ⇒ just the cwd, for a tight assertion
  });
  expect("args" in r).toBe(true);
  if (!("args" in r)) return;
  const { cmd } = r.args;
  expect(cmd[0]).toBe("sandbox-exec");
  expect(cmd[1]).toBe("-p");
  expect(cmd[2]).toContain('(subpath "/ws")'); // the profile
  expect(cmd.slice(3)).toEqual(["sh", "-c", "echo hi"]); // original command preserved
});

test("an unrepresentable (control-char) path is refused, even in auto", () => {
  const r = applySandbox({ ...baseArgs, cwd: "/ws\nevil" }, {
    mode: "auto",
    mechanism: "seatbelt",
    resolvePath: idResolve,
    writeRoots: [],
  });
  expect("error" in r).toBe(true);
  if ("error" in r) expect(r.error).toContain("control characters");
});

test("require with an unresolvable workspace fails closed; auto falls back", () => {
  const throwResolve = () => {
    throw new Error("ENOENT");
  };
  const required = applySandbox(baseArgs, { mode: "require", mechanism: "seatbelt", resolvePath: throwResolve });
  expect("error" in required).toBe(true);

  const auto = applySandbox(baseArgs, { mode: "auto", mechanism: "seatbelt", resolvePath: throwResolve });
  expect(auto).toEqual({ args: baseArgs });
});

// --- describeSandbox (the loud diagnostic) ---

test("describeSandbox states the status for each situation", () => {
  expect(describeSandbox({ mode: "off" }, "darwin")).toContain("OFF");
  expect(describeSandbox({ mode: "auto", mechanism: "seatbelt" }, "darwin")).toContain("ON via seatbelt");
  expect(describeSandbox({ mode: "auto", mechanism: null }, "linux")).toContain("UNSANDBOXED");
  expect(describeSandbox({ mode: "require", mechanism: null }, "linux")).toContain("DENIED");
});

// --- REAL enforcement (macOS only; skips elsewhere so Linux CI stays green) ---
// writeRoots:[] ⇒ only the workspace (cwd) is writable, so "outside" can be a
// temp sibling — hermetic, no repo writes.

const notDarwin = process.platform !== "darwin";

/** A workspace + a sibling dir, both realpath'd; cleaned up after. */
async function withWorkspaces(fn: (ws: string, sibling: string) => Promise<void>): Promise<void> {
  const ws = realpathSync(await mkdtemp(join(tmpdir(), "sa-sbx-ws-")));
  const sibling = realpathSync(await mkdtemp(join(tmpdir(), "sa-sbx-out-")));
  try {
    await fn(ws, sibling);
  } finally {
    await rm(ws, { recursive: true, force: true });
    await rm(sibling, { recursive: true, force: true });
  }
}

test.skipIf(notDarwin)("[real] a sandboxed command CAN write inside the workspace", async () => {
  await withWorkspaces(async (ws) => {
    const tool = createShellTool({ sandbox: { mode: "auto", writeRoots: [] } });
    const out = String(await tool.handler({ command: "echo hi > inside.txt && cat inside.txt" }, { cwd: ws, workspaceRoot: ws }));
    expect(out).toContain("exit code: 0");
    expect(out).toContain("hi");
    expect(existsSync(join(ws, "inside.txt"))).toBe(true);
  });
});

test.skipIf(notDarwin)("[real] a sandboxed command CANNOT write outside the write roots", async () => {
  // writeRoots:[] tightens the policy to the workspace only, so a temp sibling is
  // out-of-bounds and the denial is deterministic.
  await withWorkspaces(async (ws, sibling) => {
    const escape = join(sibling, "pwned.txt");
    const tool = createShellTool({ sandbox: { mode: "auto", writeRoots: [] } });
    const out = String(await tool.handler({ command: `echo pwned > ${escape}` }, { cwd: ws, workspaceRoot: ws }));
    expect(existsSync(escape)).toBe(false); // the write was denied by the sandbox
    expect(out.toLowerCase()).toContain("not permitted");
  });
});

test.skipIf(notDarwin)("[real] the SHIPPED default write roots permit a temp write", async () => {
  // The production default (defaultWriteRoots: tmpdir + /private/tmp + …) must let
  // a command write to temp — exercising the real surface, not the tightened [].
  await withWorkspaces(async (ws) => {
    const tmpTarget = join(realpathSync(tmpdir()), `sa-sbx-tmp-${process.pid}.txt`);
    const tool = createShellTool({ sandbox: { mode: "auto" } }); // default writeRoots
    try {
      const out = String(await tool.handler({ command: `echo ok > ${tmpTarget} && cat ${tmpTarget}` }, { cwd: ws, workspaceRoot: ws }));
      expect(out).toContain("exit code: 0");
      expect(existsSync(tmpTarget)).toBe(true);
    } finally {
      if (existsSync(tmpTarget)) await rm(tmpTarget, { force: true });
    }
  });
});

test.skipIf(notDarwin)("[real] a sandboxed command CANNOT reach the network (even a live local server)", async () => {
  // A local listener guarantees the target is reachable absent the sandbox, so a
  // failure proves the sandbox blocked it (not that the host is offline).
  const server = Bun.serve({ port: 0, fetch: () => new Response("ok") });
  try {
    await withWorkspaces(async (ws) => {
      const tool = createShellTool({ sandbox: { mode: "auto", writeRoots: [] } });
      const cmd = `curl -s -m 3 http://127.0.0.1:${server.port}/ -o /dev/null && echo CONNECTED || echo BLOCKED`;
      const out = String(await tool.handler({ command: cmd }, { cwd: ws, workspaceRoot: ws }));
      expect(out).toContain("BLOCKED");
      expect(out).not.toContain("CONNECTED");
    });
  } finally {
    server.stop(true);
  }
});

test.skipIf(notDarwin)("[real] mode off runs unconfined — the same outside write succeeds", async () => {
  // Control: proves the deny above is the sandbox, not the environment.
  await withWorkspaces(async (ws, sibling) => {
    const escape = join(sibling, "allowed.txt");
    const tool = createShellTool({ sandbox: { mode: "off" } });
    await tool.handler({ command: `echo ok > ${escape}` }, { cwd: ws, workspaceRoot: ws });
    expect(existsSync(escape)).toBe(true);
  });
});
