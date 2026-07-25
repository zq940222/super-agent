/**
 * HITL approver for the TUI (P-tui-4).
 *
 * Line-based (read `y`/`n`/`a` + Enter), matching the original CLI's `prompt()`
 * approver — single-keypress is a polish follow-up, and line input avoids the
 * raw-mode↔readline fight for v1.
 *
 * SERIALIZED. `spawn_agent` is low-risk, so two `spawn_agent` calls in one turn
 * run concurrently (the engine executes them via `Promise.all`); each child can
 * hit an ask-tier tool and call this *same* approver at the same time. Two
 * prompts pending on one input stream would let a keystroke resolve the wrong
 * one — and because approve gates writes, that is a wrong *safety* decision, not
 * a cosmetic glitch. The promise-chain below presents approvals strictly one at
 * a time. See ADR-0001 §5.
 */

import type { Approver, PermissionPolicy, PermissionRequest } from "../permissions/gate";

export type ApprovalChoice = "yes" | "no" | "always";

/** Map a line of input to a choice, or null if unrecognized (caller re-asks). */
export function choiceFromInput(input: string): ApprovalChoice | null {
  const c = input.trim().toLowerCase();
  if (c === "y" || c === "yes") return "yes";
  if (c === "a" || c === "always") return "always";
  if (c === "n" || c === "no" || c === "") return "no"; // empty ⇒ safe default: deny
  return null;
}

export interface ApproverIO {
  /** Show a prompt and read one line back. */
  ask: (prompt: string) => Promise<string>;
}

function preview(text: string, n = 60): string {
  const first = text.split("\n")[0] ?? "";
  return first.length > n ? first.slice(0, n) + "…" : first;
}

export function createApprover(policy: PermissionPolicy, io: ApproverIO): Approver {
  const one = async (req: PermissionRequest): Promise<boolean> => {
    const label = `${req.name}(${preview(JSON.stringify(req.input))})`;
    // High-risk tools can't be "always"-allowed (ADR-0005 §3), so don't offer the
    // choice — showing it and then silently re-prompting would mislead the user.
    const highRisk = req.risk === "high";
    const prompt = highRisk
      ? `🔐 Allow ${label}? (high-risk — asks every time) [y]es / [n]o `
      : `🔐 Allow ${label}? [y]es / [n]o / [a]lways `;
    let choice: ApprovalChoice | null = null;
    while (choice === null) {
      choice = choiceFromInput(await io.ask(prompt));
    }
    // "always" grants a session allow-rule on the SHARED policy, so the engine
    // stops routing this tool to `ask` on later turns. allowForSession refuses a
    // high-risk rule, so even a typed 'a' only approves this one call.
    if (choice === "always") policy.allowForSession(req.name, req.risk);
    return choice !== "no";
  };

  // Chain each call after the previous settles (resolve OR reject) so at most
  // one prompt is ever outstanding.
  let tail: Promise<boolean> = Promise.resolve(true);
  return (req) => {
    const next = tail.then(
      () => one(req),
      () => one(req),
    );
    tail = next;
    return next;
  };
}
