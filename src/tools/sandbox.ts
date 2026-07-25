/**
 * OS sandbox for `shell` (P15, ADR-0007). Real containment under the existing
 * HITL approval: a sandboxed command can't write outside the workspace or reach
 * the network. Implemented as a pure `SpawnArgs → SpawnArgs` transform that
 * wraps the command in the platform's sandbox launcher — so `shell`'s timeout,
 * env-scrub, and output handling are untouched.
 *
 * macOS uses Seatbelt (`sandbox-exec` + an SBPL profile); Linux `bwrap` is a
 * follow-up (mechanism is `null` there for now). Enforcement, kill semantics,
 * and the `/var`→`/private/var` realpath requirement were verified on the host
 * before this was written — see ADR-0007's Context.
 */

import { realpathSync } from "node:fs";
import { tmpdir } from "node:os";
import type { SpawnArgs } from "./shell";

export type SandboxMode = "auto" | "require" | "off";
export type SandboxMechanism = "seatbelt" | null; // bwrap deferred

/** Which sandbox mechanism the platform supports. */
export function sandboxMechanism(platform: string = process.platform): SandboxMechanism {
  return platform === "darwin" ? "seatbelt" : null;
}

/** Parse `AGENT_SHELL_SANDBOX` → a mode. Anything unrecognized (or unset) ⇒ `auto`. */
export function sandboxModeFromEnv(raw: string | undefined): SandboxMode {
  const v = (raw ?? "").trim().toLowerCase();
  return v === "off" || v === "require" ? v : "auto";
}

/** Escape a path for use inside an SBPL string literal. */
function escapeSbpl(p: string): string {
  return p.replace(/\\/g, "\\\\").replace(/"/g, '\\"');
}

/** A path with a control char can't be safely embedded in a profile ⇒ refuse. */
function unrepresentable(p: string): boolean {
  // eslint-disable-next-line no-control-regex
  return /[\x00-\x1f]/.test(p); // NUL, newline, CR, other C0 controls
}

/**
 * Build a Seatbelt (SBPL) profile: deny-by-default, read everything (dyld/libs/
 * the command binaries — reading isn't the exfil risk), write ONLY under the
 * given roots (already realpath'd), and deny all network. Matches the profile
 * verified on the host. `writeRoots` must be resolved + representable.
 */
export function buildSeatbeltProfile(writeRoots: string[]): string {
  const subpaths = writeRoots.map((r) => `  (subpath "${escapeSbpl(r)}")`).join("\n");
  return [
    "(version 1)",
    "(deny default)",
    "(allow process*)",
    "(allow sysctl-read)",
    "(allow file-read*)",
    "(allow file-write*",
    subpaths,
    '  (literal "/dev/null") (literal "/dev/stdout") (literal "/dev/stderr"))',
    "(deny network*)",
  ].join("\n");
}

export interface SandboxConfig {
  mode: SandboxMode;
  /** Injectable for tests; defaults to platform detection. */
  mechanism?: SandboxMechanism;
  /** Injectable for tests; defaults to realpathSync. */
  resolvePath?: (p: string) => string;
  /** Extra write roots (besides the command's cwd). Defaults to the system temp dirs. */
  writeRoots?: string[];
}

/** System temp dirs a command legitimately writes to (mktemp, compilers, …). */
function defaultWriteRoots(): string[] {
  return [tmpdir(), "/private/tmp", "/private/var/tmp"];
}

/**
 * Wrap `args` so the command runs sandboxed, or return an error string when the
 * policy says the command must not run unsandboxed (`require` with no mechanism,
 * or an unrepresentable path). Returning `{ args }` unchanged means "run as-is"
 * (mode `off`, or `auto` with no mechanism — still HITL-gated upstream).
 */
export function applySandbox(args: SpawnArgs, cfg: SandboxConfig): { args: SpawnArgs } | { error: string } {
  if (cfg.mode === "off") return { args };

  // `!== undefined` so an explicitly-injected `null` (no mechanism) is honored,
  // not overridden by platform detection — `??` would conflate the two.
  const mechanism = cfg.mechanism !== undefined ? cfg.mechanism : sandboxMechanism();
  if (mechanism === null) {
    return cfg.mode === "require"
      ? { error: "shell refused: AGENT_SHELL_SANDBOX=require, but no sandbox mechanism is available on this platform." }
      : { args }; // auto ⇒ run unsandboxed (the command is still gated by approval)
  }

  const resolve = cfg.resolvePath ?? realpathSync;

  // The command's cwd (the workspace) is the primary write root and MUST resolve.
  let cwdReal: string;
  try {
    cwdReal = resolve(args.cwd);
  } catch (err) {
    const msg = `shell: cannot resolve the workspace path for the sandbox (${err instanceof Error ? err.message : String(err)}).`;
    return cfg.mode === "require" ? { error: msg } : { args };
  }

  // Temp roots are best-effort — skip any that don't resolve (may not exist).
  const extra = (cfg.writeRoots ?? defaultWriteRoots()).flatMap((r) => {
    try {
      return [resolve(r)];
    } catch {
      return [];
    }
  });

  const roots = [...new Set([cwdReal, ...extra])];
  const bad = roots.find(unrepresentable);
  if (bad) {
    // Fail closed regardless of mode: never emit a weaker profile than intended.
    return { error: `shell refused: a write-root path contains control characters and can't be sandboxed: ${JSON.stringify(bad)}` };
  }

  const profile = buildSeatbeltProfile(roots);
  return { args: { ...args, cmd: ["sandbox-exec", "-p", profile, ...args.cmd] } };
}

/** One-line status for the startup diagnostic (ADR-0007 §4 — the fallback must be loud). */
export function describeSandbox(cfg: Pick<SandboxConfig, "mode" | "mechanism">, platform: string = process.platform): string {
  if (cfg.mode === "off") return "shell sandbox: OFF — commands run unconfined";
  const mechanism = cfg.mechanism !== undefined ? cfg.mechanism : sandboxMechanism(platform);
  if (mechanism === null) {
    return cfg.mode === "require"
      ? `shell sandbox: REQUIRE, but no mechanism on ${platform} — shell commands will be DENIED`
      : `shell sandbox: UNSANDBOXED (no mechanism on ${platform}; commands still require approval)`;
  }
  return `shell sandbox: ON via ${mechanism} (workspace-write, network denied)`;
}
