# Blade Agent SDK

面向 Node.js 与 TypeScript 的 Session-first Agent SDK。它把多轮会话、工具执行、MCP、子 Agent、Skills、权限控制、Hooks、沙箱和结构化输出统一到一套 API 中，适合构建 CLI 助手、IDE 插件、自动化工作流和对话式开发工具。

根目录 `README` 只保留仓库概览和最小上手。更详细的配置、API 和使用模式已经放在 `docs/` 中，并通过 VitePress 对外发布，避免首页和文档站维护两套重复内容。

## 核心能力

- Session-first：`createSession()`、`resumeSession()`、`forkSession()`、`prompt()`
- 流式 Agent 交互：`send()` + `stream()`，支持内容、thinking、tool use、tool result、usage、result 等 15 种事件类型
- 多模型支持：`openai`、`anthropic`、`azure-openai`、`gemini`、`deepseek`、`openai-compatible`
- 工具系统：内置 23 个标准工具，支持 `defineTool()`、`createTool()`、MCP 协议工具与 MCP 资源工具
- 工具目录：`ToolCatalog` 统一管理内置、自定义、MCP 工具的来源追踪与信任分级
- MCP：支持 `stdio`、`sse`、`http` 传输，也支持从 `@blade-ai/agent-sdk/local` 显式导入的进程内 `createSdkMcpServer()`
- 协作能力：子 Agent（前台/后台）、`Task` / `TaskOutput` / `TaskStop` 工具，以及用户级和项目级 Skills
- Memory 系统：`@blade-ai/agent-sdk/local` 提供 `MemoryManager` + `FileSystemMemoryStore`，可选的 `MemoryRead` / `MemoryWrite` 工具
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

- `@blade-ai/ai` / `packages/ai`：provider-agnostic 的 `ModelPort`、stream event、usage normalization、provider adapter 和 provider-specific helper，例如 OpenAI-compatible / GLM / Vercel AI SDK / DeepSeek helper。
- `@blade-ai/agent` / `packages/agent`：运行时无关的 `AgentKernel`、tool/store/hook/trace ports 和 agent stream 协议，不依赖 Node 本地能力、MCP、文件系统、shell 或 provider SDK。
- `@blade-ai/agent-sdk` / `packages/agent-sdk`：session-first 产品 SDK，组合 `@blade-ai/agent` 与 `@blade-ai/ai`；root 入口保留 `createSession()`、工具定义、权限、协议和类型，Node 本地工具、MCP、memory、sandbox adapter 需要从 `@blade-ai/agent-sdk/local` 显式导入，provider-specific helper 从 `@blade-ai/ai/*` 导入。

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

SDK 保持 session-first 的默认体验，root 入口面向 Node server 和 CLI process embedding 场景：

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

`@blade-ai/agent-sdk/server` 是显式 server-only facade，直接组合 session/core/tools/subagent API，不通过 root wildcard 转发。它会保持与 root 的公开 server-safe runtime/type surface 对齐，同时发布产物里的 server 入口也能被 verifier 独立检查。

`@blade-ai/agent-sdk/core` 只导出 browser-safe 的类型、协议和常量。浏览器环境误导入 root、`server`、`session` 或 `local` 入口时，会解析到 browser stub，并在调用 server-only API 时抛出清晰错误。

