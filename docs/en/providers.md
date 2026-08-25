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
type BuiltinProviderType =
  | 'openai'
  | 'anthropic'
  | 'azure-openai'
  | 'gemini'
  | 'deepseek'
  | 'openai-compatible';

interface ProviderConfig {
  id?: string;
  type: BuiltinProviderType | (string & {});
  apiKey?: string;
  baseUrl?: string;
  headers?: Record<string, string>;
  organization?: string;
  apiVersion?: string;
  projectId?: string;
  requestTimeoutMs?: number;
  streamIdleTimeoutMs?: number;
}
```

`type` selects the wire-protocol adapter. `id` identifies the logical provider
and defaults to `type`. Set `id` for OpenAI-compatible gateways when provider
identity must survive model switches or persisted-session resume. `id` never
changes adapter selection:

```ts
provider: {
  id: 'openrouter',
  type: 'openai-compatible',
  apiKey: process.env.OPENROUTER_API_KEY!,
  baseUrl: 'https://openrouter.ai/api/v1',
}
```

`requestTimeoutMs` bounds one non-streaming model operation, including retry
delays, and defaults to 10 minutes. `streamIdleTimeoutMs` bounds the wait for
each next streaming chunk and defaults to 5 minutes. Both values
must be positive integers in milliseconds. A timeout aborts the underlying
provider request and throws `ModelTimeoutError` with code
`MODEL_REQUEST_TIMEOUT` or `MODEL_STREAM_IDLE_TIMEOUT`; it is not reported as a
user cancellation.

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
    id: 'provider-name',
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

Assistant history records the logical provider ID, API adapter, and model that
produced each response. Native reasoning blocks are replayed only to that same
provider, adapter, and model. When any identity component changes, or when
legacy history has no identity, reasoning is converted to ordinary assistant
text while tool-call relationships are preserved. This prevents
provider-specific reasoning payloads from being sent to an incompatible API.

## Custom provider adapters

`ProviderRegistry` is an instance-scoped registry. It has no process-global
registration state, so separate Sessions can safely use different adapters for
the same `type`.

```ts
import {
  createSession,
  ProviderRegistry,
  type ChatConfig,
  type IChatService,
  type ProviderAdapter,
} from '@blade-ai/agent-sdk';

const adapter = {
  type: 'acme-chat',
  async create(config: Readonly<ChatConfig>): Promise<IChatService> {
    return new AcmeChatService(config);
  },
} satisfies ProviderAdapter;

const session = await createSession({
  provider: {
    id: 'acme-production',
    type: 'acme-chat',
    apiKey: process.env.ACME_API_KEY!,
  },
  providerRegistry: new ProviderRegistry([adapter]),
  model: 'acme-reasoner',
});
```

An adapter returns the existing `IChatService` contract, so model middleware,
request and stream-idle deadlines, durable model-attempt tracking, subagents,
and compaction continue to use the same runtime path. A custom adapter may also
override a built-in `type` for one Registry instance. Duplicate or malformed
registrations and unknown unregistered adapter types fail with
`ProviderRegistryError`.

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
