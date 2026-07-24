# super-agent

A general-purpose task agent built **from scratch** in TypeScript to learn agent
architecture hands-on — pluggable model backends, a normalized message model, a
tool registry, and a typed event stream. Runs on [Bun](https://bun.sh).

Background: [`docs/agent-research.md`](docs/agent-research.md) (how Claude Code,
Codex CLI, OpenClaw, and Hermes are built) and
[`docs/our-agent-design.md`](docs/our-agent-design.md) (our design + 8-phase plan).

## Status

**Feature-complete** through the 8-phase build. Latest — **P8 — subagents**
([issue #13](https://github.com/zq940222/super-agent/issues/13)): a `spawn_agent`
tool delegates a self-contained subtask to a fresh child `runAgent` (isolated
context — only the task goes in, only the final answer comes back), with a
recursion cap; parallel delegation falls out of the engine's parallel tool calls.

The phases: skeleton (**P1**) · reasoning loop (**P2**) · context management /
compaction + session rollout (**P4**) · permissions & safety (**P5**) ·
pluggable OpenAI + Anthropic backends (**P6**) · MCP client (**P7**) · subagents
(**P8**). See `docs/agent-research.md` for the architecture study behind them.

Permissions are enforced by the engine, **not** the prompt — the model can ask
to run a tool, but only the policy decides whether it does.

## Setup

```bash
bun install
cp .env.example .env   # then put your OPENAI_API_KEY in .env
```

## Run

```bash
bun run agent "what's in ./package.json?"
# or pipe a prompt:
echo "summarize ./README.md" | bun run agent

# switch backend by config — same loop, different model:
AGENT_PROVIDER=anthropic bun run agent "list src/ then explain engine.ts"
```

Writing a file is high-risk, so under the default policy the agent asks before
`write_file` runs. Change the posture with `AGENT_PERMISSION_MODE`:
`default` (ask), `auto` (allow everything — trusted/sandboxed only), or
`readonly` (deny writes).

To give the agent external tools, drop an `mcp.json` in the cwd (see
`mcp.json.example`). Each server's tools appear as `mcp__<server>__<tool>` and
are gated like any other tool.

You'll see the agent decide to call `read_file`, the (truncated) result, and its
final answer — the whole run rendered from the event stream.

## Develop

```bash
bun test            # unit tests (fake-provider seam + pure normalizers); no network
bun run typecheck   # tsc --noEmit
```

The live OpenAI path has one opt-in smoke test that runs only when
`OPENAI_API_KEY` is set (`test/smoke.live.test.ts`).

## Architecture (P1)

```
src/
├─ core/
│  ├─ types.ts      Message / ContentBlock / AssistantTurn / ToolSpec (provider-neutral)
│  ├─ events.ts     typed AgentEvent stream + emitter
│  ├─ engine.ts     runAgent — the ReAct loop (while tool_use, maxSteps cap)
│  └─ compaction.ts estimateTokens + compact (orphan-safe summarization)
├─ providers/
│  ├─ provider.ts  ModelProvider interface (the pluggable seam)
│  ├─ openai.ts    OpenAI adapter + pure wire-format normalizers
│  ├─ anthropic.ts Anthropic adapter + pure wire-format normalizers
│  └─ factory.ts   createProvider(name) — picks a backend by config
├─ permissions/
│  └─ gate.ts      PermissionPolicy — deny→ask→allow by mode + risk
├─ tools/
│  ├─ registry.ts  ToolRegistry + defineTool (Zod → JSON Schema + validator)
│  ├─ workspace.ts resolveInWorkspace — file-tool path boundary
│  ├─ read-file.ts read_file (with built-in output truncation)
│  ├─ list-dir.ts  list_dir (directory listing, capped)
│  └─ write-file.ts write_file (high-risk; gated by the permission policy)
├─ session/
│  └─ rollout.ts   append-only JSONL session persistence
├─ mcp/
│  ├─ client.ts    minimal MCP stdio JSON-RPC client (initialize/list/call)
│  └─ register.ts  connectMcpServer — register MCP tools into the registry
├─ agents/
│  └─ subagent.ts  createSubagentTool — spawn_agent (isolated child runAgent)
└─ cli/main.ts     minimal terminal front-end
```

**Design seams worth knowing:** the engine depends only on `ModelProvider`, so
tests drive it with a scripted fake provider — no network. Each tool's
model-facing JSON Schema and runtime validator are derived from one Zod schema,
so they can't drift. Tool output is size-capped so it can't blow out the context
window.
