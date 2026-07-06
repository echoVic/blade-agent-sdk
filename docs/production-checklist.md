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
| Package boundaries | `pnpm run verify:boundaries` | 确保 `@blade-ai/agent` 不引入 Node-local runtime、MCP、filesystem、provider SDK 或 session SDK |
| Docs build | `pnpm run docs:build` | 确保 VitePress 文档可构建 |
| Entrypoints | `pnpm run verify:entrypoints` | 检查 root、server、session、local、core、tools、browser 入口和 browser-safe 约束 |
| Package smoke | `pnpm run verify:packages` | pack 三个 npm 包，安装到临时 consumer，import 公共入口，type-check `SessionOptions` 采样/上下文/thinking/token budget 字段，并检查 browser-safe `core` 声明不暴露 server/local API |
| Unit tests | `pnpm run test:unit` | 覆盖 provider、agent kernel、session runtime、tools、hooks、observability、权限和 token budget |
| Integration tests | `pnpm run test:integration` | 有 `INTEGRATION_API_KEY` / `INTEGRATION_BASE_URL` 时跑真实集成；缺少时按测试策略跳过 |

## Package Boundary

发布前确认三层职责没有倒灌：

- `@blade-ai/ai` 只负责 model/provider 协议、stream、usage、provider options 和 provider adapters。
- `@blade-ai/agent` 保持 runtime-independent，只依赖端口和协议，不直接依赖 Node-only API、MCP SDK、provider SDK、本地工具、filesystem、shell、sandbox 或 `@blade-ai/agent-sdk`。
- `@blade-ai/agent-sdk` 作为产品 SDK 组合 server/local adapters，并保持 session-first 入口：

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

`pnpm run verify` 会先执行无 token 的静态 release gate，校验 semantic-release 配置、三包 publish metadata、`publishConfig.provenance: true`、release workflow 的 verify-before-release 顺序，以及 OIDC trusted publishing 设置：

```bash
pnpm run verify:release
```

发版前还可以用 dry-run 检查 semantic-release 的版本推导、release notes 和远端权限：

```bash
pnpm run release:dry
```

dry-run 不发布 npm 包。它通常需要 GitHub token 环境，适合维护者本机或安全的 CI 环境。

## Main Branch Publishing

推送到 `main` 后，`.github/workflows/release.yml` 会执行：

1. 安装依赖。
2. 运行 `pnpm run verify`。
3. 运行 `pnpm exec semantic-release`。
4. 使用 GitHub OIDC trusted publishing 和 npm provenance 发布 `@blade-ai/ai`、`@blade-ai/agent`、`@blade-ai/agent-sdk`。
5. 对比发布前后的最新 `v*` tag；只有 semantic-release 创建新 tag 时，才运行 `pnpm run verify:published -- --version <tag>` 做 post-publish GitHub Release / npm / npm provenance attestations / 临时 consumer / browser-safe core 声明边界 / browser bundle smoke 校验。

不要绕过 `pnpm run verify` 直接发布。不要在 trusted publishing 流程中依赖长期 `NPM_TOKEN`。

发布 workflow 会在新版本产生后自动执行 post-publish verifier，确认 GitHub Release、三个 npm 包版本和 npm provenance attestations 都已经公开可见；没有新 tag 的 main 提交会跳过该步骤，避免拿旧版本重复验证。维护者也可以在本地用同一命令复核。该命令会创建一个临时 consumer，从 npm 安装同版本的三包，并执行 runtime import smoke、root/subpath TypeScript public declarations 编译、`SessionOptions` 采样/上下文/thinking/token budget 字段编译、browser-safe `core` 声明边界检查与 browser bundle smoke：

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
