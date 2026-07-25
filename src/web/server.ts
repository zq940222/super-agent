/**
 * Web UI server (P13-1) — a zero-dependency `Bun.serve` handler that streams a
 * run's event stream to the browser over transport "B": `POST /prompt` returns
 * the run's `AgentEvent`s as NDJSON in the response body, and a client
 * disconnect (tab close / Stop) aborts `request.signal`, which the server
 * threads into `runAgent({ signal })` — so disconnect = cancel, for free.
 *
 * Security is the OUTERMOST layer: every request must carry the per-session
 * token, and its `Origin`/`Host` must be our own localhost origin (127.0.0.1
 * alone protects nothing — any browser page can POST to localhost). See ADR-0003.
 *
 * The handler takes an injected `Runtime` (like bootstrap takes a provider), so
 * it's testable over real HTTP with a scripted provider — no key, no browser.
 */

import { runAgent } from "../core/engine";
import { EventEmitter, type AgentEvent } from "../core/events";
import type { Approver } from "../permissions/gate";
import type { Runtime } from "../runtime/bootstrap";
import type { RolloutRecorder } from "../session/rollout";
import type { Message } from "../core/types";
import { nextHistory } from "../tui/conversation";

export interface WebServerOptions {
  /** Injected session runtime (bootstrap output). */
  runtime: Runtime;
  /** Per-session bearer token required on every route. */
  token: string;
  /** Our own origin, e.g. "http://localhost:8787" — requests must match it. */
  origin: string;
  /** The built client's HTML to serve at `/` (single-file build). Falls back to
   *  a placeholder when absent, so the API is usable before the client is built. */
  indexHtml?: string;
  rollout?: RolloutRecorder;
  maxContextTokens?: number;
}

const json = (status: number, body: unknown): Response =>
  new Response(JSON.stringify(body), { status, headers: { "content-type": "application/json" } });

export interface AuthDecision {
  ok: boolean;
  status?: number;
  error?: string;
}

/**
 * The security gate as a pure function (so every rule is testable without
 * Request-header quirks). Precedence: token → origin → host.
 * - token: the per-session secret must match (else 401).
 * - origin: a present `Origin` must equal ours — a cross-origin page's POST
 *   carries its own, so this blocks CSRF (else 403). A missing Origin is fine
 *   (same-origin GETs and non-browser clients omit it); the token still gates.
 * - host: the `Host` must be our loopback, blocking DNS-rebinding (else 403).
 */
export function authorize(p: {
  provided: string | null;
  token: string;
  reqOrigin: string | null;
  origin: string;
  host: string;
}): AuthDecision {
  if (p.provided !== p.token) return { ok: false, status: 401, error: "unauthorized" };
  if (p.reqOrigin !== null && p.reqOrigin !== p.origin) return { ok: false, status: 403, error: "forbidden origin" };
  if (!/^(localhost|127\.0\.0\.1)(:\d+)?$/.test(p.host)) return { ok: false, status: 403, error: "forbidden host" };
  return { ok: true };
}

/** Extract the auth-relevant fields from a Request and apply `authorize`. */
function reject(req: Request, token: string, origin: string): Response | null {
  const url = new URL(req.url);
  const provided =
    req.headers.get("authorization")?.replace(/^Bearer\s+/i, "") ?? url.searchParams.get("token");
  const decision = authorize({
    provided: provided ?? null,
    token,
    reqOrigin: req.headers.get("origin"),
    origin,
    host: req.headers.get("host") ?? "",
  });
  return decision.ok ? null : json(decision.status ?? 403, { error: decision.error });
}

/**
 * Start the server. `idleTimeout: 0` is REQUIRED: transport B keeps the /prompt
 * response open for the whole run, and it legitimately idles while parked at an
 * approval or a slow model call — Bun's default 10s idle timeout would kill it
 * mid-run. Disconnect is handled by `request.signal`, not the idle timeout.
 */
export function serve(opts: WebServerOptions & { port?: number }): ReturnType<typeof Bun.serve> {
  return Bun.serve({ port: opts.port ?? 8787, idleTimeout: 0, fetch: createFetchHandler(opts) });
}

