# 架构说明

Blade Agent SDK 的目标是把仓库拆成 `@blade-ai/ai`、`@blade-ai/agent`、`@blade-ai/agent-sdk` 三个清晰包，同时保留 session-first 的产品体验：

```ts
import { createSession } from '@blade-ai/agent-sdk';
```

这条入口面向 Node server 和 CLI。浏览器端只应该使用 browser-safe 的类型、协议和远程客户端能力，不能直接加载本地工具、MCP、文件系统或 shell 运行时。

## 三包职责

| 包 | 职责 | 不能做什么 |
| --- | --- | --- |
| `@blade-ai/ai` | Provider-agnostic 模型协议、stream event、usage、provider adapter、provider-specific helper、模型选项归一化 | 不理解 Agent loop、Session、工具执行、本地运行时 |
| `@blade-ai/agent` | runtime-independent Agent kernel、tool call protocol、permission contract、store/trace/hook ports | 不导入 Node-only 模块、MCP SDK、provider SDK、本地工具、文件系统 |
| `@blade-ai/agent-sdk` | session-first 产品 SDK，组合 AI provider、Agent kernel、server runtime、MCP、工具、持久化、hooks、observability；Node-local adapters 由 `/local` 显式承载 | 不把 browser-safe API、root session facade、Node-only local adapters 和 provider-specific helper 混成一个入口 |

依赖方向固定为：

```text
@blade-ai/agent-sdk -> @blade-ai/agent -> @blade-ai/ai
@blade-ai/agent-sdk -> @blade-ai/ai
```

`@blade-ai/ai` 不依赖 `agent` 或 `agent-sdk`。`@blade-ai/agent` 只依赖 `@blade-ai/ai` 的模型协议，不依赖 provider 实现。`@blade-ai/agent-sdk` 是产品层，负责把模型、kernel、Session、工具和本地能力装配起来。

## 执行流

```text
createSession()
  -> SessionRuntime
  -> ModelPort from @blade-ai/ai
  -> AgentKernel from @blade-ai/agent
  -> Session adapters in @blade-ai/agent-sdk
       -> tools
       -> permission
       -> hooks
       -> store
       -> trace
```

`AgentKernel` 只通过 ports 调用外部能力。工具执行、权限确认、trace sink、持久化存储和 hook runtime 都由 `@blade-ai/agent-sdk` 注入。这样 kernel 可以在 server、CLI、测试环境或未来远程运行时中复用。

## Runtime 边界

`@blade-ai/agent` 必须保持 runtime-independent。它不能导入：

- `node:*`
- `child_process`
- `node-pty`
- `undici`
- `@modelcontextprotocol/sdk`
- 内置本地工具
- 文件系统 store
- provider SDK 实现

这些能力属于 `@blade-ai/agent-sdk/local` 或 `@blade-ai/agent-sdk/server`。浏览器安全入口只能导出类型、协议、常量和明确的 server-only stub。

## Observability 边界

Session trace 是产品层能力，但 trace event 的核心语义来自 kernel 和 session stream：

- stream events 描述用户可见的 turn 输出
- tool calls 描述工具调用、结果和权限更新
- usage 描述模型 token 和上下文预算
- hooks 描述 prompt、permission、tool、stop 等生命周期事件

默认 trace 不记录完整 prompt、工具入参或工具结果。只有显式启用 payload capture 时才保存完整内容。

## 生产约束

当前质量门通过 `pnpm run verify` 聚合：

- lint
- root 和 workspace type-check
- package boundary verification
- docs build
- browser/server entrypoint verification
- packed package install smoke test
- unit tests
- integration tests

发布从 `main` 触发，先运行完整验证链，再以 fixed-version monorepo 模式发布三个包。
