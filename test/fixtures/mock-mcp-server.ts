/**
 * A minimal MCP stdio server for tests. Speaks newline-delimited JSON-RPC 2.0
 * and exposes one tool, `add`. Run via `bun test/fixtures/mock-mcp-server.ts`.
 */

function send(obj: unknown): void {
  process.stdout.write(JSON.stringify(obj) + "\n");
}

let buffer = "";
process.stdin.on("data", (chunk: Buffer) => {
  buffer += chunk.toString("utf8");
  let newline: number;
  while ((newline = buffer.indexOf("\n")) >= 0) {
    const line = buffer.slice(0, newline).trim();
    buffer = buffer.slice(newline + 1);
    if (line) handle(JSON.parse(line));
  }
});

function handle(msg: { id?: number; method?: string; params?: any }): void {
  switch (msg.method) {
    case "initialize":
      send({
        jsonrpc: "2.0",
        id: msg.id,
        result: {
          protocolVersion: "2025-06-18",
          capabilities: { tools: {} },
          serverInfo: { name: "mock", version: "0.0.1" },
        },
      });
      break;
    case "notifications/initialized":
      break; // notification: no reply
    case "tools/list":
      send({
        jsonrpc: "2.0",
        id: msg.id,
        result: {
          tools: [
            {
              name: "add",
              description: "Add two numbers.",
              inputSchema: {
                type: "object",
                properties: { a: { type: "number" }, b: { type: "number" } },
                required: ["a", "b"],
              },
            },
          ],
        },
      });
      break;
    case "tools/call": {
      const { name, arguments: args } = msg.params ?? {};
      if (name === "add") {
        send({ jsonrpc: "2.0", id: msg.id, result: { content: [{ type: "text", text: String((args?.a ?? 0) + (args?.b ?? 0)) }] } });
      } else {
        send({ jsonrpc: "2.0", id: msg.id, result: { content: [{ type: "text", text: `unknown tool: ${name}` }], isError: true } });
      }
      break;
    }
    default:
      if (msg.id !== undefined) {
        send({ jsonrpc: "2.0", id: msg.id, error: { code: -32601, message: "Method not found" } });
      }
  }
}
