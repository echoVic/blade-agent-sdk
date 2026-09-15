# 概览

`@blade-ai/agent-sdk` 是一个 TypeScript AI Agent 开发框架。面向应用开发者的
`createAgent()` 提供分层配置；底层仍由 Session 统一承载会话管理、工具执行、
MCP、权限、Hooks、沙箱、Memory 和工具目录。

适合构建：CLI 助手、IDE 插件、自动化工作流、对话式开发工具、多 Agent 协作系统。

## 安装

```bash
npm install @blade-ai/agent-sdk
# 或
pnpm add @blade-ai/agent-sdk
```

## 最小示例：流式对话

```ts
import { createAgent } from '@blade-ai/agent-sdk';

const agent = await createAgent({
  model: 'gpt-4o',
  apiKey: process.env.OPENAI_API_KEY!,
});

const response = await agent.send('用三句话解释什么是 TypeScript');

for await (const chunk of response.textStream()) {
  process.stdout.write(chunk);
}

await agent.close();
```

## 最小示例：一次性调用

```ts
import { prompt } from '@blade-ai/agent-sdk/advanced';

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
import { createAgent, defineTool } from '@blade-ai/agent-sdk';
import Type from 'typebox';

const weatherTool = defineTool({
  name: 'GetWeather',
  description: '查询指定城市的天气',
  parameters: Type.Object({ city: Type.String() }),
  async execute({ city }) {
    return { weather: `${city}: 晴 25°C` };
  },
});

const agent = await createAgent({
  model: 'gpt-4o',
  apiKey: process.env.OPENAI_API_KEY!,
  tools: [weatherTool],
});

const response = await agent.send('北京今天天气怎么样？');
console.log(await response.text());
await agent.close();
```

## 核心概念

### 自动上下文管理

SDK 内置多层上下文压缩策略（Microcompact → Soft → LLM 摘要 → 紧急截断），自动管理对话历史的 token 用量。当上下文接近模型上限时自动触发压缩，上下文溢出时自动恢复并重试，无需手动干预。详见 [Session API — 上下文自动压缩](./session#上下文自动压缩)。

### Agent 接触面与 Session 内核

应用从 `createAgent()` 开始。每次 `send()` 返回一个只执行一次、可重放消费的
`AgentResponse`：

```
createAgent() → Agent
                  ├── send() → AgentResponse
                  │              ├── text()
                  │              ├── textStream()
                  │              ├── on()
                  │              └── stream()
                  ├── close() / abort()
                  ├── fork()
                  └── model / MCP / trace 管理
```

框架与运行时集成可从 `/advanced` 使用 local `createSession()` 或显式的
`createServerSession()`。

### 底层 Session 的 send() + stream() 模型

需要 steering、排队或原始生命周期控制时使用 Session：

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

本地 transcript 写入支持同机多进程协调和崩溃尾部恢复；恢复时遇到已完整写入但
格式损坏的记录会 fail-closed。文件系统与原生锁约束详见[会话](./session)。

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
