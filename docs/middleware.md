# Middleware 与插件

Middleware 为模型调用和工具执行提供可组合的洋葱式扩展点。第一个注册的
middleware 是最外层：调用 `next()` 前按注册顺序执行，调用后按相反顺序回卷。

## 快速开始

```ts
import {
  createSession,
  definePlugin,
  type ToolMiddleware,
} from '@blade-ai/agent-sdk';

const auditTool: ToolMiddleware = async function* (request, next) {
  console.log('before', request.toolName, request.input);
  const result = yield* next();
  console.log('after', request.toolName, result.status);
  return result;
};

const session = await createSession({
  provider,
  model,
  plugins: [
    definePlugin({
      name: 'audit',
      middleware: {
        tool: [auditTool],
      },
    }),
  ],
});
```

也可以不创建插件，直接注册：

```ts
const session = await createSession({
  provider,
  model,
  middleware: {
    tool: [auditTool],
  },
});
```

`SessionOptions.middleware` 始终位于插件 middleware 外层。多个插件按
`SessionOptions.plugins` 中的顺序组合，插件内部按数组顺序组合。

## 通用组合器

```ts
type MiddlewareNext<TRequest, TResult> =
  (request?: TRequest) => TResult;

type Middleware<TRequest, TResult> =
  (request: TRequest, next: MiddlewareNext<TRequest, TResult>) => TResult;

function composeMiddleware<TRequest, TResult>(
  middleware: readonly Middleware<TRequest, TResult>[],
  terminal: (request: TRequest) => TResult,
): (request: TRequest) => TResult;
```

同一条执行链只能调用一次 `next()`。重复调用会抛出
`next() called multiple times`，避免一次模型或工具请求被重复执行。

## 工具 middleware

`ToolMiddleware` 包住完整的流式工具执行：

```ts
const normalizeInput: ToolMiddleware = async function* (request, next) {
  const result = yield* next({
    ...request,
    input: {
      ...request.input,
      query: String(request.input.query ?? '').trim(),
    },
  });

  return {
    ...result,
    model: redactSecrets(result.model),
  };
};
```

它可以：

- 在 `next()` 前变换 `input`；
- 不调用 `next()`，返回自己的 `ToolExecution` 以短路执行；
- 原样转发或变换流式 `ToolYield`；
- 在回卷阶段变换最终 `ToolResult`。

它不能：

- 改写 `toolName`；
- 替换 `ExecutionContext`；
- 调用多次 `next()`。

这些限制保护权限、取消信号和 durable lifecycle 的绑定关系。middleware
返回的最终结果会进入执行历史，并由外层 `onToolSettled` 持久化后再发布。

## 模型 middleware

`ModelMiddleware` 针对四种模型调用分别提供包装器：

```ts
const modelMiddleware = {
  async wrapChat(request, next) {
    const startedAt = Date.now();
    try {
      return await next(request);
    } finally {
      metrics.observe(Date.now() - startedAt);
    }
  },

  async *wrapStream(request, next) {
    for await (const chunk of next(request)) {
      yield chunk;
    }
  },
} satisfies ModelMiddleware;
```

| 方法 | 包装的调用 |
|---|---|
| `wrapChat` | 普通非流式请求 |
| `wrapSideQuery` | compaction、总结等旁路请求 |
| `wrapStream` | 流式模型请求 |
| `wrapChatWithRetryEvents` | 带重试事件的非流式请求 |

模型切换后，新建的 provider service 会自动套用同一组 middleware。

## 声明式插件

插件可以把 middleware、现有 hooks 和工具打包在一起：

```ts
const reviewPlugin = definePlugin({
  name: 'review',
  middleware: {
    model: [modelMiddleware],
    tool: [auditTool],
  },
  hooks: {
    [HookEvent.UserPromptSubmit]: [
      async (input) => ({
        action: 'continue',
        modifiedInput: {
          userPrompt: `[review]\n${String(input.userPrompt ?? '')}`,
        },
      }),
    ],
  },
  tools: [reviewTool],
});
```

插件名必须非空且在一个 Session 中唯一。插件工具以
`sourceId: "plugin:<name>"`、`trustLevel: "workspace"` 注册，仍受
`allowedTools`、`disallowedTools`、权限规则和 sandbox 约束。

## Durable 副作用边界

Middleware 只在**实时执行**时运行；恢复流程通过 durable journal 投影状态，
不会重放 middleware 调用栈。

因此：

- 日志、指标和 trace 可以直接放在 middleware 中；
- prompt、模型参数、工具输入/输出变换可以放在 middleware 中；
- 发邮件、扣费、写数据库等提交型副作用**不能**直接放在 middleware 中。

提交型副作用应实现为声明了 `sideEffect` 的工具。工具调用会继续经过：

```text
onToolScheduled
  → middleware / permissions
  → onExecutionStarted
  → tool side effect
  → middleware unwind
  → onToolSettled
```

这条路径是当前的 journal 出口。它保证最终输入在副作用开始前被持久化，
最终结果在发布前被持久化。SDK 暂不向普通插件暴露任意
`ctx.emit(command)`，避免插件绕开 durable event schema 和恢复对账规则。

## Middleware 与 Hooks 的选择

| 需求 | 推荐机制 |
|---|---|
| 包装模型调用、重试、缓存、路由 | Model middleware |
| 包装工具流、变换输入/结果、短路 | Tool middleware |
| 观察 Session 生命周期事件 | Hooks |
| 对工具作 allow/deny/ask 决策 | `canUseTool` / `permissionHandler` |
| 执行可恢复的外部副作用 | 声明了 `sideEffect` 的 Tool |
| 消费已持久化的执行事件 | `subscribeDurableEvents()` |
