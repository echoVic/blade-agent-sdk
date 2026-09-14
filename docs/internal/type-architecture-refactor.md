# Blade Agent SDK 类型架构问题与重构方案

> 状态：已由 [类型所有权架构 RFC](./ideal-type-architecture.md) 取代。本文仅保留为
> v7.4.9 问题分析记录，不再作为实现规范。
>
> 类型定义不清晰会导致项目越来越难维护，复杂度不断攀升。这是比 API 设计更根本的问题。

---

## 核心问题诊断

### 🔴 问题 1：SessionOptions 与 AgentOptions 职责重叠

两个接口都包含相同的字段，但语义不清晰，导致调用者困惑。

```ts
// SessionOptions (session/types.ts) - 421 行
interface SessionOptions {
  provider: ProviderConnectionConfig;
  model: string;
  temperature?: number;
  // ...
  permissionMode?: PermissionMode;
  permissionHandler?: PermissionHandler;
  canUseTool?: CanUseTool;  // 标记为 @deprecated 但仍在接口里
  // ...
  tools?: SessionTool[];
  allowedTools?: string[];
  disallowedTools?: string[];
  // ...
}

// AgentOptions (agent/types.ts) - 在同一个项目里！
interface AgentOptions {
  systemPrompt?: string;
  permissions?: Partial<PermissionsConfig>;
  permissionMode?: PermissionMode;
  permissionHandler?: PermissionHandler;
  canUseTool?: CanUseTool;  // 又出现了一次！
  // ...
  toolWhitelist?: string[];  // 跟 allowedTools 是同一个东西
  toolSourcePolicy?: ToolCatalogSourcePolicy;
  modelId?: string;  // 跟 SessionOptions.model 是同一个东西
  // ...
}
```

**问题根源：**
- `Session` 和 `Agent` 的边界模糊
- 没有清晰的"配置层级"概念（创建时配置 vs 运行时配置）
- 两个接口都试图"什么都管"

---

### 🔴 问题 2：ChatContext 是数据容器还是运行时状态？

`ChatContext` 的注释说它是"聊天上下文接口"，职责是"保存会话相关的数据和状态"，但实际上它混合了多种职责：

```ts
interface ChatContext {
  // 会话数据
  messages: ConversationMessage[];
  userId: string;
  sessionId: SessionId;
  snapshot?: ContextSnapshot;
  
  // 运行时控制
  signal?: AbortSignal;
  confirmationHandler?: ConfirmationHandler;
  permissionMode?: PermissionMode;
  
  // 子系统引用
  backgroundAgentManager?: IBackgroundAgentManager;
  
  // 持久化/恢复控制（标记为 @internal）
  executionFence?: DurableExecutionFence;
  assertExecutionLease?: () => Promise<void>;
  runWithExecutionLease?: <T>(operation: () => Promise<T>) => Promise<T>;
  
  // 其他
  systemPrompt?: string;
  subagentInfo?: SubagentInfoForContext;
  omitEnvironment?: boolean;
}
```

**问题根源：**
- 这个类型试图同时承担"数据"、"配置"、"运行时状态"、"依赖注入"四种职责
- 标记 `@internal` 的字段和公开字段混在一起
- 没有明确的"只读数据" vs "可变状态" 区分

---

### 🔴 问题 3：ToolDefinition 的泛型参数缺乏约束

```ts
export interface ToolDefinition<TParams = JsonObject, TData extends JsonValue = JsonValue> {
  name: string;
  description: string | ToolDescription;
  parameters: JSONSchema7 | z.ZodSchema;  // 这里没有约束必须匹配 TParams
  execute: (params: TParams, context: ExecutionContext) => ToolExecution<TData>;
}
```

**问题：**
- `parameters` 的类型（JSONSchema7 | ZodSchema）和 `TParams` 之间没有类型级别的关联
- 用户可以传入一个 `z.object({ city: z.string() })` 的 schema，但 `TParams` 是 `{ foo: number }`，TypeScript 不会报错
- 这导致运行时类型不安全

---

### 🔴 问题 4：Tool、ToolDefinition、ToolConfig 三者关系不清

