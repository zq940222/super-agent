/**
 * `shell` — run a command via `sh -c` (P14-3). The most powerful and most
 * dangerous tool: arbitrary code execution is *both* legs of the lethal
 * trifecta at once. So it's `high` risk (default asks every call, `readonly`
 * denies, `auto` allows) and `mutates: true`.
 *
 * The v1 security boundary is the HITL approval — a human sees the exact
 * command. Everything here is blast-radius reduction, not containment (no
 * OS-kernel sandbox in v1; see ADR-0005):
 *   - env allowlist (fail closed): the child can't read the agent's API keys.
 *   - cwd defaults to the workspace (a default, not a boundary — `cd /` escapes).
 *   - a wall-clock timeout kills runaways (Bun's native timeout + SIGKILL).
 *   - stdout/stderr are captured, capped with a visible marker, exit reported.
 *
 * The spawn is injected so tests are hermetic (no real processes in CI).
 */

import { z } from "zod";
import { defineTool, type RegisteredTool } from "./registry";
import { applySandbox, sandboxModeFromEnv, type SandboxConfig } from "./sandbox";

const DEFAULT_TIMEOUT_MS = 30_000;
const MAX_TIMEOUT_MS = 600_000; // 10 min hard cap
const DEFAULT_MAX_CHARS = 20_000; // per stream (stdout, stderr)

/**
 * The env vars the child inherits — an explicit ALLOWLIST (fail closed), so a
 * command can't read `OPENAI_API_KEY` / `ANTHROPIC_API_KEY` / `BRAVE_API_KEY`
 * and exfiltrate them. A denylist would miss `AWS_SESSION_*` / `GH_*` / keys
 * added later and fail open. See ADR-0005 §6.
 */
const DEFAULT_ENV_ALLOWLIST = ["PATH", "HOME", "LANG", "TERM", "TMPDIR", "SHELL", "USER"];

/** What the handler needs back from a spawned process (a narrow, injectable shape). */
export interface SpawnResult {
  /** Exit code, or null when the process was terminated by a signal. */
  exitCode: number | null;
  /** Signal that killed it (e.g. "SIGKILL" on timeout), or null on normal exit. */
  signalCode: string | null;
  stdout: string;
  stderr: string;
}

export interface SpawnArgs {
  cmd: string[];
  cwd: string;
  env: Record<string, string>;
  timeoutMs: number;
}

export type SpawnFn = (args: SpawnArgs) => Promise<SpawnResult>;

/** The real spawn — Bun's native `timeout` + `killSignal` (verified on 1.3.13). */
const bunSpawn: SpawnFn = async ({ cmd, cwd, env, timeoutMs }) => {
  const proc = Bun.spawn({
    cmd,
    cwd,
    env,
    stdin: "ignore", // non-interactive: a command reading stdin gets EOF, not a hang
    stdout: "pipe",
    stderr: "pipe",
    timeout: timeoutMs,
    killSignal: "SIGKILL",
  });
  const [stdout, stderr] = await Promise.all([
    new Response(proc.stdout).text(),
    new Response(proc.stderr).text(),
  ]);
  await proc.exited;
  return { exitCode: proc.exitCode, signalCode: proc.signalCode, stdout, stderr };
};

/** Truncate with the same visible marker the other capable tools use. */
function truncate(text: string, max: number): string {
  if (text.length <= max) return text;
  return text.slice(0, max) + `\n…[truncated ${text.length - max} of ${text.length} chars]`;
}

function clampTimeout(v: number | undefined): number {
  if (!v || v <= 0) return DEFAULT_TIMEOUT_MS;
  return Math.min(v, MAX_TIMEOUT_MS);
}

/** Build the child env from the allowlist (present vars only) + explicit extras. */
function buildEnv(allowlist: string[], extra: Record<string, string>): Record<string, string> {
  const env: Record<string, string> = {};
  for (const key of allowlist) {
    const val = process.env[key];
    if (val !== undefined) env[key] = val;
  }
  return { ...env, ...extra };
}

function formatResult(r: SpawnResult, timeoutMs: number, maxChars: number): string {
  const header = r.signalCode
    ? `terminated by signal ${r.signalCode}` +
      (r.signalCode === "SIGKILL" ? ` (likely the ${timeoutMs}ms timeout)` : "")
    : `exit code: ${r.exitCode ?? "unknown"}`;
  const out = r.stdout.trim();
  const err = r.stderr.trim();
  return [
    header,
    `--- stdout ---\n${out ? truncate(out, maxChars) : "(empty)"}`,
    `--- stderr ---\n${err ? truncate(err, maxChars) : "(empty)"}`,
  ].join("\n");
}

