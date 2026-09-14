# Blade Agent SDK 理想类型架构设计

> 从零开始，不考虑兼容性，只考虑最合理的设计。

---

## 第一部分：核心设计原则

### 原则 1：类型即文档

每个类型的名字和结构应该让开发者一眼就能理解它的职责、生命周期和使用场景。

### 原则 2：严格的层次边界

```
Protocol (wire)          ← 序列化边界，永不变
    ↓
Domain (core concepts)   ← 领域概念，稳定
    ↓
API (user-facing)        ← 用户接口，版本化
    ↓
Internal (implementation) ← 内部实现，自由变化
```

### 原则 3：类型安全优先

- 能用泛型自动推导的，就不要手写类型
- 能在编译期检查的，就不要推迟到运行时
- 能用 branded types 防止混淆的，就不要用 string

### 原则 4：配置即代码

配置类型应该读起来像配置文件，而不是像代码。

---

## 第二部分：完整类型架构

### 目录结构

```
src/types/
├── ids.ts                    # 品牌类型：SessionId, AgentId, ToolId, ...
├── protocol/                 # 序列化边界（browser-safe）
│   ├── wire.ts              # AgentCommand, AgentEvent
│   ├── codec.ts             # 序列化/反序列化
│   └── version.ts           # 协议版本
├── domain/                   # 领域模型
│   ├── message.ts           # Message, Role, Content
│   ├── tool.ts              # Tool, ToolKind, ToolSideEffect
│   ├── model.ts             # ModelIdentity, ModelCapabilities
│   ├── permission.ts        # Permission, PermissionDecision
│   └── runtime.ts           # RuntimeContext, Capability
├── config/                   # 配置类型（用户填写）
│   ├── agent.ts             # AgentConfig（分层）
│   ├── tool.ts              # ToolConfig
│   ├── model.ts             # ModelConfig
│   └── permission.ts        # PermissionConfig
├── api/                      # 公开 API
│   ├── agent.ts             # Agent 接口
│   ├── response.ts          # AgentResponse
│   ├── tool-builder.ts      # defineTool() 的类型
│   └── events.ts            # SessionStreamEvent（公开事件）
└── internal/                 # 内部类型（不导出）
    ├── session.ts           # SessionState（内部状态机）
    ├── loop.ts              # LoopState, TurnState
    ├── events.ts            # InternalEvent（完整事件）
    └── context.ts           # InternalContext（完整上下文）
```

---

## 第三部分：具体类型定义

### 3.1 ID 类型（`types/ids.ts`）

```ts
// 品牌类型，防止 ID 混用
declare const SessionIdBrand: unique symbol;
export type SessionId = string & { readonly [SessionIdBrand]: true };

declare const AgentIdBrand: unique symbol;
export type AgentId = string & { readonly [AgentIdBrand]: true };

declare const ToolIdBrand: unique symbol;
export type ToolId = string & { readonly [ToolIdBrand]: true };

declare const MessageIdBrand: unique symbol;
export type MessageId = string & { readonly [MessageIdBrand]: true };

// 工厂函数
export const SessionId = (id: string): SessionId => id as SessionId;
export const AgentId = (id: string): AgentId => id as AgentId;
export const ToolId = (id: string): ToolId => id as ToolId;
export const MessageId = (id: string): MessageId => id as MessageId;
```

---

### 3.2 领域模型（`types/domain/`）

#### `domain/message.ts`

```ts
export enum Role {
  User = 'user',
  Assistant = 'assistant',
  System = 'system',
  Tool = 'tool',
}

export type TextContent = {
  type: 'text';
  text: string;
};

export type ImageContent = {
  type: 'image';
  url: string;
  detail?: 'low' | 'high';
};

export type Content = TextContent | ImageContent;

export type Message = {
  id: MessageId;
  role: Role;
  content: Content[];
  timestamp: number;
};
```

#### `domain/tool.ts`

```ts
export enum ToolKind {
  ReadOnly = 'read-only',
  Write = 'write',
  Execute = 'execute',
  Network = 'network',
  Subagent = 'subagent',
}

export enum ToolSideEffect {
  Pure = 'pure',             // 可以安全重放
  Idempotent = 'idempotent', // 可以重放但有外部效果
  NonIdempotent = 'non-idempotent', // 不可重放
}

// 运行时 Tool（内部使用）
export type RuntimeTool = {
  id: ToolId;
  name: string;
  description: string;
  kind: ToolKind;
  sideEffect: ToolSideEffect;
  jsonSchema: JSONSchema7;
  execute: (params: unknown, context: ToolContext) => ToolExecution;
};
```

