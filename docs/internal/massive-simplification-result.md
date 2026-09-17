# Massive Simplification Result

## Outcome

The simplification program reduced production TypeScript from the agreed
baseline of **83,805 LOC** to **56,331 LOC**:

- **27,474 lines removed**
- **32.8% net reduction**
- **895 lines** in the largest remaining production file
- **0 functions** above 150 lines

The measurement includes `src/**/*.ts` and excludes tests and spec files. Tests,
generated output, changelog fragments, and documentation do not contribute to
the reduction.

## Ownership Map

| Area | Authoritative owner |
|------|---------------------|
| Tool declarations and invocation preparation | `tools/core/createTool.ts`, `tools/core/ToolInvocation.ts` |
| Tool registration and exposure | `tools/registry/ToolRegistry.ts`, `tools/exposure/ToolExposurePlanner.ts` |
| Agent turns and tool execution | `agent/AgentLoop.ts`, `agent/loop/runTurn.ts`, `agent/loop/runToolCall.ts` |
| Session request lifecycle | `session/SessionRequestExecution.ts`, `session/SessionStreamRunner.ts` |
| Durable state transitions | `session/events/DurableSessionReducer.ts` and domain reducers |
| PostgreSQL storage | `server/PostgresContext.ts`, `server/PostgresEventStreams.ts`, `server/PostgresExecutionLeases.ts` |
| Built-in filesystem operations | `tools/builtin/file/operationCore.ts` |
| Built-in search | `tools/builtin/search/searchRunner.ts` |
| Built-in web requests | `tools/builtin/web/webRequest.ts` |
| Structured task CRUD | `tools/builtin/task/taskCrud.ts`, `tools/builtin/task/TaskStore.ts` |
| Built-in model adapters | `services/modelProvider.ts`, `services/modelAdapter.ts` |
| Docker execution | `execution/DockerExecutionHost.ts`, `execution/DockerExecutionPolicy.ts`, `execution/DockerProcessRunner.ts`, `execution/DockerWorkspace.ts` |

## Removed Parallel Systems

- Deprecated tool authoring, catalog, metadata, and runtime-shape compatibility
  paths.
- Shell hook protocol, external hook process infrastructure, and duplicated hook
  schemas.
- Legacy transcript repair, duplicate persisted histories, generic outbox and
  checkpoint persistence, and test-only runtime stores shipped as production
  APIs.
- Duplicate Agent execution paths, streaming executors, session cleanup paths,
  and queue implementations.
- Git/system/JavaScript Grep fallbacks, Exa MCP search, standalone search cache
  and provider modules, and per-operation file/task wrappers.
- Unused runtime dependencies: `chalk`, `lodash-es`, `semver`, and `zustand`.

## Verification

The final branch is required to pass:

- `pnpm lint`
- `pnpm type-check`
- `pnpm test`
- `pnpm docs:build`
- `pnpm changelog:check`
- `pnpm verify:entrypoints`
- `pnpm verify:install`

`src/__tests__/simplificationArchitecture.test.ts` enforces the 900-line file
limit, the 150-line function limit, provider/Docker ownership boundaries, and
the removed dependency set.
