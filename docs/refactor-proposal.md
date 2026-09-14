# Blade Agent SDK 重构方案

> 基于对 v7.4.9 全量代码（83,000 行 / 344 个源文件 / 11 个入口点）的深度 Review  
> 不考虑向后兼容性。目标：一个有 TypeScript 经验的开发者 5 分钟内跑出第一个有意义的 agent。

---

## 诊断摘要

| 指标 | 现状 |
|------|------|
| 入口点数量 | 11 个，用户需读文档才能选择 |
| `SessionOptions` 字段 | 40+ 个，全部平铺 |
| 权限 API | 3 套并行（`permissionMode` / `permissionHandler` / `canUseTool`） |
| 钩子系统 | 2 套独立且无桥接（inline callbacks / shell commands） |
| `Session.ts` 行数 | 2,666 行（全项目最大文件，上帝对象） |
| DeepSeek 工具函数 | 1,087 行挂在主包上，无法 tree-shake |

---

## 第一章：用户视角问题

### 🔴 入口选择成了第一道门槛

`/node` 与 `/server` 的选择依据是底层机制差异，而非用户意图。

```ts
// 现状——用户必须先理解内部机制
import { createSession } from '@blade-ai/agent-sdk/node';
import { createSession } from '@blade-ai/agent-sdk/server';

// 应该是——通过 profile 表达意图
import { createAgent } from '@blade-ai/agent-sdk';
const agent = createAgent({ profile: 'local', model: 'gpt-4o' });
```

### 🔴 SessionOptions 无分层，40+ 字段等价呈现

`model`、`temperature` 与 `durableEventStore`、`executionLease` 混在同一层级。新手不知道最少需要哪几个，老手也容易遗漏字段语义冲突。

### 🔴 没有"最小可用 API"的入口

理论上"总结一篇文章"需要 10 行代码，但目前需要：
1. 理解 `/node` vs `/server` 的区别
2. 理解 `SessionOptions` 里哪些字段是必需的
3. 理解 provider 配置格式
4. 理解如何消费流式事件

没有"先跑起来，再学原理"的路径。

### 🟡 tool 定义的 AsyncGenerator 对初学者不直觉

`yield`（progress）和 `return`（result）语义差异没有提示，大量用户只需要简单 async function。

```ts
// 现状——仅支持 AsyncGenerator
async *execute({ city }) {
  yield { kind: 'progress', message: '...' };
  return { status: 'success', model: city };
}
```

### 🟡 三套并行的权限 API

`canUseTool` 注释明确写着 "Legacy callback"，但仍出现在主接口里。

### 🟡 流式事件无高层消费 API

17 种事件全靠手写 `if (event.type === 'content')`，没有任何辅助函数。

### 🟡 两套独立的钩子系统（重要发现）

| 系统 | 位置 | 触发方式 | 事件数量 |
|------|------|----------|----------|
| Inline hooks | `SessionOptions.hooks` | TypeScript callback | 8 种 |
| Shell hooks | `HookConfig`（CLI 配置） | 子进程执行 | 20+ 种 |

两者完全独立，无桥接。用户极易混淆，"为什么我写在 `hooks` 里的没有触发 `Stop` 事件" 是典型困惑场景。

### 🟢 错误体系需要了解内部层级才能可靠捕获

9 个错误类，层级关系埋在代码里，没有文档说明如何 "捕获所有 SDK 错误"。

---

## 第二章：架构问题

### 🔴 Session.ts 是上帝对象（2,666 行）

同时承担：会话生命周期 / durable event 写入 / 输入队列 / agent loop 调用 / 流式事件分发 / checkpoint 协调 / worker handoff。

### 🟡 主入口 re-export 阻断 tree-shaking

`/node` → `export * from '../index.js'` → re-export 几乎所有模块，包括 DeepSeek 批量 API（1,087 行）。用户只用 `createSession` 也无法 shake 掉这些代码。

### 🟡 ToolRegistry 与 ToolCatalog 职责重叠