#### `domain/permission.ts`

```ts
export enum PermissionDecision {
  Allow = 'allow',
  Deny = 'deny',
  Ask = 'ask',
}

export type PermissionRequest = {
  kind: ToolKind;
  toolName: string;
  params: unknown;
  affectedPaths?: string[];
};

export type PermissionResult = {
  decision: PermissionDecision;
  reason?: string;
};
```

---

### 3.3 配置类型（`types/config/`）

#### `config/agent.ts` - 这是核心

```ts
import type { z } from 'zod';

// ── 第一层：必需配置（2-3 个字段）──────────────────────

export type AgentCoreConfig = {
  /**
   * 模型标识符，如 'gpt-4o', 'claude-sonnet-3.5'
   */
  model: string;
  
  /**
   * API key（如果不通过环境变量提供）
   */
  apiKey?: string;
};

// ── 第二层：常用配置（≤10 个字段）──────────────────────

export type AgentBehaviorConfig = {
  /**
   * 系统提示词
   */
  systemPrompt?: string;
  
  /**
   * 采样温度 (0-2)
   */
  temperature?: number;
  
  /**
   * 最大轮次，-1 表示无限制
   */
  maxTurns?: number;
  
  /**
   * 工具列表
   */
  tools?: ToolBuilder[];
  
  /**
   * 文件系统访问权限（自动启用 node profile）
   */
  filesystem?: {
    roots: string[];
    cwd?: string;
  };
};

// ── 第三层：高级配置（其余全部）──────────────────────────

export type AgentAdvancedConfig = {
  /**
   * 权限配置（统一入口）
   */
  permission?: PermissionConfig;
  
  /**
   * Token 预算
   */
  tokenBudget?: {
    maxPromptTokens?: number;
    maxCompletionTokens?: number;
    maxTotalTokens?: number;
  };
  
  /**
   * 中间件
   */
  middleware?: {
    model?: ModelMiddleware[];
    tool?: ToolMiddleware[];
  };
  
  /**
   * 钩子（TypeScript callbacks）
   */
  hooks?: {
    beforeToolUse?: HookFn<'beforeToolUse'>[];
    afterToolUse?: HookFn<'afterToolUse'>[];
    onError?: HookFn<'onError'>[];
    // ... 其他 inline hooks
  };
  
  /**
   * 持久化存储（生产环境）
   */
  persistence?: {
    store: DurableStore;
    sessionId?: SessionId;
  };
  
  /**
   * 可观测性
   */
  observability?: {
    tracing?: TracingConfig;
    metrics?: MetricsConfig;
  };
};

// ── 完整配置类型 ───────────────────────────────────────

export type AgentConfig = 
  & AgentCoreConfig 
  & AgentBehaviorConfig 
  & {
      advanced?: AgentAdvancedConfig;
    };
```

#### `config/permission.ts`

```ts
/**
 * 权限配置（统一入口，替代原来的 3 个字段）
 */
export type PermissionConfig = 
  | PermissionPreset
  | PermissionHandler;

/**
 * 预设权限模式
 */
export enum PermissionPreset {
  /**
   * 默认：读自动允许，写需确认
   */
  Default = 'default',
  
  /**
   * 接受编辑：文件读写自动允许，执行需确认
   */
  AcceptEdits = 'accept-edits',
  
  /**
   * 绕过所有权限检查（测试用）
   */
  Bypass = 'bypass',
}

/**
 * 自定义权限处理器
 */
export type PermissionHandler = (
  request: PermissionRequest
) => Promise<PermissionDecision> | PermissionDecision;
```

---

### 3.4 工具定义（`types/api/tool-builder.ts`）

