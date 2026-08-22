# Session API

Session 是 SDK 的核心抽象，封装了与大语言模型的多轮对话、工具调用、权限控制、会话持久化等能力。

## 创建会话

使用 `createSession()` 创建一个新的会话实例。

```ts
function createSession(options: SessionOptions): Promise<ISession>
```

### 最小示例

```ts
import { createSession } from '@blade-ai/agent-sdk';

const session = await createSession({
  provider: { type: 'anthropic', apiKey: process.env.ANTHROPIC_API_KEY },
  model: 'claude-sonnet-4-20250514',
});
```

### 完整配置示例

```ts
import { createSession, PermissionMode } from '@blade-ai/agent-sdk';
import type { SessionOptions, ToolDefinition } from '@blade-ai/agent-sdk';

const options: SessionOptions = {
  provider: {
    type: 'openai',
    apiKey: process.env.OPENAI_API_KEY,
    organization: 'org-xxx',
    projectId: 'proj-xxx',
  },
  model: 'gpt-4o',

  systemPrompt: '你是一个严谨的代码审查助手，只使用中文回复。',
  maxTurns: 20,

  allowedTools: ['Read', 'Glob', 'Grep', 'Edit', 'Write', 'Bash'],
  disallowedTools: ['KillShell'],
  tools: [myCustomTool],

  permissionMode: PermissionMode.AUTO_EDIT,
  canUseTool: async (toolName, input, options) => {
    if (toolName === 'Bash' && String(input.command).includes('rm')) {
      return { behavior: 'deny', message: '禁止执行 rm 命令' };
    }
    return { behavior: 'allow' };
  },

  agents: {
    researcher: {
      name: 'researcher',
      description: '专门用于代码库搜索和分析的子代理',
      allowedTools: ['Read', 'Glob', 'Grep'],
      model: 'gpt-4o-mini',
    },
  },

  defaultContext: {
    capabilities: {
      filesystem: {
        roots: ['/workspace/my-project'],
        cwd: '/workspace/my-project',
      },
    },
    environment: { NODE_ENV: 'development', CI: '0' },
    metadata: { userId: 'dev-001' },
  },

  persistSession: true,
  storagePath: '/home/user/.blade',

  outputFormat: {
    type: 'json_schema',
    json_schema: {
      name: 'code_review',
      schema: {
        type: 'object',
        properties: {
          issues: {
            type: 'array',
            items: {
              type: 'object',
              properties: {
                file: { type: 'string' },
                line: { type: 'number' },
                severity: { type: 'string', enum: ['error', 'warning', 'info'] },
                message: { type: 'string' },
              },
              required: ['file', 'line', 'severity', 'message'],
            },
          },
        },
        required: ['issues'],
      },
      strict: true,
    },
  },

  logger: {
    log: (entry) => console.log(`[${entry.level}] ${entry.message}`),
  },
};

const session = await createSession(options);
```

::: tip
`createSession()` 返回的 `ISession` 实例实现了 `AsyncDisposable`，支持 `await using` 语法自动清理资源。
:::

## Provider 配置

`ProviderConfig` 定义模型提供方的连接信息。

```ts
interface ProviderConfig {
  type: ProviderType;
  apiKey?: string;
  baseUrl?: string;
  headers?: Record<string, string>;
  organization?: string;   // OpenAI 专用
  apiVersion?: string;      // Azure OpenAI 专用
  projectId?: string;       // OpenAI 专用
}
```

### ProviderType

```ts
type ProviderType =
  | 'anthropic'
  | 'openai'
  | 'azure-openai'
  | 'gemini'
  | 'deepseek'
  | 'openai-compatible';
```

### 各 Provider 配置示例

**Anthropic**

```ts
const session = await createSession({
  provider: {
    type: 'anthropic',
    apiKey: process.env.ANTHROPIC_API_KEY,
    // baseUrl 默认: https://api.anthropic.com
  },
  model: 'claude-sonnet-4-20250514',
});
```

**OpenAI**

```ts
const session = await createSession({
  provider: {
    type: 'openai',
    apiKey: process.env.OPENAI_API_KEY,
    organization: 'org-abc123',
    projectId: 'proj-xyz789',
    // baseUrl 默认: https://api.openai.com/v1
  },
  model: 'gpt-4o',
});
```

::: tip
当 `type` 为 `'openai'` 时，`organization` 会自动映射为 `OpenAI-Organization` 请求头，`projectId` 会映射为 `OpenAI-Project` 请求头。
:::

**Azure OpenAI**

```ts
const session = await createSession({
  provider: {
    type: 'azure-openai',
    apiKey: process.env.AZURE_OPENAI_API_KEY,
    baseUrl: 'https://my-resource.openai.azure.com/openai/deployments/gpt-4o',
    apiVersion: '2024-08-01-preview',
  },
  model: 'gpt-4o',
});
```

**Google Gemini**

```ts
const session = await createSession({
  provider: {
    type: 'gemini',
    apiKey: process.env.GEMINI_API_KEY,
    // baseUrl 默认: https://generativelanguage.googleapis.com
  },
  model: 'gemini-2.5-pro',
});
```

**DeepSeek**

```ts
const session = await createSession({
  provider: {
    type: 'deepseek',
    apiKey: process.env.DEEPSEEK_API_KEY,
    baseUrl: 'https://api.deepseek.com/v1',
  },
  model: 'deepseek-chat',
});
```

**OpenAI Compatible（自定义端点）**

```ts
const session = await createSession({
  provider: {
    type: 'openai-compatible',
    apiKey: process.env.API_KEY,
    baseUrl: 'https://api.together.xyz/v1',
    headers: {
      'X-Custom-Header': 'my-value',
    },
  },
  model: 'meta-llama/Llama-3-70b-chat-hf',
});
```

::: tip
`openai-compatible` 是最通用的类型，适用于任何兼容 OpenAI Chat Completions API 的服务端点，包括本地部署的 vLLM、Ollama 等。
:::

## send / stream 交互模型

Blade SDK 采用 **send + stream 两步式** 交互：`send()` 接受输入并返回投递结果，`stream()` 消费 Agent 的完整输出流。请求运行期间再次调用 `send()` 时，输入会按 `priority` 转向当前请求或排队到下一请求。

```ts
// send：提交消息，返回输入 ID、请求 ID 与实际投递方式
// message 支持纯文本字符串或多模态内容数组（ContentPart[]）
session.send(
  message: UserMessageContent,
  options?: SendOptions,
): Promise<InputSubmission>

// stream：异步迭代消费输出
session.stream(options?: StreamOptions): AsyncGenerator<StreamMessage>
```

### SendOptions

```ts
interface SendOptions {
  signal?: AbortSignal;        // 外部取消信号
  maxTurns?: number;           // 覆盖本次请求的最大轮次
  context?: RuntimeContext;    // 本轮的运行时上下文（与 defaultContext 合并）
  priority?: 'now' | 'next' | 'later';
  expectedRequestId?: RequestId;
}

type InputSubmission =
  | { status: 'started'; inputId: InputId; requestId: RequestId }
  | { status: 'steered'; inputId: InputId; requestId: RequestId; priority: 'now' | 'next' }
  | { status: 'queued'; inputId: InputId; priority: 'later' };
```

