# MCP 集成

本指南介绍 Blade Agent SDK 的 MCP (Model Context Protocol) 集成功能，允许 Agent 连接外部工具和数据源。

## 概述

MCP 是一个开放协议，使 AI 模型能够与外部工具和数据源交互。Blade Agent SDK 支持连接 MCP 服务器以扩展 Agent 能力：

- **工具扩展** - 通过 MCP 服务器添加自定义工具
- **资源访问** - 访问 MCP 服务器提供的资源
- **多服务器** - 同时连接多个 MCP 服务器
- **动态管理** - 运行时连接/断开服务器

## 配置 MCP 服务器

创建会话时配置 MCP 服务器：

```typescript
import { createSession } from '@blade-ai/agent-sdk';

const session = await createSession({
  provider: { type: 'openai-compatible', apiKey: process.env.API_KEY },
  model: 'gpt-4o-mini',
  mcpServers: {
    filesystem: {
      type: 'stdio',
      command: 'npx',
      args: ['-y', '@anthropic-ai/mcp-server-filesystem', '/path/to/workspace']
    },
    github: {
      type: 'stdio',
      command: 'npx',
      args: ['-y', '@anthropic-ai/mcp-server-github'],
      env: { GITHUB_TOKEN: process.env.GITHUB_TOKEN }
    }
  }
});
```

## 服务器配置类型

### `McpServerConfig`

```typescript
type McpServerConfig =
  | McpStdioServerConfig
  | McpSSEServerConfig
  | McpHttpServerConfig;
```

### `McpStdioServerConfig`

通过标准输入/输出通信：

```typescript
interface McpStdioServerConfig {
  type?: 'stdio';
  command: string;
  args?: string[];
  env?: Record<string, string>;
  cwd?: string;
}
```

| 字段 | 类型 | 描述 |
|:-----|:-----|:-----|
| `type` | `'stdio'` | 服务器类型（可选，默认） |
| `command` | `string` | 执行命令 |
| `args` | `string[]` | 命令参数 |
| `env` | `Record<string, string>` | 环境变量 |
| `cwd` | `string` | 工作目录 |

### `McpSSEServerConfig`

通过 Server-Sent Events 连接：

```typescript
interface McpSSEServerConfig {
  type: 'sse';
  url: string;
  headers?: Record<string, string>;
}
```

| 字段 | 类型 | 描述 |
|:-----|:-----|:-----|
| `type` | `'sse'` | 服务器类型 |
| `url` | `string` | SSE 端点 URL |
| `headers` | `Record<string, string>` | 请求头 |

### `McpHttpServerConfig`

通过 HTTP 请求通信：

```typescript
interface McpHttpServerConfig {
  type: 'http';
  url: string;
  headers?: Record<string, string>;
}
```

| 字段 | 类型 | 描述 |
|:-----|:-----|:-----|
| `type` | `'http'` | 服务器类型 |
| `url` | `string` | HTTP 端点 URL |
| `headers` | `Record<string, string>` | 请求头 |

## 服务器管理

### 查看服务器状态

```typescript
const status = await session.mcpServerStatus();

for (const server of status) {
  console.log(`服务器: ${server.name}`);
  console.log(`状态: ${server.status}`);
  console.log(`工具数: ${server.toolCount}`);
  if (server.error) {
    console.log(`错误: ${server.error}`);
  }
}
```

### 连接/断开服务器

```typescript
// 连接服务器
await session.mcpConnect('filesystem');

// 断开服务器
await session.mcpDisconnect('filesystem');

// 重新连接服务器
await session.mcpReconnect('filesystem');
```

### 列出可用工具

```typescript
const tools = await session.mcpListTools();

for (const tool of tools) {
  console.log(`工具: ${tool.name}`);
  console.log(`描述: ${tool.description}`);
  console.log(`服务器: ${tool.serverName}`);
}
```

## 类型定义

### `McpServerStatus`

```typescript
interface McpServerStatus {
  name: string;
  status: 'connected' | 'disconnected' | 'connecting' | 'error';
  toolCount: number;
  tools?: string[];
  connectedAt?: Date;
  error?: string;
}
```

| 字段 | 类型 | 描述 |
|:-----|:-----|:-----|
| `name` | `string` | 服务器名称 |
| `status` | `string` | 连接状态 |
| `toolCount` | `number` | 可用工具数 |
| `tools` | `string[]` | 工具名称列表 |
| `connectedAt` | `Date` | 连接时间 |
| `error` | `string` | 错误信息（如有） |

### `McpToolInfo`

```typescript
interface McpToolInfo {
  name: string;
  description: string;
  serverName: string;
}
```

## MCP 资源

### 列出资源

使用内置的 `ListMcpResources` 工具：

```typescript
// Agent 可以使用此工具列出 MCP 资源
await session.send('列出可用的 MCP 资源');
```

### 读取资源

使用内置的 `ReadMcpResource` 工具：

```typescript
// Agent 可以使用此工具读取 MCP 资源
await session.send('读取 file:///path/to/file.txt 的内容');
```