```ts
import type { z } from 'zod';

/**
 * 工具构建器（用户定义工具时使用）
 * 
 * 泛型参数 TSchema 自动推导参数类型，保证类型安全
 */
export type ToolBuilder<TSchema extends z.ZodObject<any> = z.ZodObject<any>> = {
  /**
   * 工具名称（唯一标识）
   */
  name: string;
  
  /**
   * 工具描述（给模型看）
   */
  description: string;
  
  /**
   * 参数 schema（Zod）
   */
  parameters: TSchema;
  
  /**
   * 工具类型
   */
  kind?: ToolKind;
  
  /**
   * 副作用类型
   */
  sideEffect?: ToolSideEffect;
  
  /**
   * 执行函数
   * 
   * 支持两种形式：
   * 1. async function - 直接返回结果
   * 2. async generator - 可以 yield 进度
   */
  execute: ToolExecutor<z.infer<TSchema>>;
};

/**
 * 工具执行器（两种形式）
 */
export type ToolExecutor<TParams> =
  | SimpleExecutor<TParams>
  | StreamingExecutor<TParams>;

/**
 * 简单执行器：async function，返回结果
 */
export type SimpleExecutor<TParams> = (
  params: TParams,
  context: ToolContext
) => Promise<ToolResult>;

/**
 * 流式执行器：async generator，可以 yield 进度
 */
export type StreamingExecutor<TParams> = (
  params: TParams,
  context: ToolContext
) => AsyncGenerator<ToolProgress, ToolResult>;

/**
 * 工具上下文（执行时可用的能力）
 */
export type ToolContext = {
  /**
   * 取消信号
   */
  signal: AbortSignal;
  
  /**
   * 会话 ID
   */
  sessionId: SessionId;
  
  /**
   * 确认对话框
   */
  confirm: (message: string) => Promise<boolean>;
  
  /**
   * 进度回调（简单执行器也可以用）
   */
  progress: (message: string) => Promise<void>;
};

/**
 * 工具结果
 */
export type ToolResult = {
  /**
   * 返回给模型的内容
   */
  content: string | Content[];
  
  /**
   * 可选：显示给用户的内容
   */
  display?: {
    summary?: string;
    details?: string;
  };
  
  /**
   * 可选：错误信息
   */
  error?: {
    message: string;
    code?: string;
  };
};

/**
 * 工具进度
 */
export type ToolProgress = {
  message: string;
  percent?: number;
};
```

#### 使用示例

```ts
import { defineTool } from '@blade-ai/agent-sdk';
import { z } from 'zod';

// 示例 1：简单工具（async function）
const weather = defineTool({
  name: 'get_weather',
  description: 'Get weather for a city',
  parameters: z.object({
    city: z.string(),
    unit: z.enum(['celsius', 'fahrenheit']).optional(),
  }),
  async execute(params, ctx) {
    // params 的类型自动推导为 { city: string; unit?: 'celsius' | 'fahrenheit' }
    const data = await fetchWeather(params.city, params.unit);
    return { content: `Weather: ${data}` };
  },
});

// 示例 2：流式工具（async generator）
const analyze = defineTool({
  name: 'analyze_codebase',
  description: 'Analyze a codebase',
  parameters: z.object({
    path: z.string(),
  }),
  async *execute(params, ctx) {
    yield { message: 'Scanning files...', percent: 20 };
    const files = await scanFiles(params.path);
    
    yield { message: 'Analyzing...', percent: 60 };
    const result = await analyze(files);
    
    yield { message: 'Done', percent: 100 };
    
    return {
      content: `Found ${result.issues} issues`,
      display: { summary: result.summary },
    };
  },
});
```

---

### 3.5 公开 API（`types/api/`）

#### `api/agent.ts`

```ts
/**
 * Agent 接口（用户交互的主要入口）
 */
export interface Agent {
  /**
   * 会话 ID
   */
  readonly sessionId: SessionId;
  
  /**
   * 发送消息
   */
  send(message: string | Content[]): Promise<AgentResponse>;
  
  /**
   * 关闭会话
   */
  close(): Promise<void>;
  
  /**
   * 中止当前请求
   */
  abort(): Promise<void>;
}
```

#### `api/response.ts`

