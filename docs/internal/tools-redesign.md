# Tools 模块重设计方案

> 状态：设计定稿；§13 第 1-4 步已实施
> 前提：**不考虑向后兼容**（API 面可自由重塑；已持久化的 durable 字符串取值除外）
> 依据：所有判断均基于当前代码调用点实测（见各节行号引用）

---

## 0. 背景与结论

对 `src/tools/` 的多轮审查确认：真正的架构问题**不在执行层**（Pipeline 拆
stage 承载 durable/权限语义，是必要复杂度），而集中在**类型层、注册层与执行
上下文**：

1. 一个胖 `Tool` 接口混淆了四种身份（模型声明 / 运行时执行 / 元数据 / 权限行为）。
2. “工具行为”被拆成三态七函数，调用者无法判断该用哪个。
3. `ToolCatalog` 纯代理 `ToolRegistry` 并维护第二份 Map，外加 `ToolCatalogReadView`
   鸭子接口抹平两者——抽象反噬。
4. 工具暴露存在两条并行链路，Plan 模式过滤实现了两遍。
5. 一批死接口仍在维护（`getMetadata` / `version` / registry 的 category/tag 索引）。
6. `ExecutionContext` 是漏抽象：普通工具能拿到 `toolRegistry` / lease / bgManager。
7. 11 个 `create*Tool` 工厂多为搭依赖的样板，其中 6 个注入的 `sessionId` 执行期
   已可从 `ctx.sessionId` 获得。

**核心思路一句话**：把“胖 `Tool` + 三态七函数行为 + 双容器双暴露 + 每工具工厂 +
胖 context”坍缩成“数据化的 `Tool` + 单一行为解析器 + 单容器单暴露 + 按需依赖声明 +
分层 context”，执行层安全语义原样保留。

---

## 1. 设计原则

1. 一个 authoring 入口，一个内部运行时类型，一条数据流。
2. 数据与方法分离：能预计算的（声明、静态行为）是只读字段，不是方法。
3. 一个概念一个解析器：行为只有 `static` 与 `resolve(params)` 两态。
4. 不可变优于可变：参数被改写就重新 `prepare()`，不在共享 state 上原地 mutate。
5. 最小权限：工具默认只见执行必需的上下文；特权能力必须显式声明。
6. 安全 / durable 语义零改动。

---

## 2. 命名纪律

复用仓库已有名字，不自造术语。用户需要理解的名字从 6 个降到 3 个：

| 概念 | 采用名（复用现有） | 废弃/合并 |
|------|-------------------|-----------|
| authoring 数据 | `ToolDefinition` | 删 `ToolConfig` 重复入口 |
| 编译后运行时对象 | `Tool`（瘦身） | — |
| 一次已解析调用（内部） | `ToolInvocation`（内部化，不导出） | — |
| 工具行为 | `ToolBehavior` | 不再加 `Spec` 变体 |
| 执行上下文（作者面） | `ExecutionContext`（分层） | — |
| 执行期特权分组 | `ctx.runtime: RuntimeAccess` | — |

---

## 3. 目标模块布局

```
src/tools/
├── definition.ts    # ToolDefinition, ToolDescription, ToolExposure
├── defineTool.ts     # 唯一 authoring 入口（含 services / requiresRuntime 声明位）
├── behavior.ts       # ToolKind, ToolSideEffect, ToolBehavior, resolveBehavior(唯一解析器)
├── tool.ts           # Tool(运行时数据), ToolInvocation(内部 PreparedCall)
├── services.ts       # ToolServiceMap（会话级服务唯一登记处）
├── registry.ts       # 单容器 Map<name,{tool,source}> + 按需注入
├── exposure.ts       # 暴露/策略过滤唯一 owner + DiscoverableCatalogView
├── context.ts        # ExecutionContext(分层) + RuntimeAccess
├── result.ts         # ToolResult / ToolExecution（不变）
├── execution/        # Pipeline + stages（语义不变，消费 Tool + Registry）
└── validation/       # schema 编译、路径安全（不变）
```

