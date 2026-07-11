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
  execute: async (params) => {
    const results = await searchDocuments(params.query, params.limit ?? 10);
    return {
      success: true,
      llmContent: JSON.stringify(results),
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
  execute: async (params, context) => {
    return {
      success: true,
      llmContent: `已部署 v${params.version} 到 ${params.environment}`,
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

获取当前 package-local adapter 已迁移的内置工具。当前 baseline 只包含 opt-in 的 `MemoryRead` 和 `MemoryWrite`；没有传入 `memoryManager` 时返回空数组。

```ts
function getBuiltinTools(opts?: {
  memoryManager?: MemoryManager;
}): Promise<Tool[]>
```

Root `createSession()` 不会自动注册 Node-local builtin tools。只有显式传入 `memoryManager` 调用 `/local` helper 时，`MemoryRead` 和 `MemoryWrite` 才会出现在返回集合中；返回的预构建 `Tool[]` 可以直接传给 `SessionOptions.tools`，不需要转换回 `ToolDefinition`。完整 Read/Edit/Write/Bash/Task 工具套件仍是后续 local-runtime migration，不属于当前发布包的默认能力。

```ts
import { createSession } from '@blade-ai/agent-sdk';
import {
  FileSystemMemoryStore,
  MemoryManager,
  getBuiltinTools,
} from '@blade-ai/agent-sdk/local';

const tools = await getBuiltinTools({
  memoryManager: new MemoryManager(new FileSystemMemoryStore('/tmp/blade-memory')),
});

const session = await createSession({
  provider: { type: 'openai', apiKey: process.env.OPENAI_API_KEY! },
  model: 'gpt-4o-mini',
  tools,
});
```

## 当前 local builtin 列表

| 工具名 | Kind | 启用条件 |
| --- | --- | --- |
| `MemoryRead` | readonly | `getBuiltinTools({ memoryManager })` |
| `MemoryWrite` | write | `getBuiltinTools({ memoryManager })` |

## 工具筛选

```ts
// 只启用已显式注册的 custom tool
const session = await createSession({
  // ...provider, model
  tools: [searchTool, deployTool],
  allowedTools: ['SearchDocs'],
});

// 在已注册工具中排除指定工具
const session2 = await createSession({
  // ...provider, model
  tools: [searchTool, deployTool],
  disallowedTools: ['Deploy'],
});
```

## 核心类型

### SessionTool

```ts
type SessionTool = ToolDefinition | Tool;
```

`ToolDefinition` 会由 session runtime 转换为 `Tool`；通过 `createTool()` 或 `/local` adapter 得到的预构建 `Tool` 会直接注册，不会重复包装。

通过 `SessionOptions.tools` 显式传入的两种形式都按 session `custom/workspace` 来源登记，不会因为工具由 `/local` helper 创建就自动提升为 `builtin/trusted`。需要按来源过滤时，应把这类显式注入工具视为 custom tools。

### ToolDefinition

```ts
interface ToolDefinition<TParams = Record<string, unknown>> {
  name: string;
  displayName?: string;
  description: string | ToolDescription;
  parameters: unknown;
  kind?: ToolKind;     // 'readonly' | 'write' | 'execute'
  execute: (params: TParams, context: ExecutionContext) => Promise<ToolResult>;
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

interface ToolSuccessResult {
  success: true;
  llmContent: string | object;   // 返回给 LLM 的内容
  data?: JsonValue;              // 可选：结构化数据（必须是 JSON 值）
  metadata?: ToolResultMetadata;
}

interface ToolFailureResult {
  success: false;
  llmContent: string | object;
  error: ToolError;              // 失败时必填
  metadata?: ToolResultMetadata;
}
```

`llmContent` 是给 LLM 消费的内容；如需返回结构化数据用 `data`（其类型为 `JsonValue`，因此自定义对象数组等需保证可 JSON 序列化）。失败时 `success: false` 且必须带 `error`。

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
  execute: async (params) => {
    // params.query: string, params.limit?: number —— 无需 cast
    const results = await searchDocuments(params.query, params.limit ?? 10);
    return { success: true, llmContent: JSON.stringify(results), data: { count: results.length } };
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
  onProgress?: (message: string) => void;
  updateOutput?: (output: string) => void;
  confirmationHandler?: ConfirmationHandler;
  permissionMode?: PermissionMode;
  bladeConfig?: BladeConfig;
}
```
