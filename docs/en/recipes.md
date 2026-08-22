# Recipes

## Multi-turn conversation

```ts
const session = await createSession({ provider, model });

for (const prompt of [
  'Inspect src/index.ts',
  'Identify its highest-risk issue',
  'Propose a focused fix',
]) {
  await session.send(prompt);
  for await (const event of session.stream()) {
    if (event.type === 'content') {
      process.stdout.write(event.delta);
    }
  }
}

await session.close();
```

## Steer while streaming

```ts
const started = await session.send('Refactor the module');

const streamTask = (async () => {
  for await (const event of session.stream()) {
    if (event.type === 'content') {
      process.stdout.write(event.delta);
    }
    if (event.type === 'input_applied') {
      console.log('Steering applied', event.inputId);
    }
  }
})();

await session.send('Keep the public API unchanged', {
  priority: 'next',
  expectedRequestId:
    started.status === 'started' ? started.requestId : undefined,
});

await streamTask;
```

Use `now` only when the current step should be interrupted. Use `later` for an independent follow-up request.

## Cancel a long request

```ts
const controller = new AbortController();
setTimeout(() => controller.abort(), 60_000);

await session.send('Analyze the entire repository', {
  signal: controller.signal,
});

for await (const event of session.stream()) {
  if (event.type === 'content') {
    process.stdout.write(event.delta);
  }
  if (event.type === 'error') {
    console.error('Request failed or was cancelled:', event.message);
  }
}
```

Request errors are projected as stream events. Do not rely only on a `try/catch` around the loop.

## Queue and cancel follow-ups

```ts
const queued = await session.send('Run tests afterward', {
  priority: 'later',
});

for (const input of session.getPendingInputs()) {
  console.log(input.inputId, input.priority, input.acceptedAt);
}

await session.cancelInput(queued.inputId);
```

## Structured output

```ts
import type { OutputFormat } from '@blade-ai/agent-sdk';

const outputFormat: OutputFormat = {
  type: 'json_schema',
  json_schema: {
    name: 'code_review',
    strict: true,
    schema: {
      type: 'object',
      properties: {
        summary: { type: 'string' },
        issues: {
          type: 'array',
          items: {
            type: 'object',
            properties: {
              severity: {
                type: 'string',
                enum: ['error', 'warning', 'info'],
              },
              file: { type: 'string' },
              message: { type: 'string' },
            },
            required: ['severity', 'file', 'message'],
          },
        },
      },
      required: ['summary', 'issues'],
    },
  },
};

const session = await createSession({
  provider,
  model,
  outputFormat,
});
```

Provider support for strict structured output varies.

## Automatic cleanup

```ts
{
  await using session = await createSession({ provider, model });

  await session.send('Hello');
  for await (const event of session.stream()) {
    // Consume the full stream.
  }
}
```

`ISession` implements `AsyncDisposable`.

## Exhaustive stream handling

```ts
for await (const event of session.stream({ includeThinking: true })) {
  switch (event.type) {
    case 'turn_start':
    case 'turn_end':
      console.log(event.type, event.turn);
      break;
    case 'turn_interrupted':
    case 'input_applied':
      console.log(event.type, event.inputId);
      break;
    case 'content':
      process.stdout.write(event.delta);
      break;
    case 'thinking':
      process.stderr.write(event.delta);
      break;
    case 'tool_use':
      console.log('tool', event.name, event.input);
      break;
    case 'tool_progress':
      console.log(event.progress);
      break;
    case 'tool_message':
      console.log(event.content);
      break;
    case 'tool_runtime_patch':
    case 'tool_context_patch':
      console.log(event.patch);
      break;
    case 'tool_new_messages':
      console.log(event.messages);
      break;
    case 'tool_permission_updates':
      console.log(event.updates);
      break;
    case 'tool_result':
      console.log(event.name, event.output, event.display);
      break;
    case 'usage':
      console.log(event.usage.totalTokens);
      break;
    case 'result':
      console.log(event.subtype, event.content ?? event.error);
      break;
    case 'error':
      console.error(event.code, event.message);
      break;
  }
}
```

## Opt-in memory tools

`getBuiltinTools()` can create a memory-enabled tool set for a custom
lower-level runtime:

```ts
import {
  FileSystemMemoryStore,
  getBuiltinTools,
  MemoryManager,
} from '@blade-ai/agent-sdk';

const manager = new MemoryManager(
  new FileSystemMemoryStore('/var/lib/my-agent/memory'),
);

const tools = await getBuiltinTools({
  memoryManager: manager,
});
```

`FileSystemMemoryStore` writes one frontmatter-backed Markdown file per memory
and maintains a `MEMORY.md` index. Memory types are `user`, `project`,
`feedback`, and `reference`.

::: warning Session integration
`createMemoryReadTool()` and `createMemoryWriteTool()` return the lower-level
`Tool` interface, while `SessionOptions.tools` currently accepts
`ToolDefinition`. Do not pass those helper results directly to Session; there
is no first-class `memoryManager` Session option yet.
:::

## Tool source policy

```ts
const session = await createSession({
  provider,
  model,
  toolSourcePolicy: {
    allowedSources: ['builtin', 'custom'],
    allowedTrustLevels: ['trusted', 'workspace'],
  },
});
```

| Source | Typical trust |
|--------|---------------|
| Built-in tools | `trusted` |
| `SessionOptions.tools` | `workspace` |
| Remote MCP tools | `remote` |

## Session-local subagents

```ts
const session = await createSession({
  provider,
  model,
  agents: {
    reviewer: {
      name: 'reviewer',
      description: 'Review code for correctness and security',
      allowedTools: ['Read', 'Glob', 'Grep'],
    },
    'test-writer': {
      name: 'test-writer',
      description: 'Write and repair focused tests',
      allowedTools: ['Read', 'Write', 'Edit', 'Bash', 'Glob', 'Grep'],
    },
  },
});
```

## In-process MCP tools

```ts
import {
  createSdkMcpServer,
  createSession,
  tool,
} from '@blade-ai/agent-sdk';
import { z } from 'zod';

const analyzeDependencies = tool(
  'analyze-dependencies',
  'Analyze package dependencies',
  {
    packageJson: z.string(),
  },
  async ({ packageJson }) => ({
    content: [
      {
        type: 'text',
        text: await analyze(packageJson),
      },
    ],
  }),
);

const server = await createSdkMcpServer({
  name: 'project-tools',
  version: '1.0.0',
  tools: [analyzeDependencies],
});

const session = await createSession({
  provider,
  model,
  mcpServers: {
    projectTools: server,
  },
});
```
