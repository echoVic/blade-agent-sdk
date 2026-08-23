# 工具系统

SDK 提供三种方式创建自定义工具，从简单到完整：

| 方式 | 函数 | Schema | 适用场景 |
|------|------|--------|----------|
| 简单模式 | `defineTool()` | JSON Schema | 快速定义，可直接传给 Session |
| 工厂模式 | `createTool()` | Zod Schema | 完整类型推断、运行时验证和中断策略 |
| 转换模式 | `toolFromDefinition()` | JSON Schema | 将 ToolDefinition 转为内部 Tool 对象 |

## defineTool

最简单的工具定义方式，原样返回传入的定义。适合直接传给 `SessionOptions.tools`。

```ts
import { defineTool, ToolKind, ToolSideEffect } from '@blade-ai/agent-sdk';

const searchTool = defineTool({
  name: 'SearchDocs',
  description: '搜索文档库',
  parameters: {
    type: 'object',
    properties: {
      query: { type: 'string', description: '搜索关键词' },
      limit: { type: 'number', description: '返回数量' },
    },
    required: ['query'],
  },
  kind: ToolKind.ReadOnly,
  sideEffect: ToolSideEffect.PURE,
  async *execute(params) {
    const results = await searchDocuments(params.query, params.limit ?? 10);
    yield {
      kind: 'progress',
      message: '文档搜索完成',
      data: { count: results.length },
    };
    return {
      status: 'success',
      model: JSON.stringify(results),
      display: { summary: `找到 ${results.length} 条文档` },
      // 可选：结构化数据（必须是 JSON 值），供调用方消费
      data: { count: results.length },
    };
  },
});
```

::: tip
`kind` 使用 `ToolKind` 枚举（`ToolKind.ReadOnly` / `ToolKind.Write` / `ToolKind.Execute`），从 `@blade-ai/agent-sdk` 导入。TypeScript 下不接受裸字符串字面量。
:::

## createTool

使用 Zod Schema 的工厂函数，提供完整的类型推断、运行时验证和工具行为配置。
返回的 `Tool` 可以直接放入 `SessionOptions.tools`，Session 会保留原实例，
不会再次适配或丢失行为。

```ts
import { z } from 'zod';
import { createTool, ToolKind, ToolSideEffect } from '@blade-ai/agent-sdk';

const deployTool = createTool({
  name: 'Deploy',
  displayName: 'Deploy',
  kind: ToolKind.Execute,
  sideEffect: ToolSideEffect.NON_IDEMPOTENT,
  description: {
    short: '部署应用到指定环境',
    long: '支持 staging 和 production 环境的自动部署',
    usageNotes: ['需要先通过 CI 测试'],
    important: ['production 部署需要人工确认'],
  },
  schema: z.object({
    environment: z.enum(['staging', 'production']).describe('目标环境'),
    version: z.string().describe('部署版本号'),
  }),
  async *execute(params, context) {
    yield {
      kind: 'progress',
      message: '正在部署',
      data: { environment: params.environment, version: params.version },
    };
    return {
      status: 'success',
      model: `已部署 v${params.version} 到 ${params.environment}`,
      display: { summary: `部署完成: ${params.environment}` },
    };
  },
});
```

## toolFromDefinition

将 `ToolDefinition` 转换为内部 `Tool` 对象。一般在需要直接操作 Tool 接口时使用。

```ts
function toolFromDefinition<TParams>(definition: ToolDefinition<TParams>): Tool<TParams>
```

## getBuiltinTools

获取 SDK 所有内置工具列表。

```ts
function getBuiltinTools(opts?: {
  sessionId?: string;
  configDir?: string;
  mcpRegistry?: McpRegistry;
  includeMcpProtocolTools?: boolean;
  memoryManager?: MemoryManager;
  subagentRegistry?: SubagentRegistry;
}): Promise<Tool[]>
```

`MemoryRead` 和 `MemoryWrite` 默认不会注册。只有在显式传入 `memoryManager` 时才会加入内置工具集合。

```ts
import {
  FileSystemMemoryStore,
  MemoryManager,
  SubagentRegistry,
  getBuiltinTools,
} from '@blade-ai/agent-sdk';

const tools = await getBuiltinTools({
  memoryManager: new MemoryManager(new FileSystemMemoryStore('/tmp/blade-memory')),
  subagentRegistry: new SubagentRegistry(),
});
```

## 内置工具列表

SDK 内置 23 个标准工具，连接 MCP 后额外提供 2 个资源工具：

