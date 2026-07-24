/**
 * Skill store (P9).
 *
 * Skills are reusable, human-readable procedure documents — distinct from
 * executable tools (per the research: Claude Code's Skill, OpenClaw's SKILL.md,
 * Hermes' agentskills.io). Each lives at `<dir>/<name>/SKILL.md` with YAML
 * frontmatter (`name`, `description`) and a Markdown body. The agent discovers
 * them cheaply (name + description), loads a body on demand, and can author new
 * ones — a self-improving loop. See issue #16.
 */

import { mkdir, readdir, readFile, stat, writeFile } from "node:fs/promises";
import { join, resolve } from "node:path";

export interface SkillMeta {
  name: string;
  description: string;
}
export interface Skill extends SkillMeta {
  body: string;
}

/** Kebab-case, no path traversal. */
const NAME_RE = /^[a-z0-9][a-z0-9-]{0,63}$/;

export function isValidSkillName(name: string): boolean {
  return NAME_RE.test(name);
}

/** Minimal `---`-delimited YAML frontmatter parser (no dependency). */
export function parseSkill(raw: string): { meta: Record<string, string>; body: string } {
  const match = raw.match(/^---\n([\s\S]*?)\n---\n?([\s\S]*)$/);
  if (!match) return { meta: {}, body: raw.trim() };
  const meta: Record<string, string> = {};
  for (const line of (match[1] ?? "").split("\n")) {
    const kv = line.match(/^([A-Za-z0-9_-]+):\s*(.*)$/);
    const key = kv?.[1];
    if (key) meta[key] = (kv?.[2] ?? "").trim().replace(/^["']|["']$/g, "");
  }
  return { meta, body: (match[2] ?? "").trim() };
}

async function exists(path: string): Promise<boolean> {
  try {
    await stat(path);
    return true;
  } catch {
    return false;
  }
}

export class SkillStore {
  private readonly dir: string;

  constructor(dir: string) {
    this.dir = resolve(dir);
  }

  private pathFor(name: string): string {
    if (!isValidSkillName(name)) {
      throw new Error(`Invalid skill name "${name}" (use kebab-case: a-z, 0-9, -).`);
    }
    return join(this.dir, name, "SKILL.md");
  }

  /** All skills' metadata (name + description), sorted by name. */
  async list(): Promise<SkillMeta[]> {
    let dirs: string[];
    try {
      dirs = (await readdir(this.dir, { withFileTypes: true }))
        .filter((e) => e.isDirectory())
        .map((e) => e.name);
    } catch {
      return []; // dir doesn't exist yet
    }
    const metas: SkillMeta[] = [];
    for (const name of dirs) {
      try {
        const raw = await readFile(join(this.dir, name, "SKILL.md"), "utf8");
        metas.push({ name, description: parseSkill(raw).meta.description ?? "" });
      } catch {
        // skip a directory without a readable SKILL.md
      }
    }
    return metas.sort((a, b) => a.name.localeCompare(b.name));
  }

  /** Keyword-ranked search over name + description. Empty query → all. */
  async find(query?: string): Promise<SkillMeta[]> {
    const all = await this.list();
    const terms = (query ?? "").toLowerCase().split(/\s+/).filter(Boolean);
    if (terms.length === 0) return all;
    return all
      .map((m) => {
        const hay = `${m.name} ${m.description}`.toLowerCase();
        return { m, score: terms.filter((t) => hay.includes(t)).length };
      })
      .filter((x) => x.score > 0)
      .sort((a, b) => b.score - a.score)
      .map((x) => x.m);
  }

  async read(name: string): Promise<Skill> {
    const raw = await readFile(this.pathFor(name), "utf8");
    const { meta, body } = parseSkill(raw);
    return { name, description: meta.description ?? "", body };
  }

  /** Author a new skill. Refuses to overwrite an existing one. Returns the path. */
  async create(skill: { name: string; description: string; body: string }): Promise<string> {
    const path = this.pathFor(skill.name);
    if (await exists(path)) throw new Error(`Skill "${skill.name}" already exists.`);
    await mkdir(join(this.dir, skill.name), { recursive: true });
    const description = skill.description.replace(/\r?\n/g, " ").replace(/"/g, '\\"').trim();
    const content = `---\nname: ${skill.name}\ndescription: "${description}"\n---\n\n${skill.body.trim()}\n`;
    await writeFile(path, content, "utf8");
    return path;
  }
}