删除：`core/createTool.ts` 的 `createTool`/`ToolConfig`、`core/ToolInvocation.ts`
公开面、`catalog/ToolCatalog.ts` 整个、`ToolCatalogReadView`、`builtin/groups.ts`
的 `createBuiltinToolGroups`。

---

## 4. 四处坍缩

### 4.1 一个 authoring 类型 `ToolDefinition`

删除 `createTool`/`ToolConfig` 双入口。字段做减法：

- 删：`displayName` 改名 `title`（保留，有读者：搜索加权、可发现清单）、
  `category`（死索引）、`version`（无运行时读者）、`getMetadata`（仅测试调用）。
- 收：`kind`/`sideEffect`/`isReadOnly`/`isConcurrencySafe`/`isDestructive`/
  `interruptBehavior` 全部收进 `behavior: ToolBehavior`。
- 留：`strict` 改名 `strictSchema`——**非死字段**，
  [VercelAIModelService.ts:639](../../src/services/VercelAIModelService.ts) 读取
  用于 OpenAI structured outputs，属声明面，并入 `FunctionDeclaration`。
- 迁移（非删除）：`tags`——**非死字段**，MCP 服务器归属靠它匹配
  （注册 [createMcpTool.ts:55](../../src/mcp/createMcpTool.ts)，拆除
  [ToolRegistry.ts:310](../../src/tools/registry/ToolRegistry.ts)）。迁到结构化
  `source: { kind:'mcp', serverName }` 后方可删 `tags`。

### 4.2 行为：一个概念一个解析器

`behavior.ts` 合并 [kind.ts:32-144](../../src/tools/types/kind.ts) 的
`createToolBehavior / getStaticToolBehavior / resolveToolBehaviorHint /
resolveToolBehavior / resolveToolBehaviorSafely` 五函数 + Tool 上
`resolveBehavior / getBehaviorHint` 两方法为：

```typescript
export type ToolKind = 'readonly' | 'write' | 'execute';       // 字面量值须与已持久化保持一致
export type ToolSideEffect = 'pure' | 'idempotent' | 'non_idempotent';

export interface ToolBehavior {
  kind: ToolKind; sideEffect: ToolSideEffect;
  isReadOnly: boolean; isConcurrencySafe: boolean; isDestructive: boolean;
  interruptBehavior: 'block' | 'cancel';
}

// 唯一解析器：无参=静态；带参=按参数收窄；对参数校验失败自动回退静态（吸收原 *Safely）
export function resolveBehavior(tool: Tool, params?: unknown): ToolBehavior;
```

**合并/派生语义（防回归关键）**：当 `resolveBehavior(params)` 返回
`Partial<ToolBehavior>` 收窄 `kind` 时，顺序必须为——① 合并 `kind` → ② 由新
`kind` 派生默认布尔（`isReadOnly` 等）→ ③ 应用显式覆盖。避免出现
`kind:readonly` 但 `isReadOnly:false` 的矛盾态。

“hint vs resolved”的区别退化为“传不传 params”，预计算结果存 `tool.staticBehavior`。

### 4.3 `Tool`：数据化，四身份面各归其位

```typescript
export interface Tool {
  readonly name: string;
  readonly aliases: readonly string[];
  readonly title: string;                    // 原 displayName
  readonly description: ToolDescription;
  readonly staticBehavior: ToolBehavior;
  readonly exposure: ToolExposure;
  readonly maxResultSizeChars: number;
  readonly requiresRuntime: boolean;
  readonly declaration: FunctionDeclaration; // 预计算 {name,description,jsonSchema,strict}，取代 getFunctionDeclaration()

  readonly prepare: (raw: unknown) => ToolInvocation;      // 取代 build()
  readonly execute: (params: unknown, ctx: ExecutionContext) => ToolExecution;
  readonly checkPermissions?: (p: unknown, ctx: ExecutionContext) => Maybe<PermissionResult>;
}

// 不可变快照：参数被 hook/权限改写时重新 prepare，而非原地 mutate
export interface ToolInvocation {
  readonly params: JsonObject;
  readonly behavior: ToolBehavior;
  readonly affectedPaths: readonly string[];
  readonly permissionSignature: string;
  readonly description: string;
}
```