```ts
/**
 * Agent 响应（高层 API）
 */
export interface AgentResponse {
  /**
   * 请求 ID
   */
  readonly requestId: RequestId;
  
  /**
   * 获取完整文本（最常用）
   */
  text(): Promise<string>;
  
  /**
   * 流式获取文本
   */
  textStream(): AsyncIterable<string>;
  
  /**
   * 监听特定事件
   */
  on<T extends SessionEventType>(
    type: T,
    handler: EventHandler<T>
  ): this;
  
  /**
   * 获取完整响应（包含工具调用、token 使用等）
   */
  result(): Promise<ResponseResult>;
  
  /**
   * 底层：完整事件流（高级用户使用）
   */
  stream(): AsyncIterable<SessionStreamEvent>;
}

/**
 * 公开事件类型（17 种，用户可见）
 */
export type SessionStreamEvent =
  | { type: 'turn.start'; turn: number }
  | { type: 'turn.end'; turn: number }
  | { type: 'content'; delta: string }
  | { type: 'thinking'; delta: string }
  | { type: 'tool.use'; id: ToolUseId; name: string; input: unknown }
  | { type: 'tool.progress'; id: ToolUseId; progress: ToolProgress }
  | { type: 'tool.result'; id: ToolUseId; result: ToolResult }
  | { type: 'usage'; promptTokens: number; completionTokens: number }
  | { type: 'error'; message: string; code?: string }
  // ... 其他事件

/**
 * 事件类型联合（用于 .on() 的类型推导）
 */
export type SessionEventType = SessionStreamEvent['type'];

/**
 * 事件处理器（类型安全）
 */
export type EventHandler<T extends SessionEventType> = (
  event: Extract<SessionStreamEvent, { type: T }>
) => void | Promise<void>;

/**
 * 完整响应结果
 */
export type ResponseResult = {
  content: string;
  toolCalls: ToolCallRecord[];
  usage: TokenUsage;
  duration: number;
};
```

---

### 3.6 内部类型（`types/internal/`）

#### `internal/session.ts`

```ts
/**
 * 会话状态（内部状态机）
 * 
 * 只在 Session 类内部使用，不导出
 */
export enum SessionState {
  Idle = 'idle',
  Running = 'running',
  Waiting = 'waiting',
  Closed = 'closed',
  Error = 'error',
}

/**
 * 内部会话数据
 */
export type InternalSessionData = {
  sessionId: SessionId;
  state: SessionState;
  messages: Message[];
  context: InternalContext;
  currentTurn: number;
  tokenUsage: TokenUsage;
};
```

#### `internal/context.ts`

```ts
/**
 * 内部上下文（包含所有运行时依赖）
 * 
 * 与公开的 ToolContext 不同，这是完整的内部上下文
 */
export type InternalContext = {
  // 只读数据
  data: {
    readonly sessionId: SessionId;
    readonly userId: string;
    readonly snapshot: ContextSnapshot;
  };
  
  // 运行时能力
  runtime: {
    signal: AbortSignal;
    confirm: (message: string) => Promise<boolean>;
    checkPermission: (req: PermissionRequest) => Promise<PermissionDecision>;
  };
  
  // 子系统（内部）
  internal: {
    backgroundAgents: BackgroundAgentManager;
    executionLease: DurableExecutionLease;
    toolCatalog: ToolCatalog;
  };
};
```

#### `internal/events.ts`

```ts
/**
 * 内部事件（32 种，包含所有内部细节）
 */
export type InternalEvent =
  | { type: 'agent.start'; sessionId: SessionId }
  | { type: 'agent.end'; sessionId: SessionId }
  | { type: 'turn.start'; turn: number }
  | { type: 'turn.end'; turn: number }
  | { type: 'content.delta'; delta: string }  // 内部用 delta
  | { type: 'thinking.delta'; delta: string }
  | { type: 'tool.scheduled'; id: ToolUseId; name: string }
  | { type: 'tool.started'; id: ToolUseId }
  | { type: 'tool.progress'; id: ToolUseId; progress: ToolProgress }
  | { type: 'tool.completed'; id: ToolUseId; result: ToolResult }
  | { type: 'budget.warning'; remaining: number }
  | { type: 'compaction.start' }
  | { type: 'compaction.end'; removed: number }
  // ... 其他内部事件

/**
 * 事件转换器（内部事件 → 公开事件）
 */
export function toPublicEvent(
  event: InternalEvent
): SessionStreamEvent | null {
  switch (event.type) {
    case 'content.delta':
      return { type: 'content', delta: event.delta };
    case 'tool.completed':
      return { type: 'tool.result', id: event.id, result: event.result };
    case 'budget.warning':
    case 'compaction.start':
      return null;  // 内部事件，不暴露
    default:
      return event as SessionStreamEvent;  // 大部分直接透传
  }
}
```

