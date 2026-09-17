# 工具系统

SDK 使用 `defineTool()` 作为唯一的自定义工具声明入口。参数 schema 使用
TypeBox，返回的 `ToolDefinition` 可以直接传给 Agent 或 Session。

## defineTool

`execute` 必须返回业务 JSON 数据的 Promise，该值会自动包装为内部 generator；
默认值（例如省略的
`sideEffect`）由 Session Registry 编译工具时补齐。

```ts
import { defineTool } from '@blade-ai/agent-sdk';
import Type from 'typebox';

const searchTool = defineTool({
  name: 'SearchDocs',
  description: '搜索文档库',
  parameters: Type.Object({
    query: Type.String({ description: '搜索关键词' }),
    limit: Type.Optional(Type.Number({ description: '返回数量' })),
  }),
  async execute(params) {
    const results = await searchDocuments(params.query, params.limit ?? 10);
    return { results, count: results.length };
  },
});
```

返回的 JSON 值会成为成功结果的 `model` 和 `data`。自定义工具通过抛出异常报告
失败，不接受 `ToolResult` 或 async generator，避免根据返回对象形状猜测语义。

TypeBox schema 是参数类型、运行时校验与模型侧 JSON Schema 的单一事实源。
`execute` 参数由 `Type.Static<TSchema>` 自动推导；异构工具集合的类型擦除只发生在
Session 内部，应用代码不需要声明该内部类型。

### 可以省略什么

`defineTool` 只有 `name`、`description`、`parameters` 和 `execute` 是必填的：

- **`sideEffect` 可省略**，省略时按 `non_idempotent` 处理，也就是恢复时**绝不重放**这个工具。
  只读或可安全重试的工具请显式声明 `ToolSideEffect.PURE` 或 `ToolSideEffect.IDEMPOTENT`，
  这样才能进入可重试的恢复集合。
- **`parameters` 接受 TypeBox schema**。同一个 schema 对象会直接发给模型，并由
  SDK 编译为运行时 validator；不存在 Zod/JSON Schema 互转或只声明不校验的旁路。

```ts
import { defineTool } from '@blade-ai/agent-sdk';
import Type from 'typebox';

const lookup = defineTool({
  name: 'Lookup',
  description: '按 ID 查询一条记录',
  parameters: Type.Object({ id: Type.String() }),
  async execute({ id }) {
    return await lookupRecord(id);
  },
});
```

::: tip
`kind` 和 `sideEffect` 都可以省略，但如果要写 `kind`，请使用 `ToolKind` 常量
（`ToolKind.ReadOnly` / `ToolKind.Write` / `ToolKind.Execute`），从 `@blade-ai/agent-sdk`
导入：TypeScript 下不接受裸字符串字面量。
:::

### 按需能力

`services` 声明工具需要的 Session 服务，`execute` 只能访问已声明的服务。
`requiresRuntime: true` 显式开放执行租约与 fence 能力：

```ts
const delegated = defineTool({
  name: 'Delegate',
  description: '委派任务',
  parameters: Type.Object({ prompt: Type.String() }),
  services: ['subagentRegistry'],
  requiresRuntime: true,
  async execute({ prompt }, context) {
    await context.runtime.assertExecutionLease();
    return { prompt, agents: context.subagentRegistry.getAllNames() };
  },
});
```

合法服务名由 `ToolServiceName` 限定。Session 缺少任一声明服务时不会注册该工具，
也不会向工具暴露未声明的服务。普通工具的 `execute` 类型和实际运行上下文都没有
`runtime`。

## getBuiltinTools

获取 SDK 所有内置工具列表。

```ts
function getBuiltinTools(opts?: {
  mcpRegistry?: McpRegistry;
  includeMcpProtocolTools?: boolean;
}): Promise<Tool[]>
```

`getBuiltinTools()` 从 `/advanced` 导出；其 local Session 会自动注册 Coding
Agent 工具集合。返回值包含所有静态内置工具候选；Session Registry 会跳过缺少
声明 service 的工具。`MemoryRead` 和 `MemoryWrite` 只有在
`SessionOptions.memoryManager` 存在时才会注册。
直接调用返回工具的 `execute()` 会绕过 `ExecutionPipeline`。已有文件的
`Write`/`Edit` 仍要求 `ExecutionContext.sessionId`，否则无法验证
read-before-write，并会 fail closed。

