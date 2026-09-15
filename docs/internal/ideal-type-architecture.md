# Blade Agent SDK 类型所有权架构 RFC

> 状态：已实施（2026-09-14；公开 API 兼容性清理由 v8 承担）
> 基线：v7.4.11 + Session Phase 3
> 目标版本：v8
> 本文是类型所有权、依赖方向和迁移门禁的单一事实源。

---

## 1. 决策摘要

Blade Agent SDK 不建立集中式“新类型系统”，也不把现有类型批量搬入
`src/types/`。类型继续与拥有其语义和运行时验证的模块共置，通过公开 barrel
形成稳定 contract。

类型按所有权分为五类：

1. **Wire contract**：可序列化 DTO、版本、schema 和 parser。
2. **Public API contract**：普通应用使用的 Agent、Response、Tool authoring API。
3. **Advanced SPI contract**：部署者和框架集成者实现的稳定扩展端口。
4. **Domain value contract**：跨模块共享、无运行时依赖的 ID、JSON 和值对象。
5. **Internal runtime type**：状态机、执行上下文和具体实现依赖，不从包入口导出。

依赖方向为：

```text
Domain values
  ↑             ↑
Public API    Wire contract
  ↑             ↑
Advanced SPI ───┘
  ↑
Internal runtime
```

Wire contract 是正交的序列化边界，不是领域模型的“上层”。Internal runtime
可以依赖公开 contract；公开 contract 不得反向依赖具体 runtime class。
当前跨 owner 复用的 wire-safe 公开 contract 只有
`agent/UserMessageContent.ts::UserMessageContent` 和
`session/types.ts::SessionStreamEvent`。它们由原 owner 与 protocol 共同治理：
任何 union member、字段或枚举值变化都按 protocol schema 变更处理，不能只作为
普通 SDK 类型变更发布。protocol 只在 schema parity 测试覆盖下复用它们。

当前只实现 protocol v1。`SessionStreamEvent` union 和
`sessionStreamEventSchema` 视为 v1 冻结快照，client/server 的
`protocolVersion` 不一致时直接拒绝，不宣称已经支持多版本协商。

引入 v2 必须先提交独立 protocol RFC，并在 protocol owner 中创建版本化
`AgentWireStreamEventV1/V2` 与穷举 `toWireEventV1/V2` adapter。每个 adapter
必须对当前全部 Session event 明确执行 map、版本化降级或 unsupported error，
禁止 default 忽略和强制断言。v1 schema/adapter 在迁移窗口继续保留；bootstrap
协商格式、支持版本集合、选择规则和无交集错误也由该 RFC 定义。

允许依赖矩阵：

| Owner | 可依赖 |
|-------|--------|
| Domain values | 仅标准库与同层值类型 |
| Wire contract | Domain values、wire-local schema/parser、显式标记为 wire-safe 的公开值 contract |
| Public API | Domain values、公开的 module-local contract |
| Advanced SPI | Domain values、Public API、必要的 Wire contract、稳定的 Server Infra port（仅 type-only） |
| Internal runtime | 上述所有 contract 与具体 adapter |

箭头表示“下方实现依赖上方 contract”。Wire 与 Public API 之间不直接复用配置
对象，只允许复用已经明确声明为 wire-safe 的值类型。

---

## 2. 不变量

### 2.1 Wire 安全

- Wire payload 只能包含 JSON value、版本化标识和经过 parser 验证的 DTO。
- Wire command 不携带 API key、Provider 实例、函数、middleware、Store 或
  execution handle。
- `session.create` 只接受客户端 metadata。Provider、credential、tool 和 Store
  由认证后的服务端 `resolveSessionOptions` 解析。
- 每个 wire 版本一旦发布即 immutable。当前 strict schema 拒绝未知字段，因此
  新增字段必须发布新 protocol version，不能原地扩展 v1。当前实现只接受精确 v1；
  多版本并存和协商必须先满足上一节要求。
- TypeScript 类型和 Zod schema 必须成对维护。Parity 通过
  `z.ZodType<Contract, z.ZodTypeDef, unknown>` 编译约束、合法 fixture 和未知字段
  拒绝测试共同验证，不声称在运行时反射 TypeScript 类型。

### 2.2 Durable 所有权

- transcript projection、transcript event、durable journal、subagent repository、
  runtime store 和 execution lease 保持独立端口。
- 不引入同时代表上述能力的单一 `DurableStore`。
- 只有启用 durable execution lease 的 Session 才进入 fenced mode。
- fence assertion 不是原子提交保证。fenced mode 中，模型请求和所有
  `sideEffect !== 'pure'` 的工具在副作用开始前 assertion，并先持久化 started
  boundary；旧 executor 的终态提交仍必须再次验证 fence。`ToolKind` 只参与权限，
  不决定持久化或重放策略。
