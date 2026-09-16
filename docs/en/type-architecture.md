# Type Architecture

SDK types are owned by domains and boundaries, not collected into a generic
type bucket. Each concept has one definition site. Other modules import that
owner directly, while package entry points only assemble public contracts.

## Ownership

| Domain | Owner | Representative types |
|--------|-------|----------------------|
| Model | `src/model/` | `ModelMessage`, `ConversationMessage`, `ModelService`, `ModelUsage` |
| Agent | `src/agent/` | Public `AgentOptions` / `AgentResponse` / `UserMessageContent`; internal `AgentRuntimeOptions` / `AgentExecutionContext` |
| Tool | `src/tools/types/` | `Tool`, `ToolDefinition`, authoring inputs, `ToolResult`, `ToolBehavior` |
| Session API | `src/session/types.ts` | `SessionOptions`, `SessionStreamEvent`, `PromptResult` |
| Transcript | `src/session/transcript.ts` | `TranscriptEvent`, `TranscriptMessage`, `TranscriptPart` |
| Durable journal | `src/session/events/` | `DurableEventEnvelope`, `DurableSessionProjection` |
| Remote protocol | `src/protocol/` | `AgentCommand`, `AgentCommandResult`, `AgentServerEvent` |
| Runtime Store | `src/server/RuntimeStore.ts` | `RuntimeCommandCommit`, `RuntimeDomainEvent`, `RuntimeEffectIntent` |
| Cross-domain primitives | `src/types/` | branded identifiers, JSON, permissions, logging |

`src/types/` contains only genuinely cross-domain primitives. Business
configuration, messages, and events must not move into a generic `common.ts`
module.

## Agent configuration and execution context

The public Agent facade and internal Agent loop have distinct owners:

- `src/agent/createAgent.ts::AgentOptions` is the only public Agent
  configuration exported at root.
- `src/agent/types.ts::AgentRuntimeOptions` is used only by Agent and
  LoopRunner internals.
- `SessionOptions` is the low-level `/advanced` Session contract, not a
  duplicate of `AgentOptions`.

Internal `AgentExecutionContext` composes narrow conversation-state,
execution-control, and runtime-service contracts. The runtime object remains
flat to avoid wrappers on model and tool hot paths. None of these internal
types are exported from package entrypoints.

## Model boundary

The model layer is exported from `@blade-ai/agent-sdk`. It does not depend
on Session, local Node.js capabilities, or a concrete provider SDK.

```ts
import type {
  ConversationMessage,
  ModelMessage,
  ModelService,
  ModelServiceConfig,
  ModelToolDefinition,
  ModelUsage,
  ProviderConnectionConfig,
} from '@blade-ai/agent-sdk';
```

Configuration types have distinct responsibilities:

| Type | Responsibility |
|------|----------------|
| `ProviderConnectionConfig` | User-supplied provider identity, credentials, endpoint, and timeouts |
| `ModelConfig` | A registered, switchable model description |
| `ModelServiceConfig` | Normalized configuration used by a provider adapter to create `ModelService` |
| `ModelProviderOptions` | Provider-specific request extensions that remain JSON-safe |
| `ModelMessage` | Provider-neutral payload sent to a model |
| `ConversationMessage` | Agent/Session envelope carrying provenance, correlation, telemetry, and extensions |

`ModelUsage` is the raw provider response. `TokenUsage` is the Agent and Session
budget view. `normalizeModelUsage()` is the single conversion point.

`ModelMessage` has no generic `metadata` dictionary. SDK control fields belong
in `ConversationMessage.provenance`, `correlation`, or `telemetry`; provider
hints belong in `providerOptions`. Only application data that does not
participate in SDK control flow may use `extensions`.

## Event layers

Event types remain separate because their lifecycles differ:

| Type | Lifetime | Persisted | Wire format |
|------|----------|-----------|-------------|
| `AgentEvent` | One internal Agent loop | No | No |
| `SessionStreamEvent` | Stream consumed by a Session caller | No | No |
| `TranscriptEvent` | Conversation and input projection | Yes | No |
| `DurableEventEnvelope` | Deterministic recovery journal | Yes | No |
| `RuntimeDomainEvent` | Atomic runtime transaction | Yes | No |
| `AgentServerEvent` | AgentClient/AgentServer protocol | Replayable | Yes |

