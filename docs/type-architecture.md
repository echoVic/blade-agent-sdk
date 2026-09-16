# 类型架构

SDK 的类型按领域和边界归属，不按“通用类型”集中堆放。每个概念只有一个定义
位置；其他模块直接依赖该所有者，package entrypoint 只负责组织公开契约。

## 所有权

| 领域 | 所有者 | 代表类型 |
|------|--------|----------|
| Model | `src/model/` | `ModelMessage`、`ConversationMessage`、`ModelService`、`ModelUsage` |
| Agent | `src/agent/` | 公开 `AgentOptions` / `AgentResponse` / `UserMessageContent`，内部 `AgentRuntimeOptions` / `AgentExecutionContext` |
| Tool | `src/tools/types/` | `Tool`、`ToolDefinition`、authoring input、`ToolResult`、`ToolBehavior` |
| Session API | `src/session/types.ts` | `SessionOptions`、`SessionStreamEvent`、`PromptResult` |
| Transcript | `src/session/transcript.ts` | `TranscriptEvent`、`TranscriptMessage`、`TranscriptPart` |
| Durable journal | `src/session/events/` | `DurableEventEnvelope`、`DurableSessionProjection` |
| Remote protocol | `src/protocol/` | `AgentCommand`、`AgentCommandResult`、`AgentServerEvent` |
| Runtime Store | `src/server/RuntimeStore.ts` | `RuntimeCommandCommit`、`RuntimeDomainEvent`、`RuntimeEffectIntent` |
| Cross-domain primitives | `src/types/` | branded identifiers、JSON、permissions、logging |

`src/types/` 只承载真正跨领域的基础契约。业务配置、消息和事件不能放入
`common.ts` 一类的万能模块。

## Agent 配置与执行上下文

公开 Agent facade 与内部 Agent loop 使用不同 owner：

- `src/agent/createAgent.ts::AgentOptions` 是根入口唯一公开的 Agent 配置。
- `src/agent/types.ts::AgentRuntimeOptions` 只用于 Agent/LoopRunner 运行时。
- `SessionOptions` 是 `/advanced` 的低层 Session contract，不是
  `AgentOptions` 的重复定义。

内部 `AgentExecutionContext` 由 conversation state、execution control 和 runtime
services 三个窄接口组合。组合后的对象仍保持扁平，避免在 model/tool 热路径增加
包装对象；这些内部类型不从 package entrypoint 导出。

## Model 边界

模型层从 `@blade-ai/agent-sdk` 导出，且不依赖 Session、Node 本地能力或
具体 Provider SDK。

```ts
import type {
  ConversationMessage,
  ModelMessage,
  ModelService,
  ModelServiceConfig,
  ModelToolDefinition,
  ModelUsage,
  ProviderConnectionConfig,
} from '@blade-ai/agent-sdk';
```

配置类型按职责区分：

| 类型 | 职责 |
|------|------|
| `ProviderConnectionConfig` | 用户提供的 Provider 身份、凭据、endpoint 和 timeout |
| `ModelConfig` | 可注册、可切换的模型描述 |
| `ModelServiceConfig` | Provider adapter 创建 `ModelService` 时使用的规范化配置 |
| `ModelProviderOptions` | Provider 专属但仍为 JSON-safe 的请求扩展 |
| `ModelMessage` | 仅包含发送给模型的 provider-neutral 消息负载 |
| `ConversationMessage` | Agent/Session 使用的消息信封，承载来源、输入关联、遥测和扩展 |

`ModelUsage` 表示 Provider 返回的原始用量；`TokenUsage` 表示 Agent/Session
聚合后的预算视图。转换统一由 `normalizeModelUsage()` 完成。

`ModelMessage` 不提供通用 `metadata` 字典。SDK 控制字段必须放在
`ConversationMessage.provenance`、`correlation` 或 `telemetry` 中；
Provider 提示放在 `providerOptions` 中。只有不参与 SDK 控制流的应用数据可以
放入 `extensions`，核心逻辑不得读取 `extensions`。

## 事件层次

事件类型按生命周期分开，不能因为字段相似而复用：

| 类型 | 生命周期 | 是否持久化 | 是否为 wire 格式 |
|------|----------|------------|------------------|
| `AgentEvent` | 单次 Agent loop 内部执行 | 否 | 否 |
| `SessionStreamEvent` | Session 调用方消费的流 | 否 | 否 |
| `TranscriptEvent` | 对话消息和输入投影 | 是 | 否 |
| `DurableEventEnvelope` | 确定性恢复 journal | 是 | 否 |
| `RuntimeDomainEvent` | 原子 runtime transaction | 是 | 否 |
| `AgentServerEvent` | AgentClient/AgentServer 协议 | 可重放 | 是 |

