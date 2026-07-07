# Production Checklist

这个清单用于判断一次 Blade Agent SDK 改动是否达到 release-ready 状态。它面向维护者和自动化 agent，覆盖 package boundary、session-first API、browser-safe 入口、验证链、live smoke 和发版流程。

## 必跑门禁

每个合并到 `main` 的变更都必须先通过根验证链：

```bash
CI=true pnpm run verify
```

`pnpm run verify` 当前覆盖：

| Gate | 命令或范围 | 目的 |
| --- | --- | --- |
| Lint | `pnpm run lint` | 保持源码风格和基础静态检查稳定 |
| Root type check | `pnpm run type-check` | 检查根 SDK 源码类型 |
| Workspace type check | `pnpm -r run type-check` | 检查 `@blade-ai/ai`、`@blade-ai/agent`、`@blade-ai/agent-sdk` 包类型 |
| Examples | `pnpm run verify:examples` | 确保 session-first quickstart 示例持续可类型检查 |
| Package boundaries | `pnpm run verify:boundaries` | 确保 `@blade-ai/agent` 不引入 Node-local runtime、MCP、filesystem、provider SDK 或 session SDK；三包源码相对 import/export 必须带显式 ESM 运行时文件扩展；三包 manifest 不暴露 CLI product capability |
| Docs build | `pnpm run docs:build` | 确保 VitePress 文档可构建 |
| Entrypoints | `pnpm run verify:entrypoints` | 检查 root、server、session、local、core、tools、browser 入口和 browser-safe 约束 |
| Package smoke | `pnpm run verify:packages` | pack 三个 npm 包，检查 packed package file scope、packed package npm metadata、packed package description metadata、packed package author metadata、packed package discoverability metadata、packed package module metadata、packed package engine metadata、packed package license artifacts、packed package manifest entry targets、packed CLI product boundary 和 packed SDK browser export conditions，安装到临时 consumer，import 公共入口，type-check `SessionOptions` 采样/上下文/thinking/token budget 字段，并检查 browser-safe `core` 和 root 声明不暴露 server/local API 或 provider-specific helper |
| Unit tests | `pnpm run test:unit` | 覆盖 provider、agent kernel、session runtime、tools、hooks、observability、权限和 token budget |
| Integration tests | `pnpm run test:integration` | 有 `INTEGRATION_API_KEY` / `INTEGRATION_BASE_URL` 时跑真实集成；缺少时按测试策略跳过 |

## Package Boundary

发布前确认三层职责没有倒灌：

- `@blade-ai/ai` 只负责 model/provider 协议、stream、usage、provider options、provider adapters 和 provider-specific helper。
- `@blade-ai/agent` 保持 runtime-independent，只依赖端口和协议，不直接依赖 Node-only API、MCP SDK、provider SDK、本地工具、filesystem、shell、sandbox 或 `@blade-ai/agent-sdk`。
- `@blade-ai/agent-sdk` 作为产品 SDK 保持 session-first root 入口；Node-local adapters 必须通过 `@blade-ai/agent-sdk/local` 显式导入，DeepSeek 等 provider-specific helper 必须通过 `@blade-ai/ai/*` 显式导入：
- `@blade-ai/ai`、`@blade-ai/agent` 和 `@blade-ai/agent-sdk` 都是库包，does not publish a CLI product、不提供 `./cli` export，也不声明 `cli` keyword；`@blade-ai/agent-sdk` 仍可用于 CLI process embedding，但不提供 `@blade-ai/agent-sdk/cli`，未来 Pi-style coding-agent / CLI 产品必须拆成独立包。

```ts
import { createSession } from '@blade-ai/agent-sdk';
```

如果一个改动碰到这些边界，必须至少跑：

```bash
pnpm run verify:boundaries
pnpm run verify:entrypoints
pnpm run verify:packages
```

## Browser-safe Boundary

浏览器端只能使用 browser-safe 协议和类型：

- `@blade-ai/agent-sdk/core`
- `@blade-ai/agent-sdk/browser`
- `@blade-ai/agent-sdk/tools` 中不依赖本地执行器的类型和定义 API

客户端不要 import root、`server`、`session` 或 `local` runtime。发布前如果改动了入口、exports、browser stub、tools 类型或 docs 中的远程客户端示例，必须确认：

```bash
pnpm run verify:entrypoints
pnpm run docs:build
```

## Live GLM Smoke

真实模型链路不强制每个 PR 都跑，但以下情况应该手动执行：

- 改动 `@blade-ai/ai` provider adapter。
- 改动 model stream、usage 归一化、provider options、thinking 参数或 OpenAI-compatible 配置。
- 改动 session model config 到 `ModelPort` 的传递逻辑。
- 发版前需要确认 `.env` 中的 `glm-5.2` 真实链路仍可用。

命令：

```bash
pnpm run test:live:glm
pnpm run test:live:session-glm
```

`test:live:glm` 会构建 `@blade-ai/ai`，读取 `.env` 中的 GLM baseUrl / apiKey，执行一次非流式请求和一次流式请求，并检查 usage 信息。

`test:live:session-glm` 会构建 `@blade-ai/ai`、`@blade-ai/agent` 和 `@blade-ai/agent-sdk`，再用 session-first `createSession()` 真实执行一次 `send()` + `stream()`。它会显式设置 `allowedTools: []`，验证无工具场景下的 content / result 事件、server SDK 到 kernel/provider 的端到端组合，以及成功 trace 中的 `model_request`、`turn_end` 和 `result` 事件。