| 分类 | 工具名 | Kind | Side effect | 说明 |
|------|--------|------|-------------|------|
| **文件** | Read | readonly | pure | 读取文件内容 |
| | Edit | write | non_idempotent | 搜索替换编辑文件 |
| | Write | write | idempotent | 写入/创建文件 |
| | NotebookEdit | write | non_idempotent | 编辑 Jupyter Notebook；replace 调用动态收窄为 idempotent |
| **搜索** | Glob | readonly | pure | 文件名模式匹配搜索 |
| | Grep | readonly | pure | 文件内容正则搜索 |
| **Shell** | Bash | execute | non_idempotent | 执行 Shell 命令；只读前台命令动态收窄为 pure |
| | KillShell | execute | idempotent | 终止 Shell 进程 |
| **网络** | WebFetch | execute | non_idempotent | GET/HEAD 动态收窄为 pure，PUT/DELETE 为 idempotent |
| | WebSearch | readonly | pure | 搜索互联网 |
| **子任务** | Task | readonly | non_idempotent | 创建子任务（子 Agent） |
| | TaskOutput | readonly | non_idempotent | 获取并消费子任务输出 |
| **结构化任务** | TaskCreate | write | non_idempotent | 创建结构化任务条目 |
| | TaskGet | write | pure | 获取任务详情 |
| | TaskUpdate | write | idempotent | 更新任务状态 |
| | TaskList | write | pure | 列出所有任务 |
| | TaskStop | write | idempotent | 停止后台任务或后台 Agent |
| **系统** | AskUserQuestion | readonly | non_idempotent | 向用户提问 |
| | DiscoverTools | readonly | idempotent | 发现并搜索可用工具 |
| | Skill | execute | non_idempotent | 调用 Skill 脚本 |
| **计划** | EnterPlanMode | readonly | non_idempotent | 进入计划模式 |
| | ExitPlanMode | readonly | non_idempotent | 退出计划模式 |
| **待办** | TodoWrite | readonly | idempotent | 管理待办事项 |
| **MCP** | ListMcpResources | readonly | pure | 列出 MCP 资源（需连接 MCP） |
| | ReadMcpResource | readonly | pure | 读取 MCP 资源（需连接 MCP） |

::: tip
`Task` 使用当前 session 的 `SubagentRegistry`。`DiscoverTools` 允许 LLM 搜索和发现可用工具。`MemoryRead` / `MemoryWrite` 属于 opt-in 工具，不在默认列表中。
:::

::: info 工具排序
SDK 发送给 LLM 的工具列表按以下规则排序：**内置工具在前，MCP 工具在后**，每组内按名称字母序排列。这意味着内置工具在 LLM 的上下文中优先级更高。
:::

## 工具筛选

```ts
// 只启用指定工具
const session = await createSession({
  // ...provider, model
  allowedTools: ['Read', 'Edit', 'Write', 'Glob', 'Grep'],
});

// 排除危险工具
const session2 = await createSession({
  // ...provider, model
  disallowedTools: ['Bash', 'KillShell'],
});
```

## 核心类型

### ToolDefinition

```ts
interface ToolDefinition<
  TParams = JsonObject,
  TData extends JsonValue = JsonValue,
> {
  name: string;
  aliases?: string[];
  displayName?: string;
  description: string | ToolDescription;
  parameters: JSONSchema7;
  sideEffect: ToolSideEffect;
  kind?: ToolKind;
  category?: string;
  tags?: string[];
  exposure?: ToolExposureConfig;
  execute: (
    params: TParams,
    context: ExecutionContext,
  ) => ToolExecution<TData>;
}
```

### ToolDescription

```ts
interface ToolDescription {
  short: string;
  long?: string;
  usageNotes?: string[];
  examples?: Array<{ description: string; params: Record<string, unknown> }>;
  important?: string[];
}
```

### ToolResult

`ToolResult` 是成功与失败两种结果的判别联合：

```ts
type ToolResult = ToolSuccessResult | ToolFailureResult;
type ToolModelContent = JsonValue;

interface ToolSuccessResult {
  status: 'success';
  model: ToolModelContent;       // 返回给模型的 JSON 内容
  display?: ToolDisplayContent;  // 返回给 UI 的内容
  data?: JsonValue;              // 可选：结构化数据（必须是 JSON 值）
  metadata?: ToolResultMetadata;
}

interface ToolFailureResult {
  status: 'error';
  model: ToolModelContent;
  display?: ToolDisplayContent;
  error: ToolError;              // 失败时必填
  metadata?: ToolResultMetadata;
}
```

