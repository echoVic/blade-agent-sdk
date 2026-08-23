# Hooks 生命周期钩子

`SessionOptions.hooks` 提供应用内回调，可审计输入、修改工具参数或结果，并阻止当前操作。Session 不会自动扫描 `.blade/hooks/` 等目录；文件 Hook 的加载属于上层应用集成职责。

## 快速开始

```ts
import { createSession, HookEvent } from '@blade-ai/agent-sdk';

const session = await createSession({
  provider: { type: 'openai', apiKey: process.env.OPENAI_API_KEY! },
  model: 'gpt-4o',
  hooks: {
    [HookEvent.PreToolUse]: [
      async (input) => {
        console.log('[工具调用]', input.toolName, input.toolInput);
        return { action: 'continue' };
      },
    ],
    [HookEvent.PostToolUseFailure]: [
      async (input) => {
        console.error('[工具失败]', input.toolName, input.error);
        return { action: 'continue' };
      },
    ],
  },
});
```

## Session 支持的事件

`HookEvent` 常量包含 22 个事件，供 SDK 内部和文件 Hook 协议使用。`SessionOptions.hooks` 的公开类型 `SessionHookEvent` 只接受以下 8 个事件：

需要直接引用 `SessionHookEvent` 类型时，从
`@blade-ai/agent-sdk/session` 导入；根入口当前未重新导出该类型。

| 事件 | 时机 | 常用输入 |
|------|------|----------|
| `SessionStart` | Session 初始化完成 | `sessionId` |
| `UserPromptSubmit` | 用户输入进入 Agent 前 | `userPrompt`、`hasImages`、`imageCount` |
| `PreToolUse` | 工具权限检查与执行前 | `toolName`、`toolInput` |
| `PermissionRequest` | 工具需要权限决策时 | `toolName`、`toolInput` |
| `PostToolUse` | 工具成功后 | `toolName`、`toolInput`、`toolOutput` |
| `PostToolUseFailure` | 工具失败后 | `toolName`、`toolInput`、`toolOutput`、`error` |
| `TaskCompleted` | 任务完成 | 任务相关字段 |
| `SessionEnd` | Session 关闭 | `sessionId` |

## 核心类型

```ts
interface HookInput {
  event: HookEvent;
  abortSignal?: AbortSignal;
  toolName?: string;
  toolInput?: JsonObject;
  toolOutput?: ToolModelContent;
  error?: Error;
  sessionId: SessionId;
  [key: string]: unknown;
}

interface HookOutput {
  action: 'continue' | 'skip' | 'abort';
  modifiedInput?: JsonObject | string;
  modifiedOutput?: JsonValue;
  reason?: string;
}

type HookCallback = (input: HookInput) => Promise<HookOutput>;
```

| action | 含义 |
|--------|------|
| `continue` | 继续处理，可同时返回修改后的输入或输出 |
| `skip` | 跳过当前工具调用 |
| `abort` | 中止当前 prompt 或工具调用；不会永久关闭 Session |

## 时限与取消

每次 inline hook 事件共享一份总 wall-clock 预算，callback 按注册顺序执行。
`SessionOptions.hookTimeoutMs` 默认是 `600000`（10 分钟）。`SessionEnd`
使用更短的 `SessionOptions.sessionEndHookTimeoutMs`，默认是 `3000`。

SDK 会组合调用方 signal 与 deadline，并通过 `HookInput.abortSignal` 传给
callback。到期后事件以 `HookTimeoutError`（code 为 `HOOK_TIMEOUT`）失败。
callback 必须监听 signal 并释放资源；如果取消后仍未结束，后续 inline hook
dispatch 以及 Session close/handoff 都会 fail-closed，直至该 callback
settle。上述选项不替代文件 Hook 自己的独立超时配置。

文件/命令 Hook 会在启动子进程前检查 Request 信号。在 POSIX 上，取消或文件
Hook 超时时会终止进程组，先发送 `SIGTERM` 并短暂等待，必要时升级为
`SIGKILL`。在 Windows 上，命令必须在启动后代前加入 Job Object，取消时会终止
完整 Job。进程树退出前 Hook 不会报告清理成功；containment 失败会直接拒绝，
不服从普通 Hook 的失败降级策略。Windows 原生依赖 `koffi` 不可用时，命令 Hook
也会在启动前 fail-closed。Runtime 还会在每个文件 Hook 返回后再次检查信号，因此
默认的 `ignore` 失败策略不会让已取消的 Request 继续执行。
如果 containment failure 在取消已赢得异步工具或权限竞态后才到达，执行管道会
进入隔离状态；后续工具调用以及 Session close/handoff 都会继续 fail-closed。

