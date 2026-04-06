# MCP 协议集成

MCP（Model Context Protocol）是连接 LLM 与外部工具、数据源的标准协议。Blade Agent SDK 支持连接外部 MCP Server，也支持在进程内创建 MCP Server。

## 连接外部 MCP Server

在 `createSession` 的 `mcpServers` 中配置：

```ts
import { createSession } from '@blade-ai/agent-sdk';

const session = await createSession({
  provider: { type: 'anthropic', apiKey: process.env.ANTHROPIC_API_KEY },
  model: 'claude-sonnet-4-20250514',
  mcpServers: {
    filesystem: {
      type: 'stdio',
      command: 'npx',
      args: ['-y', '@modelcontextprotocol/server-filesystem', '/workspace'],
    },
  },
});
```

### 三种传输模式

**stdio — 本地子进程**

最常见的模式，SDK 启动子进程并通过 stdin/stdout 通信：

```ts
mcpServers: {
  github: {
    type: 'stdio',
    command: 'npx',
    args: ['-y', '@modelcontextprotocol/server-github'],
    env: { GITHUB_TOKEN: process.env.GITHUB_TOKEN },
  },
}
```

**SSE — Server-Sent Events**

适用于远程 MCP 服务器：

```ts
mcpServers: {
  remote: {
    type: 'sse',
    url: 'https://mcp.example.com/sse',
    headers: { Authorization: `Bearer ${token}` },
  },
}
```

**HTTP — Streamable HTTP**

适用于支持 HTTP 传输的 MCP 服务器：

```ts
mcpServers: {
  api: {
    type: 'http',
    url: 'https://mcp.example.com/mcp',
  },
}
```

## McpServerConfig 完整参考

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

| 字段 | 类型 | 说明 |
|------|------|------|
| `command` | `string` | stdio 模式的启动命令 |
| `args` | `string[]` | 命令参数 |
| `env` | `Record<string, string>` | 子进程环境变量 |
| `disabled` | `boolean` | 暂时禁用此服务器 |
| `alwaysAllow` | `string[]` | 自动授权的工具名列表（跳过权限检查） |
| `type` | `'stdio' \| 'sse' \| 'http'` | 传输模式 |
| `url` | `string` | SSE/HTTP 模式的服务器 URL |
| `headers` | `Record<string, string>` | SSE/HTTP 的请求头 |
| `oauth` | `object` | OAuth 认证配置 |
| `healthCheck` | `object` | 健康检查配置 |

## 运行时管理

Session 提供了完整的 MCP 运行时管理 API：

### 查看服务器状态

```ts
const statuses = await session.mcpServerStatus();
for (const s of statuses) {
  console.log(`${s.name}: ${s.status} (${s.toolCount} tools)`);
}
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
```

### 连接/断开/重连

```ts
await session.mcpConnect('github');
await session.mcpDisconnect('github');
await session.mcpReconnect('github');
```

### 列出可用工具

```ts
const tools = await session.mcpListTools();
for (const t of tools) {
  console.log(`${t.serverName}/${t.name}: ${t.description}`);
}
```

```ts
interface McpToolInfo {
  name: string;
  description: string;
  serverName: string;
}
```

## 创建进程内 MCP Server

当你需要用 TypeScript 编写自定义工具时，可以用 `tool()` 和 `createSdkMcpServer()` 创建进程内 MCP Server，无需启动额外进程：

```ts
import { tool, createSdkMcpServer, createSession } from '@blade-ai/agent-sdk';
import { z } from 'zod';

// 定义工具（使用 Zod Schema）
const getWeather = tool(
  'get-weather',
  '查询指定城市的当前天气',
  { city: z.string().describe('城市名称') },
  async ({ city }) => ({
    content: [{ type: 'text', text: `${city}: 晴 25°C` }],
  }),
);

const queryDB = tool(
  'query-database',
  '执行 SQL 查询',
  {
    sql: z.string().describe('SQL 语句'),
    database: z.string().default('main').describe('数据库名'),
  },
  async ({ sql, database }) => {
    const result = await executeSQL(database, sql);
    return { content: [{ type: 'text', text: JSON.stringify(result) }] };
  },
);

// 创建 MCP Server
const myServer = await createSdkMcpServer({
  name: 'my-tools',
  version: '1.0.0',
  tools: [getWeather, queryDB],
});

// 在 Session 中使用
const session = await createSession({
  provider: { type: 'openai', apiKey: process.env.OPENAI_API_KEY },
  model: 'gpt-4o',
  mcpServers: {
    myTools: myServer,  // SdkMcpServerHandle
  },
});
```