`priority` 在已有 pending/running 请求时生效：

- `next`（默认）：不中断当前步骤，在下一个模型/工具安全点加入当前请求。
- `now`：中断当前模型步骤及声明为 `interruptBehavior: 'cancel'` 的工具，闭合全部工具结果后加入当前请求。
- `later`：不影响当前请求，排队为下一个独立请求。当前 `stream()` 结束后再次调用 `stream()` 消费它。

`now` 触发后，流会先产生 `turn_interrupted`；若模型已经声明工具调用，SDK 会为每个调用生成或等待一个终态 `tool_result`，之后才产生 `input_applied`。被中断的模型部分输出仅用于 UI 展示，不会写回模型上下文。

`expectedRequestId` 用于防止并发客户端把输入投递到错误的活动请求。请求已经 sealed 或正在停止时，`next`/`now` 会安全降级为 `later`。活动请求期间不能覆盖 `signal`、`maxTurns` 或 `context`。

```ts
const started = await session.send('分析失败原因');
const output = session.stream();

// output 正在消费时，可从另一个异步任务提交修正
const steered = await session.send('先检查数据库连接，不要改代码', {
  priority: 'next',
  expectedRequestId:
    started.status === 'started' ? started.requestId : undefined,
});

for await (const event of output) {
  if (event.type === 'input_applied') {
    console.log(`已应用输入 ${event.inputId}`);
  }
}
```

已接受的输入有数量和字节双重上限。配置 `storagePath` 后，SDK 通过
JSONL 记录 `input_enqueued`、`input_applied` 或 `input_cancelled`；
进程重启后，尚未应用的输入会恢复为 `later`，避免绑定到已经失效的请求。
内存模式不会跨进程恢复。配置 `durableEventStore` 时，初始请求内容还会写入
`request_accepted`；它不会替代 `storagePath` 对后续 steering 队列的恢复。

### StreamOptions

```ts
interface StreamOptions {
  includeThinking?: boolean;   // 是否包含模型思考过程（默认 false）
}
```

### StreamMessage 类型

`stream()` 产出的是判别联合类型：

```ts
type StreamMessage =
  | { type: 'turn_start'; turn: number; sessionId: SessionId }
  | { type: 'turn_end'; turn: number; sessionId: SessionId }
  | { type: 'turn_interrupted'; inputId: InputId; requestId: RequestId; turn: number; sessionId: SessionId }
  | { type: 'input_applied'; inputId: InputId; requestId: RequestId; priority: 'now' | 'next'; turn: number; sessionId: SessionId }
  | { type: 'content'; delta: string; sessionId: SessionId }
  | { type: 'thinking'; delta: string; sessionId: SessionId }
  | { type: 'tool_use'; id: string; name: string; input: JsonValue; sessionId: SessionId }
  | { type: 'tool_progress'; id: string; name: string; progress: ToolProgress; sessionId: SessionId }
  | { type: 'tool_message'; id: string; name: string; content: ToolDisplayContent; sessionId: SessionId }
  | { type: 'tool_runtime_patch'; id: string; name: string; patch: RuntimePatch; sessionId: SessionId }
  | { type: 'tool_context_patch'; id: string; name: string; patch: RuntimeContextPatch; sessionId: SessionId }
  | { type: 'tool_new_messages'; id: string; name: string; messages: Message[]; sessionId: SessionId }
  | { type: 'tool_permission_updates'; id: string; name: string; updates: PermissionUpdate[]; sessionId: SessionId }
  | { type: 'tool_result'; id: string; name: string; output: ToolModelContent; display?: ToolDisplayContent; isError?: boolean; sessionId: SessionId }
  | { type: 'usage'; usage: TokenUsage; sessionId: SessionId }
  | { type: 'result'; subtype: 'success' | 'error'; content?: string; error?: string; sessionId: SessionId }
  | { type: 'error'; message: string; code?: string; sessionId: SessionId };
```

| 类型            | 说明                                        |
| ------------- | ----------------------------------------- |
| `turn_start`  | Agent 开始新一轮                               |
| `turn_end`    | Agent 当前轮结束                               |
| `turn_interrupted` | 当前模型步骤被 `now` 输入中断                  |
| `input_applied` | 排队输入已持久化并加入模型上下文；`turn` 是目标模型轮次     |
| `content`     | 文本内容增量（流式）                                |
| `thinking`    | 模型思考过程增量（需 `includeThinking: true`）       |
| `tool_use`    | Agent 发起工具调用                              |
| `tool_progress` | 工具执行进度消息                                |
| `tool_message` | 工具执行过程中产生的附加消息                          |
| `tool_runtime_patch` | 工具请求的运行时补丁（如 Skill 激活时的模型/工具策略变更）  |
| `tool_context_patch` | 工具请求的上下文补丁                             |
| `tool_new_messages` | 工具产生的新消息（如子 Agent 的输出）                  |
| `tool_permission_updates` | 工具请求的权限更新                           |
| `tool_result` | 工具执行结果返回                                  |
| `usage`       | Token 用量统计                                |
| `result`      | 最终结果（`subtype` 为 `'success'` 或 `'error'`） |
| `error`       | 流处理过程中发生的错误                               |

公开联合类型为 `result` 保留了 `subtype: 'error'`，但当前 Session 实现会把
请求失败作为独立的 `error` 事件发送，`result` 用于成功完成。

### 常用 Stream 事件处理示例

```ts
import { createSession } from '@blade-ai/agent-sdk';

const session = await createSession({
  provider: { type: 'anthropic', apiKey: process.env.ANTHROPIC_API_KEY },
  model: 'claude-sonnet-4-20250514',
  defaultContext: {
    capabilities: {
      filesystem: { roots: [process.cwd()], cwd: process.cwd() },
    },
  },
});

await session.send('分析 src 目录下的所有 TypeScript 文件，找出未使用的导出', {
  maxTurns: 10,
});

for await (const msg of session.stream({ includeThinking: true })) {
  switch (msg.type) {
    case 'turn_start':
      console.log(`\n--- 第 ${msg.turn} 轮 ---`);
      break;

    case 'turn_end':
      console.log(`--- 第 ${msg.turn} 轮结束 ---\n`);
      break;

    case 'content':
      process.stdout.write(msg.delta);
      break;

    case 'thinking':
      process.stderr.write(`[思考] ${msg.delta}`);
      break;

    case 'tool_use':
      console.log(`\n🔧 调用工具: ${msg.name}`, JSON.stringify(msg.input, null, 2));
      break;

    case 'tool_result':
      if (msg.isError) {
        console.error(`❌ 工具失败: ${msg.name}`, msg.output);
      } else {
        console.log(`✅ 工具完成: ${msg.name}`);
      }
      break;

    case 'usage':
      console.log(`\n📊 Token 用量: 输入=${msg.usage.inputTokens}, 输出=${msg.usage.outputTokens}, 总计=${msg.usage.totalTokens}`);
      break;

    case 'result':
      if (msg.subtype === 'success') {
        console.log('\n🎉 任务完成:', msg.content);
      } else {
        console.error('\n💥 任务失败:', msg.error);
      }
      break;

    case 'error':
      console.error(`\n🚨 错误 [${msg.code ?? 'UNKNOWN'}]: ${msg.message}`);
      break;
  }
}

await session.close();
```

