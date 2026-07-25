import { test, expect } from "bun:test";
import { createWebSearchTool } from "../src/tools/web-search";
import type { ToolContext } from "../src/tools/registry";

const ctx: ToolContext = { cwd: "/tmp" };
const KEY = "test-brave-key";

/** A fetch stub returning a canned Brave JSON body; records URL + headers. */
function braveStub(
  results: Array<{ title?: string; url?: string; description?: string }>,
  init: ResponseInit = { status: 200 },
): { fetch: typeof globalThis.fetch; calls: Array<{ url: string; headers: Headers }> } {
  const calls: Array<{ url: string; headers: Headers }> = [];
  const fn = (async (url: string | URL, opts?: RequestInit) => {
    calls.push({ url: String(url), headers: new Headers(opts?.headers) });
    return new Response(JSON.stringify({ web: { results } }), {
      headers: { "content-type": "application/json" },
      ...init,
    });
  }) as unknown as typeof globalThis.fetch;
  return { fetch: fn, calls };
}

const run = (tool: ReturnType<typeof createWebSearchTool>, query: string, count?: number): Promise<string> =>
  Promise.resolve(tool.handler({ query, count }, ctx)).then(String);

// --- metadata & gating ---

test("web_search is medium-risk and non-mutating (default asks; readonly denies)", () => {
  const t = createWebSearchTool({ apiKey: KEY });
  expect(t.risk).toBe("medium");
  expect(t.mutates).toBe(false);
});

test("check() gates on the Brave key: hidden without, offered with", () => {
  expect(createWebSearchTool({ apiKey: undefined }).check?.()).toBe(false);
  expect(createWebSearchTool({ apiKey: KEY }).check?.()).toBe(true);
});

test("handler refuses to run when unconfigured (belt-and-braces with check)", async () => {
  const out = await run(createWebSearchTool({ apiKey: undefined }), "anything");
  expect(out).toContain("not configured");
});

// --- happy path ---

test("web_search formats ranked results (title, url, snippet)", async () => {
  const { fetch } = braveStub([
    { title: "Bun", url: "https://bun.sh", description: "The <strong>fast</strong> JS runtime" },
    { title: "Zod", url: "https://zod.dev", description: "TypeScript-first schema validation" },
  ]);
  const out = await run(createWebSearchTool({ apiKey: KEY, fetch }), "js runtimes");
  expect(out).toContain("1. Bun");
  expect(out).toContain("https://bun.sh");
  expect(out).toContain("The fast JS runtime"); // <strong> highlight tags stripped
  expect(out).not.toContain("<strong>");
  expect(out).toContain("2. Zod");
  expect(out).toContain("https://zod.dev");
});

test("sends the query + count and the X-Subscription-Token header", async () => {
  const { fetch, calls } = braveStub([{ title: "x", url: "https://x", description: "y" }]);
  await run(createWebSearchTool({ apiKey: KEY, fetch }), "hello world", 3);
  expect(calls).toHaveLength(1);
  expect(calls[0]!.url).toContain("q=hello%20world");
  expect(calls[0]!.url).toContain("count=3");
  expect(calls[0]!.headers.get("x-subscription-token")).toBe(KEY);
  expect(calls[0]!.headers.get("accept")).toBe("application/json");
});

test("clamps count to Brave's max of 20 (defence-in-depth; schema .max also rejects)", async () => {
  // In the real engine `count: 99` fails the schema's `.max(20)` before the handler
  // runs; this calls the handler directly (house style) to prove the clamp regardless.
  const { fetch, calls } = braveStub([]);
  await run(createWebSearchTool({ apiKey: KEY, fetch }), "q", 99);
  expect(calls[0]!.url).toContain("count=20");
});

test("uses the configured default count when the model omits it", async () => {
  const { fetch, calls } = braveStub([]);
  await run(createWebSearchTool({ apiKey: KEY, fetch, count: 8 }), "q");
  expect(calls[0]!.url).toContain("count=8");
});

// --- edge cases ---

test("reports an empty result set", async () => {
  const { fetch } = braveStub([]);
  const out = await run(createWebSearchTool({ apiKey: KEY, fetch }), "asdfqwer no hits");
  expect(out).toContain("No web results");
});

test("reports a non-200 status (bad key / rate limit)", async () => {
  const { fetch } = braveStub([], { status: 401, statusText: "Unauthorized" });
  const out = await run(createWebSearchTool({ apiKey: KEY, fetch }), "q");
  expect(out).toContain("HTTP 401");
});

test("reports an unparseable body", async () => {
  const fetch = (async () =>
    new Response("<html>not json</html>", {
      status: 200,
      headers: { "content-type": "application/json" },
    })) as unknown as typeof globalThis.fetch;
  const out = await run(createWebSearchTool({ apiKey: KEY, fetch }), "q");
  expect(out).toContain("unparseable");
});

test("surfaces a network failure instead of throwing", async () => {
  const fetch = (async () => {
    throw new Error("ECONNREFUSED");
  }) as unknown as typeof globalThis.fetch;
  const out = await run(createWebSearchTool({ apiKey: KEY, fetch }), "q");
  expect(out).toContain("Search failed");
  expect(out).toContain("ECONNREFUSED");
});

test("caps a long snippet with an ellipsis", async () => {
  const { fetch } = braveStub([
    { title: "Long", url: "https://long", description: "A".repeat(500) },
  ]);
  const out = await run(createWebSearchTool({ apiKey: KEY, fetch }), "q");
  expect(out).toContain("…");
  // The 500-char snippet must not survive whole (300-char cap).
  expect(out).not.toContain("A".repeat(400));
});