```ts
import { getBuiltinTools } from '@blade-ai/agent-sdk/advanced';

const tools = await getBuiltinTools();
```

## 社区工具包约定

可复用的第三方工具包使用 `blade-tool-*` 命名：

- 非 scoped 包：`blade-tool-github`
- scoped 包：`@acme/blade-tool-jira`
- 名称必须为小写 kebab-case，并描述能力或目标系统，不能使用含糊名称。

包的根入口应导出一个命名工厂（例如 `createGithubTool`）或一个稳定的 `tools`
数组。不要导入 SDK 的 `src/`、`dist/` chunk 或其他私有路径；工具作者只能依赖
根入口公开的 `defineTool`、类型和常量。

```json
{
  "name": "@acme/blade-tool-jira",
  "peerDependencies": {
    "@blade-ai/agent-sdk": "^7.4.0"
  }
}
```

发布前必须满足：

- 每个工具显式声明准确的 `sideEffect` 和 `interruptBehavior`。
- 参数使用 TypeBox schema；执行结果必须是可序列化数据。
- credential 由调用方注入，包内不得读取或内置隐式全局凭据。
- 网络工具必须执行协议、重定向与私网地址校验；文件工具必须遵守
  `ExecutionContext` 的 filesystem capability。
- 非幂等副作用不得自动重试；中止后必须释放进程、连接和临时资源。
- README 必须列出工具名、权限需求、环境变量、side effect 与最小使用示例。

## 内置工具列表

SDK 提供一个静态内置工具数组；连接 MCP 后还会追加远端动态工具：

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
| **Memory** | MemoryRead | readonly | pure | 读取配置的 Memory Store |
| | MemoryWrite | write | idempotent | 写入配置的 Memory Store |
| **MCP** | ListMcpResources | readonly | pure | 列出 MCP 资源（需连接 MCP） |
| | ReadMcpResource | readonly | pure | 读取 MCP 资源（需连接 MCP） |

::: tip
`Task` 使用当前 Session 的 `SubagentRegistry`。`DiscoverTools` 允许 LLM 搜索和发现可用工具。`MemoryRead` / `MemoryWrite` 属于 opt-in 工具，仅在配置 `SessionOptions.memoryManager` 后注册。
:::

内置工具的实现按能力边界共享四个窄核心：文件读写由
`file/operationCore.ts` 统一授权路径、写前校验与错误结果；`Glob`/`Grep`
由 `search/searchRunner.ts` 统一搜索路径和执行；`WebFetch`/`WebSearch` 由
`web/webRequest.ts` 统一超时、中止、代理与请求策略；结构化任务 CRUD
集中声明在 `task/taskCrud.ts`，并共同使用 `TaskStore`。

::: info 工具排序
SDK 发送给 LLM 的工具列表按以下规则排序：**内置工具在前，MCP 工具在后**，每组内按名称字母序排列。这意味着内置工具在 LLM 的上下文中优先级更高。
:::

`WebFetch` 默认只允许 `http:` 和 `https:`，并在连接时拒绝 loopback、link-local、
私网、保留地址以及解析到这些地址的 DNS 结果；每次重定向都会重新校验。可通过
`SessionOptions.webFetch` 或 `BladeConfig.webFetch` 配置 `allowedHosts`、
`blockedHosts`。只有受信任的本地部署才应设置 `allowPrivateNetwork: true`。

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
  TSchema extends Type.TSchema = Type.TSchema,
  TData extends JsonValue = JsonValue,
