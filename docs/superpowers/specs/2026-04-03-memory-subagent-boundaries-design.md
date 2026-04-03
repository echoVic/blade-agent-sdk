# SDK Memory And Subagent Boundaries Design

## Context

The SDK currently mixes core agent runtime capabilities with application-level product decisions:

- Builtin memory tools are registered by default through `getBuiltinTools()`.
- The memory implementation is centered on a filesystem-backed `~/.blade/memory/` layout.
- A `verification` subagent is bundled as a builtin agent type.
- `SessionOptions.agents` is documented as a customization entry point, but it is not wired into the runtime.
- Subagent lookup currently depends on a process-global registry, which risks cross-session leakage.

These defaults create the wrong ownership boundary for an SDK. SDK consumers should decide:

- Whether memory exists at all
- Which persistence backend stores memory
- Whether a code-review or verification agent exists
- Which agent definitions are available inside a given session

The SDK should instead provide reusable primitives and explicit extension points.

## Goals

- Remove default memory-tool registration from `getBuiltinTools()`.
- Replace the current filesystem-centric memory abstraction with a backend-agnostic `MemoryStore` interface.
- Keep a filesystem implementation available as an opt-in adapter.
- Remove `verification` from builtin subagents.
- Make custom subagent registration a real public capability through both `SessionOptions.agents` and exported runtime classes.
- Ensure subagent registration is isolated per session.

## Non-Goals

- Preserve backward compatibility with the current memory API.
- Keep `verification` as a hidden or soft-deprecated builtin agent.
- Redesign task coordination tools such as `TaskStore`, `TaskCreate`, `TaskUpdate`, `TaskList`, or `TaskStop`.
- Change `BashClassifier`, `DenialTracker`, or the execution pipeline security model.

## Design Summary

The SDK will be split more cleanly into two layers:

- Capability layer:
  - `MemoryStore` interface
  - `MemoryManager` orchestration layer
  - `FileSystemMemoryStore` opt-in adapter
  - `SubagentRegistry`
  - `SubagentExecutor`
  - Session-scoped subagent registration via `SessionOptions.agents`
- Product layer:
  - Filesystem-backed memory setup
  - Verification or reviewer agent definitions

The capability layer remains inside the SDK. Product decisions move to explicit consumer opt-in through code, examples, and docs.

## Memory Architecture

### Public Types

Introduce a backend-agnostic `MemoryStore` interface in `src/memory/MemoryStore.ts`.

The interface should express the minimum persistence contract needed by the SDK:

```ts
export interface MemoryInput {
  name: string;
  description: string;
  type: MemoryType;
  body: string;
}

export interface Memory {
  name: string;
  description: string;
  type: MemoryType;
  body: string;
  updatedAt: number;
}

export interface MemoryStore {
  save(memory: MemoryInput): Promise<Memory>;
  get(name: string): Promise<Memory | undefined>;
  list(): Promise<Memory[]>;
  delete(name: string): Promise<void>;
}
```

This contract intentionally does not include:

- Filesystem paths
- Index files
- `MEMORY.md`
- Search APIs
- Backend-specific metadata

The core `Memory` type must also stop exposing filesystem details such as `filePath`. Filesystem paths remain an internal concern of `FileSystemMemoryStore`, not part of the SDK-wide memory abstraction.

### MemoryManager

`MemoryManager` becomes a pure orchestration layer and no longer chooses a storage backend by itself.

Constructor shape:

```ts
class MemoryManager {
  constructor(private readonly store: MemoryStore) {}
}
```

Responsibilities:

- `save()`
- `get()`
- `list()`
- `delete()`
- `search(query)`
- `readIndexContent()`

`search()` and `readIndexContent()` remain in `MemoryManager` so custom stores only need to implement the minimal CRUD interface.

`readIndexContent()` becomes a derived text view generated from `list()`, not a filesystem concern. This keeps the user-facing tool behavior while removing the filesystem assumption from the abstraction.

### FileSystemMemoryStore

