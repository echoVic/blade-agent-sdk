# Session

Session is the primary SDK boundary. It owns conversation state, request execution, tools, persistence, MCP connections, hooks, and runtime context.

## Create a Session

```ts
import { createSession } from '@blade-ai/agent-sdk';

const session = await createSession({
  provider: {
    type: 'anthropic',
    apiKey: process.env.ANTHROPIC_API_KEY!,
  },
  model: 'claude-sonnet-4-20250514',
  maxTurns: 30,
  defaultContext: {
    capabilities: {
      filesystem: {
        roots: [process.cwd()],
        cwd: process.cwd(),
      },
    },
  },
});
```

Only `provider` and `model` are required. Filesystem context is optional and should only be added when local tools need it.

## Send and stream

```ts
const submission = await session.send('Analyze the current project');

for await (const event of session.stream()) {
  if (event.type === 'content') {
    process.stdout.write(event.delta);
  }
}
```

`send()` accepts text or multimodal message content and returns:

```ts
type InputSubmission =
  | {
      status: 'started';
      inputId: InputId;
      requestId: RequestId;
    }
  | {
      status: 'steered';
      inputId: InputId;
      requestId: RequestId;
      priority: 'now' | 'next';
    }
  | {
      status: 'queued';
      inputId: InputId;
      priority: 'later';
    };
```

Call `stream()` once for each pending request and drain it through completion.

## Steer an active request

```ts
interface SendOptions {
  signal?: AbortSignal;
  maxTurns?: number;
  context?: RuntimeContext;
  priority?: 'now' | 'next' | 'later';
  expectedRequestId?: RequestId;
}
```

When no request is active, `send()` starts one. During an active request:

| Priority | Behavior |
|----------|----------|
| `next` | Default. Apply at the next model or tool safe point without interrupting the current step. |
| `now` | Interrupt the current model step and tools that declare `interruptBehavior: 'cancel'`, then apply at the next safe point. |
| `later` | Queue an independent request to consume after the current stream finishes. |

```ts
const started = await session.send('Refactor the parser');
const output = session.stream();

await session.send('Preserve all public types', {
  priority: 'next',
  expectedRequestId:
    started.status === 'started' ? started.requestId : undefined,
});

for await (const event of output) {
  if (event.type === 'input_applied') {
    console.log('Applied', event.inputId, event.priority);
  }
}
```

`expectedRequestId` prevents a concurrent client from steering the wrong request. If the target request is sealed or stopping, a `now` or `next` input is safely retargeted to `later`.

Queued and steering inputs are durable only when `storagePath` enables message
persistence. Unapplied inputs are then recovered as `later` after process
restart. When `durableEventStore` is configured, the initial request input is
also captured by `request_accepted`; this does not replace pending-input
recovery for later steering messages.

## Manage pending input

```ts
const queued = await session.send('Run this later', {
  priority: 'later',
});

console.log(session.getPendingInputs());
const cancelled = await session.cancelInput(queued.inputId);
```

`cancelInput()` returns `false` once the Agent loop has claimed the input.

## Stream events

`StreamMessage` is a 17-variant discriminated union:

| Event | Meaning |
|-------|---------|
| `turn_start` | A model turn started. |
| `turn_end` | The current model turn ended. |
| `turn_interrupted` | A `now` input interrupted the current model step. |
| `input_applied` | A `now` or `next` input was persisted and added to model context. |
| `content` | Text delta. |
| `thinking` | Reasoning delta when `includeThinking` is enabled. |
| `tool_use` | The model requested a tool call. |
| `tool_progress` | Structured tool progress. |
| `tool_message` | Tool-provided UI content. |
| `tool_runtime_patch` | Tool-provided runtime policy or model patch. |
| `tool_context_patch` | Tool-provided context patch. |
| `tool_new_messages` | Messages emitted by a tool or subagent. |
| `tool_permission_updates` | Permission updates emitted by a tool. |
| `tool_result` | Terminal result for one tool call. |
| `usage` | Token usage update. |
| `result` | Final success or error result. |
| `error` | Request processing error. |

The public union reserves `result.subtype: 'error'`, but the current Session
implementation emits request failures as the separate `error` event and emits
`result` for successful completion.

