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

## 类 / 运行时对象

| 名称 | 来源 | 说明 |
|------|------|------|
| `FileSystemMemoryStore` | memory | 文件系统 memory 适配器 |
| `MemoryManager` | memory | memory 编排层 |
| `SubagentRegistry` | subagents | 注册和发现子 Agent |
| `SubagentExecutor` | subagents | 执行单个子 Agent |

## 常量 / 枚举

| 名称 | 值 |
|------|------|
| `PermissionMode` | `DEFAULT` / `AUTO_EDIT` / `YOLO` / `PLAN` |
| `HookEvent` | `SessionStart` / `SessionEnd` / `UserPromptSubmit` / `PermissionRequest` / `PreToolUse` / `PostToolUse` / `PostToolUseFailure` / `TaskCompleted` 等 |
| `ToolKind` | `READONLY` / `WRITE` / `EXECUTE` |
| `StreamMessageType` | `TURN_START` / `TURN_END` / `CONTENT` / `THINKING` / `TOOL_USE` / `TOOL_RESULT` / `USAGE` / `RESULT` / `ERROR` |
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
| `StreamMessage` | 流式消息联合类型 |
| `PromptResult` | prompt() 返回结果 |
| `ResumeOptions` | resume 选项 |
| `ForkOptions` | fork 选项 |
| `ForkSessionOptions` | Session fork 选项 |
| `ForkSessionResult` | Session fork 结果 |

### 工具

| 类型 | 说明 |
|------|------|
| `ToolDefinition` | 工具定义接口 |
| `ToolResult` | 工具执行结果 |
| `ExecutionContext` | 工具执行上下文 |
| `ToolCallRecord` | 工具调用记录 |
| `Memory` | Memory 记录类型 |
| `MemoryInput` | Memory 写入输入类型 |
| `MemoryStore` | Memory 后端抽象接口 |

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
| `ContextSnapshot` | 上下文快照 |
| `OutputFormat` | 输出格式约束 |
| `SandboxSettings` | 沙箱配置 |
| `AgentDefinition` | 子 Agent 定义 |
| `SubagentInfo` | 子 Agent 信息 |
| `SubagentConfig` | 子 Agent 配置 |
| `SubagentContext` | 子 Agent 执行上下文 |
| `SubagentResult` | 子 Agent 执行结果 |
| `SubagentSource` | 子 Agent 来源类型 |
| `AgentLogger` | 日志接口 |
| `LogEntry` | 日志条目 |
| `LogLevelName` | 日志级别 |
