import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { StreamableHTTPClientTransport } from '@modelcontextprotocol/sdk/client/streamableHttp.js';
import { BACKEND_URL } from './env';

export const LOGICAL_ACTIONS = {
  readIssue: 'retirement-demo:read-issue',
  listServices: 'retirement-demo:list-services',
  previewRetirement: 'retirement-demo:preview-retirement',
  retireService: 'retirement-demo:retire-service',
} as const;

export type Envelope = {
  logicalAction: string;
  toolName: string;
  arguments: Record<string, unknown>;
  isError: boolean;
  /** Text content exactly as returned by the native MCP server. */
  text: string[];
  structuredContent?: unknown;
  /** Transport/protocol level failure (no tool result at all). */
  protocolError?: string;
};

export type McpSession = {
  client: Client;
  transport: StreamableHTTPClientTransport;
  endpoint: string;
  close: () => Promise<void>;
};

/** Connects with the official MCP TypeScript SDK over Streamable HTTP. */
export async function connect(
  token: string | undefined,
  endpointPath = '/api/mcp-actions/v1',
): Promise<McpSession> {
  const endpoint = `${BACKEND_URL}${endpointPath}`;
  const transport = new StreamableHTTPClientTransport(new URL(endpoint), {
    requestInit: token ? { headers: { Authorization: `Bearer ${token}` } } : {},
  });
  const client = new Client({ name: 'who-authorized-that-replay', version: '0.1.0' });
  await client.connect(transport);
  return { client, transport, endpoint, close: () => client.close() };
}

/** Maps logical action IDs to the tool names the native plugin actually exposes. */
export async function discoverTools(session: McpSession) {
  const { tools } = await session.client.listTools();
  const mapping: Record<string, string | undefined> = {};
  for (const [key, logical] of Object.entries(LOGICAL_ACTIONS)) {
    const [, name] = logical.split(':');
    mapping[key] = tools.find(
      t => t.name === name || t.name.endsWith(`.${name}`) || t.name === logical,
    )?.name;
  }
  return { tools, mapping };
}

export async function callTool(
  session: McpSession,
  logicalAction: string,
  toolName: string,
  args: Record<string, unknown>,
): Promise<Envelope> {
  try {
    const result = await session.client.callTool({ name: toolName, arguments: args });
    const content = (result.content ?? []) as Array<{ type: string; text?: string }>;
    return {
      logicalAction,
      toolName,
      arguments: args,
      isError: Boolean(result.isError),
      text: content.filter(c => c.type === 'text').map(c => c.text ?? ''),
      structuredContent: result.structuredContent,
    };
  } catch (e) {
    return {
      logicalAction,
      toolName,
      arguments: args,
      isError: true,
      text: [],
      protocolError: `${(e as Error).name}: ${(e as Error).message}`,
    };
  }
}