删除 `getMetadata()` / `describe()` 方法 / `version`。动态描述并入
`prepare().description`。`ToolInvocation` 永不出现在公开面。

**`prepare()` 双错误通道（防回归）**：schema 不合法**继续抛异常**（现有测试断言
`toThrow(/参数验证失败/)`）；语义 `validate()` 失败**仍返回**
`ToolValidationError`。两条通道不可合并。

### 4.4 Registry：单容器

删除 `ToolCatalog` 代理与 `ToolCatalogReadView` 鸭子接口：

```typescript
export interface RegisteredTool { tool: Tool; source: ToolSource; }  // source 必填

export class ToolRegistry {
  private tools = new Map<string, RegisteredTool>();
  private aliases = new Map<string, string>();
  constructor(private readonly services: ToolServiceMap) {}

  register(def: ToolDefinition, source: ToolSource): void;   // 保留：内置名保护、别名冲突检测
  registerMcp(def: ToolDefinition, source: ToolSource): void; // 保留：mcp__ 命名空间、与内置冲突保护
  get(name: string): Tool | undefined;
  entries(): readonly RegisteredTool[];
  unregister(name: string): boolean;
  removeMcp(serverName: string): number;                     // 靠 source.serverName，不再靠 tags
}
```

删除：category/tag 索引及全部 getter、`getStats`、`getReadOnlyTools`、Registry
上的 `search`（退化为自由函数 `searchTools(list, query)`，
[toolSearch.ts](../../src/tools/search/toolSearch.ts) 本就接收 list）、
`getFunctionDeclarations*`（交给 exposure）。

---

## 5. 暴露：唯一 owner

`ToolExposurePlanner.plan(entries, policy)` 成为“模型能看到哪些工具”的唯一
决策点（plan 模式只读过滤、allow/deny、source policy、deferred/discoverable）。

删除 [ToolExposurePlanner.ts:106-128](../../src/tools/exposure/ToolExposurePlanner.ts)
的 `planFromDeclarations` 死 fallback（`LoopRunner` 恒传非空 catalog，走不到）
与 Registry 的 `getFunctionDeclarationsByMode` / `getReadOnlyFunctionDeclarations`。
它直接吃 `RegisteredTool[]`，不再需要 `ToolCatalogReadView`。

---

## 6. ExecutionContext 三层分层

实测（内置工具 `execute` 读取字段计数）证明“作者面 vs 管道面”两分不成立：
`executionFence`(task/bash)、`assertExecutionLease`/`runWithExecutionLease`(task)、
`backgroundAgentManager`(task/taskOutput/taskStop/bash) 等被少数编排工具正当读取。
正确切法是**按能力等级分三层**。

### 第 1 层 `ExecutionContext`（默认，~7 字段，人人可见）

`signal / sessionId / messageId / contextSnapshot(→cwd) / permissionMode /
confirmationHandler / bladeConfig`。所有 `execute(params, ctx)` 的默认签名。

### 第 2 层 `ctx.runtime: RuntimeAccess`（执行期特权）

只放**执行期动态、无法构造期注入**的能力：

```typescript
export interface RuntimeAccess {
  assertExecutionLease: () => Promise<void>;
  runWithExecutionLease: <T>(op: () => Promise<T>) => Promise<T>;
  executionFence?: DurableExecutionFence;
}
```

无 durable lease 时，两个操作分别退化为 no-op 和直接执行；只有 fence 数据可选。
第 2 步由 Pipeline 对所有工具构造冻结的 `runtime`，旧顶层 lease/fence 字段直接
删除；第 3 步加入 `requiresRuntime` 后再从类型上限制普通工具访问。读取者：
task.ts、bash.ts。

### 第 3 层 构造期依赖（从 context 移除，改按需注入）→ 见第 7 节

`backgroundAgentManager / skillRegistry / subagentRegistry / mcpRegistry /
memoryManager / 目录视图` 全部改 `services` 声明注入。

> 注：`backgroundAgentManager` 现状是 `as` 强转 + 可选链兜底（
> [bash.ts:284](../../src/tools/builtin/shell/bash.ts)），并非稳定注入，归第 3 层。

### 第 4 层 纯管道内化（工具完全不可见）