### 多轮对话示例

```ts
const session = await createSession({
  provider: { type: 'openai', apiKey: process.env.OPENAI_API_KEY },
  model: 'gpt-4o',
});

await session.send('你好，请记住我的名字叫小明');
for await (const msg of session.stream()) {
  if (msg.type === 'content') process.stdout.write(msg.delta);
}

console.log('\n');

await session.send('我的名字是什么？');
for await (const msg of session.stream()) {
  if (msg.type === 'content') process.stdout.write(msg.delta);
}

await session.close();
```

### 使用 AbortSignal 取消请求

```ts
const controller = new AbortController();

setTimeout(() => controller.abort(), 30_000);

await session.send('执行一个可能很耗时的分析任务', {
  signal: controller.signal,
});

for await (const msg of session.stream()) {
  if (msg.type === 'content') process.stdout.write(msg.delta);
  if (msg.type === 'error') console.error(msg.message);
}
```

::: warning

- 调用 `stream()` 之前必须先调用 `send()`，否则会抛出 `'No pending message. Call send() before stream().'`
- 活动请求期间可以再次调用 `send()`；通过 `priority` 选择立即转向、安全点转向或排队
- 每条 pending message 只能被 `stream()` 消费一次
  :::

## prompt 一次性请求

`prompt()` 是一个便捷函数，适用于不需要保留长期会话的一次性请求场景。内部会自动创建 Session、发送消息、消费流、关闭 Session。

```ts
function prompt(
  message: Parameters<ISession['send']>[0],
  options: SessionOptions,
): Promise<PromptResult>
```

### PromptResult

```ts
interface PromptResult {
  result: string;              // 模型最终文本回复
  toolCalls: ToolCallRecord[]; // 所有工具调用记录
  usage: TokenUsage;           // Token 用量
  duration: number;            // 总耗时（毫秒）
  turnsCount: number;          // 轮次数
}

interface ToolCallRecord {
  id: string;
  name: string;
  input: unknown;
  output: unknown;
  duration: number;
  isError?: boolean;
}

interface TokenUsage {
  inputTokens: number;
  outputTokens: number;
  totalTokens: number;
  maxContextTokens: number;
}
```

### 基本用法

```ts
import { prompt } from '@blade-ai/agent-sdk';

const result = await prompt('列出当前目录下所有 TypeScript 文件', {
  provider: { type: 'anthropic', apiKey: process.env.ANTHROPIC_API_KEY },
  model: 'claude-sonnet-4-20250514',
  defaultContext: {
    capabilities: {
      filesystem: { roots: [process.cwd()], cwd: process.cwd() },
    },
  },
});

console.log('回复:', result.result);
console.log('工具调用次数:', result.toolCalls.length);
console.log('轮次:', result.turnsCount);
console.log('耗时:', result.duration, 'ms');
console.log('Token 用量:', result.usage);
```

### 配合结构化输出

```ts
const result = await prompt('分析这个函数的复杂度', {
  provider: { type: 'openai', apiKey: process.env.OPENAI_API_KEY },
  model: 'gpt-4o',
  outputFormat: {
    type: 'json_schema',
    json_schema: {
      name: 'complexity_analysis',
      schema: {
        type: 'object',
        properties: {
          cyclomaticComplexity: { type: 'number' },
          cognitiveComplexity: { type: 'number' },
          suggestions: {
            type: 'array',
            items: { type: 'string' },
          },
        },
        required: ['cyclomaticComplexity', 'cognitiveComplexity', 'suggestions'],
      },
      strict: true,
    },
  },
});

const analysis = JSON.parse(result.result);
console.log('圈复杂度:', analysis.cyclomaticComplexity);
```

### 检查工具调用详情

```ts
const result = await prompt('搜索所有包含 TODO 注释的文件', {
  provider: { type: 'openai', apiKey: process.env.OPENAI_API_KEY },
  model: 'gpt-4o',
  allowedTools: ['Grep', 'Glob', 'Read'],
  defaultContext: {
    capabilities: {
      filesystem: { roots: ['/workspace/project'], cwd: '/workspace/project' },
    },
  },
});

for (const call of result.toolCalls) {
  console.log(`工具: ${call.name}`);
  console.log(`  输入: ${JSON.stringify(call.input)}`);
  console.log(`  成功: ${!call.isError}`);
}
```

::: tip
`prompt()` 在执行完毕后会自动调用 `session.close()` 释放资源，无需手动清理。如果需要多轮对话，请使用 `createSession()` + `send()` / `stream()` 组合。
:::

## 会话持久化

Blade Agent SDK 默认使用内存存储。只有配置 `storagePath` 且未设置
`persistSession: false` 时才写入磁盘。

### 持久化模式

```ts
const session = await createSession({
  provider: { type: 'anthropic', apiKey: process.env.ANTHROPIC_API_KEY },
  model: 'claude-sonnet-4-20250514',
  storagePath: '/home/user/.blade',
});
```

默认行为：

- 会话历史自动写入本地存储（JSONL 格式）
- 存储路径：`{storagePath}/sessions/{sessionId}.jsonl`
- 未指定 `storagePath` 时使用内存存储，不创建 Session 文件
- 可通过 `resumeSession()` 恢复已有会话
- 可通过 `forkSession()` 从历史会话分叉

### 纯内存模式

对于 Web API、Serverless、浏览器中转层等场景，可显式关闭持久化：

```ts
const session = await createSession({
  provider: { type: 'openai', apiKey: process.env.OPENAI_API_KEY },
  model: 'gpt-4o',
  persistSession: false,
});
```

::: warning
`persistSession: false` 时：

- SDK **不会** 创建或写入任何磁盘文件
- 会话仅存在于当前进程内存中
- `resumeSession()` 不可用（会抛出错误）
- `forkSession()` 不可用（会抛出错误）
- `session.fork()` 仍然可用，因为它直接复制内存中的消息
  :::

### Durable 执行事件

通过 `durableEventStore` 显式启用可恢复执行日志。该 Store 与消息历史存储相互
独立，因此也可以与 `persistSession: false` 组合：

```ts
import {
  JsonlDurableEventStore,
  createSession,
} from '@blade-ai/agent-sdk';

const eventStore = new JsonlDurableEventStore('/var/lib/my-agent');
const session = await createSession({
  provider,
  model,
  persistSession: false,
  durableEventStore: eventStore,
});
```

启用后，Session 会记录 Session、Request、Turn、Tool、Permission 和输入应用
事件，并保证：

- `send()` 返回前已提交 `request_accepted`。
- `turn_start` 和 `tool_use` 对外可见前已提交对应 durable 事件。
- 工具副作用开始前已提交 `tool_started`。
- `tool_result`、`result` 或 `error` 对外可见前已提交终态。
- pending request 的 `await session.abort()` 返回前已提交
  `request_interrupted`。

如果 durable 边界提交失败，Session 会直接拒绝 stream，而不会伪造普通终态
事件；在日志完成对账前，新请求和排队请求也不会继续执行。

