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

已发布包面向 npm 分发；这个仓库本身使用 `pnpm` 进行依赖安装、构建、测试、发布和文档开发。

> **ESM-only**：本包为纯 ESM（`"type": "module"`），仅通过 `import` 使用，不支持 CommonJS `require()`（否则会报 `ERR_PACKAGE_PATH_NOT_EXPORTED`）。请确保项目为 ESM（package.json 设 `"type": "module"`）或使用支持 ESM 的运行时/打包器。

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
pnpm run build
pnpm test
pnpm run type-check
pnpm run lint
pnpm run docs:dev
```

## 发布

本仓库使用 `semantic-release` 自动发包。代码合并到 `main` 后，GitHub Actions 会先运行 lint、type-check、build 和 test；通过后再根据 conventional commits 自动决定版本、创建 `v*` 标签、发布 GitHub Release，并把 `@blade-ai/agent-sdk` 发布到 npm。

- `feat:` 触发 minor 版本
- `fix:` 触发 patch 版本
- `BREAKING CHANGE:` 触发 major 版本
- `docs:`、`test:`、`chore:` 等默认不会单独发包

第一次启用前，需要在 GitHub 仓库的 Actions secrets 中配置 `NPM_TOKEN`，或在 npm 上为这个仓库配置 Trusted Publishing。手动预演可以运行：

```bash
pnpm run release:dry
```

更多贡献约定见 [CONTRIBUTING.md](./CONTRIBUTING.md)。

## 社区

- [linux.do](https://linux.do/)
