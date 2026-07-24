# super-agent

**English** · [简体中文](README.zh-CN.md)

A general-purpose task agent built **from scratch** in TypeScript, to learn agent
architecture hands-on. It has a normalized message model, pluggable model
backends (OpenAI + Anthropic), a tool registry, a permission gate, context
compaction, session persistence, an MCP client, subagents, and self-authored
skills — assembled over nine small, tested phases. Runs on [Bun](https://bun.sh).

New here? Start with the **[reader's guide](docs/GUIDE.md)**. The thinking behind
the design is in [`docs/agent-research.md`](docs/agent-research.md) (how Claude
Code, Codex CLI, OpenClaw, and Hermes are built) and
[`docs/our-agent-design.md`](docs/our-agent-design.md) (our design + the 8-phase plan).

## Highlights

- **One dumb loop, many backends.** A single `runAgent` ReAct loop
  (`while stop_reason == tool_use`, capped by `maxSteps`) drives OpenAI or
  Anthropic — chosen by config. Each adapter hides its wire-format differences.
- **Permissions in the harness, not the prompt.** A policy (`deny → ask → allow`,
  by mode + per-tool risk) decides what runs; risky tools trigger human-in-the-loop
  approval. The model can *ask*; only the policy *allows*.
- **Context that survives long tasks.** Compaction summarizes old turns past a
  token budget (with an orphan-safe cut that never splits a `tool_use` from its
  `tool_result`); sessions persist as append-only JSONL.
- **An open tool ecosystem.** A hand-rolled MCP (Model Context Protocol) stdio
  client registers external servers' tools through the *same* registry and
  permission gate as native tools.
- **Delegation.** A `spawn_agent` tool runs subtasks in isolated child contexts
  and returns only a distilled result; parallel delegation is free.
- **Skills (self-extension).** Reusable procedure docs (`SKILL.md`) the agent can
  `find_skill`, `read_skill`, and `create_skill` — a self-improving loop, gated
  like any other write.
- **Tested.** 86 passing tests against fake providers and a mock MCP server — no
  network needed. Type-checked with TypeScript 7.

## Setup

```bash
bun install
cp .env.example .env   # then set OPENAI_API_KEY (and/or ANTHROPIC_API_KEY)
```

## Run

```bash
bun run agent "what's in ./package.json?"
echo "summarize ./README.md" | bun run agent

# switch backend by config — same loop, different model:
AGENT_PROVIDER=anthropic bun run agent "list src/ then explain engine.ts"
```

Writing a file is high-risk, so under the default policy the agent asks before
`write_file` runs. To give it external tools, drop an `mcp.json` in the cwd (see
[`mcp.json.example`](mcp.json.example)); each server's tools appear as
`mcp__<server>__<tool>` and are gated like any other tool.

## Develop

```bash
bun test            # unit + integration tests; no network
bun run typecheck   # tsc --noEmit (TypeScript 7)
```

The live provider paths have opt-in smoke tests. They make real API calls, so
they run only with an explicit opt-in — `RUN_LIVE_SMOKE=1 bun test` — and the
matching key set. The default `bun test` is hermetic (no network) even when a
`.env` with keys is present.

## Configuration

Environment variables (see [`.env.example`](.env.example)):

| Variable | Purpose | Default |
|---|---|---|
| `AGENT_PROVIDER` | Backend: `openai` or `anthropic` | `openai` |
| `AGENT_PERMISSION_MODE` | `default` (ask), `auto` (allow all), `readonly` (deny writes) | `default` |
| `AGENT_MAX_CONTEXT_TOKENS` | Compact once the estimate exceeds this | built-in (dormant) |
| `AGENT_SKILLS_DIR` | Where reusable `SKILL.md` skills live | `.agent/skills` |
| `OPENAI_API_KEY` / `OPENAI_MODEL` / `OPENAI_BASE_URL` | OpenAI backend | model `gpt-4o-mini` |
| `ANTHROPIC_API_KEY` / `ANTHROPIC_MODEL` / `ANTHROPIC_BASE_URL` | Anthropic backend | model `claude-sonnet-5` |

Secrets are read only from the environment (or `.env`) — never hard-code them.

## Architecture

```
src/
├─ core/
│  ├─ types.ts       Message / ContentBlock / AssistantTurn / ToolSpec (provider-neutral)
│  ├─ events.ts      typed AgentEvent stream + emitter
│  ├─ engine.ts      runAgent — the ReAct loop + permission gate + compaction
│  └─ compaction.ts  estimateTokens + compact (orphan-safe summarization)
├─ providers/
│  ├─ provider.ts    ModelProvider interface (the pluggable seam)
│  ├─ openai.ts      OpenAI adapter + pure wire-format normalizers
│  ├─ anthropic.ts   Anthropic adapter + pure wire-format normalizers
│  └─ factory.ts     createProvider(name) — picks a backend by config
├─ permissions/
│  └─ gate.ts        PermissionPolicy — deny→ask→allow by mode + risk
├─ tools/
│  ├─ registry.ts    ToolRegistry + defineTool (Zod → JSON Schema + validator)
│  ├─ workspace.ts   resolveInWorkspace — file-tool path boundary
│  ├─ read-file.ts   read_file (output truncation)
│  ├─ list-dir.ts    list_dir (capped listing)
│  └─ write-file.ts  write_file (high-risk; gated)
├─ session/
│  └─ rollout.ts     append-only JSONL session persistence
├─ mcp/
│  ├─ client.ts      minimal MCP stdio JSON-RPC client (initialize/list/call)
│  └─ register.ts    connectMcpServer — register MCP tools into the registry
├─ agents/
│  └─ subagent.ts    createSubagentTool — spawn_agent (isolated child runAgent)
├─ skills/
│  ├─ store.ts       SkillStore — SKILL.md files (list/find/read/create)
│  └─ tools.ts       find_skill / read_skill / create_skill + system catalog
└─ cli/main.ts       minimal terminal front-end
```

Built-in tools: `read_file`, `list_dir`, `write_file`, `spawn_agent`,
`find_skill`, `read_skill`, `create_skill`, plus any MCP tools you configure.

## The phases

Each phase is one merged PR and turns a researched principle into tested code:

| Phase | What | Principle |
|---|---|---|
| P1 | skeleton: provider abstraction, message model, single tool round-trip | wire protocol, tool_use/tool_result |
| P2 | the ReAct loop (`while tool_use` + `maxSteps`) | the loop *is* the agent |
| P4 | context management: compaction + session rollout | context rot, external memory |
| P5 | permissions & safety: gate + HITL + workspace boundary | two-layer enforcement, lethal trifecta |
| P6 | pluggable multi-backend: Anthropic adapter + factory | provider normalization |
| P7 | MCP client | one gate for every tool source |
| P8 | subagents: `spawn_agent` | context isolation, orchestrator-worker |
| P9 | skills: find / read / create | self-extension, skills ≠ tools |

## Status & limits

Feature-complete through P9. Deliberately deferred (see the design doc): a local
(Ollama/LM Studio) backend, streaming, a `bash` tool, content-level
prompt-injection scanning, MCP HTTP transport, resuming a saved session into
the live loop, and a shared skill registry.

Built to learn — not a supported product.
