# 子 Agent

Session 支持配置子 Agent，用于任务分解和并行执行。

## 内置子 Agent

SDK 内置 3 种子 Agent：

| 名称 | 用途 | 默认省略环境上下文 |
|------|------|------------------|
| general-purpose | 通用型，处理各类子任务 | 否 |
| Explore | 探索型，专注于代码搜索和分析 | 是 |
| Plan | 规划型，用于制定执行计划 | 是 |

::: tip
Explore 和 Plan 子 Agent 默认设置了 `contextOmissions: ['environment']`，省略环境上下文信息以节省 token，让更多上下文空间用于实际任务内容。
:::

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
  contextOmissions?: Array<'environment'>;
}
```

| 字段 | 说明 |
|------|------|
| `name` | 子 Agent 显示名称 |
| `description` | 描述，LLM 根据此决定何时调用 |
| `systemPrompt` | 子 Agent 专属的系统提示词 |
| `allowedTools` | 限制可用工具范围 |
| `model` | 使用不同模型（可选，默认继承主 Session） |
| `contextOmissions` | 省略的上下文部分。设置 `['environment']` 可跳过环境信息注入，节省 token |

::: tip
SDK 只内置 `general-purpose`、`Explore`、`Plan` 三种通用 agent 模式。产品化角色例如 `verification` 应由上层应用自行定义。
:::

## 后台 Agent

通过内置的 `Task` 工具，LLM 可以创建后台运行的子 Agent。后台 Agent 独立于主对话循环执行，适合耗时的并行任务。

### 生命周期

1. **创建**：LLM 调用 `Task` 工具启动后台 Agent，返回任务 ID
2. **执行**：后台 Agent 在独立上下文中运行，不阻塞主对话
3. **查询**：通过 `TaskOutput` 工具获取后台 Agent 的执行状态和输出
4. **停止**：通过 `TaskStop` 工具停止后台 Agent

### 取消机制

后台 Agent 内部使用双控制器设计：

- **生命周期控制器**：控制整个 Agent 生命周期，`TaskStop` 触发此控制器
- **工作控制器**：仅控制当前执行中的工作单元

当生命周期控制器被触发时，会级联中止当前工作。这种分离确保取消操作是干净的。

```ts
// 后台 Agent 由 LLM 自动创建和管理
// 以下是 LLM 可能产生的工具调用序列：

// 1. LLM 创建后台探索任务
// Tool: Task { prompt: "搜索所有包含 TODO 的文件" }

// 2. LLM 查询任务状态
// Tool: TaskOutput { task_id: "agent-xxx" }

// 3. 如需取消
// Tool: TaskStop { taskId: "agent-xxx" }
```
