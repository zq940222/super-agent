import { test, expect } from "bun:test";
import { createWebFetchTool, htmlToText, isBlockedHost } from "../src/tools/web-fetch";
import type { ToolContext } from "../src/tools/registry";

const ctx: ToolContext = { cwd: "/tmp" };

/** A fetch stub returning a canned Response; records the URL it was called with. */
function stubFetch(body: string, init: ResponseInit = {}): { fetch: typeof globalThis.fetch; calls: string[] } {
  const calls: string[] = [];
  const fn = (async (url: string | URL) => {
    calls.push(String(url));
    return new Response(body, { status: 200, headers: { "content-type": "text/html" }, ...init });
  }) as unknown as typeof globalThis.fetch;
  return { fetch: fn, calls };
}

/** Returns a canned sequence of Responses (one per call) — for redirect chains. */
function stubSequence(responses: Response[]): { fetch: typeof globalThis.fetch; calls: string[] } {
  const calls: string[] = [];
  let i = 0;
  const fn = (async (url: string | URL) => {
    calls.push(String(url));
    return responses[i++] ?? new Response("", { status: 500 });
  }) as unknown as typeof globalThis.fetch;
  return { fetch: fn, calls };
}

const run = (tool: ReturnType<typeof createWebFetchTool>, url: string): Promise<string> =>
  Promise.resolve(tool.handler({ url }, ctx)).then(String);

// --- metadata ---

test("web_fetch is medium-risk and non-mutating (default asks; readonly denies)", () => {
  const t = createWebFetchTool();
  expect(t.risk).toBe("medium");
  expect(t.mutates).toBe(false);
});

// --- HTML → text ---

test("htmlToText strips script/style/tags and decodes entities", () => {
  const html =
    "<html><head><style>x{}</style></head><body><script>evil()</script>" +
    "<h1>Title</h1><p>Fish &amp; chips &lt;yum&gt;</p></body></html>";
  const text = htmlToText(html);
  expect(text).not.toContain("evil()"); // script content dropped
  expect(text).not.toContain("x{}"); // style content dropped
  expect(text).not.toContain("<h1>"); // tags stripped
  expect(text).not.toContain("<p>");
  expect(text).toContain("Title");
  expect(text).toContain("Fish & chips <yum>"); // entities decoded (incl. &lt;/&gt;)
});

test("web_fetch returns the page's readable text", async () => {
  const { fetch } = stubFetch("<p>Hello <b>world</b></p>");
  const out = await run(createWebFetchTool({ fetch }), "https://example.com/");
  expect(out).toContain("Hello world");
});

// --- truncation (output-size discipline) ---

test("web_fetch truncates long output with a visible marker", async () => {
  const { fetch } = stubFetch("<p>" + "A".repeat(500) + "</p>");
  const out = await run(createWebFetchTool({ fetch, maxChars: 100 }), "https://example.com/");
  expect(out).toContain("…[truncated");
  expect(out).toMatch(/truncated \d+ of \d+ chars/);
});

// --- errors ---

test("web_fetch reports a non-200 status", async () => {
  const fetch = (async () =>
    new Response("nope", { status: 404, statusText: "Not Found" })) as unknown as typeof globalThis.fetch;
  const out = await run(createWebFetchTool({ fetch }), "https://example.com/missing");
  expect(out).toContain("HTTP 404");
});

test("web_fetch rejects an invalid URL", async () => {
  const out = await run(createWebFetchTool(), "not a url");
  expect(out).toContain("Invalid URL");
});

// --- SSRF guard ---

test("web_fetch refuses non-http(s) schemes", async () => {
  const { fetch, calls } = stubFetch("secret");
  const out = await run(createWebFetchTool({ fetch }), "file:///etc/passwd");
  expect(out).toContain("only http/https");
  expect(calls.length).toBe(0); // never fetched
});

test("web_fetch refuses loopback / link-local / private hosts", async () => {
  const { fetch, calls } = stubFetch("secret");
  const tool = createWebFetchTool({ fetch });
  for (const host of ["http://localhost:8787/", "http://127.0.0.1/", "http://169.254.169.254/latest/meta-data/", "http://10.0.0.5/", "http://192.168.1.1/"]) {
    expect(await run(tool, host)).toContain("SSRF guard");
  }
  expect(calls.length).toBe(0); // none fetched
});

test("isBlockedHost: blocks loopback/link-local/private, allows public", () => {
  for (const h of ["localhost", "127.0.0.1", "0.0.0.0", "169.254.169.254", "10.1.2.3", "172.16.0.1", "192.168.0.1", "::1"]) {
    expect(isBlockedHost(h)).toBe(true);
  }
  // Public hosts allowed — incl. `fcc.gov`/`fdic.gov`, which must NOT trip the IPv6 ULA rule.
  for (const h of ["example.com", "8.8.8.8", "172.15.0.1", "172.32.0.1", "1.1.1.1", "fcc.gov", "fdic.gov"]) {
    expect(isBlockedHost(h)).toBe(false);
  }
});

// --- redirects re-validated through the SSRF guard ---

test("web_fetch refuses a redirect to a blocked host (no SSRF via 302)", async () => {
  const { fetch, calls } = stubSequence([
    new Response("", { status: 302, headers: { location: "http://169.254.169.254/latest/meta-data/" } }),
  ]);
  const out = await run(createWebFetchTool({ fetch }), "https://example.com/redir");
  expect(out).toContain("Refused redirect");
  expect(calls).toEqual(["https://example.com/redir"]); // the metadata endpoint was NEVER fetched
});

test("web_fetch follows a redirect to an allowed host", async () => {
  const { fetch, calls } = stubSequence([
    new Response("", { status: 302, headers: { location: "https://example.org/final" } }),
    new Response("<p>Final page</p>", { status: 200, headers: { "content-type": "text/html" } }),
  ]);
  const out = await run(createWebFetchTool({ fetch }), "https://example.com/start");
  expect(out).toContain("Final page");
  expect(calls).toEqual(["https://example.com/start", "https://example.org/final"]);
});

test("web_fetch refuses obvious binary content types", async () => {
  const fetch = (async () =>
    new Response("%PDF-1.4 …", { status: 200, headers: { "content-type": "application/pdf" } })) as unknown as typeof globalThis.fetch;
  const out = await run(createWebFetchTool({ fetch }), "https://example.com/doc.pdf");
  expect(out).toContain("unsupported content-type");
});