Create `src/memory/FileSystemMemoryStore.ts` as the opt-in adapter for the current on-disk format.

Responsibilities:

- Persist memory entries under a filesystem directory
- Preserve the current frontmatter-based memory file format
- Maintain `MEMORY.md` as an implementation detail of this adapter
- Keep the default directory of `~/.blade/memory/` when the consumer explicitly chooses this adapter

This class is not registered anywhere by default. It is only used when a consumer instantiates it.

### Memory Tools

Memory tools become explicit factories that require a configured manager:

```ts
createMemoryReadTool({ manager: MemoryManager })
createMemoryWriteTool({ manager: MemoryManager })
```

The tool factories must not:

- Instantiate their own manager
- Infer a default config directory
- Implicitly create filesystem storage

### Builtin Tool Registration

`getBuiltinTools()` gains an optional `memoryManager` dependency:

```ts
getBuiltinTools({
  sessionId,
  configDir,
  mcpRegistry,
  includeMcpProtocolTools,
  subagentRegistry,
  memoryManager,
})
```

Default behavior:

- If `memoryManager` is absent, do not register `MemoryRead` or `MemoryWrite`.
- If `memoryManager` is present, register both memory tools.

This preserves memory support as an SDK capability while making it opt-in.

## Subagent Architecture

### Builtin Agents

`src/agent/subagents/builtinAgents.ts` keeps only:

- `general-purpose`
- `Explore`
- `Plan`

Remove:

- `verification`

`verification` becomes a documentation and example pattern rather than a builtin product opinion.

### Session-Scoped Registry

The runtime must stop relying on the process-global `subagentRegistry` singleton as the main execution path.

Instead:

- `SessionRuntime` creates a dedicated `SubagentRegistry` instance for the session
- The session registry loads builtin agents
- The session registry loads user-level and project-level agent config files
- The session registry registers `SessionOptions.agents`

This prevents agent definitions from leaking across sessions in the same process.

### Task Tool Factory

Convert the current `taskTool` constant into a factory:

```ts
createTaskTool({ registry: SubagentRegistry })
```

The Task tool description, validation, and runtime lookup should all use the injected registry instance.

`taskOutputTool` can remain as-is because it reads task execution results rather than subagent definitions.

### SessionOptions.agents

`SessionOptions.agents` becomes a real runtime entry point.

Loading order:

1. Builtin agents
2. User-level and project-level agent config files
3. `SessionOptions.agents`

`SessionOptions.agents` wins last because it is the most explicit, per-session configuration source.

Each `AgentDefinition` entry is converted into a `SubagentConfig` and registered into the session-local registry before builtin tools are created.

### Public Exports

Promote subagent primitives to the root public API:

- `SubagentRegistry`
- `SubagentExecutor`
- relevant subagent config and result types

This gives consumers two supported extension paths:

- High-level: `SessionOptions.agents`
- Low-level: instantiate and manage registries and executors directly

## File Layout Changes

### Memory

- `src/memory/MemoryStore.ts`
  - replace current object implementation with the `MemoryStore` interface
- `src/memory/FileSystemMemoryStore.ts`
  - add the filesystem-backed implementation
- `src/memory/MemoryManager.ts`
  - refactor into an orchestration layer over `MemoryStore`
- `src/memory/index.ts`
  - export `MemoryStore`, `FileSystemMemoryStore`, `MemoryManager`, and memory types

### Builtin Tools

- `src/tools/builtin/memory/memoryRead.ts`
  - require an injected `MemoryManager`
- `src/tools/builtin/memory/memoryWrite.ts`
  - require an injected `MemoryManager`
- `src/tools/builtin/index.ts`
  - register memory tools only when `memoryManager` is supplied
- `src/tools/builtin/task/task.ts`
  - replace `taskTool` constant with `createTaskTool({ registry })`
- `src/tools/builtin/task/index.ts`
  - export the task tool factory

### Runtime And Public API

- `src/session/SessionRuntime.ts`
  - create the session-local `SubagentRegistry`
  - register `SessionOptions.agents`
  - pass the registry into builtin tool creation
