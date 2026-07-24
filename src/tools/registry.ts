/**
 * Tool registry. Maps a tool name to its spec (model-facing), handler
 * (executable), risk (feeds the future permission gate), and an optional
 * availability check (Hermes-style: a tool whose prerequisites aren't
 * configured simply isn't offered to the model).
 *
 * `defineTool` derives the model-facing JSON Schema AND the runtime validator
 * from ONE Zod schema, so they can never drift apart (design principle).
 *
 * See docs/our-agent-design.md §3 and docs/agent-research.md §4.1.
 */

import { z } from "zod";
import type { ToolSpec } from "../core/types";

export type Risk = "low" | "medium" | "high";

export interface ToolContext {
  /** Working directory tools resolve relative paths against. */
  cwd: string;
  /** If set, file tools reject paths that escape this root (see workspace.ts). */
  workspaceRoot?: string;
}

export type ToolHandler = (input: any, ctx: ToolContext) => Promise<string> | string;

export type Validation =
  | { ok: true; value: unknown }
  | { ok: false; error: string };

export interface RegisteredTool {
  spec: ToolSpec;
  handler: ToolHandler;
  risk: Risk;
  /** Validate/coerce raw model input before the handler runs. */
  validate?: (input: unknown) => Validation;
  /** Return false to hide this tool from the model this session. */
  check?: () => boolean;
}

export class ToolRegistry {
  private tools = new Map<string, RegisteredTool>();

  register(tool: RegisteredTool): this {
    this.tools.set(tool.spec.name, tool);
    return this;
  }

  get(name: string): RegisteredTool | undefined {
    return this.tools.get(name);
  }

  /** Specs for every currently-available tool, to hand to the model. */
  list(): ToolSpec[] {
    return [...this.tools.values()]
      .filter((t) => (t.check ? t.check() : true))
      .map((t) => t.spec);
  }
}

/**
 * Author a tool from a Zod schema. One schema → JSON Schema (for the model)
 * + safeParse validator (for the runtime). Zod 4 ships `z.toJSONSchema`.
 */
export function defineTool<S extends z.ZodType>(opts: {
  name: string;
  description: string;
  schema: S;
  risk?: Risk;
  handler: (input: z.infer<S>, ctx: ToolContext) => Promise<string> | string;
  check?: () => boolean;
}): RegisteredTool {
  const inputSchema = z.toJSONSchema(opts.schema) as Record<string, unknown>;
  return {
    spec: { name: opts.name, description: opts.description, inputSchema },
    risk: opts.risk ?? "low",
    handler: opts.handler as ToolHandler,
    check: opts.check,
    validate: (input: unknown): Validation => {
      const parsed = opts.schema.safeParse(input);
      if (parsed.success) return { ok: true, value: parsed.data };
      const msg = parsed.error.issues
        .map((i) => `${i.path.join(".") || "(root)"}: ${i.message}`)
        .join("; ");
      return { ok: false, error: msg };
    },
  };
}
