# Blade Agent SDK

面向 Node.js 与 TypeScript 的 Session-first Agent SDK。它把多轮会话、工具执行、MCP、子 Agent、Skills、权限控制、Hooks、沙箱和结构化输出统一到一套 API 中，适合构建 CLI 助手、IDE 插件、自动化工作流和对话式开发工具。

根目录 `README` 只保留仓库概览和最小上手。更详细的配置、API 和使用模式已经放在 `docs/` 中，并通过 VitePress 对外发布，避免首页和文档站维护两套重复内容。

## 核心能力

- Session-first：`createSession()`、`resumeSession()`、`forkSession()`、`prompt()`
- 流式 Agent 交互：`send()` + `stream()`，支持内容、thinking、tool use、tool result、usage、result 等 15 种事件类型
- 多模型支持：`openai`、`anthropic`、`azure-openai`、`gemini`、`deepseek`、`openai-compatible`
- 工具系统：内置 23 个标准工具，支持 `defineTool()`、`createTool()`、MCP 协议工具与 MCP 资源工具
- 工具目录：`ToolCatalog` 统一管理内置、自定义、MCP 工具的来源追踪与信任分级
- MCP：支持 `stdio`、`sse`、`http` 传输，也支持进程内 `createSdkMcpServer()`
- 协作能力：子 Agent（前台/后台）、`Task` / `TaskOutput` / `TaskStop` 工具，以及用户级和项目级 Skills
- Memory 系统：`MemoryManager` + `FileSystemMemoryStore`，可选的 `MemoryRead` / `MemoryWrite` 工具
- 安全与治理：`permissionMode`、`canUseTool`、`permissionHandler`、Hooks、沙箱配置可组合使用
- Observability：可选 trace 记录，把 stream events、tool calls、usage、hooks 汇总为可调试的执行轨迹
- 工程能力：运行时 Context、结构化输出、日志接口、会话持久化与分叉、自动上下文压缩、上下文溢出恢复、Token 预算

## 安装

```bash
npm install @blade-ai/agent-sdk
# 或
pnpm add @blade-ai/agent-sdk
```

如果你要直接使用底层模型适配层或 runtime-independent agent kernel，可以安装完整三包：

```bash
npm install @blade-ai/ai @blade-ai/agent @blade-ai/agent-sdk
pnpm add @blade-ai/ai @blade-ai/agent @blade-ai/agent-sdk
```

已发布包面向 npm 分发；这个仓库本身使用 `pnpm` 进行依赖安装、构建、测试、发布和文档开发。

> **ESM-only**：本包为纯 ESM（`"type": "module"`），仅通过 `import` 使用，不支持 CommonJS `require()`（否则会报 `ERR_PACKAGE_PATH_NOT_EXPORTED`）。请确保项目为 ESM（package.json 设 `"type": "module"`）或使用支持 ESM 的运行时/打包器。

## Monorepo 包结构

仓库采用 pnpm workspace。根目录 `package.json` 是私有 orchestrator，不直接发布；npm 发布包位于 `packages/*`。整体边界对标 Pi 的分层思路：模型 API、agent loop/kernel、产品 SDK 分开演进，但 Blade 保持 session-first 作为默认用户体验。

- `@blade-ai/ai` / `packages/ai`：provider-agnostic 的 `ModelPort`、stream event、usage normalization 和 provider adapter，例如 OpenAI-compatible / GLM / Vercel AI SDK 适配。
- `@blade-ai/agent` / `packages/agent`：运行时无关的 `AgentKernel`、tool/store/hook/trace ports 和 agent stream 协议，不依赖 Node 本地能力、MCP、文件系统、shell 或 provider SDK。
- `@blade-ai/agent-sdk` / `packages/agent-sdk`：session-first 产品 SDK，组合 `@blade-ai/agent` 与 `@blade-ai/ai`，并在 server / CLI 场景里接入本地工具、MCP、权限、hooks、observability、sandbox 和 session persistence。

推荐 import 边界：

```ts
import { createOpenAICompatibleModelPort } from '@blade-ai/ai';
import { AgentKernel } from '@blade-ai/agent';
import { createSession } from '@blade-ai/agent-sdk';
```

大多数应用只需要 `@blade-ai/agent-sdk`。只有当你要自己组装模型层或 agent kernel 时，才直接依赖 `@blade-ai/ai` / `@blade-ai/agent`。

## 快速开始

