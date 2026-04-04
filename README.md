# Blade Agent SDK

面向 Node.js 与 TypeScript 的 Session-first Agent SDK。它把多轮会话、工具执行、MCP、子 Agent、Skills、权限控制、Hooks、沙箱和结构化输出统一到一套 API 中，适合构建 CLI 助手、IDE 插件、自动化工作流和对话式开发工具。

根目录 `README` 只保留仓库概览和最小上手。更详细的配置、API 和使用模式已经放在 `docs/` 中，并通过 VitePress 对外发布，避免首页和文档站维护两套重复内容。

## 核心能力

- Session-first：`createSession()`、`resumeSession()`、`forkSession()`、`prompt()`
- 流式 Agent 交互：`send()` + `stream()`，支持内容、thinking、tool use、tool result、usage、result 等事件
- 多模型支持：`openai`、`anthropic`、`azure-openai`、`gemini`、`deepseek`、`openai-compatible`
- 工具系统：内置 18 个标准工具，支持 `defineTool()`、`createTool()`、MCP 协议工具与 MCP 资源工具
- MCP：支持 `stdio`、`sse`、`http` 传输，也支持进程内 `createSdkMcpServer()`
- 协作能力：支持子 Agent、`Task` / `TaskOutput` 工具，以及用户级和项目级 Skills
- 安全与治理：`permissionMode`、`canUseTool`、Hooks、沙箱配置可组合使用
- 工程能力：运行时 Context、结构化输出、日志接口、会话持久化与分叉、自动上下文压缩

## 安装

```bash
npm install @blade-ai/agent-sdk
# 或
pnpm add @blade-ai/agent-sdk
```

已发布包面向 npm 分发；这个仓库本身使用 `pnpm` 进行依赖安装、构建、测试、发布和文档开发。

## 快速开始

```ts
import { createSession } from '@blade-ai/agent-sdk';

const session = await createSession({
  provider: { type: 'openai', apiKey: process.env.OPENAI_API_KEY! },
  model: 'gpt-4o-mini',
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

## 什么时候适合用它

- 需要一个可持久化、可恢复、可分叉的 Agent Session 层
- 需要把文件、搜索、Shell、Web、MCP 等能力统一暴露给模型
- 需要在本地开发环境里组合权限控制和沙箱
- 需要用自定义工具、MCP server、子 Agent 或 Skills 扩展能力
- 需要结构化输出、日志和运行时 Context 来接入现有应用

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

更多贡献约定见 [CONTRIBUTING.md](./CONTRIBUTING.md)。

## 社区

- [linux.do](https://linux.do/)
