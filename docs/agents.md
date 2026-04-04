# 子 Agent

Session 支持配置子 Agent，用于任务分解和并行执行。

## 内置子 Agent

SDK 内置 3 种子 Agent：

| 名称 | 用途 |
|------|------|
| general-purpose | 通用型，处理各类子任务 |
| Explore | 探索型，专注于代码搜索和分析 |
| Plan | 规划型，用于制定执行计划 |

## 自定义子 Agent

`SessionOptions.agents` 会把这些定义注册到当前 session 专属的 `SubagentRegistry` 中：

- 同一进程里的不同 session 不共享这些 agent
- 同名定义会覆盖当前 session 里的 builtin agent 或文件配置 agent
- `verification` 这类代码审查 agent 属于应用层决策，需要消费者自己注册

```ts
import type { AgentDefinition } from '@blade-ai/agent-sdk';

const session = await createSession({
  provider: { type: 'openai', apiKey: process.env.OPENAI_API_KEY! },
  model: 'gpt-4o',
  agents: {
    verification: {
      name: 'verification',
      description: '审查代码变更的正确性、风险和缺失测试',
      systemPrompt: '你是一位严格的代码审查专家，关注正确性、风险和测试缺口。',
      allowedTools: ['Read', 'Glob', 'Grep'],
      model: 'gpt-4o',
    },
    'test-writer': {
      name: 'Test Writer',
      description: '专门负责编写测试的 Agent',
      allowedTools: ['Read', 'Write', 'Edit', 'Bash', 'Glob', 'Grep'],
    },
  },
});
```

## AgentDefinition

```ts
interface AgentDefinition {
  name: string;
  description: string;
  systemPrompt?: string;
  allowedTools?: string[];
  model?: string;
}
```

| 字段 | 说明 |
|------|------|
| `name` | 子 Agent 显示名称 |
| `description` | 描述，LLM 根据此决定何时调用 |
| `systemPrompt` | 子 Agent 专属的系统提示词 |
| `allowedTools` | 限制可用工具范围 |
| `model` | 使用不同模型（可选，默认继承主 Session） |

::: tip
SDK 只内置 `general-purpose`、`Explore`、`Plan` 三种通用 agent 模式。产品化角色例如 `verification` 应由上层应用自行定义。
:::
