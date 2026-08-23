# Middleware and plugins

Middleware provides composable onion-style extension points around model calls
and tool execution. The first registered middleware is the outermost layer:
code before `next()` runs in registration order, and code after `next()` unwinds
in reverse order.

## Quick start

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

Register middleware directly when a reusable plugin is unnecessary:

```ts
const session = await createSession({
  provider,
  model,
  middleware: {
    tool: [auditTool],
  },
});
```

`SessionOptions.middleware` is always outside plugin middleware. Plugins compose
in `SessionOptions.plugins` order, followed by each plugin's array order.

## Generic composer

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

One execution chain may call `next()` only once. A second call throws
`next() called multiple times`, preventing duplicate model or tool execution.

## Tool middleware

`ToolMiddleware` wraps one complete streaming tool execution:

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

It may:

- transform `input` before `next()`;
- short-circuit execution by returning its own `ToolExecution`;
- pass through or transform streamed `ToolYield` values;
- transform the final `ToolResult` while the onion unwinds.

It may not:

- change `toolName`;
- replace `ExecutionContext`;
- call `next()` more than once.

These restrictions preserve permission, cancellation, and durable lifecycle
identity. The final middleware result is recorded in execution history and is
persisted by the outer `onToolSettled` boundary before publication.

## Model middleware

`ModelMiddleware` exposes a wrapper for each model operation:

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

| Method | Wrapped operation |
|---|---|
| `wrapChat` | Non-streaming model request |
| `wrapSideQuery` | Side queries such as compaction and summaries |
| `wrapStream` | Streaming model request |
| `wrapChatWithRetryEvents` | Non-streaming request with retry events |

When the active model changes, the newly created provider service receives the
same middleware stack.

## Declarative plugins

A plugin bundles middleware, existing hooks, and tools:

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

Plugin names must be non-empty and unique within a Session. Plugin tools are
registered with `sourceId: "plugin:<name>"` and
`trustLevel: "workspace"`. They still pass through `allowedTools`,
`disallowedTools`, permission rules, and sandbox policy.

## Durable side-effect boundary

Middleware runs during **live execution** only. Recovery projects durable
journal events and does not replay the middleware call stack.

Consequently:

- logging, metrics, and tracing may run directly in middleware;
- prompt, model request, tool input, and result transforms belong in middleware;
- committed side effects such as sending mail, charging an account, or writing
  a database must **not** run directly in middleware.

Model committed side effects as tools with an explicit `sideEffect` contract.
Tool calls continue through:

```text
onToolScheduled
  -> middleware / permissions
  -> onExecutionStarted
  -> tool side effect
  -> middleware unwind
  -> onToolSettled
```

This is the current journal outlet. It persists final input before the side
effect starts and persists the final result before publication. The SDK does
not expose arbitrary `ctx.emit(command)` to ordinary plugins yet, because that
would let plugins bypass the durable event schema and recovery reconciliation.

## Middleware or hooks?

| Requirement | Preferred mechanism |
|---|---|
| Model wrapping, retry, caching, or routing | Model middleware |
| Tool stream wrapping, transforms, or short-circuiting | Tool middleware |
| Observe Session lifecycle events | Hooks |
| Make allow/deny/ask decisions | `canUseTool` / `permissionHandler` |
| Run recoverable external side effects | Tool with declared `sideEffect` |
| Consume persisted execution events | `subscribeDurableEvents()` |
