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
  /** HITL approver for the main loop (P13-2 wires the browser bridge; default: deny). */
  approve?: Approver;
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

export function createFetchHandler(opts: WebServerOptions): (req: Request) => Promise<Response> | Response {
  const approve: Approver = opts.approve ?? (async () => false);
  let history: Message[] = [];
  let running = false;

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

  return (req: Request): Promise<Response> | Response => {
    const denied = reject(req, opts.token, opts.origin);
    if (denied) return denied;

    const url = new URL(req.url);
    if (req.method === "POST" && url.pathname === "/prompt") return handlePrompt(req);
    if (url.pathname === "/") {
      // P13-4 serves the built React client here; a minimal placeholder for now.
      return new Response("<!doctype html><title>super-agent</title><p>web UI — client pending (P13-3)</p>", {
        headers: { "content-type": "text/html; charset=utf-8" },
      });
    }
    return json(404, { error: "not found" });
  };
}
