# MCP Integration

Blade Agent SDK can connect to external Model Context Protocol servers and host in-process MCP tools.

## External servers

Configure servers in `SessionOptions.mcpServers`:

```ts
const session = await createSession({
  provider,
  model,
  mcpServers: {
    filesystem: {
      type: 'stdio',
      command: 'npx',
      args: [
        '-y',
        '@modelcontextprotocol/server-filesystem',
        '/workspace',
      ],
    },
  },
});
```

### stdio

```ts
mcpServers: {
  github: {
    type: 'stdio',
    command: 'npx',
    args: ['-y', '@modelcontextprotocol/server-github'],
    env: {
      GITHUB_TOKEN: process.env.GITHUB_TOKEN!,
    },
  },
}
```

### Server-Sent Events

```ts
mcpServers: {
  remote: {
    type: 'sse',
    url: 'https://mcp.example.com/sse',
    headers: {
      Authorization: `Bearer ${token}`,
    },
  },
}
```

### Streamable HTTP

```ts
mcpServers: {
  api: {
    type: 'http',
    url: 'https://mcp.example.com/mcp',
  },
}
```

## McpServerConfig

```ts
interface McpServerConfig {
  command?: string;
  args?: string[];
  env?: Record<string, string>;
  disabled?: boolean;
  alwaysAllow?: string[];
  type?: 'stdio' | 'sse' | 'http';
  url?: string;
  headers?: Record<string, string>;
  oauth?: {
    provider: string;
    clientId?: string;
    enabled?: boolean;
  };
  healthCheck?: {
    enabled?: boolean;
    intervalMs?: number;
  };
}
```

`alwaysAllow` is currently retained as MCP configuration metadata. The Session permission pipeline does not automatically authorize tools from this field. Implement trusted-tool policy with `canUseTool` or `permissionHandler`.

## Runtime management

```ts
const statuses = await session.mcpServerStatus();

await session.mcpConnect('github');
await session.mcpDisconnect('github');
await session.mcpReconnect('github');

const tools = await session.mcpListTools();
```

```ts
interface McpServerStatus {
  name: string;
  status: 'connected' | 'disconnected' | 'connecting' | 'error';
  toolCount: number;
  tools?: string[];
  connectedAt?: Date;
  error?: string;
}

interface McpToolInfo {
  name: string;
  description: string;
  serverName: string;
}
```

## In-process MCP server

```ts
import {
  createSdkMcpServer,
  createSession,
  tool,
} from '@blade-ai/agent-sdk';
import { z } from 'zod';

const getWeather = tool(
  'get-weather',
  'Get the current weather for a city',
  {
    city: z.string(),
  },
  async ({ city }) => ({
    content: [
      {
        type: 'text',
        text: `${city}: clear, 25 C`,
      },
    ],
  }),
);

const server = await createSdkMcpServer({
  name: 'local-tools',
  version: '1.0.0',
  tools: [getWeather],
});

const session = await createSession({
  provider,
  model,
  mcpServers: {
    localTools: server,
  },
});
```

An in-process server executes in the current Node.js process and does not create a child process.

## Response content

```ts
interface McpToolCallResponse {
  content: Array<{
    type: 'text' | 'image' | 'resource';
    text?: string;
    data?: string;
    mimeType?: string;
  }>;
  isError?: boolean;
}
```

## Permission policy

```ts
const session = await createSession({
  provider,
  model,
  mcpServers,
  canUseTool: async (toolName) => {
    if (['read_file', 'list_directory'].includes(toolName)) {
      return { behavior: 'allow' };
    }
    return {
      behavior: 'ask',
      message: `Approve MCP tool ${toolName}?`,
    };
  },
});
```

When multiple MCP servers expose the same tool name, the SDK may rename one to
`serverName__toolName`. Build permission policy from the effective names
returned by `mcpListTools()` rather than assuming raw server names are stable.

Permission approval is not isolation. External MCP tools execute with the privileges and deployment boundary of their server.

## Disabled and deferred connections

```ts
const session = await createSession({
  provider,
  model,
  mcpServers: {
    github: {
      type: 'stdio',
      command: 'npx',
      args: ['-y', '@modelcontextprotocol/server-github'],
      disabled: true,
    },
  },
});

await session.mcpConnect('github');
```

## OAuth and health checks

Remote servers can declare OAuth metadata:

```ts
oauth: {
  provider: 'github',
  clientId: process.env.MCP_CLIENT_ID,
  enabled: true,
}
```

Health checking is configured per server:

```ts
healthCheck: {
  enabled: true,
  intervalMs: 30_000,
}
```

Use `mcpServerStatus()` as the application-facing source for connection state and errors.

## Resource tools

When an MCP registry is present, the local built-in tool set includes:

- `ListMcpResources`
- `ReadMcpResource`

They are separate from dynamically registered MCP function tools.
