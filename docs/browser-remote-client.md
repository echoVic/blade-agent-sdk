# Browser Remote Client

浏览器端不运行 Agent runtime。它只负责 UI、用户输入、远程事件消费和 browser-safe 类型共享；`createSession()`、本地工具、MCP、文件系统、shell、sandbox、provider key 都留在 server / CLI。

## Browser-safe 入口

客户端组件可以从 `core` 导入协议类型和常量：

```ts
import { StreamMessageType } from '@blade-ai/agent-sdk/core';
import type { StreamMessage } from '@blade-ai/agent-sdk/core';
```

如果你希望显式表达“这个文件运行在浏览器侧”，也可以从 `@blade-ai/agent-sdk/browser` 导入同一组 browser-safe 协议，并获得 server-only stub：

```ts
import { StreamMessageType } from '@blade-ai/agent-sdk/browser';
```

`@blade-ai/agent-sdk/browser` 会导出 browser-safe 类型、常量，以及会在调用时抛出清晰错误的 server-only stub。它的用途是让误用在浏览器中快速暴露，而不是在浏览器中执行本地 Agent。

不要在 'use client' 文件中 import `@blade-ai/agent-sdk` root、`@blade-ai/agent-sdk/server`、`@blade-ai/agent-sdk/session` 或 `@blade-ai/agent-sdk/local`。

## 远程会话协议

推荐的浏览器集成方式是：

1. 浏览器通过 HTTP 调用你自己的 server route。
2. server route 内部使用 `createSession()`。
3. server 把 `session.stream()` 的事件转成 NDJSON、SSE 或 WebSocket message。
4. 浏览器按 `StreamMessage` 协议消费事件。

与 [Server / Next.js](./server-nextjs.md) guide 对应的 NDJSON 客户端可以这样写：

```ts
import { StreamMessageType } from '@blade-ai/agent-sdk/core';
import type { StreamMessage } from '@blade-ai/agent-sdk/core';

export async function streamRemoteSession(
  prompt: string,
  onEvent: (event: StreamMessage) => void,
): Promise<void> {
  const response = await fetch('/api/blade/session', {
    method: 'POST',
    headers: {
      'content-type': 'application/json',
      accept: 'application/x-ndjson',
    },
    body: JSON.stringify({ prompt }),
  });

  if (!response.ok || !response.body) {
    throw new Error(`Blade session request failed: ${response.status}`);
  }

  const reader = response.body.pipeThrough(new TextDecoderStream()).getReader();
  let buffer = '';

  while (true) {
    const { value, done } = await reader.read();

    if (done) {
      break;
    }

    buffer += value;
    const lines = buffer.split('\n');
    buffer = lines.pop() ?? '';

    for (const line of lines) {
      if (!line.trim()) {
        continue;
      }

      const event = JSON.parse(line) as StreamMessage;
      onEvent(event);

      if (event.type === StreamMessageType.RESULT && event.subtype === 'error') {
        throw new Error(event.error ?? 'Blade session failed');
      }
    }
  }
}
```

## UI 状态映射

客户端通常只需要处理这些事件：

| Event | UI 用途 |
| --- | --- |
| `content` | 追加 assistant 文本 |
| `thinking` | 展示模型思考流，或按产品策略隐藏 |
| `tool_use` | 展示正在执行的远程工具 |
| `tool_result` | 展示工具结果或错误 |
| `usage` | 更新 token / cost 面板 |
| `result` | 标记本轮完成或失败 |
| `error` | 展示 transport 之外的 Agent 错误 |

工具执行、权限判断、MCP 连接、文件系统访问、sandbox 执行都不应该下放到浏览器。浏览器只接收 server 过滤后的事件。

## 工具类型共享

`@blade-ai/agent-sdk/tools` 可以用于共享工具定义类型、目录元数据或构建 server/browser 共用的静态说明：

```ts
import type { ToolCatalogEntry, ToolDefinition, ToolSourceInfo } from '@blade-ai/agent-sdk/tools';

export interface RemoteToolSummary {
  name: string;
  description: string;
  source: ToolSourceInfo;
}

export function toRemoteToolSummary(tool: ToolDefinition): RemoteToolSummary {
  return {
    name: tool.name,
    description: tool.description,
    source: {
      kind: 'custom',
      trustLevel: 'workspace',
      sourceId: 'app',
    },
  };
}

export function fromCatalogEntry(entry: ToolCatalogEntry): RemoteToolSummary {
  return {
    name: entry.tool.name,
    description: entry.tool.description,
    source: entry.source,
  };
}
```

真正的 `execute()` 函数、内置工具和 `@blade-ai/agent-sdk/local` 仍然只应该在 server / CLI 中使用。

## 生产边界

- Provider key 只放在 server 环境变量。
- Browser client 只传用户输入、session id、abort signal 或 UI metadata。
- Server 负责鉴权、限流、权限策略和工具白名单。
- Remote stream 使用 HTTP、SSE 或 WebSocket 均可，但事件 payload 应保持 `StreamMessage` 兼容。
- 浏览器 bundle 中不应该出现 MCP SDK、`child_process`、文件系统、shell、sandbox 或 provider SDK。