```ts
// tools/types/tool.ts
export interface ToolDefinition<TParams, TData> { ... }

// tools/types/tool.ts（同一个文件里）
export interface Tool { ... }  // 完全不同的形状

// tools/types/tool.ts
export interface ToolConfig<TParams, TData> { ... }  // 又是另一个形状

// session/types.ts
export type SessionTool = ToolDefinition<never> | Tool;
```

用户看到 `SessionTool` 时，完全不知道应该传 `ToolDefinition` 还是 `Tool`，两者有什么区别？为什么 `ToolDefinition<never>` 要用 `never` 作为参数？

**问题根源：**
- 缺乏"接口层次"的设计——没有区分"用户定义工具的接口"和"内部实现工具的接口"
- `ToolDefinition<never>` 这种写法是类型体操，不是清晰的设计

---

### 🟡 问题 5：事件类型的二重结构无文档说明

```ts
// agent/Agent.ts（未导出）
type AgentEvent = 
  | { type: 'agent_start', ... }
  | { type: 'turn_start', ... }
  | { type: 'content_delta', ... }
  // ... 32 种

// session/types.ts（公开）
export type SessionStreamEvent = 
  | { type: 'turn_start', ... }
  | { type: 'content', ... }
  | { type: 'tool_use', ... }
  // ... 17 种
```

两者名字相似（`turn_start` vs `turn_start`），但形状不完全一致（`content_delta` vs `content`）。转换逻辑散落在 `Session.ts` 里，没有独立的类型映射说明。

---

### 🟡 问题 6：类型导出策略混乱

```ts
// 从 /node 入口
import { SessionOptions, ISession } from '@blade-ai/agent-sdk/node';

// 从 /server 入口
import { SessionOptions, ISession } from '@blade-ai/agent-sdk/server';

// 从 /session 入口
import { SessionOptions, ISession } from '@blade-ai/agent-sdk/session';

// 从根入口
import { SessionOptions, ISession } from '@blade-ai/agent-sdk';
```

同一个类型从 4 个入口都能导入，但它们之间没有 re-export 关系的文档说明。用户不知道：
- 这 4 个是同一个类型吗？
- 如果是，为什么要从 4 个地方导出？
- 如果有细微差别，差别在哪里？

---

## 类型架构重构方案

### 原则 1：明确类型的"所有权层级"

```
┌─────────────────────────────────────────┐
│  Protocol Types (browser-safe)          │  ← 最稳定，序列化边界
│  @blade-ai/agent-sdk/protocol           │
├─────────────────────────────────────────┤
│  Core Domain Types                       │  ← 领域模型，所有运行时共享
│  @blade-ai/agent-sdk/core                │
├─────────────────────────────────────────┤
│  Session API Types (public)             │  ← 用户面向的公开接口
│  @blade-ai/agent-sdk                     │
├─────────────────────────────────────────┤
│  Advanced Types (internal boundaries)   │  ← 扩展点，生产部署可见
│  @blade-ai/agent-sdk/advanced            │
├─────────────────────────────────────────┤
│  Implementation Types (internal)         │  ← 内部实现，不导出
│  agent/types.ts, session/types.ts       │
└─────────────────────────────────────────┘
```

### 原则 2：配置类型应分层

```ts
// 基础层：必需字段
interface AgentCoreConfig {
  model: string;
  apiKey?: string;
  provider?: ProviderConnectionConfig;
}

// 行为层：常用字段
interface AgentBehaviorConfig {
  systemPrompt?: string;
  temperature?: number;
  maxTurns?: number;
  tools?: Tool[];
}

// 高级层：生产级字段
interface AgentAdvancedConfig {
  permission?: PermissionConfig;  // 统一的权限配置，不再有 3 个字段
  tokenBudget?: TokenBudgetConfig;
  durableStore?: DurableEventStore;
  middleware?: Middleware[];
  hooks?: HookCallbacks;
}

// 完整配置是三层的交集
type AgentConfig = AgentCoreConfig & AgentBehaviorConfig & {
  advanced?: AgentAdvancedConfig;
};
```

### 原则 3：区分"定义时类型"和"运行时类型"

