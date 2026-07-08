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
| Package boundaries | `pnpm run verify:boundaries` | 确保 `@blade-ai/agent` 不引入 Node-local runtime、MCP、filesystem、provider SDK 或 session SDK；三包源码相对 import/export 必须带显式 ESM 运行时文件扩展；三包 manifest 不暴露 CLI product capability，并保持 manifest root entry fields、package metadata export、exact package metadata export shape、manifest target extension checks、source manifest target source-file rejection, relativity, containment, and existence checks、public export subpath shape checks、types-first export condition order、browser-before-import export condition order 和 public export condition allowlist |
| Docs build | `pnpm run docs:build` | 确保 VitePress 文档可构建 |
| Entrypoints | `pnpm run verify:entrypoints` | 检查 root、server、session、local、core、tools、browser 入口和 browser-safe 约束 |
| Package smoke | `pnpm run verify:packages` | pack 三个 npm 包，检查 packed package file scope、TypeScript artifact scope、package artifact allowlist、packed package manifest hygiene、packed package dependency-version gate、package lifecycle script gate、packed package npm metadata、packed package repository directory metadata、packed package description metadata、packed package author metadata、packed package discoverability metadata、packed package module metadata、packed package engine metadata、packed package license artifacts、packed package manifest entry targets、exact package metadata export shape、manifest target extension checks、manifest target existence checks、runtime external dependency declaration checks、runtime relative import resolution checks、declaration relative reference resolution checks、declaration external dependency declaration checks、public export subpath shape checks、root export manifest contracts、types-first export condition order、browser-before-import export condition order、public export condition allowlist、packed CLI product boundary 和 packed SDK browser export conditions；packed README 与 package README 完全一致，packed LICENSE 与根 LICENSE 完全一致；安装到临时 consumer，import 公共入口，type-check `SessionOptions` 采样/上下文/thinking/token budget 字段，并检查 browser-safe `core` 和 root 声明不暴露 server/local API 或 provider-specific helper |
| Unit tests | `pnpm run test:unit` | 覆盖 provider、agent kernel、session runtime、tools、hooks、observability、权限和 token budget |
| Workspace package tests | `pnpm run test:packages` | 直接在 `packages/ai`、`packages/agent`、`packages/agent-sdk` 包目录运行 package-local tests；三包都不允许 no-tests 通过，确保 provider adapter、runtime-independent kernel、agent AsyncEventQueue behavior、agent assistant message projection behavior、agent loop decision behavior、agent no-tool branch predicate behavior、agent no-tool continue predicate behavior、agent no-tool content projection behavior、agent effective max-turn projection behavior、agent turn-limit gate predicate behavior、agent loop clock behavior、agent loop result builder behavior、agent tool-exit final message projection behavior、agent tool-exit decision behavior、agent turn-state projection behavior、agent loop lifecycle event builder behavior、agent response event projection behavior、agent token usage projection behavior、agent token usage event builder behavior、agent token budget decision behavior、agent token usage tracker behavior、agent turn counter behavior、agent tool message projection behavior、agent loop tool-injected message projection behavior、agent tool result content projection behavior、agent tool result tracker behavior、agent tool result event builder behavior、agent tool start event projection behavior、agent recovery attempt tracker behavior、agent recovery event projection behavior、agent model fallback event builder behavior、agent tool-injected message projection behavior、agent tool execution planning behavior、agent function tool-call selection behavior、agent tool-call parameter repair behavior、agent tool-update event projection、session-first facade、browser stub、`allowedTools: []` tool filtering、tools entry authoring/catalog facade behavior、permission entry facade behavior、subagents entry facade behavior、local entry adapter facade behavior、local MCP facade behavior、local memory facade behavior、local memory tools facade behavior、local sandbox facade behavior、observability trace manager、trace recorder behavior、session trace manager behavior、package-local session instance behavior、default session factory behavior、session lifecycle factory behavior、session content helper behavior、session config builder behavior、session pending turn buffer behavior、session lifecycle state behavior、session turn abort controller behavior、session turn controller behavior、session store JSONL reconstruction/fork behavior、kernel model resolution、kernel model resolver provider defaults、kernel trace finalization、kernel trace port usage accounting、agent runtime dependency wiring、kernel port wiring、kernel factory composition、runtime agent-kernel resolved/operations wiring、kernel stream bridge turn adaptation、kernel stream event projection、runtime kernel turn stream trace/task hook handling、runtime turn trace/kernel-stream operation bundling、runtime instance shell behavior、package-local runtime factory behavior、package-local kernel runtime factory behavior、default kernel runtime factory behavior、prompt result accumulation、runtime context storage/cwd helpers、runtime workspace turn projection、runtime control state updates、runtime hook initialization/trace collector scoping、runtime hook/permission guard operations、runtime permission hook input mutation/fallback behavior、runtime MCP capability projection、runtime MCP server config/registration/lifecycle helpers、runtime MCP tool source/refresh helpers、runtime MCP capability/server/tool refresh operation bundling、runtime tool registration/custom/builtin source metadata、runtime tool execution update/effect sequencing、root tool-call compatibility wrapper delegation、single-turn runtime bridge delegation、stream chat response collection/fallback behavior、streaming tool execution dispatch/fallback/epoch/cascade behavior、runtime tool operation bundling、runtime initial state derivation、runtime bootstrap composition、runtime session lifecycle create/load/hooks/close behavior、runtime session operation/workspace turn bundling、runtime fork materialization/capability errors、runtime capability startup ordering、runtime connection/MCP lifecycle operation bundling、runtime subagent definition mapping/initialization、runtime session capability subagent/fork operations、runtime noop port fallback behavior、runtime port-field projection、execution pipeline wiring、runtime execution wiring、runtime kernel composition 和后续 package-local runtime slices 都有包内测试落点 |
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

