# API 参考

`@blade-ai/agent-sdk` 根包保持 session-first 体验，面向 Node server 和 CLI 场景。浏览器端应优先从 `@blade-ai/agent-sdk/core` 导入类型、协议和常量；误导入 root、`server`、`session` 或 `local` 入口时会解析到 browser stub，并在调用 server-only API 时抛出清晰错误。

## 包入口

| 入口 | 运行环境 | 说明 |
|------|---------|------|
| `@blade-ai/agent-sdk` | Node server / CLI | 默认 session-first 入口，导出 `createSession()` 等完整 server runtime API |
| `@blade-ai/agent-sdk/server` | Node server / CLI | 显式 server 入口，等价于 server-only root facade |
| `@blade-ai/agent-sdk/session` | Node server / CLI | Session API 子入口 |
| `@blade-ai/agent-sdk/core` | Browser-safe / Node | 类型、协议、事件、常量，不导入 Node-only runtime |
| `@blade-ai/agent-sdk/browser` | Browser | Browser-safe 常量和 server-only stub |
| `@blade-ai/agent-sdk/tools` | Browser-safe / Node | 工具定义、工具类型、工具目录等不依赖本地执行器的 API |
| `@blade-ai/agent-sdk/local` | Node server / CLI | 内置工具、MCP、memory、sandbox 等 Node 本地能力 |

## 函数

下表“逻辑模块”用于分类，不代表可导入的 package subpath。除特别标注的
Node-local 能力外，这些函数都从根入口导出；实际 subpath 以“包入口”表为准。

| 函数 | 逻辑模块 | 说明 |
|------|------|------|
| `createSession` | session | 创建新会话 |
| `resumeSession` | session | 恢复会话 |
| `forkSession` | session | 分叉会话 |
| `prompt` | session | 一次性调用 |
| `defineTool` | tools | 定义工具（简单模式） |
| `createTool` | tools | 创建工具（Zod 模式） |
| `toolFromDefinition` | tools | 转换 ToolDefinition → Tool |
| `getBuiltinTools` | root / local | 获取内置工具 |
| `createMemoryReadTool` | root / local | 创建 opt-in MemoryRead 工具 |
| `createMemoryWriteTool` | root / local | 创建 opt-in MemoryWrite 工具 |
| `tool` | root / local | 定义 MCP 工具 |
| `createSdkMcpServer` | root / local | 创建进程内 MCP Server |
| `createContextSnapshot` | runtime | 创建上下文快照 |
| `mergeContext` | runtime | 合并上下文 |
| `hasFilesystemCapability` | runtime | 检查文件系统能力 |
| `createCompositePermissionHandler` | permissions | 组合多个权限处理器 |
| `createModePermissionHandler` | permissions | 基于权限模式创建处理器 |
| `createPathSafetyPermissionHandler` | permissions | 基于路径安全策略创建处理器 |
| `createPermissionHandlerFromCanUseTool` | permissions | 从 canUseTool 回调创建处理器 |
| `createRuleBasedPermissionHandler` | permissions | 基于规则创建处理器 |
| `collectToolExecution` | root / core / tools | 消费工具执行并返回最终结果 |
| `completeToolExecution` | root / core / tools | 将单个结果包装成工具执行 |
| `calculateDeepSeekCost` 等 | root | DeepSeek 调用、成本、缓存和长上下文辅助函数 |
| `registerCleanup` / `gracefulShutdown` | root | 注册和执行进程级清理 |
| `getErrorMessage` 等 | root | 安全提取未知错误信息 |

## 类 / 运行时对象

| 名称 | 来源 | 说明 |
|------|------|------|
| `ToolCatalog` | tools/catalog | 工具目录，管理来源追踪、信任分级和策略过滤 |
| `FileSystemMemoryStore` | memory | 文件系统 memory 适配器 |
| `MemoryManager` | memory | memory 编排层 |
| `SubagentRegistry` | subagents | 注册和发现子 Agent |
| `SubagentExecutor` | subagents | 执行单个子 Agent |
| `JsonlDurableEventStore` | root / local | Node.js 单进程 durable event JSONL adapter |
| `SessionInputError` | session | 输入队列容量、请求匹配或活动请求选项错误 |
| `SdkError` 及派生错误 | root | 类型化 SDK 错误层级 |

## 常量 / 枚举

