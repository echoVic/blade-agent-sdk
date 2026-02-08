# Blade Agent SDK

面向 Node.js 与 TypeScript 的多轮会话 Agent SDK，提供标准的 send/stream 会话模式、工具调用、会话恢复与自动清理。

## 安装

```bash
npm install @blade-ai/agent-sdk
```

## 快速上手

```typescript
import { createSession } from '@blade-ai/agent-sdk';

const session = await createSession({
  provider: { type: 'openai-compatible', apiKey: process.env.BLADE_API_KEY },
  model: 'gpt-4o-mini',
});

await session.send('你好');
for await (const msg of session.stream()) {
  if (msg.type === 'content') {
    process.stdout.write(msg.delta);
  }
}
```

## 会话 API

### send / stream

```typescript
await session.send('请总结下面的文本...');
for await (const msg of session.stream({ includeThinking: false })) {
  if (msg.type === 'content') {
    process.stdout.write(msg.delta);
  }
}
```

### 一次性 prompt

```typescript
import { prompt } from '@blade-ai/agent-sdk';

const result = await prompt('2+2 等于多少？', {
  provider: { type: 'openai-compatible', apiKey: process.env.BLADE_API_KEY },
  model: 'gpt-4o-mini',
});

console.log(result.result);
```

### 恢复会话

```typescript
import { resumeSession } from '@blade-ai/agent-sdk';

const session = await resumeSession({
  sessionId: 'your-session-id',
  provider: { type: 'openai-compatible', apiKey: process.env.BLADE_API_KEY },
  model: 'gpt-4o-mini',
});

await session.send('继续上次的话题');
for await (const msg of session.stream()) {
  if (msg.type === 'content') process.stdout.write(msg.delta);
}
```

### 自动清理

TypeScript 5.2+ 支持 `using` 自动清理：

```typescript
import { createSession } from '@blade-ai/agent-sdk';

await using session = await createSession({
  provider: { type: 'openai-compatible', apiKey: process.env.BLADE_API_KEY },
  model: 'gpt-4o-mini',
});

await session.send('你好');
for await (const msg of session.stream()) {
  if (msg.type === 'content') process.stdout.write(msg.delta);
}
```

旧版本 TypeScript 可手动调用：

```typescript
const session = await createSession({ provider, model });
session.close();
```

## 主要类型

```typescript
import type { ISession, StreamMessage, PromptResult } from '@blade-ai/agent-sdk';
```

## 运行环境

- Node.js >= 20
- TypeScript >= 5.2（可选，用于 `using` 自动清理）

## 许可证

MIT
