# Blade Agent SDK

[English](./README.md)

同时面向本地 Node.js 进程与 Node.js 服务端的 Session-first TypeScript Agent SDK。它用一套 API 统一多轮会话、流式工具执行、MCP、子 Agent、Skills、权限、Hooks、沙箱策略、结构化输出和可观测性。

## 环境要求

- Node.js 22.14.0 或更高版本
- ESM 项目或支持 ESM 的构建工具

本包仅提供 ESM，不支持 CommonJS `require()`。

## 5 分钟快速开始

```bash
npm install @blade-ai/agent-sdk
```

创建 `agent.mjs`：

```js
import { createAgent } from '@blade-ai/agent-sdk';

const apiKey = process.env.OPENAI_API_KEY;
if (!apiKey) throw new Error('缺少 OPENAI_API_KEY');

const agent = await createAgent({
  model: 'gpt-4o-mini',
  apiKey,
  filesystem: {
    roots: [process.cwd()],
    cwd: process.cwd(),
  },
});

await agent.send('读取 package.json，用三个要点总结这个项目');

for await (const event of agent.stream()) {
  if (event.type === 'content') {
    process.stdout.write(event.delta);
  }
}

await agent.close();
```

运行：

```bash
OPENAI_API_KEY=your-key node agent.mjs
```

`createAgent()` 默认使用 OpenAI。其他 Provider 可通过 `provider` 和 `baseUrl`
配置。传入 `filesystem` 时会自动选择 local profile；未传入时使用 server
profile。也可以通过 `profile: 'local' | 'server'` 显式选择。

常用选项保留在顶层，基础设施和策略配置统一放入 `advanced`：

```ts
const agent = await createAgent({
  model: 'gpt-4o-mini',
  apiKey,
  temperature: 0.2,
  systemPrompt: '回答务必简洁。',
  advanced: {
    permission: 'accept-edits',
    tokenBudget: { maxTotalTokens: 100_000 },
  },
});
```

## 项目脚手架

生成不依赖 PostgreSQL 或 Docker 的本地 Agent：

```bash
npm exec --yes --package=@blade-ai/agent-sdk@latest -- \
  create-blade-agent my-agent --preset local --verify
```

生成 Browser + AgentServer 应用：

```bash
npm exec --yes --package=@blade-ai/agent-sdk@latest -- \
  create-blade-agent my-agent --preset web --verify
```

生成完整的 PostgreSQL、Worker、Docker、审批和恢复拓扑：

```bash
npm exec --yes --package=@blade-ai/agent-sdk@latest -- \
  create-blade-agent my-agent --preset production --verify
```

最长的安装后 smoke 预算为五分钟。省略 `--verify` 可跳过 smoke，
`--skip-install` 只生成文件。

## 底层 Session API

框架和运行时集成可以直接使用 `createSession()`：

```ts
import { createSession as createNodeSession } from '@blade-ai/agent-sdk/node';
import { createSession as createServerSession } from '@blade-ai/agent-sdk/server';
```

两个入口共用同一套 Session API、内置工具与协议，区别在于进程的运行位置和可触达范围：

| | `/node` | `/server` |
|---|---------|-----------|
| 本地文件与 Shell 工具 | 配置 `filesystem` capability 后可用 | 工具相同，但 server profile 不做环境、Skill 与子 Agent 发现 |
| `storagePath` | 由本地 JSONL 持久化支撑 | 直接抛 `ConfigError`：服务端 Session 需要 `sessionRepository` 与 `sessionEventStore` |
| 默认持久化 | 设置 `storagePath` 时写本地 JSONL | 未注入 repository 时仅内存 |
| 上下文与 Skill 发现 | 开启 | 关闭（`localDiscovery` 为 false） |

本地 Agent 或 CLI 从 `/node` 开始；只有在构建共享的多租户服务、并显式注入存储时才用
`/server`。

## 核心能力

- Agent facade：使用必需、常用和 `advanced` 三层选项的 `createAgent()`
- 底层 Session 生命周期：`createSession()`、`resumeSession()`、`forkSession()`、`prompt()`
- 可转向请求：持久化的 `now`、`next`、`later` 输入，支持取消和待处理输入查询
- Durable 恢复：带 fencing 的执行租约、受控 worker handoff、Request/Turn rollover、显式模型/工具对账与 cursor 断线续读
- 执行平面：`AgentWorker`、可注入的 `SessionRunner` 契约、`SdkSessionRunner`、`ExecutionHostSessionRunner` 与持久化 `EffectDispatcher`
- 流式事件：17 种类型化事件，覆盖轮次、内容、思维、工具、usage、转向、结果和错误
- Provider：OpenAI、Anthropic、Azure OpenAI、Gemini、DeepSeek 和 OpenAI-compatible API
- 工具：支持 async function 与 AsyncGenerator、Zod schema、按能力分组的内置工具、MCP 工具和类型化进度/副作用
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

常用路径使用 Zod schema 和普通 async function。返回值会自动转换成内部成功结果：

```ts
import { defineTool } from '@blade-ai/agent-sdk';
import { z } from 'zod';

const weather = defineTool({
  name: 'GetWeather',
  description: '查询城市天气',
  parameters: z.object({ city: z.string() }),
  async execute({ city }) {
    return { weather: `${city}：晴，25 C` };
  },
});
```

