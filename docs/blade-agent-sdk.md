# Blade Agent SDK 总览

Blade Agent SDK 是一个 session-first 的开源 Agent SDK。它把会话、工具执行、MCP、权限控制、Hooks 和沙箱约束组织成统一的 Session API。

## 设计取向

- 对外主入口是 Session，而不是内部 manager/service
- `send()` / `stream()` 是核心交互模型
- 工具、MCP、权限和 Hooks 都围绕单个会话运行
- SDK 暴露 contract，不暴露大部分内部实现对象

## 根导出包含什么

当前根包主要暴露 5 组能力：

1. Session API
   - `createSession`
   - `resumeSession`
   - `forkSession`
   - `prompt`

2. Session contract types
   - `ISession`
   - `SessionOptions`
   - `SendOptions`
   - `StreamOptions`
   - `StreamMessage`
   - `PromptResult`

3. Tool authoring
   - `createTool`
   - `defineTool`
   - `toolFromDefinition`
   - `getBuiltinTools`
   - `ToolDefinition`
   - `ToolResult`
   - `ExecutionContext`

4. MCP authoring
   - `tool`
   - `createSdkMcpServer`
   - `SdkTool`
   - `SdkMcpServerHandle`

5. Runtime contract
   - `PermissionMode`
   - `HookEvent`
   - `ToolKind`
   - `CanUseTool`
   - `AgentLogger`
   - `SandboxSettings`
   - `OutputFormat`

## 最小示例

```ts
import { createSession } from '@blade-ai/agent-sdk';

const session = await createSession({
  provider: { type: 'openai-compatible', apiKey: process.env.API_KEY },
  model: 'gpt-4o-mini',
});

await session.send('总结这个仓库的公开 API');

for await (const event of session.stream()) {
  if (event.type === 'content') {
    process.stdout.write(event.delta);
  }
}

session.close();
```

## 会话模型

一个 Session 有这些主要能力：

- 保存消息历史
- 发送用户消息
- 流式接收 Agent 输出
- 动态切换模型和权限模式
- 连接、断开和查询 MCP server
- 基于持久化历史恢复或分叉

Session 默认是“可持久化”的，但不强制要求本地落盘：

- 默认情况下，SDK 会把会话历史写入本地存储，适合 CLI / IDE / 本地服务
- 如果传入 `persistSession: false`，则会切换到仅内存模式，适合 Web / Serverless
- 仅内存模式下仍然支持当前实例内的多轮对话，但不支持 `resumeSession()` 这类依赖磁盘历史的 API

相关文档见 [Session](./session.md)。

## 工具系统

Session 默认会装配内置工具。你也可以通过 `tools` 传入自定义工具。

```ts
import { defineTool } from '@blade-ai/agent-sdk';

const echoTool = defineTool({
  name: 'Echo',
  description: 'Echo text back',
  parameters: {
    type: 'object',
    properties: {
      text: { type: 'string' },
    },
    required: ['text'],
  },
  execute: async (params) => ({
    success: true,
    llmContent: String(params.text),
    displayContent: String(params.text),
  }),
});
```

## Hooks

Hooks 使用 callback 形式配置在 `SessionOptions.hooks` 上，不再使用 shell-style hook 配置对象。

支持的事件：

- `SessionStart`
- `SessionEnd`
- `UserPromptSubmit`
- `PermissionRequest`
- `PreToolUse`
- `PostToolUse`
- `PostToolUseFailure`
- `TaskCompleted`

相关文档见 [Hooks](./hooks.md)。

## MCP

SDK 支持两种 MCP 接入方式：

- 在 Session 中连接外部 MCP server
- 用 `tool()` + `createSdkMcpServer()` 定义 in-process MCP server

相关文档见 [MCP](./mcp.md)。

## 沙箱

命令执行的沙箱通过 `SessionOptions.sandbox` 配置，不需要直接访问内部 sandbox service。

相关文档见 [Sandbox](./sandbox.md)。

## 日志

SDK 不内置日志实现，只接受用户提供的 `AgentLogger`：

```ts
import type { AgentLogger, LogEntry } from '@blade-ai/agent-sdk';

const logger: AgentLogger = {
  log(entry: LogEntry) {
    console.log(entry.timestamp, entry.level, entry.category, entry.message);
  },
};
```

## 当前不再提供的能力

以下能力已经不再是公开 SDK contract：

- 文件 checkpoint / rewind
- 根导出的 `Agent`
- 根导出的 `ContextManager` / `ExecutionPipeline` / `ToolRegistry`
- 根导出的 `McpRegistry` / `McpClient`
- 根导出的 `SandboxService` / `SandboxExecutor`
- shell-style hooks 配置和 `HookManager` public API
