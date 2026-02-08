# 会话管理

本指南介绍 Blade Agent SDK 的会话生命周期管理，包括创建、恢复、分叉会话以及 send/stream 模式的使用。

## 创建会话

### 基本创建

```typescript
import { createSession } from '@blade-ai/agent-sdk';

const session = await createSession({
  provider: {
    type: 'openai-compatible',
    apiKey: process.env.API_KEY
  },
  model: 'gpt-4o-mini'
});
```

### 完整配置

```typescript
const session = await createSession({
  provider: {
    type: 'openai-compatible',
    apiKey: process.env.API_KEY,
    baseUrl: 'https://api.openai.com/v1'
  },
  model: 'gpt-4o-mini',
  systemPrompt: '你是一个有帮助的编程助手',
  maxTurns: 200,
  cwd: process.cwd(),
  permissionMode: 'default',
  allowedTools: ['Read', 'Write', 'Edit', 'Bash'],
  enableFileCheckpointing: true
});
```

## Send/Stream 模式

Blade Agent SDK 使用 send/stream 分离模式处理消息：

1. **send()** - 提交用户消息给 Agent
2. **stream()** - 返回异步迭代器接收响应

### 基本用法

```typescript
await session.send('分析这段代码并提出改进建议');

for await (const msg of session.stream()) {
  switch (msg.type) {
    case 'content':
      process.stdout.write(msg.delta);
      break;
    case 'tool_use':
      console.log(`调用工具: ${msg.name}`);
      break;
    case 'tool_result':
      console.log(`工具结果: ${msg.output}`);
      break;
    case 'result':
      console.log('完成:', msg.subtype);
      break;
  }
}
```

### 带选项使用

```typescript
// 带中断信号发送
const controller = new AbortController();
await session.send('长时间任务', {
  signal: controller.signal,
  maxTurns: 10
});

// 带思考过程的流
for await (const msg of session.stream({ includeThinking: true })) {
  if (msg.type === 'thinking') {
    console.log('思考:', msg.delta);
  }
}
```

### 消息类型

| 类型 | 描述 | 关键字段 |
|:-----|:-----|:---------|
| `turn_start` | 对话轮开始 | `turn`, `sessionId` |
| `turn_end` | 对话轮结束 | `turn` |
| `content` | 内容增量 | `delta` |
| `thinking` | 思考过程（如启用） | `delta` |
| `tool_use` | 工具调用 | `id`, `name`, `input` |
| `tool_result` | 工具执行结果 | `id`, `name`, `output`, `isError` |
| `usage` | Token 使用统计 | `usage` |
| `result` | 最终结果 | `subtype`, `content`, `error` |
| `error` | 发生错误 | `message`, `code` |

## 一次性 prompt

对于简单的单轮交互，使用 `prompt()` 函数：

```typescript
import { prompt } from '@blade-ai/agent-sdk';

const result = await prompt('2+2 等于多少？', {
  provider: { type: 'openai-compatible', apiKey: 'xxx' },
  model: 'gpt-4o-mini'
});

console.log(result.result);       // 响应内容
console.log(result.toolCalls);    // 工具调用记录
console.log(result.usage);        // Token 使用
console.log(result.duration);     // 耗时（毫秒）
console.log(result.turnsCount);   // 对话轮数
```

## 恢复会话

从存储的历史记录恢复会话：

```typescript
import { resumeSession } from '@blade-ai/agent-sdk';

const session = await resumeSession({
  sessionId: 'existing-session-id',
  provider: { type: 'openai-compatible', apiKey: 'xxx' },
  model: 'gpt-4o-mini'
});

// 继续对话
await session.send('继续上次的话题');
for await (const msg of session.stream()) {
  if (msg.type === 'content') {
    process.stdout.write(msg.delta);
  }
}
```

会话历史存储在 `{cwd}/.blade/sessions/{sessionId}.jsonl` 文件中。

## 分叉会话

从现有会话创建分支。分叉的会话继承历史但独立演进。

### 从 Session 实例分叉

```typescript
// 分叉整个会话
const forkedSession = await session.fork();

// 从特定消息点分叉
const forkedSession2 = await session.fork({
  messageId: 'msg-uuid-123',
  copyCheckpoints: true
});
```

### 从会话 ID 分叉

```typescript
import { forkSession } from '@blade-ai/agent-sdk';

const forkedSession = await forkSession({
  sessionId: 'existing-session-id',
  messageId: 'msg-uuid-456',  // 可选
  copyCheckpoints: true,       // 可选
  provider: { type: 'openai-compatible', apiKey: 'xxx' },
  model: 'gpt-4o-mini'
});
```

### Fork 与 Resume 的区别