POSIX containment 以进程组为边界。若 Hook 命令主动通过 `setsid()` 创建新会话，
该进程会离开 SDK 管理的进程组，不属于可移植清理边界。

`SessionEnd` callback 在一次 runtime 关闭流程中只执行一次；callback 失败或
超时后，重试 `close()` 不会再次调用它；文件 Hook 保持原有重试行为。

## 修改用户输入

`UserPromptSubmit` 的文本字段名是 `userPrompt`。返回 `modifiedInput.userPrompt` 可替换文本，同时保留原消息中的图片：

```ts
hooks: {
  [HookEvent.UserPromptSubmit]: [
    async (input) => {
      const prompt = String(input.userPrompt ?? '');
      return {
        action: 'continue',
        modifiedInput: {
          userPrompt: `[tenant:acme]\n${prompt}`,
        },
      };
    },
  ],
}
```

为兼容旧回调，`modifiedInput` 也可以直接返回字符串。

## 修改工具输入

```ts
hooks: {
  [HookEvent.PreToolUse]: [
    async (input) => {
      if (input.toolName !== 'Write') {
        return { action: 'continue' };
      }
      return {
        action: 'continue',
        modifiedInput: {
          ...input.toolInput,
          content: `// Generated\n${String(input.toolInput?.content ?? '')}`,
        },
      };
    },
  ],
}
```

## 阻止工具调用

```ts
const dangerous = [/rm\s+-rf/, /mkfs/, /dd\s+if=/];

hooks: {
  [HookEvent.PreToolUse]: [
    async (input) => {
      if (input.toolName !== 'Bash') {
        return { action: 'continue' };
      }
      const command = String(input.toolInput?.command ?? '');
      if (dangerous.some((pattern) => pattern.test(command))) {
        return {
          action: 'abort',
          reason: `危险命令被阻止: ${command}`,
        };
      }
      return { action: 'continue' };
    },
  ],
}
```

`skip` 会跳过执行并生成带原因的成功结果；`abort` 会生成失败结果。两者都
不等价于 `session.close()`，后续仍可继续使用 Session。

## 修改工具输出

```ts
hooks: {
  [HookEvent.PostToolUse]: [
    async (input) => {
      if (input.toolName !== 'Read') {
        return { action: 'continue' };
      }
      return {
        action: 'continue',
        modifiedOutput: String(input.toolOutput)
          .replace(/SECRET_KEY=\w+/g, 'SECRET_KEY=***'),
      };
    },
  ],
}
```

`modifiedOutput` 会替换回写给模型的 `ToolResult.model`，不修改 UI 专用的 `display` 字段。

## 与权限回调的关系

| 机制 | 用途 | 返回值 |
|------|------|--------|
| `PreToolUse` / `PostToolUse` | 拦截、审计、修改工具调用 | `HookOutput` |
| `PermissionRequest` | 观察权限请求 | `HookOutput` |
| `canUseTool` | 作出 allow / deny / ask 决策 | `PermissionResult` |

权限决策应优先放在 `canUseTool`：

```ts
const session = await createSession({
  provider,
  model,
  canUseTool: async (_toolName, _input, options) => {
    if (options.toolKind === 'readonly') {
      return { behavior: 'allow' };
    }
    return { behavior: 'ask', message: '需要用户确认写入或执行操作' };
  },
});
```

## 回调顺序与错误

同一事件的内联回调按数组顺序调用，但 dispatch 会先收集全部结果，再统一处理：

```ts
hooks: {
  [HookEvent.PreToolUse]: [hookA, hookB, hookC],
}
```

- `hookA` 返回 `skip` 或 `abort` 时，`hookB` 和 `hookC` 仍会执行。
- 后一个回调收到的是同一份原始 `HookInput`，不会看到前一个回调的 `modifiedInput`。
- 结果处理阶段按顺序合并修改，并采用遇到的第一个 `skip` 或 `abort`。
- prompt 等非工具 Hook 的异常会向上层传播。
- 工具 Hook 的异常会被执行管道规范化为工具错误；处理失败结果的
  `PostToolUseFailure` 再次抛错时，SDK 会记录 warning 并保留原始工具错误。

用于日志、监控等非关键 Hook 时，应在回调内部处理可恢复错误：

```ts
async (input) => {
  try {
    await sendToMonitoring(input);
  } catch (error) {
    console.error('Hook 上报失败', error);
  }
  return { action: 'continue' };
};
```
