# API 参考

`@blade-ai/agent-sdk` 根包保持 session-first 体验，并采用服务端安全默认值。需要访问本机文件、进程或 Sandbox 的 Node.js 应用使用 `/node`；不应隐式访问宿主资源的服务端应用使用 `/server`。浏览器端应优先从 `/browser` 或 `/core` 导入类型、协议和常量；误导入 root、`server`、`session` 或 `node` 入口时会解析到 browser stub，并在调用 server-only API 时抛出清晰错误。

`/server` 当前面向 Node.js 服务进程，不是 Edge Runtime 入口。PostgreSQL、
OpenTelemetry、非内置 Provider adapter 与原生 Node 增强使用可选 peer dependency；
`/server` 不再静态加载对应 adapter。部分依赖仍可能由基础依赖间接安装。

## 包入口

| 入口 | 运行环境 | 说明 |
|------|---------|------|
| `@blade-ai/agent-sdk` | Node.js server | 默认服务端入口；仅加载显式配置的工具、Agent、middleware 和 MCP |
| `@blade-ai/agent-sdk/server` | Node.js server | 无隐式本机访问的服务端入口，行为等价于 root |
| `@blade-ai/agent-sdk/server/postgres` | Node.js server | PostgreSQL Runtime Store adapter |
| `@blade-ai/agent-sdk/server/otel` | Node.js server | OpenTelemetry metric、trace 与 audit adapter |
| `@blade-ai/agent-sdk/server/testing` | Node.js test | Runtime Store conformance suite |
| `@blade-ai/agent-sdk/node` | Node.js local process | 具备本机访问能力的入口；默认启用本地工具和工作区发现，并导出 Node 宿主适配器 |
| `@blade-ai/agent-sdk/session` | Node.js server | 底层 Session API 子入口，采用 server profile |
| `@blade-ai/agent-sdk/core` | Browser-safe / Node | 类型、协议、事件、常量，不导入 Node-only runtime |
| `@blade-ai/agent-sdk/browser` | Browser | `AgentClient`、协议类型、Browser-safe 常量和 server-only stub |
| `@blade-ai/agent-sdk/protocol` | Browser-safe / Node | 版本化 command/event schema、解析器和协议错误 |
| `@blade-ai/agent-sdk/tools` | Browser-safe / Node | 工具定义、工具类型、工具目录等不依赖本地执行器的 API |
| `@blade-ai/agent-sdk/middleware` | Browser-safe / Node | 洋葱组合器、模型/工具 middleware 与插件定义 |
| `@blade-ai/agent-sdk/model` | Browser-safe / Node | Provider 无关的模型配置、消息、服务、重试与用量契约 |

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
| `getBuiltinTools` | node | 获取内置 Node 本地工具 |
| `createMemoryReadTool` | node | 创建 opt-in MemoryRead 工具 |
| `createMemoryWriteTool` | node | 创建 opt-in MemoryWrite 工具 |
| `tool` | node | 定义 MCP 工具 |
| `createSdkMcpServer` | node | 创建进程内 MCP Server |
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
| `composeMiddleware` | root / core / middleware | 组合通用洋葱 middleware |
| `definePlugin` | root / core / middleware | 定义声明式 Agent 插件 |
| `wrapModelService` | root / core / middleware | 使用模型 middleware 包装 `ModelService` |
| `calculateDeepSeekCost` 等 | root | DeepSeek 调用、成本、缓存和长上下文辅助函数 |
| `registerCleanup` / `gracefulShutdown` | root | 注册和执行进程级清理 |
| `getErrorMessage` 等 | root | 安全提取未知错误信息 |

## 类 / 运行时对象

