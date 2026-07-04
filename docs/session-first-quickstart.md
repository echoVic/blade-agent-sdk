# Session-first 快速开始

Blade Agent SDK 的默认入口面向 Node server 与 CLI 进程：

```ts
import { createSession } from '@blade-ai/agent-sdk';
```

最小的 session-first 流程是：

1. 用 provider 与 model 创建 session。
2. 用 `session.send()` 放入用户消息。
3. 用 `for await (const event of session.stream())` 消费增量事件。
4. 在 `finally` 中调用 `session.close()` 释放运行时资源。

仓库里有一个可类型检查的完整示例：[../examples/session-first-server.ts](../examples/session-first-server.ts)。

```ts
import { createSession } from '@blade-ai/agent-sdk';

const session = await createSession({
  provider: {
    type: 'openai-compatible',
    apiKey: process.env.GLM_API_KEY,
    baseUrl: process.env.GLM_BASE_URL,
  },
  model: process.env.BLADE_MODEL ?? 'glm-5.2',
  temperature: 0.2,
  maxOutputTokens: 1024,
  allowedTools: [],
});

try {
  await session.send('用三句话总结 Blade Agent SDK 的 session-first 设计。');

  for await (const event of session.stream()) {
    if (event.type === 'content') {
      process.stdout.write(event.delta);
    }
  }
} finally {
  session.close();
}
```

`allowedTools: []` 表示禁用所有工具，适合 quickstart、只读问答、服务端 smoke test 这类不希望模型调用本地能力的场景。未设置 `allowedTools` 时才表示不限制工具；设置为非空数组时只允许数组里的工具。

运行类型检查：

```bash
pnpm run verify:examples
```

这个命令会执行 `tsc -p examples/tsconfig.json --noEmit`，并且已经接入根目录 `pnpm run verify`，保证文档推荐的 session-first 写法跟公开类型保持同步。
