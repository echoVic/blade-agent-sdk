# 工具系统

SDK 提供三种方式创建自定义工具，从简单到完整：

| 方式 | 函数 | Schema | 适用场景 |
|------|------|--------|----------|
| 简单模式 | `defineTool()` | JSON Schema | 快速定义，直接传给 Session |
| 工厂模式 | `createTool()` | Zod Schema | 需要类型推断和参数验证 |
| 转换模式 | `toolFromDefinition()` | JSON Schema | 将 ToolDefinition 转为内部 Tool 对象 |

## defineTool

最简单的工具定义方式，原样返回传入的定义。适合直接传给 `SessionOptions.tools`。

```ts
import { defineTool, ToolKind } from '@blade-ai/agent-sdk';

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

使用 Zod Schema 的工厂函数，提供完整的类型推断和运行时验证。

```ts
import { z } from 'zod';
import { createTool, ToolKind } from '@blade-ai/agent-sdk';

const deployTool = createTool({
  name: 'Deploy',
  displayName: 'Deploy',
  kind: ToolKind.Execute,
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

| 分类 | 工具名 | Kind | 说明 |
|------|--------|------|------|
| **文件** | Read | readonly | 读取文件内容 |
| | Edit | write | 搜索替换编辑文件 |
| | Write | write | 写入/创建文件 |
| | NotebookEdit | write | 编辑 Jupyter Notebook |
| **搜索** | Glob | readonly | 文件名模式匹配搜索 |
| | Grep | readonly | 文件内容正则搜索 |
| **Shell** | Bash | execute | 执行 Shell 命令 |
| | KillShell | execute | 终止 Shell 进程 |
| **网络** | WebFetch | readonly | 抓取网页内容 |
| | WebSearch | readonly | 搜索互联网 |
| **子任务** | Task | execute | 创建子任务（子 Agent） |
| | TaskOutput | readonly | 获取子任务输出 |
| **结构化任务** | TaskCreate | execute | 创建结构化任务条目 |
| | TaskGet | readonly | 获取任务详情 |
| | TaskUpdate | execute | 更新任务状态 |
| | TaskList | readonly | 列出所有任务 |
| | TaskStop | execute | 停止后台任务或后台 Agent |
| **系统** | AskUserQuestion | readonly | 向用户提问 |
| | DiscoverTools | readonly | 发现并搜索可用工具 |
| | Skill | execute | 调用 Skill 脚本 |
| **计划** | EnterPlanMode | readonly | 进入计划模式 |
| | ExitPlanMode | readonly | 退出计划模式 |
| **待办** | TodoWrite | readonly | 管理待办事项 |
| **MCP** | ListMcpResources | readonly | 列出 MCP 资源（需连接 MCP） |
| | ReadMcpResource | readonly | 读取 MCP 资源（需连接 MCP） |

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
interface ToolDefinition<TParams = Record<string, unknown>> {
  name: string;
  displayName?: string;
  description: string | ToolDescription;
  parameters: unknown;
  kind?: ToolKind;     // 'readonly' | 'write' | 'execute'
  execute: (params: TParams, context: ExecutionContext) => ToolExecution;
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

::: warning data 必须可 JSON 序列化
`data` 会被序列化落盘（结果产物存储），因此其类型约束为 `JsonValue`。若你的领域类型是 `interface`（无索引签名），赋给 `data` 时可能报「缺少索引签名」。解决办法是让该类型满足 `JsonValue`（字段均为 JSON 值），不要用 `as unknown` 强绕过——那会把「运行时序列化失败」的风险藏起来。
:::

### 为工具参数与 data 提供类型

`defineTool` 支持两个可选泛型：`TParams`（参数类型）与 `TData`（`data` 字段类型，须 `extends JsonValue`）。指定后 `execute` 的 `params` 与返回的 `data` 都会得到精确类型，无需在 `execute` 内部做 `as` 断言：

```ts
import { defineTool, ToolKind } from '@blade-ai/agent-sdk';

const tool = defineTool<{ query: string; limit?: number }, { count: number }>({
  name: 'SearchDocs',
  description: '搜索文档库',
  kind: ToolKind.ReadOnly,
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
  sessionId?: string;
  messageId?: string;
  contextSnapshot?: ContextSnapshot;
  signal?: AbortSignal;
  confirmationHandler?: ConfirmationHandler;
  permissionMode?: PermissionMode;
  bladeConfig?: BladeConfig;
}
```

### 工具中断策略

`interruptBehavior` 控制工具收到 `priority: 'now'` 的 steering 时是否取消：

```ts
const tool = createTool({
  // ...
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

内置的 `Read`、`Glob`、`Grep`、`WebFetch`、`WebSearch` 和前台 `Bash` 明确声明为 `cancel`；后台 `Bash` 及其他内置工具为 `block`。动态 MCP 工具默认 `block`。
