/**
 * Permission gate — the harness-layer brake (P5).
 *
 * Between "the model requested tool X" and "tool X runs", a policy classifies
 * the call as allow / ask / deny. This is enforced by the engine, NOT by the
 * prompt — instructions can shape what the model tries, but only this decides
 * what actually executes (the two-layer principle from the research).
 *
 * Precedence for explicit name rules: deny → ask → allow. Otherwise fall back
 * to a mode combined with the tool's declared risk. See issue #7.
 */

import type { Risk } from "../tools/registry";

export type Decision = "allow" | "ask" | "deny";

/**
 * - `auto`     — allow everything (use only in trusted/sandboxed contexts).
 * - `default`  — low-risk allowed; medium/high must be approved (ask).
 * - `readonly` — low-risk allowed; everything else denied.
 */
export type PermissionMode = "auto" | "default" | "readonly";

export interface PermissionRequest {
  name: string;
  input: unknown;
  risk: Risk;
}

/** HITL callback: return true to allow, false to deny. */
export type Approver = (req: PermissionRequest) => Promise<boolean>;

export interface PermissionPolicyOptions {
  mode?: PermissionMode;
  /** Tool names always allowed (overrides the mode). */
  allow?: string[];
  /** Tool names always requiring approval. */
  ask?: string[];
  /** Tool names always denied (highest precedence). */
  deny?: string[];
}

export class PermissionPolicy {
  private readonly mode: PermissionMode;
  private readonly allow: Set<string>;
  private readonly ask: Set<string>;
  private readonly deny: Set<string>;

  constructor(opts: PermissionPolicyOptions = {}) {
    this.mode = opts.mode ?? "default";
    this.allow = new Set(opts.allow ?? []);
    this.ask = new Set(opts.ask ?? []);
    this.deny = new Set(opts.deny ?? []);
  }

  /**
   * Grant a tool an always-allow rule for the rest of the session — e.g. the
   * HITL "always allow" choice, so a repeated call stops prompting. Precedence
   * is unchanged: an explicit `deny`/`ask` rule still wins (see `decide`), and
   * `readonly` denies risky tools outright without ever prompting, so this can
   * only take effect after an `ask` actually fired. See ADR-0001 §5.
   *
   * A `high`-risk tool is **never** persisted here (ADR-0005 §3): the one-click
   * "always allow" answers "is *this* command OK?", not "run everything
   * unprompted", so a standing rule would be a consent mismatch. The current
   * call is still approved by the approver; it just won't skip future prompts.
   * Deliberate up-front escape hatches — `auto` mode and a construction-time
   * `allow: [...]` rule — are unaffected; only the runtime click is refused.
   * Returns whether a standing rule was granted. See ADR-0005 §3.
   */
  allowForSession(name: string, risk?: Risk): boolean {
    if (risk === "high") return false;
    this.allow.add(name);
    return true;
  }

  decide(tool: { name: string; risk: Risk; mutates?: boolean }): Decision {
    if (this.deny.has(tool.name)) return "deny";
    if (this.ask.has(tool.name)) return "ask";
    if (this.allow.has(tool.name)) return "allow";
    switch (this.mode) {
      case "auto":
        return "allow";
      case "readonly":
        // Truly read-only: allow only low-risk, NON-mutating tools. This keeps
        // readonly blocking writes even though write_file is low-risk.
        return tool.risk === "low" && !tool.mutates ? "allow" : "deny";
      case "default":
        return tool.risk === "low" ? "allow" : "ask";
    }
  }
}
