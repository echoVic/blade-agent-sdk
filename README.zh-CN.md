# Blade Agent SDK

[English](./README.md)

同时面向本地 Node.js 进程与 Node.js 服务端的 Session-first TypeScript Agent SDK。它用一套 API 统一多轮会话、流式工具执行、MCP、子 Agent、Skills、权限、Hooks、沙箱策略、结构化输出和可观测性。

## 环境要求

- Node.js 22.14.0 或更高版本
- ESM 项目或支持 ESM 的构建工具

本包仅提供 ESM，不支持 CommonJS `require()`。

## 安装

```bash
npm install @blade-ai/agent-sdk
# 或
pnpm add @blade-ai/agent-sdk
```

## 快速开始

```ts
import { createSession } from '@blade-ai/agent-sdk/server';

const session = await createSession({
  provider: { type: 'openai', apiKey: process.env.OPENAI_API_KEY! },
  model: 'gpt-4o-mini',
  temperature: 0.2,
  maxOutputTokens: 4096,
});

await session.send('分析下面这份报告并给出三个关键结论');

for await (const event of session.stream()) {
  if (event.type === 'content') {
    process.stdout.write(event.delta);
  }
}

await session.close();
```

一次性请求可以使用 `prompt()`：

```ts
import { prompt } from '@blade-ai/agent-sdk/server';

const result = await prompt('解释这个 API 的能力边界', {
  provider: { type: 'openai', apiKey: process.env.OPENAI_API_KEY! },
  model: 'gpt-4o-mini',
});

console.log(result.result);
console.log(result.toolCalls);
console.log(result.usage);
```

## 核心能力

- Session 生命周期：`createSession()`、`resumeSession()`、`forkSession()`、`prompt()`
- 可转向请求：持久化的 `now`、`next`、`later` 输入，支持取消和待处理输入查询
- Durable 恢复：带 fencing 的执行租约、受控 worker handoff、Request/Turn rollover、显式模型/工具对账与 cursor 断线续读
- 执行平面：`AgentWorker`、`SdkSessionRunner`、`ExecutionHostSessionRunner` 与持久化 `EffectDispatcher`
- 流式事件：17 种类型化事件，覆盖轮次、内容、思维、工具、usage、转向、结果和错误
- Provider：OpenAI、Anthropic、Azure OpenAI、Gemini、DeepSeek 和 OpenAI-compatible API
- 工具：仅 generator 的自定义工具、按能力分组的内置工具、MCP 工具和类型化进度/副作用
- 扩展：洋葱式模型/工具 middleware，以及可打包 middleware、hooks 与工具的声明式插件
- 协作：前台/后台子 Agent、任务工具，以及项目级 Skills
- 安全：有界模型、工具与 inline hook 执行、权限模式、策略回调、路径检查和可选 OS 沙箱集成
- 运行时：可选 workspace、结构化输出、崩溃安全的本地会话记录、上下文压缩、token 预算和 trace

## 转向活动请求

`send()` 返回 `InputSubmission`。请求运行期间，可以选择新输入的应用时机：

```ts
const current = await session.send('分析这个仓库');

for await (const event of session.stream()) {
  if (event.type === 'tool_use' && event.name === 'Bash') {
    await session.send('停止修改，只报告发现', {
      priority: 'now',
      expectedRequestId: current.requestId,
    });
  }
}
```

- `now`：中断当前可取消步骤并立即转向
- `next`：在下一个模型或工具安全点应用
- `later`：排队到下一个请求

使用 `getPendingInputs()` 和 `cancelInput()` 管理已接受的输入。

## 自定义工具

工具执行只使用 `AsyncGenerator<ToolYield, ToolResult>`：

```ts
import { defineTool, ToolKind, ToolSideEffect } from '@blade-ai/agent-sdk';

const weather = defineTool({
  name: 'GetWeather',
  description: '查询城市天气',
  kind: ToolKind.ReadOnly,
  sideEffect: ToolSideEffect.PURE,
  parameters: {
    type: 'object',
    properties: {
      city: { type: 'string' },
    },
    required: ['city'],
  },
  async *execute({ city }) {
    yield { kind: 'progress', message: `正在查询 ${city} 的天气` };
    return {
      status: 'success',
      model: `${city}：晴，25 C`,
      display: { summary: `${city} 天气` },
    };
  },
});
```

## 包入口

```ts
import { createSession as createServerSession } from '@blade-ai/agent-sdk/server';
import { createSession as createNodeSession } from '@blade-ai/agent-sdk/node';
import { AgentClient } from '@blade-ai/agent-sdk/browser';
import { AGENT_PROTOCOL_VERSION } from '@blade-ai/agent-sdk/protocol';
import { PostgresRuntimeStore } from '@blade-ai/agent-sdk/server/postgres';
import { OpenTelemetryAgentServerTelemetry } from '@blade-ai/agent-sdk/server/otel';
import { InputPriority, ToolKind } from '@blade-ai/agent-sdk/core';
import { defineTool } from '@blade-ai/agent-sdk/tools';
import { composeMiddleware } from '@blade-ai/agent-sdk/middleware';
import type { ModelMessage, ModelService } from '@blade-ai/agent-sdk/model';
```

