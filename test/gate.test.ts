import { test, expect } from "bun:test";
import { PermissionPolicy } from "../src/permissions/gate";
import type { Risk } from "../src/tools/registry";

const tool = (name: string, risk: Risk) => ({ name, risk });

test("default mode: low allowed, medium/high asked", () => {
  const p = new PermissionPolicy();
  expect(p.decide(tool("read_file", "low"))).toBe("allow");
  expect(p.decide(tool("thing", "medium"))).toBe("ask");
  expect(p.decide(tool("write_file", "high"))).toBe("ask");
});

test("auto mode allows everything", () => {
  const p = new PermissionPolicy({ mode: "auto" });
  expect(p.decide(tool("write_file", "high"))).toBe("allow");
});

test("readonly mode denies anything not low-risk", () => {
  const p = new PermissionPolicy({ mode: "readonly" });
  expect(p.decide(tool("read_file", "low"))).toBe("allow");
  expect(p.decide(tool("write_file", "high"))).toBe("deny");
});

test("readonly mode denies a mutating tool even when it is low-risk", () => {
  const p = new PermissionPolicy({ mode: "readonly" });
  expect(p.decide({ name: "read_file", risk: "low", mutates: false })).toBe("allow");
  expect(p.decide({ name: "write_file", risk: "low", mutates: true })).toBe("deny"); // the point
});

test("default mode ignores `mutates` — a low-risk write runs without asking", () => {
  const p = new PermissionPolicy(); // default
  expect(p.decide({ name: "write_file", risk: "low", mutates: true })).toBe("allow");
});

test("precedence: deny > ask > allow > mode", () => {
  const p = new PermissionPolicy({ mode: "auto", deny: ["a"], ask: ["b"], allow: ["c"] });
  expect(p.decide(tool("a", "low"))).toBe("deny");
  expect(p.decide(tool("b", "low"))).toBe("ask");
  expect(p.decide(tool("c", "high"))).toBe("allow");
});

test("an allow rule overrides a restrictive mode", () => {
  const p = new PermissionPolicy({ mode: "readonly", allow: ["write_file"] });
  expect(p.decide(tool("write_file", "high"))).toBe("allow");
});

test("a deny rule overrides an otherwise-allowing mode", () => {
  const p = new PermissionPolicy({ mode: "auto", deny: ["read_file"] });
  expect(p.decide(tool("read_file", "low"))).toBe("deny");
});

test("allowForSession turns a subsequent ask into an allow (the HITL 'always' choice)", () => {
  const p = new PermissionPolicy(); // default mode
  expect(p.decide(tool("write_file", "medium"))).toBe("ask");
  p.allowForSession("write_file");
  expect(p.decide(tool("write_file", "medium"))).toBe("allow");
});

test("allowForSession cannot punch through an explicit deny", () => {
  const p = new PermissionPolicy({ deny: ["danger"] });
  p.allowForSession("danger");
  expect(p.decide(tool("danger", "low"))).toBe("deny");
});

test("allowForSession refuses to persist a high-risk rule (ADR-0005 §3)", () => {
  const p = new PermissionPolicy(); // default mode
  expect(p.allowForSession("shell", "high")).toBe(false); // the one-click is refused
  // …so shell keeps asking every call instead of being allowed for the session.
  expect(p.decide(tool("shell", "high"))).toBe("ask");
});

test("allowForSession still persists low/medium rules (returns true)", () => {
  const p = new PermissionPolicy();
  expect(p.allowForSession("web_fetch", "medium")).toBe(true);
  expect(p.decide(tool("web_fetch", "medium"))).toBe("allow");
});

test("a deliberate construction-time allow still pre-authorizes a high-risk tool", () => {
  // Only the runtime one-click is refused; an up-front operator choice is honored.
  const p = new PermissionPolicy({ allow: ["shell"] });
  expect(p.decide(tool("shell", "high"))).toBe("allow");
});