`@blade-ai/agent-sdk` 可以嵌入你自己的 CLI 进程，但 `@blade-ai/ai`、`@blade-ai/agent` 和 `@blade-ai/agent-sdk` 都 does not publish a CLI product。不要依赖不存在的 `@blade-ai/agent-sdk/cli`；未来如果提供 Pi-style coding-agent / CLI 产品，应由独立包承载。

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
pnpm run test:packages
pnpm run test:integration
pnpm run docs:build
pnpm run docs:dev
```

`pnpm run verify` 是 CI 和发版前的生产 gate，会串起 lint、root/workspace type-check、examples type-check、package boundary scanner、docs build、entrypoint/browser-safety scanner、packed package smoke、release config verification、root unit tests、workspace package tests 和默认 integration skip 检查。workspace package tests 会直接进入三个发布包目录运行 package-local suites，并且三包都不允许 no-tests 通过，确保 provider、agent kernel、session-first facade 和 browser stub 这类包内边界有自己的测试落点。package boundary scanner 会同时保护三包依赖方向、build entry ownership、publish manifest targets、manifest root entry fields、package metadata export、exact package metadata export shape、manifest target extension checks、source manifest target source-file rejection, relativity, containment, and source-backed checks、public export subpath shape checks、SDK source browser export condition targets、CLI product capability 禁入、types-first export condition order、browser-before-import export condition order、public export condition allowlist，以及 package 源码里的 ESM 相对 import/export 必须带显式运行时文件扩展。release config verification 还会确认根 `package.json` 保持 private orchestrator，不声明 `publishConfig` 或 `files`，并拒绝任何会让 semantic-release 发布 workspace root 的 npm plugin 配置。

`pnpm run verify:packages` 会先 fresh-build 三个发布包，再打出 packed tarball，把它们安装到外部 temporary consumer 项目里，并从 consumer 侧 import root/subpath exports，检查 packed package size budgets、packed package file scope、TypeScript artifact scope、package artifact allowlist、packed package manifest hygiene、packed package dependency-version gate、package lifecycle script gate、packed package npm metadata、packed package repository directory metadata、packed package description metadata、packed package author metadata、packed package discoverability metadata、packed package module metadata、packed package engine metadata、packed package license artifacts、packed package manifest entry targets、exact package metadata export shape、manifest target extension checks、manifest target existence checks、runtime external dependency declaration checks、runtime relative import resolution checks、declaration relative reference resolution checks、declaration external dependency declaration checks、public export subpath shape checks、root export manifest contracts、types-first export condition order、browser-before-import export condition order、public export condition allowlist、packed CLI product boundary、packed SDK browser export conditions 和 packed SDK browser-safe static import closures，防止声明文件、source files、TypeScript 源文件、构建配置、exports、browser stub、workspace 依赖、外部依赖 range / placeholder、内部依赖 range、源码仓库 manifest 开发元数据、npm 子包源码目录指向、npm 生命周期脚本、模块格式、Node 运行时契约、npm 包描述、维护方信息、npm 可发现性、许可证文本、包体积或包内容在 npm 分发时回退；其中 packed README 与 package README 完全一致，`LICENSE` 与根 LICENSE 完全一致。

真实模型测试是显式 opt-in：

```bash
pnpm run test:live:session-glm
INTEGRATION_LIVE=1 pnpm run test:integration:live
```

`test:live:session-glm` 会用 `.env` / `GLM_*` / `INTEGRATION_*` 配置对 `glm-5.2` 跑一次 session-first smoke，并校验 stream 成功事件、`allowedTools: []` 无工具行为和 observability trace；`test:integration:live` 会跑完整真实 integration suite。默认 `pnpm run test:integration` 不设置 `INTEGRATION_LIVE=1` 时只验证跳过行为，避免 CI 和 release 被外部模型波动拖住。

## 发布

本仓库使用 `semantic-release` 自动发包。代码合并到 `main` 后，GitHub Actions 会先运行完整的 `pnpm run verify`；通过后再根据 conventional commits 自动决定版本、创建 `v*` 标签、发布 GitHub Release，并以 fixed-version monorepo 模式把 `@blade-ai/ai`、`@blade-ai/agent`、`@blade-ai/agent-sdk` 发布到 npm。如果发布步骤产生了新的 `v*` tag，workflow 会自动运行 `pnpm run verify:published -- --version <tag>`，确认公开 Release、npm 包、npm latest dist-tag、registry tarball integrity、npm provenance attestations、published package manifests、npm-facing manifest hygiene、published package dependency-version gate、published package size budgets、published package npm metadata、published package repository directory metadata、published package description metadata、published package author metadata、published package discoverability metadata、published package module metadata、published package engine metadata、published package license artifacts、published package manifest entry targets、exact package metadata export shape、manifest target extension checks、manifest target existence checks、runtime external dependency declaration checks、runtime relative import resolution checks、declaration relative reference resolution checks、declaration external dependency declaration checks、public export subpath shape checks、root export manifest contracts、types-first export condition order、browser-before-import export condition order、public export condition allowlist、published CLI product boundary、published SDK browser export conditions、published SDK browser-safe static import closures、published package file scope、TypeScript artifact scope、package artifact allowlist、published package READMEs、runtime import smoke、root/subpath 类型声明、browser-safe `core` 声明边界、SDK browser bundle smoke 和 `@blade-ai/agent` browser bundle smoke 都能从外部 consumer 使用；published README 与 package README 完全一致，published package license artifacts 会确认 `LICENSE` 与根 LICENSE 完全一致。没有新版本时会跳过 post-publish verification。

CI workflow 只授予 `contents: read`，避免普通验证任务继承更宽的默认 `GITHUB_TOKEN` 权限，并保持 main / master / refactor / codex 分支和 pull request 触发、`ubuntu-latest` runner、20 分钟超时、`actions/checkout@v5`、Node `22`、`pnpm/action-setup` `11.7.0`、pnpm cache、frozen install 和完整 `pnpm run verify` 受 release gate 校验。docs workflow 只授予 GitHub Pages 部署所需的 `contents: read`、`pages: write` 和 `id-token: write`，并保持 main 分支 docs-only 触发、manual dispatch、`concurrency.group: pages`、Node `22`、`pnpm/action-setup` `11.7.0`、frozen install、`pnpm run docs:build`、`docs/.vitepress/dist` artifact path 和 `actions/deploy-pages@v4` deploy job 受 release gate 校验。release workflow 只授予发布所需的 `contents: write`、`issues: write`、`pull-requests: write` 和 `id-token: write`，并保持 main 分支和 manual dispatch 触发、`ubuntu-latest` runner、20 分钟超时、`actions/checkout@v5`、setup-node pnpm cache、`concurrency.group: release-main` 和 `cancel-in-progress: false` 受 release gate 校验，避免连续 push 触发重叠 publish，也避免取消正在进行的 npm publish / post-publish verification。

三个 publishable source package 的 `version` 都保持 `0.0.0` placeholder。发布前本地 release 插件会把三个 workspace 包的 `version` 和内部 `workspace:*` 依赖同步成同一个发布版本，并从 npm-facing manifests 删除 `private` 和 `devDependencies`，避免 npm 包里泄漏 workspace 协议或源码仓库开发元数据。

GitHub Release notes 会在 conventional commit 摘要后追加三包发布清单，列出 `@blade-ai/ai`、`@blade-ai/agent`、`@blade-ai/agent-sdk` 的同版本发布结果和 session-first 安装命令。

`pnpm run verify:release` 会在不触发网络发版的情况下静态校验 `semantic-release` 配置、root private orchestrator 发布安全、三包 publish metadata、publishable source package version placeholders、direct dependencies 使用 exact versions、`pnpm-workspace.yaml` 的 dependency build-script allowlist、`publishConfig.provenance: true`、CI workflow 的 `contents: read` 最小权限、CI workflow trigger / runner / timeout / checkout / cache、docs workflow 的 GitHub Pages 最小权限、docs workflow trigger / concurrency / deploy job、docs workflow toolchain pins 和 `docs/.vitepress/dist` artifact path、release workflow 的精确发布权限、release workflow trigger / runner / timeout / checkout / cache、workflow 使用 `pnpm install --frozen-lockfile --ignore-scripts`、release workflow 的 full-history checkout、exact npm trusted-publishing CLI 与 lifecycle-script suppression、verify-before-release 顺序、package README 直接安装/import 示例、source package LICENSE artifacts、package LICENSE artifact，以及 OIDC trusted publishing 设置。`pnpm run verify:packages` 会在发布前检查 packed package file scope、TypeScript artifact scope、package artifact allowlist、packed package manifest hygiene、packed package dependency-version gate、package lifecycle script gate、packed package READMEs 和 packed package license artifacts，确保 source、packed、published package manifests 不声明 `preinstall`、`install`、`postinstall`、`prepare`、`prepublish` 或 `prepublishOnly`，tarball manifest 不包含 `private` 或 `devDependencies`，tarball 外部依赖不包含 `0.0.0` placeholder 或 range，内部依赖只能是本地 pack 阶段的 `0.0.0` 或 concrete exact version，tarball 不包含 `package/src`、嵌套 `/src/` 源码、TypeScript 源文件或 `tsconfig` / `tsup.config` 构建配置，并且只发布 `package.json`、`README.md`、`LICENSE`、`dist/**` 和 `@blade-ai/agent-sdk` 的 `vendor/ripgrep/**` artifact，`README.md` 仍包含包名、直接安装命令和最小 import 示例且 packed README 与 package README 完全一致，source package LICENSE 与根 LICENSE 完全一致，并且 `LICENSE` 保留 MIT 授权文本且 LICENSE 与根 LICENSE 完全一致。

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

发布 workflow 已经会自动运行公开可见性检查。维护者也可以在本地用同一命令复核 GitHub Release、三个 npm 包、npm latest dist-tag、registry tarball integrity 和 npm provenance attestations 是否都已经能被外部用户解析。该命令会创建一个临时 consumer，从 npm 安装同版本的三包，并用 exact `typescript` / `esbuild` 版本执行 post-publish temporary consumer toolchain pin gate，再执行 package-lock tarball resolved/integrity 对齐、published package manifests 版本/内部依赖检查、npm-facing manifest hygiene 检查、published package dependency-version gate 检查、published package size budgets 检查、published package npm metadata 检查、published package description metadata 检查、published package author metadata 检查、published package discoverability metadata 检查、published package module metadata 检查、published package engine metadata 检查、published package license artifacts 检查、published package manifest entry targets 检查、manifest target extension checks、manifest target existence checks、runtime external dependency declaration checks、runtime relative import resolution checks、declaration relative reference resolution checks、declaration external dependency declaration checks、public export subpath shape checks、published CLI product boundary 检查、published SDK browser export conditions 检查、published package file scope 检查、TypeScript artifact scope 检查、package artifact allowlist 检查、published package READMEs 安装/import 示例检查、runtime import smoke、root/subpath TypeScript public declarations 编译、SDK browser bundle smoke 与 `@blade-ai/agent` browser bundle smoke：

```bash
pnpm run verify:published -- --version 1.2.3
```

更多贡献约定见 [CONTRIBUTING.md](./CONTRIBUTING.md)。

## 社区

- [linux.do](https://linux.do/)