- 每个模型请求使用稳定 `ModelAttemptId`，每个工具执行使用稳定
  `ToolAttemptId`，每个 outbox effect 使用稳定 `effectId`。started/claim 与
  operation ID 的绑定必须在同一 Store 事务或 expected-head CAS 中唯一提交。
- 短事务型 durable append 通过 `runWithExecutionLease` 与 takeover 互斥。模型调用
  无法与本地 lease 原子化；crash 或 takeover 后未确认的 model outcome 必须进入
  reconciliation。
- 远程系统不能与本地 lease 原子提交。类型层必须保留稳定 `effectId`、
  `idempotencyKey`、`leaseId` 和 `fencingToken`，但本 RFC 不定义 effect claim、
  retry 或 reconciliation 状态转换。
- 非 fenced Session 保持现有进程内语义。纯读且不产生外部可观察状态的操作不要求
  lease。
- 类型重构不能改变 event schema、side-effect 字符串或恢复决策语义。

本 RFC 不重新定义 reconciliation 状态机。model/tool Request 的允许源状态、
command payload、expected-head CAS、幂等重放和终态冲突规则以
`src/session/events/schemas.ts`、`DurableSessionProjector`、
`DurableSessionRecoveryCoordinator` 及
`docs/durable-events.md` 为唯一事实源；runtime effect 的 claim/reconcile 规则以
`WorkerRuntimeStore`、`PostgresWorkerRuntime` 及 `docs/worker-runtime.md`
为唯一事实源。
任何状态机变化必须进入独立 durable RFC，不能夹带在类型所有权重构中。

### 2.3 事件边界

- `AgentEvent` 是 Agent loop 的内部事件。
- `SessionStreamEvent` 是公开 SDK 事件。
- `AgentServerEvent` 是带 sequence、eventId 和 protocolVersion 的 wire envelope。
- 三者不互为类型别名。
- `AgentEvent` 到 `SessionStreamEvent` 只允许通过 `StreamBroadcaster` 的穷举映射。
- 禁止 `event as SessionStreamEvent` 和默认透传分支。

### 2.4 配置所有权

- 根入口只有一个公开配置名：`AgentOptions`。
- Agent loop 的内部运行参数命名为 `AgentRuntimeOptions`。
- `/advanced` 的 `SessionOptions` 是低层 Session contract，不与 `AgentOptions`
  合并；两者服务不同调用者。
- `AgentOptions.advanced` 负责把高级能力映射到 `SessionOptions`。
- server profile 不隐式读取 `process.env` 或本机 credential。

### 2.5 Tool 所有权

- `defineTool()` 是用户 authoring API。
- `Tool` 是编译后的 runtime contract。
- Tool authoring 只接受 TypeBox schema，并通过 `Type.Static` 推导 callback 参数。
- 同一个 schema 必须同时承担模型声明与运行时校验，禁止新增格式转换或
  advisory-only 旁路。
- `ToolResult` 保持 `status: 'success' | 'error'` discriminated union。
- `ToolKind` 只描述 readonly/write/execute 权限类别；network、subagent 等能力不能
  塞进同一枚举。
- `ToolSideEffect` 的持久化值保持 `pure`、`idempotent`、`non_idempotent`。
- 内置工具继续使用完整 `Tool` contract，不强制改写为轻量 `defineTool()`。

---

## 3. 模块所有权

### 3.1 通用值类型

`src/types/` 只保留真正跨域、无具体 runtime 实现依赖的基础 contract：

```text
src/types/
├── identifiers.ts   # branded IDs
├── json.ts          # JsonValue / JsonObject
├── constants.ts     # 跨模块稳定常量
├── permissions.ts   # permission value 与策略端口
└── logging.ts       # 无具体 logger 实现的结构化日志端口
```

禁止把仅由单个功能域拥有的类型搬进 `src/types/`，避免形成新的 god folder。

### 3.2 Agent public API

所有权：

```text
src/agent/createAgent.ts   # AgentOptions, Agent, createAgent
src/agent/AgentResponse.ts # AgentResponse 及 listener/event helper
src/agent/UserMessageContent.ts # wire-safe 用户输入
```

公开 contract：

