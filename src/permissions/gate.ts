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

  decide(tool: { name: string; risk: Risk }): Decision {
    if (this.deny.has(tool.name)) return "deny";
    if (this.ask.has(tool.name)) return "ask";
    if (this.allow.has(tool.name)) return "allow";
    switch (this.mode) {
      case "auto":
        return "allow";
      case "readonly":
        return tool.risk === "low" ? "allow" : "deny";
      case "default":
        return tool.risk === "low" ? "allow" : "ask";
    }
  }
}
