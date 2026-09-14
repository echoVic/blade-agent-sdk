# Blade Agent SDK

[简体中文](./README.zh-CN.md)

A session-first TypeScript Agent SDK for both local Node.js processes and Node.js servers. It provides one API for multi-turn conversations, streaming tool execution, MCP, subagents, Skills, permissions, hooks, sandbox policies, structured output, and observability.

## Requirements

- Node.js 22.14.0 or later
- An ESM project or ESM-capable build tool

The package is ESM-only and does not support CommonJS `require()`.

## 5-Minute Quick Start

```bash
npm install @blade-ai/agent-sdk
```

Create `agent.mjs`:

```js
import { createAgent } from '@blade-ai/agent-sdk';

const apiKey = process.env.OPENAI_API_KEY;
if (!apiKey) throw new Error('OPENAI_API_KEY is required');

const agent = await createAgent({
  model: 'gpt-4o-mini',
  apiKey,
  filesystem: {
    roots: [process.cwd()],
    cwd: process.cwd(),
  },
});

await agent.send('Read package.json and summarize this project in three bullets');

for await (const event of agent.stream()) {
  if (event.type === 'content') {
    process.stdout.write(event.delta);
  }
}

await agent.close();
```

Run it:

```bash
OPENAI_API_KEY=your-key node agent.mjs
```

`createAgent()` defaults to OpenAI. Set `provider` and `baseUrl` for another
provider. A `filesystem` option automatically selects the local runtime
profile; without it, the server profile is used. Select either behavior
explicitly with `profile: 'local' | 'server'`.

Common options stay at the top level. Infrastructure and policy options live
under `advanced`:

```ts
const agent = await createAgent({
  model: 'gpt-4o-mini',
  apiKey,
  temperature: 0.2,
  systemPrompt: 'Be concise.',
  advanced: {
    permission: 'accept-edits',
    tokenBudget: { maxTotalTokens: 100_000 },
  },
});
```

## Project Starters

Generate a local Agent without PostgreSQL or Docker:

```bash
npm exec --yes --package=@blade-ai/agent-sdk@latest -- \
  create-blade-agent my-agent --preset local --verify
```

Generate a Browser + AgentServer application:

```bash
npm exec --yes --package=@blade-ai/agent-sdk@latest -- \
  create-blade-agent my-agent --preset web --verify
```

Generate the complete PostgreSQL, Worker, Docker, approval, and recovery
topology:

```bash
npm exec --yes --package=@blade-ai/agent-sdk@latest -- \
  create-blade-agent my-agent --preset production --verify
```

The longest installed smoke has a five-minute budget. Omit `--verify` to skip
it, or use `--skip-install` to write files only.

## Low-Level Session APIs

Framework and runtime integrations can use `createSession()` directly:

```ts
import { createSession as createNodeSession } from '@blade-ai/agent-sdk/node';
import { createSession as createServerSession } from '@blade-ai/agent-sdk/server';
```

Both entries share the Session API, the built-in tool set, and the protocol.
They differ in where the process runs and what it may touch:

| | `/node` | `/server` |
|---|---------|-----------|
| Local file and Shell tools | Available once a `filesystem` capability is configured | Same tools, but the server profile omits environment, Skill, and subagent discovery |
| `storagePath` | Backed by local JSONL persistence | Throws `ConfigError`: server Sessions need `sessionRepository` and `sessionEventStore` |
| Default persistence | Local JSONL when `storagePath` is set | In memory unless you inject a repository |
| Context and Skill discovery | Enabled | Disabled (`localDiscovery` is off) |

Start with `/node` for a local agent or CLI. Use `/server` when the runtime is
a shared multi-tenant service and you inject storage explicitly.

## Core Capabilities

- Agent facade: `createAgent()` with required, common, and `advanced` option layers
- Low-level Session lifecycle: `createSession()`, `resumeSession()`, `forkSession()`, and `prompt()`
- Steerable requests: durable `now`, `next`, and `later` inputs with cancellation and pending-input inspection
- Durable recovery: lease-fenced execution ownership, controlled worker handoff, safe Request/Turn rollover, explicit model/tool reconciliation, and reconnectable cursors
- Execution plane: `AgentWorker`, the injectable `SessionRunner` contract, `SdkSessionRunner`, `ExecutionHostSessionRunner`, and a durable `EffectDispatcher`
- Streaming: 17 typed events for turns, content, reasoning, tools, usage, steering, results, and errors
- Providers: OpenAI, Anthropic, Azure OpenAI, Gemini, DeepSeek, and OpenAI-compatible APIs
- Tools: async-function and AsyncGenerator authoring, Zod schemas, capability-grouped built-ins, MCP tools, and typed progress/effects
- Extensibility: onion-style model/tool middleware and declarative plugins that bundle middleware, hooks, and tools
- Collaboration: foreground and background subagents, task tools, and project Skills
- Safety: bounded model, tool, and inline-hook execution, permission modes, policy callbacks, path checks, and optional OS sandbox integration
- Runtime: optional workspace context, structured output, crash-safe local transcripts, context compaction, token budgets, and traces

