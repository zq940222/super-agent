/**
 * Transcript state (P-tui-3).
 *
 * The state a TUI frontend holds is simply the append-only buffer of rendered
 * terminal lines. `reduce` folds one event in by delegating to `renderEvent`,
 * so there is a SINGLE rendering rule set — no parallel "semantic model" that
 * could drift from what actually reaches the screen. Because `renderEvent` is
 * prefix-stable (only ever appends), a frontend prints `state.slice(prevLen)`
 * after each event to stream output incrementally. See ADR-0001 §4.
 */

import type { AgentEvent } from "../core/events";
import { renderEvent, renderUser, type Source } from "./render";

export type { Source } from "./render";

/** The rendered lines so far. Prefix-stable across `reduce` calls. */
export type Transcript = string[];

export const emptyTranscript = (): Transcript => [];

/** Fold one agent event into the transcript, tagged by the emitting agent. */
export function reduce(state: Transcript, event: AgentEvent, source: Source = "main"): Transcript {
  return [...state, ...renderEvent(event, source)];
}

/** Append the user's prompt (app-level input, not an agent event). */
export function appendUser(state: Transcript, text: string): Transcript {
  return [...state, renderUser(text)];
}
