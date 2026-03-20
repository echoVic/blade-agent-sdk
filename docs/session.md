# Session

本页介绍 Blade Agent SDK 的核心 Session API。

## 创建会话

```ts
import { createSession } from '@blade-ai/agent-sdk';

const session = await createSession({
  provider: { type: 'openai-compatible', apiKey: process.env.API_KEY },
  model: 'gpt-4o-mini',
});
```

## SessionOptions

```ts
import type { SessionOptions } from '@blade-ai/agent-sdk';

const options: SessionOptions = {
  provider: { type: 'openai-compatible', apiKey: process.env.API_KEY },
  model: 'gpt-4o-mini',
  systemPrompt: 'You are a careful coding agent.',
  maxTurns: 12,
  allowedTools: ['Read', 'Edit', 'Write', 'Bash'],
  disallowedTools: ['KillShell'],
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

| 字段 | 类型 | 说明 |
| --- | --- | --- |
| `provider` | `ProviderConfig` | 模型提供方配置 |
| `model` | `string` | 模型 ID |
| `systemPrompt` | `string` | 会话级系统提示 |
| `maxTurns` | `number` | 最大轮次 |
| `allowedTools` | `string[]` | 仅允许指定工具 |
| `disallowedTools` | `string[]` | 禁用指定工具 |
| `tools` | `ToolDefinition[]` | 追加自定义工具 |
| `mcpServers` | `Record<string, McpServerConfig \| SdkMcpServerHandle>` | MCP server 配置 |
| `permissionMode` | `PermissionMode` | 默认权限模式 |
| `canUseTool` | `CanUseTool` | 运行时权限决策 |
| `hooks` | `Partial<Record<SessionHookEvent, HookCallback[]>>` | 回调式 hooks |
| `cwd` | `string` | 工作目录 |
| `env` | `Record<string, string>` | 传递给工具执行的环境变量 |
| `logger` | `AgentLogger` | 结构化日志接入 |
| `persistSession` | `boolean` | 是否启用磁盘会话持久化，默认 `true` |
| `outputFormat` | `OutputFormat` | JSON Schema 结构化输出 |
| `sandbox` | `SandboxSettings` | 命令执行沙箱配置 |
| `agents` | `Record<string, AgentDefinition>` | 命名子代理定义 |

如果你在 Web / Serverless 场景下不希望 SDK 写入 `~/.blade/sessions`，可以关闭持久化：

```ts
const session = await createSession({
  provider: { type: 'openai-compatible', apiKey: process.env.API_KEY },
  model: 'gpt-4o-mini',
  persistSession: false,
});
```

说明：

- `persistSession: false` 时，不会写入磁盘 session 文件
- 此时 `resumeSession()` 和 `forkSession({ sessionId })` 不可用
- 如果只是想在当前进程里复制会话上下文，仍可使用 `session.fork()`

## 持久化模式

Blade Agent SDK 默认启用磁盘持久化。这种模式适合 CLI、IDE、本地桌面应用，或者需要恢复历史会话的服务端进程。

默认行为：

- session 历史会写入本地存储
- 可以通过 `resumeSession()` 恢复已有会话
- 可以通过 `forkSession({ sessionId })` 从历史会话分叉

如果你传入了 `storagePath`，session 会写到该路径下的 `sessions/` 目录；否则默认使用 `~/.blade/sessions`。

## 无状态模式

对 Web API、Serverless、浏览器中转层这类场景，更常见的诉求是“当前请求里能跑，但不要依赖本地文件系统”。这时推荐显式关闭持久化：

```ts
const session = await createSession({
  provider: { type: 'openai-compatible', apiKey: process.env.API_KEY },
  model: 'gpt-4o-mini',
  persistSession: false,
});
```

这一模式下：

- session 只保存在当前进程内存中
- 同一个 `session` 实例仍然支持多轮 `send()` / `stream()`
- SDK 不会创建或写入 `~/.blade/sessions`
- `resumeSession()` 不可用，因为没有可恢复的磁盘历史
- `forkSession({ sessionId })` 不可用，因为它依赖已持久化的 session
- `session.fork()` 仍然可用，因为它只复制当前实例内存中的消息

如果你的 Web 应用需要跨请求恢复对话，建议由你的业务层自行保存消息历史，再在新请求中重新构造会话上下文，而不是依赖本地 session 文件。

## send / stream

`send()` 只提交消息，`stream()` 负责消费这次消息对应的 Agent 输出。

```ts
await session.send('分析最近两次提交对会话持久化的影响');