```ts
const projection = session.getDurableProjection();
const recovery = session.getDurableRecoveryPlan();
```

`resumeSession()` 遇到未完成的 durable Request、待决权限或未知工具结果时抛出
`DurableSessionRecoveryRequiredError`。当前集成不会自动重放已开始的工具；
调用方必须先通过 `DurableSessionJournal` 对账。JSONL adapter 只支持单进程
writer，多进程部署需要实现带事务 CAS 或 fencing 的 `DurableEventStore`。

### 自定义存储路径

```ts
import * as path from 'node:path';
import * as os from 'node:os';

const session = await createSession({
  provider: { type: 'anthropic', apiKey: process.env.ANTHROPIC_API_KEY },
  model: 'claude-sonnet-4-20250514',
  storagePath: path.join(os.homedir(), '.my-app'),
  // 会话文件将保存到 ~/.my-app/sessions/{sessionId}.jsonl
});
```

## 恢复与分叉

### resumeSession — 恢复已有会话

```ts
function resumeSession(options: ResumeOptions): Promise<ISession>

interface ResumeOptions extends SessionOptions {
  sessionId: string;
}
```

从磁盘加载已持久化的会话历史，继续对话：

```ts
import { resumeSession } from '@blade-ai/agent-sdk';

const session = await resumeSession({
  sessionId: 'abc123',
  provider: { type: 'anthropic', apiKey: process.env.ANTHROPIC_API_KEY },
  model: 'claude-sonnet-4-20250514',
  storagePath: '/home/user/.blade',
});

console.log('已恢复消息数:', session.messages.length);

await session.send('继续之前的分析');
for await (const msg of session.stream()) {
  if (msg.type === 'content') process.stdout.write(msg.delta);
}
```

::: danger
`resumeSession()` 要求会话已持久化到磁盘。如果创建会话时使用了 `persistSession: false`，调用此函数会抛出错误：

```
resumeSession() requires session persistence. Remove persistSession: false or use createSession().
```

:::

### forkSession — 从磁盘会话分叉

```ts
function forkSession(options: ForkOptions): Promise<ISession>

interface ForkOptions extends ResumeOptions {
  messageId?: string;
}
```

从已持久化的会话创建分叉——新会话继承原始会话的消息历史（可截止到指定消息），但拥有独立的 sessionId：

```ts
import { forkSession } from '@blade-ai/agent-sdk';

const forked = await forkSession({
  sessionId: 'original-session-id',
  messageId: 'msg-456',
  provider: { type: 'openai', apiKey: process.env.OPENAI_API_KEY },
  model: 'gpt-4o',
  storagePath: '/home/user/.blade',
});

console.log('分叉会话 ID:', forked.sessionId);
console.log('继承消息数:', forked.messages.length);

await forked.send('尝试另一种方案');
for await (const msg of forked.stream()) {
  if (msg.type === 'content') process.stdout.write(msg.delta);
}
```

### session.fork() — 从活跃实例分叉

```ts
session.fork(options?: ForkSessionOptions): Promise<ISession>

interface ForkSessionOptions {
  messageId?: string;
}
```

无需磁盘持久化，直接从内存中的活跃会话创建分叉：

```ts
const session = await createSession({
  provider: { type: 'anthropic', apiKey: process.env.ANTHROPIC_API_KEY },
  model: 'claude-sonnet-4-20250514',
  persistSession: false,
});

await session.send('分析项目结构');
for await (const msg of session.stream()) {
  // 消费第一轮输出...
}

const branch = await session.fork();

await branch.send('基于之前的分析，重构 utils 模块');
for await (const msg of branch.stream()) {
  if (msg.type === 'content') process.stdout.write(msg.delta);
}

// 指定从某条消息分叉
const branch2 = await session.fork({ messageId: 'msg-789' });
```

::: tip
三种方式对比：

| 方式                | 需要持久化  | 适用场景            |
| ----------------- | ------ | --------------- |
| `resumeSession()` | ✅      | 恢复之前的对话继续       |
| `forkSession()`   | ✅      | 从历史会话创建分支尝试不同方案 |
| `session.fork()`  | ❌      | 从当前活跃会话创建分支     |
| :::               | <br /> | <br />          |

## 运行时上下文

`RuntimeContext` 为工具执行提供运行时环境信息，包括文件系统访问范围、浏览器能力、网络权限等。

`RuntimeContext` 和 filesystem capability 都是可选的。没有 workspace 时，
对话、显式自定义工具和显式配置的子 Agent 仍可使用；本地文件工具以及
依赖项目目录的 Agent/Skill 发现不会启用。SDK 不会隐式使用
`process.cwd()`。

```ts
interface RuntimeContext {
  id?: string;
  capabilities?: {
    filesystem?: {
      roots: string[];    // 允许访问的文件系统根目录列表
      cwd?: string;       // 当前工作目录
    };
    browser?: {
      pageId?: string;
      tabId?: string;
    };
    network?: {
      allowDomains?: string[];  // 允许访问的域名
    };
  };
  environment?: Record<string, string>;    // 环境变量
  metadata?: Record<string, unknown>;      // 自定义元数据
}
```

### defaultContext — 会话级上下文

在 `SessionOptions` 中通过 `defaultContext` 设置会话级默认上下文，对所有轮次生效：

```ts
const session = await createSession({
  provider: { type: 'anthropic', apiKey: process.env.ANTHROPIC_API_KEY },
  model: 'claude-sonnet-4-20250514',
  defaultContext: {
    capabilities: {
      filesystem: {
        roots: ['/workspace/my-project', '/workspace/shared-libs'],
        cwd: '/workspace/my-project',
      },
      network: {
        allowDomains: ['api.github.com', 'registry.npmjs.org'],
      },
    },
    environment: {
      NODE_ENV: 'development',
      CI: '0',
    },
    metadata: {
      userId: 'user-123',
      team: 'platform',
    },
  },
});
```

### context — 轮次级上下文

在 `SendOptions` 中通过 `context` 设置单轮上下文，与 `defaultContext` 合并（轮次上下文优先）：

```ts
await session.send('分析 shared-libs 中的依赖问题', {
  context: {
    capabilities: {
      filesystem: {
        roots: ['/workspace/shared-libs'],
        cwd: '/workspace/shared-libs',
      },
    },
    environment: {
      DEBUG: 'true',
    },
  },
});
```

::: tip
上下文合并规则：

- `capabilities.filesystem.roots`：轮次级 **替换**（非累加）默认值
- `capabilities.filesystem.cwd`：轮次级覆盖默认值
- `capabilities.browser` / `capabilities.network`：轮次级整体替换默认值
- `environment`：浅合并，轮次级覆盖同名键
- `metadata`：浅合并，轮次级覆盖同名键
  :::

## 上下文自动压缩

SDK 自动管理上下文窗口大小。当对话历史的 token 数接近模型上限时，会按优先级依次触发多层压缩策略，无需手动干预。

### 压缩层级

