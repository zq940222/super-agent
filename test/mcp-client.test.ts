import { test, expect } from "bun:test";
import { join } from "node:path";
import { McpClient } from "../src/mcp/client";

const SERVER = join(import.meta.dir, "fixtures", "mock-mcp-server.ts");
const spawn = () => McpClient.spawn({ command: "bun", args: [SERVER] });

test("initializes and reads server info", async () => {
  const client = spawn();
  try {
    await client.initialize();
    expect(client.serverInfo?.name).toBe("mock");
  } finally {
    await client.close();
  }
});

test("lists tools with their JSON Schema", async () => {
  const client = spawn();
  try {
    await client.initialize();
    const tools = await client.listTools();
    const add = tools.find((t) => t.name === "add");
    expect(add).toBeDefined();
    expect(add!.inputSchema).toMatchObject({ type: "object" });
  } finally {
    await client.close();
  }
});

test("calls a tool and returns its text content", async () => {
  const client = spawn();
  try {
    await client.initialize();
    const res = await client.callTool("add", { a: 2, b: 3 });
    expect(res.isError).toBe(false);
    expect(res.text).toBe("5");
  } finally {
    await client.close();
  }
});

test("surfaces an MCP tool error", async () => {
  const client = spawn();
  try {
    await client.initialize();
    const res = await client.callTool("nope", {});
    expect(res.isError).toBe(true);
  } finally {
    await client.close();
  }
});
