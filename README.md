# Blade Agent SDK

面向 Node.js 与 TypeScript 的多轮会话 Agent SDK，提供标准的 send/stream 会话模式、工具调用、会话恢复、文件检查点、沙箱执行与自动清理。

## 特性

- 🔄 **多轮会话** - send/stream 模式，支持流式输出
- 🔧 **工具调用** - 内置文件、命令行、MCP 等工具
- 💾 **会话管理** - 恢复、分叉会话
- 📁 **文件检查点** - 追踪文件变更，支持回滚
- 🔒 **沙箱执行** - OS 级别安全隔离
- 🔌 **MCP 集成** - 支持 Model Context Protocol
- 🪝 **Hooks 系统** - 生命周期钩子，自定义行为
- 🎯 **结构化输出** - 支持 JSON Schema 输出格式
- 🤖 **自定义 Agent** - 定义专用子 Agent

## 安装

```bash
npm install @blade-ai/agent-sdk
# 或
pnpm add @blade-ai/agent-sdk
```

## 快速开始

```typescript
import { createSession } from '@blade-ai/agent-sdk';

const session = await createSession({
  provider: { type: 'openai-compatible', apiKey: process.env.API_KEY },
  model: 'gpt-4o-mini',
});

await session.send('你好，你能帮我做什么？');
for await (const msg of session.stream()) {
  if (msg.type === 'content') {
    process.stdout.write(msg.delta);
  }
}

session.close();
```

## 核心概念

### Send/Stream 模式

Blade Agent SDK 使用 send/stream 分离模式：

```typescript
// 1. 发送消息（非阻塞）
await session.send('分析这段代码');

// 2. 流式接收响应
for await (const msg of session.stream()) {
  switch (msg.type) {
    case 'content':
      process.stdout.write(msg.delta);
      break;
    case 'tool_use':
      console.log(`调用工具: ${msg.name}`);
      break;
    case 'tool_result':
      console.log(`工具结果: ${msg.output}`);
      break;
    case 'result':
      console.log('完成:', msg.subtype);
      break;
  }
}
```

### 一次性 prompt

```typescript
import { prompt } from '@blade-ai/agent-sdk';

const result = await prompt('2+2 等于多少？', {
  provider: { type: 'openai-compatible', apiKey: process.env.API_KEY },
  model: 'gpt-4o-mini',
});

console.log(result.result);       // 响应内容
console.log(result.usage);        // Token 使用
console.log(result.duration);     // 耗时（毫秒）
```

### 恢复会话

```typescript
import { resumeSession } from '@blade-ai/agent-sdk';

const session = await resumeSession({
  sessionId: 'existing-session-id',
  provider: { type: 'openai-compatible', apiKey: process.env.API_KEY },
  model: 'gpt-4o-mini',
});

await session.send('继续上次的话题');
```

### 分叉会话

从现有会话创建分支，保留历史但独立演进：

```typescript
import { forkSession } from '@blade-ai/agent-sdk';

// 方式1: 从 Session 实例分叉
const forkedSession = await session.fork();

// 方式2: 从特定消息点分叉
const forkedSession2 = await session.fork({ messageId: 'msg-uuid-123' });

// 方式3: 从已存储的会话 ID 分叉
const forkedSession3 = await forkSession({
  sessionId: 'existing-session-id',
  messageId: 'msg-uuid-456',
  provider: { type: 'openai-compatible', apiKey: process.env.API_KEY },
  model: 'gpt-4o-mini',
});
```

### 自动清理

TypeScript 5.2+ 支持 `using` 自动清理：

```typescript
await using session = await createSession({ provider, model });
// 作用域结束时自动关闭会话
```

## 文件检查点

启用文件检查点功能，追踪 Agent 对文件的修改，支持回滚：

```typescript
const session = await createSession({
  provider: { type: 'openai-compatible', apiKey: process.env.API_KEY },
  model: 'gpt-4o-mini',
  enableFileCheckpointing: true,
});

// Agent 执行文件操作
await session.send('请帮我重构 src/utils.ts 文件');

// 不满意时回滚到指定消息点
const result = await session.rewindFiles('user-message-uuid');
if (result.success) {
  console.log('已恢复文件:', result.restoredFiles);
  console.log('已删除文件:', result.deletedFiles);
}

// 查看检查点统计
const stats = session.getCheckpointStatistics();
console.log('检查点数量:', stats?.checkpointCount);
```

## 沙箱执行

启用沙箱功能，在安全隔离环境中执行命令：

```typescript
const session = await createSession({
  provider: { type: 'openai-compatible', apiKey: process.env.API_KEY },
  model: 'gpt-4o-mini',
  sandbox: {
    enabled: true,
    autoAllowBashIfSandboxed: true,
    allowUnsandboxedCommands: ['git', 'npm'],
    network: {
      allowLocalBinding: true,
    },
  },
});
```