`toolInvocationLifecycle`（实测 0 工具读取）、`userId`（tools 层 0 读取）、
`skillActivationPaths`（仅 skill.ts:92，收进 skill 服务/参数）、
`toolRegistry`/`toolCatalog`/`discoveredTools`（见第 8 节）。

连带：`ExecutionHistoryEntry.context`（
[execution.ts:157](../../src/tools/types/execution.ts)）只存第 1 层快照。

`ExecutionContext` 由 21 字段降到 ~7。

---

## 7. 按需依赖声明 + 注册器注入（消灭 11 个工厂）

### 7.1 服务全集（唯一真源，key 沿用现有字段名）

```typescript
// src/tools/services.ts
export interface ToolServiceMap {
  subagentRegistry: SubagentRegistry;
  memoryManager: MemoryManager;
  mcpRegistry: McpRegistry;
  skillRegistry: SkillRegistry;
  backgroundAgentManager: IBackgroundAgentManager;
  discoverableCatalog: DiscoverableCatalogView;
}
```

### 7.2 `defineTool` 声明位

```typescript
export function defineTool<
  S extends TSchema,
  K extends keyof ToolServiceMap = never,
  R extends boolean = false,
>(def: {
  name: string;
  description: string | ToolDescription;
  parameters: S;
  behavior?: ToolBehavior;                 // 省略 => execute + non_idempotent (fail-closed)
  resolveBehavior?: (p: Static<S>) => Partial<ToolBehavior>;

  services?: readonly K[];                 // 构造期会话服务，按需声明（默认 never）
  requiresRuntime?: R;                     // 执行期特权(lease/fence)，与 services 正交

  execute: (
    params: Static<S>,
    ctx: ExecutionContext
       & Pick<ToolServiceMap, K>           // 仅声明的 service 出现，读别的编译期报错
       & (R extends true ? { runtime: RuntimeAccess } : {}),
  ) => ToolExecution;

  // 可选声明面
  aliases?: readonly string[];
  strictSchema?: boolean;
  maxResultSizeChars?: number;
  exposure?: ToolExposure;
  group?: BuiltinToolGroup;                // 替代 createBuiltinToolGroups 的分组
  validate?: (p: Static<S>, ctx: ExecutionContext) => Maybe<ToolValidationError>;
  checkPermissions?: (p: Static<S>, ctx: ExecutionContext) => Maybe<PermissionResult>;
  permissionMatcher?: (p: Static<S>) => PreparedPermissionMatcher;
}): ToolDefinition;
```

性质：

- 默认 `K = never`：无依赖工具不写 `services`，`ctx` 即纯净第 1 层，裸 `defineTool`。
- 精确注入：`Pick<ToolServiceMap, K>` 使工具只能访问已声明服务，封堵“工具持有
  全局注册表”。
- `sessionId` **不进** `services`：在第 1 层。task/todo 系读 `ctx.sessionId`，
  `TaskStore.getInstance(ctx.sessionId)` 现取（实测 execute 已写
  `ctx?.sessionId ?? sessionId`，注入参数近乎死值）。

### 7.3 注册器注入（唯一注入点）

```typescript
// 第 3 步的过渡形态；第 7 步合并容器后收敛回 register
registerDefinition(def: ToolDefinition, source: ToolSource): Tool | undefined {
  const injected = pick(this.services, def.services ?? []);   // 只取声明的键
  if (hasMissingService(injected)) return undefined;
  return register(compile(def, injected), source);
}
```

- `compile(def, injected)` 把 service 闭合进 `execute` 的 `ctx`；执行期 Pipeline
  只补第 1 层 +（若 `requiresRuntime`）`ctx.runtime`。
- 缺服务处理：`memoryManager`/`mcpRegistry` 缺席时**跳过注册**声明了它的工具
  （等价现 `memoryManager ? [...] : []`），不注入 undefined。
- `createBuiltinToolGroups` 删除，内置工具改静态 `ToolDefinition[]` + `group` 字段。

---

## 8. DiscoverTools 窄只读接口