for await (const msg of session.stream({ includeThinking: true })) {
  switch (msg.type) {
    case 'turn_start':
      console.log(`turn ${msg.turn}`);
      break;
    case 'content':
      process.stdout.write(msg.delta);
      break;
    case 'tool_use':
      console.log(`[tool] ${msg.name}`);
      break;
    case 'tool_result':
      console.log(`[tool-result] ${msg.name}`);
      break;
    case 'usage':
      console.log(msg.usage);
      break;
    case 'result':
      console.log(msg.subtype, msg.content);
      break;
  }
}
```

约束：

- 调 `stream()` 之前必须先调 `send()`
- 一条 pending message 只能被消费一次
- 如果上一条消息还没 `stream()` 完成，不能再次 `send()`

## prompt

`prompt()` 适合一次性请求，不保留长期会话对象。

```ts
import { prompt } from '@blade-ai/agent-sdk';

const result = await prompt('给我一份这个仓库的公开 API 摘要', {
  provider: { type: 'openai-compatible', apiKey: process.env.API_KEY },
  model: 'gpt-4o-mini',
});

console.log(result.result);
console.log(result.toolCalls);
console.log(result.turnsCount);
```

## 恢复和分叉

### 恢复

```ts
import { resumeSession } from '@blade-ai/agent-sdk';

const session = await resumeSession({
  sessionId: 'existing-session-id',
  provider: { type: 'openai-compatible', apiKey: process.env.API_KEY },
  model: 'gpt-4o-mini',
});
```

### 分叉

```ts
import { forkSession } from '@blade-ai/agent-sdk';

const forked = await forkSession({
  sessionId: 'existing-session-id',
  messageId: 'msg-123',
  provider: { type: 'openai-compatible', apiKey: process.env.API_KEY },
  model: 'gpt-4o-mini',
});
```

也可以从实例调用：

```ts
const forked = await session.fork({ messageId: 'msg-123' });
```

注意：

- `resumeSession()` 和 `forkSession()` 面向“已持久化到磁盘的会话”
- `session.fork()` 面向“当前进程里还活着的会话实例”

## Session 方法

### 生命周期

- `close()`：关闭会话并释放资源
- `abort()`：中止当前执行

### 运行时控制

- `setPermissionMode(mode)`：切换权限模式
- `setModel(model)`：切换后续回合的模型
- `setMaxTurns(maxTurns)`：更新最大轮次
- `supportedModels()`：列出当前 provider 支持的模型

### MCP

- `mcpServerStatus()`
- `mcpConnect(serverName)`
- `mcpDisconnect(serverName)`
- `mcpReconnect(serverName)`
- `mcpListTools()`

## StreamMessage

`stream()` 产生的事件类型：

- `turn_start`
- `turn_end`
- `content`
- `thinking`
- `tool_use`
- `tool_result`
- `usage`
- `result`
- `error`

## 命名子代理

`agents` 用于定义命名子代理，供内置任务类工具或运行时使用：

```ts
import type { AgentDefinition } from '@blade-ai/agent-sdk';

const agents: Record<string, AgentDefinition> = {
  research: {
    name: 'research',
    description: 'Investigate repository structure and summarize findings',
    allowedTools: ['Read', 'Glob', 'Grep'],
    model: 'gpt-4o-mini',
  },
};
```

## 自动清理

如果运行环境支持 `using` / `AsyncDisposable`，可以这样写：

```ts
await using session = await createSession({
  provider: { type: 'openai-compatible', apiKey: process.env.API_KEY },
  model: 'gpt-4o-mini',
});
```
