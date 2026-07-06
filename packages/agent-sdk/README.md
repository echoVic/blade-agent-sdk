# @blade-ai/agent-sdk

Session-first Blade Agent SDK for server and CLI applications.

Use this package when you want the product-level SDK: `createSession()`, streaming turns, tool execution, MCP, permissions, hooks, observability, sandbox integration, memory, subagents, and session persistence. It composes `@blade-ai/agent` and `@blade-ai/ai` behind a stable session-first API.

## Installation

```bash
pnpm add @blade-ai/agent-sdk
```

## Usage

```ts
import { createSession } from '@blade-ai/agent-sdk';

const session = await createSession({
  provider: {
    type: 'openai-compatible',
    apiKey: process.env.GLM_API_KEY!,
    baseUrl: process.env.GLM_BASE_URL!,
  },
  model: 'glm-5.2',
  allowedTools: [],
});

await session.send('Summarize this project');

for await (const event of session.stream()) {
  if (event.type === 'content') process.stdout.write(event.delta);
}

session.close();
```

The root entry is intended for Node server and CLI usage. Browser code should use browser-safe subpaths such as `@blade-ai/agent-sdk/core` and communicate with a server route for real agent execution.

Full example: `examples/session-first-server.ts` in the repository.