## McpRegistry API

### 获取注册表

```typescript
import { McpRegistry } from '@blade-ai/agent-sdk';

const registry = McpRegistry.getInstance();
```

### 注册/注销服务器

```typescript
// 注册服务器
await registry.registerServer('myserver', {
  type: 'stdio',
  command: 'node',
  args: ['server.js']
});

// 注销服务器
await registry.unregisterServer('myserver');
```

### 查询服务器

```typescript
// 获取所有服务器
const servers = registry.getAllServers();

// 获取服务器状态
const serverInfo = registry.getServerStatus('filesystem');

// 获取服务器工具
const tools = registry.getToolsByServer('filesystem');

// 获取统计信息
const stats = registry.getStatistics();
// { totalServers, connectedServers, totalTools }
```

### 断开所有服务器

```typescript
await registry.disconnectAll();
```

## McpClient API

### 创建客户端

```typescript
import { McpClient } from '@blade-ai/agent-sdk';

const client = new McpClient('myserver', {
  type: 'stdio',
  command: 'node',
  args: ['server.js']
});
```

### 连接管理

```typescript
// 连接
await client.connect();

// 断开
await client.disconnect();
```

### 使用工具和资源

```typescript
// 获取可用工具
const tools = client.availableTools;

// 调用工具
const result = await client.callTool('read_file', { path: '/path/to/file' });

// 列出资源
const resources = await client.listResources();

// 读取资源
const content = await client.readResource('file:///path/to/file');
```

## 常用 MCP 服务器

### 文件系统服务器

```typescript
{
  filesystem: {
    type: 'stdio',
    command: 'npx',
    args: ['-y', '@anthropic-ai/mcp-server-filesystem', '/path/to/workspace']
  }
}
```

### GitHub 服务器

```typescript
{
  github: {
    type: 'stdio',
    command: 'npx',
    args: ['-y', '@anthropic-ai/mcp-server-github'],
    env: { GITHUB_TOKEN: process.env.GITHUB_TOKEN }
  }
}
```

### PostgreSQL 服务器

```typescript
{
  postgres: {
    type: 'stdio',
    command: 'npx',
    args: ['-y', '@anthropic-ai/mcp-server-postgres', process.env.DATABASE_URL]
  }
}
```

### Slack 服务器

```typescript
{
  slack: {
    type: 'stdio',
    command: 'npx',
    args: ['-y', '@anthropic-ai/mcp-server-slack'],
    env: { SLACK_BOT_TOKEN: process.env.SLACK_BOT_TOKEN }
  }
}
```

## 完整示例

```typescript
import { createSession } from '@blade-ai/agent-sdk';

async function main() {
  // 创建带 MCP 服务器的会话
  const session = await createSession({
    provider: { type: 'openai-compatible', apiKey: process.env.API_KEY },
    model: 'gpt-4o-mini',
    mcpServers: {
      filesystem: {
        type: 'stdio',
        command: 'npx',
        args: ['-y', '@anthropic-ai/mcp-server-filesystem', process.cwd()]
      }
    }
  });

  // 查看 MCP 服务器状态
  const status = await session.mcpServerStatus();
  console.log('MCP 服务器:', status);

  // 列出可用工具
  const tools = await session.mcpListTools();
  console.log('可用工具:', tools.map(t => t.name));

  // Agent 可以使用 MCP 工具
  await session.send('列出当前目录的文件');
  for await (const msg of session.stream()) {
    if (msg.type === 'content') {
      process.stdout.write(msg.delta);
    }
    if (msg.type === 'tool_use') {
      console.log(`\n调用工具: ${msg.name}`);
    }
  }

  // 断开 MCP 服务器
  await session.mcpDisconnect('filesystem');

  session.close();
}

main();
```

## 错误处理

### 错误类型

```typescript
import { McpErrorType } from '@blade-ai/agent-sdk';

McpErrorType.NETWORK_TEMPORARY   // 临时网络错误
McpErrorType.NETWORK_PERMANENT   // 永久网络错误
McpErrorType.CONFIG_ERROR        // 配置错误
McpErrorType.AUTH_ERROR          // 认证错误
McpErrorType.PROTOCOL_ERROR      // 协议错误
McpErrorType.UNKNOWN             // 未知错误
```

### 处理连接错误

```typescript
try {
  await session.mcpConnect('myserver');
} catch (error) {
  console.error('连接失败:', error.message);
  
  // 检查服务器状态获取详情
  const status = await session.mcpServerStatus();
  const server = status.find(s => s.name === 'myserver');
  if (server?.error) {
    console.error('服务器错误:', server.error);
  }
}
```

## 最佳实践

1. **延迟连接** - 只在需要时连接服务器
2. **错误处理** - 妥善处理连接和调用错误
3. **资源清理** - 会话结束时断开服务器
4. **健康监控** - 对关键服务器启用健康监控
5. **环境变量** - 敏感信息通过环境变量传递
6. **超时配置** - 为长时间操作设置合理超时