| 层级 | 名称 | 触发条件 | 行为 |
|------|------|----------|------|
| **Tier 0** | Microcompact | token 用量 ≥ 60% | 将旧的大型工具输出替换为摘要预览，保留最近 N 条完整工具结果 |
| **Tier 1** | Soft compaction | token 用量 ≥ 80%（Microcompact 不足时） | 截断所有过长的工具输出到指定长度 |
| **Tier 2** | LLM 压缩 | token 用量 ≥ 80%（Soft 不足时） | 调用 LLM 生成对话历史摘要，替换旧消息 |
| **Tier 3** | 紧急截断 | token 用量 ≥ 95% | 仅保留系统消息和最近的消息，丢弃中间历史 |

### Microcompact 策略

Microcompact 是最轻量的压缩方式，不调用 LLM，只替换旧的大型工具输出：

- 保留最近 N 条工具消息的完整内容（默认保留最近 1-2 条）
- 超过指定长度的旧工具输出被替换为预览摘要
- 预览包含：原始长度、tool_call_id、内容前 160 字符

这种策略在不丢失对话语义的前提下，通常可以回收大量 token，特别适合包含大量文件读取和搜索结果的长对话。

### 上下文溢出恢复

当 LLM 调用因上下文超限报错时，SDK 会自动触发恢复流程（Reactive Compaction）：

1. 检测到 `maximum context length exceeded` 类型错误
2. 依次执行 Microcompact → Soft compaction → LLM 压缩
3. 压缩成功后自动重试当前轮次
4. 如果压缩后仍然超限，抛出原始错误

整个恢复过程对上层透明。`recovery` 是内部 Agent 事件，不属于公开
`StreamMessage`；调用方通过最终的 `result` 或 `error` 观察结果。

### 动态更新上下文

```ts
session.setDefaultContext({
  capabilities: {
    filesystem: {
      roots: ['/new/project/path'],
      cwd: '/new/project/path',
    },
  },
});

const currentContext = session.getDefaultContext();
```

## 工具配置

通过 `SessionOptions` 的三个字段控制工具可用性：

```ts
interface SessionOptions {
  tools?: SessionTool[];         // ToolDefinition 或完整 Tool
  allowedTools?: string[];       // 工具白名单（仅允许列出的工具）
  disallowedTools?: string[];    // 工具黑名单（排除列出的工具）
}
```

`allowedTools` 未设置时不限制工具；设置为 `[]` 时表示禁用所有工具。

### ToolDefinition

```ts
interface ToolDefinition<TParams = JsonObject> {
  name: string;
  description: string | ToolDescription;
  parameters: JSONSchema7;          // JSON Schema
  sideEffect: ToolSideEffect;
  execute: (params: TParams, context: ExecutionContext) => ToolExecution;
  kind?: ToolKind;
}
```

### 自定义工具示例

```ts
import { createSession, ToolKind, ToolSideEffect } from '@blade-ai/agent-sdk';
import type { ToolDefinition } from '@blade-ai/agent-sdk';

const weatherTool: ToolDefinition = {
  name: 'GetWeather',
  description: '获取指定城市的当前天气信息',
  parameters: {
    type: 'object',
    properties: {
      city: { type: 'string', description: '城市名称' },
      unit: { type: 'string', enum: ['celsius', 'fahrenheit'], description: '温度单位' },
    },
    required: ['city'],
  },
  kind: ToolKind.ReadOnly,
  sideEffect: ToolSideEffect.PURE,
  async *execute(params, context) {
    const { city, unit = 'celsius' } = params as { city: string; unit?: string };
    yield {
      kind: 'progress',
      message: `正在查询 ${city}`,
    };
    const weather = await fetchWeatherAPI(city, unit);
    return {
      status: 'success',
      model: JSON.stringify(weather),
      display: {
        summary: `${city}: ${weather.temperature}°${unit === 'celsius' ? 'C' : 'F'}`,
      },
    };
  },
};

const session = await createSession({
  provider: { type: 'openai', apiKey: process.env.OPENAI_API_KEY },
  model: 'gpt-4o',
  tools: [weatherTool],
});
```

### 使用 createTool + Zod Schema

```ts
import { createSession, createTool, ToolKind, ToolSideEffect } from '@blade-ai/agent-sdk';
import { z } from 'zod';

const dbQueryTool = createTool({
  name: 'DatabaseQuery',
  displayName: 'Database Query',
  kind: ToolKind.ReadOnly,
  sideEffect: ToolSideEffect.PURE,
  schema: z.object({
    query: z.string().describe('SQL 查询语句'),
    database: z.string().optional().describe('数据库名称'),
  }),
  description: {
    short: '执行只读数据库查询',
    long: '在指定数据库上执行只读 SQL 查询并返回结果',
  },
  async *execute(params, context) {
    const results = await runQuery(params.query, params.database);
    return {
      status: 'success',
      model: JSON.stringify(results),
      display: { summary: `查询返回 ${results.length} 行` },
    };
  },
});

const session = await createSession({
  provider: { type: 'openai', apiKey: process.env.OPENAI_API_KEY },
  model: 'gpt-4o',
  tools: [dbQueryTool],
});
```

`SessionOptions.tools` 接受 `ToolDefinition` 和完整 `Tool`。传入
`createTool()` 的结果时，Session 会保留其 Zod 校验、权限检查和
`interruptBehavior`。

### 工具过滤

```ts
// 仅允许只读工具
const session = await createSession({
  provider: { type: 'anthropic', apiKey: process.env.ANTHROPIC_API_KEY },
  model: 'claude-sonnet-4-20250514',
  allowedTools: ['Read', 'Glob', 'Grep', 'WebFetch', 'WebSearch'],
});

// 排除危险工具
const session2 = await createSession({
  provider: { type: 'anthropic', apiKey: process.env.ANTHROPIC_API_KEY },
  model: 'claude-sonnet-4-20250514',
  disallowedTools: ['Bash', 'KillShell', 'Write'],
});
```

::: warning
当 `allowedTools` 非空时，只有列出的工具会被注册。`disallowedTools` 在 `allowedTools` 过滤后进一步排除。自定义工具（`tools`）同样受这两个列表约束。
:::

## 权限模式

`PermissionMode` 控制 Agent 执行工具时的权限审批策略。

```ts
const PermissionMode = {
  DEFAULT: 'default',
  AUTO_EDIT: 'autoEdit',
  YOLO: 'yolo',
  PLAN: 'plan',
} as const;

type PermissionMode = 'default' | 'autoEdit' | 'yolo' | 'plan';
```

| 模式             | 值             | 说明                        |
| -------------- | ------------- | ------------------------- |
| **DEFAULT**    | `'default'`   | 标准模式，写入/执行类工具需要审批         |
| **AUTO\_EDIT** | `'autoEdit'`  | 自动批准文件编辑（write），但命令执行仍需审批 |
| **YOLO**       | `'yolo'`      | 内置 mode handler 默认批准；工具自检、路径安全和其他 handler 仍可拒绝或询问 |
| **PLAN**       | `'plan'`      | 计划模式——只规划不执行，生成实施方案       |

### 在创建会话时设置

```ts
import { createSession, PermissionMode } from '@blade-ai/agent-sdk';

const session = await createSession({
  provider: { type: 'anthropic', apiKey: process.env.ANTHROPIC_API_KEY },
  model: 'claude-sonnet-4-20250514',
  permissionMode: PermissionMode.AUTO_EDIT,
});
```