- `src/agent/subagents/builtinAgents.ts`
  - remove `verification`
- `src/index.ts`
  - export subagent runtime primitives and new memory exports

## Testing Strategy

### Memory Tests

- Add unit tests proving `MemoryManager` works with a custom in-memory fake `MemoryStore`
- Keep filesystem-specific tests for `FileSystemMemoryStore`
- Add tests proving memory tool factories require explicit configuration
- Add tests proving `getBuiltinTools()` excludes memory tools by default
- Add tests proving `getBuiltinTools({ memoryManager })` includes memory tools

### Subagent Tests

- Add tests proving builtin agent registration includes only the three general-purpose modes
- Add tests proving `SessionOptions.agents` are registered into the current session registry
- Add tests proving different sessions do not see each other's custom agent definitions
- Add tests proving the Task tool validates and resolves against the injected registry only

### Documentation Consistency Tests

Where practical, update tests that assert builtin tool names or builtin agent counts so the new defaults are encoded in the suite.

## Documentation Changes

Update the following docs:

- `docs/tools.md`
  - document memory tools as opt-in
  - show explicit `MemoryManager` injection
- `docs/agents.md`
  - document only three builtin agent modes
  - show a custom verification agent example
- `docs/api-reference.md`
  - add `MemoryStore`, `FileSystemMemoryStore`, `MemoryManager`, `SubagentRegistry`, and `SubagentExecutor`
- `docs/session.md`
  - ensure `SessionOptions.agents` is documented as a real runtime feature

## Breaking Changes

This work is intentionally breaking.

Consumers must update the following patterns:

- Default builtin tools no longer include `MemoryRead` and `MemoryWrite`
- `verification` is no longer an automatically available subagent type
- `MemoryManager` no longer accepts a config directory directly
- The core `Memory` type no longer exposes `filePath`
- Filesystem-backed memory now requires explicit construction through `FileSystemMemoryStore`
- Code that depends on process-global subagent registration behavior must move to session-scoped registration or explicit registry management

## Recommended Consumer Usage

### Opt-In Filesystem Memory

```ts
import {
  FileSystemMemoryStore,
  MemoryManager,
  createMemoryReadTool,
  createMemoryWriteTool,
} from '@blade-ai/agent-sdk';

const memoryStore = new FileSystemMemoryStore();
const memoryManager = new MemoryManager(memoryStore);

const tools = [
  createMemoryReadTool({ manager: memoryManager }),
  createMemoryWriteTool({ manager: memoryManager }),
];
```

### Custom Verification Agent

```ts
const session = await createSession({
  provider,
  model,
  agents: {
    verification: {
      name: 'verification',
      description: 'Review code changes for correctness, risks, and missing tests',
      systemPrompt: 'You are a code review specialist.',
      allowedTools: ['Glob', 'Grep', 'Read'],
    },
  },
});
```

## Risks And Mitigations

- Risk: Refactoring the Task tool to a factory may ripple through runtime wiring.
  - Mitigation: add focused tests around builtin tool registration and task validation before refactoring behavior.
- Risk: The current global registry may be relied on implicitly by existing code paths.
  - Mitigation: trace every `subagentRegistry` usage and move each call site to explicit dependency injection.
- Risk: Renaming the current filesystem `MemoryStore` implementation may break imports in internal code.
  - Mitigation: update root exports and internal imports in one pass, then run type-check and targeted tests.

## Acceptance Criteria

- `getBuiltinTools()` does not include memory tools by default
- Memory tools can be added only by explicitly providing a configured `MemoryManager`
- `MemoryManager` depends on a store abstraction instead of directly on filesystem layout
- Filesystem-backed memory remains available as an opt-in adapter
- Builtin subagents are limited to `general-purpose`, `Explore`, and `Plan`
- `verification` is documented as a consumer-defined agent example, not a builtin
- `SessionOptions.agents` is actually wired into runtime registration
- Custom subagent registration is isolated per session
- Root exports expose the subagent and memory primitives needed by SDK consumers
