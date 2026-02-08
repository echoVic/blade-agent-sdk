# Blade Agent SDK

Blade Agent SDK 是一个面向 Node.js 与 TypeScript 的多轮会话 Agent SDK，提供标准的 send/stream 会话模式、工具调用、会话恢复、文件检查点、沙箱执行与自动清理。

## 安装

```bash
npm install @blade-ai/agent-sdk
```

## 快速开始

```typescript
import { createSession } from '@blade-ai/agent-sdk';

const session = await createSession({
  provider: {
    type: 'openai-compatible',
    apiKey: process.env.API_KEY
  },
  model: 'gpt-4o-mini'
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

1. **send()** - 提交消息给 Agent（非阻塞）
2. **stream()** - 以异步迭代器形式接收响应

```typescript
await session.send('分析这段代码');
for await (const msg of session.stream()) {
  switch (msg.type) {
    case 'content':
      process.stdout.write(msg.delta);
      break;
    case 'tool_use':
      console.log(`工具: ${msg.name}`);
      break;
    case 'result':
      console.log('完成:', msg.content);
      break;
  }
}
```

### 会话生命周期

会话支持 TypeScript 5.2+ 的 `using` 语法自动清理：

```typescript
await using session = await createSession({ provider, model });
// 作用域结束时自动关闭会话
```

旧版 TypeScript：

```typescript
const session = await createSession({ provider, model });
try {
  // 使用会话
} finally {
  session.close();
}
```

## API 参考

### `createSession`

创建新会话。

```typescript
function createSession(options: SessionOptions): Promise<ISession>
```

**示例：**

```typescript
const session = await createSession({
  provider: {
    type: 'openai-compatible',
    apiKey: process.env.API_KEY,
    baseUrl: 'https://api.openai.com/v1'
  },
  model: 'gpt-4o-mini',
  systemPrompt: '你是一个有帮助的助手',
  maxTurns: 200
});
```

### `prompt`

一次性 prompt 函数，用于简单交互。

```typescript
function prompt(
  message: string,
  options: SessionOptions
): Promise<PromptResult>
```

**示例：**

```typescript
import { prompt } from '@blade-ai/agent-sdk';

const result = await prompt('2+2 等于多少？', {
  provider: { type: 'openai-compatible', apiKey: 'xxx' },
  model: 'gpt-4o-mini'
});

console.log(result.result);      // 响应内容
console.log(result.usage);       // Token 使用
console.log(result.duration);    // 耗时（毫秒）
```

### `resumeSession`

从存储的历史记录恢复会话。

```typescript
function resumeSession(options: ResumeOptions): Promise<ISession>
```

**示例：**

```typescript
import { resumeSession } from '@blade-ai/agent-sdk';

const session = await resumeSession({
  sessionId: 'existing-session-id',
  provider: { type: 'openai-compatible', apiKey: 'xxx' },
  model: 'gpt-4o-mini'
});
```

### `forkSession`

从现有会话的特定消息点创建新会话。

```typescript
function forkSession(options: ForkOptions): Promise<ISession>
```

**示例：**

```typescript
import { forkSession } from '@blade-ai/agent-sdk';

const forkedSession = await forkSession({
  sessionId: 'existing-session-id',
  messageId: 'msg-uuid-123',  // 可选：从特定消息分叉
  provider: { type: 'openai-compatible', apiKey: 'xxx' },
  model: 'gpt-4o-mini'
});
```

## 配置类型

### `SessionOptions`

创建会话的配置。

```typescript
interface SessionOptions {
  provider: ProviderConfig;
  model: string;
  systemPrompt?: string;
  maxTurns?: number;
  cwd?: string;
  permissionMode?: PermissionMode;
  allowedTools?: string[];
  disallowedTools?: string[];
  tools?: ToolDefinition[];
  agents?: AgentDefinition[];
  mcpServers?: Record<string, McpServerConfig>;
  canUseTool?: CanUseTool;
  hooks?: HookConfig;
  sandbox?: SandboxSettings;
  enableFileCheckpointing?: boolean;
  outputFormat?: OutputFormat;
  env?: Record<string, string>;
}
```

| 字段 | 类型 | 默认值 | 描述 |
|:-----|:-----|:-------|:-----|
| `provider` | `ProviderConfig` | 必需 | 模型提供者配置 |
| `model` | `string` | 必需 | 模型名称 |
| `systemPrompt` | `string` | - | 系统提示词 |
| `maxTurns` | `number` | `200` | 最大对话轮数 |
| `cwd` | `string` | `process.cwd()` | 工作目录 |
| `permissionMode` | `PermissionMode` | `'default'` | 权限模式 |
| `allowedTools` | `string[]` | - | 允许的工具白名单 |
| `disallowedTools` | `string[]` | - | 禁用的工具黑名单 |
| `tools` | `ToolDefinition[]` | - | 自定义工具定义 |
| `agents` | `AgentDefinition[]` | - | 自定义 Agent 定义 |
| `mcpServers` | `Record<string, McpServerConfig>` | - | MCP 服务器配置 |
| `canUseTool` | `CanUseTool` | - | 自定义权限回调 |
| `hooks` | `HookConfig` | - | Hook 配置 |
| `sandbox` | `SandboxSettings` | - | 沙箱设置 |
| `enableFileCheckpointing` | `boolean` | `false` | 启用文件变更追踪 |
| `outputFormat` | `OutputFormat` | - | 结构化输出格式 |
| `env` | `Record<string, string>` | - | 环境变量 |

### `ProviderConfig`

模型提供者配置。

```typescript
type ProviderConfig =
  | OpenAICompatibleConfig
  | AnthropicConfig
  | GeminiConfig
  | AzureOpenAIConfig;