| 名称 | 来源 | 说明 |
|------|------|------|
| `ToolCatalog` | tools/catalog | 工具目录，管理来源追踪、信任分级和策略过滤 |
| `FileSystemMemoryStore` | node | 文件系统 memory 适配器 |
| `MemoryManager` | node | memory 编排层 |
| `SubagentRegistry` | subagents | 注册和发现子 Agent |
| `SubagentExecutor` | subagents | 执行单个子 Agent |
| `DurableExecutionLease` | durable events | 自动 heartbeat 的 Store-backed execution lease handle |
| `executionFence` | durable events | 从 lease snapshot 提取不可变的下游 fence |
| `isDurableExecutionLeaseStore` | durable events | 检查 Store 是否实现完整 execution lease 协议 |
| `DURABLE_EXECUTION_LEASE_FORMAT` | durable events | lease sidecar 的持久化格式标识 |
| `JsonlDurableEventStore` | node | 支持同机多进程锁的 Node.js durable event JSONL adapter |
| `DurableExecutionLeaseError` | durable events | lease 冲突、失租、缺少 fence 或状态损坏错误 |
| `AgentServer` | server | 多租户 command 调度、Session 管理和 Fetch-compatible HTTP/SSE transport |
| `InProcessSessionExecutor` | server | `SessionExecutor` 的进程内参考实现，负责 Session 生命周期与 stream pump |
| `SdkSessionRunner` | server | 在 worker fencing 下恢复并执行 durable SDK Session |
| `ExecutionHostSessionRunner` | server | 在隔离 ExecutionHost 中 provision、执行、checkpoint 和恢复 workload |
| `AgentWorker` | server | worker 注册、heartbeat、Session claim、lease 续期、恢复与 drain supervisor |
| `EffectDispatcher` | server | 消费持久化 outbox，并执行显式重试或 uncertain 收敛 |
| `AgentClient` / `RemoteAgentSession` | browser | 带 command 重试和 SSE cursor 重连的远程客户端 |
| `InMemoryAgentServerStore` | server | 单进程控制面参考 Store；不用于多实例生产部署 |
| `PostgresRuntimeStore` | server/postgres | 共享 command、event、outbox、projection 和 Session persistence |
| `RuntimeStoreError` | server | Runtime transaction 的稳定错误类型 |
| `TenantAdmissionController` | server | 每 tenant 并发、队列和固定窗口限流 |
| `OpenTelemetryAgentServerTelemetry` | server/otel | 默认不采集 payload 的 metric、trace 与 audit adapter |
| `JsonlSessionRepository` | node | Node.js transcript repository |
| `SessionInputError` | session | 输入队列容量、请求匹配或活动请求选项错误 |
| `SessionHandoffError` | session | handoff 配置、生命周期或活动后台工作前置条件错误 |
| `SdkError` 及派生错误 | root | 类型化 SDK 错误层级 |

## 常量 / 枚举

| 名称 | 值 |
|------|------|
| `PermissionMode` | `DEFAULT` / `AUTO_EDIT` / `YOLO` / `PLAN` |
| `HookEvent` | `SessionStart` / `SessionEnd` / `UserPromptSubmit` / `PermissionRequest` / `PreToolUse` / `PostToolUse` / `PostToolUseFailure` / `TaskCompleted` / `Stop` / `SubagentStart` / `SubagentStop` / `Notification` / `Compaction` / `StopFailure` / `PreCompact` / `PostCompact` / `Elicitation` / `ElicitationResult` / `ConfigChange` / `CwdChanged` / `FileChanged` / `InstructionsLoaded` |
| `ToolKind` | `ReadOnly` / `Write` / `Execute` |
| `InputPriority` | `NOW` / `NEXT` / `LATER` |
| `SessionStreamEventType` | 包含 `TURN_INTERRUPTED` / `INPUT_APPLIED` 及内容、工具、用量、结果事件 |
| `MessageRole` | `SYSTEM` / `USER` / `ASSISTANT` / `TOOL` |
| `PermissionDecision` | `ALLOW` / `DENY` / `ASK` |

## 类型

### Session

