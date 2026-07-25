import type { AgentEvent } from "./events";

/**
 * The session token: taken from `?token=` on first load (the server embeds it in
 * the URL it prints), then remembered for the tab. Every request carries it.
 */
export function getToken(): string {
  const fromUrl = new URLSearchParams(location.search).get("token");
  if (fromUrl) sessionStorage.setItem("sa-token", fromUrl);
  return sessionStorage.getItem("sa-token") ?? "";
}

function authHeaders(): Record<string, string> {
  return { "content-type": "application/json", authorization: `Bearer ${getToken()}` };
}

/**
 * POST /prompt and yield the run's events as they stream in (transport "B":
 * the response body IS the event stream, NDJSON). Aborting `signal` (Stop /
 * unmount) closes the request, which the server sees as a cancel.
 */
export async function* runPrompt(prompt: string, signal: AbortSignal): AsyncGenerator<AgentEvent> {
  const resp = await fetch("/prompt", {
    method: "POST",
    headers: authHeaders(),
    body: JSON.stringify({ prompt }),
    signal,
  });
  if (resp.status === 409) throw new Error("a run is already in progress");
  if (!resp.ok || !resp.body) throw new Error(`prompt failed: ${resp.status}`);

  const reader = resp.body.getReader();
  const decoder = new TextDecoder();
  let buf = "";
  for (;;) {
    const { value, done } = await reader.read();
    if (done) break;
    buf += decoder.decode(value, { stream: true });
    let nl: number;
    while ((nl = buf.indexOf("\n")) >= 0) {
      const line = buf.slice(0, nl);
      buf = buf.slice(nl + 1);
      if (line.trim()) yield JSON.parse(line) as AgentEvent;
    }
  }
  if (buf.trim()) yield JSON.parse(buf) as AgentEvent;
}

export async function sendApproval(decision: "allow" | "deny" | "always"): Promise<void> {
  await fetch("/approve", { method: "POST", headers: authHeaders(), body: JSON.stringify({ decision }) });
}
