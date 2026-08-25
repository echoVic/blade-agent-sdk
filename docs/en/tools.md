# Tools

The SDK exposes three tool authoring APIs:

| API | Schema | Use |
|-----|--------|-----|
| `defineTool()` | JSON Schema | Lightweight typed definitions accepted by Session |
| `createTool()` | Zod | Full inference, runtime validation, and interruption policy |
| `toolFromDefinition()` | JSON Schema | Convert a definition into the internal `Tool` interface |

Every tool executes as `AsyncGenerator<ToolYield, ToolResult>`.

## defineTool

```ts
import { defineTool, ToolKind, ToolSideEffect } from '@blade-ai/agent-sdk';

const searchDocs = defineTool<
  { query: string; limit?: number },
  { count: number }
>({
  name: 'SearchDocs',
  description: 'Search the documentation index',
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
  async *execute(params, context) {
    context.signal?.throwIfAborted();
    const results = await search(params.query, params.limit ?? 10);
    yield {
      kind: 'progress',
      message: 'Search completed',
      data: { count: results.length },
    };
    return {
      status: 'success',
      model: results,
      display: { summary: `Found ${results.length} documents` },
      data: { count: results.length },
    };
  },
});
```

Use `ToolKind.ReadOnly`, `ToolKind.Write`, or `ToolKind.Execute`. TypeScript does not accept raw string literals for this enum.

## createTool

```ts
import { createTool, ToolKind, ToolSideEffect } from '@blade-ai/agent-sdk';
import { z } from 'zod';

const deploy = createTool({
  name: 'Deploy',
  displayName: 'Deploy',
  kind: ToolKind.Execute,
  sideEffect: ToolSideEffect.NON_IDEMPOTENT,
  description: {
    short: 'Deploy an application',
    long: 'Deploy a tested build to staging or production.',
    important: ['Production requires explicit approval.'],
  },
  schema: z.object({
    environment: z.enum(['staging', 'production']),
    version: z.string(),
  }),
  interruptBehavior: 'block',
  async *execute(params) {
    yield {
      kind: 'progress',
      message: 'Deploying',
      data: params,
    };
    return {
      status: 'success',
      model: `Deployed ${params.version} to ${params.environment}`,
      display: { summary: `Deployment completed: ${params.environment}` },
    };
  },
});
```

`createTool()` returns a complete `Tool` that can be passed directly to
`SessionOptions.tools`. Session preserves the instance instead of adapting it,
so validation, behavior, and interruption settings remain intact.

## Streaming contract

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
  | {
      kind: 'message';
      content: ToolDisplayContent;
    }
  | {
      kind: 'effect';
      effect: ToolEffect;
    };

type ToolExecution<TData extends JsonValue = JsonValue> =
  AsyncGenerator<ToolYield, ToolResult<TData>, void>;
```

Tools that have no intermediate events must still return a generator. Use `completeToolExecution(result)` to wrap a terminal result and `collectToolExecution(execution)` when a consumer only needs the return value.

## ToolResult

```ts
type ToolResult =
  | {
      status: 'success';
      model: ToolModelContent;
      display?: ToolDisplayContent;
      data?: JsonValue;
      metadata?: ToolResultMetadata;
    }
  | {
      status: 'error';
      model: ToolModelContent;
      display?: ToolDisplayContent;
      error: ToolError;
      metadata?: ToolResultMetadata;
    };