```ts
for await (const event of session.stream({ includeThinking: true })) {
  switch (event.type) {
    case 'content':
      process.stdout.write(event.delta);
      break;
    case 'tool_progress':
      console.log(event.name, event.progress);
      break;
    case 'tool_result':
      console.log(event.name, event.isError ? 'failed' : 'completed');
      break;
    case 'turn_interrupted':
      console.log('Interrupted by', event.inputId);
      break;
    case 'error':
      console.error(event.code, event.message);
      break;
  }
}
```

Partial model output produced before `turn_interrupted` can be displayed, but it is not committed to later model context. When interrupted tool calls exist, the SDK emits a terminal tool result for each one to preserve protocol validity.

## Abort a request

```ts
const stream = session.stream();
await session.abort();

for await (const event of stream) {
  // Drain cleanup and terminal events.
}
```

`abort()` terminates the whole active request and does not close the Session. It differs from `priority: 'now'`, which steers the same request at a safe point.

An external `AbortSignal` can also cancel a request:

```ts
const controller = new AbortController();
setTimeout(() => controller.abort(), 30_000);

await session.send('Run a long analysis', {
  signal: controller.signal,
});

for await (const event of session.stream()) {
  if (event.type === 'error') {
    console.error(event.message);
  }
}
```

Request failures are normally represented by stream events rather than thrown from the iteration body.

## One-shot prompts

```ts
import { prompt } from '@blade-ai/agent-sdk';

const result = await prompt('Summarize the repository', {
  provider,
  model,
});

console.log(result.result);
console.log(result.toolCalls);
console.log(result.usage);
console.log(result.duration);
console.log(result.turnsCount);
```

`prompt()` accepts the same text or multimodal content as `send()` and always closes its temporary Session.

## Persistence

Session storage is in-memory by default. Configure `storagePath` to write JSONL state:

```ts
const session = await createSession({
  provider,
  model,
  storagePath: '/var/lib/my-agent',
});
```

Session files are written under `{storagePath}/sessions/`. `persistSession: false` forces in-memory behavior.

### Durable execution events

Set `durableEventStore` to opt into the recoverable execution journal. The
event Store is independent of message-history persistence, so it can be used
with `persistSession: false`:

```ts
import {
  JsonlDurableEventStore,
  createSession,
} from '@blade-ai/agent-sdk';

const eventStore = new JsonlDurableEventStore('/var/lib/my-agent');
const session = await createSession({
  provider,
  model,
  persistSession: false,
  durableEventStore: eventStore,
});
```

When enabled, Session records Session, Request, Turn, Model Attempt, Tool,
Permission, and input-application events with these ordering guarantees:

- `request_accepted` commits before `send()` returns.
- A steering input's `input_applied` commits before its hooks and attachment preparation.
- Turn and tool scheduling events commit before `turn_start` or `tool_use` is published.
- `model_request_started` commits before the provider call. The call then
  settles as `model_request_completed`, `model_request_failed`, or
  `model_request_aborted`.
- `tool_scheduled` uses `modelAttemptId` to bind the call to its producing
  model request and stores both the provider's original `modelInput` and the
  repaired execution `input`. The schema-v3 projector verifies tool ID, name,
  and original arguments. If streaming schedules a tool early, the complete
  model response is persisted and validates those schedules before tool
  settlement is awaited.
- `tool_started` commits before the tool side effect can run.
- A standalone Request terminal event links to the latest persisted Request
  boundary through `causationEventId`.
- Terminal events commit before `tool_result`, `result`, or `error` is published.
- A pending request commits `request_interrupted` before
  `await session.abort()` resolves.

If a durable boundary cannot be committed, Session fences the current Recorder
and rejects the stream instead of fabricating a normal terminal event after the
Journal refreshes. New and queued requests remain blocked until the journal has
been reconciled.

```ts
const projection = session.getDurableProjection();
const recovery = session.getDurableRecoveryPlan();
const events = await session.subscribeDurableEvents({ after: savedCursor });
```

`resumeSession()` automatically restores a durable Request that was accepted
but has no `request_started` event. It preserves the `requestId`, input,
`maxTurns`, model, and Runtime Context, so the caller can continue it by
calling `stream()` directly. Legacy durable Requests without a complete
execution snapshot are not resumed automatically.