export function createFetchHandler(opts: WebServerOptions): (req: Request) => Promise<Response> | Response {
  let history: Message[] = [];
  let running = false;

  // HITL bridge. The engine emits a `permission_request` event (the client sees
  // it in the stream); its `approve` call parks here until `POST /approve`
  // resolves it. Serialized (a promise chain) so at most one prompt is pending —
  // the client answers "the current approval", no id needed. On disconnect the
  // pending approval is denied, so a closed tab can't hang the run. ADR-0003 §4.
  let pendingApproval: ((allow: boolean) => void) | null = null;

  function makeApprover(signal: AbortSignal): Approver {
    let tail: Promise<unknown> = Promise.resolve();
    const one = (): Promise<boolean> =>
      new Promise<boolean>((resolve) => {
        if (signal.aborted) return resolve(false); // disconnected before we asked → deny
        pendingApproval = (allow) => {
          pendingApproval = null;
          resolve(allow);
        };
      });
    return () => {
      const next = tail.then(one, one);
      tail = next.then(
        () => undefined,
        () => undefined,
      );
      return next;
    };
  }

  async function handlePrompt(req: Request): Promise<Response> {
    if (running) return json(409, { error: "a run is already in progress" });
    let body: { prompt?: unknown };
    try {
      body = (await req.json()) as { prompt?: unknown };
    } catch {
      return json(400, { error: "invalid JSON body" });
    }
    const prompt = typeof body.prompt === "string" ? body.prompt.trim() : "";
    if (!prompt) return json(400, { error: "missing prompt" });

    running = true;
    // Disconnect denies any pending approval so gateAndExecute unblocks and the
    // run reaches its abort check instead of hanging.
    req.signal.addEventListener("abort", () => pendingApproval?.(false), { once: true });
    const approve = makeApprover(req.signal);
    const encoder = new TextEncoder();
    const stream = new ReadableStream<Uint8Array>({
      async start(controller) {
        const write = (event: AgentEvent): void => {
          // The client may have disconnected; enqueuing to a torn-down stream throws.
          try {
            controller.enqueue(encoder.encode(JSON.stringify(event) + "\n"));
          } catch {
            /* stream closed — ignore */
          }
        };
        const events = new EventEmitter().on(write);
        try {
          const result = await runAgent(prompt, {
            provider: opts.runtime.provider,
            registry: opts.runtime.registry,
            system: opts.runtime.system,
            policy: opts.runtime.policy,
            approve,
            workspaceRoot: process.cwd(),
            maxContextTokens: opts.maxContextTokens,
            rollout: opts.rollout,
            events,
            history,
            signal: req.signal, // disconnect → cancel (ADR-0003 §1)
            stream: true,
          });
          history = nextHistory(history, result);
        } catch (err) {
          write({ type: "error", message: err instanceof Error ? err.message : String(err) });
        } finally {
          running = false;
          pendingApproval = null; // this run owns the slot; don't let a late abort touch the next run
          try {
            controller.close();
          } catch {
            /* already closed */
          }
        }
      },
    });

    return new Response(stream, {
      headers: {
        "content-type": "application/x-ndjson; charset=utf-8",
        "cache-control": "no-store",
        "x-content-type-options": "nosniff",
      },
    });
  }

  async function handleApprove(req: Request): Promise<Response> {
    if (!pendingApproval) return json(409, { error: "no pending approval" });
    let body: { decision?: unknown; allow?: unknown } = {};
    try {
      body = (await req.json()) as typeof body;
    } catch {
      /* tolerate an empty body → treated as deny */
    }
    const allow = body.decision === "allow" || body.allow === true;
    pendingApproval(allow);
    return json(200, { ok: true, decision: allow ? "allow" : "deny" });
  }

  return (req: Request): Promise<Response> | Response => {
    const denied = reject(req, opts.token, opts.origin);
    if (denied) return denied;

    const url = new URL(req.url);
    if (req.method === "POST" && url.pathname === "/prompt") return handlePrompt(req);
    if (req.method === "POST" && url.pathname === "/approve") return handleApprove(req);
    if (url.pathname === "/") {
      const html =
        opts.indexHtml ??
        "<!doctype html><title>super-agent</title><p>web UI — build the client: <code>cd web && bun run build</code></p>";
      return new Response(html, { headers: { "content-type": "text/html; charset=utf-8" } });
    }
    return json(404, { error: "not found" });
  };
}