```ts
import { createSession } from '@blade-ai/agent-sdk';

const session = await createSession({
  provider: { type: 'openai', apiKey: process.env.OPENAI_API_KEY! },
  model: 'gpt-4o-mini',
  temperature: 0.2,
  maxOutputTokens: 4096,
});

await session.send('分析当前项目的目录结构，并总结关键模块职责');

for await (const event of session.stream()) {
  if (event.type === 'content') {
    process.stdout.write(event.delta);
  }
}

session.close();
```

如果你只需要一次性调用，可以直接使用 `prompt()`：

```ts
import { prompt } from '@blade-ai/agent-sdk';

const result = await prompt('总结这个仓库的公开 API', {
  provider: { type: 'openai', apiKey: process.env.OPENAI_API_KEY! },
  model: 'gpt-4o-mini',
});

console.log(result.result);
console.log(result.toolCalls);
console.log(result.usage);
```

## 模型参数

`createSession()` 可以直接配置常见模型采样和预算参数，这些字段会传入当前会话的默认 `ModelConfig`：

```ts
const session = await createSession({
  provider: { type: 'openai', apiKey: process.env.OPENAI_API_KEY! },
  model: 'gpt-5',
  temperature: 0.2,
  maxOutputTokens: 4096,
  maxContextTokens: 128000,
  providerOptions: {
    openai: { reasoningEffort: 'low' },
  },
  thinkingEnabled: true,
  thinkingBudget: 1024,
  tokenBudget: {
    maxTotalTokens: 100000,
    warningThresholdPercent: 80,
  },
});
```

## 包入口

SDK 保持 session-first 的默认体验，root 入口面向 Node server 和 CLI 场景：

```ts
import { createSession } from '@blade-ai/agent-sdk';
```

需要更明确的运行时边界时，可以使用 subpath exports：

```ts
import { createSession } from '@blade-ai/agent-sdk/server';
import { ToolKind } from '@blade-ai/agent-sdk/core';
import { defineTool } from '@blade-ai/agent-sdk/tools';
import { getBuiltinTools } from '@blade-ai/agent-sdk/local';
```

`@blade-ai/agent-sdk/core` 只导出 browser-safe 的类型、协议和常量。浏览器环境误导入 root、`server`、`session` 或 `local` 入口时，会解析到 browser stub，并在调用 server-only API 时抛出清晰错误。

## Observability Trace

当需要调试 Agent 行为时，可以开启 `observability`。SDK 会为每次 `send()` + `stream()` 生成一条 trace，串起 turn、内容流、工具调用、usage、hooks 和最终结果。

默认情况下，trace 只记录结构化摘要，不保存完整 prompt、模型输出、工具入参或工具结果，避免把敏感内容写入调试数据。只有显式设置 `capturePayloads: true` 时才会记录完整 payload。

```ts
import { createSession } from '@blade-ai/agent-sdk';

const session = await createSession({
  provider: { type: 'openai', apiKey: process.env.OPENAI_API_KEY! },
  model: 'gpt-4o-mini',
  observability: {
    enabled: true,
    // capturePayloads: true, // 调试时才开启，可能包含敏感内容
    sink: async (trace) => {
      await sendTraceToYourPlatform(trace);
    },
  },
});

await session.send('分析当前项目的测试覆盖');
for await (const event of session.stream()) {
  if (event.type === 'content') process.stdout.write(event.delta);
}

console.log(session.getLastTrace());
```

## 什么时候适合用它

- 需要一个可持久化、可恢复、可分叉的 Agent Session 层
- 需要把文件、搜索、Shell、Web、MCP 等能力统一暴露给模型
- 需要在本地开发环境里组合权限控制和沙箱
- 需要用自定义工具、MCP server、子 Agent 或 Skills 扩展能力
- 需要结构化输出、日志、trace 和运行时 Context 来接入现有应用

## 文档

README 只保留概览。详细用法请直接看文档：

- [文档首页](./docs/index.md)
- [概览](./docs/blade-agent-sdk.md)
- [架构说明](./docs/architecture.md)
- [包与入口](./docs/packages.md)
- [Session API](./docs/session.md)
- [Provider 配置](./docs/providers.md)
- [工具系统](./docs/tools.md)
- [MCP 协议集成](./docs/mcp.md)
- [子 Agent](./docs/agents.md)
- [Skills 系统](./docs/skills.md)
- [Hooks 生命周期钩子](./docs/hooks.md)
- [权限控制](./docs/permissions.md)
- [沙箱安全](./docs/sandbox.md)
- [常见模式](./docs/recipes.md)
- [API 参考](./docs/api-reference.md)

## 仓库开发