A started Request, active Turn, pending permission, unknown model outcome, or
unknown tool outcome is never replayed speculatively and raises
`DurableSessionRecoveryRequiredError`. An active `model_request_started`
produces `reconcile_model_outcome`; inspect provider or application records and
commit the confirmed result through `reconcileModelOutcome()` before rollover.
When input preparation is ambiguous before the first or a subsequent Turn, call
`prepareRequestRecovery()` with the reconciled final input, exact
`appliedInputIds`, and observed `sourceLastTurn` to atomically roll the old
Request into a new one. Missing or extra input applications are first classified as
`reconcile_request_inputs`. Recovery skips the completed initial hooks,
attachment expansion, and first-turn preparation, and filters already applied
inputs from the legacy queue. For a safe `resume_turn`, call
`prepareTurnRecovery()` to atomically terminate the old execution and accept a
provenance-linked continuation Request. Both then use `resumeSession()`'s
accepted-Request path. A Request whose last Turn ended without a Request
terminal event reports `reconcile_request_outcome`; settle it with
`reconcileRequestOutcome()` rather than replaying it. A `non_idempotent` tool
that completed, failed, or was cancelled after execution started always
remains fail-closed.
The JSONL adapter supports only one process;
multi-process deployments need a `DurableEventStore` with transactional CAS or
fencing.

### Resume

```ts
import { resumeSession } from '@blade-ai/agent-sdk';

const session = await resumeSession({
  sessionId,
  provider,
  model,
  storagePath: '/var/lib/my-agent',
});

// A process that stopped after send() but before stream() leaves the original
// Request pending. Do not submit the same input twice.
if (session.getPendingInputs().length === 0) {
  await session.send('Continue the analysis');
}
for await (const event of session.stream()) {
  // Consume the resumed or newly submitted Request.
}
```

`resumeSession()` requires persistent storage.

### Fork

Fork a persisted Session:

```ts
import { forkSession } from '@blade-ai/agent-sdk';

const branch = await forkSession({
  sessionId,
  messageId,
  provider,
  model,
  storagePath: '/var/lib/my-agent',
});
```

Fork the current in-memory state:

```ts
const branch = await session.fork({ messageId });
```

The new Session receives an independent `SessionId`.

## Runtime context

```ts
interface RuntimeContext {
  id?: string;
  capabilities?: {
    filesystem?: {
      roots: string[];
      cwd?: string;
    };
    browser?: {
      pageId?: string;
      tabId?: string;
    };
    network?: {
      allowDomains?: string[];
    };
  };
  environment?: Record<string, string>;
  metadata?: JsonObject;
}
```

Set defaults for the Session:

```ts
session.setDefaultContext({
  capabilities: {
    filesystem: {
      roots: ['/workspace/project'],
      cwd: '/workspace/project',
    },
  },
});
```

Override context for one request:

```ts
await session.send('Inspect the package', {
  context: {
    environment: { CI: '1' },
  },
});
```

The SDK does not infer a workspace from `process.cwd()`. Without filesystem capability, local file tools and project-level discovery are unavailable.

## Context compaction

The Agent loop manages context pressure in stages:

1. replace older large tool outputs with previews;
2. truncate oversized tool output;
3. summarize older conversation with the model;
4. retain only essential system and recent messages under emergency pressure.

Context overflow recovery retries internally. There is no public `recovery` stream event; observe the final `result` or `error`.

## Tools and permissions

```ts
const session = await createSession({
  provider,
  model,
  tools: [customTool],
  allowedTools: ['Read', 'Glob', 'Grep', 'CustomTool'],
  disallowedTools: ['Bash'],
  permissionMode: PermissionMode.DEFAULT,
  canUseTool: async (_name, _input, options) =>
    options.toolKind === 'readonly'
      ? { behavior: 'allow' }
      : { behavior: 'ask' },
});
```

See [Tools](./tools), [Permissions](./permissions), and [Hooks](./hooks).

## MCP

```ts
const status = await session.mcpServerStatus();
await session.mcpConnect('github');
await session.mcpDisconnect('github');
await session.mcpReconnect('github');
const tools = await session.mcpListTools();
```

See [MCP Integration](./mcp).

## Runtime configuration

```ts
session.setPermissionMode(PermissionMode.AUTO_EDIT);
await session.setModel('gpt-4o-mini');
session.setMaxTurns(50);
const models = await session.supportedModels();
```