| 类型 | 说明 |
|------|------|
| `ISession` | Session 实例接口 |
| `SessionOptions` | Session 创建选项 |
| `SessionRepository` | transcript 的只读 projection 端口 |
| `SessionEventStore` | transcript domain event append 端口 |
| `SessionPersistence` | 组合 read projection 与 event append 的兼容端口 |
| `SessionRepositoryMessageMetadata` / `SessionRepositoryCompactionMetadata` | repository 消息与 compaction append 元数据 |
| `SessionRepositorySubagentInfo` / `SessionRepositorySubagentRef` | 子 Agent transcript 归属与结果引用 |
| `SessionRepositoryHealth` / `SessionRepositoryStorageStats` | repository 健康与容量统计 |
| `SessionTool` | Session 接受的 `ToolDefinition` 或完整 `Tool` 联合类型 |
| `SendOptions` | send() 选项 |
| `InputSubmission` | 输入被 started / steered / queued 的判别联合 |
| `PendingSessionInput` | 尚未应用的持久化输入 |
| `InputId` / `RequestId` / `SessionId` | 输入、活动请求与会话的 branded identifiers |
| `MessageId` / `PartId` / `ToolUseId` | transcript 消息、内容 part 与工具调用标识 |
| `EventId` / `EventSequence` | event 标识与 Session 内单调序列 |
| `CommandId` / `TurnId` / `ModelAttemptId` / `ToolAttemptId` / `PermissionRequestId` | durable command、turn、模型尝试、工具尝试与权限请求标识 |
| `WorkerId` / `ExecutionLeaseId` / `FencingToken` | worker、租约和单调 fence 的 branded identifiers |
| `TraceId` / `SpanId` / `TraceEventId` | trace、span 与 trace event 标识 |
| `StreamOptions` | stream() 选项 |
| `SessionStreamEvent` | Session 流式消息联合类型 |
| `PromptResult` | prompt() 返回结果 |
| `ResumeOptions` | resume 选项 |
| `ForkOptions` | fork 选项 |
| `ForkSessionOptions` | Session fork 选项 |
| `ForkSessionResult` | Session fork 结果 |
| `SessionHandoffResult` | worker handoff 完成后的 journal head 与 recovery plan |
| `SessionHandoffErrorCode` | worker handoff 的稳定错误码 |

### Server Runtime

