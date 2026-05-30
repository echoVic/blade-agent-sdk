# Provider 配置

## 支持的 Provider

| Provider | `type` 值 | 说明 |
|----------|-----------|------|
| OpenAI | `'openai'` | 官方 OpenAI API |
| Anthropic | `'anthropic'` | Claude 系列模型 |
| Azure OpenAI | `'azure-openai'` | Azure 托管的 OpenAI |
| Gemini | `'gemini'` | Google Gemini 系列 |
| DeepSeek | `'deepseek'` | DeepSeek 模型 |
| OpenAI 兼容 | `'openai-compatible'` | 任何兼容 OpenAI API 的服务 |

## ProviderConfig

```ts
interface ProviderConfig {
  type: ProviderType;
  apiKey?: string;
  baseUrl?: string;
  headers?: Record<string, string>;
  organization?: string;
  apiVersion?: string;
  projectId?: string;
}
```

## 配置示例

### OpenAI

```ts
{ type: 'openai', apiKey: 'sk-xxx' }
```

### Anthropic

```ts
{ type: 'anthropic', apiKey: 'sk-ant-xxx' }
```

### Azure OpenAI

```ts
{
  type: 'azure-openai',
  apiKey: 'xxx',
  baseUrl: 'https://my-resource.openai.azure.com',
  apiVersion: '2024-02-15-preview',
}
```

### Gemini

```ts
{ type: 'gemini', apiKey: 'xxx' }
```

### DeepSeek

```ts
{
  type: 'deepseek',
  apiKey: process.env.DEEPSEEK_API_KEY!,
  // 可省略，默认使用 https://api.deepseek.com
  baseUrl: 'https://api.deepseek.com',
}
```

DeepSeek 使用原生 provider 分支，默认模型建议使用 `deepseek-v4-pro`。旧别名 `deepseek-chat`、`deepseek-reasoner` 会继续兼容，但 SDK 会优先按当前 V4 模型路由。

```ts
const session = await createSession({
  provider: { type: 'deepseek', apiKey: process.env.DEEPSEEK_API_KEY! },
  model: 'deepseek-v4-pro',
});
```

Thinking mode 可通过模型配置的 `providerOptions` 透传：

```ts
{
  id: 'deepseek-pro',
  name: 'DeepSeek V4 Pro',
  provider: 'deepseek',
  model: 'deepseek-v4-pro',
  providerOptions: {
    deepseek: {
      thinking: { type: 'enabled' },
    },
  },
}
```

DeepSeek Context Caching 默认由官方服务端启用，SDK 不需要额外开关。响应 usage 会保留缓存命中与未命中口径：`cacheReadInputTokens` 对应 `prompt_cache_hit_tokens`，`cacheMissInputTokens` / `billableInputTokens` 对应 `prompt_cache_miss_tokens`。如果启用 Agent token budget，可复用内置价格表生成成本配置：

```ts
import { createDeepSeekTokenBudgetCostConfig } from '@blade-ai/agent-sdk';

const session = await createSession({
  provider: { type: 'deepseek', apiKey: process.env.DEEPSEEK_API_KEY! },
  model: 'deepseek-v4-pro',
  tokenBudget: {
    maxTotalTokens: 1_000_000,
    ...createDeepSeekTokenBudgetCostConfig('deepseek-v4-pro'),
  },
});
```

内置价格表按 DeepSeek 官方价格页的 cache hit、cache miss、output 三档折算为 per-token USD。价格变动时，应在业务侧传入自定义 `DeepSeekPricing` 或直接覆盖 `tokenBudget` 的成本字段。

也可以直接对单次 usage 计算成本明细：

```ts
import { calculateDeepSeekCost } from '@blade-ai/agent-sdk';

const cost = calculateDeepSeekCost(response.usage, 'deepseek-v4-pro');
console.log(cost?.totalCost);
```

### DeepSeek 缓存命中优化

DeepSeek 服务端会自动缓存 prompt 前缀。SDK 会在 DeepSeek provider 下对带稳定缓存标记的首轮上下文做安全重排：保留开头 system 消息不动，把首个 assistant/tool 消息之前标记为稳定的 user 上下文提前，使多次请求共享更长的相同前缀。

```ts
import {
  createDeepSeekChatCompletion,
  optimizeDeepSeekCachePrefix,
} from '@blade-ai/agent-sdk';

const messages = optimizeDeepSeekCachePrefix([
  { role: 'system', content: 'You are a repository assistant.' },
  { role: 'user', content: '本轮问题：解释构建流程' },
  {
    role: 'user',
    content: '大型、稳定、跨请求复用的仓库摘要...',
    metadata: { deepseekCache: 'stable' },
  },
]);

const response = await createDeepSeekChatCompletion({
  apiKey: process.env.DEEPSEEK_API_KEY!,
  model: 'deepseek-v4-pro',
  messages,
});
```

