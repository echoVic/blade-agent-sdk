# Blade Agent SDK

[简体中文](./README.zh-CN.md)

A session-first TypeScript SDK for building AI agents on Node.js. It provides one API for multi-turn conversations, streaming tool execution, MCP, subagents, Skills, permissions, hooks, sandbox policies, structured output, and observability.

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

## Quick Start

```ts
import { createSession } from '@blade-ai/agent-sdk';

const session = await createSession({
  provider: { type: 'openai', apiKey: process.env.OPENAI_API_KEY! },
  model: 'gpt-4o-mini',
  temperature: 0.2,
  maxOutputTokens: 4096,
});

await session.send('Summarize the responsibilities of this project');

for await (const event of session.stream()) {
  if (event.type === 'content') {
    process.stdout.write(event.delta);
  }
}

await session.close();
```

For a one-shot request, use `prompt()`:

```ts
import { prompt } from '@blade-ai/agent-sdk';

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
- Durable recovery: pre-start resume, safe Request/Turn rollover, explicit reconciliation, and reconnectable cursors
- Streaming: 17 typed events for turns, content, reasoning, tools, usage, steering, results, and errors
- Providers: OpenAI, Anthropic, Azure OpenAI, Gemini, DeepSeek, and OpenAI-compatible APIs
- Tools: generator-only custom tools, capability-grouped built-ins, MCP tools, and typed progress/effects
- Collaboration: foreground and background subagents, task tools, and project Skills
- Safety: permission modes, policy callbacks, hooks, path checks, and optional OS sandbox integration
- Runtime: optional workspace context, structured output, persistence, context compaction, token budgets, and traces

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
import { createSession } from '@blade-ai/agent-sdk';
import { InputPriority, ToolKind } from '@blade-ai/agent-sdk/core';
import { defineTool } from '@blade-ai/agent-sdk/tools';
import { getBuiltinTools } from '@blade-ai/agent-sdk/local';
```

- Root: complete Node.js API
- `/core`: browser-safe contracts, constants, and types
- `/tools`: browser-safe tool authoring primitives
- `/server` and `/session`: server-side Session APIs
- `/local`: built-in local tools and local runtime helpers

Importing a server-only entry in a browser resolves to a stub that throws a clear runtime error.

## Persistence and Workspace

Sessions are in-memory unless `storagePath` is configured:

```ts
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

The workspace is optional. Sessions and explicitly configured agents work without one, but local filesystem tools and project-level discovery require a filesystem-capable workspace.

## Documentation

- [English documentation](./docs/en/index.md)
- [Durable Event Store](./docs/en/durable-events.md)
- [中文文档](./docs/index.md)
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