```bash
pnpm install
pnpm run verify
pnpm run verify:packages
pnpm run verify:entrypoints
pnpm run verify:release
pnpm run test:unit
pnpm run test:integration
pnpm run docs:build
pnpm run docs:dev
```

`pnpm run verify` 是 CI 和发版前的生产 gate，会串起 lint、root/workspace type-check、examples type-check、package boundary scanner、docs build、entrypoint/browser-safety scanner、packed package smoke、release config verification、unit tests 和默认 integration skip 检查。

`pnpm run verify:packages` 会先 fresh-build 三个发布包，再打出 packed tarball，把它们安装到外部 temporary consumer 项目里，并从 consumer 侧 import root/subpath exports，防止声明文件、exports、workspace 依赖或包内容在 npm 分发时回退。

真实模型测试是显式 opt-in：

```bash
pnpm run test:live:session-glm
INTEGRATION_LIVE=1 pnpm run test:integration:live
```

`test:live:session-glm` 会用 `.env` / `GLM_*` / `INTEGRATION_*` 配置对 `glm-5.2` 跑一次 session-first smoke，并校验 stream 成功事件、`allowedTools: []` 无工具行为和 observability trace；`test:integration:live` 会跑完整真实 integration suite。默认 `pnpm run test:integration` 不设置 `INTEGRATION_LIVE=1` 时只验证跳过行为，避免 CI 和 release 被外部模型波动拖住。

## 发布

本仓库使用 `semantic-release` 自动发包。代码合并到 `main` 后，GitHub Actions 会先运行完整的 `pnpm run verify`；通过后再根据 conventional commits 自动决定版本、创建 `v*` 标签、发布 GitHub Release，并以 fixed-version monorepo 模式把 `@blade-ai/ai`、`@blade-ai/agent`、`@blade-ai/agent-sdk` 发布到 npm。如果发布步骤产生了新的 `v*` tag，workflow 会自动运行 `pnpm run verify:published -- --version <tag>`，确认公开 Release、npm 包、npm provenance attestations、runtime import smoke、root/subpath 类型声明、browser-safe `core` 声明边界、SDK browser bundle smoke 和 `@blade-ai/agent` browser bundle smoke 都能从外部 consumer 使用；没有新版本时会跳过 post-publish verification。

发布前本地 release 插件会把三个 workspace 包的 `version` 和内部 `workspace:*` 依赖同步成同一个发布版本，避免 npm 包里泄漏 workspace 协议。

GitHub Release notes 会在 conventional commit 摘要后追加三包发布清单，列出 `@blade-ai/ai`、`@blade-ai/agent`、`@blade-ai/agent-sdk` 的同版本发布结果和 session-first 安装命令。

`pnpm run verify:release` 会在不触发网络发版的情况下静态校验 `semantic-release` 配置、三包 publish metadata、`publishConfig.provenance: true`、release workflow 的 verify-before-release 顺序，以及 OIDC trusted publishing 设置。

- `feat:` 触发 minor 版本
- `fix:` 触发 patch 版本
- `BREAKING CHANGE:` 触发 major 版本
- `docs:`、`test:`、`chore:` 等默认不会单独发包

第一次启用前，需要在 npm 上分别为 `@blade-ai/ai`、`@blade-ai/agent`、`@blade-ai/agent-sdk` 配置 Trusted Publishing，让 GitHub Actions 通过 OIDC 发布，不再依赖长期 `NPM_TOKEN`。三个发布包的 `publishConfig.provenance` 必须保持为 `true`，这样 token fallback 或本地发布路径也不会绕过 npm provenance。每个 npm 包使用相同配置项：

- Owner: `echoVic`
- Repository: `blade-agent-sdk`
- Workflow filename: `release.yml`
- Environment name: 留空

手动预演不会执行 prepare/publish，但仍会验证 GitHub 和 npm 发布权限；本地运行时需要提供可用的 `GITHUB_TOKEN` 或 `GH_TOKEN`：

```bash
pnpm run release:dry
```

发布 workflow 已经会自动运行公开可见性检查。维护者也可以在本地用同一命令复核 GitHub Release、三个 npm 包和 npm provenance attestations 是否都已经能被外部用户解析。该命令会创建一个临时 consumer，从 npm 安装同版本的三包，并执行 runtime import smoke、root/subpath TypeScript public declarations 编译、SDK browser bundle smoke 与 `@blade-ai/agent` browser bundle smoke：

```bash
pnpm run verify:published -- --version 1.2.3
```

更多贡献约定见 [CONTRIBUTING.md](./CONTRIBUTING.md)。

## 社区

- [linux.do](https://linux.do/)