`model` 只用于回写模型上下文，`display` 只用于 UI 展示，两者不应互相解析。`model` 和 `data` 都必须是严格的 JSON 值。失败时 `status: 'error'` 且必须带 `error`。

### ToolYield 与 ToolExecution

工具执行是一个有类型终值的异步生成器。过程中可以按真实发生顺序产生进度、展示消息和运行时 effect，最后返回一个 `ToolResult`：

```ts
type ToolYield =
  | {
      kind: 'progress';
      message?: string;
      data?: JsonValue;
      completed?: number;
      total?: number;
      resumeToken?: string;
    }
  | { kind: 'message'; content: ToolDisplayContent }
  | { kind: 'effect'; effect: ToolEffect };

type ToolExecution = AsyncGenerator<ToolYield, ToolResult, void>;
```

不产生中间事件的工具也必须返回 `ToolExecution`，可使用 `completeToolExecution(result)`。需要只消费最终结果时使用 `collectToolExecution(execution)`。

::: warning data 必须是 JSON 值
`data` 是供调用方消费的结构化结果，类型约束为 `JsonValue`。大型结果的
artifact 落盘针对 `model` 内容，并不单独持久化 `data`。若领域 interface
缺少索引签名，可在边界显式转换为 JSON 对象，不要用 `as unknown` 绕过。
:::

### 为工具参数与 data 提供类型

`defineTool` 支持两个可选泛型：`TParams`（参数类型）与 `TData`（`data` 字段类型，须 `extends JsonValue`）。指定后 `execute` 的 `params` 与返回的 `data` 都会得到精确类型，无需在 `execute` 内部做 `as` 断言：

```ts
import { defineTool, ToolKind, ToolSideEffect } from '@blade-ai/agent-sdk';

const tool = defineTool<{ query: string; limit?: number }, { count: number }>({
  name: 'SearchDocs',
  description: '搜索文档库',
  kind: ToolKind.ReadOnly,
  sideEffect: ToolSideEffect.PURE,
  parameters: {
    type: 'object',
    properties: {
      query: { type: 'string' },
      limit: { type: 'number' },
    },
    required: ['query'],
  },
  async *execute(params) {
    // params.query: string, params.limit?: number —— 无需 cast
    const results = await searchDocuments(params.query, params.limit ?? 10);
    return {
      status: 'success',
      model: JSON.stringify(results),
      display: { summary: `找到 ${results.length} 条结果` },
      data: { count: results.length },
    };
  },
});
```

带具体 `TParams` 的工具可以直接放进 `SessionOptions.tools`，无需断言。

### ExecutionContext

```ts
interface ExecutionContext {
  userId?: string;
  sessionId?: SessionId;
  messageId?: MessageId;
  contextSnapshot?: ContextSnapshot;
  skillActivationPaths?: string[];
  signal?: AbortSignal;
  confirmationHandler?: ConfirmationHandler;
  permissionMode?: PermissionMode;
  bladeConfig?: BladeConfig;
  backgroundAgentManager?: IBackgroundAgentManager;
  toolRegistry?: ToolRegistry;
  toolCatalog?: ToolCatalog;
  discoveredTools?: string[];
  toolInvocationLifecycle?: ToolInvocationLifecycle; // runtime 内部注入
}
```

```ts
interface ConfirmationDetails {
  // ...
  abortSignal?: AbortSignal;
}

interface ConfirmationHandler {
  requestConfirmation(
    details: ConfirmationDetails,
  ): Promise<ConfirmationResponse>;
}
```

### Durable lifecycle 边界

Runtime 可以通过 `ToolExecutionLifecycle` 观察并阻塞工具的关键持久化边界：

```ts
interface ToolExecutionLifecycle {
  onToolScheduled?(
    event: ToolScheduledLifecycle,
  ): Promise<ToolInvocationLifecycle | undefined>;
  onToolSettled?(event: ToolSettledLifecycle): Promise<void>;
}

interface ToolScheduledLifecycle {
  toolCallId: ToolUseId;
  toolName: string;
  modelAttemptId?: ModelAttemptId;
  modelInput: JsonObject; // provider 原始参数
  input: JsonObject;
  sideEffect: ToolSideEffect;
  interruptBehavior: 'block' | 'cancel';
}

interface ToolExecutionStartedLifecycle {
  input: JsonObject;
  sideEffect: ToolSideEffect;
}

interface ToolInvocationLifecycle {
  onPermissionRequested?(
    details: ConfirmationDetails,
    input: JsonObject,
  ): Promise<PermissionRequestId>;
  onPermissionResolved?(
    resolution: ToolPermissionResolution,
  ): Promise<void>;
  onExecutionStarted?(
    event: ToolExecutionStartedLifecycle,
  ): Promise<void>;
}
```