## Steer an Active Request

`send()` returns an `InputSubmission`. While a request is active, choose when the new input should apply:

```ts
const current = await session.send('Analyze the repository');

for await (const event of session.stream()) {
  if (event.type === 'tool_use' && event.name === 'Bash') {
    await session.send('Stop editing and only report findings', {
      priority: 'now',
      expectedRequestId: current.requestId,
    });
  }
}
```

- `now`: interrupt the current cancellable step and steer immediately
- `next`: apply at the next model or tool safe point
- `later`: queue input for the next request

Use `getPendingInputs()` and `cancelInput()` to manage accepted inputs.

## Custom Tools

Use a Zod schema with a regular async function for the common path. The return
value is converted to a successful internal tool result:

```ts
import { defineTool } from '@blade-ai/agent-sdk';
import { z } from 'zod';

const weather = defineTool({
  name: 'GetWeather',
  description: 'Get the weather for a city',
  parameters: z.object({ city: z.string() }),
  async execute({ city }) {
    return { weather: `${city}: clear, 25 C` };
  },
});
```

Use `async *execute` when the tool needs to yield typed progress, messages, or
effects. Generator tools keep the existing `ToolResult` terminal contract.

## Permissions and Hooks

New Agent integrations use one permission field:

```ts
const agent = await createAgent({
  model: 'gpt-4o-mini',
  apiKey,
  advanced: {
    permission: async (request) =>
      request.kind === 'readonly' ? 'allow' : 'ask',
    hooks: {
      PreToolUse: [
        async (event) => {
          console.log(event.toolName, event.toolInput);
          return { action: 'continue' };
        },
      ],
    },
  },
});
```

`advanced.hooks` contains in-process TypeScript callbacks for the eight Session
hook events. Shell hooks use `HookConfig` in CLI/host configuration and are not
accepted by `createAgent()`. The low-level `SessionOptions.permissionMode` and
`permissionHandler` APIs remain available for runtime integrations;
`canUseTool` is deprecated.

## Package Entry Points

```ts
import { createAgent, defineTool } from '@blade-ai/agent-sdk';
import { createSession as createServerSession } from '@blade-ai/agent-sdk/server';
import { createSession as createNodeSession } from '@blade-ai/agent-sdk/node';
import { AgentClient } from '@blade-ai/agent-sdk/browser';
import { AGENT_PROTOCOL_VERSION } from '@blade-ai/agent-sdk/protocol';
import { PostgresRuntimeStore } from '@blade-ai/agent-sdk/server/postgres';
import { OpenTelemetryAgentServerTelemetry } from '@blade-ai/agent-sdk/server/otel';
import { InputPriority, ToolKind } from '@blade-ai/agent-sdk/core';
import { composeMiddleware } from '@blade-ai/agent-sdk/middleware';
import type { ModelMessage, ModelService } from '@blade-ai/agent-sdk/model';
```

- Root: the default `createAgent` and tool-authoring API
- `/server`: low-level server Sessions and `AgentServer` with an injectable `SessionExecutor`
- `/server/postgres`: shared PostgreSQL Runtime Store for commands, events, effects, projections, worker leases, routing, transcripts, and durable journals
- `/server/otel`: OpenTelemetry metrics, traces, and audit adapter
- `/server/testing`: framework-independent Runtime Store conformance suite
- `/node`: Node.js runtimes with local host access; enables file, search, shell, and task tools plus local agent/Skill discovery, and exports Node host adapters
- `/browser`: browser-safe `AgentClient`, protocol view, and explicit server-only execution stubs
- `/protocol`: browser-safe versioned command/event contracts and strict parsers
- `/core`: browser-safe contracts, constants, and types
- `/tools`: browser-safe tool authoring primitives
- `/middleware`: browser-safe middleware and plugin contracts
- `/model`: browser-safe provider-neutral model contracts, messages, configuration, and usage
- `/session`: lower-level server Session API

Importing a server-only entry in a browser resolves to a stub that throws a clear runtime error.

