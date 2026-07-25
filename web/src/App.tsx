import { useEffect, useRef, useState } from "react";
import { runPrompt, sendApproval } from "./api";
import { applyEvent, type Item } from "./transcript";

interface Pending {
  name: string;
  input: unknown;
  risk: string;
}

export function App(): JSX.Element {
  const [items, setItems] = useState<Item[]>([]);
  const [input, setInput] = useState("");
  const [running, setRunning] = useState(false);
  const [pending, setPending] = useState<Pending | null>(null);
  const abortRef = useRef<AbortController | null>(null);
  const logRef = useRef<HTMLDivElement | null>(null);
  const dialogRef = useRef<HTMLDialogElement | null>(null);

  // Keep the log scrolled to the newest content.
  useEffect(() => {
    logRef.current?.scrollTo({ top: logRef.current.scrollHeight });
  }, [items, pending]);

  // Open/close the native approval modal as `pending` changes.
  useEffect(() => {
    const d = dialogRef.current;
    if (!d) return;
    if (pending && !d.open) d.showModal();
    if (!pending && d.open) d.close();
  }, [pending]);

  async function send(): Promise<void> {
    const prompt = input.trim();
    if (!prompt || running) return;
    setInput("");
    setItems((prev) => [...prev, { kind: "user", text: prompt }]);
    setRunning(true);
    const ac = new AbortController();
    abortRef.current = ac;
    try {
      for await (const ev of runPrompt(prompt, ac.signal)) {
        setItems((prev) => applyEvent(prev, ev));
        if (ev.type === "permission_request") setPending({ name: ev.name, input: ev.input, risk: ev.risk });
        if (ev.type === "permission_decision") setPending(null);
      }
    } catch (err) {
      if (!ac.signal.aborted) {
        setItems((prev) => [...prev, { kind: "notice", text: `error: ${err instanceof Error ? err.message : String(err)}` }]);
      }
    } finally {
      setRunning(false);
      setPending(null);
      abortRef.current = null;
    }
  }

  async function decide(decision: "allow" | "deny" | "always"): Promise<void> {
    setPending(null);
    await sendApproval(decision);
  }

  function stop(): void {
    abortRef.current?.abort(); // closes the fetch → server cancels the run
  }

  return (
    <div className="app">
      <header>
        <span className="dot" data-on={running} /> super-agent
      </header>

      <div className="log" ref={logRef}>
        {items.map((it, i) => (
          <ItemView key={i} item={it} />
        ))}
        {items.length === 0 && <div className="empty">Ask the agent something…</div>}
      </div>

      <form
        className="composer"
        onSubmit={(e) => {
          e.preventDefault();
          void send();
        }}
      >
        <textarea
          value={input}
          onChange={(e) => setInput(e.target.value)}
          onKeyDown={(e) => {
            if (e.key === "Enter" && !e.shiftKey) {
              e.preventDefault();
              void send();
            }
          }}
          placeholder="Type a task, Enter to send…"
          rows={2}
        />
        {running ? (
          <button type="button" className="stop" onClick={stop}>
            Stop
          </button>
        ) : (
          <button type="submit" disabled={!input.trim()}>
            Send
          </button>
        )}
      </form>

      <dialog ref={dialogRef} className="approve" onCancel={(e) => e.preventDefault()}>
        {pending && (
          <>
            <h3>🔐 Allow this tool?</h3>
            <p className="tool">
              <code>{pending.name}</code>
            </p>
            <pre className="input">{JSON.stringify(pending.input, null, 2)}</pre>
            <div className="row">
              <button className="deny" onClick={() => void decide("deny")}>
                Deny
              </button>
              <button className="allow" onClick={() => void decide("allow")}>
                Allow once
              </button>
              {/* High-risk tools can't be always-allowed (ADR-0005 §3) — don't offer it. */}
              {pending.risk !== "high" && (
                <button className="always" onClick={() => void decide("always")}>
                  Always allow
                </button>
              )}
            </div>
          </>
        )}
      </dialog>
    </div>
  );
}

function ItemView({ item }: { item: Item }): JSX.Element {
  switch (item.kind) {
    case "user":
      return <div className="item user">{item.text}</div>;
    case "assistant":
      return <div className="item assistant">{item.text}</div>;
    case "notice":
      return <div className="item notice">{item.text}</div>;
    case "tool":
      return (
        <div className={`item tool ${item.status}`}>
          <span className="glyph">{item.status === "error" ? "✗" : item.status === "ok" ? "↳" : "🔧"}</span>
          <code>{item.name}</code>
          <span className="args">({preview(JSON.stringify(item.input))})</span>
          {item.result && <div className="result">{preview(item.result, 200)}</div>}
        </div>
      );
  }
}

function preview(text: string, n = 80): string {
  const first = text.split("\n")[0] ?? "";
  return first.length > n ? first.slice(0, n) + "…" : first;
}