DiscoverTools 需列“对模型隐藏但可发现”的工具（现读 `ctx.toolRegistry`/
`ctx.toolCatalog`，[discoverTools.ts:34-51](../../src/tools/builtin/system/discoverTools.ts)）。
给 registry 等于给 `register/unregister`。改为最小只读视图：

```typescript
// src/tools/exposure.ts
export interface DiscoverableToolInfo {
  readonly name: string;
  readonly title: string;
  readonly description: string;
  readonly exposureMode: 'deferred' | 'discoverable-only';
  readonly discoveryHint?: string;
}

export interface DiscoverableCatalogView {
  /** 当前对模型隐藏但可被发现激活的工具（已应用 permission mode 与 discovered 状态）。 */
  listDiscoverable(input: {
    query: string;
    permissionMode?: PermissionMode;
  }): readonly DiscoverableToolInfo[];
}
```

实现方为 `ToolExposurePlanner`（暴露唯一 owner），通过构造期 provider 读取当前
`RuntimePatchManager.discoveredTools`。第 4 步先把 execution-scoped 窄视图交给
现有 DiscoverTools；第 5 步迁移为 `services: ['discoverableCatalog']`。
DiscoverTools 拿不到 `register/unregister/get`，也无法枚举已暴露工具。
`toolRegistry`/`toolCatalog`/`discoveredTools` 已从 `ExecutionContext` 移除。

---

## 9. 数据流（单一路径）

```
defineTool(def)                          // 纯数据 + 依赖声明
  → registry.register(def, source)       // 单容器；按 def.services 精确注入；source 必填
  → exposure.plan(entries, policy)       // 唯一过滤 → FunctionDeclaration[]
  → model
  → pipeline.execute(name, raw, ctx)
      → registry.get(name)
      → tool.prepare(raw)                // 不可变 ToolInvocation
      → [middleware→hooks→authorize→confirm→fileLock→invoke→finalize]  // 语义不变
                                          // 参数改写 = 重新 prepare()，不原地 mutate
```

`SessionOptions.tools: ToolDefinition[]` 只收 definition，Session 内部统一编译；
删 [SessionRuntime.ts:63-73](../../src/session/SessionRuntime.ts) 的
`isRuntimeTool`/`toRuntimeTool` 鸭子判定与 `SessionTool = ErasedToolDefinition | Tool`
联合。异构擦除退化为内部边界类型，不再是用户可见的第二 authoring 类型。

---

## 10. 安全 / durable 语义：明确不动

- `execution/` Pipeline + 全部 stage：execution lease、超时、并发准入、文件
  读写锁、参数改写后重校验、权限处理器不得越权改路径、Hook 子进程收尾、durable
  lifecycle 边界。唯一改动：`PipelineExecutionState` 持有不可变 `ToolInvocation`
  引用，`InvocationBinder` 的原地 mutation 换成重新 `prepare()`（落实可变状态收敛，
  不改阶段顺序与 guard 位置）。
- `sideEffect` 与 `kind` 正交，缺省 `non_idempotent` fail-closed。
- MCP `mcp__` 命名空间与内置名冲突保护。
- `result.ts` 判别联合、`validation/` 路径安全与 schema 编译。
- **持久化字符串取值冻结**：`sideEffect` / `interruptBehavior` 已落盘
  （[SessionDurableRecorder.ts:555-556](../../src/session/events/SessionDurableRecorder.ts)），
  枚举可改字符串联合，但字面量值不得变，否则旧 session 恢复错乱。`kind` 未落盘可改。

---

## 11. 无兼容包袱下的删除清单

| 删除 | 依据 |
|------|------|
| `createTool` + `ToolConfig` | 与 `defineTool`/`ToolDefinition` 双入口 |
| `toolFromDefinition` | 编译内部化，不做公开转换函数 |
| 胖 `Tool` 方法面 / `ToolInvocation` 公开面 | 拆为数据 `Tool` + 内部 `ToolInvocation` |
| `ToolCatalog` / `ToolCatalogReadView` | 并入 Registry |
| `getMetadata` / `version` / `describe()` 方法 | 运行时无读者 |
| Registry category/tag 索引 / `getStats` / `getReadOnlyTools` / `search` | 生产零调用 |
| Registry `getFunctionDeclarationsByMode` + exposure `planFromDeclarations` | 双暴露路径 |
| `SessionTool` 联合 / `isRuntimeTool` / `toRuntimeTool` | tools 只收 definition |
| 11 个 `create*Tool` 工厂 + `createBuiltinToolGroups` | 改按需声明 + 注册器注入 |
| `category` 字段 | 死索引来源 |
| context: `toolRegistry`/`toolCatalog`/`discoveredTools`/`backgroundAgentManager`/`skillRegistry`/`lease`/`fence`/`toolInvocationLifecycle`/`userId`/`skillActivationPaths` | 分层后移除或改注入 |

