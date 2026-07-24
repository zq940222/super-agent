#!/usr/bin/env bun
/**
 * Interactive TUI front-end (P-tui-4) — a persistent, multi-turn REPL over the
 * agent loop. Usage:
 *   bun run tui
 *
 * This file is the thin terminal glue: readline for input, a raw SIGINT wiring
 * for Ctrl-C (abort the running task; at the prompt, end the session), and a
 * per-session rollout. The testable logic lives in app.ts / approver.ts /
 * conversation.ts / transcript.ts. See ADR-0001.
 */

import { createInterface } from "node:readline";
import { PermissionPolicy, type PermissionMode } from "../permissions/gate";
import { bootstrap, type Runtime } from "../runtime/bootstrap";
import { createRollout } from "../session/rollout";
import { createApprover } from "./approver";
import { createPrinter, runRepl } from "./app";

const DIM = "\x1b[2m";
const BOLD = "\x1b[1m";
const RESET = "\x1b[0m";
const dim = (s: string): string => `${DIM}${s}${RESET}`;

async function main(): Promise<void> {
  const mode = (process.env.AGENT_PERMISSION_MODE as PermissionMode) || "default";

  const rl = createInterface({ input: process.stdin, output: process.stdout });
  const writeLine = (s: string): void => void process.stdout.write(s + "\n");
  const printer = createPrinter(writeLine);

  // The policy is created here and shared with bootstrap, so the approver's
  // "always allow" (which mutates it) reaches the engine's gate.
  const policy = new PermissionPolicy({ mode });
  const askLine = (prompt: string): Promise<string> =>
    new Promise((resolve) => rl.question(prompt, resolve));
  const approve = createApprover(policy, { ask: askLine });

  let runtime: Runtime;
  try {
    runtime = await bootstrap({
      mode,
      policy,
      approve,
      onChildEvent: (e) => printer.event(e, "child"),
      log: (m) => writeLine(dim(m)),
      logError: (m) => writeLine(dim(m)),
    });
  } catch (err) {
    process.stderr.write(`${err instanceof Error ? err.message : String(err)}\n`);
    rl.close();
    process.exit(1);
  }

  // Ctrl-C: abort the running task if one is active; otherwise end the session.
  let currentRun: AbortController | null = null;
  let closed = false;
  let pending: ((v: string | null) => void) | null = null;

  // Idempotent so it's safe to bind to BOTH readline's 'SIGINT' (fires on a TTY
  // when a listener is present) and the process signal (the fallback if Bun's
  // readline doesn't emit 'SIGINT'); at most one fires per platform, and a
  // double-fire is harmless — abort() is a no-op the second time.
  const interrupt = (): void => {
    if (currentRun) {
      if (!currentRun.signal.aborted) writeLine(dim("  ⏹ interrupting…"));
      currentRun.abort();
    } else if (!closed) {
      rl.close();
    }
  };
  rl.on("SIGINT", interrupt);
  process.on("SIGINT", interrupt);

  // Resolve a pending prompt with null when the interface closes, so the loop
  // exits cleanly instead of hanging on an unanswered question.
  rl.on("close", () => {
    closed = true;
    if (pending) {
      pending(null);
      pending = null;
    }
  });
  const readLine = (): Promise<string | null> =>
    closed
      ? Promise.resolve(null)
      : new Promise((resolve) => {
          pending = resolve;
          rl.question("› ", (answer) => {
            pending = null;
            resolve(answer);
          });
        });

  const sessionPath = `.agent/sessions/${Date.now()}.jsonl`;
  const rollout = createRollout(sessionPath);
  const maxContextTokens = Number(process.env.AGENT_MAX_CONTEXT_TOKENS) || undefined;

  writeLine(dim(`super-agent · ${runtime.provider.name} · ${mode} — type your task, /exit to quit, Ctrl-C to interrupt`));

  try {
    await runRepl({
      runtime,
      approve,
      printer,
      readLine,
      beginRun: () => {
        currentRun = new AbortController();
        return currentRun.signal;
      },
      endRun: () => {
        currentRun = null;
      },
      rollout,
      maxContextTokens,
    });
    writeLine(dim(`(session: ${sessionPath})`));
  } finally {
    rl.close();
    await runtime.close();
    process.stdout.write(`${BOLD}bye${RESET}\n`);
  }
}

main();
