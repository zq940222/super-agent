/**
 * Session persistence — an append-only JSONL rollout (P4).
 *
 * Records the raw message stream (pre-compaction) plus a meta line, so a run is
 * inspectable, recoverable, and could later be resumed or forked. Append-only +
 * line-based is the same cheap, portable pattern Codex and OpenClaw use.
 *
 * See docs/agent-research.md §3.3 and issue #9.
 */

import { appendFile, mkdir, readFile } from "node:fs/promises";
import { dirname } from "node:path";
import type { Message } from "../core/types";

export interface RolloutRecorder {
  readonly path: string;
  recordMeta(meta: Record<string, unknown>): Promise<void>;
  recordMessage(message: Message): Promise<void>;
}

export function createRollout(path: string): RolloutRecorder {
  let ensured: Promise<void> | undefined;
  const ensureDir = (): Promise<void> =>
    (ensured ??= mkdir(dirname(path), { recursive: true }).then(() => undefined));

  const write = async (obj: unknown): Promise<void> => {
    await ensureDir();
    await appendFile(path, JSON.stringify(obj) + "\n", "utf8");
  };

  return {
    path,
    async recordMeta(meta) {
      await write({ type: "meta", at: Date.now(), ...meta });
    },
    async recordMessage(message) {
      await write({ type: "message", at: Date.now(), message });
    },
  };
}

/** Read back the recorded messages (for inspection or resume). */
export async function readSessionMessages(path: string): Promise<Message[]> {
  const text = await readFile(path, "utf8");
  const messages: Message[] = [];
  for (const line of text.split("\n")) {
    if (!line.trim()) continue;
    const entry = JSON.parse(line) as { type?: string; message?: Message };
    if (entry.type === "message" && entry.message) messages.push(entry.message);
  }
  return messages;
}
