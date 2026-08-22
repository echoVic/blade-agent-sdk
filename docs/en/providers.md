# Providers and Logging

## Supported providers

| Provider | `type` | Package |
|----------|--------|---------|
| OpenAI | `openai` | `@ai-sdk/openai` |
| Anthropic | `anthropic` | `@ai-sdk/anthropic` |
| Azure OpenAI | `azure-openai` | `@ai-sdk/azure` |
| Google Gemini | `gemini` | `@ai-sdk/google` |
| DeepSeek | `deepseek` | `@ai-sdk/deepseek` |
| OpenAI-compatible | `openai-compatible` | `@ai-sdk/openai-compatible` |

Provider adapters are loaded lazily. Optional adapters only need to be installed when you use them.

## ProviderConfig

```ts
interface ProviderConfig {
  type:
    | 'openai'
    | 'anthropic'
    | 'azure-openai'
    | 'gemini'
    | 'deepseek'
    | 'openai-compatible';
  apiKey?: string;
  baseUrl?: string;
  headers?: Record<string, string>;
  organization?: string;
  apiVersion?: string;
  projectId?: string;
}
```

## OpenAI

```ts
const session = await createSession({
  provider: {
    type: 'openai',
    apiKey: process.env.OPENAI_API_KEY!,
    organization: process.env.OPENAI_ORG_ID,
  },
  model: 'gpt-4o-mini',
});
```

## Anthropic

```ts
const session = await createSession({
  provider: {
    type: 'anthropic',
    apiKey: process.env.ANTHROPIC_API_KEY!,
  },
  model: 'claude-sonnet-4-20250514',
});
```

## Azure OpenAI

```ts
const session = await createSession({
  provider: {
    type: 'azure-openai',
    apiKey: process.env.AZURE_OPENAI_API_KEY!,
    baseUrl: process.env.AZURE_OPENAI_ENDPOINT!,
    apiVersion: '2024-10-21',
  },
  model: 'my-deployment-name',
});
```

## Gemini

```ts
const session = await createSession({
  provider: {
    type: 'gemini',
    apiKey: process.env.GOOGLE_GENERATIVE_AI_API_KEY!,
  },
  model: 'gemini-2.0-flash',
});
```

## DeepSeek

```ts
const session = await createSession({
  provider: {
    type: 'deepseek',
    apiKey: process.env.DEEPSEEK_API_KEY!,
  },
  model: 'deepseek-chat',
});
```

The root package also exports DeepSeek-specific helpers for:

- chat and FIM completions;
- cache-prefix optimization;
- token estimation and cost tracking;
- long-context chunk planning;
- batch completion summaries;
- strict JSON Schema normalization.

These helpers are lower-level APIs and do not replace the Session interface.

## OpenAI-compatible endpoints

```ts
const session = await createSession({
  provider: {
    type: 'openai-compatible',
    apiKey: process.env.PROVIDER_API_KEY!,
    baseUrl: 'https://provider.example.com/v1',
    headers: {
      'X-Tenant-ID': 'acme',
    },
  },
  model: 'provider-model-id',
});
```

Use this adapter for services that implement OpenAI Chat Completions semantics. Provider-specific behavior can still differ, especially for tools, reasoning output, and structured output.

## Model options

Common options live directly on `SessionOptions`:

```ts
const session = await createSession({
  provider,
  model: 'gpt-5',
  temperature: 0.2,
  maxOutputTokens: 4096,
  maxContextTokens: 128_000,
  thinkingEnabled: true,
  thinkingBudget: 1024,
  providerOptions: {
    openai: {
      reasoningEffort: 'low',
    },
  },
});
```

`providerOptions` is a `JsonObject` forwarded to the selected provider adapter.

## Runtime model changes

```ts
await session.setModel('gpt-4o-mini');

const models = await session.supportedModels();
for (const model of models) {
  console.log(model.id, model.provider, model.maxContextTokens);
}
```

Changing the model affects later model calls in the same Session.

## Logging

Inject an `AgentLogger` to route SDK logs into your application:

```ts
import type { AgentLogger, LogEntry } from '@blade-ai/agent-sdk';

const logger: AgentLogger = {
  log(entry: LogEntry) {
    appLogger[entry.level](
      {
        category: entry.category,
        sessionId: entry.sessionId,
        args: entry.args,
      },
      entry.message,
    );
  },
};

const session = await createSession({
  provider,
  model,
  logger,
});
```

Use `observability` when you need request traces rather than operational logs:

```ts
const session = await createSession({
  provider,
  model,
  observability: {
    enabled: true,
    capturePayloads: false,
    sink: async (trace) => {
      await traceStore.write(trace);
    },
  },
});

console.log(session.getLastTrace());
```

`capturePayloads` is disabled by default because prompts, tool inputs, and tool results can contain sensitive data.
