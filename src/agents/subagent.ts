/**
 * Subagents — the orchestrator-worker pattern (P8).
 *
 * `createSubagentTool` returns a `spawn_agent` tool. When the model calls it,
 * the handler runs a CHILD `runAgent` in a fresh context whose only input is the
 * `task` string (the sole channel in — the parent's history never leaks), with
 * its own tool registry. Only the child's final text returns to the parent.
 *
 * This buys two things (kept distinct per the research): context isolation
 * (a clean window that returns a distilled summary) and — via the engine's
 * existing parallel tool execution — parallel delegation when the model emits
 * several `spawn_agent` calls at once.
 *
 * Recursion is capped by `maxDepth` (default 1 ⇒ subagents are leaves). The
 * child inherits the parent's provider/policy/approver, so its OWN tool calls
 * are still gated. See issue #13.
 */

import { z } from "zod";
import { runAgent } from "../core/engine";
import type { EventEmitter } from "../core/events";
import type { Approver, PermissionPolicy } from "../permissions/gate";
import type { ModelProvider } from "../providers/provider";
import { ToolRegistry, type RegisteredTool, type Risk } from "../tools/registry";

export interface SubagentOptions {
  provider: ModelProvider;
  /** Toolset each subagent gets (the `spawn_agent` tool is added automatically up to maxDepth). */
  tools: RegisteredTool[];
  system?: string;
  maxSteps?: number;
  /** Nesting levels of subagents allowed. Default 1 (children are leaves). */
  maxDepth?: number;
  /** Inherited by children so their own tool calls stay gated. */
  policy?: PermissionPolicy;
  approve?: Approver;
  /** Optional: observe child runs (e.g. to render nested progress). */
  events?: EventEmitter;
  /** Risk of the spawn_agent tool itself. Default "low" (delegation isn't destructive). */
  risk?: Risk;
}

export function createSubagentTool(opts: SubagentOptions, depth = 1): RegisteredTool {
  const maxDepth = opts.maxDepth ?? 1;

  return {
    spec: {
      name: "spawn_agent",
      description:
        "Delegate a self-contained subtask to a fresh subagent with its own context. " +
        "Returns only the subagent's final answer. Use it for focused research or " +
        "independent, parallelizable work. The task description must be COMPLETE and " +
        "standalone — the subagent cannot see this conversation.",
      inputSchema: z.toJSONSchema(
        z.object({
          task: z
            .string()
            .min(1)
            .describe("A complete, standalone description of the subtask, including all needed context."),
        }),
      ) as Record<string, unknown>,
    },
    risk: opts.risk ?? "low",
    validate: (input: unknown) => {
      const parsed = z.object({ task: z.string().min(1) }).safeParse(input);
      return parsed.success
        ? { ok: true, value: parsed.data }
        : { ok: false, error: parsed.error.issues.map((i) => i.message).join("; ") };
    },
    handler: async (input: { task: string }, ctx) => {
      const registry = new ToolRegistry();
      for (const tool of opts.tools) registry.register(tool);
      // Allow deeper nesting only while under the cap.
      if (depth < maxDepth) {
        registry.register(createSubagentTool(opts, depth + 1));
      }

      const result = await runAgent(input.task, {
        provider: opts.provider,
        registry,
        system: opts.system,
        maxSteps: opts.maxSteps,
        cwd: ctx.cwd,
        workspaceRoot: ctx.workspaceRoot,
        policy: opts.policy,
        approve: opts.approve,
        events: opts.events,
      });

      return result.text || "(subagent produced no text)";
    },
  };
}