| 导出 | 说明 |
|------|------|
| `AgentServerOptions` / `AgentServerSessionContext` | 认证、Session options、Store、遥测、准入和 transport 限制 |
| `SessionExecutor` / `SessionExecutorCommandContext` | command transport 与 Session 执行面的稳定边界 |
| `InProcessSessionExecutorOptions` | 进程内 executor 的 Store、Session resolver、event publisher 与容量配置 |
| `SessionExecutorEventPublisher` / `SessionExecutorReadResult` | executor 的事件输出与 Session read projection |
| `AgentServerStore` / `AgentCommandClaim` / `AgentServerSessionRecord` | command claim/seal/complete、tenant Session 和 event replay 端口 |
| `AgentServerTelemetry` / `AgentServerAuditRecord` | payload-free metric 与审计端口 |
| `AgentClientOptions` / `AgentClientCommandOptions` / `AgentClientEventOptions` | 浏览器 transport、重试和 cursor 选项 |
| `AgentCommand` / `AgentCommandResult` | protocol v1 command 与结果判别联合 |
| `AgentServerEvent` / `AgentEventCursor` / `AgentEventPage` | 单调 sequence 的远程事件与 cursor |
| `AgentPrincipal` / `AgentServerScope` | 服务端认证主体与授权 scope |
| `AgentProtocolCapabilities` / `AgentClientCapabilities` | 服务端与客户端能力描述 |
| `AgentInitializationData` | `initialize` 响应，包含协商能力与 `serverTime` |
| `AgentProtocolError` / `AgentProtocolErrorCode` | 稳定 wire error |
| `AGENT_PROTOCOL_VERSION` / `AgentCommandType` | 协议版本与 command 常量 |
| `parseAgentCommand` / `parseAgentCommandResult` | strict command envelope parser |
| `parseAgentEventCursor` / `parseAgentServerEvent` | strict event/cursor parser |
| `agentInitializationDataSchema` | strict initialize response schema |
| `RuntimeStore` / `RuntimeTenantStore` | 共享 authority 与 tenant-scoped Session/durable adapter |
| `RUNTIME_STORE_SCHEMA_VERSION` / `RUNTIME_DOMAIN_EVENT_SCHEMA_VERSION` | 数据库 schema 与 domain event schema 版本 |
| `RuntimeCommandCommit` / `RuntimeCommitResult` | 原子 command、event、effect、projection transaction |
| `RuntimeDomainEvent` / `RuntimeDomainEventDraft` / `RuntimeDomainEventPage` | Runtime domain event stream |
| `RuntimeEffectIntent` / `RuntimeEffectRecord` / `RuntimeEffectStatus` | Transactional outbox 类型 |
| `RuntimeProjectionCheckpoint` / `RuntimeProjectionRecord` | Projection CAS 与 checkpoint |
| `RuntimeWorkerRecord` / `RuntimeWorkerRegistration` | worker heartbeat、容量与 drain 状态 |
| `RuntimeSessionRoute` / `RuntimeSessionClaim` / `RuntimeSessionState` | Session 路由、含可重入 `idle` 的八态状态机与 execution lease |
| `RuntimeEffectClaim` / `RuntimeEffectLease` / `RuntimeEffectExecutionMode` / `RuntimeEffectReconciliation` | effect 领取、fencing、at-most-once 与人工对账语义 |
| `RuntimeEffectHandler` / `RuntimeEffectHandlerContext` | 类型化 outbox effect handler |
| `RetryableRuntimeEffectError` / `UncertainRuntimeEffectError` | 显式声明 effect 可重试或结果未知 |
| `SessionRunner` / `SessionRunnerContext` / `SessionRunResult` | 单个 fenced Session 的执行边界 |
| `WorkerRuntimeStore` / `WorkerRuntimeError` | worker 调度与恢复端口及稳定错误 |
| `assertRuntimeStoreConformance` | 不依赖测试框架的公开 Store conformance suite |

完整部署约束见 [Server Runtime](./server-runtime) 和
[Runtime Store](./runtime-store)，worker 调度见
[Worker Runtime](./worker-runtime)，隔离执行见
[Execution Host](./execution-host)。

### Execution Host

| 导出 | 说明 |
|------|------|
| `ExecutionHost` | `provision`、`exec`、`checkpoint`、`restore`、`terminate` 执行端口 |
| `ExecutionProvisionRequest` / `ExecutionHandle` | 镜像、workspace、资源、网络与执行句柄 |
| `ExecutionExecRequest` / `ExecutionExecResult` | 单次 command 输入与有界输出 |
| `ExecutionCheckpoint` / `ExecutionRestoreRequest` | workspace checkpoint 与恢复输入 |
| `ExecutionResourceLimits` / `ExecutionNetworkPolicy` / `ExecutionWorkspaceSource` | CPU、内存、磁盘、PID、运行时、输出、网络及 workspace 约束 |
| `ExecutionEgressController` / `ExecutionEgressLease` | proxy allowlist 的外部 enforcement 端口 |
| `CredentialBroker` / `CredentialIssuer` / `CredentialRequest` / `CredentialLease` | 单次 command 的短期凭据签发与撤销 |
| `CredentialIssueContext` / `IssuedCredential` | issuer 输入和有明确过期时间的签发结果 |
| `EphemeralCredentialBroker` | TTL 校验、失败回滚和自动撤销的参考 broker |
| `ExecutionHostError` / `ExecutionHostErrorCode` | 稳定的执行边界错误 |
| `ExecutionId` / `ExecutionCheckpointId` / `CredentialLeaseId` | 执行、checkpoint 和凭据 lease 的 branded ID |
| `DockerExecutionHost` / `DockerExecutionHostOptions` | `/node` 导出的 Docker 参考实现 |