需要产生类型化进度、消息或 effect 时，继续使用 `async *execute`。generator
工具保留现有的 `ToolResult` 终态契约。

## 权限与 Hooks

新的 Agent 集成只使用一个权限字段：

```ts
const agent = await createAgent({
  model: 'gpt-4o-mini',
  apiKey,
  advanced: {
    permission: async (request) =>
      request.kind === 'readonly' ? 'allow' : 'ask',
    hooks: {
      PreToolUse: [
        async (event) => {
          console.log(event.toolName, event.toolInput);
          return { action: 'continue' };
        },
      ],
    },
  },
});
```

`advanced.hooks` 只包含进程内 TypeScript callback，对应 8 种 Session hook
事件。Shell hooks 使用 CLI/宿主配置中的 `HookConfig`，不能传给
`createAgent()`。底层集成仍可使用 `SessionOptions.permissionMode` 和
`permissionHandler`；`canUseTool` 已弃用。

## 包入口

```ts
import { createAgent, defineTool } from '@blade-ai/agent-sdk';
import { createSession as createServerSession } from '@blade-ai/agent-sdk/server';
import { createSession as createNodeSession } from '@blade-ai/agent-sdk/node';
import { AgentClient } from '@blade-ai/agent-sdk/browser';
import { AGENT_PROTOCOL_VERSION } from '@blade-ai/agent-sdk/protocol';
import { PostgresRuntimeStore } from '@blade-ai/agent-sdk/server/postgres';
import { OpenTelemetryAgentServerTelemetry } from '@blade-ai/agent-sdk/server/otel';
import { InputPriority, ToolKind } from '@blade-ai/agent-sdk/core';
import { composeMiddleware } from '@blade-ai/agent-sdk/middleware';
import type { ModelMessage, ModelService } from '@blade-ai/agent-sdk/model';
```

- 根入口：默认的 `createAgent` 与工具定义 API
- `/server`：底层服务端 Session，以及可注入 `SessionExecutor` 的 `AgentServer`
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

使用一条命令在本地运行完整的浏览器到 Worker 生产拓扑：

```bash
pnpm example:production
```

该命令会启动 PostgreSQL、`AgentServer`、运行真实 SDK Session 的 `AgentWorker`，
以及带浏览器审批步骤的隔离 Docker 仓库环境。详见[可运行 Golden Paths](./examples/README.md)。

PostgreSQL、OpenTelemetry、非内置 Provider adapter 和本机原生增强是按需 peer：

```bash
pnpm add pg                         # /server/postgres
pnpm add @opentelemetry/api         # /server/otel
pnpm add @ai-sdk/anthropic          # provider: anthropic
pnpm add fs-native-extensions        # Node JSONL 跨进程锁
```

## 持久化与 Workspace

未同时配置只读 `SessionRepository` 与只写 `SessionEventStore` 时，Session
只保存在内存中。local Agent 会把 `advanced.storagePath` 转换为同时实现两者的
本地 JSONL `SessionPersistence`：

```ts
import { createAgent } from '@blade-ai/agent-sdk';

const agent = await createAgent({
  model,
  apiKey,
  profile: 'local',
  filesystem: {
    roots: [process.cwd()],
    cwd: process.cwd(),
  },
  advanced: {
    storagePath: '/var/lib/my-agent',
  },
});
```

根入口的底层 `createSession()` 和 `/server` 不会把 `storagePath` 解释为本地
持久化；服务端应用必须显式注入 `sessionRepository` 和 `sessionEventStore`，
或配置共享 `runtimeStore`。
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
- [迁移到真实仓库](./docs/migrating-to-your-repository.md)
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

发布版本号来自 Git tag，与 commit 类型无关。每个可发布的改动仍然要在 `.changes/`
下增加一个双语 JSON fragment：

```json
{
  "type": "feature",
  "en": "Add a user-facing capability.",
  "zh-CN": "新增一项用户可见能力。"
}
```

文件名必须唯一且使用 kebab-case。`type` 只允许 `breaking`、`feature`、
`fix`、`performance`、`refactor` 和 `docs`，它决定变更日志的分节，不决定版本号。

要发布，就给 `main` 上的提交打 tag 并推送该 tag：

```bash
git tag v7.4.2
git push origin v7.4.2
```

发布工作流随后以该 tag 的代码树为准：

1. 先 checkout 它声明的 tag，并在**构建之前**把该版本号写进 `package.json`，避免 bundle 与 tarball manifest 携带上一个版本；
2. 校验 fragment、lint、类型检查、构建并测试 package 和文档；
3. 校验构建产物确实带有该版本号后，把 `v7.4.2` 原样发布到 npm 并带上 provenance——不会产生别的版本号；
4. 在 `main` 上用一次 `chore(release): 7.4.2` 提交记录版本号、两份变更日志和已消费的 fragment；
5. 用双语说明创建 GitHub Release。

推送到 `main` 不再触发发布。用 `pnpm run changelog:check` 校验 fragment；
先在本地打 tag，再用 `pnpm run release:dry --tag v7.4.2` 预演发布。

更多贡献约定见 [CONTRIBUTING.md](./CONTRIBUTING.md)。

## 许可证

[MIT](./LICENSE)
