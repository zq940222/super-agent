/**
 * Skill tools (P9) — `find_skill`, `read_skill`, `create_skill`, registered like
 * any other tool so they flow through the same registry + permission gate.
 * `create_skill` is medium-risk (a write / self-modification) → gated by default.
 * See issue #16.
 */

import { z } from "zod";
import { defineTool, type RegisteredTool } from "../tools/registry";
import { isValidSkillName, type SkillStore } from "./store";

export function createSkillTools(store: SkillStore): RegisteredTool[] {
  const findSkill = defineTool({
    name: "find_skill",
    description:
      "Search your library of reusable skills (procedure guides) by keyword. Returns matching " +
      "skill names and descriptions — call read_skill to load one's full instructions. Empty query lists all.",
    risk: "low",
    schema: z.object({
      query: z.string().default("").describe("Keywords to match skill names/descriptions. Empty = list all."),
    }),
    handler: async ({ query }) => {
      const metas = await store.find(query);
      if (metas.length === 0) return "No matching skills. You can author one with create_skill.";
      return metas.map((m) => `- ${m.name}: ${m.description}`).join("\n");
    },
  });

  const readSkill = defineTool({
    name: "read_skill",
    description:
      "Load the full instructions of a skill by name (discover names with find_skill), then follow the procedure it returns.",
    risk: "low",
    schema: z.object({ name: z.string().min(1).describe("The skill's name.") }),
    handler: async ({ name }) => {
      const skill = await store.read(name);
      return `# Skill: ${skill.name}\n${skill.description}\n\n${skill.body}`;
    },
  });

  const createSkill = defineTool({
    name: "create_skill",
    description:
      "Save a new reusable skill (a procedure guide) to your skill library, so you can find_skill/read_skill " +
      "it next time. Use it after working out how to do a non-trivial task.",
    risk: "medium",
    mutates: true, // writes a skill file
    schema: z.object({
      name: z
        .string()
        .refine(isValidSkillName, "must be kebab-case (a-z, 0-9, -)")
        .describe("Kebab-case name, e.g. 'deploy-to-staging'."),
      description: z.string().min(1).describe("One line: what the skill does and when to use it."),
      body: z.string().min(1).describe("Step-by-step instructions in Markdown."),
    }),
    handler: async ({ name, description, body }) => {
      const path = await store.create({ name, description, body });
      return `Saved skill "${name}" to ${path}.`;
    },
  });

  return [findSkill, readSkill, createSkill];
}

/**
 * A short "available skills" catalog to append to the system prompt at startup
 * (stable prefix — cache-safe; never mutate the system prompt mid-session).
 */
export async function skillsCatalog(store: SkillStore): Promise<string> {
  const metas = await store.list();
  if (metas.length === 0) {
    return "You can save reusable procedures as skills with create_skill and recall them with find_skill / read_skill.";
  }
  const lines = metas.map((m) => `- ${m.name}: ${m.description}`).join("\n");
  return (
    "You have a library of reusable skills. Before a matching task, call read_skill to load one.\n" +
    `Available skills:\n${lines}\n` +
    "You can also author new skills with create_skill."
  );
}