| 名称 | 值 |
|------|------|
| `PermissionMode` | `DEFAULT` / `AUTO_EDIT` / `YOLO` / `PLAN` |
| `HookEvent` | `SessionStart` / `SessionEnd` / `UserPromptSubmit` / `PermissionRequest` / `PreToolUse` / `PostToolUse` / `PostToolUseFailure` / `TaskCompleted` / `Stop` / `SubagentStart` / `SubagentStop` / `Notification` / `Compaction` / `StopFailure` / `PreCompact` / `PostCompact` / `Elicitation` / `ElicitationResult` / `ConfigChange` / `CwdChanged` / `FileChanged` / `InstructionsLoaded` |
| `ToolKind` | `ReadOnly` / `Write` / `Execute` |
| `InputPriority` | `NOW` / `NEXT` / `LATER` |
| `StreamMessageType` | 包含 `TURN_INTERRUPTED` / `INPUT_APPLIED` 及内容、工具、用量、结果事件 |
| `MessageRole` | `SYSTEM` / `USER` / `ASSISTANT` / `TOOL` |
| `PermissionDecision` | `ALLOW` / `DENY` / `ASK` |

## 类型

### Session

| 类型 | 说明 |
|------|------|
| `ISession` | Session 实例接口 |
| `SessionOptions` | Session 创建选项 |
| `SessionTool` | Session 接受的 `ToolDefinition` 或完整 `Tool` 联合类型 |
| `SendOptions` | send() 选项 |
| `InputSubmission` | 输入被 started / steered / queued 的判别联合 |
| `PendingSessionInput` | 尚未应用的持久化输入 |
| `InputId` / `RequestId` / `SessionId` | 输入、活动请求与会话的 branded identifiers |
| `EventId` / `EventSequence` | durable event 标识与 Session 内单调序列 |
| `CommandId` / `TurnId` / `ToolAttemptId` / `PermissionRequestId` | durable command、turn、工具尝试与权限请求标识 |
| `StreamOptions` | stream() 选项 |
| `StreamMessage` | Session 流式消息联合类型 |
| `PromptResult` | prompt() 返回结果 |
| `ResumeOptions` | resume 选项 |
| `ForkOptions` | fork 选项 |
| `ForkSessionOptions` | Session fork 选项 |
| `ForkSessionResult` | Session fork 结果 |

### Durable Events

