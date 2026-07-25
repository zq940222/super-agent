/**
 * `web_fetch` — fetch a web page and return its readable text (P14-1).
 *
 * The first *network* tool. It's `medium` risk (not low), because a fetch is
 * both legs of the lethal trifecta: the INBOUND leg (fetched content is
 * untrusted — prompt injection) and the OUTBOUND leg (an attacker-chosen URL is
 * an exfil channel). So the default policy asks once and `readonly` denies it.
 *
 * An SSRF guard refuses non-http(s) schemes and loopback/link-local/private
 * hosts at the boundary (this repo runs an authenticated agent on
 * 127.0.0.1:8787). HTML→text is hand-rolled best-effort. Output is capped with a
 * visible truncation marker. See ADR-0004.
 */

import { z } from "zod";
import { defineTool, type RegisteredTool } from "./registry";

/** Block loopback / link-local / private / metadata hosts by literal (no DNS). */
export function isBlockedHost(hostname: string): boolean {
  const h = hostname.toLowerCase().replace(/^\[|\]$/g, ""); // strip IPv6 brackets
  if (h === "localhost" || h.endsWith(".localhost")) return true;
  // IPv6 literals only (contain ":") — otherwise `fcc.gov` / `fdic.gov` would match.
  if (h.includes(":")) {
    if (h === "::1" || h.startsWith("fe80:") || h.startsWith("fc") || h.startsWith("fd")) return true; // loopback/link-local/ULA
  }
  const m = h.match(/^(\d{1,3})\.(\d{1,3})\.(\d{1,3})\.(\d{1,3})$/);
  if (m) {
    const a = Number(m[1]);
    const b = Number(m[2]);
    if (a === 0 || a === 127) return true; // 0.0.0.0, loopback
    if (a === 169 && b === 254) return true; // link-local + cloud metadata 169.254.169.254
    if (a === 10) return true; // private
    if (a === 172 && b >= 16 && b <= 31) return true; // private
    if (a === 192 && b === 168) return true; // private
  }
  return false;
}

/** Best-effort HTML → text: drop script/style, strip tags, decode common entities. */
export function htmlToText(html: string): string {
  return html
    .replace(/<(script|style|noscript|template|svg)[\s\S]*?<\/\1>/gi, " ")
    .replace(/<!--[\s\S]*?-->/g, " ")
    .replace(/<\/(p|div|li|tr|h[1-6]|section|article|br)\s*>/gi, "\n")
    .replace(/<[^>]+>/g, " ")
    .replace(/&nbsp;/gi, " ")
    .replace(/&amp;/gi, "&")
    .replace(/&lt;/gi, "<")
    .replace(/&gt;/gi, ">")
    .replace(/&quot;/gi, '"')
    .replace(/&#0*39;|&apos;/gi, "'")
    .replace(/&#0*32;/g, " ")
    .replace(/[ \t\f\r]+/g, " ")
    .replace(/[ \t]*\n[ \t]*/g, "\n")
    .replace(/\n{3,}/g, "\n\n")
    .trim();
}

function truncate(text: string, max: number): string {
  if (text.length <= max) return text;
  return text.slice(0, max) + `\n…[truncated ${text.length - max} of ${text.length} chars]`;
}

/** Scheme + host guard (SSRF). Returns the parsed URL, or a refusal message. */
export function checkUrl(raw: string): { url: URL } | { error: string } {
  let parsed: URL;
  try {
    parsed = new URL(raw);
  } catch {
    return { error: `Invalid URL: ${raw}` };
  }
  if (parsed.protocol !== "http:" && parsed.protocol !== "https:") {
    return { error: `Refused: only http/https URLs are allowed (got "${parsed.protocol}").` };
  }
  if (isBlockedHost(parsed.hostname)) {
    return { error: `Refused: "${parsed.hostname}" is a loopback/link-local/private address (SSRF guard).` };
  }
  return { url: parsed };
}

/** Obvious binary content types we shouldn't dump into the context as text. */
function isBinaryType(contentType: string): boolean {
  return /^(image|audio|video)\/|application\/(pdf|octet-stream|zip|gzip|x-|wasm)/i.test(contentType);
}

export interface WebFetchOptions {
  /** Injected for tests; defaults to global fetch. */
  fetch?: typeof fetch;
  /** Max characters returned before truncation. Default 20000. */
  maxChars?: number;
  /** Request timeout in ms. Default 15000. */
  timeoutMs?: number;
}

export function createWebFetchTool(opts: WebFetchOptions = {}): RegisteredTool {
  const doFetch = opts.fetch ?? globalThis.fetch;
  const maxChars = opts.maxChars ?? 20_000;
  const timeoutMs = opts.timeoutMs ?? 15_000;

  return defineTool({
    name: "web_fetch",
    description:
      "Fetch an http(s) web page and return its readable text (best-effort HTML→text, so " +
      "treat it as approximate — missing text isn't proof the page lacks it). Use it to look " +
      "up documentation, articles, or any URL. Long pages are truncated with a marker.",
    risk: "medium",
    schema: z.object({ url: z.string().min(1).describe("The http(s) URL to fetch.") }),
    handler: async ({ url }) => {
      const first = checkUrl(url);
      if ("error" in first) return first.error;

      // Follow redirects MANUALLY so the SSRF guard re-checks every hop — else a
      // 302 to 169.254.169.254 would slip past the initial check. Cap the hops.
      let current = first.url;
      let resp: Response;
      for (let hop = 0; ; hop++) {
        if (hop > 5) return `Too many redirects (>5) for ${url}`;
        try {
          resp = await doFetch(current.href, {
            redirect: "manual",
            signal: AbortSignal.timeout(timeoutMs),
            headers: { "user-agent": "super-agent/0.1 (+web_fetch)", accept: "text/html,text/plain,*/*" },
          });
        } catch (err) {
          return `Fetch failed: ${err instanceof Error ? err.message : String(err)}`;
        }
        const location = resp.status >= 300 && resp.status < 400 ? resp.headers.get("location") : null;
        if (!location) break;
        const next = checkUrl(new URL(location, current).href);
        if ("error" in next) return `Refused redirect to a blocked target — ${next.error}`;
        current = next.url;
      }
      if (!resp.ok) return `HTTP ${resp.status} ${resp.statusText} for ${url}`;

      const contentType = resp.headers.get("content-type") ?? "";
      if (isBinaryType(contentType)) return `(unsupported content-type "${contentType}" — web_fetch returns text only)`;
      const raw = await resp.text();
      const text = contentType.includes("html") ? htmlToText(raw) : raw.trim();
      return truncate(text || "(empty response)", maxChars);
    },
  });
}