## Release Rehearsal

`pnpm run verify` 会先执行无 token 的静态 release gate，校验 semantic-release 配置、root private orchestrator 发布安全、三包 publish metadata、`publishConfig.provenance: true`、release workflow 的 verify-before-release 顺序，以及 OIDC trusted publishing 设置：

```bash
pnpm run verify:release
```

所有 workspace manifest 的 direct dependencies 必须使用 exact versions；源码里的内部 `@blade-ai/*` workspace 依赖可以保持 `workspace:*`，发布前会被 release prepare 步骤改成同一个 concrete version。

根 `package.json` 必须保持 private orchestrator，不声明 `publishConfig` 或 `files`，semantic-release 也不能配置发布 workspace root；只有 `@blade-ai/ai`、`@blade-ai/agent`、`@blade-ai/agent-sdk` 三个 `packages/*` manifest 是可发布 npm 包。

依赖 build scripts 必须维持最小 allowlist：`@vscode/ripgrep`、`esbuild`、`node-pty`。不要为了临时安装方便扩大 `pnpm-workspace.yaml` 的 `allowBuilds`。

发版前还可以用 dry-run 检查 semantic-release 的版本推导、release notes 和远端权限：

```bash
pnpm run release:dry
```

dry-run 不发布 npm 包。它通常需要 GitHub token 环境，适合维护者本机或安全的 CI 环境。

## Main Branch Publishing

推送到 `main` 后，`.github/workflows/release.yml` 会执行：

1. 以 `fetch-depth: 0` checkout 完整 git 历史和 tags，使用 exact `npm@11.5.1 --ignore-scripts` 升级 trusted-publishing npm CLI，再用 frozen lockfile 安装依赖，并忽略依赖生命周期脚本：`pnpm install --frozen-lockfile --ignore-scripts`。
2. 运行 `pnpm run verify`。
3. 运行 `pnpm exec semantic-release`。
4. 使用 GitHub OIDC trusted publishing 和 npm provenance 发布 `@blade-ai/ai`、`@blade-ai/agent`、`@blade-ai/agent-sdk`。
5. 对比发布前后的最新 `v*` tag；只有 semantic-release 创建新 tag 时，才运行 `pnpm run verify:published -- --version <tag>` 做 post-publish GitHub Release / npm / npm latest dist-tag / registry tarball integrity / npm provenance attestations / 临时 consumer / published package manifests / published package size budgets / published package npm metadata / published package description metadata / published package author metadata / published package discoverability metadata / published package module metadata / published package engine metadata / published package license artifacts / published package manifest entry targets / published CLI product boundary / published SDK browser export conditions / published package file scope / published package READMEs / browser-safe core 声明边界 / SDK browser bundle smoke / `@blade-ai/agent` browser bundle smoke 校验。发布前的 `pnpm run verify:packages` 还会检查 packed package size budgets、packed package file scope、packed package READMEs 和 packed package license artifacts，确认 tarball 体积维持在预算内、不包含 `package/src` 或嵌套 `/src/` 源码，`README.md` 保留包名、直接安装命令和最小 import 示例，并且 `LICENSE` 保留 MIT 授权文本。

release workflow 必须保持 `concurrency.group: release-main` 和 `cancel-in-progress: false`，让连续 push 到 `main` 的发布任务串行排队，并避免取消已经进入 publish / post-publish verification 的任务。

不要绕过 `pnpm run verify` 直接发布。不要在 trusted publishing 流程中依赖长期 `NPM_TOKEN`。

发布 workflow 会在新版本产生后自动执行 post-publish verifier，确认 GitHub Release、三个 npm 包版本、npm latest dist-tag、registry tarball integrity 和 npm provenance attestations 都已经公开可见；没有新 tag 的 main 提交会跳过该步骤，避免拿旧版本重复验证。维护者也可以在本地用同一命令复核。该命令会创建一个临时 consumer，从 npm 安装同版本的三包，并执行 package-lock tarball resolved/integrity 对齐、runtime import smoke、root/subpath TypeScript public declarations 编译、published package manifests 版本和内部依赖检查、published package size budgets 检查、published package npm metadata 检查、published package description metadata 检查、published package author metadata 检查、published package discoverability metadata 检查、published package module metadata 检查、published package engine metadata 检查、published package license artifacts 检查、published package manifest entry targets 检查、published CLI product boundary 检查、published SDK browser export conditions 检查、published package file scope 检查、published package READMEs 安装和 import 示例检查、`SessionOptions` 采样/上下文/thinking/token budget 字段编译、browser-safe `core` 声明边界检查、SDK browser bundle smoke 与 `@blade-ai/agent` browser bundle smoke：

```bash
pnpm run verify:published -- --version 1.2.3
```

## Release-ready 判断

一次改动可以进入 release 队列时，应满足：

- roadmap 对应状态已更新。
- 相关文档已更新，且 `pnpm run docs:build` 通过。
- 新行为有 RED -> GREEN 记录，测试覆盖了 public API 或 package boundary。
- `pnpm run verify` 通过。
- 如果涉及真实 provider/runtime 行为，`pnpm run test:live:glm` 已手动通过或明确记录未跑原因。
- 如果涉及 session runtime、kernel adapter、model config 或 stream 行为，`pnpm run test:live:session-glm` 已手动通过或明确记录未跑原因。
- 如果涉及发版配置，`pnpm run release:dry` 已手动通过或明确记录未跑原因。
- 工作区干净，commit message 能说明变更类型和边界。