```ts
export interface AgentOptions {
  model: string;
  apiKey: string;
  profile?: 'local' | 'server';
  provider?: ProviderType;
  baseUrl?: string;
  tools?: readonly SessionTool[];
  systemPrompt?: string;
  temperature?: number;
  maxOutputTokens?: number;
  maxTurns?: number;
  filesystem?: AgentFilesystemOptions;
  advanced?: AgentAdvancedOptions;
}

export interface Agent extends Omit<ISession, 'send' | 'stream'> {
  send(message: UserMessageContent, options?: SendOptions): Promise<AgentResponse>;
}
```

这里存在两个独立入口：

- `createAgent({ profile: 'server' })`：在当前服务端进程直接执行 Agent，
  `apiKey` 是该进程持有的 Provider credential。
- `AgentClient → AgentServer`：浏览器只发送 protocol DTO；AgentServer 在认证后
  通过 `resolveSessionOptions` 注入 Provider credential。

两条链路不互相调用，wire payload 永远不包含 credential。

映射规则由 `createAgent()` 单点实现：

1. `advanced` 先提供低层 Session 字段。
2. 根级 `model`、tools、prompt、temperature、token 和 turn 字段覆盖同名低层值；
   `Omit<SessionOptions, RootAgentOption>` 在类型层禁止冲突。
3. `advanced.connection` 先提供 Provider 附加字段，根级 `provider`、`apiKey` 和
   `baseUrl` 后写并具有更高优先级。
4. `filesystem` 在未显式指定 profile 时选择 local profile；其 roots/cwd 覆盖
   `advanced.defaultContext.capabilities.filesystem`，其他 capability 保留。
5. `advanced.hooks` 直接成为 Session inline hooks；不存在第二个根级 hooks 字段。
6. `advanced.permission` 最后编译为低层 permission handler/mode，并覆盖所有通过
   非类型调用混入的 legacy permission 字段。
7. 显式 `profile` 优先于自动 profile 推断。

内部 Agent 参数不得继续使用同名 `AgentOptions`：

```ts
export interface AgentRuntimeOptions {
  systemPrompt?: string;
  appendSystemPrompt?: string;
  permissions?: Partial<PermissionsConfig>;
  permissionMode?: PermissionMode;
  maxTurns?: number;
  toolWhitelist?: string[];
  toolSourcePolicy?: ToolCatalogSourcePolicy;
  modelId?: string;
  permissionHandler?: PermissionHandler;
  // 其余字段保持当前 runtime 语义
}
```

`AgentRuntimeOptions` 是内部实现类型，不从 root、browser 或 advanced 导出。

### 3.3 Agent 执行上下文

旧 `ChatContext` 改为按能力组合的内部类型。运行时对象保持扁平，避免为了类型美观
增加热路径对象分配：

```ts
export interface AgentConversationState {
  messages: ConversationMessage[];
  userId: string;
  sessionId: SessionId;
  snapshot?: ContextSnapshot;
}

export interface AgentExecutionControl {
  signal?: AbortSignal;
  confirmationHandler?: ConfirmationHandler;
  permissionMode?: PermissionMode;
  executionFence?: DurableExecutionFence;
  assertExecutionLease?: () => Promise<void>;
  runWithExecutionLease?: <T>(operation: () => Promise<T>) => Promise<T>;
}

export interface AgentExecutionServices {
  backgroundAgentManager?: IBackgroundAgentManager;
  systemPrompt?: string;
  subagentInfo?: SubagentInfoForContext;
  omitEnvironment?: boolean;
}

export type AgentExecutionContext =
  & AgentConversationState
  & AgentExecutionControl
  & AgentExecutionServices;
```

这些类型只属于 Agent runtime。Tool 通过自己的 `ExecutionContext` 获取能力，
不能直接依赖完整 Agent context。

### 3.4 Tool authoring 与 runtime

所有权：

```text
src/tools/types/tool.ts      # authoring/runtime tool contracts
src/tools/types/result.ts    # result/yield contracts
src/tools/types/execution.ts # runtime execution capability
src/tools/core/createTool.ts # compiler/adapter
```

Tool authoring 只接受 TypeBox schema：

```ts
export interface ToolDefinition<
  TSchema extends Type.TSchema = Type.TSchema,
  TData extends JsonValue = JsonValue,
> {
  parameters: TSchema;
  execute(
    params: Type.Static<TSchema>,
    context: ExecutionContext,
  ): ToolExecution<TData>;
}
```

`Type.Static<TSchema>` 提供 callback 参数类型；TypeBox 生成的同一个 JSON Schema
对象直接交给模型并由 `Schema.Compile()` 编译为 runtime validator。公开 API
不定义 codec，也不存在 Zod/JSON Schema 转换或 advisory-only 校验旁路。

异构 Session 工具集合通过一个明确命名的 erased contract 表达，而不是在
`SessionOptions` 里直接展开类型擦除细节。

