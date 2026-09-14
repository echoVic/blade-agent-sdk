# Overview

`@blade-ai/agent-sdk` is a TypeScript framework for AI agents. Application
code starts with the layered `createAgent()` facade; the Session core still
owns multi-turn state, streaming tools, MCP, permissions, hooks, and
observability.

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
import { createAgent } from '@blade-ai/agent-sdk';

const agent = await createAgent({
  model: 'gpt-4o-mini',
  apiKey: process.env.OPENAI_API_KEY!,
});

await agent.send('Explain TypeScript in three sentences');

for await (const event of agent.stream()) {
  if (event.type === 'content') {
    process.stdout.write(event.delta);
  }
}

await agent.close();
```

## Run a one-shot prompt

```ts
import { prompt } from '@blade-ai/agent-sdk/server';

const result = await prompt('Summarize this API', {
  provider: { type: 'openai', apiKey: process.env.OPENAI_API_KEY! },
  model: 'gpt-4o-mini',
});

console.log(result.result);
console.log(result.usage);
```

## Add a custom tool

```ts
import { createAgent, defineTool } from '@blade-ai/agent-sdk';
import { z } from 'zod';

const weather = defineTool({
  name: 'GetWeather',
  description: 'Get the current weather for a city',
  parameters: z.object({ city: z.string() }),
  async execute({ city }) {
    return { weather: `${city}: clear, 25 C` };
  },
});

const agent = await createAgent({
  model,
  apiKey,
  tools: [weather],
});
```

`defineTool()` wraps regular async returns as internal generators. See
[Tools](./tools) for advanced progress, effects, cancellation, and result
contracts.

## Agent facade and Session core

```text
createAgent() -> Agent (ISession)
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

Framework and runtime integrations can continue to use `createSession()` from
`/node` or `/server`.

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
