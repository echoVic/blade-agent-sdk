# API 参考

`@blade-ai/agent-sdk` 根包导出的所有公开符号。

## 函数

| 函数 | 来源 | 说明 |
|------|------|------|
| `createSession` | session | 创建新会话 |
| `resumeSession` | session | 恢复会话 |
| `forkSession` | session | 分叉会话 |
| `prompt` | session | 一次性调用 |
| `defineTool` | tools | 定义工具（简单模式） |
| `createTool` | tools | 创建工具（Zod 模式） |
| `toolFromDefinition` | tools | 转换 ToolDefinition → Tool |
| `getBuiltinTools` | tools | 获取内置工具 |
| `createMemoryReadTool` | tools | 创建 opt-in MemoryRead 工具 |
| `createMemoryWriteTool` | tools | 创建 opt-in MemoryWrite 工具 |
| `tool` | mcp | 定义 MCP 工具 |
| `createSdkMcpServer` | mcp | 创建进程内 MCP Server |
| `createContextSnapshot` | runtime | 创建上下文快照 |
| `mergeContext` | runtime | 合并上下文 |
| `hasFilesystemCapability` | runtime | 检查文件系统能力 |
| `createCompositePermissionHandler` | permissions | 组合多个权限处理器 |
| `createModePermissionHandler` | permissions | 基于权限模式创建处理器 |
| `createPathSafetyPermissionHandler` | permissions | 基于路径安全策略创建处理器 |
| `createPermissionHandlerFromCanUseTool` | permissions | 从 canUseTool 回调创建处理器 |
| `createRuleBasedPermissionHandler` | permissions | 基于规则创建处理器 |

## 类 / 运行时对象

| 名称 | 来源 | 说明 |
|------|------|------|
| `ToolCatalog` | tools/catalog | 工具目录，管理来源追踪、信任分级和策略过滤 |
| `FileSystemMemoryStore` | memory | 文件系统 memory 适配器 |
| `MemoryManager` | memory | memory 编排层 |
| `SubagentRegistry` | subagents | 注册和发现子 Agent |
| `SubagentExecutor` | subagents | 执行单个子 Agent |

## 常量 / 枚举

| 名称 | 值 |
|------|------|
| `PermissionMode` | `DEFAULT` / `AUTO_EDIT` / `YOLO` / `PLAN` |
| `HookEvent` | `SessionStart` / `SessionEnd` / `UserPromptSubmit` / `PermissionRequest` / `PreToolUse` / `PostToolUse` / `PostToolUseFailure` / `TaskCompleted` / `Stop` / `SubagentStart` / `SubagentStop` / `Notification` / `Compaction` / `StopFailure` / `PreCompact` / `PostCompact` / `Elicitation` / `ElicitationResult` / `ConfigChange` / `CwdChanged` / `FileChanged` / `InstructionsLoaded` |
| `ToolKind` | `READONLY` / `WRITE` / `EXECUTE` |
| `StreamMessageType` | `TURN_START` / `TURN_END` / `CONTENT` / `THINKING` / `TOOL_USE` / `TOOL_PROGRESS` / `TOOL_MESSAGE` / `TOOL_RUNTIME_PATCH` / `TOOL_CONTEXT_PATCH` / `TOOL_NEW_MESSAGES` / `TOOL_PERMISSION_UPDATES` / `TOOL_RESULT` / `USAGE` / `RESULT` / `ERROR` |
| `MessageRole` | `SYSTEM` / `USER` / `ASSISTANT` / `TOOL` |
| `PermissionDecision` | `ALLOW` / `DENY` / `ASK` |

## 类型

### Session

| 类型 | 说明 |
|------|------|
| `ISession` | Session 实例接口 |
| `SessionOptions` | Session 创建选项 |
| `SendOptions` | send() 选项 |
| `StreamOptions` | stream() 选项 |
| `StreamMessage` | 流式消息联合类型（15 种） |
| `PromptResult` | prompt() 返回结果 |
| `ResumeOptions` | resume 选项 |
| `ForkOptions` | fork 选项 |
| `ForkSessionOptions` | Session fork 选项 |
| `ForkSessionResult` | Session fork 结果 |

### 工具

| 类型 | 说明 |
|------|------|
| `Tool` | 内部工具接口 |
| `ToolConfig` | 工具配置 |
| `ToolSchema` | 工具 Schema |
| `ToolBehavior` | 工具行为配置 |
| `ToolEffect` | 工具副作用描述 |
| `ToolDefinition` | 工具定义接口 |
| `ToolDescription` | 工具描述（短描述/长描述/使用提示/示例） |
| `ToolDescriptionResolver` | 动态工具描述解析器 |
| `ToolResult` | 工具执行结果 |
| `ExecutionContext` | 工具执行上下文 |
| `ToolCallRecord` | 工具调用记录 |
| `ToolExposureConfig` | 工具暴露配置 |
| `ToolExposureMode` | 工具暴露模式 |
| `ToolExecutionUpdate` | 工具执行过程更新事件 |
| `FunctionDeclaration` | 函数声明（JSON Schema 格式） |

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