**支持的沙箱技术：**
- **Linux**: Bubblewrap (bwrap)
- **macOS**: Seatbelt (sandbox-exec)

## MCP 集成

连接 MCP (Model Context Protocol) 服务器：

```typescript
const session = await createSession({
  provider: { type: 'openai-compatible', apiKey: process.env.API_KEY },
  model: 'gpt-4o-mini',
  mcpServers: {
    filesystem: {
      type: 'stdio',
      command: 'npx',
      args: ['-y', '@anthropic-ai/mcp-server-filesystem', '/path/to/workspace'],
    },
    github: {
      type: 'stdio',
      command: 'npx',
      args: ['-y', '@anthropic-ai/mcp-server-github'],
      env: { GITHUB_TOKEN: process.env.GITHUB_TOKEN },
    },
  },
});

// 查看 MCP 服务器状态
const status = await session.mcpServerStatus();

// 列出可用的 MCP 工具
const tools = await session.mcpListTools();
```

## 权限控制

使用 `canUseTool` 回调控制工具权限：

```typescript
const session = await createSession({
  provider: { type: 'openai-compatible', apiKey: process.env.API_KEY },
  model: 'gpt-4o-mini',
  canUseTool: async (toolName, input, options) => {
    // 只读工具自动批准
    if (options.toolKind === 'readonly') {
      return { behavior: 'allow' };
    }
    
    // 危险命令拒绝
    if (toolName === 'Bash' && input.command?.includes('rm -rf')) {
      return { behavior: 'deny', message: '禁止危险命令' };
    }
    
    // 其他情况询问用户
    return { behavior: 'ask' };
  },
});
```

## Hooks 系统

在 Agent 生命周期的特定点注入自定义逻辑：

```typescript
const session = await createSession({
  provider: { type: 'openai-compatible', apiKey: process.env.API_KEY },
  model: 'gpt-4o-mini',
  hooks: {
    enabled: true,
    PreToolUse: [
      {
        matcher: 'Bash',
        hooks: [
          {
            type: 'command',
            command: './scripts/validate-bash.sh',
            timeout: 10,
          },
        ],
      },
    ],
  },
});
```

## 自定义工具

```typescript
import { z } from 'zod';

const customTool = {
  name: 'MyTool',
  description: '自定义工具',
  inputSchema: z.object({
    query: z.string().describe('要处理的查询')
  }),
  execute: async (input, context) => {
    return `处理结果: ${input.query}`;
  }
};

const session = await createSession({
  provider: { type: 'openai-compatible', apiKey: process.env.API_KEY },
  model: 'gpt-4o-mini',
  tools: [customTool],
});
```

## 自定义 Agent

```typescript
const searchAgent = {
  name: 'search',
  description: '搜索代码库中的信息',
  systemPrompt: '你是一个代码搜索专家',
  tools: ['Read', 'Grep', 'Glob'],
};

const session = await createSession({
  provider: { type: 'openai-compatible', apiKey: process.env.API_KEY },
  model: 'gpt-4o-mini',
  agents: [searchAgent],
});
```

## 结构化输出

```typescript
import { z } from 'zod';

const session = await createSession({
  provider: { type: 'openai-compatible', apiKey: process.env.API_KEY },
  model: 'gpt-4o-mini',
  outputFormat: {
    type: 'json_schema',
    schema: z.object({
      summary: z.string(),
      confidence: z.number().min(0).max(1),
    }),
    name: 'AnalysisResult',
    strict: true,
  },
});
```

## 主要类型

```typescript
import type {
  ISession,
  SessionOptions,
  StreamMessage,
  PromptResult,
  ForkOptions,
  ForkSessionOptions,
  RewindResult,
  SandboxSettings,
  McpServerConfig,
  ToolDefinition,
  AgentDefinition,
} from '@blade-ai/agent-sdk';
```

## 文档

- [API 参考](./docs/blade-agent-sdk.md) - 完整 API 文档
- [会话管理](./docs/session.md) - 会话 API 完整指南
- [文件检查点](./docs/checkpoint.md) - 文件变更追踪与回滚
- [沙箱功能](./docs/sandbox.md) - 安全隔离执行
- [MCP 集成](./docs/mcp.md) - Model Context Protocol 集成
- [Hooks 系统](./docs/hooks.md) - 生命周期钩子详解

## 运行环境

- Node.js >= 20
- TypeScript >= 5.2（可选，用于 `using` 自动清理）
- Linux: Bubblewrap（可选，用于沙箱）
- macOS: 内置 Seatbelt 支持

## 许可证

MIT
