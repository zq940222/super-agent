/**
 * Conversation threading across turns (P-tui-4).
 *
 * A multi-turn frontend feeds the previous run's messages back as the next
 * turn's `history`. But history may only advance when a run produced a complete
 * answer (`end_turn`). Every other exit — `cancelled` (before the first turn or
 * mid-tool) and `max_steps` — leaves a trailing *user-role* message (an
 * interrupted `tool_results` block, or the unanswered prompt). Appending the
 * next user input after that would place two user-role messages back-to-back,
 * which providers (Anthropic in particular) reject.
 *
 * So an interrupted or incomplete turn does NOT advance the conversation
 * context; it survives only in the rollout (which records deltas as they
 * happen, so `rollout ⊇ history` after a reverted turn — a resume feature would
 * need to tolerate a trailing tool_results). See ADR-0001 §2/§3.
 */

import type { RunResult } from "../core/engine";
import type { Message } from "../core/types";

export function nextHistory(before: Message[], result: RunResult): Message[] {
  return result.stoppedBy === "end_turn" ? result.messages : before;
}
