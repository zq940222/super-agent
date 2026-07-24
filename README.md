# super-agent

A general-purpose task agent built **from scratch** in TypeScript to learn agent
architecture hands-on — pluggable model backends, a normalized message model, a
tool registry, and a typed event stream. Runs on [Bun](https://bun.sh).

Background: [`docs/agent-research.md`](docs/agent-research.md) (how Claude Code,
Codex CLI, OpenClaw, and Hermes are built) and
[`docs/our-agent-design.md`](docs/our-agent-design.md) (our design + 8-phase plan).

## Status

**P4 — context management** ([issue #9](https://github.com/zq940222/super-agent/issues/9)):
compaction (summarize old turns past a token budget, with an orphan-safe cut that
never splits a `tool_use` from its `tool_result`) and append-only JSONL session
rollout persistence. Prior: permissions (**P5**), multi-backend (**P6**),
reasoning loop (**P2**), skeleton (**P1**). Roadmap remaining: P7 MCP, P8 subagents.

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
└─ cli/main.ts     minimal terminal front-end
```

**Design seams worth knowing:** the engine depends only on `ModelProvider`, so
tests drive it with a scripted fake provider — no network. Each tool's
model-facing JSON Schema and runtime validator are derived from one Zod schema,
so they can't drift. Tool output is size-capped so it can't blow out the context
window.