Conversion belongs at boundary implementations. An internal event must not be
cast into a protocol event, and unvalidated protocol `data` must not enter a
Session as a generic `JsonObject`.

## Persistence ports

Session persistence has two direction-specific ports:

```ts
interface SessionRepository extends SessionStore {
  initialize(): Promise<void>;
  // read projections, lifecycle, health, and capacity
}

interface SessionEventStore {
  // append transcript events
}
```

- `SessionRepository` owns read projections and storage management.
- `SessionEventStore` owns transcript appends.
- One adapter may explicitly implement both ports, but the SDK no longer
  provides a combined alias or detects capabilities at runtime.
- A Session requires compatible read and write ports. It must never write to
  one backend and resume from another.
- Local JSONL and PostgreSQL adapters convert persistence DTOs back into domain
  types.

## Branded identifiers

`SessionId`, `MessageId`, `ToolUseId`, `CommandId`, `EventId`,
`EventSequence`, `ExecutionLeaseId`, `ExecutionId`, `ExecutionCheckpointId`,
and `CredentialLeaseId` are branded types. Structurally similar identifiers
therefore cannot be passed to the wrong API.

```ts
const sessionId = SessionId(rawSessionId);
const commandId = CommandId(rawCommandId);
```

Construction is allowed only at trusted generation points or validated
boundaries:

- After a Zod protocol or transcript parser validates a string.
- After a database adapter validates constrained columns and complete payloads.
- When the SDK creates a new identifier with `nanoid()`.

Domain logic must not use `as SessionId` or degrade branded identifiers to
plain `string` parameters.

## Schemas and TypeScript

External input follows validate-then-model semantics:

1. A schema accepts `unknown`.
2. A parser validates structure, enums, numeric ranges, and required fields.
3. The parser constructs branded identifiers after validation.
4. Domain code receives only parsed values.

Recursive JSON schemas come from `src/types/jsonSchema.ts`.
`SessionStreamEvent`, protocol events, transcript events, and durable events
retain separate schemas because their compatibility and evolution policies
differ.

## Tool generics

Tool authoring accepts TypeBox schemas only. `ToolDefinition<TSchema>` and
`ToolDefinitionInput<TSchema>` infer callback parameters through
`Type.Static<TSchema>`. The same schema object is both the model-facing JSON
Schema and the runtime validation source, with no schema conversion or
advisory-only path.

Heterogeneous collections use the Tool-owned `ErasedToolDefinition` boundary;
Session does not spell `ToolDefinition<never>` directly. Compiled runtime
Tools precompute model declarations and static behavior as readonly data.
`prepare()` validates input and returns an internal immutable call snapshot:

```ts
interface Tool {
  readonly declaration: FunctionDeclaration;
  readonly staticBehavior: ToolBehavior;
  prepare(raw: unknown): ToolInvocation; // internal immutable snapshot
  execute(params: JsonObject, context?: ExecutionContext): ToolExecution;
}
```

`ToolInvocation` is not exported from public entry points. When hooks or
permission handlers rewrite input, the Pipeline must call `prepare()` again
instead of mutating an existing invocation's parameters, behavior, paths, or
permission signature.
Catalogs and registries do not erase parameter types through
`as unknown as Tool`. Tool execution always terminates with `ToolResult`, while
model-facing function declarations use `ModelToolDefinition`.

## Export rules

- Source modules import owner files directly to avoid root-barrel cycles.
- Barrels re-export owner modules directly instead of routing through
  domain-level compatibility barrels.
- The root entry assembles application APIs and public types; `/browser`
  remains browser-safe.
- Filesystem, shell, process, low-level Session, and integration APIs are
  exported by `/advanced`.
- `AgentServer`, Workers, Runtime Stores, and telemetry adapters are exported
  by `/server/infra`.
- The legacy `/node`, `/server`, `/core`, `/model`, `/session`, `/middleware`,
  and `/tools` subpaths have been removed.
- Compile-time assertion helpers are internal and are not part of the npm API.

## Change checklist

When adding or changing a type, verify:

1. The type is defined by the domain that owns the concept.
2. It does not duplicate an existing DTO, usage, config, message, or event.
3. Wire, database, and file inputs are validated before entering the domain.
4. Identifiers are constructed at boundaries and remain branded internally.
5. A public type is exported only from an appropriate package entry point.
6. Browser-safe entry points do not import Node-only dependencies.
7. Schemas, type tests, API references, and both documentation languages agree.
