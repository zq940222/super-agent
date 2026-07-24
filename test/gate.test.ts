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
