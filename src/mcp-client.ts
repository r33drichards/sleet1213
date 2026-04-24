/**
 * Thin wrapper around @modelcontextprotocol/sdk for remote HTTP MCP servers.
 * Opens a fresh connection per call — short-lived sessions are fine for our
 * use (one-shot `tools/list` during health checks, a handful of
 * `tools/call` per Claude turn).
 *
 * Auto-negotiates transport: tries the modern Streamable HTTP first; on
 * connection failure, falls back to the legacy SSE transport. Servers that
 * only expose `/sse` (e.g. older deployments or the r33drichards/mcp-js V8
 * runtime) work without the caller needing to know the wire protocol.
 */
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { StreamableHTTPClientTransport } from '@modelcontextprotocol/sdk/client/streamableHttp.js';
import { SSEClientTransport } from '@modelcontextprotocol/sdk/client/sse.js';
import { StdioClientTransport } from '@modelcontextprotocol/sdk/client/stdio.js';

export type McpTool = {
  name: string;
  description?: string;
  inputSchema: Record<string, unknown>;
};

export type ToolCallResult = {
  content: Array<{ type: string; text?: string } & Record<string, unknown>>;
  isError?: boolean;
};

/** Connect via Streamable HTTP, falling back to SSE if the server rejects. */
async function connectHttp(url: string): Promise<Client> {
  const parsed = new URL(url);
  const client = new Client({ name: 'ted', version: '0.1.0' });
  try {
    await client.connect(new StreamableHTTPClientTransport(parsed));
    return client;
  } catch (err) {
    // Streamable HTTP failed — try legacy SSE. Don't try to be clever about
    // error-message matching; the SDK throws a handful of distinct error
    // shapes (MCPError, TypeError on parse, fetch aborts). Any of them
    // mean this server probably isn't Streamable-HTTP, so try SSE.
    try {
      await client.close();
    } catch {
      /* ignore */
    }
    const sseClient = new Client({ name: 'ted', version: '0.1.0' });
    try {
      await sseClient.connect(new SSEClientTransport(parsed));
      return sseClient;
    } catch (sseErr) {
      // Surface the SSE error since that's the one the user is more likely
      // to be hitting on a legacy server; mention the HTTP failure too.
      const httpMsg = err instanceof Error ? err.message : String(err);
      const sseMsg =
        sseErr instanceof Error ? sseErr.message : String(sseErr);
      throw new Error(
        `MCP connect failed. SSE: ${sseMsg}. Streamable HTTP: ${httpMsg}`,
      );
    }
  }
}

/** Connect via stdio by spawning a child process. */
async function connectStdio(command: string, args: string[]): Promise<Client> {
  const client = new Client({ name: 'ted', version: '0.1.0' });
  const transport = new StdioClientTransport({ command, args });
  await client.connect(transport);
  return client;
}

export type ConnectOpts =
  | { transport: 'http'; url: string }
  | { transport: 'stdio'; command: string; args: string[] };

async function withClient<T>(
  opts: ConnectOpts,
  fn: (c: Client) => Promise<T>,
): Promise<T> {
  const client = opts.transport === 'stdio'
    ? await connectStdio(opts.command, opts.args)
    : await connectHttp(opts.url);
  try {
    return await fn(client);
  } finally {
    try {
      await client.close();
    } catch {
      /* ignore */
    }
  }
}

export async function listTools(opts: ConnectOpts): Promise<McpTool[]> {
  return withClient(opts, async (c) => {
    const result = await c.listTools();
    return result.tools as McpTool[];
  });
}

export async function callTool(
  opts: ConnectOpts,
  name: string,
  args: Record<string, unknown>,
): Promise<ToolCallResult> {
  return withClient(opts, async (c) => {
    const result = await c.callTool({ name, arguments: args });
    return result as ToolCallResult;
  });
}
