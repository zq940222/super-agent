# super-agent

A general-purpose task agent built **from scratch** in TypeScript to learn agent
architecture hands-on — pluggable model backends, a normalized message model, a
tool registry, and a typed event stream. Runs on [Bun](https://bun.sh).

Background: [`docs/agent-research.md`](docs/agent-research.md) (how Claude Code,
Codex CLI, OpenClaw, and Hermes are built) and
[`docs/our-agent-design.md`](docs/our-agent-design.md) (our design + 8-phase plan).

## Status

**P1 — agent skeleton** ([issue #1](https://github.com/zq940222/super-agent/issues/1)): a provider
abstraction (OpenAI), the message/turn model, a tool registry with `read_file`,
and a single tool-call round-trip with a typed event stream. The generalized
reasoning loop is **P2** (see the design doc for the roadmap).

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
│  └─ engine.ts    the single tool-call round-trip driver
├─ providers/
│  ├─ provider.ts  ModelProvider interface (the pluggable seam)
│  └─ openai.ts    OpenAI adapter + pure wire-format normalizers
├─ tools/
│  ├─ registry.ts  ToolRegistry + defineTool (Zod → JSON Schema + validator)
│  └─ read-file.ts read_file (with built-in output truncation)
└─ cli/main.ts     minimal terminal front-end
```

**Design seams worth knowing:** the engine depends only on `ModelProvider`, so
tests drive it with a scripted fake provider — no network. Each tool's
model-facing JSON Schema and runtime validator are derived from one Zod schema,
so they can't drift. Tool output is size-capped so it can't blow out the context
window.
