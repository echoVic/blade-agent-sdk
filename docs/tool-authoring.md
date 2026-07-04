# Tool Authoring

自定义工具是 `@blade-ai/agent-sdk` 的产品层能力：工具定义可以放进 session，执行仍由 server / CLI 进程控制。浏览器代码只共享工具类型或摘要，不直接执行工具。

## 入口选择

普通 server / CLI 应用可以直接从 root 导入；需要明确 browser-safe 类型边界时，从 `@blade-ai/agent-sdk/tools` 导入工具类型和定义函数：

```ts
import { createSession } from '@blade-ai/agent-sdk';
import { defineTool, ToolKind } from '@blade-ai/agent-sdk/tools';
import type { ExecutionContext } from '@blade-ai/agent-sdk/tools';
```

`@blade-ai/agent` 只看到 runtime-independent `AgentToolPort`，不会依赖具体工具实现、MCP、文件系统或 shell。`@blade-ai/agent-sdk` 负责把 `ToolDefinition` 适配进 kernel。

## 最小工具

`defineTool()` 接受 JSON Schema，适合大多数应用工具。工具返回的 `llmContent` 给模型阅读，`data` 给业务代码消费，并且必须是 JSON 可序列化值。

```ts
const searchDocs = defineTool<{ query: string; limit?: number }, { count: number }>({
  name: 'SearchDocs',
  description: '搜索内部文档',
  kind: ToolKind.ReadOnly,
  parameters: {
    type: 'object',
    properties: {
      query: { type: 'string', description: '搜索关键词' },
      limit: { type: 'number', description: '最多返回条数' },
    },
    required: ['query'],
  },
  execute: async (params, context: ExecutionContext) => {
    context.onProgress?.(`searching: ${params.query}`);
    const results = await searchDocuments(params.query, params.limit ?? 5);

    return {
      success: true,
      llmContent: results.map((item) => `- ${item.title}`).join('\n'),
      data: { count: results.length },
    };
  },
});
```

## Zod 工具

`createTool()` 使用 Zod schema，适合需要强参数校验、复杂描述和更完整工具元数据的场景。

```ts
import { z } from 'zod';
import { createTool, ToolKind } from '@blade-ai/agent-sdk/tools';

const deploy = createTool({
  name: 'Deploy',
  displayName: 'Deploy',
  kind: ToolKind.Execute,
  description: {
    short: '部署应用',
    long: '把已构建版本部署到 staging 或 production',
    important: ['production 需要权限确认'],
  },
  schema: z.object({
    environment: z.enum(['staging', 'production']),
    version: z.string(),
  }),
  execute: async ({ environment, version }, context) => {
    context.onProgress?.(`deploying ${version} to ${environment}`);
    return {
      success: true,
      llmContent: `deployed ${version} to ${environment}`,
    };
  },
});
```

## 注册到 Session

工具通过 `SessionOptions.tools` 注册。`allowedTools` 是工具白名单：不设置表示不限制，`allowedTools: []` 表示禁用所有工具，非空数组表示只允许这些名字。

```ts
const session = await createSession({
  provider: {
    type: 'openai-compatible',
    apiKey: process.env.GLM_API_KEY!,
    baseUrl: process.env.GLM_BASE_URL!,
  },
  model: 'glm-5.2',
  tools: [searchDocs],
  allowedTools: ['SearchDocs'],
});
```

如果只是做 quickstart 或模型 smoke test，显式使用：

```ts
const session = await createSession({
  provider: { type: 'openai-compatible', apiKey: process.env.GLM_API_KEY! },
  model: 'glm-5.2',
  allowedTools: [],
});
```

## 执行上下文

`ExecutionContext` 会把 session 运行时信息传给工具，包括 `sessionId`、`messageId`、`contextSnapshot`、`signal`、`onProgress`、`updateOutput`、权限模式和当前配置。长任务应监听 `signal`，并用 `onProgress` 输出面向用户的进度。

```ts
execute: async (params, context) => {
  if (context.signal?.aborted) {
    return {
      success: false,
      llmContent: 'cancelled',
      error: { type: 'ABORTED', message: 'Tool execution was cancelled' },
    };
  }

  context.onProgress?.('working');
  return { success: true, llmContent: 'done' };
}
```

## 权限与效果

会修改权限状态的工具可以在成功结果里返回 `effects`。这些更新会通过 stream 的 `tool_permission_updates` 事件流出，并写入 trace，便于审计。

```ts
return {
  success: true,
  llmContent: 'remembered allow rule',
  effects: [
    {
      type: 'permissionUpdates',
      updates: [
        {
          type: 'addRules',
          behavior: 'allow',
          rules: [{ toolName: 'SearchDocs', ruleContent: 'project-docs' }],
        },
      ],
    },
  ],
};
```

普通业务工具不需要直接处理 kernel 事件；session stream 会把工具生命周期映射成 `tool_use`、`tool_result`、`tool_permission_updates` 等 `StreamMessage`。

## 生产检查清单

- 给每个工具设置稳定、唯一、面向模型可理解的 `name`。
- 为写入、执行、联网工具选择正确的 `ToolKind`，让权限策略能区分风险。
- 参数 schema 要把必填字段、枚举和描述写清楚，避免模型猜字段。
- `llmContent` 保持短而有决策价值，完整大对象放在 `data` 或外部存储。
- 失败时返回 `success: false` 和明确 `error`，不要把异常堆栈直接暴露给模型。
- 工具测试至少覆盖成功、失败、权限/abort、JSON 序列化和 session stream 事件。

示例和公开写法通过 `pnpm run verify:examples` 进入验证链；完整发布前继续跑 `pnpm run verify`。