---

### 3.7 协议类型（`types/protocol/`）

#### `protocol/wire.ts`

```ts
/**
 * 协议版本（语义化版本）
 */
export const PROTOCOL_VERSION = '2.0.0' as const;

/**
 * Agent 命令（客户端 → 服务器）
 */
export type AgentCommand =
  | { type: 'session.create'; config: AgentConfig }
  | { type: 'session.send'; sessionId: SessionId; message: string }
  | { type: 'session.abort'; sessionId: SessionId }
  | { type: 'session.close'; sessionId: SessionId };

/**
 * Agent 事件（服务器 → 客户端）
 */
export type AgentWireEvent =
  | { type: 'session.created'; sessionId: SessionId }
  | { type: 'session.event'; sessionId: SessionId; event: SessionStreamEvent }
  | { type: 'session.error'; sessionId: SessionId; error: WireError }
  | { type: 'session.closed'; sessionId: SessionId };

/**
 * 错误表示（序列化安全）
 */
export type WireError = {
  message: string;
  code?: string;
  details?: Record<string, unknown>;
};
```

---

## 第四部分：类型导出策略

### 4.1 主入口（`@blade-ai/agent-sdk`）

```ts
// src/index.ts

// ── 创建 API ──────────────────────────────────
export { createAgent } from './agent/Agent.js';
export { defineTool } from './tools/builder.js';

// ── 配置类型 ──────────────────────────────────
export type {
  AgentConfig,
  AgentCoreConfig,
  AgentBehaviorConfig,
  AgentAdvancedConfig,
} from './types/config/agent.js';

export type {
  PermissionConfig,
  PermissionPreset,
  PermissionHandler,
} from './types/config/permission.js';

// ── API 类型 ──────────────────────────────────
export type {
  Agent,
} from './types/api/agent.js';

export type {
  AgentResponse,
  ResponseResult,
  SessionStreamEvent,
  SessionEventType,
} from './types/api/response.js';

export type {
  ToolBuilder,
  ToolExecutor,
  ToolContext,
  ToolResult,
  ToolProgress,
} from './types/api/tool-builder.js';

// ── 领域类型 ──────────────────────────────────
export type {
  Message,
  Content,
  Role,
} from './types/domain/message.js';

export type {
  ToolKind,
  ToolSideEffect,
} from './types/domain/tool.js';

export {
  SessionId,
  AgentId,
  ToolId,
  MessageId,
} from './types/ids.js';

// ── 错误类型 ──────────────────────────────────
export {
  SdkError,
  ConfigError,
  PermissionDeniedError,
  ToolExecutionError,
} from './errors/index.js';
```

### 4.2 浏览器入口（`@blade-ai/agent-sdk/browser`）

```ts
// src/browser/index.ts

// ── 浏览器客户端 ──────────────────────────────
export { AgentClient } from './client.js';

// ── 协议类型 ──────────────────────────────────
export type {
  AgentCommand,
  AgentWireEvent,
  WireError,
} from '../types/protocol/wire.js';

export { PROTOCOL_VERSION } from '../types/protocol/wire.js';

// ── 配置类型（浏览器需要发送给服务器）──────
export type {
  AgentConfig,
} from '../types/config/agent.js';

// ── 事件类型（浏览器需要订阅）──────────────
export type {
  SessionStreamEvent,
  SessionEventType,
} from '../types/api/response.js';
```

### 4.3 高级入口（`@blade-ai/agent-sdk/advanced`）

```ts
// src/advanced/index.ts

// ── 扩展点 ────────────────────────────────────
export type {
  SessionRunner,
  SessionRunContext,
  SessionRunResult,
} from '../server/SessionRunner.js';

export type {
  AgentRuntimeDeps,
} from '../agent/Agent.js';

export type {
  ToolCatalog,
  ToolCatalogEntry,
} from '../tools/catalog/index.js';

// ── 内部类型（供扩展使用）────────────────────
export type {
  RuntimeTool,
} from '../types/domain/tool.js';

export type {
  InternalContext,
} from '../types/internal/context.js';

// ── 中间件 ────────────────────────────────────
export type {
  ModelMiddleware,
  ToolMiddleware,
  Middleware,
} from '../middleware/index.js';
```

