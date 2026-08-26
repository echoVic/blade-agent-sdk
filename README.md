# Blade Agent SDK

[简体中文](./README.zh-CN.md)

A session-first TypeScript Agent SDK for both local Node.js processes and Node.js servers. It provides one API for multi-turn conversations, streaming tool execution, MCP, subagents, Skills, permissions, hooks, sandbox policies, structured output, and observability.

## Requirements

- Node.js 22.14.0 or later
- An ESM project or ESM-capable build tool

The package is ESM-only and does not support CommonJS `require()`.

## Install

```bash
npm install @blade-ai/agent-sdk
# or
pnpm add @blade-ai/agent-sdk
```

## Choose a Starting Point

Create a local Node.js Agent without PostgreSQL or Docker:

```bash
npm exec --yes --package=@blade-ai/agent-sdk@latest -- \
  create-blade-agent my-agent --preset local --verify
```

Create a Browser + AgentServer application with in-process Sessions:

```bash
npm exec --yes --package=@blade-ai/agent-sdk@latest -- \
  create-blade-agent my-agent --preset web --verify
```

Create the complete production topology:

```bash
npm exec --yes --package=@blade-ai/agent-sdk@latest -- \
  create-blade-agent my-agent --preset production --verify
```

All three presets use the same Session and protocol semantics. Their
generation, installation, and real-smoke budgets are one minute for `local`,
two minutes for `web`, and five minutes for `production`. The production
preset includes the browser client, `AgentServer`, PostgreSQL, `AgentWorker`,
`DockerExecutionHost`, and operations endpoints. Omitting `--preset` preserves
the production default. Omit `--verify` to avoid running the smoke, or use
`--skip-install` to write files only.

## Quick Start

```ts
import { createSession } from '@blade-ai/agent-sdk/server';

const session = await createSession({
  provider: { type: 'openai', apiKey: process.env.OPENAI_API_KEY! },
  model: 'gpt-4o-mini',
  temperature: 0.2,
  maxOutputTokens: 4096,
});

await session.send('Analyze this report and return three key findings');

for await (const event of session.stream()) {
  if (event.type === 'content') {
    process.stdout.write(event.delta);
  }
}

await session.close();
```

For a one-shot request, use `prompt()`:

```ts
import { prompt } from '@blade-ai/agent-sdk/server';

const result = await prompt('Explain this API surface', {
  provider: { type: 'openai', apiKey: process.env.OPENAI_API_KEY! },
  model: 'gpt-4o-mini',
});

console.log(result.result);
console.log(result.toolCalls);
console.log(result.usage);
```

## Core Capabilities

- Session lifecycle: `createSession()`, `resumeSession()`, `forkSession()`, and `prompt()`
- Steerable requests: durable `now`, `next`, and `later` inputs with cancellation and pending-input inspection
- Durable recovery: lease-fenced execution ownership, controlled worker handoff, safe Request/Turn rollover, explicit model/tool reconciliation, and reconnectable cursors
- Execution plane: `AgentWorker`, `SdkSessionRunner`, `ExecutionHostSessionRunner`, and a durable `EffectDispatcher`
- Streaming: 17 typed events for turns, content, reasoning, tools, usage, steering, results, and errors
- Providers: OpenAI, Anthropic, Azure OpenAI, Gemini, DeepSeek, and OpenAI-compatible APIs
- Tools: generator-only custom tools, capability-grouped built-ins, MCP tools, and typed progress/effects
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

Tool execution uses `AsyncGenerator<ToolYield, ToolResult>` exclusively:

```ts
import { defineTool, ToolKind, ToolSideEffect } from '@blade-ai/agent-sdk';

const weather = defineTool({
  name: 'GetWeather',
  description: 'Get the weather for a city',
  kind: ToolKind.ReadOnly,
  sideEffect: ToolSideEffect.PURE,
  parameters: {
    type: 'object',
    properties: {
      city: { type: 'string' },
    },
    required: ['city'],
  },
  async *execute({ city }) {
    yield { kind: 'progress', message: `Loading weather for ${city}` };
    return {
      status: 'success',
      model: `${city}: clear, 25 C`,
      display: { summary: `Weather for ${city}` },
    };
  },
});
```

## Package Entry Points

```ts
import { createSession as createServerSession } from '@blade-ai/agent-sdk/server';
import { createSession as createNodeSession } from '@blade-ai/agent-sdk/node';
import { AgentClient } from '@blade-ai/agent-sdk/browser';
import { AGENT_PROTOCOL_VERSION } from '@blade-ai/agent-sdk/protocol';
import { PostgresRuntimeStore } from '@blade-ai/agent-sdk/server/postgres';
import { OpenTelemetryAgentServerTelemetry } from '@blade-ai/agent-sdk/server/otel';
import { InputPriority, ToolKind } from '@blade-ai/agent-sdk/core';
import { defineTool } from '@blade-ai/agent-sdk/tools';
import { composeMiddleware } from '@blade-ai/agent-sdk/middleware';
import type { ModelMessage, ModelService } from '@blade-ai/agent-sdk/model';
```

- Root and `/server`: server-side agents; expose `AgentServer` with an injectable `SessionExecutor` and load only explicitly supplied capabilities
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

This starts PostgreSQL, `AgentServer`, `AgentWorker`, and an isolated Docker
execution host. See [Runnable golden paths](./examples/README.md).

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
`SessionEventStore` are configured. The `/node` entry converts `storagePath`
into one local JSONL `SessionPersistence` implementation:

```ts
import { createSession } from '@blade-ai/agent-sdk/node';

const session = await createSession({
  provider,
  model,
  storagePath: '/var/lib/my-agent',
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

The root and `/server` entries never interpret `storagePath` as local access.
Server applications must inject `sessionRepository` plus `sessionEventStore`,
or configure one shared `runtimeStore`. See
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

Releases are managed only by `semantic-release`. Every releasable pull request must add a bilingual JSON fragment under `.changes/`. On `main`, the release workflow:

```json
{
  "type": "feature",
  "en": "Add a user-facing capability.",
  "zh-CN": "新增一项用户可见能力。"
}
```

Use a unique kebab-case filename. Allowed types are `breaking`, `feature`,
`fix`, `performance`, `refactor`, and `docs`.

1. validates, builds, and tests the package and documentation;
2. determines the next version from conventional commits;
3. updates `package.json`, `CHANGELOG.md`, and `CHANGELOG.zh-CN.md`;
4. commits the generated release metadata;
5. publishes the npm package and GitHub Release.

Run `pnpm run changelog:check` to validate fragments and `pnpm run release:dry` to preview a release.

See [CONTRIBUTING.md](./CONTRIBUTING.md) for contribution guidance.

## License

[MIT](./LICENSE)
