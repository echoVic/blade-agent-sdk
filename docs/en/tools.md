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
import { defineTool, ToolKind } from '@blade-ai/agent-sdk';

const searchDocs = defineTool<
  { query: string; limit?: number },
  { count: number }
>({
  name: 'SearchDocs',
  description: 'Search the documentation index',
  kind: ToolKind.ReadOnly,
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
import { createTool, ToolKind } from '@blade-ai/agent-sdk';
import { z } from 'zod';

const deploy = createTool({
  name: 'Deploy',
  displayName: 'Deploy',
  kind: ToolKind.Execute,
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

`interruptBehavior` belongs to the `ToolConfig` accepted by `createTool()`;
`defineTool()` / `ToolDefinition` does not expose it. Use `createTool()` with
`cancel` when a custom Session tool can safely stop for a `now` input.

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
}
```

## Built-in tools

`getBuiltinTools()` is exported by the root and `/local` entry points. Memory tools are only included when a `MemoryManager` is supplied.

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

Current `ToolKind` values:

| Tool | Kind |
|------|------|
| `Read`, `Glob`, `Grep`, `WebFetch`, `WebSearch`, `Task`, `TaskOutput` | `ReadOnly` |
| `TaskCreate`, `TaskGet`, `TaskUpdate`, `TaskList`, `TaskStop` | `Write` |
| `Bash`, `KillShell` | `Execute` |

See source metadata for the remaining tool kinds. Permission decisions use the declared kind, so consumers should not infer it from a tool name.

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
