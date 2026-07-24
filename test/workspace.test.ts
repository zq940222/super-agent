import { test, expect } from "bun:test";
import { resolve } from "node:path";
import { resolveInWorkspace } from "../src/tools/workspace";

const root = resolve(process.cwd());

test("resolves a path inside the workspace", () => {
  const abs = resolveInWorkspace({ cwd: root, workspaceRoot: root }, "sub/file.txt");
  expect(abs).toBe(resolve(root, "sub/file.txt"));
});

test("allows the workspace root itself", () => {
  expect(resolveInWorkspace({ cwd: root, workspaceRoot: root }, ".")).toBe(root);
});

test("rejects a path escaping the workspace root", () => {
  expect(() => resolveInWorkspace({ cwd: root, workspaceRoot: root }, "../outside.txt")).toThrow(
    /escapes the workspace/,
  );
});

test("rejects an absolute path outside the workspace root", () => {
  const outside = process.platform === "win32" ? "C:\\Windows\\system.ini" : "/etc/passwd";
  expect(() => resolveInWorkspace({ cwd: root, workspaceRoot: root }, outside)).toThrow(
    /escapes the workspace/,
  );
});

test("no workspaceRoot ⇒ unrestricted (back-compat)", () => {
  expect(resolveInWorkspace({ cwd: root }, "../anywhere.txt")).toBe(resolve(root, "../anywhere.txt"));
});
