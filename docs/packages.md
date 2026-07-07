# 包与入口

Blade Agent SDK 拆成三个 npm 包。日常应用仍然从 `@blade-ai/agent-sdk` 开始，只有构建底层 runtime、provider adapter 或测试 kernel 时才直接使用 `@blade-ai/ai` / `@blade-ai/agent`。

## 推荐入口

| 入口 | 环境 | 用途 |
| --- | --- | --- |
| `@blade-ai/agent-sdk` | Server / CLI | session-first 默认入口，包含 `createSession()`、`resumeSession()`、`forkSession()`、`prompt()` |
| `@blade-ai/agent-sdk/server` | Server / CLI | 显式 server runtime 入口 |
| `@blade-ai/agent-sdk/session` | Server / CLI | Session API 子入口 |
| `@blade-ai/agent-sdk/core` | Browser-safe / Server / CLI | 类型、协议、事件、常量 |
| `@blade-ai/agent-sdk/browser` | Browser-safe | 浏览器安全常量和 server-only stub |
| `@blade-ai/agent-sdk/tools` | Browser-safe / Server / CLI | 工具定义、工具类型、工具目录等不依赖本地执行器的 API |
| `@blade-ai/agent-sdk/local` | Server / CLI | 内置工具、MCP、memory、sandbox、文件系统等 Node-only 能力 |

最常见用法：

```ts
import { createSession } from '@blade-ai/agent-sdk';

const session = await createSession({
  provider: { type: 'openai', apiKey: process.env.OPENAI_API_KEY! },
  model: 'gpt-4o-mini',
});
```

需要显式表达运行时边界时：

```ts
import { createSession } from '@blade-ai/agent-sdk/server';
import { ToolKind } from '@blade-ai/agent-sdk/core';
import { defineTool } from '@blade-ai/agent-sdk/tools';
import { getBuiltinTools } from '@blade-ai/agent-sdk/local';
```

## `@blade-ai/ai`

`@blade-ai/ai` 负责模型和 provider 层。它适合用于自定义 provider adapter、模型测试、usage 归一化、provider-specific helper 或直接调用底层模型协议。

```ts
import { createOpenAICompatibleModelPort } from '@blade-ai/ai';

const model = createOpenAICompatibleModelPort({
  apiKey: process.env.GLM_API_KEY!,
  baseUrl: process.env.GLM_BASE_URL!,
  model: 'glm-5.2',
});
```

完整示例见 [`examples/ai-model-port.ts`](../examples/ai-model-port.ts)。

可以直接使用的典型入口：

| 入口 | 用途 |
| --- | --- |
| `@blade-ai/ai` | 通用模型协议类型 |
| `@blade-ai/ai/model` | `ModelPort`、`ModelRequest`、`ModelResponse`、stream event |
| `@blade-ai/ai/chat` | legacy chat protocol 类型 |
| `@blade-ai/ai/providers/openai-compatible` | OpenAI-compatible provider adapter |
| `@blade-ai/ai/providers/vercel` | Vercel AI provider adapter |
| `@blade-ai/ai/deepseek` | DeepSeek helper、成本/缓存/长上下文工具和 runtime |
| `@blade-ai/ai/retry` | Retry policy |

## `@blade-ai/agent`

`@blade-ai/agent` 是 runtime-independent kernel。它面向 SDK 内部、adapter 作者和测试场景，不包含 Node-only 能力，也不直接依赖 provider SDK。

```ts
import { AgentKernel } from '@blade-ai/agent';
import { TokenBudget } from '@blade-ai/agent/budget';
import { ExecutionEpoch } from '@blade-ai/agent/epoch';
import { AsyncEventQueue, decideNoToolTurn } from '@blade-ai/agent/loop';
import { isOverflowRecoverable } from '@blade-ai/agent/recovery';
import { isValidSystemSource } from '@blade-ai/agent/state';
```

Kernel 通过 ports 访问外部能力：

- model port 来自 `@blade-ai/ai`
- tool port 由调用方注入
- permission port 由调用方注入
- store port 由调用方注入
- hook port 由调用方注入
- trace port 由调用方注入
- token budget 可通过 `@blade-ai/agent/budget` 注入，并通过 `budget_warning` / `budget_exhausted` 事件观察
- streaming loop 事务边界可通过 `@blade-ai/agent/epoch` 的 `ExecutionEpoch` 标识，adapter 可用它丢弃 retry/fallback 后迟到的事件或副作用
- streaming loop 的 producer/consumer 事件桥和 no-tool turn 决策可通过 `@blade-ai/agent/loop` 的 `AsyncEventQueue` / `decideNoToolTurn()` 复用
- reactive compaction 入口可通过 `@blade-ai/agent/recovery` 的 `isOverflowRecoverable()` 判断模型错误是否属于可恢复的上下文溢出
- 受控 system 消息来源可通过 `@blade-ai/agent/state` 的 `isValidSystemSource()` 归一化

完整示例见 [`examples/agent-kernel.ts`](../examples/agent-kernel.ts)，它用一个内存 `ModelPort` 演示 `kernel.runTurn()` 的事件流。

## `@blade-ai/agent-sdk`

`@blade-ai/agent-sdk` 是产品层 SDK，组合模型、kernel、工具、MCP、hooks、memory、observability、持久化和本地能力。应用开发者优先使用 root 的 session-first API；Node 本地 adapter 从 `@blade-ai/agent-sdk/local` 显式导入，provider-specific helper 从 `@blade-ai/ai/*` 显式导入。

Server / CLI 场景可以使用 root：

```ts
import { createSession } from '@blade-ai/agent-sdk';
```

也可以使用 `@blade-ai/agent-sdk/server` 表达更明确的 server-only 边界。这个入口是显式 facade，直接从 `session`、`core`、`tools` 和 `subagents` 组合公开 API，不通过 root wildcard 转发；它会保持与 root 的公开 server-safe runtime/type surface 对齐，packed package 和 post-publish verifier 都会拒绝它退回 root facade 或漏掉 root 已公开的 server-safe 类型和值。

浏览器代码不要直接调用 root、`server`、`session` 或 `local` 的运行时 API。需要共享类型时，从 `core` 或 `tools` 导入：

```ts
import { StreamMessageType, ToolKind } from '@blade-ai/agent-sdk/core';
import type { ToolDefinition } from '@blade-ai/agent-sdk/tools';
```

如果浏览器误调用 server-only API，browser stub 会抛出清晰错误，而不是把 Node-only 依赖拖进客户端 bundle。

## 选择规则

- 构建普通 Agent 应用：用 `@blade-ai/agent-sdk`
- 构建 server 或 CLI：可以用 root，也可以用 `@blade-ai/agent-sdk/server`
- 写 browser-safe 类型共享代码：用 `@blade-ai/agent-sdk/core` 和 `@blade-ai/agent-sdk/tools`
- 使用本地工具、MCP、文件系统、sandbox：用 `@blade-ai/agent-sdk/local`
- 写 provider adapter 或模型测试：用 `@blade-ai/ai`
- 写 runtime-independent kernel adapter：用 `@blade-ai/agent`
