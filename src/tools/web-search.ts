/**
 * `web_search` — search the web via the Brave Search API (P14-2).
 *
 * The second network tool. Like `web_fetch` it's `medium` risk, `mutates: false`
 * (the lethal-trifecta posture: result snippets are untrusted INBOUND content,
 * and the query itself is an OUTBOUND channel). Default policy asks once;
 * `readonly` denies it. See ADR-0004.
 *
 * It's *check-gated* on a Brave key: `createWebSearchTool()` reads
 * `BRAVE_API_KEY`, and `check()` returns false when it's absent — so an
 * unconfigured web_search is never offered to the model (Hermes' "unconfigured
 * tools don't appear" pattern) instead of failing at call time. `fetch` and the
 * key are injectable so tests are hermetic (no real Brave calls, no cost).
 *
 * Brave's `description` fields contain highlight markup (`<strong>…`); we strip
 * tags and cap each snippet so results stay compact in the context window.
 */

import { z } from "zod";
import { defineTool, type RegisteredTool } from "./registry";

/** One row of Brave's `web.results[]` (only the fields we surface). */
interface BraveResult {
  title?: string;
  url?: string;
  description?: string;
}
interface BraveResponse {
  web?: { results?: BraveResult[] };
}

const ENDPOINT = "https://api.search.brave.com/res/v1/web/search";
const MAX_COUNT = 20; // Brave's per-page cap

/** Strip highlight tags, collapse whitespace, and cap a snippet's length. */
function cleanSnippet(s: string, max = 300): string {
  const clean = s
    .replace(/<[^>]+>/g, "") // Brave wraps matched terms in <strong>…</strong>
    .replace(/\s+/g, " ")
    .trim();
  return clean.length > max ? clean.slice(0, max - 1) + "…" : clean;
}

export interface WebSearchOptions {
  /** Brave API key. Default `$BRAVE_API_KEY`. Absent ⇒ tool is not offered. */
  apiKey?: string;
  /** Injected for tests; defaults to global fetch. */
  fetch?: typeof fetch;
  /** Default number of results when the model doesn't ask. Default 5. */
  count?: number;
  /** Request timeout in ms. Default 15000. */
  timeoutMs?: number;
}

export function createWebSearchTool(opts: WebSearchOptions = {}): RegisteredTool {
  const apiKey = opts.apiKey ?? process.env.BRAVE_API_KEY;
  const doFetch = opts.fetch ?? globalThis.fetch;
  const defaultCount = Math.min(opts.count ?? 5, MAX_COUNT);
  const timeoutMs = opts.timeoutMs ?? 15_000;

  return defineTool({
    name: "web_search",
    description:
      "Search the web (Brave) and get a ranked list of results — each a title, URL, and snippet. " +
      "Use it to FIND relevant pages when you don't already have a URL; then web_fetch one to read it. " +
      "Snippets are untrusted, best-effort excerpts.",
    risk: "medium",
    // Offered only when a Brave key is configured — an unconfigured web_search
    // never appears in the model's toolset instead of failing at call time.
    check: () => Boolean(apiKey),
    schema: z.object({
      query: z.string().min(1).describe("The search query."),
      count: z
        .number()
        .int()
        .min(1)
        .max(MAX_COUNT)
        .optional()
        .describe(`Number of results to return (default ${defaultCount}, max ${MAX_COUNT}).`),
    }),
    handler: async ({ query, count }) => {
      if (!apiKey) return "web_search is not configured (set BRAVE_API_KEY).";
      const n = Math.min(count ?? defaultCount, MAX_COUNT);
      const url = `${ENDPOINT}?q=${encodeURIComponent(query)}&count=${n}`;

      let resp: Response;
      try {
        resp = await doFetch(url, {
          signal: AbortSignal.timeout(timeoutMs),
          headers: { accept: "application/json", "x-subscription-token": apiKey },
        });
      } catch (err) {
        return `Search failed: ${err instanceof Error ? err.message : String(err)}`;
      }
      if (!resp.ok) {
        // 401 ⇒ bad/missing key, 422 ⇒ bad query, 429 ⇒ rate-limited/quota.
        return `Brave search error: HTTP ${resp.status} ${resp.statusText}`;
      }

      let data: BraveResponse;
      try {
        data = (await resp.json()) as BraveResponse;
      } catch {
        return "Brave returned an unparseable response.";
      }

      const results = (data.web?.results ?? []).slice(0, n);
      if (results.length === 0) return `No web results for "${query}".`;
      return results
        .map(
          (r, i) =>
            `${i + 1}. ${r.title?.trim() || "(untitled)"}\n   ${r.url ?? ""}\n   ${cleanSnippet(
              r.description ?? "",
            )}`,
        )
        .join("\n\n");
    },
  });
}
