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
import { defineTool } from '@blade-ai/agent-sdk';

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
  kind: 'readonly',
  execute: async (params) => {
    const results = await searchDocuments(params.query, params.limit ?? 10);
    return {
      success: true,
      llmContent: JSON.stringify(results),
      displayContent: `找到 ${results.length} 条结果`,
    };
  },
});
```

## createTool

使用 Zod Schema 的工厂函数，提供完整的类型推断和运行时验证。

```ts
import { z } from 'zod';
import { createTool } from '@blade-ai/agent-sdk';

const deployTool = createTool({
  name: 'Deploy',
  displayName: 'Deploy',
  kind: 'execute',
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
      displayContent: `✅ 部署成功: v${params.version} → ${params.environment}`,
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

```ts
interface ToolResult {
  success: boolean;
  llmContent: string | object;
  displayContent: string;
  error?: ToolError;
  metadata?: Record<string, unknown>;
}
```

`llmContent` 和 `displayContent` 分离设计让你可以给 LLM 提供结构化数据，同时给用户展示可读的摘要。

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