### Durable Events

| 导出 | 说明 |
|------|------|
| `DurableEventStore` | append/read/head 的持久化接口 |
| `DurableExecutionLeaseStore` | 粘性 `requiresExecutionLease`、原子 acquire/renew/release/assert、`withExecutionLease` 与 fenced append 接口 |
| `DurableExecutionLeaseOptions` | Session lease 的 owner、TTL、heartbeat 和可选 lease ID |
| `DurableExecutionLeaseSnapshot` / `DurableExecutionFence` | 当前租约快照及传递给 Store/工具的 fence |
| `DurableExecutionLeaseErrorCode` | lease 配置、冲突、缺少 fence、失租、损坏与写入错误码 |
| `DurableEventSubscription` | 支持 replay/caught-up/live 阶段的可重连事件流 |
| `durableEventCursor` / `parseDurableEventCursor` | 创建和严格解析版本化恢复 cursor |
| `DurableSessionJournal` / `DurableSessionJournalOptions` | command-oriented 串行提交、CAS 重试与对账层 |
| `DurableSessionRecoveryCoordinator` | Request/Turn rollover、权限消解及模型、工具与 Request 结果对账协调器 |
| `DurableSessionCommand` / `DurableCommandEventDraft` | Journal command 与不含重复 `commandId` 的事件输入 |
| `DurableCommandCommitOptions` | 通过 `expectedHeadSequence` 固定状态派生 command 的前置 head |
| `DurableCommandCommitResult` / `DurableCommandCommitStatus` | `committed` / `replayed` / `reconciled` 提交结果 |
| `DurableSessionJournalError` / `DurableSessionJournalErrorCode` | command、分页和 Store 返回值错误 |
| `DurableCommandConflictError` | 同一 `commandId` 被用于不同事件 |
| `DurableCommandOutcomeUnknownError` | 写入失败后无法确认 command 是否提交 |
| `DurableSessionRecoveryError` / `DurableSessionRecoveryErrorCode` | 恢复目标缺失或状态不满足恢复契约 |
| `DurableSessionRecoveryRequiredError` | Session 恢复前需要输入、模型、权限或工具结果对账 |
| `SessionDurableRecorderError` | Session runtime 观察到非法 durable 生命周期状态 |
| `DurableEventEnvelope` / `DurableEventDraft` | 已提交事件与待提交事件 |
| `DurableEventDataMap` / `DurableEventOfType` / `DurableEventError` / `DurableEventSchemaVersion` / `DurableTokenUsage` | 事件类型到严格 payload 的映射、类型提取、schema 版本及公共 payload |
| `DurableModelResponse` / `DurableModelToolCall` / `DurableModelUsage` | 已完成模型响应、工具调用与用量的持久化结构 |
| `DurableInputPriority` / `DurablePermissionDecision` | 输入优先级与权限结果 |
| `DurableRequestInterruptReason` / `DurableTurnAbortReason` / `DurableModelRequestAbortReason` | Request、Turn 与模型调用中断原因 |
| `DurableToolInterruptBehavior` / `DurableToolCancelReason` / `DurableToolOutcomeUnknownReason` | 工具中断、取消及未知结果原因 |
| `DurableSessionCloseReason` | Session 关闭原因 |
| `DurableEventAppendOptions` / `DurableEventAppendResult` | compare-and-append 参数与结果 |
| `DurableEventReadOptions` / `DurableEventPage` | cursor 分页读取参数与结果 |
| `JsonlDurableEventStoreOptions` | JSONL Store 时钟、事件 ID factory、`lockTimeoutMs` 与 `operationTimeoutMs` |
| `DurableEventStoreTimeoutError` | durable append/read/head 调用超过 deadline |
| `DurableExecutionLeaseTimeoutError` | lease Store 调用超过 deadline |
| `DurableEventCursor` / `DURABLE_EVENT_CURSOR_VERSION` | 绑定 Session、sequence 和 event ID 的 cursor |
| `DurableEventSubscriptionOptions` / `DurableEventSubscriptionMessage` | 订阅配置与 event/caught-up 消息 |
| `DurableEventSubscriptionError` / `DurableEventSubscriptionErrorCode` | cursor、分页或订阅配置错误 |
| `DurableEventType` / `isDurableEventType` | 生命周期事件名及运行时类型判断 |
| `DurableSessionProjector` / `projectDurableSession` | 增量或一次性重建并校验 Session 生命周期 |
| `planDurableSessionRecovery` / `DurableSessionRecoveryPlan` | 分类未完成 Request、Turn、Tool 与 Permission |
| `DurableSessionProjection` / `DurableSessionProjectionStatus` | Session 当前 durable 状态及全局已对账输入 |
| `DurableRequestProjection` / `DurableRequestStatus` | 活动 Request 状态、已应用、待准备及已对账输入 |
| `DurableRequestRecoveryOrigin` | continuation Request 的 source Request/Turn provenance |
| `DurableRequestRecoveryKind` | 区分 active-Turn 与 synthetic pre-Turn recovery |
| `DurableTurnProjection` / `DurableTurnStatus` | 活动 Turn 状态 |
| `DurableModelAttemptProjection` / `DurableModelAttemptStatus` | 当前 Turn 的模型调用尝试状态 |
| `DurableToolAttemptProjection` / `DurableToolAttemptStatus` | 当前 Turn 的工具尝试状态 |
| `DurablePermissionProjection` / `DurablePermissionStatus` | 工具权限状态 |
| `DurableSessionRecoveryAction` | 恢复动作判别值 |
| `DurableAcceptedRequestRecovery` | 可自动恢复且带完整执行快照的 accepted Request |
| `DurableSessionResumeDecision` | `ready` / `resume_accepted_request` / `recovery_required` 决策 |
| `DurableRequestRolloverCommand` / `DurableRequestRolloverResult` | 首个 Turn 前的原子 Request rollover 命令及结果 |
| `DurableRequestOutcomeReconciliation` / `DurableRequestOutcomeReconciliationCommand` | Turn 后缺失 Request 终态时的显式对账输入 |
| `DurableModelOutcomeReconciliation` / `DurableModelOutcomeReconciliationCommand` | 未知模型调用结果的显式对账输入 |
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
| `ConfirmationDetails` | 确认请求详情；`abortSignal` 为当前 Request 的取消信号 |
| `ConfirmationHandler` | 交互式确认处理器 |
| `ConfirmationResponse` | 交互式确认结果 |
| `ToolYield` | 工具产生的结构化进度、展示消息或 effect |
| `ToolProgress` | 可选包含计数、结构化数据和恢复令牌的进度事件 |
| `ToolMessage` | 面向用户界面的执行消息 |
| `ToolEffectYield` | 工具产生的运行时 effect 事件 |
| `ToolResult` | 工具执行的最终成功/失败结果 |
| `ToolModelContent` | 回写模型上下文的工具内容 |
| `ToolDisplayContent` | 展示给用户的工具内容 |
| `ExecutionContext` | 工具执行上下文 |
| `ToolExecutionRecord` | 工具调用记录 |
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
| `ProviderRegistry` | 实例级 Provider adapter Registry |
| `ProviderRegistryError` | Registry 配置与查找错误 |
| `ProviderRegistryErrorCode` | Registry 错误码 |
| `ProviderAdapter` | 自定义 provider adapter 契约 |
| `ProviderConnectionConfig` | Provider 配置 |
| `BuiltinProviderType` | 内置 Provider adapter 类型字面量 |
| `ProviderType` | 内置或自定义 Provider adapter 类型 |
| `PROVIDER_TYPES` / `isBuiltinProviderType` | 内置 Provider catalog 与类型守卫 |
| `ModelConfig` | Registry 中可注册、可切换的模型描述 |
| `ModelServiceConfig` | 传给 Provider adapter 的模型请求配置 |
| `ModelService` | Provider adapter 返回的聊天服务契约 |
| `ModelMessage` / `ModelContent` / `ModelToolCall` | Provider 无关的模型消息与工具调用 |
| `ModelTextContent` / `ModelImageContent` | 文本与图片内容 part |
| `ModelToolCallDelta` / `ModelStreamToolCall` | 流式工具调用增量与聚合类型 |
| `ModelResponse` / `ModelStreamChunk` | 非流式响应与流式增量 |
| `ModelToolDefinition` | 传给模型的函数定义 |
| `ModelProviderOptions` / `ModelSideQueryOptions` | Provider 扩展和 side query 选项 |
| `ModelRetryConfig` / `ModelRetryEvent` / `QuerySource` | 模型重试策略、可观察事件与查询来源 |
| `ModelIdentity` | 生成 assistant 消息的 Provider、API adapter 与模型身份 |
| `ModelUsage` | Provider 返回的原始 token 用量 |
| `ModelInfo` | 模型信息 |
| `TokenUsage` | Agent/Session 聚合后的 token 预算视图 |
| `resolveModelIdentity` | 从规范化配置解析模型身份 |
| `normalizeModelUsage` | 把 Provider usage 转成 Agent/Session 用量 |

