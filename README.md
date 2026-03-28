# Blade Agent SDK

面向 Node.js 与 TypeScript 的 session-first Agent SDK，提供多轮会话、工具调用、MCP、权限控制、Hooks、沙箱执行和结构化输出。

## 特性

- 多轮会话：`send()` / `stream()` 分离，适合 CLI、IDE 和服务端集成
- 会话持久化：支持 `resumeSession()` 和 `forkSession()`
- 内置工具：文件、搜索、Shell、Web、Todo、Plan、MCP 资源工具
- MCP：支持 stdio、SSE、HTTP 服务器，也支持 in-process MCP server
- 权限控制：`permissionMode` + `canUseTool`
- Hooks：在会话、权限和工具执行阶段注入自定义逻辑
- 沙箱执行：通过 `sandbox` 配置约束命令执行
- 结构化输出：支持 JSON Schema `outputFormat`

## 安装

用于在你的应用中安装已发布到 npm 的包：

```bash
npm install @blade-ai/agent-sdk
```

如果你是要参与本仓库开发，请查看 `CONTRIBUTING.md`。仓库本身的依赖安装、测试和发布脚本使用 `bun`。

## 快速开始

```ts
import { createSession } from '@blade-ai/agent-sdk';

const session = await createSession({
  provider: {
    type: 'openai-compatible',
    apiKey: process.env.API_KEY,
  },
  model: 'gpt-4o-mini',
});

await session.send('分析这个仓库的测试结构');

for await (const msg of session.stream()) {
  if (msg.type === 'content') {
    process.stdout.write(msg.delta);
  }
}

session.close();
```

## 核心模型

Blade Agent SDK 的主入口是 Session：

- `createSession(options)`：创建新会话
- `resumeSession(options)`：恢复已有会话
- `forkSession(options)`：从已有会话线性分叉
- `prompt(message, options)`：一次性请求，内部使用临时会话

### Send / Stream

```ts
await session.send('检查最近的改动是否会影响 MCP 工具刷新');

for await (const msg of session.stream({ includeThinking: true })) {
  switch (msg.type) {
    case 'turn_start':
      console.log(`turn ${msg.turn}`);
      break;
    case 'content':
      process.stdout.write(msg.delta);
      break;
    case 'tool_use':
      console.log(`\n[tool] ${msg.name}`);
      break;
    case 'tool_result':
      console.log(`\n[result] ${msg.name}`);
      break;
    case 'result':
      console.log(`\n[done] ${msg.subtype}`);
      break;
  }
}
```

约束：

- 每次 `stream()` 之前必须先调用一次 `send()`
- 同一时间只能有一个 pending message
- `stream()` 会消费当前 pending message，并把结果写回会话历史

### 一次性 prompt

```ts
import { prompt } from '@blade-ai/agent-sdk';

const result = await prompt('总结这个项目的公开 API', {
  provider: { type: 'openai-compatible', apiKey: process.env.API_KEY },
  model: 'gpt-4o-mini',
});

console.log(result.result);
console.log(result.toolCalls);
console.log(result.usage);
```

### Web / Serverless 场景

如果你在 Web API、Serverless Function 或其他不希望写本地磁盘的环境中使用 SDK，可以关闭 session 持久化：

```ts
import { createSession } from '@blade-ai/agent-sdk';

const session = await createSession({
  provider: { type: 'openai-compatible', apiKey: process.env.API_KEY },
  model: 'gpt-4o-mini',
  persistSession: false,
});

await session.send('帮我总结这段代码的职责');

for await (const event of session.stream()) {
  if (event.type === 'content') {
    process.stdout.write(event.delta);
  }
}
```

这种模式下：

- SDK 不会写入 `~/.blade/sessions`
- 当前进程内的多轮对话仍然可用
- `resumeSession()` 和 `forkSession({ sessionId })` 不可用
- 如果只是复制当前内存中的上下文，可以继续使用 `session.fork()`

### 恢复与分叉

```ts
import { forkSession, resumeSession } from '@blade-ai/agent-sdk';

const session = await resumeSession({
  sessionId: 'existing-session-id',
  provider: { type: 'openai-compatible', apiKey: process.env.API_KEY },
  model: 'gpt-4o-mini',
});

const forked = await forkSession({
  sessionId: 'existing-session-id',
  messageId: 'msg-123',
  provider: { type: 'openai-compatible', apiKey: process.env.API_KEY },
  model: 'gpt-4o-mini',
});
```

## 配置 Session

```ts
import { PermissionMode, type SessionOptions } from '@blade-ai/agent-sdk';

const options: SessionOptions = {
  provider: { type: 'openai-compatible', apiKey: process.env.API_KEY },
  model: 'gpt-4o-mini',
  systemPrompt: 'You are a careful coding agent.',
  maxTurns: 12,
  permissionMode: PermissionMode.DEFAULT,
  allowedTools: ['Read', 'Edit', 'Write', 'Bash'],
  defaultContext: {
    capabilities: {
      filesystem: {
        roots: ['/workspace/project'],
        cwd: '/workspace/project',
      },
    },
    environment: { CI: '1' },
  },
};
```

常用字段：