`pnpm run verify` 会先执行无 token 的静态 release gate，校验 semantic-release 配置、root private orchestrator 发布安全、三包 publish metadata、publishable source package version placeholders、source package LICENSE artifacts、`publishConfig.provenance: true`、CI workflow 的 `contents: read` 最小权限、CI workflow trigger / runner / timeout / checkout / cache、docs workflow 的 GitHub Pages 最小权限、docs workflow trigger / concurrency / deploy job、docs workflow toolchain pins、`docs/.vitepress/dist` artifact path、release workflow 的精确发布权限、release workflow trigger / runner / timeout / checkout / cache、release workflow 的 verify-before-release 顺序，以及 OIDC trusted publishing 设置：

```bash
pnpm run verify:release
```

所有 publishable source package 的 `version` 必须保持 `0.0.0` placeholder。所有 workspace manifest 的 direct dependencies 必须使用 exact versions；源码里的内部 `@blade-ai/*` workspace 依赖可以保持 `workspace:*`，发布前会被 release prepare 步骤改成同一个 concrete version。npm-facing manifest hygiene 要求 source package manifests、packed tarball manifests、release prepare 产物和 post-publish 安装产物都不能包含 `private` 或 `devDependencies`，避免把源码仓库开发元数据带进 npm 包。source package LICENSE 与根 LICENSE 完全一致；packed package dependency-version gate 会拒绝 packed tarball manifest 里的外部依赖 range 或 `0.0.0` placeholder，也会拒绝内部 `@blade-ai/*` 依赖 range；内部依赖只能是本地 pack 阶段的 `0.0.0` 或 concrete exact version，避免 npm 包在真正发布前漏出不稳定依赖声明。package lifecycle script gate 还会拒绝 `preinstall`、`install`、`postinstall`、`prepare`、`prepublish` 和 `prepublishOnly`，确保发布包 manifest 不引入自动执行脚本。

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
5. 对比发布前后的最新 `v*` tag；只有 semantic-release 创建新 tag 时，才运行 `pnpm run verify:published -- --version <tag>` 做 post-publish GitHub Release / npm / npm latest dist-tag / registry tarball integrity / npm provenance attestations / 临时 consumer / published package manifests / npm-facing manifest hygiene / published package dependency-version gate / package lifecycle script gate / published package size budgets / published package npm metadata / published package repository directory metadata / published package description metadata / published package author metadata / published package discoverability metadata / published package module metadata / published package engine metadata / published package license artifacts / published package manifest entry targets / manifest target extension checks / manifest target existence checks / runtime external dependency declaration checks / runtime relative import resolution checks / declaration relative reference resolution checks / declaration external dependency declaration checks / public export subpath shape checks / root export manifest contracts / types-first export condition order / browser-before-import export condition order / public export condition allowlist / published CLI product boundary / published SDK browser export conditions / published package file scope / TypeScript artifact scope / package artifact allowlist / published package READMEs / browser-safe core 声明边界 / SDK browser bundle smoke / `@blade-ai/agent` browser bundle smoke 校验；published README 与 package README 完全一致。发布前的 `pnpm run verify:packages` 还会检查 packed package size budgets、packed package file scope、TypeScript artifact scope、package artifact allowlist、packed package manifest hygiene、packed package dependency-version gate、package lifecycle script gate、packed package READMEs、packed package license artifacts、manifest target existence checks、runtime external dependency declaration checks、runtime relative import resolution checks、declaration relative reference resolution checks 和 declaration external dependency declaration checks，确认 tarball manifest 不包含 `private` 或 `devDependencies`，外部依赖不包含 range 或 `0.0.0` placeholder，内部依赖只能是本地 pack 阶段的 `0.0.0` 或 concrete exact version，也不声明 npm lifecycle scripts，tarball 体积维持在预算内、不包含 `package/src`、嵌套 `/src/` 源码、TypeScript 源文件或 `tsconfig` / `tsup.config` 构建配置，并且只发布 `package.json`、`README.md`、`LICENSE`、`dist/**` 和 `@blade-ai/agent-sdk` 的 `vendor/ripgrep/**` artifact，`README.md` 保留包名、直接安装命令和最小 import 示例且 packed README 与 package README 完全一致，并且 `LICENSE` 保留 MIT 授权文本且 LICENSE 与根 LICENSE 完全一致。