---

## 第五部分：拆分实施路径

### Phase 1: 建立新类型系统（10-12 天）

**目标：** 定义所有新类型，不改任何实现

**工作内容：**

1. **Day 1-2: 基础类型**
   - 创建 `src/types/` 目录结构
   - 实现 `ids.ts`（品牌类型）
   - 实现 `domain/message.ts`, `domain/tool.ts`, `domain/permission.ts`

2. **Day 3-4: 配置类型**
   - 实现 `config/agent.ts`（分层配置）
   - 实现 `config/permission.ts`（统一权限）
   - 实现 `config/tool.ts`, `config/model.ts`

3. **Day 5-6: API 类型**
   - 实现 `api/agent.ts`
   - 实现 `api/response.ts`（事件类型）
   - 实现 `api/tool-builder.ts`（ToolBuilder 与泛型推导）

4. **Day 7-8: 内部类型**
   - 实现 `internal/session.ts`
   - 实现 `internal/context.ts`
   - 实现 `internal/events.ts`（含 `toPublicEvent` 转换器）

5. **Day 9-10: 协议类型**
   - 实现 `protocol/wire.ts`
   - 实现 `protocol/codec.ts`（序列化/反序列化）
   - 实现 `protocol/version.ts`

6. **Day 11-12: 导出策略**
   - 配置所有入口的 `index.ts`
   - 写文档：`docs/types/README.md`（类型系统导览）
   - 写文档：`docs/types/migration.md`（从旧类型迁移指南）

**产出：**
- 完整的新类型系统
- 所有新类型标记为 `@beta`
- 类型导出文档

**验证：**
```bash
pnpm run build  # 确保新类型编译通过
pnpm run type-check  # 确保没有类型错误
```

---

### Phase 2: 实现新 API 层（8-10 天）

**目标：** 基于新类型实现 `createAgent()` 和 `defineTool()`

**工作内容：**

1. **Day 1-2: `defineTool()` 实现**
   - 实现 `tools/builder.ts`
   - 支持 Zod schema 自动推导参数类型
   - 支持 async function 和 async generator 两种形式
   - 内部转换为 `RuntimeTool`

2. **Day 3-4: `createAgent()` facade**
   - 实现 `agent/createAgent.ts`
   - 接受 `AgentConfig`（分层配置）
   - 内部转换为旧的 `SessionOptions`
   - 返回 `Agent` 接口实例

3. **Day 5-6: `AgentResponse` 实现**
   - 实现 `agent/AgentResponse.ts`
   - 实现 `.text()`, `.textStream()`, `.on()`, `.result()`
   - 底层基于现有的 `session.stream()`
   - 实现 `toPublicEvent()` 转换器

4. **Day 7-8: 集成测试**
   - 写示例：`examples/quickstart/` 使用新 API
   - 写集成测试：`tests/integration/new-api.test.ts`
   - 确保新 API 可以完整运行

5. **Day 9-10: 文档**
   - 更新 README.md 为新 API
   - 写 `docs/api/agent.md`
   - 写 `docs/api/tool.md`

**产出：**
- 新 API 完全可用
- 旧 API 仍然可用（未删除）
- 新 API 文档完整

**验证：**
```bash
cd examples/quickstart
node index.mjs  # 新 API 可以运行
pnpm test       # 所有测试通过
```

---

### Phase 3: 内部迁移（12-15 天）

**目标：** 内部代码全部切换到新类型

**工作内容：**

1. **Day 1-3: Session 内部迁移**
   - `Session.ts` 内部使用 `InternalContext`
   - 保持 `ISession` 接口不变（兼容旧 API）
   - 事件分发使用 `toPublicEvent()` 转换

2. **Day 4-6: Agent 内部迁移**
   - `Agent.ts` 内部使用新的 `InternalSessionData`
   - `AgentLoop` 使用新的 `InternalEvent`
   - 保持对外接口不变

3. **Day 7-9: Tool 系统迁移**
   - `ToolCatalog` 使用 `RuntimeTool`
   - `ExecutionPipeline` 使用新的 `ToolContext`
   - 所有内置工具用 `defineTool()` 重写

4. **Day 10-12: 测试覆盖**
   - 补充单元测试到 70%+ 覆盖率
   - 补充集成测试覆盖关键路径
   - E2E 测试覆盖生产场景