```ts
type ErasedToolDefinition =
  & Omit<ToolDefinition<Type.TSchema, JsonValue>, 'execute'>
  & {
      execute(
        params: never,
        context: ExecutionContext,
      ): ToolExecution<JsonValue>;
    };
type SessionTool = ErasedToolDefinition | Tool;
```

完整转换链为：

```text
TypeBox TSchema
  → defineTool()
  → typed ToolDefinition
  → SessionTool boundary erases heterogeneous params
  → toolFromDefinition()
  → runtime Tool
  → ToolRegistry / ToolCatalog
```

`AgentOptions.tools` 和 `SessionOptions.tools` 接受 authoring definition 或已经编译的
`Tool`。`defineTool()`、`createTool()` 与 `toolFromDefinition()` 共享同一个 TypeBox
编译路径，错误参数不能进入 description、permission、behavior 或 execute callback。
MCP 客户端收到的 raw JSON Schema 是协议适配边界：它直接由 TypeBox 的 JSON Schema
validator 编译，不转换成另一种 authoring schema。Wire、durable 和 MCP SDK 自身的
Zod parser 不属于 Tool authoring API，继续由各自 owner 管理。

### 3.5 Session contract

`SessionOptions`、`ISession`、`SessionStreamEvent` 继续由 `src/session/types.ts`
拥有。它们是 `/advanced` 使用的低层 contract，不复制到 `src/types/api/`。

Session 内部状态机继续由以下模块拥有：

```text
AgentSession.ts
SessionState.ts
SessionLifecycle.ts
SessionRequestCoordinator.ts
SessionStreamRunner.ts
SessionDurability.ts
StreamBroadcaster.ts
```

这些内部实现类不从任何 package entrypoint 导出。

### 3.6 Protocol contract

所有权：

```text
src/protocol/types.ts
src/protocol/schemas.ts
src/protocol/index.ts
```

wire create command 保持：

```ts
type CreateSessionCommand = AgentCommandBase<
  'session.create',
  { readonly metadata?: JsonObject }
>;
```

浏览器入口导出 protocol types、schema/parser 和 `AgentClient`，不导出任何要求
Node runtime 的实现。

### 3.7 Advanced SPI

`/advanced` 只承载集成者可实现或组合的稳定端口与 Node adapters：

- `SessionRunner`
- `EffectDispatcher`
- `AgentRuntimeDeps`
- `ExecutionHost`
- local/server Session factories
- Node storage、sandbox、Skill 和 MCP adapters

`RuntimeStore`、`AgentServer` 和 `AgentWorker` 由 `/server/infra` 拥有。
`SessionRunnerContext.store` 对 `RuntimeStore`、route 和 claim contract 的依赖是
`/advanced` 与 `/server/infra` 之间唯一允许的 type-only bridge；不得由此引入
server runtime value 或形成运行时循环依赖。

标记为 internal 且允许自由变化的类型不得从 `/advanced` 或 `/server/infra`
导出。一旦类型进入任一 package entrypoint，就按公开 contract 进行 semver 管理。

---

## 4. 明确拒绝的设计

以下方案不进入实现：

1. **Wire command 携带 `AgentConfig`**
   原因：包含 credential 和不可序列化 runtime value，破坏认证与部署边界。

2. **单一 `DurableStore`**
   原因：混淆 transcript、journal、runtime transaction 和 lease ownership。

3. **事件通过强制断言默认透传**
   原因：新增内部事件会静默扩大公共协议。

4. **所有内置工具改写为 `defineTool()`**
   原因：内置工具依赖动态 behavior、permission matcher、interrupt、exposure 和
   durable lifecycle，轻量 authoring API 无法表达完整 contract。

同时拒绝：

- 创建与当前类型并行的 `src/types/api`、`src/types/domain` 大树。
- 为目录整齐度跨 ownership 边界搬运类型。
- 用 aggregate coverage 代替关键状态机和类型 contract 测试。
- 在同一 patch 中同时重命名 wire event 字符串和重构内部类型。

---

## 5. 实施切片

### Slice 1：Agent 配置所有权

- 将内部 `agent/types.ts::AgentOptions` 重命名为 `AgentRuntimeOptions`。
- 根入口只导出 `createAgent.ts::AgentOptions`。
- 增加类型所有权测试，禁止内部配置从 package entrypoint 泄漏。

验收：

```text
public AgentOptions count: 1
internal AgentRuntimeOptions exported from package: 0
runtime behavior changes: 0
```

### Slice 2：内部执行上下文

