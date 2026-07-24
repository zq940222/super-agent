import { test, expect } from "bun:test";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { SkillStore, isValidSkillName, parseSkill } from "../src/skills/store";

const tmp = () => mkdtemp(join(tmpdir(), "sa-skills-"));

test("create → list → read round-trips", async () => {
  const dir = await tmp();
  try {
    const store = new SkillStore(dir);
    await store.create({ name: "greet", description: "Say hello nicely", body: "1. Smile\n2. Say hi" });

    const list = await store.list();
    expect(list).toEqual([{ name: "greet", description: "Say hello nicely" }]);

    const skill = await store.read("greet");
    expect(skill.description).toBe("Say hello nicely");
    expect(skill.body).toContain("Say hi");
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

test("list on a non-existent dir returns []", async () => {
  const store = new SkillStore(join(tmpdir(), "sa-does-not-exist-xyz"));
  expect(await store.list()).toEqual([]);
});

test("find ranks by keyword and empty query lists all", async () => {
  const dir = await tmp();
  try {
    const store = new SkillStore(dir);
    await store.create({ name: "deploy-staging", description: "Deploy the app to staging", body: "x" });
    await store.create({ name: "run-tests", description: "Run the test suite", body: "y" });

    expect((await store.find("deploy")).map((m) => m.name)).toEqual(["deploy-staging"]);
    expect((await store.find("")).length).toBe(2);
    expect(await store.find("nonsense")).toEqual([]);
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

test("refuses to overwrite an existing skill", async () => {
  const dir = await tmp();
  try {
    const store = new SkillStore(dir);
    await store.create({ name: "dup", description: "d", body: "b" });
    await expect(store.create({ name: "dup", description: "d2", body: "b2" })).rejects.toThrow(/already exists/);
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

test("rejects an invalid skill name (no path traversal)", async () => {
  const dir = await tmp();
  try {
    const store = new SkillStore(dir);
    await expect(store.create({ name: "../evil", description: "d", body: "b" })).rejects.toThrow(/Invalid skill name/);
    await expect(store.read("../../etc/passwd")).rejects.toThrow(/Invalid skill name/);
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

test("isValidSkillName + parseSkill", () => {
  expect(isValidSkillName("deploy-staging")).toBe(true);
  expect(isValidSkillName("Bad Name")).toBe(false);
  expect(isValidSkillName("../x")).toBe(false);

  const { meta, body } = parseSkill(`---\nname: x\ndescription: "hello: world"\n---\n\nStep one`);
  expect(meta.name).toBe("x");
  expect(meta.description).toBe("hello: world");
  expect(body).toBe("Step one");
});