release workflow 必须保持 `contents: write`、`issues: write`、`pull-requests: write` 和 `id-token: write` 这组精确权限；不要增加不需要的 `actions`、`packages` 或 OIDC 之外的额外写权限。它还必须保持 main 分支 push 和 manual `workflow_dispatch` 触发、`ubuntu-latest` runner、20 分钟超时、`actions/checkout@v5`、完整 git history checkout、Node `22.14`、pnpm cache、`concurrency.group: release-main` 和 `cancel-in-progress: false`，让连续 push 到 `main` 的发布任务串行排队，并避免取消已经进入 publish / post-publish verification 的任务。

CI workflow 必须显式保持 `permissions: { contents: read }`，普通验证任务不需要写入仓库、issues、pull requests 或 OIDC token。它还必须保持 main / master / refactor / codex 分支和 pull request 触发、`ubuntu-latest` runner、20 分钟超时、`actions/checkout@v5`、Node `22`、`pnpm/action-setup` `11.7.0`、pnpm cache、`pnpm install --frozen-lockfile --ignore-scripts` 和完整 `pnpm run verify`，让普通 PR 与分支验证持续覆盖生产发布前的同一条质量链路。

docs workflow 必须显式保持 `permissions: { contents: read, pages: write, id-token: write }`，只允许 GitHub Pages artifact 部署所需权限。它还必须保持 main 分支 docs-only push paths、manual `workflow_dispatch`、`concurrency.group: pages`、`cancel-in-progress: false`、Node `22`、`pnpm/action-setup` `11.7.0`、`pnpm install --frozen-lockfile --ignore-scripts`、`pnpm run docs:build`、`docs/.vitepress/dist` artifact path，以及依赖 build job 的 `actions/deploy-pages@v4` deploy job，避免文档部署链路绕开发版工具链、上传错误目录或并发取消正在发布的 Pages artifact。

不要绕过 `pnpm run verify` 直接发布。不要在 trusted publishing 流程中依赖长期 `NPM_TOKEN`。

发布 workflow 会在新版本产生后自动执行 post-publish verifier，确认 GitHub Release、三个 npm 包版本、npm latest dist-tag、registry tarball integrity 和 npm provenance attestations 都已经公开可见；没有新 tag 的 main 提交会跳过该步骤，避免拿旧版本重复验证。维护者也可以在本地用同一命令复核。该命令会创建一个临时 consumer，从 npm 安装同版本的三包，并用 exact `typescript` / `esbuild` 版本执行 post-publish temporary consumer toolchain pin gate，再执行 package-lock tarball resolved/integrity 对齐、runtime import smoke、root/subpath TypeScript public declarations 编译、published package manifests 版本和内部依赖检查、npm-facing manifest hygiene 检查、published package dependency-version gate 检查、published package size budgets 检查、published package npm metadata 检查、published package repository directory metadata 检查、published package description metadata 检查、published package author metadata 检查、published package discoverability metadata 检查、published package module metadata 检查、published package engine metadata 检查、published package license artifacts 检查、published package manifest entry targets 检查、manifest target extension checks、manifest target existence checks、runtime external dependency declaration checks、runtime relative import resolution checks、declaration relative reference resolution checks、declaration external dependency declaration checks、public export subpath shape checks、root export manifest contracts 检查、types-first export condition order 检查、browser-before-import export condition order 检查、public export condition allowlist 检查、published CLI product boundary 检查、published SDK browser export conditions 检查、published package file scope 检查、TypeScript artifact scope 检查、package artifact allowlist 检查、published package READMEs 安装和 import 示例检查、`SessionOptions` 采样/上下文/thinking/token budget 字段编译、browser-safe `core` 声明边界检查、SDK browser bundle smoke 与 `@blade-ai/agent` browser bundle smoke：

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
