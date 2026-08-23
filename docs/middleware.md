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
  console.log('before', { toolName: request.toolName });
  const result = yield* next();
  console.log('after', {
    toolName: request.toolName,
    status: result.status,
  });
  return result;
};

const session = await createSession({
  provider: { type: 'openai', apiKey: process.env.OPENAI_API_KEY! },
  model: 'gpt-4o-mini',
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
  provider: { type: 'openai', apiKey: process.env.OPENAI_API_KEY! },
  model: 'gpt-4o-mini',
  middleware: {
    tool: [auditTool],
  },
});
```

`SessionOptions.middleware` 始终位于插件 middleware 外层。多个插件按
`SessionOptions.plugins` 中的顺序组合，插件内部按数组顺序组合。
同一组 model/tool middleware 会传递给该 Session 启动的前台和后台子 Agent。
插件中的 hooks 与 tools 则注册在根 Session；子 Agent 仍使用自己的工具白名单
与系统提示。根 Agent 与多个子 Agent 可能并发调用同一个 middleware 实例；
middleware 必须并发安全，并把请求级状态保存在局部变量中。

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
- 不调用 `next()`，返回自己的 `ToolExecution` 以纯计算方式短路执行；
- 原样转发或变换流式 `ToolYield`；
- 在回卷阶段变换最终 `ToolResult`。

它不能：

- 改写 `toolName`；
- 替换 `ExecutionContext`；
- 把输入变换到不同的 `interruptBehavior`；
- 调用多次 `next()`。
- 在 middleware 中直接执行提交型外部副作用。
- 把 core 的失败结果改写为成功，或覆盖 core 的取消结果。

这些限制保护权限、取消信号和 durable lifecycle 的绑定关系。middleware
返回的最终结果会进入执行历史，并由外层 `onToolSettled` 持久化后再发布。
调用 `next()` 后必须用 `yield*` 完整转发 delegated execution；若 middleware
已启动 core 却提前返回，SDK 会自动排空 core，并以真实 core 结果为准。
SDK 会在进入和离开 middleware 链时校验 execution lease；lease failure 不会
被转换为普通工具错误。短路成功会在 settlement 前持久化一个合成
`tool_started`，使 durable 投影保持合法；因此短路逻辑必须是无提交副作用的
缓存命中或纯计算。短路不会进入 `PreToolUse`、权限处理器或 `PostToolUse`；
它表示受信任 middleware 已完整处理该工具调用。

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
流被调用方提前关闭时，middleware 与 provider generator 都会关闭。模型请求
变换应保持确定性；middleware 接收并必须向下传递当前 `AbortSignal`。SDK
会在每层 middleware 边界校验 `operation`、`model` 与 `signal` 未被替换，
包括内层 middleware 短路之前。

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

插件名必须是 1–64 位小写字母、数字、点、下划线或连字符，首尾必须是
字母或数字，并且在一个 Session 中唯一。插件工具以
`sourceId: "plugin:<name>"`、`trustLevel: "workspace"` 注册，仍受
`allowedTools`、`disallowedTools`、权限规则和 sandbox 约束。
内置工具、`SessionOptions.tools` 和插件之间若出现重复 canonical 工具名，
Session 初始化会失败；后注册项不会替换已有工具。

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
  → ownership check
  → middleware
  → scheduler / file lock / hooks / permissions
  → onExecutionStarted
  → tool side effect
  → middleware unwind
  → ownership check
  → onToolSettled
```

这条路径是当前的 journal 出口。它保证最终输入在副作用开始前被持久化，
最终结果在发布前被持久化。SDK 暂不向普通插件暴露任意
`ctx.emit(command)`，避免插件绕开 durable event schema 和恢复对账规则。
短路成功不执行真实工具，但仍在结果发布前写入合成 `tool_started`。恢复流程
不会重放 middleware；失租会 fail-closed。core 完成前收到 abort 会取消执行，
core 完成后才观察到 abort 则保留已提交结果。

## Middleware 与 Hooks 的选择

| 需求 | 推荐机制 |
|---|---|
| 包装模型调用、重试、缓存、路由 | Model middleware |
| 包装工具流、变换输入/结果、短路 | Tool middleware |
| 观察 Session 生命周期事件 | Hooks |
| 对工具作 allow/deny/ask 决策 | `canUseTool` / `permissionHandler` |
| 执行可恢复的外部副作用 | 声明了 `sideEffect` 的 Tool |
| 消费已持久化的执行事件 | `subscribeDurableEvents()` |
