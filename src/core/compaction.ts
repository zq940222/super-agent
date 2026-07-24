/**
 * Context compaction — the context-rot fighter (P4).
 *
 * When the running history grows past a budget, summarize the older portion
 * into a single message and keep the most recent turns verbatim. The hard part
 * (per the research) is *where to cut*: we must never split an assistant
 * `tool_use` from its `tool_result`, or the next request breaks provider
 * pairing rules. So the kept tail is extended backward to a safe boundary.
 *
 * The summarizer is injectable so the engine can be tested without a real model
 * call; the default calls the provider with a compression prompt.
 *
 * See docs/agent-research.md §4.2 and issue #9.
 */

import type { Message } from "./types";
import { textOf, userText } from "./types";
import type { ModelProvider } from "../providers/provider";

export type Summarizer = (messages: Message[]) => Promise<string>;

/** Rough token estimate (~4 chars/token) — good enough to trigger compaction. */
export function estimateTokens(messages: Message[]): number {
  let chars = 0;
  for (const m of messages) {
    for (const b of m.content) {
      if (b.type === "text" || b.type === "thinking") chars += b.text.length;
      else if (b.type === "tool_use") chars += b.name.length + JSON.stringify(b.input ?? {}).length;
      else if (b.type === "tool_result") chars += b.content.length;
    }
  }
  return Math.ceil(chars / 4);
}

function containsToolResult(message: Message): boolean {
  return message.content.some((b) => b.type === "tool_result");
}

export interface CompactOptions {
  /** How many recent messages to keep verbatim (before the safe-boundary adjustment). */
  keepRecent?: number;
}

/**
 * Replace all but the most recent messages with a summary. Returns the original
 * array unchanged if it can't compact cleanly (too short, or no safe cut point).
 */
export async function compact(
  messages: Message[],
  summarize: Summarizer,
  opts: CompactOptions = {},
): Promise<Message[]> {
  const keepRecent = opts.keepRecent ?? 6;
  if (messages.length <= keepRecent) return messages;

  let start = messages.length - keepRecent;
  // Orphan-safe boundary: if the kept tail would begin with a message carrying a
  // tool_result, pull the boundary back to include the assistant tool_use it answers.
  while (start > 0 && containsToolResult(messages[start]!)) start -= 1;
  if (start <= 0) return messages; // nothing to gain / can't cut cleanly

  const head = messages.slice(0, start);
  const tail = messages.slice(start);
  const summary = await summarize(head);
  const summaryMessage = userText(`[Earlier conversation, summarized]\n${summary}`);
  return [summaryMessage, ...tail];
}

const SUMMARY_SYSTEM = [
  "You compress conversation history for an AI agent so it can continue with less context.",
  "Preserve: the user's original request and intent, key facts and decisions, files read or",
  "written, errors encountered and how they were resolved, and any pending work.",
  "Drop verbatim tool output and chit-chat. Be concise and factual.",
].join(" ");

function renderForSummary(messages: Message[]): string {
  return messages
    .map((m) => {
      const body = m.content
        .map((b) => {
          switch (b.type) {
            case "text":
              return b.text;
            case "thinking":
              return `(thinking) ${b.text}`;
            case "tool_use":
              return `[calls ${b.name} ${JSON.stringify(b.input ?? {})}]`;
            case "tool_result":
              return `[result${b.isError ? " ERROR" : ""}] ${b.content.slice(0, 500)}`;
          }
        })
        .join("\n");
      return `## ${m.role}\n${body}`;
    })
    .join("\n\n");
}

/** Default summarizer: ask the model to compress the history. */
export function providerSummarizer(provider: ModelProvider): Summarizer {
  return async (messages) => {
    const turn = await provider.generate({
      system: SUMMARY_SYSTEM,
      messages: [
        userText(`Summarize the following so the agent can continue with minimal context:\n\n${renderForSummary(messages)}`),
      ],
      maxTokens: 1024,
    });
    return textOf(turn.message).trim() || "(no summary produced)";
  };
}
