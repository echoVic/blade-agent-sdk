# Overview

`@blade-ai/agent-sdk` is a session-first TypeScript framework for AI agents. It combines model providers, multi-turn state, streaming tool execution, MCP, subagents, Skills, permissions, hooks, structured output, and observability behind one Session API.

Use it for CLI assistants, IDE integrations, automation services, and conversational developer tools.

## Requirements

- Node.js 22.14.0 or later
- ESM

## Install

```bash
npm install @blade-ai/agent-sdk
# or
pnpm add @blade-ai/agent-sdk
```

## Stream a response

```ts
import { createSession } from '@blade-ai/agent-sdk';

const session = await createSession({
  provider: { type: 'openai', apiKey: process.env.OPENAI_API_KEY! },
  model: 'gpt-4o-mini',
});

await session.send('Explain TypeScript in three sentences');

for await (const event of session.stream()) {
  if (event.type === 'content') {
    process.stdout.write(event.delta);
  }
}

await session.close();
```

## Run a one-shot prompt

```ts
import { prompt } from '@blade-ai/agent-sdk';

const result = await prompt('Summarize this API', {
  provider: { type: 'openai', apiKey: process.env.OPENAI_API_KEY! },
  model: 'gpt-4o-mini',
});

console.log(result.result);
console.log(result.usage);
```

## Add a custom tool

```ts
import { createSession, defineTool, ToolKind } from '@blade-ai/agent-sdk';

const weather = defineTool({
  name: 'GetWeather',
  description: 'Get the current weather for a city',
  kind: ToolKind.ReadOnly,
  sideEffect: 'pure',
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

const session = await createSession({
  provider,
  model,
  tools: [weather],
});
```

Tool execution always returns `AsyncGenerator<ToolYield, ToolResult>`. See [Tools](./tools) for progress, effects, cancellation, and result contracts.

## Session-first API

```text
createSession() -> ISession
                    |- send()
                    |- stream()
                    |- getPendingInputs() / cancelInput()
                    |- abort() / close()
                    |- fork()
                    |- setModel() / setPermissionMode()
                    |- mcpConnect() / mcpDisconnect()
                    `- getLastTrace() / getTraces()
```

`send()` starts work when the Session is idle. During an active request, it can steer the request with `now` or `next`, or queue an independent `later` input.

```ts
const active = await session.send('Refactor the parser');

await session.send('Do not change public types', {
  priority: 'next',
  expectedRequestId:
    active.status === 'started' ? active.requestId : undefined,
});
```

See [Session](./session) for the full lifecycle and stream events.

## Filesystem context

The SDK does not implicitly use `process.cwd()`. Configure a filesystem capability when local tools need a workspace:

```ts
const session = await createSession({
  provider,
  model,
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

Without a filesystem capability, conversation, remote tools, explicitly configured tools, and explicitly configured subagents still work. Local file tools and project discovery do not.

## Persistence

Sessions use in-memory storage unless `storagePath` is set:

```ts
const session = await createSession({
  provider,
  model,
  storagePath: '/var/lib/my-agent',
});
```

Persistent sessions can be restored with `resumeSession()` or forked with `forkSession()`. Set `persistSession: false` to force in-memory behavior even when a path is present.
Local transcript writes are same-host process-safe and crash-tail-aware; malformed
committed records fail closed during restore. See [Session](./session) for the
filesystem and native-lock constraints.

## Providers

| Provider | `type` |
|----------|--------|
| OpenAI | `openai` |
| Anthropic | `anthropic` |
| Azure OpenAI | `azure-openai` |
| Google Gemini | `gemini` |
| DeepSeek | `deepseek` |
| OpenAI-compatible | `openai-compatible` |

See [Providers and Logging](./providers).

## Next steps

- [Session](./session)
- [Tools](./tools)
- [Permissions](./permissions)
- [MCP Integration](./mcp)
- [API Reference](./api-reference)