```

#### `OpenAICompatibleConfig`

```typescript
interface OpenAICompatibleConfig {
  type: 'openai-compatible';
  apiKey: string;
  baseUrl?: string;
}
```

#### `AnthropicConfig`

```typescript
interface AnthropicConfig {
  type: 'anthropic';
  apiKey: string;
}
```

#### `GeminiConfig`

```typescript
interface GeminiConfig {
  type: 'gemini';
  apiKey: string;
}
```

#### `AzureOpenAIConfig`

```typescript
interface AzureOpenAIConfig {
  type: 'azure-openai';
  apiKey: string;
  baseUrl: string;
  apiVersion?: string;
}
```

### `PermissionMode`

```typescript
type PermissionMode =
  | 'default'           // 标准权限行为
  | 'acceptEdits'       // 自动接受文件编辑
  | 'bypassPermissions' // 跳过所有权限检查
  | 'plan';             // 计划模式 - 不执行
```

### `ResumeOptions`

恢复会话的选项。

```typescript
interface ResumeOptions extends SessionOptions {
  sessionId: string;
}
```

### `ForkOptions`

分叉会话的选项。

```typescript
interface ForkOptions extends ResumeOptions {
  messageId?: string;
  copyCheckpoints?: boolean;
}
```

| 字段 | 类型 | 描述 |
|:-----|:-----|:-----|
| `sessionId` | `string` | 源会话 ID |
| `messageId` | `string` | 可选的分叉消息 ID |
| `copyCheckpoints` | `boolean` | 是否复制文件检查点 |

### `ForkSessionOptions`

`session.fork()` 方法的选项。

```typescript
interface ForkSessionOptions {
  messageId?: string;
  copyCheckpoints?: boolean;
}
```

### `SendOptions`

发送消息的选项。

```typescript
interface SendOptions {
  signal?: AbortSignal;
  maxTurns?: number;
}
```

### `StreamOptions`

流式响应的选项。

```typescript
interface StreamOptions {
  includeThinking?: boolean;
}
```

## 消息类型

### `StreamMessage`

所有可能的流消息的联合类型。

```typescript
type StreamMessage =
  | TurnStartMessage
  | TurnEndMessage
  | ContentMessage
  | ThinkingMessage
  | ToolUseMessage
  | ToolResultMessage
  | UsageMessage
  | ResultMessage
  | ErrorMessage;
```

### `TurnStartMessage`

```typescript
interface TurnStartMessage {
  type: 'turn_start';
  turn: number;
  sessionId: string;
}
```

### `TurnEndMessage`

```typescript
interface TurnEndMessage {
  type: 'turn_end';
  turn: number;
}
```

### `ContentMessage`

```typescript
interface ContentMessage {
  type: 'content';
  delta: string;
}
```

### `ThinkingMessage`

```typescript
interface ThinkingMessage {
  type: 'thinking';
  delta: string;
}
```

### `ToolUseMessage`

```typescript
interface ToolUseMessage {
  type: 'tool_use';
  id: string;
  name: string;
  input: unknown;
}
```

### `ToolResultMessage`

```typescript
interface ToolResultMessage {
  type: 'tool_result';
  id: string;
  name: string;
  output: string;
  isError?: boolean;
}
```

### `UsageMessage`

```typescript
interface UsageMessage {
  type: 'usage';
  usage: TokenUsage;
}
```

### `ResultMessage`

```typescript
interface ResultMessage {
  type: 'result';
  subtype: 'success' | 'error' | 'max_turns' | 'aborted';
  content?: string;
  error?: string;
}
```

### `ErrorMessage`

```typescript
interface ErrorMessage {
  type: 'error';
  message: string;
  code?: string;
}
```

### `TokenUsage`

```typescript
interface TokenUsage {
  inputTokens: number;
  outputTokens: number;
  totalTokens: number;
  cacheReadTokens?: number;
  cacheWriteTokens?: number;
}
```

### `PromptResult`

`prompt()` 函数的返回结果。

```typescript
interface PromptResult {
  result: string;
  toolCalls: ToolCallRecord[];
  usage: TokenUsage;
  duration: number;
  turnsCount: number;
}
```

## ISession 接口

主会话接口。

```typescript
interface ISession extends AsyncDisposable {
  readonly sessionId: string;
  readonly messages: Message[];

