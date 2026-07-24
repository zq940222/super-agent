/**
 * A minimal MCP (Model Context Protocol) client over stdio — hand-rolled so the
 * protocol is legible, not hidden behind an SDK (this is a learning project).
 *
 * MCP's stdio transport is newline-delimited JSON-RPC 2.0: each message is one
 * line on stdin/stdout, no embedded newlines. Lifecycle: `initialize` request →
 * `notifications/initialized`, then `tools/list` and `tools/call`.
 *
 * Scope (P7): stdio transport, tools only. No HTTP transport, resources,
 * prompts, sampling, or list_changed refresh. See issue #11.
 */

export interface McpServerConfig {
  command: string;
  args?: string[];
  env?: Record<string, string>;
  cwd?: string;
}

export interface McpToolInfo {
  name: string;
  description?: string;
  inputSchema: Record<string, unknown>;
}

interface Pending {
  resolve: (value: unknown) => void;
  reject: (err: Error) => void;
}

interface JsonRpcResponse {
  id?: number;
  result?: unknown;
  error?: { code?: number; message?: string };
}

export class McpClient {
  private proc: Bun.Subprocess<"pipe", "pipe", "inherit">;
  private nextId = 1;
  private pending = new Map<number, Pending>();
  private buffer = "";
  serverInfo?: { name?: string; version?: string };

  private constructor(proc: Bun.Subprocess<"pipe", "pipe", "inherit">) {
    this.proc = proc;
    void this.readLoop();
  }

  static spawn(config: McpServerConfig): McpClient {
    const proc = Bun.spawn({
      cmd: [config.command, ...(config.args ?? [])],
      stdin: "pipe",
      stdout: "pipe",
      stderr: "inherit",
      env: config.env ? { ...process.env, ...config.env } : undefined,
      cwd: config.cwd,
    });
    return new McpClient(proc as Bun.Subprocess<"pipe", "pipe", "inherit">);
  }

  private async readLoop(): Promise<void> {
    const decoder = new TextDecoder();
    for await (const chunk of this.proc.stdout as unknown as AsyncIterable<Uint8Array>) {
      this.buffer += decoder.decode(chunk, { stream: true });
      let newline: number;
      while ((newline = this.buffer.indexOf("\n")) >= 0) {
        const line = this.buffer.slice(0, newline).trim();
        this.buffer = this.buffer.slice(newline + 1);
        if (line) this.handleLine(line);
      }
    }
    // Stream ended: fail any in-flight requests.
    for (const [, p] of this.pending) p.reject(new Error("MCP server closed the connection"));
    this.pending.clear();
  }

  private handleLine(line: string): void {
    let msg: JsonRpcResponse;
    try {
      msg = JSON.parse(line) as JsonRpcResponse;
    } catch {
      return; // ignore non-JSON (e.g. stray server logging on stdout)
    }
    if (msg.id === undefined) return; // a notification from the server — ignored in P7
    const pending = this.pending.get(msg.id);
    if (!pending) return;
    this.pending.delete(msg.id);
    if (msg.error) pending.reject(new Error(msg.error.message ?? "MCP error"));
    else pending.resolve(msg.result);
  }

  private send(obj: unknown): void {
    this.proc.stdin.write(JSON.stringify(obj) + "\n");
    this.proc.stdin.flush();
  }

  request(method: string, params?: unknown, timeoutMs = 15_000): Promise<unknown> {
    const id = this.nextId++;
    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => {
        if (this.pending.delete(id)) reject(new Error(`MCP request timed out: ${method}`));
      }, timeoutMs);
      this.pending.set(id, {
        resolve: (v) => (clearTimeout(timer), resolve(v)),
        reject: (e) => (clearTimeout(timer), reject(e)),
      });
      this.send({ jsonrpc: "2.0", id, method, params: params ?? {} });
    });
  }

  notify(method: string, params?: unknown): void {
    this.send({ jsonrpc: "2.0", method, params: params ?? {} });
  }

  async initialize(): Promise<void> {
    const result = (await this.request("initialize", {
      protocolVersion: "2025-06-18",
      capabilities: {},
      clientInfo: { name: "super-agent", version: "0.1.0" },
    })) as { serverInfo?: { name?: string; version?: string } };
    this.serverInfo = result?.serverInfo;
    this.notify("notifications/initialized");
  }

  async listTools(): Promise<McpToolInfo[]> {
    const result = (await this.request("tools/list")) as { tools?: McpToolInfo[] };
    return result?.tools ?? [];
  }

  async callTool(name: string, args: unknown): Promise<{ text: string; isError: boolean }> {
    const result = (await this.request("tools/call", { name, arguments: args ?? {} })) as {
      content?: Array<{ type?: string; text?: string }>;
      isError?: boolean;
    };
    const content = Array.isArray(result?.content) ? result.content : [];
    const text =
      content
        .filter((c) => c.type === "text" && typeof c.text === "string")
        .map((c) => c.text)
        .join("\n") || JSON.stringify(result?.content ?? result ?? null);
    return { text, isError: Boolean(result?.isError) };
  }

  async close(): Promise<void> {
    try {
      this.proc.stdin.end();
    } catch {
      /* already closed */
    }
    this.proc.kill();
    await this.proc.exited.catch(() => undefined);
  }
}