### 运行时切换

```ts
session.setPermissionMode(PermissionMode.YOLO);
```

### canUseTool 回调

通过 `canUseTool` 实现细粒度的运行时权限决策：

```ts
import type { CanUseTool, PermissionResult } from '@blade-ai/agent-sdk';

const canUseTool: CanUseTool = async (
  toolName: string,
  input: Record<string, unknown>,
  options: { signal: AbortSignal; toolKind: string; affectedPaths: string[] }
): Promise<PermissionResult> => {
  if (toolName === 'Bash') {
    const command = String(input.command || '');
    if (command.includes('rm -rf') || command.includes('sudo')) {
      return {
        behavior: 'deny',
        message: `危险命令被拒绝: ${command}`,
      };
    }
  }

  if (options.affectedPaths.some(p => p.includes('node_modules'))) {
    return {
      behavior: 'deny',
      message: '不允许修改 node_modules',
    };
  }

  return { behavior: 'allow' };
};

const session = await createSession({
  provider: { type: 'openai', apiKey: process.env.OPENAI_API_KEY },
  model: 'gpt-4o',
  canUseTool,
});
```

`PermissionResult` 有三种行为：

```ts
type PermissionResult =
  | { behavior: 'allow'; updatedInput?: Record<string, unknown>; updatedPermissions?: PermissionUpdate[] }
  | { behavior: 'deny'; message: string; interrupt?: boolean }
  | { behavior: 'ask' };
```

::: tip
`canUseTool` 的优先级低于 Hook 系统中的 `PermissionRequest` 事件。如果 Hook 已做出决策（`abort` 或 `skip`），`canUseTool` 不会被调用。
:::

## 子 Agent

通过 `agents` 字段定义命名子代理，供内置任务工具（如 Task）在运行时调度：

```ts
interface AgentDefinition {
  name: string;
  description: string;
  systemPrompt?: string;
  allowedTools?: string[];
  model?: string;
}
```

`SessionOptions.agents` 会在当前 session 初始化时注册到专属的 `SubagentRegistry`：

- 不同 session 之间不会共享这些 agent
- 加载顺序是 builtin → 用户/项目文件配置 → `SessionOptions.agents`
- 如果名称冲突，当前 session 里的显式 `agents` 定义优先级最高

### 自定义子代理

```ts
const session = await createSession({
  provider: { type: 'anthropic', apiKey: process.env.ANTHROPIC_API_KEY },
  model: 'claude-sonnet-4-20250514',
  agents: {
    researcher: {
      name: 'researcher',
      description: '代码库搜索和分析专家，擅长查找文件、搜索代码模式',
      allowedTools: ['Read', 'Glob', 'Grep', 'WebSearch'],
      model: 'claude-sonnet-4-20250514',
    },
    verification: {
      name: 'verification',
      description: '代码审查专家，负责分析正确性、风险和缺失测试',
      systemPrompt: `你是一个资深代码审查员。审查时关注：
1. 类型安全
2. 错误处理
3. 性能隐患
4. 安全漏洞
请用中文输出结构化的审查报告。`,
      allowedTools: ['Read', 'Glob', 'Grep'],
    },
    planner: {
      name: 'planner',
      description: '架构设计师，负责制定实施方案和技术选型',
      systemPrompt: '你是一名软件架构师。分析需求后给出详细的分步实施计划。',
    },
  },
});
```

### 3 个内置子代理

SDK 默认提供以下内置子代理：

| 名称                  | 说明                                                    | 可用工具                                  |
| ------------------- | ----------------------------------------------------- | ------------------------------------- |
| **general-purpose** | 通用代理，适合研究复杂问题、搜索代码、执行多步任务                             | 全部                                    |
| **Explore**         | 快速代码库探索专家，支持三种深度：`quick` / `medium` / `very thorough` | Glob, Grep, Read, WebFetch, WebSearch |
| **Plan**            | 软件架构师，专门用于设计实施方案、识别关键文件、权衡技术选型                        | 全部                                    |

```ts
// 内置代理无需额外配置，直接可用
const session = await createSession({
  provider: { type: 'anthropic', apiKey: process.env.ANTHROPIC_API_KEY },
  model: 'claude-sonnet-4-20250514',
  // Explore、Plan、general-purpose 已自动注册
});
```

::: tip
用户定义的子代理会与内置子代理并存。如果名称冲突，当前 session 的定义将覆盖内置或文件配置的同名 agent。
:::

## 结构化输出

通过 `outputFormat` 要求模型以指定的 JSON Schema 格式输出：

```ts
interface OutputFormat {
  type: 'json_schema';
  json_schema: {
    name: string;
    description?: string;
    schema: JsonSchema;
    strict?: boolean;
  };
}
```

### 示例

```ts
const session = await createSession({
  provider: { type: 'openai', apiKey: process.env.OPENAI_API_KEY },
  model: 'gpt-4o',
  outputFormat: {
    type: 'json_schema',
    json_schema: {
      name: 'code_analysis',
      description: '代码分析结果',
      schema: {
        type: 'object',
        properties: {
          summary: { type: 'string', description: '总体评价' },
          score: { type: 'number', description: '代码质量评分 (0-100)' },
          issues: {
            type: 'array',
            items: {
              type: 'object',
              properties: {
                file: { type: 'string' },
                line: { type: 'integer' },
                severity: { type: 'string', enum: ['critical', 'warning', 'info'] },
                message: { type: 'string' },
                suggestion: { type: 'string' },
              },
              required: ['file', 'line', 'severity', 'message'],
            },
          },
        },
        required: ['summary', 'score', 'issues'],
      },
      strict: true,
    },
  },
});

await session.send('分析 src/utils 目录的代码质量');
for await (const msg of session.stream()) {
  if (msg.type === 'result' && msg.subtype === 'success') {
    const analysis = JSON.parse(msg.content!);
    console.log(`评分: ${analysis.score}/100`);
    console.log(`问题数: ${analysis.issues.length}`);
  }
}
```

::: tip
`strict: true` 会开启 OpenAI 的 Structured Outputs 模式，确保模型输出严格遵循 Schema。注意：并非所有 Provider 都支持此功能。
:::

## 生命周期方法

### close()

关闭会话并释放所有资源（Agent、Runtime、MCP 连接等）：

```ts
await session.close();
```

调用后：

- 中止正在进行的请求
- 断开所有 MCP 服务器连接
- 触发 `SessionEnd` Hook
- Session 永久进入关闭状态，后续 `send()` / `stream()` 会抛出错误

### abort()

终止当前正在进行的整个请求，不关闭会话。它与 `priority: 'now'` 不同：`abort()` 会取消所有工具，包括 `interruptBehavior: 'block'` 的工具；`now` 只中断当前步骤，并在安全点继续同一请求。

```ts
const currentStream = session.stream();
await session.abort();

// 先排队，当前流完成清理后再消费下一请求
await session.send('换个思路重新试试', { priority: 'later' });
for await (const msg of currentStream) {
  // Drain the aborted request.
}
for await (const msg of session.stream()) {
  if (msg.type === 'content') process.stdout.write(msg.delta);
}
```