```ts
// 定义时：用户写工具时的类型
interface ToolDefinition<TParams extends z.ZodSchema> {
  name: string;
  description: string;
  parameters: TParams;  // Zod schema
  execute: (params: z.infer<TParams>) => ToolResult;  // 自动推导
}

// 运行时：SDK 内部使用的类型
interface RuntimeTool {
  name: string;
  description: string;
  jsonSchema: JSONSchema7;  // 已转换
  execute: (params: unknown) => ToolExecution;  // 运行时已验证
}

// 转换函数的类型签名清晰表达了边界
function compileToolDefinition<T extends z.ZodSchema>(
  def: ToolDefinition<T>
): RuntimeTool;
```

### 原则 4：Context 类型应该是只读数据 + 窄接口

```ts
// 纯数据（只读）
interface SessionData {
  readonly sessionId: SessionId;
  readonly userId: string;
  readonly messages: readonly ConversationMessage[];
  readonly snapshot: ContextSnapshot;
}

// 运行时能力（窄接口）
interface SessionRuntime {
  confirm(request: ConfirmationRequest): Promise<boolean>;
  checkPermission(request: PermissionRequest): Promise<PermissionDecision>;
  signal: AbortSignal;
}

// Context 是数据 + 运行时的组合
interface SessionContext {
  data: SessionData;
  runtime: SessionRuntime;
}

// 内部运行时（不暴露给用户）
interface InternalSessionRuntime extends SessionRuntime {
  backgroundAgents: IBackgroundAgentManager;
  executionLease: DurableExecutionLease;
}
```

### 原则 5：统一事件类型的定义和转换

```ts
// 内部事件（完整信息）
namespace InternalEvents {
  export type AgentEvent = 
    | { type: 'agent_start', ... }
    | { type: 'turn_start', ... }
    | { type: 'content_delta', delta: string }
    // ... 32 种
}

// 公开事件（稳定协议）
namespace PublicEvents {
  export type SessionStreamEvent = 
    | { type: 'turn_start', ... }
    | { type: 'content', delta: string }  // 重命名
    // ... 17 种
}

// 显式的映射类型
type EventMapping = {
  [K in InternalEvents.AgentEvent['type']]: 
    Extract<PublicEvents.SessionStreamEvent, { type: MapType<K> }>;
};

// 转换函数的类型约束
function toPublicEvent(
  internal: InternalEvents.AgentEvent
): PublicEvents.SessionStreamEvent | null;
```

---

## 具体重构步骤

### Step 1: 创建类型分层的新目录结构

```
src/types/
├── protocol/          # 序列化边界类型（browser-safe）
│   ├── commands.ts
│   ├── events.ts
│   └── wire.ts
├── core/              # 核心领域类型
│   ├── session.ts
│   ├── tool.ts
│   ├── model.ts
│   └── runtime.ts
├── config/            # 配置类型（分层）
│   ├── agent.ts       # AgentCoreConfig, AgentBehaviorConfig, AgentAdvancedConfig
│   ├── tool.ts
│   └── permission.ts
└── internal/          # 内部类型（不导出）
    ├── agent.ts
    ├── session.ts
    └── events.ts
```

### Step 2: 重构 SessionOptions → AgentConfig

```ts
// 新类型（分层清晰）
interface AgentConfig {
  // 必需
  model: string;
  apiKey?: string;
  
  // 常用
  systemPrompt?: string;
  temperature?: number;
  tools?: ToolDefinition[];
  
  // 高级
  advanced?: {
    permission?: PermissionConfig;  // 统一的权限配置
    durableStore?: DurableStore;
    middleware?: Middleware[];
    hooks?: Hooks;
    tokenBudget?: TokenBudget;
  };
}
```

### Step 3: 工具类型的泛型约束

```ts
// 新设计：Zod schema 和参数类型自动关联
function defineTool<TSchema extends z.ZodObject<any>>(config: {
  name: string;
  description: string;
  parameters: TSchema;
  execute: (
    params: z.infer<TSchema>,  // 自动推导
    context: ToolContext
  ) => ToolResult | AsyncGenerator<ToolYield, ToolResult>;
}): Tool;

// 使用时类型安全
const weather = defineTool({
  name: 'GetWeather',
  parameters: z.object({ city: z.string() }),
  execute: async (params) => {
    params.city  // TypeScript 知道这是 string
    params.foo   // ❌ TypeScript 报错
    return { ... };
  }
});
```