## Lifecycle

```ts
await session.close();
console.log(session.isClosed);
```

`close()` aborts active work, closes MCP connections, runs the `SessionEnd` hook, and permanently closes the object. A closed Session cannot be reinitialized.

Use explicit resource management when available:

```ts
{
  await using session = await createSession({ provider, model });
  await session.send('Hello');
  for await (const event of session.stream()) {
    // ...
  }
}
```

## Observability

```ts
const session = await createSession({
  provider,
  model,
  observability: {
    enabled: true,
    capturePayloads: false,
    sink: async (trace) => traceStore.write(trace),
  },
});

const latest = session.getLastTrace();
const all = session.getTraces();
```

Payload capture is opt-in because prompts and tool data may be sensitive.

## SessionOptions

| Option | Type | Notes |
|--------|------|-------|
| `provider` | `ProviderConfig` | Required |
| `model` | `string` | Required |
| `temperature` | `number` | Sampling temperature |
| `maxOutputTokens` | `number` | Per-call output limit |
| `maxContextTokens` | `number` | Context window used for compaction |
| `providerOptions` | `JsonObject` | Provider-specific options |
| `thinkingEnabled` / `thinkingBudget` | `boolean` / `number` | Reasoning controls |
| `tokenBudget` | `TokenBudgetConfig` | Request and cost limits |
| `tools` | `SessionTool[]` | Custom `ToolDefinition` or complete `Tool` instances |
| `allowedTools` / `disallowedTools` | `string[]` | Tool filters |
| `toolSourcePolicy` | `ToolCatalogSourcePolicy` | Source and trust filtering |
| `mcpServers` | `Record<string, McpServerConfig \| SdkMcpServerHandle>` | MCP configuration |
| `permissionMode` | `PermissionMode` | Built-in approval mode |
| `permissionHandler` / `canUseTool` | callbacks | Custom permission policy |
| `systemPrompt` | `string` | Session system prompt |
| `maxTurns` | `number` | Agent turn limit |
| `agents` | `Record<string, AgentDefinition>` | Session-local subagents |
| `hooks` | `Partial<Record<SessionHookEvent, HookCallback[]>>` | Eight inline hook events |
| `defaultContext` | `RuntimeContext` | Optional runtime capabilities |
| `logger` | `AgentLogger` | Structured logger |
| `storagePath` | `string` | Enables JSONL persistence |
| `persistSession` | `boolean` | Disable persistence explicitly |
| `durableEventStore` | `DurableEventStore` | Opt-in durable execution journal |
| `outputFormat` | `OutputFormat` | Structured output schema |
| `sandbox` | `SandboxSettings` | Bash sandbox settings |
| `observability` | `ObservabilityOptions` | Trace collection |

## ISession

```ts
interface ISession extends AsyncDisposable {
  readonly sessionId: SessionId;
  readonly messages: Message[];
  readonly isClosed: boolean;

  send(message, options?: SendOptions): Promise<InputSubmission>;
  stream(options?: StreamOptions): AsyncGenerator<StreamMessage>;
  getPendingInputs(): readonly PendingSessionInput[];
  cancelInput(inputId: InputId): Promise<boolean>;

  abort(): Promise<void>;
  close(): Promise<void>;
  fork(options?: ForkSessionOptions): Promise<ISession>;

  getDefaultContext(): RuntimeContext;
  setDefaultContext(context: RuntimeContext): void;
  setPermissionMode(mode: PermissionMode): void;
  setModel(model: string): Promise<void>;
  setMaxTurns(maxTurns: number): void;
  supportedModels(): Promise<ModelInfo[]>;

  mcpServerStatus(): Promise<McpServerStatus[]>;
  mcpConnect(serverName: string): Promise<void>;
  mcpDisconnect(serverName: string): Promise<void>;
  mcpReconnect(serverName: string): Promise<void>;
  mcpListTools(): Promise<McpToolInfo[]>;

  getLastTrace(): AgentTrace | undefined;
  getTraces(): AgentTrace[];
  getDurableProjection(): DurableSessionProjection | null;
  getDurableRecoveryPlan(): DurableSessionRecoveryPlan | null;
  subscribeDurableEvents(
    options?: DurableEventSubscriptionOptions,
  ): Promise<DurableEventSubscription>;
}
```
