# Hooks 生命周期钩子

Hooks 是 Blade Agent SDK 的运行时扩展机制，让你可以在 Agent 执行过程中拦截、审计、修改工具调用行为。

## 架构

Hook 系统内部分为两层，由统一的 Hook 运行时协调：

| 层 | 来源 | 适用场景 |
|---|------|----------|
| **内联回调** | `SessionOptions.hooks` 中注册的回调函数 | 应用级逻辑：审计日志、权限拦截、输入/输出修改 |
| **文件脚本** | 项目 `.blade/hooks/` 目录下的 Shell/Node 脚本 | 项目级约束：强制代码规范、安全策略 |

两层按顺序执行：**内联回调先执行，文件脚本后执行**。任一层返回 `abort` 或 `skip` 都会阻止后续执行。对于 `PermissionRequest`、`UserPromptSubmit` 等事件，文件脚本的结果（如权限决策、prompt 注入）会叠加在内联回调之后生效。

## 快速开始

```ts
import { createSession, HookEvent } from '@blade-ai/agent-sdk';

const session = await createSession({
  provider: { type: 'anthropic', apiKey: process.env.ANTHROPIC_API_KEY },
  model: 'claude-sonnet-4-20250514',
  hooks: {
    [HookEvent.PreToolUse]: [
      async (input) => {
        console.log(`[工具调用] ${input.toolName}`, input.toolInput);
        return { action: 'continue' };
      },
    ],
    [HookEvent.PostToolUse]: [
      async (input) => {
        console.log(`[调用完成] ${input.toolName}`);
        return { action: 'continue' };
      },
    ],
  },
});
```

## 核心类型

### HookCallback

```ts
type HookCallback = (input: HookInput) => Promise<HookOutput>;
```

### HookInput

```ts
interface HookInput {
  event: HookEvent;
  toolName?: string;
  toolInput?: unknown;
  toolOutput?: unknown;
  error?: Error;
  sessionId: string;
  [key: string]: unknown;
}
```

### HookOutput

```ts
interface HookOutput {
  action: 'continue' | 'skip' | 'abort';
  modifiedInput?: unknown;
  modifiedOutput?: unknown;
  reason?: string;
}
```

**三种 action 的含义：**

| action | 说明 | 适用场景 |
|--------|------|----------|
| `continue` | 继续正常执行 | 审计日志、数据收集 |
| `skip` | 跳过当前工具调用 | 阻止特定操作 |
| `abort` | 终止整个会话 | 检测到危险行为 |

## 支持的 8 个事件

### SessionStart

会话创建时触发。

```ts
hooks: {
  [HookEvent.SessionStart]: [
    async (input) => {
      console.log(`会话 ${input.sessionId} 已启动`);
      return { action: 'continue' };
    },
  ],
}
```

**HookInput 字段：** `event`、`sessionId`

### UserPromptSubmit

用户发送消息时触发。

```ts
hooks: {
  [HookEvent.UserPromptSubmit]: [
    async (input) => {
      const message = input.message as string;
      console.log(`用户输入: ${message}`);
      return { action: 'continue' };
    },
  ],
}
```

**HookInput 字段：** `event`、`sessionId`、`message`

### PreToolUse

工具执行**之前**触发。这是最常用的 Hook，可以用来审计、修改输入、或阻止执行。

```ts
hooks: {
  [HookEvent.PreToolUse]: [
    async (input) => {
      // 阻止删除操作
      if (input.toolName === 'Bash') {
        const command = (input.toolInput as { command: string }).command;
        if (command.includes('rm -rf')) {
          return { action: 'abort', reason: '禁止执行危险的删除命令' };
        }
      }
      return { action: 'continue' };
    },
  ],
}
```

**HookInput 字段：** `event`、`sessionId`、`toolName`、`toolInput`

**支持的 HookOutput 操作：**
- `continue` — 正常执行
- `continue` + `modifiedInput` — 修改输入后执行
- `skip` — 跳过此次工具调用
- `abort` — 终止会话

### PostToolUse

工具执行**成功后**触发。

```ts
hooks: {
  [HookEvent.PostToolUse]: [
    async (input) => {
      console.log(`${input.toolName} 执行成功:`, input.toolOutput);
      return { action: 'continue' };
    },
  ],
}
```

**HookInput 字段：** `event`、`sessionId`、`toolName`、`toolInput`、`toolOutput`

**支持的 HookOutput 操作：**
- `continue` — 正常返回结果
- `continue` + `modifiedOutput` — 修改输出后返回

### PostToolUseFailure

工具执行**失败后**触发。

```ts
hooks: {
  [HookEvent.PostToolUseFailure]: [
    async (input) => {
      console.error(`${input.toolName} 执行失败:`, input.error?.message);
      return { action: 'continue' };
    },
  ],
}
```

**HookInput 字段：** `event`、`sessionId`、`toolName`、`error`

### PermissionRequest

权限检查时触发。

```ts
hooks: {
  [HookEvent.PermissionRequest]: [
    async (input) => {
      console.log(`权限请求: ${input.toolName}`);
      return { action: 'continue' };
    },
  ],
}
```

**HookInput 字段：** `event`、`sessionId`、`toolName`、`toolInput`

### TaskCompleted

任务/子任务完成时触发。

```ts
hooks: {
  [HookEvent.TaskCompleted]: [
    async (input) => {
      console.log('任务完成');
      return { action: 'continue' };
    },
  ],
}
```

### SessionEnd

会话结束时触发。

