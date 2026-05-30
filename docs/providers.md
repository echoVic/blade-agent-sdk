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