export interface ShellOptions {
  /** Injected for tests; defaults to a Bun.spawn-backed runner. */
  spawn?: SpawnFn;
  /** Default timeout when the model doesn't pass one. Default 30000ms. */
  defaultTimeoutMs?: number;
  /** Max characters per stream before truncation. Default 20000. */
  maxChars?: number;
  /** Replace the env allowlist entirely (advanced). Var names inherited from the agent's env. */
  envAllowlist?: string[];
  /** Append names to the DEFAULT allowlist (the common opt-in: pass NODE_ENV, a proxy var, …). */
  extraAllowlist?: string[];
  /** Inject explicit env values (as opposed to passing through from the agent's env). */
  extraEnv?: Record<string, string>;
  /** OS-sandbox config (ADR-0007). Default: mode from `AGENT_SHELL_SANDBOX` (else `auto`). */
  sandbox?: SandboxConfig;
}

export function createShellTool(opts: ShellOptions = {}): RegisteredTool {
  const doSpawn = opts.spawn ?? bunSpawn;
  const defaultTimeout = clampTimeout(opts.defaultTimeoutMs);
  const maxChars = opts.maxChars ?? DEFAULT_MAX_CHARS;
  // `envAllowlist` replaces the default; otherwise the default plus any `extraAllowlist` opt-ins.
  const allowlist = opts.envAllowlist ?? [...DEFAULT_ENV_ALLOWLIST, ...(opts.extraAllowlist ?? [])];
  const extraEnv = opts.extraEnv ?? {};
  const sandbox: SandboxConfig = opts.sandbox ?? { mode: sandboxModeFromEnv(process.env.AGENT_SHELL_SANDBOX) };

  return defineTool({
    name: "shell",
    description:
      "Run a shell command via `sh -c` and return its exit code, stdout, and stderr. " +
      "Commands run NON-INTERACTIVELY (no stdin/TTY — a command that waits for input hangs " +
      "until the timeout), in the agent's workspace directory, with a MINIMAL scrubbed " +
      "environment (API keys and most vars are NOT inherited — only PATH/HOME and a few others). " +
      "Use it for builds, tests, git, and file operations. Long output is truncated with a marker. " +
      "When sandboxed (default on macOS), a command CANNOT reach the network, and can only write " +
      "under the workspace and temp dirs — so `curl`/`npm install`/`git fetch` will fail; say so " +
      "rather than retrying. " +
      "High-risk: it can modify or delete anything, so it asks for approval on each call.",
    risk: "high",
    mutates: true,
    schema: z.object({
      command: z.string().min(1).describe("The shell command to run via `sh -c`."),
      timeout_ms: z
        .number()
        .int()
        .positive()
        .max(MAX_TIMEOUT_MS)
        .optional()
        .describe(`Wall-clock timeout in ms (default ${defaultTimeout}, max ${MAX_TIMEOUT_MS}).`),
    }),
    handler: async ({ command, timeout_ms }, ctx) => {
      // cwd defaults to the workspace, matching resolveInWorkspace's fallback
      // (ADR-0005 §4). This is the STARTING dir, not a boundary — `cd` escapes.
      const cwd = ctx.workspaceRoot ?? ctx.cwd;
      const timeoutMs = timeout_ms ? clampTimeout(timeout_ms) : defaultTimeout;
      const env = buildEnv(allowlist, extraEnv);

      // Wrap the command in the OS sandbox (ADR-0007). A fail-closed refusal
      // (require mode with no mechanism, or an unrepresentable path) returns a
      // string; otherwise the cmd is rewritten to run under sandbox-exec.
      const boxed = applySandbox({ cmd: ["sh", "-c", command], cwd, env, timeoutMs }, sandbox);
      if ("error" in boxed) return boxed.error;

      let result: SpawnResult;
      try {
        result = await doSpawn(boxed.args);
      } catch (err) {
        return `shell failed to start: ${err instanceof Error ? err.message : String(err)}`;
      }
      return formatResult(result, timeoutMs, maxChars);
    },
  });
}
