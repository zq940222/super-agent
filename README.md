# super-agent

A general-purpose task agent built **from scratch** in TypeScript to learn agent
architecture hands-on — pluggable model backends, a normalized message model, a
tool registry, and a typed event stream. Runs on [Bun](https://bun.sh).

Background: [`docs/agent-research.md`](docs/agent-research.md) (how Claude Code,
Codex CLI, OpenClaw, and Hermes are built) and
[`docs/our-agent-design.md`](docs/our-agent-design.md) (our design + 8-phase plan).

## Status

**P6 — pluggable multi-backend** ([issue #5](https://github.com/zq940222/super-agent/issues/5)):
the same `runAgent` loop drives **OpenAI or Anthropic**, chosen by config
(`AGENT_PROVIDER`), proving the provider abstraction. Built on the reasoning
loop (**P2**, [#3](https://github.com/zq940222/super-agent/issues/3)) and the
skeleton (**P1**, [#1](https://github.com/zq940222/super-agent/issues/1)).
Roadmap remaining: P4 context, P5 permissions, P7 MCP, P8 subagents.

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
│  ├─ types.ts     Message / ContentBlock / AssistantTurn / ToolSpec (provider-neutral)
│  ├─ events.ts    typed AgentEvent stream + emitter
│  └─ engine.ts    runAgent — the ReAct loop (while tool_use, maxSteps cap)
├─ providers/
│  ├─ provider.ts  ModelProvider interface (the pluggable seam)
│  ├─ openai.ts    OpenAI adapter + pure wire-format normalizers
│  ├─ anthropic.ts Anthropic adapter + pure wire-format normalizers
│  └─ factory.ts   createProvider(name) — picks a backend by config
├─ tools/
│  ├─ registry.ts  ToolRegistry + defineTool (Zod → JSON Schema + validator)
│  ├─ read-file.ts read_file (with built-in output truncation)
│  └─ list-dir.ts  list_dir (directory listing, capped)
└─ cli/main.ts     minimal terminal front-end
```

**Design seams worth knowing:** the engine depends only on `ModelProvider`, so
tests drive it with a scripted fake provider — no network. Each tool's
model-facing JSON Schema and runtime validator are derived from one Zod schema,
so they can't drift. Tool output is size-capped so it can't blow out the context
window.
