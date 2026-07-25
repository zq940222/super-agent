import { test, expect } from "bun:test";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { authorize, createFetchHandler } from "../src/web/server";
import { bootstrap } from "../src/runtime/bootstrap";
import type { AgentEvent } from "../src/core/events";
import type { AssistantTurn } from "../src/core/types";
import { userText } from "../src/core/types";
import type { GenerateRequest, ModelProvider, StreamChunk } from "../src/providers/provider";

const usage = { inputTokens: 0, outputTokens: 0 };
const endTurn = (text: string): AssistantTurn => ({
  message: { role: "assistant", content: [{ type: "text", text }] },
  stopReason: "end_turn",
  usage,
});

class ScriptedProvider implements ModelProvider {
  readonly name = "scripted";
  calls: GenerateRequest[] = [];
  private i = 0;
  constructor(private turns: AssistantTurn[]) {}
  async generate(req: GenerateRequest): Promise<AssistantTurn> {
    this.calls.push({ ...req, messages: structuredClone(req.messages) }); // keep signal by ref
    return this.turns[this.i++] ?? endTurn("(extra)");
  }
}

/** Never resolves until the run is aborted; records that it saw the abort. */
class HangingProvider implements ModelProvider {
  readonly name = "hang";
  aborted = false;
  generate(req: GenerateRequest): Promise<AssistantTurn> {
    return new Promise((_resolve, reject) => {
      const fail = (): void => {
        this.aborted = true;
        reject(new DOMException("Aborted", "AbortError"));
      };
      if (req.signal?.aborted) return fail();
      req.signal?.addEventListener("abort", fail, { once: true });
    });
  }
}

const TOKEN = "secret-token";

async function withServer<T>(
  provider: ModelProvider,
  fn: (ctx: { base: string; headers: Record<string, string> }) => Promise<T>,
): Promise<T> {
  const dir = await mkdtemp(join(tmpdir(), "sa-web-"));
  const runtime = await bootstrap({ provider, loadMcp: false, skillsDir: join(dir, "skills") });
  const handler = createFetchHandler({ runtime, token: TOKEN, origin: "http://localhost" });
  const server = Bun.serve({ port: 0, fetch: handler });
  try {
    return await fn({
      base: `http://localhost:${server.port}`,
      headers: { authorization: `Bearer ${TOKEN}`, "content-type": "application/json" },
    });
  } finally {
    server.stop(true);
    await runtime.close();
    await rm(dir, { recursive: true, force: true });
  }
}

async function readNdjson(resp: Response): Promise<AgentEvent[]> {
  const events: AgentEvent[] = [];
  const reader = resp.body!.getReader();
  const dec = new TextDecoder();
  let buf = "";
  for (;;) {
    const { value, done } = await reader.read();
    if (done) break;
    buf += dec.decode(value, { stream: true });
    let nl: number;
    while ((nl = buf.indexOf("\n")) >= 0) {
      const line = buf.slice(0, nl);
      buf = buf.slice(nl + 1);
      if (line.trim()) events.push(JSON.parse(line));
    }
  }
  if (buf.trim()) events.push(JSON.parse(buf));
  return events;
}

// --- authorize (pure) ---

test("authorize enforces token, then origin, then host", () => {
  const base = { token: "t", origin: "http://localhost:8787", host: "localhost:8787", reqOrigin: null };
  expect(authorize({ ...base, provided: "t" })).toEqual({ ok: true });
  expect(authorize({ ...base, provided: "wrong" })).toMatchObject({ ok: false, status: 401 });
  expect(authorize({ ...base, provided: "t", reqOrigin: "http://evil.test" })).toMatchObject({ ok: false, status: 403 });
  expect(authorize({ ...base, provided: "t", reqOrigin: "http://localhost:8787" })).toEqual({ ok: true }); // same-origin ok
  expect(authorize({ ...base, provided: "t", host: "evil.test" })).toMatchObject({ ok: false, status: 403 });
  expect(authorize({ ...base, provided: "t", host: "127.0.0.1:9999" })).toEqual({ ok: true });
});

// --- HTTP ---

test("POST /prompt streams the run's events as NDJSON", async () => {
  await withServer(new ScriptedProvider([endTurn("hello from the agent")]), async ({ base, headers }) => {
    const resp = await fetch(`${base}/prompt`, { method: "POST", headers, body: JSON.stringify({ prompt: "hi" }) });
    expect(resp.status).toBe(200);
    expect(resp.headers.get("content-type")).toContain("application/x-ndjson");
    const events = await readNdjson(resp);
    const done = events.find((e) => e.type === "done");
    expect(done).toMatchObject({ type: "done", text: "hello from the agent" });
  });
});