- 根入口与 `/server`：服务端 Agent；提供可注入 `SessionExecutor` 的 `AgentServer`，只加载显式传入的能力
- `/server/postgres`：共享 PostgreSQL Runtime Store，统一承载 command、event、effect、projection、worker lease、路由、transcript 和 durable journal
- `/server/otel`：OpenTelemetry metric、trace 与审计 adapter
- `/server/testing`：不依赖测试框架的 Runtime Store conformance suite
- `/node`：具备本机访问能力的 Node.js 运行时；默认加载文件、搜索、Shell、任务工具和本地 Agent/Skill 发现，并导出 Node 宿主适配器
- `/browser`：browser-safe `AgentClient`、协议视图和明确的 server-only stub
- `/protocol`：browser-safe 版本化 command/event 契约与 strict parser
- `/core`：浏览器安全的协议、常量和类型
- `/tools`：浏览器安全的工具定义原语
- `/middleware`：浏览器安全的 middleware 与插件契约
- `/model`：浏览器安全、Provider 无关的模型契约、消息、配置和用量类型
- `/session`：底层服务端 Session API

浏览器误导入仅服务端入口时，会解析到带清晰错误信息的 stub。

PostgreSQL、OpenTelemetry、非默认 Provider 和本机原生增强是按需 peer：

```bash
pnpm add pg                         # /server/postgres
pnpm add @opentelemetry/api         # /server/otel
pnpm add @ai-sdk/anthropic          # provider: anthropic
pnpm add fs-native-extensions        # Node JSONL 跨进程锁
```

## 持久化与 Workspace

未同时配置只读 `SessionRepository` 与只写 `SessionEventStore` 时，Session
只保存在内存中。`/node` 入口会把 `storagePath` 转换为同时实现两者的本地
JSONL `SessionPersistence`：

```ts
import { createSession } from '@blade-ai/agent-sdk/node';

const session = await createSession({
  provider,
  model,
  storagePath: '/var/lib/my-agent',
  defaultContext: {
    capabilities: {
      filesystem: {
        roots: [process.cwd()],
        cwd: process.cwd(),
      },
    },
  },
});
```

根入口和 `/server` 不会把 `storagePath` 解释成本机访问权限；服务端应用必须显式
注入 `sessionRepository` 和 `sessionEventStore`，或配置共享 `runtimeStore`。
HTTP/SSE 服务端、浏览器客户端、多租户存储、幂等、
审批和遥测见 [Server Runtime](./docs/server-runtime.md)。
多实例持久化见 [Runtime Store](./docs/runtime-store.md)。
worker 协调与崩溃恢复见 [Worker Runtime](./docs/worker-runtime.md)。
容器隔离、资源限制、checkpoint 与短期凭据见
[Execution Host](./docs/execution-host.md)。
公开类型的所有权与边界规则见[类型架构](./docs/type-architecture.md)。

workspace 是可选的。没有 workspace 时，Session 和显式配置的 Agent 仍可工作，但本地文件工具和项目级发现需要具备文件系统能力的 workspace。

## 文档

- [中文文档](./docs/index.md)
- [Middleware 与插件](./docs/middleware.md)
- [Server Runtime](./docs/server-runtime.md)
- [Runtime Store](./docs/runtime-store.md)
- [Worker Runtime](./docs/worker-runtime.md)
- [Execution Host](./docs/execution-host.md)
- [Durable Event Store](./docs/durable-events.md)
- [English documentation](./docs/en/index.md)
- [可运行 Golden Paths](./examples/README.md)
- [Runtime 基准](./docs/runtime-benchmarks.md)
- [中文更新日志](./CHANGELOG.zh-CN.md)
- [English changelog](./CHANGELOG.md)

## 仓库开发

```bash
pnpm install
pnpm run lint
pnpm run type-check
pnpm run test
pnpm run build
pnpm run docs:build
```

## 发布流程

仓库仅使用 `semantic-release` 发布。每个会触发版本发布的 PR 必须在 `.changes/` 下增加一个双语 JSON fragment。代码进入 `main` 后，发布工作流会：

```json
{
  "type": "feature",
  "en": "Add a user-facing capability.",
  "zh-CN": "新增一项用户可见能力。"
}
```

文件名必须唯一且使用 kebab-case。`type` 只允许 `breaking`、`feature`、
`fix`、`performance`、`refactor` 和 `docs`。

1. 校验、构建并测试 package 和文档；
2. 根据 conventional commits 计算下一版本；
3. 更新 `package.json`、`CHANGELOG.md` 和 `CHANGELOG.zh-CN.md`；
4. 提交生成的发布元数据；
5. 发布 npm package 和 GitHub Release。

使用 `pnpm run changelog:check` 校验 fragment，使用 `pnpm run release:dry` 预演发布。

更多贡献约定见 [CONTRIBUTING.md](./CONTRIBUTING.md)。

## 许可证

[MIT](./LICENSE)