### Step 4: 分离数据和运行时

```ts
// agent/types.ts 拆分为三个文件

// agent/data.ts - 纯数据
export interface AgentData {
  readonly sessionId: SessionId;
  readonly messages: readonly Message[];
  readonly snapshot: ContextSnapshot;
}

// agent/runtime.ts - 运行时能力
export interface AgentRuntime {
  confirm(req: ConfirmationRequest): Promise<boolean>;
  checkPermission(req: PermissionRequest): Promise<PermissionDecision>;
}

// agent/context.ts - 组合
export interface AgentContext {
  data: AgentData;
  runtime: AgentRuntime;
}
```

### Step 5: 明确类型导出策略

```ts
// @blade-ai/agent-sdk (主入口)
export type {
  // 用户配置类型
  AgentConfig,
  ToolDefinition,
  
  // 用户交互类型
  AgentResponse,
  SessionStreamEvent,
  
  // 错误类型
  SdkError,
  ConfigError,
  // ...
} from './types/index.js';

// @blade-ai/agent-sdk/advanced (高级入口)
export type {
  // 内部边界类型
  SessionRunner,
  AgentRuntimeDeps,
  InternalSessionContext,
  // ...
} from './types/advanced/index.js';

// @blade-ai/agent-sdk/protocol (协议入口)
export type {
  // 序列化边界类型
  AgentCommand,
  AgentEvent,
  // ...
} from './types/protocol/index.js';
```

---

## 迁移计划

### Phase 1: 类型定义重构（不改实现）

**工作量：** 7-10 天  
**优先级：** 立即

1. 创建新的类型目录结构
2. 定义分层的配置类型（`AgentCoreConfig` / `AgentBehaviorConfig` / `AgentAdvancedConfig`）
3. 重构 `ToolDefinition` 的泛型约束，让 Zod schema 和参数类型自动关联
4. 拆分 `ChatContext` 为 `SessionData` + `SessionRuntime`
5. 定义清晰的类型导出策略文档

**产出：**
- `src/types/` 新目录
- 类型迁移文档（说明旧类型 → 新类型的对应关系）
- 所有新类型都标记为 `@beta`，旧类型标记为 `@deprecated`

### Phase 2: 逐步迁移实现（共存期）

**工作量：** 10-15 天  
**优先级：** Phase 1 完成后立即开始

1. `SessionOptions` 内部转换为新的 `AgentConfig`
2. `Agent` 和 `Session` 类内部使用新的 Context 类型
3. 保持旧 API 作为 facade，内部转发到新类型
4. 补充集成测试覆盖新旧类型的转换边界

**产出：**
- 所有核心类内部使用新类型
- 旧 API 作为兼容层保留
- 测试覆盖率达到 70%+

### Phase 3: 文档和示例更新

**工作量：** 3-5 天  
**优先级：** Phase 2 完成后

1. README 和 Quick Start 使用新类型
2. 所有 examples/ 迁移到新 API
3. API 文档生成（TypeDoc）
4. 类型设计文档（为什么这样设计）

---

## 收益评估

### 短期（Phase 1 完成后）

- 新用户不再困惑 `SessionOptions` 的 40+ 字段
- 工具定义的类型安全性提升（Zod schema 自动推导参数类型）
- IDE 自动补全更清晰（分层配置）

### 中期（Phase 2 完成后）

- 内部代码可维护性显著提升
- 新功能可以按"层级"添加，不会污染基础类型
- 类型错误在编译期捕获，而非运行时

### 长期（Phase 3 完成后）

- 社区贡献者可以快速理解类型边界
- API 文档自动生成且准确
- 为未来的 breaking changes 建立了清晰的演进路径

---

## 关键决策

**为什么不一次性替换？**  
一次性替换会导致所有用户的代码同时失效，风险太高。分阶段迁移让用户有时间适应新类型，同时保持项目的可用性。

**为什么强调 Zod schema？**  
Zod 提供了类型级别的约束，让 `parameters` 和 `execute` 的参数类型自动关联。这是解决 `ToolDefinition` 类型不安全的唯一可行路径。

**类型重构会影响运行时性能吗？**  
不会。类型重构只影响编译期，编译后的 JavaScript 代码几乎完全相同。
