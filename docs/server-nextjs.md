# Server / Next.js

`@blade-ai/agent-sdk` 的默认入口是 server-only，适合 Node server、Next.js Route Handler、Server Action 和 CLI。客户端组件不要直接 import root、`server`、`session` 或 `local` 入口。

## Route Handler

在 Next.js App Router 中，把 session 创建放在 Route Handler 里，并声明 Node runtime：

```ts
import { createSession } from '@blade-ai/agent-sdk';

export const runtime = 'nodejs';

export async function POST(request: Request): Promise<Response> {
  const { prompt } = (await request.json()) as { prompt: string };

  const session = await createSession({
    provider: {
      type: 'openai-compatible',
      apiKey: process.env.GLM_API_KEY,
      baseUrl: process.env.GLM_BASE_URL,
    },
    model: process.env.BLADE_MODEL ?? 'glm-5.2',
    allowedTools: [],
  });

  try {
    await session.send(prompt);

    const stream = new ReadableStream({
      async start(controller) {
        const encoder = new TextEncoder();

        for await (const event of session.stream()) {
          controller.enqueue(encoder.encode(`${JSON.stringify(event)}\n`));
        }

        controller.close();
      },
      cancel() {
        session.close();
      },
    });

    return new Response(stream, {
      headers: {
        'content-type': 'application/x-ndjson; charset=utf-8',
      },
    });
  } catch (error) {
    session.close();
    throw error;
  }
}
```

`allowedTools: []` 在服务端入口中表示禁用所有工具。需要开放工具时，显式列出允许的工具名，并把权限策略、工作目录、MCP server 和环境变量都留在 server 端。

## Server Action

Server Action 也可以使用同一个 session-first API：

```ts
'use server';

import { createSession } from '@blade-ai/agent-sdk';

export async function askBlade(prompt: string): Promise<string> {
  const session = await createSession({
    provider: {
      type: 'openai-compatible',
      apiKey: process.env.GLM_API_KEY,
      baseUrl: process.env.GLM_BASE_URL,
    },
    model: process.env.BLADE_MODEL ?? 'glm-5.2',
    allowedTools: [],
  });

  try {
    await session.send(prompt);

    let text = '';
    for await (const event of session.stream()) {
      if (event.type === 'content') {
        text += event.delta;
      }
    }

    return text;
  } finally {
    session.close();
  }
}
```

## Client Boundary

客户端组件只 import browser-safe 的类型、协议和工具定义：

```ts
import { StreamMessageType } from '@blade-ai/agent-sdk/core';
import type { ToolDefinition } from '@blade-ai/agent-sdk/tools';
```

客户端通过 HTTP 调用你自己的 Route Handler 或 Server Action。不要把 `@blade-ai/agent-sdk` root、`@blade-ai/agent-sdk/server`、`@blade-ai/agent-sdk/session`、`@blade-ai/agent-sdk/local` 放进 `'use client'` 文件，也不要把内置工具、MCP、文件系统、shell、sandbox 或 provider key 暴露给浏览器 bundle。

如果浏览器环境误调用 server-only API，browser stub 会抛出清晰错误；正确的架构仍然是浏览器只处理 UI、输入和远程事件，Agent runtime 留在 server 端。

## 入口选择

| 场景 | 入口 |
| --- | --- |
| Next.js Route Handler | `@blade-ai/agent-sdk` 或 `@blade-ai/agent-sdk/server` |
| Next.js Server Action | `@blade-ai/agent-sdk` 或 `@blade-ai/agent-sdk/server` |
| CLI | `@blade-ai/agent-sdk` |
| 客户端类型共享 | `@blade-ai/agent-sdk/core`、`@blade-ai/agent-sdk/tools` |
| 本地工具、MCP、文件系统、sandbox | `@blade-ai/agent-sdk/local`，仅 server / CLI |