  send(message: string, options?: SendOptions): Promise<void>;
  stream(options?: StreamOptions): AsyncGenerator<StreamMessage>;

  close(): void;
  abort(): void;

  setPermissionMode(mode: PermissionMode): void;
  setModel(model: string): Promise<void>;
  setMaxTurns(maxTurns: number): void;

  supportedCommands(): Promise<SlashCommand[]>;
  supportedModels(): Promise<ModelInfo[]>;

  mcpServerStatus(): Promise<McpServerStatus[]>;
  mcpConnect(serverName: string): Promise<void>;
  mcpDisconnect(serverName: string): Promise<void>;
  mcpReconnect(serverName: string): Promise<void>;
  mcpListTools(): Promise<McpToolInfo[]>;

  fork(options?: ForkSessionOptions): Promise<ISession>;
  rewindFiles(messageUuid: string): Promise<RewindResult>;
  getCheckpointStatistics(): CheckpointStatistics | null;
}
```

### 会话方法

#### `send`

发送消息给 Agent。

```typescript
await session.send('你好', { signal: abortController.signal });
```

#### `stream`

返回异步迭代器接收响应。

```typescript
for await (const msg of session.stream({ includeThinking: true })) {
  // 处理消息
}
```

#### `close`

关闭会话并释放资源。

```typescript
session.close();
```

#### `abort`

中断当前操作。

```typescript
session.abort();
```

#### `fork`

从当前会话创建新会话。

```typescript
const forked = await session.fork({ messageId: 'msg-uuid' });
```

#### `rewindFiles`

将文件恢复到特定消息检查点的状态。

```typescript
const result = await session.rewindFiles('user-message-uuid');
```

#### `getCheckpointStatistics`

返回文件检查点统计信息。

```typescript
const stats = session.getCheckpointStatistics();
// { checkpointCount, trackedFileCount, pendingChangeCount }
```

## MCP 配置

### `McpServerConfig`

MCP 服务器配置。

```typescript
type McpServerConfig =
  | McpStdioServerConfig
  | McpSSEServerConfig
  | McpHttpServerConfig;