| 导出 | 说明 |
|------|------|
| `DurableEventStore` | append/read/head 的持久化接口 |
| `DurableEventSubscription` | 支持 replay/caught-up/live 阶段的可重连事件流 |
| `durableEventCursor` / `parseDurableEventCursor` | 创建和严格解析版本化恢复 cursor |
| `DurableSessionJournal` / `DurableSessionJournalOptions` | command-oriented 串行提交、CAS 重试与对账层 |
| `DurableSessionRecoveryCoordinator` | Request/Turn rollover、权限消解及工具与 Request 结果对账协调器 |
| `DurableSessionCommand` / `DurableCommandEventDraft` | Journal command 与不含重复 `commandId` 的事件输入 |
| `DurableCommandCommitOptions` | 通过 `expectedHeadSequence` 固定状态派生 command 的前置 head |
| `DurableCommandCommitResult` / `DurableCommandCommitStatus` | `committed` / `replayed` / `reconciled` 提交结果 |
| `DurableSessionJournalError` / `DurableSessionJournalErrorCode` | command、分页和 Store 返回值错误 |
| `DurableCommandConflictError` | 同一 `commandId` 被用于不同事件 |
| `DurableCommandOutcomeUnknownError` | 写入失败后无法确认 command 是否提交 |
| `DurableSessionRecoveryError` / `DurableSessionRecoveryErrorCode` | 恢复目标缺失或状态不满足恢复契约 |
| `DurableSessionRecoveryRequiredError` | Session 恢复前需要权限或工具结果对账 |
| `SessionDurableRecorderError` | Session runtime 观察到非法 durable 生命周期状态 |
| `DurableEventEnvelope` / `DurableEventDraft` | 已提交事件与待提交事件 |
| `DurableEventDataMap` / `DurableEventOfType` / `DurableEventError` / `DurableTokenUsage` | 事件类型到严格 payload 的映射、类型提取及公共 payload |
| `DurableInputPriority` / `DurablePermissionDecision` | 输入优先级与权限结果 |
| `DurableRequestInterruptReason` / `DurableTurnAbortReason` | Request 与 Turn 中断原因 |
| `DurableToolInterruptBehavior` / `DurableToolCancelReason` / `DurableToolOutcomeUnknownReason` | 工具中断、取消及未知结果原因 |
| `DurableSessionCloseReason` | Session 关闭原因 |
| `DurableEventAppendOptions` / `DurableEventAppendResult` | compare-and-append 参数与结果 |
| `DurableEventReadOptions` / `DurableEventPage` | cursor 分页读取参数与结果 |
| `DurableEventCursor` / `DURABLE_EVENT_CURSOR_VERSION` | 绑定 Session、sequence 和 event ID 的 cursor |
| `DurableEventSubscriptionOptions` / `DurableEventSubscriptionMessage` | 订阅配置与 event/caught-up 消息 |
| `DurableEventSubscriptionError` / `DurableEventSubscriptionErrorCode` | cursor、分页或订阅配置错误 |
| `DurableEventType` / `isDurableEventType` | 生命周期事件名及运行时类型判断 |
| `DurableSessionProjector` / `projectDurableSession` | 增量或一次性重建并校验 Session 生命周期 |
| `planDurableSessionRecovery` / `DurableSessionRecoveryPlan` | 分类未完成 Request、Turn、Tool 与 Permission |
| `DurableSessionProjection` / `DurableSessionProjectionStatus` | Session 当前 durable 状态及全局已对账输入 |
| `DurableRequestProjection` / `DurableRequestStatus` | 活动 Request 状态、已应用及已对账输入 |
| `DurableRequestRecoveryOrigin` | continuation Request 的 source Request/Turn provenance |
| `DurableRequestRecoveryKind` | 区分 active-Turn 与 synthetic pre-Turn recovery |
| `DurableTurnProjection` / `DurableTurnStatus` | 活动 Turn 状态 |
| `DurableToolAttemptProjection` / `DurableToolAttemptStatus` | 当前 Turn 的工具尝试状态 |
| `DurablePermissionProjection` / `DurablePermissionStatus` | 工具权限状态 |
| `DurableSessionRecoveryAction` | 恢复动作判别值 |
| `DurableAcceptedRequestRecovery` | 可自动恢复且带完整执行快照的 accepted Request |
| `DurableSessionResumeDecision` | `ready` / `resume_accepted_request` / `recovery_required` 决策 |
| `DurableRequestRolloverCommand` / `DurableRequestRolloverResult` | 首个 Turn 前的原子 Request rollover 命令及结果 |
| `DurableRequestOutcomeReconciliation` / `DurableRequestOutcomeReconciliationCommand` | Turn 后缺失 Request 终态时的显式对账输入 |
| `DurableToolOutcomeReconciliation` / `DurableToolOutcomeReconciliationCommand` | 显式工具结果对账输入 |
| `DurableToolStartCommand` | 恢复执行前持久化 `tool_started` 的幂等命令 |
| `DurableTurnRecoveryCommand` / `DurableTurnRecoveryResult` | 原子 Turn rollover 命令及结果 |
| `DurablePermissionResolutionCommand` | 幂等权限消解输入 |
| `DurableRecoveryCommitResult` | 对账提交结果及更新后的 projection/recovery plan |
| `DURABLE_EVENT_SCHEMA_VERSION` / `DURABLE_EVENT_LOG_FORMAT` | wire schema 与日志格式版本 |
| `DurableEventProjectionError` | 生命周期事件顺序或关联关系非法 |
| `DurableEventSequenceConflictError` | CAS 序列冲突错误 |
| `DurableEventStoreError` / `DurableEventStoreErrorCode` | 参数、I/O 和日志损坏错误 |
| `parseDurableEventDraft` / `parseDurableEventEnvelope` | 严格 schema 解析 |
| `parsePersistedDurableEventBatch` / `PersistedDurableEventBatch` | JSONL batch 解析与类型 |

### 工具

| 类型 | 说明 |
|------|------|
| `Tool` | 内部工具接口 |
| `ToolConfig` | 工具配置 |
| `ToolSchema` | 工具 Schema |
| `ToolBehavior` | 工具行为配置 |
| `ToolSideEffect` | 工具副作用契约：`pure` / `idempotent` / `non_idempotent` |
| `ToolEffect` | 工具副作用描述 |
| `ToolDefinition` | 工具定义接口 |
| `ToolDescription` | 工具描述（短描述/长描述/使用提示/示例） |
| `ToolDescriptionResolver` | 动态工具描述解析器 |
| `ToolExecution` | 工具的异步生成器执行契约 |
| `ToolExecutionLifecycle` | Request 级工具 scheduled / settled 持久化边界 |
| `ToolExecutionStartedLifecycle` | 最终执行输入与解析后副作用等级 |
| `ToolInvocationLifecycle` | 单次工具权限与副作用开始边界 |
| `ToolScheduledLifecycle` / `ToolSettledLifecycle` | 工具调度与终态 payload |
| `ToolPermissionResolution` | 权限请求的 durable 决策 payload |
| `ToolYield` | 工具产生的结构化进度、展示消息或 effect |
| `ToolProgress` | 可选包含计数、结构化数据和恢复令牌的进度事件 |
| `ToolMessage` | 面向用户界面的执行消息 |
| `ToolEffectYield` | 工具产生的运行时 effect 事件 |
| `ToolResult` | 工具执行的最终成功/失败结果 |
| `ToolModelContent` | 回写模型上下文的工具内容 |
| `ToolDisplayContent` | 展示给用户的工具内容 |
| `ExecutionContext` | 工具执行上下文 |
| `ToolCallRecord` | 工具调用记录 |
| `ToolExposureConfig` | 工具暴露配置 |
| `ToolExposureMode` | 工具暴露模式 |
| `ToolExecutionUpdate` | 工具执行过程更新事件 |
| `FunctionDeclaration` | 函数声明（JSON Schema 格式） |