两者都处理 tool 的存储和查询，都从 `/tools` 入口导出，边界不清。`ToolCatalog` 是更高层抽象（加了 source/trust 元数据），但这个关系在公开 API 里不可见。

### 🟡 Durable 配置与基础配置混在同一层

`durableEventStore`、`durableStoreTimeoutMs`、`executionLease` 是生产级容灾机制，对 95% 的用户是干扰。

### 🟡 Agent 类非公开但 AgentRuntimeDeps 有价值

`Agent.ts`（834 行）不从任何入口导出——这是好的设计决策。但 `AgentRuntimeDeps` 接口对需要自定义的高级用户很有价值，却没有设计成可扩展的公开 API。

### 🟡 AgentEvent（32 种）与 SessionStreamEvent（17 种）并存

内部与公开各有一套流事件联合类型，转换逻辑散落在 `Session.ts` 里。

### 🟡 Skills 仅支持文件系统发现

`discoverSkills()` 只能从本地 `~/.blade/skills/` 和 `.blade/skills/` 读取，无法通过 `SessionOptions` 传入数据形式的 Skills。

---

## 第三章：战略风险

### 🔴 工具生态缺乏标准化

没有第三方 tool 包的命名约定（类似 `babel-plugin-*`）或 `peerDependencies` 声明规范，社区 tool 包质量和接口无法对齐。

### 🟡 流式 API 未为框架集成预留设计

`AsyncIterable<SessionStreamEvent>` 在 React 18+、Vue Composition API、Svelte 里都需要额外适配层，没有官方适配，也没有定义可被第三方适配的稳定协议。

### 🟡 SessionRunner 是最佳扩展点，但文档几乎为零

`SessionRunner` 接口是本生产部署的主要自定义缝隙，`SdkSessionRunner` 为默认，用户可完全替换。这是当前设计里最优秀的扩展机制，但 README 里几乎没有提及。

---

## 第四章：重构设计

### 4.1 单一入口 + 三层选项

```ts
import { createAgent, defineTool } from '@blade-ai/agent-sdk';

const agent = createAgent({
  // 层一：必需（2-3 个字段）
  model: 'gpt-4o',
  apiKey: process.env.OPENAI_API_KEY,

  // 层二：常用（10 个以内）
  tools: [myTool],
  systemPrompt: 'You are a helpful assistant.',
  filesystem: { roots: [process.cwd()] },  // 自动选 node profile

  // 层三：高级（其余全部进 advanced 命名空间）
  advanced: {
    permission: 'accept-edits',
    tokenBudget: { maxTokens: 100_000 },
    middleware: [loggingMiddleware],
    durableStore: pgStore,
    hooks: {
      'PreToolUse': [async (e) => ({ action: 'continue' })],
    },
  },
});
```

`/node` 和 `/server` 降级为框架集成者使用的低层 API，不再是用户的入口选择点。

### 4.2 Tool 定义支持简单路径

```ts
import { defineTool } from '@blade-ai/agent-sdk';
import { z } from 'zod';

// 简单路径（新增）：async function，返回结果
const weather = defineTool({
  name: 'GetWeather',
  description: 'Get weather for a city',
  parameters: z.object({ city: z.string() }),  // 支持 Zod，内部自动转 JSON Schema
  async execute({ city }) {
    return { weather: `${city}: clear, 25°C` };
  },
});

// 进阶路径（保留）：AsyncGenerator，支持进度
const heavyTool = defineTool({
  name: 'HeavyTask',
  parameters: z.object({ input: z.string() }),
  async *execute({ input }, { progress }) {
    await progress('Step 1/3...');
    return { result: input };
  },
});
```

### 4.3 流式事件高层消费 API

```ts
const response = await agent.send('Analyze this codebase');

// 辅助方法一：获取完整文本（最常用）
const text = await response.text();

// 辅助方法二：流式打印
for await (const chunk of response.textStream()) {
  process.stdout.write(chunk);
}

// 辅助方法三：监听特定事件
response
  .on('tool_use', (e) => console.log(`Tool: ${e.name}`))
  .on('error', (e) => console.error(e.message));

// 底层（保留）：完整事件流，面向需要完整控制的用户
for await (const event of response.stream()) {
  // 17 种原始 SessionStreamEvent
}
```