```

#### `McpStdioServerConfig`

```typescript
interface McpStdioServerConfig {
  type?: 'stdio';
  command: string;
  args?: string[];
  env?: Record<string, string>;
  cwd?: string;
}
```

#### `McpSSEServerConfig`

```typescript
interface McpSSEServerConfig {
  type: 'sse';
  url: string;
  headers?: Record<string, string>;
}
```

#### `McpHttpServerConfig`

```typescript
interface McpHttpServerConfig {
  type: 'http';
  url: string;
  headers?: Record<string, string>;
}
```

**示例：**

```typescript
const session = await createSession({
  provider: { type: 'openai-compatible', apiKey: 'xxx' },
  model: 'gpt-4o-mini',
  mcpServers: {
    filesystem: {
      type: 'stdio',
      command: 'npx',
      args: ['-y', '@anthropic-ai/mcp-server-filesystem', '/path']
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

### `McpToolInfo`

```typescript
interface McpToolInfo {
  name: string;
  description: string;
  serverName: string;
}
```

## 沙箱配置

### `SandboxSettings`

沙箱执行配置。

```typescript
interface SandboxSettings {
  enabled?: boolean;
  autoAllowBashIfSandboxed?: boolean;
  allowUnsandboxedCommands?: string[];
  excludedCommands?: string[];
  network?: NetworkSettings;
  ignoreFileViolations?: string[];
  ignoreNetworkViolations?: string[];
}
```

| 字段 | 类型 | 默认值 | 描述 |
|:-----|:-----|:-------|:-----|
| `enabled` | `boolean` | `false` | 启用沙箱执行 |
| `autoAllowBashIfSandboxed` | `boolean` | `false` | 沙箱内自动批准 Bash |
| `allowUnsandboxedCommands` | `string[]` | `[]` | 允许非沙箱执行的命令 |
| `excludedCommands` | `string[]` | `[]` | 排除沙箱的命令 |
| `network` | `NetworkSettings` | - | 网络访问设置 |
| `ignoreFileViolations` | `string[]` | `[]` | 忽略的文件访问违规 |
| `ignoreNetworkViolations` | `string[]` | `[]` | 忽略的网络违规 |

### `NetworkSettings`

```typescript
interface NetworkSettings {
  allowLocalBinding?: boolean;
  allowAllUnixSockets?: boolean;
  allowedUnixSockets?: string[];
}
```

**示例：**

```typescript
const session = await createSession({
  provider: { type: 'openai-compatible', apiKey: 'xxx' },
  model: 'gpt-4o-mini',
  sandbox: {
    enabled: true,
    autoAllowBashIfSandboxed: true,
    allowUnsandboxedCommands: ['git', 'npm'],
    network: {
      allowLocalBinding: true
    }
  }
});
```

## 文件检查点

### 启用检查点

```typescript
const session = await createSession({
  provider: { type: 'openai-compatible', apiKey: 'xxx' },
  model: 'gpt-4o-mini',
  enableFileCheckpointing: true
});
```

### `RewindResult`

文件回滚操作的结果。

```typescript
interface RewindResult {
  success: boolean;
  restoredFiles: string[];
  deletedFiles: string[];
  errors: RewindError[];
}
```

### `RewindError`

```typescript
interface RewindError {
  filePath: string;
  error: string;
}
```

### `FileSnapshot`

```typescript
interface FileSnapshot {
  filePath: string;
  content: string | null;
  exists: boolean;
  timestamp: Date;
}
```

### `FileChange`

```typescript
interface FileChange {
  filePath: string;
  operation: 'create' | 'modify' | 'delete';
  beforeSnapshot: FileSnapshot | null;
  afterSnapshot: FileSnapshot;
  timestamp: Date;
}
```

### `MessageCheckpoint`

```typescript
interface MessageCheckpoint {
  messageUuid: string;
  messageRole: 'user' | 'assistant';
  timestamp: Date;
  fileChanges: FileChange[];
  fileSnapshots: Map<string, FileSnapshot>;
}
```

**示例：**

```typescript
// 启用检查点
const session = await createSession({
  enableFileCheckpointing: true,
  // ...
});

// Agent 修改文件
await session.send('重构 src/utils.ts');
for await (const msg of session.stream()) {
  // ...
}

// 需要时回滚
const result = await session.rewindFiles('user-message-uuid');
if (result.success) {
  console.log('已恢复:', result.restoredFiles);
  console.log('已删除:', result.deletedFiles);
}

// 查看统计
const stats = session.getCheckpointStatistics();
console.log('检查点数:', stats?.checkpointCount);
```

## 权限控制

### `CanUseTool`

自定义权限回调类型。

```typescript
type CanUseTool = (
  toolName: string,
  input: unknown,
  options: {
    signal: AbortSignal;
    toolKind?: 'readonly' | 'write' | 'execute';
  }
) => Promise<PermissionResult>;
```

### `PermissionResult`

```typescript
type PermissionResult =
  | { behavior: 'allow' }
  | { behavior: 'deny'; message: string }
  | { behavior: 'ask' };
```

**示例：**

```typescript
const session = await createSession({
  provider: { type: 'openai-compatible', apiKey: 'xxx' },
  model: 'gpt-4o-mini',
  canUseTool: async (toolName, input, options) => {
    // 自动允许只读工具
    if (options.toolKind === 'readonly') {
      return { behavior: 'allow' };
    }
    
    // 拒绝危险命令
    if (toolName === 'Bash' && input.command?.includes('rm -rf')) {
      return { behavior: 'deny', message: '危险命令已阻止' };
    }
    
    // 其他情况询问
    return { behavior: 'ask' };
  }
});
```

## Hook 类型

关于使用 Hooks 的完整指南，请参阅 [Hooks 指南](./hooks.md)。

### `HookEvent`

可用的 Hook 事件。

```typescript
type HookEvent =
  | 'PreToolUse'
  | 'PostToolUse'
  | 'PostToolUseFailure'
  | 'Notification'
  | 'UserPromptSubmit'
  | 'SessionStart'
  | 'SessionEnd'
  | 'Stop'
  | 'SubagentStart'
  | 'SubagentStop'
  | 'Compaction'
  | 'PermissionRequest'
  | 'TaskCompleted';
```

### `HookCallback`

```typescript
type HookCallback = (
  input: HookInput,
  options: { signal: AbortSignal }
) => Promise<HookOutput>;
```

### `HookConfig`

```typescript
interface HookConfig {
  enabled?: boolean;
  defaultTimeout?: number;
  timeoutBehavior?: 'ignore' | 'error';
  failureBehavior?: 'ignore' | 'error';
  [event: HookEvent]?: HookCallbackMatcher[];
}
```

**示例：**

```typescript
const session = await createSession({
  provider: { type: 'openai-compatible', apiKey: 'xxx' },
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
            timeout: 10
          }
        ]
      }
    ]
  }
});
```

## 工具类型

### 自定义工具定义

```typescript
interface ToolDefinition {
  name: string;
  description: string;
  inputSchema: z.ZodType;
  execute: (input: unknown, context: ToolExecutionContext) => Promise<string>;
}
```

**示例：**

```typescript
import { z } from 'zod';

const customTool: ToolDefinition = {
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
  provider: { type: 'openai-compatible', apiKey: 'xxx' },
  model: 'gpt-4o-mini',
  tools: [customTool]
});
```

### `ToolExecutionContext`

```typescript
interface ToolExecutionContext {
  sessionId: string;
  cwd: string;
  signal: AbortSignal;
  env: Record<string, string>;
}
```

### `ToolCallRecord`

```typescript
interface ToolCallRecord {
  name: string;
  input: unknown;
  output: string;
  duration: number;
  isError: boolean;
}
```

## Agent 类型

### 自定义 Agent 定义

```typescript
interface AgentDefinition {
  name: string;
  description: string;
  systemPrompt?: string;
  model?: string;
  tools?: string[];
}
```

**示例：**

```typescript
const searchAgent: AgentDefinition = {
  name: 'search',
  description: '搜索代码库中的信息',
  systemPrompt: '你是一个代码搜索专家',
  tools: ['Read', 'Grep', 'Glob']
};

const session = await createSession({
  provider: { type: 'openai-compatible', apiKey: 'xxx' },
  model: 'gpt-4o-mini',
  agents: [searchAgent]
});
```

## 输出格式

### `OutputFormat`

结构化输出配置。

```typescript
interface OutputFormat {
  type: 'json_schema';
  schema: z.ZodType;
  name?: string;
  strict?: boolean;
}
```

**示例：**

```typescript
import { z } from 'zod';

const session = await createSession({
  provider: { type: 'openai-compatible', apiKey: 'xxx' },
  model: 'gpt-4o-mini',
  outputFormat: {
    type: 'json_schema',
    schema: z.object({
      summary: z.string(),
      confidence: z.number().min(0).max(1)
    }),
    name: 'AnalysisResult',
    strict: true
  }
});
```

## 错误处理

### 常见错误类型

```typescript
// 会话错误
class SessionError extends Error {
  code: string;
}

// 工具错误
class ToolError extends Error {
  toolName: string;
  input: unknown;
}

// MCP 错误
class McpError extends Error {
  serverName: string;
  errorType: McpErrorType;
}
```

### 错误处理示例

```typescript
try {
  await session.send('执行某操作');
  for await (const msg of session.stream()) {
    if (msg.type === 'error') {
      console.error('流错误:', msg.message);
    }
  }
} catch (error) {
  if (error instanceof SessionError) {
    console.error('会话错误:', error.code, error.message);
  }
}
```

## 最佳实践

1. **使用自动清理** - TypeScript 5.2+ 推荐使用 `await using` 语法
2. **设置合理的 maxTurns** - 防止无限循环
3. **处理错误** - 监控 `error` 类型消息并捕获异常
4. **使用 AbortSignal** - 为长任务提供取消能力
5. **分叉而非修改** - 探索不同方向时使用 `fork()`
6. **启用检查点** - 使用 `enableFileCheckpointing` 保护文件安全
7. **配置沙箱** - 对不信任的代码执行启用沙箱

## 相关文档

- [Hooks 指南](./hooks.md) - 生命周期钩子详解
- [会话管理](./session.md) - 完整会话 API 指南
- [文件检查点](./checkpoint.md) - 文件变更追踪与回滚
- [沙箱执行](./sandbox.md) - 安全隔离执行
- [MCP 集成](./mcp.md) - Model Context Protocol 集成
