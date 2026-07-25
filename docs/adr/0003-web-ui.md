# ADR 0003 — Web UI: a zero-dep streaming server + a React client, over transport "B"

- **Status:** Accepted
- **Date:** 2026-07-25
- **Deciders:** @zq940222
- **Related:** [P13 — #32](https://github.com/zq940222/super-agent/issues/32), [ADR-0001](0001-interactive-tui-frontend.md) (thin-client-over-events premise), [ADR-0002](0002-token-streaming.md) (streaming this renders live)

## Context

The agent has two frontends — the one-shot CLI and the interactive TUI. Both are thin
clients over the engine's `AgentEvent` stream plus an `approve` callback (ADR-0001). A web UI
is a **third** such client, but unlike the terminal ones it needs a **server** hosting the
engine and a **transport** carrying the event stream to a browser and prompts/approvals back.

The engine is already built for this: `bootstrap()` assembles a `Runtime`, `runAgent`
streams typed events, and `history`/`signal`/`stream` are the seams a multi-turn, cancellable,
live-rendering frontend needs. Nothing in the core changes.

## Decision

### 1. Transport "B": `POST /prompt` returns the run's event stream as its body

A run's lifecycle **is** an HTTP request's lifecycle. The browser `POST`s a prompt; the
response body is a stream of the run's `AgentEvent`s (newline-delimited JSON — **NDJSON**),
which the client reads via `fetch` + `ReadableStream`. When the run ends, the body closes.

The alternative (a standing `GET /events` EventSource + separate `POST` commands) was
rejected: an SSE drop doesn't cancel the run, forcing a manual `/cancel` route and
close-detection. With B, **client disconnect = cancellation for free** — a spike confirmed
`Bun.serve` fires `request.signal` on disconnect and supports a streaming `Response` body, so
the server threads `request.signal` straight into `runAgent({ signal })`. Tab close or a Stop
button (aborting the `fetch`) aborts the run between steps and mid-model-call (ADR-0002 §3).
The cost — hand-parsing NDJSON instead of EventSource's built-in framing — is small and
one-directional streaming is exactly what B does well.

**`idleTimeout: 0` is required** on `Bun.serve`. Transport B holds the `/prompt` response open
for the whole run, and it legitimately idles while parked at an approval or a slow model
call; Bun's default 10s idle timeout would kill the stream mid-run. Disconnect is detected by
`request.signal`, not the idle timeout, so disabling it is safe. The `serve()` helper sets it
(unit tests never idle that long, so this only surfaces in a real run — it did).

### 2. Server: `Bun.serve`, zero dependencies, reuses `bootstrap`

The server is hand-rolled on `Bun.serve` — no framework — consistent with the from-scratch
ethos (the same reasoning that kept the TUI dependency-free). It owns a `Runtime` from
`bootstrap()` and, like `bootstrap` takes an injectable `provider`, the server takes an
**injectable `Runtime`** so tests drive it with a `ScriptedProvider` over real HTTP, no key
and no browser.

Routes (all behind the auth gate below): `POST /prompt` (stream a run), `POST /approve`
(resolve a gated tool), static serving of the built client.

### 3. Security is the OUTERMOST layer of the server, not an afterthought

The server executes `write_file`, `spawn_agent`, and MCP tools — an unauthenticated local
endpoint is local-RCE-adjacent. **Binding to `127.0.0.1` does not protect it:** any web page
in the user's browser can fire a no-preflight `POST` to `http://127.0.0.1:<port>` or open the
stream and exfiltrate output. So the first thing every request hits:

- **A per-session token**, required on *every* route including the initial `GET /` and the
  event stream. Generated on startup and printed in the URL (`/?token=…`); the client reads it
  from the query and remembers it for the tab (`sessionStorage`), sending it on every request.
- **An `Origin`/`Host` allowlist** — reject anything not from the server's own localhost
  origin. This blocks CSRF and DNS-rebinding.

The auth check wraps the router (`serve()` is the only public entrypoint) so no route can be
added that skips it.

**Token-in-URL is accepted, consciously (P13-4).** The token sits in the address bar and
history — the Jupyter-grade posture, fine for a localhost single-user tool. It is deliberately
*not* scrubbed (`history.replaceState`): scrubbing would break reload, because the reload's
`GET /` for the HTML carries no token (the JS that reads `sessionStorage` hasn't run yet) and
would 401. Reload-safe token-in-URL beats a scrub that needs a `Set-Cookie` session to survive
reload — the cookie path is deferred.

### 4. Disconnect cancels the run AND rejects any pending approval

`gateAndExecute` awaits `approve`; if the browser closes mid-modal, that promise would never
resolve and the run would hang holding resources (the web analogue of the TUI's sticky
Ctrl-C-at-approval, but with no human to press `n`). The server ties the pending-approval
lifecycle to `request.signal`: on abort, pending approvals reject/deny and the run cancels.

HITL: the engine emits a `permission_request` event (the client sees it in the stream) and its
`approve` call parks a single pending resolver; the client `POST /approve`s the decision, which
resolves it. Serialized like the TUI approver, so at most one approval is outstanding — the
client answers "the current approval", **no id needed**.

**v1 scopes the bridge to the main loop (P13-4).** The `bun run web` entry bootstraps the
runtime with *no* approver, so a subagent's ask-tier tool auto-denies (fail-closed) rather than
routing to the browser. This keeps the bridge single-caller and sequential — the serialized
chain and the shared pending-resolver are never under real concurrency. Routing subagent
approvals to the browser (which would need per-run scoping of the resolver and a
concurrent-approval test) is deferred.

This is a **UX boundary, not a security hole, and it rests on `spawn_agent` being low-risk**
(so the parent delegates freely; only the child's ask-tier tools deny). If `spawn_agent` is
ever made ask-tier, delegation itself would prompt the browser, but a delegated task needing
`write_file` would still silently dead-end — revisit the subagent-approval routing then.

### 5. Reuse the pure pieces, not the renderer

`render.ts`/`transcript.ts` emit ANSI — the browser re-renders in HTML, so they don't cross
over. But `conversation.ts`'s `nextHistory` is pure and provider-agnostic: the server reuses
it for multi-turn (same "advance history only on `end_turn`" contract). The server's
read→run→stream loop mirrors `runRepl` but isn't literally shareable (different I/O) — a
parallel loop that reuses the pure pieces.

### 6. Client: React + Vite, scoped to `web/`

The browser client is a **React + Vite** app (the maintainer's explicit choice for an
evolvable product face). This deviates from the project's zero-dependency ethos, so it is
**contained**: it lives in its own `web/` subproject with its own `package.json`/build; the
agent core and the server stay dependency-clean. The client consumes the NDJSON stream, renders
tokens live (ADR-0002), and shows a `<dialog>` approval modal. It is the untested glue layer —
the web analogue of the terminal glue — with logic (auth, security, the run loop, history
threading) living server-side where it's tested.

**Serving constraint (decided for P13-4):** "token on every route" (§3) and a normal Vite
build conflict — the browser fetches hashed `/assets/*.js|.css` with no token and no Origin,
which the gate would 401. So the built client must arrive as a **single `?token=`-authorized
document**: a single-file Vite build (e.g. `vite-plugin-singlefile`) that inlines JS/CSS into
one `index.html`. This keeps the gate intact (the whole app arrives in the one authorized
document) and avoids a cookie-session path; chosen over the Jupyter-style cookie model for
being smaller and more ethos-consistent.

## Consequences

**Positive**
- A third frontend with **zero engine changes** — the thin-client-over-events premise pays off again.
- Disconnect-as-cancel and reject-pending-approval fall out of transport B + `request.signal`
  for free; no `/cancel` route, no hung runs.
- The server is hermetically testable (Bun.serve on port 0 + `fetch` + injected `Runtime`);
  the React client is the only untested surface.
- The dependency deviation (React/Vite) is contained to `web/`; core and server stay clean.

**Negative / accepted trade-offs**
- NDJSON hand-parsing on the client instead of EventSource's framing (small).
- The `web/` subproject adds a build step and a second dependency tree — the cost of the
  React choice, accepted deliberately and quarantined.
- Single localhost session for v1 (no multi-user, no auth beyond the local token, no
  persistence beyond the rollout). Multi-client/shared state is out of scope.

## Alternatives considered

- **Standing `GET /events` (EventSource) + `POST` commands (transport A).** Rejected: needs a
  manual `/cancel` and close-detection; disconnect doesn't cancel. B's lifecycle elegance wins
  for a single-session tool, and the spike de-risked it.
- **A server framework (Hono/Express).** Rejected: `Bun.serve` covers routing + streaming with
  zero deps, matching the ethos for the server layer.
- **Plain HTML/JS client (no build).** The advisor's recommendation and ethos-consistent, but
  the maintainer chose React/Vite for an evolvable UI; recorded here and contained to `web/`.
- **WebSocket transport.** Bidirectional, but the model is a one-way event stream plus discrete
  POST commands — SSE-shaped over a streaming response body fits without WS's overhead.