### 4.4 权限系统统一

```ts
// 现状：三套并行
permissionMode: PermissionMode.AcceptEdits,
permissionHandler: myHandler,        // 优先级高
canUseTool: legacyFn,                // 遗留，仅在无 permissionHandler 时生效
confirmationHandler: confirm,
confirmationHandlerFactory: factory,

// 重构后：一个字段，两种形式
permission: 'accept-edits',          // 预设字符串

// 或自定义函数
permission: async (req) => {
  return req.kind === 'read' ? 'allow' : await confirmDialog(req);
},
```

### 4.5 钩子系统澄清

两套钩子系统的目的不同，应在 API 设计和文档上明确区分：

| | 现状 | 重构后 |
|--|------|--------|
| **Inline hooks** | `SessionOptions.hooks` | `advanced.hooks`（TypeScript callback，8 种事件） |
| **Shell hooks** | `HookConfig`（CLI 配置文件） | 明确标注为"CLI 专用"，不在 `createAgent` 中出现 |

### 4.6 Session.ts 内部拆分

目标：将 2,666 行拆分为 5 个职责单一的模块。

| 新模块 | 职责 | 目标行数 |
|--------|------|----------|
| `AgentSession` | 面向用户的 ISession，仅暴露 send/stream/close | ~300 行 |
| `AgentLoop` | model ↔ tool 循环，不感知持久化（现已存在，强化边界） | ~400 行 |
| `SessionJournal` | 所有 durable event 写入 | ~300 行 |
| `InputInbox` | 输入队列与 steering 逻辑（现已存在） | 保持 |
| `StreamBroadcaster` | AgentEvent（32 种）→ SessionStreamEvent（17 种）转换与分发 | ~200 行 |

### 4.7 入口点精简：11 个 → 4 个

| 入口 | 目标用户 | 包含 |
|------|----------|------|
| `@blade-ai/agent-sdk` | 所有用户的默认入口 | `createAgent`, `defineTool`, 所有类型 |
| `/browser` | 浏览器端消费者 | `AgentClient`, 协议类型 |
| `/server/infra` | 部署 AgentServer 的后端开发者 | `AgentServer`, `AgentWorker`, `RuntimeStore` |
| `/advanced` | 需要底层控制的集成者 | `SessionRunner`, `EffectDispatcher`, `AgentRuntimeDeps`, 所有内部类型 |

废除：`/core`（合并到主入口）、`/model`（类型直接从主入口导出）、`/session`（合并到 `/advanced`）、`/middleware`（从主入口导出）、`/tools`（从主入口导出）、`/protocol`（从 `/browser` 导出）。

### 4.8 Skills 支持数据形式注入

```ts
// 现状：仅文件系统
// ~/.blade/skills/my-skill/SKILL.md

// 新增：SessionOptions 直接传入
advanced: {
  skills: [
    {
      name: 'my-skill',
      description: 'Helps with X',
      content: '## Instructions\n...',
      allowedTools: ['Bash', 'Read'],
    },
  ],
}
```

### 4.9 SessionRunner 作为一等扩展点

将 `SessionRunner` 接口从 `/server` 迁移到 `/advanced`，补充完整的"如何自定义生产执行逻辑"文档。示范 `SdkSessionRunner` → `CustomSessionRunner` 的继承和覆盖模式。

---

## 第五章：迁移路径

### Phase 1（立即，约 8–11 天）

**目标：不改内部，只改接触面**

**状态：已完成（2026-09-14，随 v7.4.10 发布）**