```

- `model` is written back to model context.
- `display` is UI-facing content and should not be parsed to reconstruct model output.
- `data` is optional caller-facing structured data and must be a strict JSON
  value. Large-result artifact persistence applies to `model`, not `data`.
- Failed results require both `status: 'error'` and `error`.

## Progress, messages, and effects

Yield events in the order they happen:

```ts
async *execute(params) {
  yield {
    kind: 'progress',
    message: 'Uploading',
    completed: 1,
    total: 3,
  };
  yield {
    kind: 'message',
    content: { summary: 'Upload started' },
  };
  yield {
    kind: 'effect',
    effect: {
      type: 'contextPatch',
      patch: { metadata: { uploadId: 'upload-1' } },
    },
  };
  return {
    status: 'success',
    model: { uploadId: 'upload-1' },
  };
}
```

Effects can update runtime policy, context, messages, or permissions. The Session stream projects them into corresponding `tool_*` events.

## Interruption

`interruptBehavior` controls a tool when a `priority: 'now'` input arrives:

- `block` is the default. The tool completes before steering is applied.
- `cancel` is for tools that observe `context.signal` and reliably release resources.

```ts
const tool = createTool({
  // ...
  sideEffect: ToolSideEffect.IDEMPOTENT,
  interruptBehavior: 'cancel',
  async *execute(params, context) {
    context.signal?.throwIfAborted();
    try {
      return await run(params, context.signal);
    } finally {
      await releaseResources();
    }
  },
});
```

Explicit `session.abort()` and `session.close()` are request-level cancellation and are not blocked by `interruptBehavior: 'block'`.
Both methods wait for active tool cleanup, so custom tools must honor the
request `AbortSignal` even when they block `now`-priority steering.

`SessionOptions.toolTimeoutMs` bounds each tool invocation and defaults to
`600000` (10 minutes). The deadline starts after permission checks and the
durable `tool_started` boundary, remains active across progress yields, and
aborts the tool's signal on expiry. The terminal result has
`ToolErrorType.TIMEOUT_ERROR`. Cleanup is awaited for at most 5 seconds. If it
is still pending, the pipeline refuses new tool work and Session shutdown or
handoff fails closed until the generator exits; JavaScript cannot preempt
custom tool code that ignores cancellation.

Permission waits are cancellation-bounded instead of time-bounded because a
human approval may legitimately remain open. Input validation and tool-level
permission checks receive `ExecutionContext.signal`; `permissionHandler` and
`canUseTool` receive `request.signal`; interactive handlers receive
`ConfirmationDetails.abortSignal`. The pipeline races every callback against
that request signal. A callback should stop work when it aborts. If it ignores
the signal, the request still cancels, but new tool calls and Session
close/handoff fail closed until the callback Promise settles. A durable
permission request is resolved with `decision: 'cancel'` before cancellation
completes.

Concurrency-slot and same-file lock waits also occur before the tool timeout
starts, but both observe the active Request signal. Cancellation removes a
queued waiter without consuming capacity or disturbing FIFO order. If resource
grant and cancellation happen in the same turn, the pipeline rechecks the
signal and releases every acquired lease before returning the cancellation
result.

`interruptBehavior` belongs to the `ToolConfig` accepted by `createTool()`;
`defineTool()` / `ToolDefinition` does not expose it. Use `createTool()` with
`cancel` when a custom Session tool can safely stop for a `now` input.

## Side-effect contract

Every `ToolDefinition`, `ToolConfig`, and complete `Tool` must explicitly
declare `sideEffect`:

- `pure`: does not mutate external state and can be replayed during recovery.
- `idempotent`: repeating the same invocation reaches the same intended state
  and can be replayed during recovery.
- `non_idempotent`: repeating an invocation may create additional effects, so a
  started call requires operator or external-system reconciliation.

`ToolKind`, `isReadOnly`, and `sideEffect` are independent dimensions; the SDK
does not infer one from another. Parameter-dependent tools may narrow the
contract through `resolveBehavior()`, but their static declaration must be the
most conservative value. Dynamic MCP tools always use `non_idempotent`; remote
annotations are hints and are not sufficient evidence for safe automatic
replay.

## ToolDefinition

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
  execute(
    params: TParams,
    context: ExecutionContext,
  ): ToolExecution<TData>;
}
```

## ExecutionContext

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
  toolInvocationLifecycle?: ToolInvocationLifecycle; // injected by the runtime
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

## Durable lifecycle boundaries