### 管理待处理输入

```ts
const queued = await session.send('稍后执行', { priority: 'later' });

session.getPendingInputs();
await session.cancelInput(queued.inputId);
```

已被 AgentLoop claim 的输入不能再取消，`cancelInput()` 此时返回 `false`。

### setModel()

在运行时切换模型：

```ts
await session.setModel('gpt-4o-mini');
```

### setMaxTurns()

更新最大轮次限制：

```ts
session.setMaxTurns(50);
```

### supportedModels()

查询当前 Provider 支持的模型列表：

```ts
const models = await session.supportedModels();
for (const model of models) {
  console.log(`${model.name} (${model.provider})`);
}
```

```ts
interface ModelInfo {
  id: string;
  name: string;
  provider: string;
  maxContextTokens?: number;
}
```

### MCP 方法

#### mcpServerStatus()

获取所有已配置 MCP 服务器的连接状态：

```ts
const statuses = await session.mcpServerStatus();
for (const s of statuses) {
  console.log(`${s.name}: ${s.status} (${s.toolCount} tools)`);
  if (s.error) console.error(`  错误: ${s.error}`);
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

#### mcpConnect() / mcpDisconnect() / mcpReconnect()

手动管理 MCP 服务器连接：

```ts
await session.mcpConnect('my-db-server');

await session.mcpReconnect('my-db-server');

await session.mcpDisconnect('my-db-server');
```

#### mcpListTools()

列出所有通过 MCP 服务器注册的工具：

```ts
const tools = await session.mcpListTools();
for (const tool of tools) {
  console.log(`${tool.name} [${tool.serverName}]: ${tool.description}`);
}
```

```ts
interface McpToolInfo {
  name: string;
  description: string;
  serverName: string;
}
```

### MCP 配置示例

```ts
const session = await createSession({
  provider: { type: 'anthropic', apiKey: process.env.ANTHROPIC_API_KEY },
  model: 'claude-sonnet-4-20250514',
  mcpServers: {
    filesystem: {
      command: 'npx',
      args: ['-y', '@modelcontextprotocol/server-filesystem', '/workspace'],
      type: 'stdio',
    },
    'remote-api': {
      type: 'sse',
      url: 'https://mcp.example.com/sse',
      headers: { Authorization: 'Bearer token' },
    },
    database: {
      command: 'node',
      args: ['./mcp-servers/db-server.js'],
      env: { DATABASE_URL: process.env.DATABASE_URL! },
      alwaysAllow: ['query', 'list_tables'],
      healthCheck: { enabled: true, intervalMs: 30000 },
    },
  },
});
```

## 自动清理 (AsyncDisposable)

`ISession` 实现了 `AsyncDisposable` 接口。在支持 `using` 声明的运行时（TypeScript 5.2+、Node.js 等）中，可以利用 `await using` 确保会话自动清理：

```ts
async function analyzeCode() {
  await using session = await createSession({
    provider: { type: 'anthropic', apiKey: process.env.ANTHROPIC_API_KEY },
    model: 'claude-sonnet-4-20250514',
  });

  await session.send('分析这个项目的架构');
  for await (const msg of session.stream()) {
    if (msg.type === 'content') process.stdout.write(msg.delta);
  }

  // 函数退出时自动调用 session[Symbol.asyncDispose]()
  // 等效于 session.close()
}
```

对比传统写法：

```ts
async function analyzeCodeManual() {
  const session = await createSession({
    provider: { type: 'anthropic', apiKey: process.env.ANTHROPIC_API_KEY },
    model: 'claude-sonnet-4-20250514',
  });

  try {
    await session.send('分析这个项目的架构');
    for await (const msg of session.stream()) {
      if (msg.type === 'content') process.stdout.write(msg.delta);
    }
  } finally {
    await session.close();
  }
}
```

::: tip
`await using` 的优势在于：即使 `stream()` 中途抛出异常，会话也会被正确清理，避免资源泄漏。
:::

## SessionOptions 完整参考

| 字段                | 类型                                                      | 必填 | 默认值         | 说明                                                |
| ----------------- | ------------------------------------------------------- | -- | ----------- | ------------------------------------------------- |
| `provider`        | `ProviderConfig`                                        | ✅  | —           | 模型提供方配置                                           |
| `model`           | `string`                                                | ✅  | —           | 模型 ID（如 `'claude-sonnet-4-20250514'`, `'gpt-4o'`） |
| `temperature`     | `number`                                                | —  | `0.7`       | 模型采样温度                                            |
| `maxOutputTokens` | `number`                                                | —  | —           | 单次模型输出 token 限制                                  |
| `maxContextTokens` | `number`                                               | —  | `128000`    | 会话默认模型上下文窗口大小                                  |
| `providerOptions` | `JsonObject`                                            | —  | —           | 透传给底层 provider 的高级选项                             |
| `thinkingEnabled` | `boolean`                                               | —  | —           | 是否为支持 thinking 的模型启用 reasoning 内容                 |
| `thinkingBudget`  | `number`                                                | —  | —           | thinking/reasoning token 预算，供 provider 适配使用          |
| `tokenBudget`     | `TokenBudgetConfig`                                     | —  | —           | Agent 级 token 与成本预算配置                              |
| `systemPrompt`    | `string`                                                | —  | —           | 会话级系统提示词                                          |
| `maxTurns`        | `number`                                                | —  | `200`       | Agent 最大轮次限制                                      |
| `allowedTools`    | `string[]`                                              | —  | —           | 工具白名单；未设置表示不限制，空数组表示禁用全部工具                    |
| `disallowedTools` | `string[]`                                              | —  | —           | 工具黑名单                                             |
| `toolSourcePolicy` | `ToolCatalogSourcePolicy`                              | —  | —           | 工具来源策略，按来源类型和信任级别过滤工具                            |
| `tools`           | `SessionTool[]`                                          | —  | —           | 追加的 `ToolDefinition` 或完整 `Tool`                        |
| `mcpServers`      | `Record<string, McpServerConfig \| SdkMcpServerHandle>` | —  | —           | MCP 服务器配置映射                                       |
| `permissionMode`  | `PermissionMode`                                        | —  | `'default'` | 权限审批模式                                            |
| `permissionHandler` | `PermissionHandler`                                   | —  | —           | 底层权限处理器（比 `canUseTool` 更低级）                       |
| `canUseTool`      | `CanUseTool`                                            | —  | —           | 运行时权限决策回调                                         |
| `agents`          | `Record<string, AgentDefinition>`                       | —  | —           | 命名子代理定义                                           |
| `subagent`        | `SubagentInfo`                                          | —  | —           | 子代理上下文信息（内部使用）                                    |
| `hooks`           | `Partial<Record<SessionHookEvent, HookCallback[]>>`     | —  | —           | 生命周期 Hook 回调                                      |
| `defaultContext`  | `RuntimeContext`                                        | —  | `{}`        | 会话级默认运行时上下文                                       |
| `logger`          | `AgentLogger`                                           | —  | —           | 结构化日志适配器                                          |
| `storagePath`     | `string`                                                | —  | —           | 会话存储根路径；未设置时使用内存存储                              |
| `persistSession`  | `boolean`                                               | —  | `true`      | 有 `storagePath` 时是否启用消息历史持久化                         |
| `durableEventStore` | `DurableEventStore`                                  | —  | —           | opt-in durable 执行事件 Store                                 |
| `outputFormat`    | `OutputFormat`                                          | —  | —           | 结构化 JSON Schema 输出格式                              |
| `sandbox`         | `SandboxSettings`                                       | —  | —           | 命令执行沙箱设置                                          |
| `observability`   | `ObservabilityOptions`                                  | —  | —           | Trace 收集、payload 捕获与 sink 配置                         |

### SessionHookEvent

可用的 Hook 事件类型：

```ts
type SessionHookEvent =
  | 'PreToolUse'
  | 'PostToolUse'
  | 'PostToolUseFailure'
  | 'PermissionRequest'
  | 'UserPromptSubmit'
  | 'SessionStart'
  | 'SessionEnd'
  | 'TaskCompleted';