上述 Provider 无关契约可从 `@blade-ai/agent-sdk/model` 单独导入。类型所有权和
边界转换规则见[类型架构](./type-architecture)。

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
| `PermissionsConfig` | Session 权限规则配置 |
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

### Middleware 与插件

| 类型 | 说明 |
|------|------|
| `Middleware` / `MiddlewareNext` | 通用洋葱中间件契约 |
| `AgentMiddlewareConfig` | Session 级模型与工具 middleware 配置 |
| `AgentPlugin` | 声明式 middleware、hooks 与工具集合 |
| `ModelMiddleware` | 模型调用包装器集合 |
| `ModelChatRequest` / `ModelSideQueryRequest` | 非流式模型请求 |
| `ModelStreamRequest` / `ModelRetryRequest` | 流式与重试可见请求 |
| `ToolMiddleware` / `ToolMiddlewareRequest` | 流式工具执行中间件 |

详见 [Middleware 与插件](./middleware)。

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
| `SdkErrorOptions` / `SessionInputErrorCode` / `HookTimeoutErrorCode` / `ModelTimeoutErrorCode` | SDK 错误元数据 |
| `TokenBudgetConfig` / `TokenBudgetSnapshot` | 跨轮次 token 预算配置与快照 |

### 错误、生命周期与标识符

| 导出 | 说明 |
|------|------|
| `SdkError` / `AbortError` / `ConfigError` | SDK 基础错误、中止错误与配置错误 |
| `HookTimeoutError` | inline hook 事件总时限错误 |
| `ModelTimeoutError` | 非流式模型请求或流式空闲超时错误 |
| `ProviderRegistryError` | Provider adapter 注册、查找或构造错误 |
| `PermissionDeniedError` / `ToolExecutionError` | 权限与工具执行错误 |
| `getErrorCode` / `getErrorMessage` / `getErrorName` / `toError` | 未知错误规范化辅助函数 |
| `registerCleanup` / `gracefulShutdown` / `resetCleanupRegistry` | 进程级清理生命周期 |
| `CleanupFn` / `CleanupHandle` / `GracefulShutdownOptions` | 清理生命周期类型 |
| `AgentId` / `MessageId` / `ToolUseId` | Agent、消息和工具调用 branded identifiers |
| `JsonObject` / `JsonValue` | 严格 JSON 类型 |
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