`ToolBehavior.sideEffect` 必须显式声明并决定 started tool 是否可在恢复时重放。
`ToolBehavior.interruptBehavior` 默认为 `block`。只有能够观察 `AbortSignal` 并可靠清理资源的工具才应声明为 `cancel`。

### 工具目录

| 类型 | 说明 |
|------|------|
| `ToolCatalogEntry` | 工具目录条目 |
| `ToolCatalogReadView` | 工具目录只读视图接口 |
| `ToolCatalogSourcePolicy` | 工具来源策略（按来源类型和信任级别过滤） |
| `ToolSourceInfo` | 工具来源信息 |
| `ToolSourceKind` | 工具来源类型（`builtin` / `custom` / `mcp` / `session`） |
| `ToolTrustLevel` | 工具信任级别（`trusted` / `workspace` / `remote`） |

### Memory

| 类型 | 说明 |
|------|------|
| `Memory` | Memory 记录类型 |
| `MemoryInput` | Memory 写入输入类型 |
| `MemoryStore` | Memory 后端抽象接口 |
| `MemoryType` | Memory 类型（`user` / `feedback` / `project` / `reference`） |

`createMemoryReadTool()` 和 `createMemoryWriteTool()` 返回完整 `Tool`，可直接
传给 `SessionOptions.tools`。

### Provider

| 类型 | 说明 |
|------|------|
| `ProviderConfig` | Provider 配置 |
| `ProviderType` | Provider 类型字面量 |
| `ModelInfo` | 模型信息 |
| `TokenUsage` | Token 用量 |

### MCP

| 类型 | 说明 |
|------|------|
| `McpServerConfig` | MCP 服务器配置 |
| `McpServerStatus` | MCP 服务器状态 |
| `McpToolInfo` | MCP 工具信息 |
| `McpToolCallResponse` | MCP 工具调用响应 |
| `McpToolDefinition` | MCP 工具定义 |
| `McpToolResponse` | MCP 工具响应（ToolResponse 别名） |
| `SdkTool` | SDK MCP 工具 |
| `SdkMcpServerHandle` | MCP Server 句柄 |

### 权限

| 类型 | 说明 |
|------|------|
| `CanUseTool` | 权限回调类型 |
| `CanUseToolOptions` | 权限回调选项 |
| `PermissionResult` | 权限判定结果 |
| `PermissionHandler` | 底层权限处理器接口 |
| `PermissionHandlerRequest` | 权限处理请求 |
| `PermissionRuleValue` | 权限规则值 |
| `PermissionUpdate` | 权限更新 |

### Hooks

| 类型 | 说明 |
|------|------|
| `HookCallback` | Hook 回调函数类型 |
| `HookInput` | Hook 输入 |
| `HookOutput` | Hook 输出 |

`HookEvent` 包含 22 个文件 Hook 事件；`SessionOptions.hooks` 只接受
`SessionStart`、`SessionEnd`、`UserPromptSubmit`、`PermissionRequest`、
`PreToolUse`、`PostToolUse`、`PostToolUseFailure` 和 `TaskCompleted` 这 8 个
内联事件。

### 运行时

| 类型 | 说明 |
|------|------|
| `RuntimeContext` | 运行时上下文 |
| `RuntimePatch` | 运行时补丁（Skill 激活等场景使用） |
| `RuntimePatchScope` | 运行时补丁作用域（`turn` / `session`） |
| `RuntimePatchSkillInfo` | 运行时补丁的 Skill 信息 |
| `RuntimeToolPolicyPatch` | 工具策略补丁 |
| `RuntimeToolDiscoveryPatch` | 工具发现补丁 |
| `RuntimeModelOverride` | 模型覆盖配置 |
| `RuntimeHookEvent` | 运行时 Hook 事件 |
| `RuntimeHookRegistration` | 运行时 Hook 注册 |
| `RuntimeContextPatch` | 运行时上下文补丁 |
| `ContextSnapshot` | 上下文快照 |
| `OutputFormat` | 输出格式约束 |
| `SandboxSettings` | 沙箱配置 |

