/**
 * The interactive REPL (P-tui-4).
 *
 * `runRepl` is the read → run → render loop, with its I/O injected (`readLine`,
 * `printer`, `approve`, `beginRun`) so it can be integration-tested against a
 * scripted provider with no terminal and no network. The terminal wiring
 * (readline, raw SIGINT, rollout) lives in main.ts — the thin, untested glue.
 *
 * Multi-turn context is threaded via `nextHistory`: the previous run's messages
 * seed the next turn, but only when the run completed (see conversation.ts).
 */

import { runAgent, type RunResult } from "../core/engine";
import { EventEmitter, type AgentEvent } from "../core/events";
import type { Approver } from "../permissions/gate";
import type { Runtime } from "../runtime/bootstrap";
import type { RolloutRecorder } from "../session/rollout";
import type { Message } from "../core/types";
import { reduce, appendUser, emptyTranscript, type Transcript, type Source } from "./transcript";
import { nextHistory } from "./conversation";

/**
 * Session-level printer. Both the main loop's events and the subagents'
 * (child) events funnel through one prefix-stable buffer, so nested work
 * interleaves in arrival order and each new line is written exactly once.
 */
export interface Printer {
  event(event: AgentEvent, source: Source): void;
  user(text: string): void;
  /**
   * Write a one-off UI line (e.g. a Ctrl-C ack) — commits any open streamed
   * `pending` first, so the line can't glue onto a half-written token. Not part
   * of the transcript buffer.
   */
  notice(line: string): void;
}

/**
 * `write` is a RAW sink (no implicit newline) — the printer owns line breaks, so
 * it can emit sub-line token deltas. Committed transcript lines are written with
 * a trailing newline; streamed deltas are written as-is and accumulate in a
 * volatile `pending` string until a whole-line event flushes them. See ADR-0002 §5.
 */
export function createPrinter(write: (s: string) => void): Printer {
  let buf: Transcript = emptyTranscript();
  let printed = 0;
  let pending = ""; // streamed text written to the screen but not yet committed as a line

  const flush = (): void => {
    for (const line of buf.slice(printed)) write(line + "\n");
    printed = buf.length;
  };
  // Terminate the volatile stream line and commit it as a buffer line. It's
  // already on screen, so bump `printed` past it — flush must not reprint it.
  const commitPending = (): void => {
    if (!pending) return;
    write("\n");
    buf = [...buf, pending];
    printed = buf.length;
    pending = "";
  };

  return {
    event(event, source) {
      if (event.type === "text_delta") {
        write(event.text); // raw, no newline — the live token stream
        pending += event.text;
        return;
      }
      commitPending(); // flush any streamed line BEFORE rendering a whole-line event
      buf = reduce(buf, event, source);
      flush();
    },
    user(text) {
      commitPending();
      buf = appendUser(buf, text);
      flush();
    },
    notice(line) {
      commitPending();
      write(line + "\n");
    },
  };
}

export interface ReplDeps {
  runtime: Runtime;
  /** Approver for the main loop's ask-tier tools. */
  approve: Approver;
  printer: Printer;
  /** Next user line, or null at EOF / to end the session. */
  readLine: () => Promise<string | null>;
  /** Start a run: returns its cancellation signal (Ctrl-C). Omit ⇒ no cancel. */
  beginRun?: () => AbortSignal | undefined;
  /** Called when a run settles (clear the active-run marker). */
  endRun?: () => void;
  rollout?: RolloutRecorder;
  maxContextTokens?: number;
  /** Opt into token streaming (the TUI sets this). See ADR-0002. */
  stream?: boolean;
  /** Directory the file tools are bounded to. Defaults to the cwd. */
  workspaceRoot?: string;
}

/** Slash-commands that end the session. */
const EXIT = new Set(["/exit", "/quit", "/q"]);

export async function runRepl(deps: ReplDeps): Promise<void> {
  let history: Message[] = [];

  for (;;) {
    const line = await deps.readLine();
    if (line === null) break;
    const input = line.trim();
    if (!input) continue;
    if (EXIT.has(input)) break;

    deps.printer.user(input);
    const events = new EventEmitter().on((e) => deps.printer.event(e, "main"));
    const signal = deps.beginRun?.();
    try {
      const result: RunResult = await runAgent(input, {
        provider: deps.runtime.provider,
        registry: deps.runtime.registry,
        system: deps.runtime.system,
        policy: deps.runtime.policy,
        approve: deps.approve,
        workspaceRoot: deps.workspaceRoot ?? process.cwd(),
        maxContextTokens: deps.maxContextTokens,
        rollout: deps.rollout,
        events,
        history,
        signal,
        stream: deps.stream,
      });
      history = nextHistory(history, result);
    } catch (err) {
      // A run that throws (e.g. provider/network error) must not kill the REPL.
      deps.printer.event(
        { type: "error", message: err instanceof Error ? err.message : String(err) },
        "main",
      );
    } finally {
      deps.endRun?.();
    }
  }
}