- `provider` / `model`：模型接入配置
- `systemPrompt`：会话级系统提示
- `allowedTools` / `disallowedTools` / `tools`：工具集控制
- `mcpServers`：MCP server 配置
- `permissionMode` / `canUseTool`：权限控制
- `hooks`：会话/工具/权限阶段回调
- `sandbox`：命令执行沙箱
- `outputFormat`：JSON Schema 结构化输出
- `agents`：命名子代理定义
- `logger`：结构化日志回调
- `persistSession`：是否启用磁盘会话持久化，默认 `true`

如果是 Web 场景，不希望 SDK 写入 `~/.blade/sessions`，可以显式关闭：

```ts
const session = await createSession({
  provider: { type: 'openai-compatible', apiKey: process.env.API_KEY },
  model: 'gpt-4o-mini',
  persistSession: false,
});
```

关闭后仍可正常对话，但 `resumeSession()` 和基于 `sessionId` 的 `forkSession()` 不可用；如需在当前进程内复制上下文，可调用实例方法 `session.fork()`。

## Hooks

当前 `SessionOptions.hooks` 支持这些事件：

- `HookEvent.SessionStart`
- `HookEvent.SessionEnd`
- `HookEvent.UserPromptSubmit`
- `HookEvent.PermissionRequest`
- `HookEvent.PreToolUse`
- `HookEvent.PostToolUse`
- `HookEvent.PostToolUseFailure`
- `HookEvent.TaskCompleted`

```ts
import { createSession, HookEvent } from '@blade-ai/agent-sdk';

const session = await createSession({
  provider: { type: 'openai-compatible', apiKey: process.env.API_KEY },
  model: 'gpt-4o-mini',
  hooks: {
    [HookEvent.PreToolUse]: [
      async (input) => {
        if (input.toolName === 'Bash' && String(input.toolInput).includes('rm -rf')) {
          return { action: 'abort', reason: 'Dangerous command blocked' };
        }
        return { action: 'continue' };
      },
    ],
    [HookEvent.PostToolUse]: [
      async (input) => ({
        action: 'continue',
        modifiedOutput: {
          ...((input.toolOutput as Record<string, unknown>) || {}),
          audited: true,
        },
      }),
    ],
  },
});
```

## 权限控制

```ts
import { createSession, PermissionMode, type CanUseTool } from '@blade-ai/agent-sdk';

const canUseTool: CanUseTool = async (toolName, input, options) => {
  if (options.toolKind === 'readonly') {
    return { behavior: 'allow' };
  }

  if (toolName === 'Bash' && String(input.command || '').includes('rm -rf')) {
    return { behavior: 'deny', message: 'Dangerous command blocked' };
  }

  return { behavior: 'ask' };
};

const session = await createSession({
  provider: { type: 'openai-compatible', apiKey: process.env.API_KEY },
  model: 'gpt-4o-mini',
  permissionMode: PermissionMode.DEFAULT,
  canUseTool,
});
```

## MCP

### 连接外部 MCP 服务器

```ts
const session = await createSession({
  provider: { type: 'openai-compatible', apiKey: process.env.API_KEY },
  model: 'gpt-4o-mini',
  mcpServers: {
    filesystem: {
      type: 'stdio',
      command: 'npx',
      args: ['-y', '@anthropic-ai/mcp-server-filesystem', '/workspace/project'],
    },
  },
});

console.log(await session.mcpServerStatus());
console.log(await session.mcpListTools());
```

### 定义 in-process MCP server

```ts
import { createSdkMcpServer, tool } from '@blade-ai/agent-sdk';
import { z } from 'zod';

const greet = tool(
  'greet',
  'Greet a user by name',
  { name: z.string() },
  async ({ name }) => ({
    content: [{ type: 'text', text: `Hello, ${name}!` }],
  }),
);

const greetServer = await createSdkMcpServer({
  name: 'greetings',
  version: '1.0.0',
  tools: [greet],
});
```

## 沙箱

```ts
const session = await createSession({
  provider: { type: 'openai-compatible', apiKey: process.env.API_KEY },
  model: 'gpt-4o-mini',
  sandbox: {
    enabled: true,
    autoAllowBashIfSandboxed: true,
    excludedCommands: ['sudo'],
    network: {
      allowLocalBinding: true,
    },
  },
});
```

## 自定义工具

```ts
import { defineTool } from '@blade-ai/agent-sdk';

const echoTool = defineTool({
  name: 'Echo',
  description: 'Echoes text back to the model',
  parameters: {
    type: 'object',
    properties: {
      text: { type: 'string', description: 'Text to echo' },
    },
    required: ['text'],
  },
  execute: async (params) => ({
    success: true,
    llmContent: String(params.text),
    displayContent: String(params.text),
  }),
});
```

## 日志

SDK 不自带日志实现。你只需要实现 `AgentLogger` 接口：

```ts
import type { AgentLogger, LogEntry } from '@blade-ai/agent-sdk';

const logger: AgentLogger = {
  log(entry: LogEntry) {
    console.log(entry.level, entry.category, entry.message, entry.args);
  },
};
```

## 文档

- [总览](./docs/blade-agent-sdk.md)
- [Session](./docs/session.md)
- [Hooks](./docs/hooks.md)
- [MCP](./docs/mcp.md)
- [Sandbox](./docs/sandbox.md)

## 社区

- [linux.do](https://linux.do/)