- 将 `ChatContext` 拆为三个窄接口及 `AgentExecutionContext` 交集。
- 迁移 Agent、LoopRunner、PlanExecutor、Session stream 和 subagent 内部引用。
- 不改变运行时对象形状和序列化格式。

验收：

```text
ChatContext references: 0
AgentExecutionContext package exports: 0
Session/durable tests: unchanged
```

### Slice 3：Tool authoring contract

- `ToolDefinition<TSchema>` 和 `ToolDefinitionInput<TSchema>` 只接受 TypeBox schema。
- `defineTool()` 通过 `Type.Static<TSchema>` 推导 callback 参数。
- 引入 `ErasedToolDefinition`，让异构集合的类型擦除发生在 Tool 模块。
- 保留完整 `Tool` runtime contract 和 discriminated `ToolResult`。

验收：

- TypeBox schema 自动推导 callback 参数。
- 同一 schema 对象同时用于模型声明和运行时验证，不做格式转换。
- 错误参数在任何 Tool callback 前被 runtime validator 拒绝。
- MCP raw JSON Schema 在 adapter 内直接编译，保留 `$ref`、enum 和
  `additionalProperties` 等协议语义。
- Tool 公开入口不导出 codec 或 schema-family-specific authoring 类型。
- 所有 builtin tool 与 durable tool tests 保持通过。

### Slice 4：Wire 与导出边界

- 增加 source/entrypoint contract test。
- 禁止 protocol types 导入 Agent config、Session options、Store 或 concrete runtime。
- 在 `src/protocol/__tests__/ownership.test.ts` 维护 internal symbol denylist，并对
  `package.json.exports` 对应的全部 source entrypoint 执行检查；兼容 subpath 也在
  范围内。
- 保持四个 canonical entrypoint：
  - `@blade-ai/agent-sdk`
  - `@blade-ai/agent-sdk/browser`
  - `@blade-ai/agent-sdk/advanced`
  - `@blade-ai/agent-sdk/server/infra`

验收：

- `session.create` schema 拒绝 `config`、`apiKey` 和其他未知字段。
- browser source 不包含 Node/server runtime import。
- `verify:entrypoints` 与 `verify:install` 通过。

---

## 6. 迁移规则

- 内部类型重命名在单独 patch 完成，不与 wire schema 变更混合。
- 每个切片先增加失败的 type/contract test，再迁移实现。
- 旧内部名称不保留 deprecated alias；它们不是公共 contract。
- 公开类型如需删除或重命名，只能在 v8 major 中进行，并提供迁移表。
- 每个公开类型只有一个 owner；其他入口只做显式 type re-export。
- 迁移完成后使用 `rg` 全量确认旧名称和禁止 import 为零，不做抽样检查。

---

## 7. 验收门禁

### 编译期

- `pnpm run type-check`
- Zod/JSON Schema authoring inference tests
- root/browser/advanced export ownership tests
- protocol type/schema parity tests

### 运行时

- `pnpm test`
- `pnpm run test:coverage:session`
- `pnpm run verify:entrypoints`
- `pnpm run verify:install`
- DeepSeek live Agent/Tool/Response smoke，无框架重试连续 3 次

### 文档

- `pnpm run docs:build`
- 中英文 API reference 保持 entrypoint parity
- 本 RFC 与实际 owner 路径一致

### 完成条件

- 公开 Agent 配置只有 `AgentOptions`。
- 内部仅使用 `AgentRuntimeOptions` 和 `AgentExecutionContext`。
- Tool authoring 两条 schema 路径均有类型与运行时测试。
- Wire payload 保持纯 JSON，credential 和 runtime dependency 不跨边界。
- 没有新增平行类型体系、默认事件断言或聚合 Store。

---

## 8. 实施记录

2026-09-14 完成四个切片：

- 生产源码仅保留一个公开 `AgentOptions`；内部使用 `AgentRuntimeOptions`。
- `ChatContext` 生产引用归零，替换为三个窄 contract 组合的
  `AgentExecutionContext`。
- Tool owner 提供 Zod、JSON Schema 和内部 erased definition contract。
- `UserMessageContent` 迁至独立 wire-safe owner；sandbox context 的 TypeScript
  contract 与 strict stream schema 保持一致。
- protocol ownership test 覆盖全部当前 package source entrypoint、未知 wire 字段和
  `StreamBroadcaster` 穷举规则。

验收结果：

- lint、type-check、文档构建、changelog parity、entrypoint 和最小安装通过。
- 全量 Vitest：205 files / 2178 tests passed，95 个环境型测试 skipped。
- DeepSeek live Agent/Skill/Response smoke 无框架重试连续 3 次通过。