5. **Day 13-15: 清理**
   - 删除旧类型（`SessionOptions`, `AgentOptions` 等）
   - 删除旧 API 的兼容层
   - 更新所有 import 路径

**产出：**
- 内部代码 100% 使用新类型
- 旧类型和旧 API 完全删除
- 测试覆盖率 ≥ 70%

**验证：**
```bash
pnpm run build
pnpm test  # 所有测试通过
pnpm run example:production  # 生产示例可以运行
```

---

### Phase 4: 入口精简与文档（5-7 天）

**目标：** 精简入口点，完善文档

**工作内容：**

1. **Day 1-2: 入口精简**
   - 废除 `/core`, `/model`, `/session`, `/tools`, `/middleware` 独立入口
   - 保留 `/browser`, `/advanced`
   - 更新 `package.json` 的 `exports` 字段

2. **Day 3-4: API 文档生成**
   - 配置 TypeDoc
   - 生成 API 文档到 `docs/api/`
   - 写 `docs/types/architecture.md`（类型架构说明）

3. **Day 5-7: 用户指南**
   - 写 `docs/guide/getting-started.md`（5 分钟快速开始）
   - 写 `docs/guide/tools.md`（自定义工具）
   - 写 `docs/guide/advanced.md`（生产部署）
   - 写 `docs/guide/migration.md`（从 v7 迁移）

**产出：**
- 入口点从 11 个精简到 3 个
- 完整的 API 文档
- 完整的用户指南

---

## 总工期估算

| Phase | 工作内容 | 工期 |
|-------|----------|------|
| Phase 1 | 建立新类型系统 | 10-12 天 |
| Phase 2 | 实现新 API 层 | 8-10 天 |
| Phase 3 | 内部迁移 | 12-15 天 |
| Phase 4 | 入口精简与文档 | 5-7 天 |
| **总计** | | **35-44 天** |

如果是 2 人团队，Phase 1 和 Phase 2 可以并行，总工期可以压缩到 **25-30 天**。

---

## 验收标准

### Phase 1 完成标准

- [ ] 所有新类型定义完成，编译通过
- [ ] 类型系统文档完整（README + 迁移指南）
- [ ] 导出策略文档完整

### Phase 2 完成标准

- [ ] `createAgent()` 可以创建 agent
- [ ] `defineTool()` 可以定义工具，泛型推导正确
- [ ] `AgentResponse` 的所有方法可用
- [ ] quickstart 示例可以运行
- [ ] 新 API 文档完整

### Phase 3 完成标准

- [ ] 内部代码 100% 使用新类型
- [ ] 旧类型和旧 API 完全删除
- [ ] 测试覆盖率 ≥ 70%
- [ ] 所有 examples 运行正常

### Phase 4 完成标准

- [ ] 入口点精简到 3 个
- [ ] API 文档自动生成
- [ ] 用户指南完整（快速开始 + 自定义工具 + 生产部署 + 迁移）
- [ ] 发布 v8.0.0

---

## 附录：关键设计决策说明

### 为什么 `AgentConfig` 要分三层？

**原因：** 新手只需要看到 2-3 个必填字段，老手可以在 `advanced` 里找到所有高级选项。这是"渐进式披露"的设计模式。

### 为什么工具定义要用 Zod？

**原因：** Zod 提供类型级别的约束，`z.infer<TSchema>` 可以自动推导参数类型，保证 `parameters` 和 `execute` 的参数类型一致。这是唯一能在编译期保证类型安全的方案。

### 为什么要区分 `InternalEvent` 和 `SessionStreamEvent`？

**原因：** 内部事件包含所有细节（32 种），公开事件是稳定的协议（17 种）。内部事件可以随时增加，不影响公开 API。

### 为什么要用品牌类型（branded types）？

**原因：** 防止 ID 混用。`SessionId` 和 `AgentId` 都是 `string`，但品牌类型让 TypeScript 把它们当作不同类型，避免 `agent.send(sessionId)` 这种错误。

### 为什么 `ToolContext` 是窄接口？

**原因：** 工具不应该依赖太多内部细节。`ToolContext` 只暴露工具需要的能力（`signal`, `confirm`, `progress`），内部的 `backgroundAgents` 和 `executionLease` 对工具不可见。
