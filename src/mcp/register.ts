/**
 * Register the tools of an MCP server into our ToolRegistry, so they flow
 * through the SAME model-facing schema, permission gate, and execution path as
 * native tools (OpenClaw's lesson: one gate for every tool source). See issue #11.
 */

import { McpClient, type McpServerConfig } from "./client";
import type { RegisteredTool, Risk, ToolRegistry } from "../tools/registry";

export interface McpConnectOptions extends McpServerConfig {
  /** Server name, used to namespace tools as `mcp__<name>__<tool>`. */
  name: string;
  /** Risk assigned to this server's tools. Default "high" (third-party/untrusted). */
  risk?: Risk;
}

export interface McpConnection {
  client: McpClient;
  toolNames: string[];
}

export async function connectMcpServer(
  registry: ToolRegistry,
  opts: McpConnectOptions,
): Promise<McpConnection> {
  const client = McpClient.spawn(opts);
  await client.initialize();
  const tools = await client.listTools();

  const toolNames: string[] = [];
  for (const tool of tools) {
    const namespaced = `mcp__${opts.name}__${tool.name}`;
    const registered: RegisteredTool = {
      spec: {
        name: namespaced,
        description: tool.description ?? `MCP tool "${tool.name}" from server "${opts.name}".`,
        inputSchema: tool.inputSchema ?? { type: "object" },
      },
      risk: opts.risk ?? "high",
      // No local validator: the MCP server validates its own arguments.
      handler: async (input) => {
        const { text, isError } = await client.callTool(tool.name, input);
        if (isError) throw new Error(text || `MCP tool ${tool.name} reported an error`);
        return text;
      },
    };
    registry.register(registered);
    toolNames.push(namespaced);
  }

  return { client, toolNames };
}