| 操作 | 描述 | 会话 ID |
|:-----|:-----|:--------|
| **Resume** | 继续原会话，添加新消息 | 不变 |
| **Fork** | 从指定点创建分支，原会话不变 | 新 ID |

## 会话控制

### 中断操作

```typescript
// 方式1：使用 AbortSignal
const controller = new AbortController();
await session.send('长任务', { signal: controller.signal });

// 从其他地方中断
controller.abort();

// 方式2：直接中断
session.abort();
```

### 关闭会话

```typescript
session.close();
```

### 自动清理（TypeScript 5.2+）

```typescript
await using session = await createSession({ provider, model });
// 作用域结束时自动关闭会话
```

## 会话配置

### 设置权限模式

```typescript
import { PermissionMode } from '@blade-ai/agent-sdk';

session.setPermissionMode(PermissionMode.PLAN);
// 可选值: DEFAULT, PLAN, BYPASS_PERMISSIONS, ACCEPT_EDITS
```

### 设置最大轮数

```typescript
session.setMaxTurns(50);
```

### 更换模型

```typescript
await session.setModel('gpt-4-turbo');
```

## 查询会话状态

### 获取消息历史

```typescript
const messages = session.messages;
console.log(`共 ${messages.length} 条消息`);
```

### 获取会话 ID

```typescript
const sessionId = session.sessionId;
```

### 获取支持的命令

```typescript
const commands = await session.supportedCommands();
// [{ name: '/help', description: '显示帮助' }, ...]
```

### 获取支持的模型

```typescript
const models = await session.supportedModels();
// [{ id: 'default', name: 'gpt-4o-mini', provider: 'openai-compatible' }]
```

## MCP 服务器管理

### 查看服务器状态

```typescript
const status = await session.mcpServerStatus();
for (const server of status) {
  console.log(`${server.name}: ${server.status}`);
  console.log(`工具数: ${server.toolCount}`);
}
```

### 连接/断开服务器

```typescript
await session.mcpConnect('filesystem');
await session.mcpDisconnect('filesystem');
await session.mcpReconnect('filesystem');
```

### 列出 MCP 工具

```typescript
const tools = await session.mcpListTools();
for (const tool of tools) {
  console.log(`${tool.name} (${tool.serverName}): ${tool.description}`);
}
```

## 文件检查点

启用文件变更追踪和回滚：

```typescript
const session = await createSession({
  enableFileCheckpointing: true,
  // ...
});

// Agent 修改文件
await session.send('重构 src/utils.ts');
for await (const msg of session.stream()) {
  // ...
}

// 需要时回滚
const result = await session.rewindFiles('user-message-uuid');
if (result.success) {
  console.log('已恢复:', result.restoredFiles);
  console.log('已删除:', result.deletedFiles);
}

// 查看统计
const stats = session.getCheckpointStatistics();
console.log('检查点数:', stats?.checkpointCount);
```

详见 [文件检查点](./checkpoint.md)。

## 完整示例

```typescript
import { createSession } from '@blade-ai/agent-sdk';

async function main() {
  // 创建带完整配置的会话
  await using session = await createSession({
    provider: {
      type: 'openai-compatible',
      apiKey: process.env.API_KEY
    },
    model: 'gpt-4o-mini',
    systemPrompt: '你是一个有帮助的编程助手',
    maxTurns: 100,
    enableFileCheckpointing: true,
    sandbox: {
      enabled: true,
      autoAllowBashIfSandboxed: true
    }
  });

  console.log('会话 ID:', session.sessionId);

  // 第一次交互
  await session.send('分析项目结构');
  for await (const msg of session.stream()) {
    if (msg.type === 'content') {
      process.stdout.write(msg.delta);
    }
  }

  // 分叉进行实验
  const experimentSession = await session.fork();
  
  await experimentSession.send('尝试不同的方案');
  for await (const msg of experimentSession.stream()) {
    if (msg.type === 'content') {
      process.stdout.write(msg.delta);
    }
  }

  // 实验失败，原会话不受影响
  experimentSession.close();

  // 继续原会话
  await session.send('继续原来的计划');
  for await (const msg of session.stream()) {
    if (msg.type === 'content') {
      process.stdout.write(msg.delta);
    }
  }
}

main();
```

## 最佳实践

1. **使用自动清理** - TypeScript 5.2+ 推荐使用 `await using` 语法
2. **设置合理的 maxTurns** - 防止无限循环
3. **处理错误** - 监控 `error` 类型消息并捕获异常
4. **使用 AbortSignal** - 为长任务提供取消能力
5. **分叉进行实验** - 探索不同方向时使用 `fork()`
6. **启用检查点** - 使用 `enableFileCheckpointing` 保护文件安全