### 子 Agent

| 类型 | 说明 |
|------|------|
| `AgentDefinition` | 子 Agent 定义 |
| `SubagentInfo` | 子 Agent 信息 |
| `SubagentConfig` | 子 Agent 配置（含 `contextOmissions` 字段） |
| `SubagentContext` | 子 Agent 执行上下文 |
| `SubagentResult` | 子 Agent 执行结果 |
| `SubagentSource` | 子 Agent 来源类型 |
| `SubagentColor` | 子 Agent 颜色标识 |

### 日志

| 类型 | 说明 |
|------|------|
| `AgentLogger` | 日志接口 |
| `LogEntry` | 日志条目 |
| `LogLevelName` | 日志级别 |

### Observability 与错误

| 类型 | 说明 |
|------|------|
| `ObservabilityOptions` | Trace 开关、payload 捕获和 sink 配置 |
| `AgentTrace` / `TraceEvent` / `TraceSpan` | 一次 Agent 请求的结构化执行轨迹 |
| `TracePayloadSummary` / `TraceSink` | Trace 摘要与输出接口 |
| `TraceSpanKind` / `TraceStatus` | Span 类型与状态 |
| `SdkErrorOptions` / `SessionInputErrorCode` | SDK 错误元数据 |
| `TokenBudgetConfig` / `TokenBudgetSnapshot` | 跨轮次 token 预算配置与快照 |

### 错误、生命周期与标识符

| 导出 | 说明 |
|------|------|
| `SdkError` / `AbortError` / `ConfigError` | SDK 基础错误、中止错误与配置错误 |
| `PermissionDeniedError` / `ToolExecutionError` | 权限与工具执行错误 |
| `getErrorCode` / `getErrorMessage` / `getErrorName` / `toError` | 未知错误规范化辅助函数 |
| `registerCleanup` / `gracefulShutdown` / `resetCleanupRegistry` | 进程级清理生命周期 |
| `CleanupFn` / `CleanupHandle` / `GracefulShutdownOptions` | 清理生命周期类型 |
| `AgentId` / `MessageId` / `ToolUseId` | Agent、消息和工具调用 branded identifiers |
| `JsonObject` / `JsonValue` | 严格 JSON 类型 |
| `Assert` / `Extends` / `IsEqual` / `KeysEqual` | 编译期类型断言辅助类型 |
| `lazySingleton` | 惰性单例辅助函数 |

### Hook 协议

除 Session 内联 Hook 类型外，根入口还导出：

- `getHookSchemas`
- `DecisionBehavior`
- `HookExitCode`
- `HookType`

### DeepSeek 辅助 API

函数与运行时值：

- `calculateDeepSeekCost`
- `createDeepSeekBatchChatCompletions`
- `createDeepSeekChatCompletion`
- `createDeepSeekFimCompletion`
- `createDeepSeekLongContextChunks`
- `createDeepSeekLongContextMessages`
- `createDeepSeekLongContextPlan`
- `createDeepSeekTokenBudgetCostConfig`
- `estimateDeepSeekTokens`
- `getDeepSeekPricing`
- `normalizeDeepSeekModel`
- `optimizeDeepSeekCachePrefix`
- `resolveDeepSeekBaseUrl`
- `sanitizeDeepSeekStrictSchema`
- `summarizeDeepSeekBatchChatCompletions`
- `DEEPSEEK_BETA_BASE_URL`
- `DEEPSEEK_DEFAULT_BASE_URL`
- `DEEPSEEK_DEFAULT_MODEL`
- `DEEPSEEK_DEFAULT_PRICING`
- `DeepSeekCostTracker`

类型：

- `DeepSeekBatchChatCompletionItem`
- `DeepSeekBatchChatCompletionOptions`
- `DeepSeekBatchChatCompletionResult`
- `DeepSeekBatchChatCompletionSummary`
- `DeepSeekCacheOptimizationOptions`
- `DeepSeekChatCompletionOptions`
- `DeepSeekChatCompletionResponse`
- `DeepSeekChatMessage`
- `DeepSeekCostBreakdown`
- `DeepSeekCostSnapshot`
- `DeepSeekFimCompletionOptions`
- `DeepSeekFimCompletionResponse`
- `DeepSeekLongContextChunk`
- `DeepSeekLongContextOptions`
- `DeepSeekLongContextPlan`
- `DeepSeekPricing`
- `DeepSeekProviderOptions`

### 工具错误

- `ToolError`
- `ToolErrorType`