这些回调不是 best-effort telemetry。执行顺序固定为：

1. `onToolScheduled` 完成后才发布 `tool_start`。
2. `onPermissionRequested` 完成后才调用交互式确认处理器。
3. `onPermissionResolved` 完成后才接受权限决定。
4. `onExecutionStarted` 持久化权限处理后的最终输入和副作用等级；完成后才调用工具 generator，因此 durable 写失败不会放行副作用。
5. `onToolSettled` 完成后才发布 `tool_result`。

无效 JSON 参数和从未派发的 synthetic interruption result 不会进入 durable
lifecycle，因为它们尚未形成可执行调用。未配置 lifecycle observer 时行为与
普通工具执行一致。

### 副作用契约

每个 `ToolDefinition`、`ToolConfig` 和完整 `Tool` 都必须显式声明
`sideEffect`：

- `pure`：不改变外部状态，可以在恢复时重放。
- `idempotent`：相同参数重复执行会达到相同目标状态，可以在恢复时重放。
- `non_idempotent`：重复执行可能产生额外副作用，started 后必须人工或外部系统对账。

`ToolKind`、`isReadOnly` 与 `sideEffect` 是不同维度，SDK 不会相互推断。参数相关
工具可以用 `resolveBehavior()` 收窄契约，但静态声明必须采用最保守值。动态
MCP 工具始终按 `non_idempotent` 处理；远端 annotations 只是 hint，不能单独
作为自动重放的安全依据。

### 工具中断策略

`interruptBehavior` 控制工具收到 `priority: 'now'` 的 steering 时是否取消：

```ts
const tool = createTool({
  // ...
  sideEffect: ToolSideEffect.IDEMPOTENT,
  interruptBehavior: 'cancel',
  async *execute(params, context) {
    context.signal?.throwIfAborted();
    // ...
  },
});
```

- `block` 是默认值。工具继续完成，结果落盘后再应用 steering，适合写文件、状态变更和不可撤销的外部调用。
- `cancel` 仅用于真正监听 `context.signal`、能安全停止并在 `finally` 中释放资源的工具。
- Session 的显式 `abort()` 和 `close()` 属于请求级终止，不受 `block` 限制。
  两者都会等待活动工具完成清理，因此自定义工具即使阻止 `now` 转向，也必须监听
  request `AbortSignal`。

`SessionOptions.toolTimeoutMs` 限制每次工具调用的总时长，默认值为 `600000`
（10 分钟）。时限从权限检查及 durable `tool_started` 边界完成后开始，在
progress yield 之间持续计时，并在到期时中止工具的 signal。终态结果的错误类型为
`ToolErrorType.TIMEOUT_ERROR`。SDK 最多等待工具清理 5 秒；若清理仍未结束，
pipeline 会拒绝新的工具执行，Session 关闭或 handoff 也会 fail-closed，直至
generator 退出。JavaScript 无法强制抢占忽略取消信号的自定义工具代码。

权限等待采用取消边界而不是固定超时，因为人工审批可以合理地长时间保持打开。
输入校验和工具级权限检查通过 `ExecutionContext.signal` 接收信号，
`permissionHandler` 与 `canUseTool` 通过 `request.signal` 接收信号，交互式
处理器通过 `ConfirmationDetails.abortSignal` 接收信号。Pipeline 会将每个回调
与该 Request 信号竞速；回调应在信号中止时停止工作。若回调忽略信号，Request
仍会完成取消，但新的工具调用以及 Session close/handoff 会 fail-closed，直至
该回调 Promise 结束。已持久化的权限请求会先以 `decision: 'cancel'` 完成解析。

并发槽位与同文件锁的等待也发生在工具时限开始之前，但都会监听当前 Request
信号。取消会从 FIFO 队列中移除 waiter，不占用配额，也不打乱其他请求的顺序。
若资源授予与取消发生在同一轮事件循环，pipeline 会再次检查信号，并在返回取消
结果前释放已取得的所有 lease。

`interruptBehavior` 属于 `createTool()` 的 `ToolConfig`，轻量
`defineTool()` / `ToolDefinition` 不暴露该字段。需要让 Session 中的自定义
工具响应 `now` 转向时，应使用 `createTool()` 并声明 `cancel`。

内置的 `Read`、`Glob`、`Grep`、`WebFetch`、`WebSearch` 和前台 `Bash` 明确声明为 `cancel`；后台 `Bash` 及其他内置工具为 `block`。动态 MCP 工具默认 `block`。
