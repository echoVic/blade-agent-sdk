# 概览

`@blade-ai/agent-sdk` 是一个 **Session-first** 的 AI Agent 开发框架。它将会话管理、工具执行、MCP 协议、权限控制、生命周期钩子、沙箱安全、Memory 系统和工具目录统一封装在 Session API 中，让你用最少的代码构建功能完整的 AI Agent 应用。

适合构建：CLI 助手、IDE 插件、自动化工作流、对话式开发工具、多 Agent 协作系统。

## 安装

```bash
npm install @blade-ai/agent-sdk
# 或
pnpm add @blade-ai/agent-sdk
```

## 最小示例：流式对话

```ts
import { createSession } from '@blade-ai/agent-sdk';

const session = await createSession({
  provider: { type: 'openai', apiKey: process.env.OPENAI_API_KEY! },
  model: 'gpt-4o',
});

await session.send('用三句话解释什么是 TypeScript');

for await (const event of session.stream()) {
  if (event.type === 'content') {
    process.stdout.write(event.delta);
  }
}

await session.close();
```

## 最小示例：一次性调用

```ts
import { prompt } from '@blade-ai/agent-sdk';

const result = await prompt('列出当前目录下的所有 TypeScript 文件', {
  provider: { type: 'openai', apiKey: process.env.OPENAI_API_KEY! },
  model: 'gpt-4o',
  defaultContext: {
    capabilities: {
      filesystem: { roots: [process.cwd()], cwd: process.cwd() },
    },
  },
});

console.log(result.result);
console.log(`耗时 ${result.duration}ms，使用了 ${result.toolCalls.length} 次工具`);
```

## 带自定义工具的示例

```ts
import { createSession, defineTool } from '@blade-ai/agent-sdk';

const weatherTool = defineTool({
  name: 'GetWeather',
  description: '查询指定城市的天气',
  sideEffect: 'pure',
  parameters: {
    type: 'object',
    properties: {
      city: { type: 'string', description: '城市名称' },
    },
    required: ['city'],
  },
  async *execute(params) {
    yield {
      kind: 'progress',
      message: `正在查询 ${params.city} 的天气`,
    };
    return {
      status: 'success',
      model: `${params.city}: 晴 25°C`,
      display: { summary: `查询天气: ${params.city}` },
    };
  },
});

const session = await createSession({
  provider: { type: 'openai', apiKey: process.env.OPENAI_API_KEY! },
  model: 'gpt-4o',
  tools: [weatherTool],
});

await session.send('北京今天天气怎么样？');
for await (const event of session.stream()) {
  if (event.type === 'content') process.stdout.write(event.delta);
}
await session.close();
```

## 核心概念

### 自动上下文管理

SDK 内置多层上下文压缩策略（Microcompact → Soft → LLM 摘要 → 紧急截断），自动管理对话历史的 token 用量。当上下文接近模型上限时自动触发压缩，上下文溢出时自动恢复并重试，无需手动干预。详见 [Session API — 上下文自动压缩](./session#上下文自动压缩)。

### Session-first 设计

SDK 的所有能力都围绕 **Session（会话）** 组织。Session 是唯一的入口：

```
createSession() → ISession
                    ├── send()     启动、转向或排队用户输入
                    ├── stream()   流式接收 Agent 输出
                    ├── cancelInput() / getPendingInputs()
                    ├── close()    关闭会话
                    ├── abort()    中断当前执行
                    ├── fork()     分叉会话
                    ├── setModel() / setPermissionMode() / setMaxTurns()
                    ├── mcpConnect() / mcpDisconnect() / mcpListTools()
                    └── getDefaultContext() / setDefaultContext()
```

### send() + stream() 交互模型

每一轮交互遵循固定模式：

1. 调用 `send(message)` 提交用户消息，并取得 `InputSubmission`
2. 调用 `stream()` 获取异步迭代器，消费所有流式事件
3. Agent 自动执行工具调用，完成多轮推理后结束

请求执行期间再次调用 `send()` 时，默认以 `priority: 'next'` 在下一个模型/工具安全点加入当前请求；也可以使用 `now` 中断当前步骤，或使用 `later` 排队到下一请求。

```ts
await session.send('重构 src/utils.ts 中的 parseDate 函数');

for await (const msg of session.stream()) {
  switch (msg.type) {
    case 'content':
      process.stdout.write(msg.delta);
      break;
    case 'tool_use':
      console.log(`\n调用工具: ${msg.name}`);
      break;
    case 'tool_result':
      console.log(`工具结果: ${msg.name} → ${msg.isError ? '失败' : '成功'}`);
      break;
    case 'error':
      console.error(`错误: ${msg.message}`);
      break;
  }
}
```

### 会话持久化

Session 默认只保存在内存中。配置 `storagePath` 后才会写入磁盘，并可通过 `resumeSession()` 恢复历史会话。

| 模式 | 配置 | 适用场景 |
|------|------|----------|
| 仅内存（默认） | 不设置 `storagePath`，或 `persistSession: false` | Web / Serverless / 无状态 |
| 持久化 | `storagePath: '/path/to/sessions'` | CLI / IDE / 本地服务 |

## 多模型支持

原生支持 6 种 Provider：

| Provider | `type` 值 | 说明 |
|----------|-----------|------|
| OpenAI | `'openai'` | 官方 OpenAI API |
| Anthropic | `'anthropic'` | Claude 系列模型 |
| Azure OpenAI | `'azure-openai'` | Azure 托管的 OpenAI |
| Gemini | `'gemini'` | Google Gemini 系列 |
| DeepSeek | `'deepseek'` | DeepSeek 模型 |
| OpenAI 兼容 | `'openai-compatible'` | 任何兼容 OpenAI API 的服务 |

详见 [Provider 配置](./providers)。