```ts
hooks: {
  [HookEvent.SessionEnd]: [
    async (input) => {
      console.log(`会话 ${input.sessionId} 已结束`);
      return { action: 'continue' };
    },
  ],
}
```

## 修改工具输入/输出

### 修改输入（PreToolUse）

通过 `modifiedInput` 在工具执行前修改参数：

```ts
hooks: {
  [HookEvent.PreToolUse]: [
    async (input) => {
      if (input.toolName === 'Write') {
        const params = input.toolInput as { filePath: string; content: string };
        return {
          action: 'continue',
          modifiedInput: {
            ...params,
            content: `// Auto-generated\n${params.content}`,
          },
        };
      }
      return { action: 'continue' };
    },
  ],
}
```

### 修改输出（PostToolUse）

通过 `modifiedOutput` 在工具执行后修改返回值：

```ts
hooks: {
  [HookEvent.PostToolUse]: [
    async (input) => {
      if (input.toolName === 'Read') {
        const output = input.toolOutput as { content: string };
        return {
          action: 'continue',
          modifiedOutput: {
            ...output,
            content: output.content.replace(/SECRET_KEY=\w+/g, 'SECRET_KEY=***'),
          },
        };
      }
      return { action: 'continue' };
    },
  ],
}
```

## canUseTool 权限回调

`canUseTool` 与 Hooks 是两个独立的系统：

| 特性 | Hooks | canUseTool |
|------|-------|------------|
| 用途 | 拦截、审计、修改 | 权限决策 |
| 返回值 | HookOutput (continue/skip/abort) | PermissionResult (allow/deny/ask) |
| 执行时机 | 工具调用前后 | 权限检查时 |

### canUseTool 签名

```ts
type CanUseTool = (
  toolName: string,
  input: Record<string, unknown>,
  options: CanUseToolOptions,
) => Promise<PermissionResult>;

interface CanUseToolOptions {
  signal: AbortSignal;
  toolKind: 'readonly' | 'write' | 'execute';
  affectedPaths: string[];
}
```

### PermissionResult

```ts
// 允许执行（可选修改输入）
{ behavior: 'allow', updatedInput?: Record<string, unknown> }

// 拒绝执行
{ behavior: 'deny', message: string, interrupt?: boolean }

// 交给内置权限系统决定
{ behavior: 'ask' }
```

### 示例：自定义权限 UI

```ts
const session = await createSession({
  provider: { type: 'openai', apiKey: process.env.OPENAI_API_KEY },
  model: 'gpt-4o',
  canUseTool: async (toolName, input, options) => {
    if (options.toolKind === 'readonly') {
      return { behavior: 'allow' };
    }

    // 对写操作弹出自定义确认框
    const approved = await showConfirmDialog(
      `允许 ${toolName} 操作 ${options.affectedPaths.join(', ')}？`,
    );

    return approved
      ? { behavior: 'allow' }
      : { behavior: 'deny', message: '用户拒绝' };
  },
});
```

## 实战示例

### 审计日志

```ts
const auditLog: Array<{ time: string; tool: string; input: unknown }> = [];

const session = await createSession({
  // ...provider, model
  hooks: {
    [HookEvent.PreToolUse]: [
      async (input) => {
        auditLog.push({
          time: new Date().toISOString(),
          tool: input.toolName ?? 'unknown',
          input: input.toolInput,
        });
        return { action: 'continue' };
      },
    ],
    [HookEvent.SessionEnd]: [
      async () => {
        const { writeFileSync } = await import('node:fs');
        writeFileSync('audit.json', JSON.stringify(auditLog, null, 2));
        return { action: 'continue' };
      },
    ],
  },
});
```

### 阻止危险命令

```ts
const DANGEROUS_PATTERNS = [/rm\s+-rf/, /mkfs/, /dd\s+if=/, />\s*\/dev\//];

hooks: {
  [HookEvent.PreToolUse]: [
    async (input) => {
      if (input.toolName === 'Bash') {
        const cmd = (input.toolInput as { command: string }).command;
        for (const pattern of DANGEROUS_PATTERNS) {
          if (pattern.test(cmd)) {
            return { action: 'abort', reason: `危险命令被阻止: ${cmd}` };
          }
        }
      }
      return { action: 'continue' };
    },
  ],
}
```

### 速率限制

```ts
const callCounts = new Map<string, number>();
const MAX_CALLS_PER_TOOL = 50;

hooks: {
  [HookEvent.PreToolUse]: [
    async (input) => {
      const name = input.toolName ?? '';
      const count = (callCounts.get(name) ?? 0) + 1;
      callCounts.set(name, count);

      if (count > MAX_CALLS_PER_TOOL) {
        return { action: 'skip', reason: `${name} 调用次数超过限制 (${MAX_CALLS_PER_TOOL})` };
      }
      return { action: 'continue' };
    },
  ],
}
```

## 执行顺序

同一事件可以注册多个 Hook，它们按数组顺序依次执行：

```ts
hooks: {
  [HookEvent.PreToolUse]: [hookA, hookB, hookC],
}
```

- 按 `hookA` → `hookB` → `hookC` 顺序执行
- 如果任意一个返回 `skip` 或 `abort`，后续 Hook **不再执行**
- 如果 `hookA` 返回 `modifiedInput`，`hookB` 收到的是修改后的输入

## 错误处理

::: warning
Hook 回调中抛出的异常会被捕获并记录，但**不会阻止**工具执行。务必在回调内做好 try/catch：
:::

```ts
async (input) => {
  try {
    await sendToMonitoring(input);
  } catch (err) {
    console.error('Hook 执行失败:', err);
  }
  return { action: 'continue' };
};
```
