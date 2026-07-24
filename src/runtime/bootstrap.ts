/**
 * Session bootstrap — assemble the pieces a run needs, once per session, so
 * every frontend (one-shot CLI, interactive TUI) shares identical wiring.
 *
 * What lives here is session-scoped and UI-agnostic: the provider, the tool
 * registry (native + skills + MCP + spawn_agent), the system prompt, and the
 * permission policy. What stays in the frontend is the *view* (how events are
 * rendered) and the *main-loop* `events` emitter (per-run). The frontend
 * supplies its `approve` callback and an optional child-event handler; both are
 * stable for the life of the session, so they're baked into the subagent tool
 * here rather than threaded per-run. See ADR-0001 §5.
 */

import { EventEmitter, type EventHandler } from "../core/events";
import { createProvider } from "../providers/factory";
import type { ModelProvider } from "../providers/provider";
import { PermissionPolicy, type Approver, type PermissionMode } from "../permissions/gate";
import { connectMcpServer } from "../mcp/register";
import type { McpClient } from "../mcp/client";
import { createSubagentTool } from "../agents/subagent";
import { SkillStore } from "../skills/store";
import { createSkillTools, skillsCatalog } from "../skills/tools";
import { readFileTool } from "../tools/read-file";
import { listDirTool } from "../tools/list-dir";
import { writeFileTool } from "../tools/write-file";
import { ToolRegistry } from "../tools/registry";

/** The agent's stable system prompt (skills catalog is appended at bootstrap). */
export const SYSTEM = [
  "You are super-agent, a general-purpose assistant running in a terminal.",
  "You can call tools: list_dir to explore directories, read_file to read files,",
  "write_file to create or overwrite files, and spawn_agent to delegate a",
  "self-contained subtask to a fresh subagent (which returns only its final answer).",
  "Break the task into steps, use tools to gather what you need,",
  "and when you have enough information, answer the user directly and concisely.",
].join(" ");

export interface BootstrapOptions {
  /** Inject a provider (tests / embedding). Default: `createProvider()` from env. */
  provider?: ModelProvider;
  /** Permission mode. Default `default` (low-risk allowed, else ask). */
  mode?: PermissionMode;
  /** HITL approver — used by both the main loop and subagents. */
  approve?: Approver;
  /** Observe subagent (child) runs, e.g. for nested rendering (source-tagged). */
  onChildEvent?: EventHandler;
  /** Skill library directory. Default `$AGENT_SKILLS_DIR` or `.agent/skills`. */
  skillsDir?: string;
  /** Hard cap on a subagent's model turns. Default 10. */
  subagentMaxSteps?: number;
  /** Connect MCP servers declared in ./mcp.json. Default true; tests opt out. */
  loadMcp?: boolean;
  /** Sink for startup diagnostics (backend line, MCP successes). */
  log?: (message: string) => void;
  /** Sink for startup *failures* (MCP connect errors). Defaults to `log`. */
  logError?: (message: string) => void;
}

export interface Runtime {
  provider: ModelProvider;
  registry: ToolRegistry;
  system: string;
  /** Session-scoped: an `allowForSession` here persists across turns. */
  policy: PermissionPolicy;
  mode: PermissionMode;
  /** Release session resources (closes MCP clients). */
  close(): Promise<void>;
}

export async function bootstrap(opts: BootstrapOptions = {}): Promise<Runtime> {
  const provider = opts.provider ?? createProvider();
  const mode = opts.mode ?? "default";
  const policy = new PermissionPolicy({ mode });
  opts.log?.(`backend: ${provider.name} · permissions: ${mode}`);

  const registry = new ToolRegistry()
    .register(readFileTool)
    .register(listDirTool)
    .register(writeFileTool);

  // Skills (P9): reusable procedure docs the agent can find, read, and author.
  const skills = new SkillStore(opts.skillsDir || process.env.AGENT_SKILLS_DIR || ".agent/skills");
  for (const tool of createSkillTools(skills)) registry.register(tool);
  const system = `${SYSTEM}\n\n${await skillsCatalog(skills)}`;

  const logError = opts.logError ?? opts.log;
  const mcpClients = opts.loadMcp === false ? [] : await loadMcpServers(registry, opts.log, logError);

  // spawn_agent (P8): give subagents the CURRENT toolset — captured here, BEFORE
  // spawn_agent registers, so a subagent's registry excludes spawn_agent itself.
  // This is load-bearing: leaking the depth-1 spawn_agent closure would let
  // subagents delegate without bound (maxDepth wouldn't save us).
  const childEvents = new EventEmitter();
  if (opts.onChildEvent) childEvents.on(opts.onChildEvent);
  registry.register(
    createSubagentTool({
      provider,
      tools: registry.all(),
      system,
      policy,
      approve: opts.approve,
      events: childEvents,
      maxSteps: opts.subagentMaxSteps ?? 10,
    }),
  );

  return {
    provider,
    registry,
    system,
    policy,
    mode,
    async close() {
      await Promise.all(mcpClients.map((c) => c.close()));
    },
  };
}

/** Connect any MCP servers declared in ./mcp.json and register their tools. */
async function loadMcpServers(
  registry: ToolRegistry,
  log?: (m: string) => void,
  logError?: (m: string) => void,
): Promise<McpClient[]> {
  const file = Bun.file("mcp.json");
  if (!(await file.exists())) return [];
  const clients: McpClient[] = [];
  try {
    const config = (await file.json()) as {
      servers?: Record<string, { command: string; args?: string[]; env?: Record<string, string> }>;
    };
    for (const [name, cfg] of Object.entries(config.servers ?? {})) {
      try {
        const { client, toolNames } = await connectMcpServer(registry, { name, ...cfg });
        clients.push(client);
        log?.(`mcp: ${name} → ${toolNames.length} tool(s)`);
      } catch (err) {
        logError?.(`mcp: failed to connect "${name}": ${err instanceof Error ? err.message : String(err)}`);
      }
    }
  } catch (err) {
    logError?.(`mcp: could not read mcp.json: ${err instanceof Error ? err.message : String(err)}`);
  }
  return clients;
}