转换应发生在边界实现中。内部事件不能直接伪装成协议事件，协议 `data` 也不能以
未验证的 `JsonObject` 进入 Session。

## 持久化端口

Session 持久化使用两个方向明确的端口：

```ts
interface SessionRepository extends SessionStore {
  initialize(): Promise<void>;
  // read projections, lifecycle, health, and capacity
}

interface SessionEventStore {
  // append transcript events
}
```

- `SessionRepository` 是只读投影和存储管理端口。
- `SessionEventStore` 是 transcript 追加端口。
- 同一个 adapter 可以显式实现两个端口，但 SDK 不再提供组合别名或自动能力探测。
- `Session` 必须同时获得兼容的读写端口，禁止写入一个 backend、从另一个
  backend 恢复。
- 本地 JSONL 与 PostgreSQL adapter 负责把存储 DTO 转回领域类型。

## Branded identifiers

`SessionId`、`MessageId`、`ToolUseId`、`CommandId`、`EventId`、
`EventSequence`、`ExecutionLeaseId`、`ExecutionId`、`ExecutionCheckpointId`
和 `CredentialLeaseId` 等均为 branded types。它们阻止不同 ID
在结构相同的情况下被误传。

```ts
const sessionId = SessionId(rawSessionId);
const commandId = CommandId(rawCommandId);
```

构造只允许出现在可信生成点或已经完成验证的边界：

- Zod protocol/transcript parser 完成字符串校验后。
- 数据库 adapter 读取受约束列并验证完整 payload 后。
- SDK 使用 `nanoid()` 创建新标识符时。

领域逻辑不得使用 `as SessionId`，也不得把 branded identifier 降级回普通
`string` 作为内部 API 参数。

## Schema 与 TypeScript

外部输入遵循先验证、后建模：

1. schema 接收 `unknown`。
2. parser 检查结构、枚举、数值范围和必填字段。
3. parser 在验证完成后构造 branded identifiers。
4. 领域层只接收解析后的类型。

JSON schema 的递归基础定义统一来自 `src/types/jsonSchema.ts`。
`SessionStreamEvent`、protocol event、transcript event 和 durable event 各自保留
独立 schema，因为它们的兼容性和演进策略不同。

## Tool 泛型

Tool authoring 只接受 TypeBox schema。`ToolDefinition<TSchema>` 和
`ToolDefinitionInput<TSchema>` 通过 `Type.Static<TSchema>` 推导 callback 参数；
同一个 schema 对象既是模型侧 JSON Schema，也是执行前的运行时验证依据，不存在
schema 格式转换或 advisory-only 旁路。

异构工具集合通过 Tool owner 定义的 `ErasedToolDefinition` 擦除 authoring
参数。Session 不直接写 `ToolDefinition<never>`。编译后的 runtime `Tool`
把模型声明和静态行为预计算为只读字段；`prepare()` 校验输入并返回内部不可变
调用快照：

```ts
interface Tool {
  readonly declaration: FunctionDeclaration;
  readonly staticBehavior: ToolBehavior;
  prepare(raw: unknown): ToolInvocation; // internal immutable snapshot
  execute(params: JsonObject, context?: ExecutionContext): ToolExecution;
}
```

`ToolInvocation` 不从公共入口导出。Hook 或权限处理器改写输入后，Pipeline 必须重新
调用 `prepare()`，不得修改既有 invocation 的参数、行为、路径或权限签名。
Catalog 和 Registry 不通过 `as unknown as Tool` 擦除工具参数类型。工具执行的
最终值统一为 `ToolResult`，模型侧函数定义统一为 `ModelToolDefinition`。

## 导出规则

- 源码内部优先直接导入所有者文件，避免通过根 barrel 形成循环依赖。
- barrel 使用显式导出表达公开契约，不使用大范围 `export *` 聚合业务类型。
- 根入口汇总应用侧 API 与公共类型；`/browser` 保持 browser-safe。
- 本地文件系统、Shell、进程、底层 Session 和集成扩展从 `/advanced` 导出。
- `AgentServer`、Worker、Runtime Store 和遥测 adapter 从 `/server/infra` 导出。
- 旧 subpath 仅作为 deprecated compatibility alias，不承载新的公开契约。
- 类型级测试辅助仅供源码内部使用，不属于 npm 公共 API。

## 变更检查

新增或修改类型时必须确认：

1. 类型是否位于拥有该概念的领域。
2. 是否重复了已有 DTO、usage、config、message 或 event。
3. 跨 wire、数据库或文件边界时是否先验证。
4. identifier 是否在边界构造并在内部保持品牌。
5. 新公开类型是否只从合理的 package entrypoint 导出。
6. browser-safe 入口是否引入了 Node-only 依赖。
7. schema、类型测试、API 文档和中英文文档是否同步。