```

### Hook 回调签名

```ts
type HookCallback = (input: HookInput) => Promise<HookOutput>;

interface HookInput {
  event: HookEvent;
  toolName?: string;
  toolInput?: JsonObject;
  toolOutput?: ToolModelContent;
  error?: Error;
  sessionId: SessionId;
  [key: string]: unknown;
}

interface HookOutput {
  action: 'continue' | 'skip' | 'abort';
  modifiedInput?: JsonObject | string;
  modifiedOutput?: JsonValue;
  reason?: string;
}
```

### Hook 使用示例

```ts
import { createSession, HookEvent } from '@blade-ai/agent-sdk';

const session = await createSession({
  provider: { type: 'anthropic', apiKey: process.env.ANTHROPIC_API_KEY },
  model: 'claude-sonnet-4-20250514',
  hooks: {
    [HookEvent.PreToolUse]: [
      async (input) => {
        console.log(`[Hook] 即将执行工具: ${input.toolName}`);
        return { action: 'continue' };
      },
    ],
    [HookEvent.PostToolUse]: [
      async (input) => {
        console.log(`[Hook] 工具执行完成: ${input.toolName}`);
        return { action: 'continue' };
      },
    ],
    [HookEvent.SessionStart]: [
      async (input) => {
        console.log(`[Hook] 会话启动: ${input.sessionId}`);
        return { action: 'continue' };
      },
    ],
    [HookEvent.UserPromptSubmit]: [
      async (input) => {
        const userPrompt = input.userPrompt as string;
        if (userPrompt.length > 10000) {
          return { action: 'abort', reason: '消息过长，请精简后重试' };
        }
        return { action: 'continue' };
      },
    ],
  },
});
```

## ISession 接口完整参考

```ts
interface ISession extends AsyncDisposable {
  /** 会话唯一标识符 */
  readonly sessionId: SessionId;

  /** 当前会话的消息历史（只读副本） */
  readonly messages: Message[];

  /** Session 是否已永久关闭 */
  readonly isClosed: boolean;

  /**
   * 提交用户消息；空闲时启动请求，活动时按 priority 转向或排队
   * 支持纯文本字符串或多模态内容数组（ContentPart[]）
   */
  send(message: UserMessageContent, options?: SendOptions): Promise<InputSubmission>;

  /** 获取尚未应用的输入快照 */
  getPendingInputs(): readonly PendingSessionInput[];

  /** 取消尚未被 AgentLoop claim 的输入 */
  cancelInput(inputId: InputId): Promise<boolean>;

  /**
   * 异步迭代消费 Agent 输出流
   * 必须在 send() 之后调用
   */
  stream(options?: StreamOptions): AsyncGenerator<StreamMessage>;

  /** 关闭会话并释放所有资源 */
  close(): Promise<void>;

  /** 中止当前正在进行的请求 */
  abort(): Promise<void>;

  /** 获取当前默认运行时上下文 */
  getDefaultContext(): RuntimeContext;

  /** 设置默认运行时上下文 */
  setDefaultContext(context: RuntimeContext): void;

  /** 运行时切换权限模式 */
  setPermissionMode(mode: PermissionMode): void;

  /** 运行时切换模型 */
  setModel(model: string): Promise<void>;

  /** 更新最大轮次 */
  setMaxTurns(maxTurns: number): void;

  /** 查询支持的模型列表 */
  supportedModels(): Promise<ModelInfo[]>;

  /** 获取所有 MCP 服务器的连接状态 */
  mcpServerStatus(): Promise<McpServerStatus[]>;

  /** 连接指定的 MCP 服务器 */
  mcpConnect(serverName: string): Promise<void>;

  /** 断开指定的 MCP 服务器 */
  mcpDisconnect(serverName: string): Promise<void>;

  /** 重新连接指定的 MCP 服务器 */
  mcpReconnect(serverName: string): Promise<void>;

  /** 列出所有 MCP 工具 */
  mcpListTools(): Promise<McpToolInfo[]>;

  /** 从当前会话创建分叉 */
  fork(options?: ForkSessionOptions): Promise<ISession>;

  /** 获取最近一条或全部 observability trace */
  getLastTrace(): AgentTrace | undefined;
  getTraces(): AgentTrace[];
  getDurableProjection(): DurableSessionProjection | null;
  getDurableRecoveryPlan(): DurableSessionRecoveryPlan | null;
}
```

### 顶层导出函数

```ts
/** 创建新会话 */
function createSession(options: SessionOptions): Promise<ISession>;

/** 恢复已持久化的会话 */
function resumeSession(options: ResumeOptions): Promise<ISession>;

/** 从已持久化的会话创建分叉 */
function forkSession(options: ForkOptions): Promise<ISession>;

/** 一次性请求（自动创建和销毁会话） */
function prompt(
  message: Parameters<ISession['send']>[0],
  options: SessionOptions,
): Promise<PromptResult>;
```

### 完整类型导出一览

```ts
// 函数
export { createSession, resumeSession, forkSession, prompt };

// 类型
export type {
  SessionOptions,
  SendOptions,
  InputSubmission,
  PendingSessionInput,
  InputPriority,
  InputId,
  RequestId,
  StreamOptions,
  StreamMessage,
  ISession,
  ProviderConfig,
  ProviderType,
  PromptResult,
  ToolCallRecord,
  TokenUsage,
  AgentDefinition,
  SubagentInfo,
  ForkSessionOptions,
  ForkSessionResult,
  ForkOptions,
  ResumeOptions,
  ModelInfo,
  McpServerStatus,
  McpToolInfo,
  HookCallback,
  HookInput,
  HookOutput,
  RuntimeContext,
  RuntimePatch,
  RuntimeContextPatch,
  ContextSnapshot,
  ToolDefinition,
  ToolResult,
  ExecutionContext,
  OutputFormat,
  McpServerConfig,
  SandboxSettings,
  CanUseTool,
  CanUseToolOptions,
  PermissionResult,
  PermissionHandler,
  PermissionUpdate,
  AgentLogger,
};

// 常量枚举
export {
  PermissionMode,
  InputPriority,
  HookEvent,
  StreamMessageType,
  ToolKind,
  MessageRole,
  PermissionDecision,
};
```