::: tip
进程内 MCP Server 不会启动子进程，直接在当前进程中执行，性能更高、调试更方便。
:::

### tool() 函数签名

```ts
function tool<T extends ZodRawShape>(
  name: string,
  description: string,
  schema: T,
  handler: (params: z.infer<z.ZodObject<T>>) => Promise<McpToolCallResponse>,
): SdkTool;
```

### McpToolCallResponse

```ts
interface McpToolCallResponse {
  content: Array<{ type: 'text'; text: string }>;
  isError?: boolean;
}
```

## alwaysAllow 自动授权

对于信任的 MCP 工具，可以跳过权限检查：

```ts
mcpServers: {
  filesystem: {
    type: 'stdio',
    command: 'npx',
    args: ['-y', '@modelcontextprotocol/server-filesystem', '/workspace'],
    alwaysAllow: ['read_file', 'list_directory'],  // 这些工具不需要权限确认
  },
}
```

::: warning
`alwaysAllow` 仅影响权限提示，不影响沙箱限制。即使自动授权，沙箱仍然会限制实际执行范围。
:::

## OAuth 认证

远程 MCP 服务器可以使用 OAuth 进行认证：

```ts
mcpServers: {
  enterprise: {
    type: 'http',
    url: 'https://mcp.enterprise.com/api',
    oauth: {
      provider: 'github',
      clientId: 'your-client-id',
      enabled: true,
    },
  },
}
```

## 健康检查

启用健康检查后，SDK 会定期检测 MCP 服务器状态，自动发现连接中断：

```ts
mcpServers: {
  critical: {
    type: 'stdio',
    command: 'my-mcp-server',
    healthCheck: {
      enabled: true,
      intervalMs: 30000,  // 每 30 秒检查一次
    },
  },
}
```

健康检查支持以下状态：

| 状态 | 说明 |
|------|------|
| `healthy` | 服务器响应正常 |
| `degraded` | 服务器响应变慢或部分功能异常 |
| `unhealthy` | 服务器无响应或连续失败 |
| `checking` | 正在执行健康检查 |
| `disabled` | 未启用健康检查 |

::: info 工具排序
MCP 服务器注册的工具在发送给 LLM 时排列在内置工具**之后**。每组内按名称字母序排列。这意味着内置工具在 LLM 上下文中具有更高的优先级。
:::

## 实战示例

### 多服务器组合

```ts
import { tool, createSdkMcpServer, createSession } from '@blade-ai/agent-sdk';
import { z } from 'zod';

// 进程内工具
const analyzeCode = tool(
  'analyze-code',
  '分析代码质量',
  { filePath: z.string() },
  async ({ filePath }) => {
    const result = await runLinter(filePath);
    return { content: [{ type: 'text', text: result }] };
  },
);

const codeAnalyzer = await createSdkMcpServer({
  name: 'code-analyzer',
  version: '1.0.0',
  tools: [analyzeCode],
});

const session = await createSession({
  provider: { type: 'anthropic', apiKey: process.env.ANTHROPIC_API_KEY },
  model: 'claude-sonnet-4-20250514',
  mcpServers: {
    // 外部：文件系统
    filesystem: {
      type: 'stdio',
      command: 'npx',
      args: ['-y', '@modelcontextprotocol/server-filesystem', '.'],
    },
    // 外部：GitHub
    github: {
      type: 'stdio',
      command: 'npx',
      args: ['-y', '@modelcontextprotocol/server-github'],
      env: { GITHUB_TOKEN: process.env.GITHUB_TOKEN },
    },
    // 进程内：自定义分析工具
    analyzer: codeAnalyzer,
  },
});
```

### 动态连接管理

```ts
const session = await createSession({
  provider: { type: 'openai', apiKey: process.env.OPENAI_API_KEY },
  model: 'gpt-4o',
  mcpServers: {
    github: {
      type: 'stdio',
      command: 'npx',
      args: ['-y', '@modelcontextprotocol/server-github'],
      disabled: true,  // 先不连接
    },
  },
});

// 需要时手动连接
await session.mcpConnect('github');

// 查看状态
const status = await session.mcpServerStatus();
console.log(status);

// 列出所有可用 MCP 工具
const tools = await session.mcpListTools();
console.log(`共 ${tools.length} 个 MCP 工具`);

// 用完断开
await session.mcpDisconnect('github');
```