A runtime can use `ToolExecutionLifecycle` to observe and block critical tool
persistence boundaries:

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
  modelInput: JsonObject; // Original provider arguments.
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

These callbacks are not best-effort telemetry. Their ordering is fixed:

1. `onToolScheduled` completes before `tool_start` is published.
2. `onPermissionRequested` completes before the interactive confirmation handler runs.
3. `onPermissionResolved` completes before the permission decision is accepted.
4. `onExecutionStarted` persists the final post-permission input and resolved
   side-effect contract before invoking the tool generator, so a durable write
   failure blocks the side effect.
5. `onToolSettled` completes before `tool_result` is published.

Invalid JSON arguments and synthetic interruption results for calls that were
never dispatched do not enter the durable lifecycle because they never form an
executable invocation. Without a lifecycle observer, normal tool execution
behavior is unchanged.

## Built-in tools

`getBuiltinTools()` is exported by the `/node` entry point. The `/node`
Session facade registers this local host tool set automatically; memory tools
are only included when a `MemoryManager` is supplied explicitly.

| Group | Tools |
|-------|-------|
| Filesystem | `Read`, `Edit`, `Write`, `NotebookEdit`, `Glob`, `Grep` |
| Shell | `Bash`, `KillShell` |
| Web | `WebFetch`, `WebSearch` |
| Subagents | `Task`, `TaskOutput` |
| Structured tasks | `TaskCreate`, `TaskGet`, `TaskUpdate`, `TaskList`, `TaskStop` |
| System | `AskUserQuestion`, `DiscoverTools`, `Skill` |
| Planning | `EnterPlanMode`, `ExitPlanMode` |
| Todos | `TodoWrite` |
| MCP resources | `ListMcpResources`, `ReadMcpResource` |

Built-in contracts:

| Tool | Kind | Side effect |
|------|------|-------------|
| `Read` | `ReadOnly` | `pure` |
| `Edit` | `Write` | `non_idempotent` |
| `Write` | `Write` | `idempotent` |
| `NotebookEdit` | `Write` | `non_idempotent`; replace narrows to `idempotent` |
| `Glob`, `Grep` | `ReadOnly` | `pure` |
| `Bash` | `Execute` | `non_idempotent`; read-only foreground commands narrow to `pure` |
| `KillShell` | `Execute` | `idempotent` |
| `WebFetch` | `Execute` | `non_idempotent`; GET/HEAD narrow to `pure`, PUT/DELETE to `idempotent` |
| `WebSearch` | `ReadOnly` | `pure` |
| `Task` | `ReadOnly` | `non_idempotent` |
| `TaskOutput` | `ReadOnly` | `non_idempotent` |
| `TaskCreate` | `Write` | `non_idempotent` |
| `TaskGet`, `TaskList` | `Write` | `pure` |
| `TaskUpdate`, `TaskStop` | `Write` | `idempotent` |
| `TodoWrite` | `ReadOnly` | `idempotent` |
| `EnterPlanMode`, `ExitPlanMode`, `AskUserQuestion` | `ReadOnly` | `non_idempotent` |
| `DiscoverTools` | `ReadOnly` | `idempotent` |
| `Skill` | `Execute` | `non_idempotent` |
| `ListMcpResources`, `ReadMcpResource` | `ReadOnly` | `pure` |

Permission decisions use the resolved behavior, so consumers should not infer
kind or side effects from a tool name.

## Select tools

```ts
const session = await createSession({
  provider,
  model,
  tools: [searchDocs],
  allowedTools: ['Read', 'Glob', 'Grep', 'SearchDocs'],
  disallowedTools: ['Bash'],
});
```

An omitted `allowedTools` means no allowlist restriction. An empty array disables all tools.

## Source policy

```ts
toolSourcePolicy: {
  allowedSources: ['builtin', 'custom'],
  allowedTrustLevels: ['trusted', 'workspace'],
}
```

- Built-in tools use `trusted`.
- `SessionOptions.tools` use `workspace`.
- Remote MCP tools use `remote`.