- [x] 实现 `createAgent()`，内部代理到现有 `createSession()`
- [x] 实现 `AgentOptions` 三层结构（必需 / 常用 / `advanced`）
- [x] `defineTool` 支持 async function + Zod schema（内部自动包装为 generator）
- [x] 废除 `canUseTool`，统一权限接口为单一 `permission` 字段
- [x] 明确区分 inline hooks 与 shell hooks 的 API 位置
- [x] 更新 README 为"5 分钟快速开始"格式

验收覆盖 lint、类型检查、完整 Vitest、构建、入口和最小安装校验，以及
DeepSeek 官方 API 的真实端到端调用。Phase 1 smoke 在无脚本级重试条件下连续
3 次通过，每次均验证 `createAgent`、Zod 参数、async tool、权限回调、
`tool_use` / `tool_result` 事件和最终模型回复。

### Phase 2（次周，约 5–7 天）

**目标：改善流式体验 + 精简入口**

**状态：已完成（2026-09-14）**

- [x] Response 对象增加 `.text()` / `.textStream()` / `.on()` 方法
- [x] 入口点从 11 个精简到 4 个，修复所有 import 路径
- [x] 运行 `pnpm run verify:entrypoints` 确认构建产物正确
- [x] Skills 支持通过 `advanced.skills` 传入数据形式

正式入口为根入口、`/browser`、`/server/infra` 和 `/advanced`。旧入口在
Phase 3 前继续作为 deprecated compatibility alias；PostgreSQL 与 OTel adapter
保留独立 subpath，以免 canonical 入口强制加载可选 peer dependency。

验收覆盖 Response 单次执行与多视图重放、Session 间 Skill 隔离、数据 Skill
实际激活、browser stub、旧入口等价性、构建产物、无可选 peer 的最小安装，
以及 DeepSeek 官方 API 的真实端到端调用。Phase 2 live test 在无框架重试
条件下连续 3 次通过；每次均验证模型调用数据 `Skill`，并由 `.on()`、`.text()`、
`.textStream()` 和 `.stream()` 重放同一次执行。

### Phase 3（三周后，约 11–15 天）

**目标：内部结构重构**

- 拆分 `Session.ts`，引入 `StreamBroadcaster`
- 目标：`Session.ts` 降至 800 行以下
- `SessionRunner` 迁移至 `/advanced`，补充文档
- 定义 `blade-tool-*` 社区命名约定
- 前提：Phase 1+2 完成后的集成测试覆盖率需达到合理水平（建议 ≥60% 关键路径）

---

## 不建议做的事

**不要把入口精简和内部重构放在同一个 PR。**  
接触面重构和内部结构重构应该是两个独立的工作流，混在一起会让 review 困难，也会让 git bisect 在出问题时失效。

**不要在 Phase 3 之前大改 Session.ts。**  
等集成测试覆盖率足够高时再动它。现在 `vitest run` 有约 199 个测试文件，但关键路径的 E2E 覆盖仍需补充。

**不要让框架 adapter 影响 SDK 核心设计。**  
React/Vue adapter 应建立在 `/advanced` 入口的稳定低层 API 之上。`useAgent()` 之类的东西放进独立的 `@blade-ai/agent-sdk-react` 包，SDK 核心不感知框架。

**不要在 Phase 1/2 里删除旧入口。**  
旧入口（`/node`、`/server`）作为 `/advanced` 的别名保留到 Phase 3 完成后再移除，避免中间状态破坏 examples 和 scripts 里的引用。

---

## 关键决策说明

Phase 1 和 Phase 2 的所有改动对内部实现是**非破坏性的**——只增加新 API 层，不改动 `Session.ts` 和 `AgentLoop.ts`。这样可以在不冒险动内部的前提下，立刻改善用户体验，同时为 Phase 3 的大改积累测试覆盖。

`SessionRunner` 接口是当前设计里最优秀的扩展机制，生产部署的权威分界线清晰：SDK 拥有 `RuntimeStore` / `WorkerRuntime` / `SdkSessionRunner` / `EffectDispatcher`，用户实现 `RepositorySessionRunner` 和领域特定的执行逻辑。这个边界应该在重构中被强化而非打破。