如需使用自定义 metadata key：

```ts
const session = await createSession({
  provider: { type: 'deepseek', apiKey: process.env.DEEPSEEK_API_KEY! },
  model: 'deepseek-v4-pro',
  providerOptions: {
    deepseek: {
      cacheOptimization: {
        stableMetadataKey: 'cacheScope',
        stableMetadataValue: 'project',
      },
    },
  },
});
```

这项优化不会重排已经进入多轮对话的 assistant/tool 历史，避免破坏 tool call 因果关系。

### DeepSeek 长上下文分片

对于 64K/128K 级稳定上下文，推荐先分片为稳定前缀消息，再追加本轮问题。默认估算为 4 chars/token，可根据业务 tokenizer 调整。

```ts
import {
  createDeepSeekChatCompletion,
  createDeepSeekLongContextMessages,
  optimizeDeepSeekCachePrefix,
} from '@blade-ai/agent-sdk';

const contextMessages = createDeepSeekLongContextMessages(largeDocument, {
  chunkTokenLimit: 64_000,
  chunkPrefix: 'repo',
});

const messages = optimizeDeepSeekCachePrefix([
  { role: 'system', content: 'Answer from the provided repository context.' },
  ...contextMessages,
  { role: 'user', content: '定位鉴权相关代码并给出风险点' },
]);

await createDeepSeekChatCompletion({
  apiKey: process.env.DEEPSEEK_API_KEY!,
  model: 'deepseek-v4-pro',
  messages,
});
```

对于 128K 场景，可以把 `chunkTokenLimit` 设置为 `128_000`，并预留输出空间：

```ts
const chunks = createDeepSeekLongContextMessages(largeDocument, {
  chunkTokenLimit: 128_000,
  reserveOutputTokens: 8_000,
});
```

### DeepSeek 批量请求

DeepSeek 当前公开文档没有 OpenAI-style `/batches` API；SDK 提供 `createDeepSeekBatchChatCompletions`，在 `/chat/completions` 上做 bounded concurrency 批量请求，并保留每个请求的 usage 与成本明细。

```ts
import { createDeepSeekBatchChatCompletions } from '@blade-ai/agent-sdk';

const results = await createDeepSeekBatchChatCompletions({
  apiKey: process.env.DEEPSEEK_API_KEY!,
  concurrency: 4,
  requests: [
    {
      id: 'case-1',
      model: 'deepseek-v4-pro',
      messages: [{ role: 'user', content: 'Summarize file A' }],
    },
    {
      id: 'case-2',
      model: 'deepseek-v4-pro',
      messages: [{ role: 'user', content: 'Summarize file B' }],
    },
  ],
});

for (const item of results) {
  if (item.error) {
    console.error(item.id, item.error.message);
  } else {
    console.log(item.id, item.response?.cost?.totalCost);
  }
}
```

### OpenAI 兼容

适用于 Ollama、vLLM、LiteLLM 等兼容 OpenAI API 的服务：

```ts
{
  type: 'openai-compatible',
  baseUrl: 'http://localhost:11434/v1',
  apiKey: 'ollama',
}
```

## 运行时切换模型

```ts
const session = await createSession({
  provider: { type: 'openai', apiKey: process.env.OPENAI_API_KEY! },
  model: 'gpt-4o-mini',
});

// 简单任务用小模型
await session.send('列出 src 目录下的文件');
for await (const event of session.stream()) { /* ... */ }

// 复杂任务切换到大模型
await session.setModel('gpt-4o');
await session.send('重构这些文件的架构');
for await (const event of session.stream()) { /* ... */ }
```

## 查看支持的模型

```ts
const models = await session.supportedModels();
for (const m of models) {
  console.log(`${m.id}: ${m.name}`);
}
```

## 日志

SDK 不内置日志实现，通过 `AgentLogger` 接口接受外部注入：

```ts
import type { AgentLogger, LogEntry } from '@blade-ai/agent-sdk';

const logger: AgentLogger = {
  log(entry: LogEntry) {
    const prefix = `[${entry.timestamp}][${entry.level.toUpperCase()}][${entry.category}]`;
    console.log(`${prefix} ${entry.message}`);
  },
};

const session = await createSession({
  provider: { type: 'openai', apiKey: process.env.OPENAI_API_KEY! },
  model: 'gpt-4o',
  logger,
});
```

### LogEntry

```ts
interface LogEntry {
  level: 'debug' | 'info' | 'warn' | 'error';
  category: string;
  message: string;
  timestamp: string;
  sessionId?: string;
  args?: unknown[];
}
```