保留但改造：`tags`→`source.serverName`；`displayName`→`title`；`strict`→`strictSchema`。

---

## 12. 内置工具迁移账（16 个）

| 工具 | services 声明 | requiresRuntime |
|------|--------------|-----------------|
| read/edit/write/notebook/grep/glob/killShell/webFetch/webSearch/enterPlan/exitPlan/askUserQuestion | — | — |
| taskCreate/taskGet/taskUpdate/taskList/taskStop/todoWrite | —（读 `ctx.sessionId`） | — |
| task | `['subagentRegistry']` | ✅ (lease/fence) |
| bash | `['backgroundAgentManager']` | ✅ (fence) |
| taskOutput | `['backgroundAgentManager']` | — |
| memoryRead/memoryWrite | `['memoryManager']` | — |
| listMcpResources/readMcpResource | `['mcpRegistry']` | — |
| skill | `['skillRegistry']` | — |
| discoverTools | `['discoverableCatalog']` | — |

结果：工厂 11 → 0；`ExecutionContext` 21 → ~7；服务注入收敛到注册器一处；特权
能力全部变成工具上的显式声明位（`services` + `requiresRuntime`）。

---

## 13. 落地顺序（每步独立、可编译、可测）

1. [x] `behavior.ts` 合并单一 `resolveBehavior` + `ToolBehavior`（字面量值保持一致）。
2. [x] `ExecutionContext` 三层拆分 + `RuntimeAccess` + `ctx.runtime`（旧顶层字段已删除）。
3. [x] `ToolServiceMap` + `defineTool` 的 `services`/`requiresRuntime` 声明位 + 注册器注入。
4. [x] `DiscoverableCatalogView` 落地，DiscoverTools 切窄接口；从 context 删 registry/catalog。
5. 类 A 6 工厂删除改读 `ctx.sessionId`；类 B 5 工厂改 `services`；删剩余 `as` 兜底。
6. `Tool`/`ToolInvocation` 替换胖接口；Pipeline 改吃不可变 `ToolInvocation`。
7. `registry.ts` 单容器，删 `ToolCatalog`；exposure 收敛为唯一 owner。
8. 清死代码（getMetadata/version/category/tag/stats/双暴露）。
9. 删 `createBuiltinToolGroups`，内置工具改静态数组 + `group` 字段。
10. 根入口只导 `defineTool` + 必要类型。

---

## 14. 必需的集成测试

- Task 派生 subagent：lease/fence 经 `ctx.runtime` 正确传递。
- 后台 Bash：fence + `backgroundAgentManager` 注入链。
- DiscoverTools：窄接口 `listDiscoverable` 返回隐藏工具，且拿不到 registry 写能力。
- Memory 服务缺席：声明 `['memoryManager']` 的工具被跳过注册。
- 精确注入负向类型测试：读未声明 service 应编译失败。
- 行为解析：`resolveBehavior` 收窄 `kind` 后布尔正确重新派生（防矛盾态）。
- durable 恢复：`sideEffect`/`interruptBehavior` 字面量值未变，旧 session 可恢复。

---

## 15. 待确认 / 已确认决策记录

- [x] `ToolKind` enum → 字符串联合（字面量值冻结已落盘者）。
- [x] `ExecutionContext` 分层纳入本次重设计。
- [x] 依赖注入走路线 1（消灭工厂）+ 按需声明粒度。
- [x] `ToolServiceMap` key 沿用现有字段名。
- [x] DiscoverTools 走窄只读 `DiscoverableCatalogView`。