test("a request without the token is rejected 401", async () => {
  await withServer(new ScriptedProvider([endTurn("x")]), async ({ base }) => {
    const resp = await fetch(`${base}/prompt`, {
      method: "POST",
      headers: { "content-type": "application/json" }, // no authorization
      body: JSON.stringify({ prompt: "hi" }),
    });
    expect(resp.status).toBe(401);
  });
});

test("consecutive prompts thread conversation history", async () => {
  const provider = new ScriptedProvider([endTurn("A1"), endTurn("A2")]);
  await withServer(provider, async ({ base, headers }) => {
    await readNdjson(await fetch(`${base}/prompt`, { method: "POST", headers, body: JSON.stringify({ prompt: "q1" }) }));
    await readNdjson(await fetch(`${base}/prompt`, { method: "POST", headers, body: JSON.stringify({ prompt: "q2" }) }));

    expect(provider.calls.length).toBe(2);
    expect(provider.calls[0]!.messages).toEqual([userText("q1")]);
    expect(provider.calls[1]!.messages).toEqual([userText("q1"), endTurn("A1").message, userText("q2")]);
  });
});

test("a client disconnect cancels the run (request.signal reaches the provider)", async () => {
  const provider = new HangingProvider();
  await withServer(provider, async ({ base, headers }) => {
    const ac = new AbortController();
    const resp = await fetch(`${base}/prompt`, {
      method: "POST",
      headers,
      body: JSON.stringify({ prompt: "go" }),
      signal: ac.signal,
    });
    const reader = resp.body!.getReader();
    await reader.read(); // turn_start — the run has started and the provider is hanging
    ac.abort(); // disconnect

    // Give the server a moment to observe request.signal.
    for (let i = 0; i < 50 && !provider.aborted; i++) await new Promise((r) => setTimeout(r, 10));
    expect(provider.aborted).toBe(true);
  });
});

test("text_delta events stream through /prompt's NDJSON body", async () => {
  const turn = endTurn("hello");
  const provider: ModelProvider = {
    name: "streaming",
    async generate() {
      return turn;
    },
    async *stream(): AsyncIterable<StreamChunk> {
      yield { type: "text_delta", text: "hel" };
      yield { type: "text_delta", text: "lo" };
      yield { type: "done", turn };
    },
  };
  await withServer(provider, async ({ base, headers }) => {
    const events = await readNdjson(
      await fetch(`${base}/prompt`, { method: "POST", headers, body: JSON.stringify({ prompt: "hi" }) }),
    );
    const deltas = events
      .filter((e): e is Extract<AgentEvent, { type: "text_delta" }> => e.type === "text_delta")
      .map((e) => e.text);
    expect(deltas).toEqual(["hel", "lo"]);
    expect(events.find((e) => e.type === "done")).toMatchObject({ type: "done", text: "hello" });
  });
});

test("a provider error surfaces as an error event and does not wedge the server", async () => {
  let calls = 0;
  const provider: ModelProvider = {
    name: "boom",
    async generate() {
      calls += 1;
      throw new Error("model exploded");
    },
  };
  await withServer(provider, async ({ base, headers }) => {
    const events = await readNdjson(
      await fetch(`${base}/prompt`, { method: "POST", headers, body: JSON.stringify({ prompt: "go" }) }),
    );
    expect(events.some((e) => e.type === "error" && e.message.includes("model exploded"))).toBe(true);

    // `running` must have reset in finally — the next prompt is served (200), not 409'd forever.
    const second = await fetch(`${base}/prompt`, { method: "POST", headers, body: JSON.stringify({ prompt: "again" }) });
    expect(second.status).toBe(200);
    await readNdjson(second); // drain
    expect(calls).toBe(2);
  });
});

test("a second prompt while one is running is rejected 409", async () => {
  const provider = new HangingProvider();
  await withServer(provider, async ({ base, headers }) => {
    const ac = new AbortController();
    const first = fetch(`${base}/prompt`, {
      method: "POST",
      headers,
      body: JSON.stringify({ prompt: "one" }),
      signal: ac.signal,
    });
    await first; // response headers back ⇒ the run is marked running

    const second = await fetch(`${base}/prompt`, { method: "POST", headers, body: JSON.stringify({ prompt: "two" }) });
    expect(second.status).toBe(409);

    ac.abort(); // release the hanging first run
  });
});