> {
  name: string;
  aliases?: string[];
  displayName?: string;
  description: string | ToolDescription;
  parameters: TSchema;
  sideEffect?: ToolSideEffect;
  kind?: ToolKind;
  group?: BuiltinToolGroup;
  exposure?: ToolExposureConfig;
  services?: readonly ToolServiceName[];
  requiresRuntime?: boolean;
  execute: (
    params: Type.Static<TSchema>,
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

`ToolExecution` 是 SDK 内部运行时协议。公开的 `defineTool()` 只接受返回
`Promise<JsonValue>` 的 async function，并由 Registry 编译为该协议；它不根据
返回值字段或迭代器方法猜测结果类型。

::: warning data 必须是 JSON 值
`data` 是供调用方消费的结构化结果，类型约束为 `JsonValue`。大型结果的
artifact 落盘针对 `model` 内容，并不单独持久化 `data`。若领域 interface
缺少索引签名，可在边界显式转换为 JSON 对象，不要用 `as unknown` 绕过。
:::

### 为工具参数与 data 提供类型

`defineTool` 从 TypeBox schema 自动推导参数类型。需要显式约束返回数据时，可传
`TSchema` 与 `TData` 两个泛型；通常直接依赖推导即可：

```ts
import { defineTool, ToolKind, ToolSideEffect } from '@blade-ai/agent-sdk';
import Type from 'typebox';

const parameters = Type.Object({
  query: Type.String(),
  limit: Type.Optional(Type.Number()),
});

const tool = defineTool<typeof parameters, { count: number }>({
  name: 'SearchDocs',
  description: '搜索文档库',
  kind: ToolKind.ReadOnly,
  sideEffect: ToolSideEffect.PURE,
  parameters,
  async execute(params) {
    // params.query: string, params.limit?: number —— 无需 cast
    const results = await searchDocuments(params.query, params.limit ?? 10);
    return { count: results.length };
  },
});
```

带具体 `TSchema` 的工具可以直接放进 `SessionOptions.tools`，无需断言。

### ExecutionContext

```ts
interface ExecutionContext {
  sessionId?: SessionId;
  messageId?: MessageId;
  contextSnapshot?: ContextSnapshot;
  signal?: AbortSignal;
  confirmationHandler?: ConfirmationHandler;
  permissionMode?: PermissionMode;
  bladeConfig?: BladeConfig;
}
```

通过 `services` 声明的 Session 服务会按需加入 authoring context。
`requiresRuntime: true` 时额外提供只读的 `context.runtime`；Registry、暴露规划器
和 durable lifecycle 不会直接暴露给工具。

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

每个工具都应声明准确的 `sideEffect`；`ToolDefinition` 省略该字段时按最保守的
`non_idempotent` 处理：

- `pure`：不改变外部状态，可以在恢复时重放。
- `idempotent`：相同参数重复执行会达到相同目标状态，可以在恢复时重放。
- `non_idempotent`：重复执行可能产生额外副作用，started 后必须人工或外部系统对账。

`ToolKind`、`isReadOnly` 与 `sideEffect` 是不同维度，SDK 不会相互推断。参数相关
工具可以用 `resolveBehavior()` 收窄契约，但静态声明必须采用最保守值。动态
MCP 工具始终按 `non_idempotent` 处理；远端 annotations 只是 hint，不能单独
作为自动重放的安全依据。

### 工具中断策略

`interruptBehavior` 控制工具收到 `priority: 'now'` 的 steering 时是否取消。
公开的 `defineTool()` 使用保守的 `block` 默认值：

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
`AgentOptions.advanced.permission` 与底层 `permissionHandler` 通过
`request.signal` 接收信号，交互式处理器通过
`ConfirmationDetails.abortSignal` 接收信号。Pipeline 会将每个回调与该 Request
信号竞速；回调应在信号中止时停止工作。若回调忽略信号，Request 仍会完成取消，
但新的工具调用以及 Session close/handoff 会 fail-closed，直至该回调 Promise
结束。已持久化的权限请求会先以 `decision: 'cancel'` 完成解析。

并发槽位与同文件锁的等待也发生在工具时限开始之前，但都会监听当前 Request
信号。取消会从 FIFO 队列中移除 waiter，不占用配额，也不打乱其他请求的顺序。
若资源授予与取消发生在同一轮事件循环，pipeline 会再次检查信号，并在返回取消
结果前释放已取得的所有 lease。

`defineTool()` / `ToolDefinition` 不暴露 `interruptBehavior`；自定义工具在显式
`session.abort()` 或 `session.close()` 时仍应监听 `context.signal` 并及时清理资源。

内置的 `Read`、`Glob`、`Grep`、`WebFetch`、`WebSearch` 和前台 `Bash` 明确声明为 `cancel`；后台 `Bash` 及其他内置工具为 `block`。动态 MCP 工具默认 `block`。

`Bash` 只会把简单且明确列入白名单的命令动态收窄为只读。管道、重定向、
heredoc、变量/命令替换、`eval`、shell 嵌套和未知命令均按有副作用执行处理。
分类器用于权限与调度提示，不是安全沙箱。