Run the complete browser-to-worker production topology locally with one command:

```bash
pnpm example:production
```

This starts PostgreSQL, `AgentServer`, `AgentWorker` running a real SDK
Session, and an isolated Docker repository workspace with a browser approval
step. See [Runnable golden paths](./examples/README.md).

PostgreSQL, OpenTelemetry, non-bundled provider adapters, and native Node enhancements
are opt-in peers:

```bash
pnpm add pg                         # /server/postgres
pnpm add @opentelemetry/api         # /server/otel
pnpm add @ai-sdk/anthropic          # provider: anthropic
pnpm add fs-native-extensions        # cross-process Node JSONL locks
```

## Persistence and Workspace

Sessions are ephemeral unless a read-side `SessionRepository` and write-side
`SessionEventStore` are configured. A local Agent converts
`advanced.storagePath` into one local JSONL `SessionPersistence`
implementation:

```ts
import { createAgent } from '@blade-ai/agent-sdk';

const agent = await createAgent({
  model,
  apiKey,
  profile: 'local',
  filesystem: {
    roots: [process.cwd()],
    cwd: process.cwd(),
  },
  advanced: {
    storagePath: '/var/lib/my-agent',
  },
});
```

The low-level root `createSession()` and `/server` entry never interpret
`storagePath` as local persistence. Server applications must inject
`sessionRepository` plus `sessionEventStore`, or configure one shared
`runtimeStore`. See
[Server Runtime](./docs/en/server-runtime.md) for the HTTP/SSE server,
browser client, multi-tenant storage, idempotency, approvals, and telemetry.
For multi-instance storage, see [Runtime Store](./docs/en/runtime-store.md).
For worker coordination and crash recovery, see
[Worker Runtime](./docs/en/worker-runtime.md).
For container isolation, resource limits, checkpoints, and ephemeral
credentials, see [Execution Host](./docs/en/execution-host.md).
The ownership and boundary rules for public contracts are documented in
[Type Architecture](./docs/en/type-architecture.md).

The workspace is optional. Sessions and explicitly configured agents work without one, but local filesystem tools and project-level discovery require a filesystem-capable workspace.

## Documentation

- [English documentation](./docs/en/index.md)
- [Middleware and plugins](./docs/en/middleware.md)
- [Server Runtime](./docs/en/server-runtime.md)
- [Runtime Store](./docs/en/runtime-store.md)
- [Worker Runtime](./docs/en/worker-runtime.md)
- [Execution Host](./docs/en/execution-host.md)
- [Durable Event Store](./docs/en/durable-events.md)
- [中文文档](./docs/index.md)
- [Migrating to your own repository](./docs/en/migrating-to-your-repository.md)
- [Runnable golden paths](./examples/README.md)
- [Runtime benchmarks](./docs/en/runtime-benchmarks.md)
- [English changelog](./CHANGELOG.md)
- [中文更新日志](./CHANGELOG.zh-CN.md)

## Development

```bash
pnpm install
pnpm run lint
pnpm run type-check
pnpm run test
pnpm run build
pnpm run docs:build
```

## Release Process

The released version comes from the Git tag, never from commit types. Every
releasable change still adds a bilingual JSON fragment under `.changes/`:

```json
{
  "type": "feature",
  "en": "Add a user-facing capability.",
  "zh-CN": "新增一项用户可见能力。"
}
```

Use a unique kebab-case filename. Allowed types are `breaking`, `feature`,
`fix`, `performance`, `refactor`, and `docs`; they select the changelog section,
not the version.

To publish, tag the commit on `main` and push that tag:

```bash
git tag v7.4.2
git push origin v7.4.2
```

The release workflow then, from the tagged tree:

1. checks out the tag it names and stamps that version into `package.json` **before** anything is built, so the bundle and the tarball manifest carry the released version rather than the previous one;
2. validates fragments, lints, type-checks, builds, and tests the package and documentation;
3. publishes exactly `v7.4.2` to npm with provenance — no other number can be produced — after checking that the built output really contains that version;
4. records the version, both changelogs, and the consumed fragments in one `chore(release): 7.4.2` commit on `main`;
5. creates the GitHub Release with the bilingual notes.

Pushing to `main` no longer releases anything. Validate fragments with
`pnpm run changelog:check`, and preview a release by creating the tag locally
first and running `pnpm run release:dry --tag v7.4.2`.

See [CONTRIBUTING.md](./CONTRIBUTING.md) for contribution guidance.

## License

[MIT](./LICENSE)
