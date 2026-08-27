# 权限控制

SDK 提供多层权限机制，控制 Agent 的工具执行行为。

## PermissionMode

4 种内置权限模式：

| 模式 | 值 | 说明 |
|------|------|------|
| 默认 | `'default'` | 写入和执行类工具需要用户确认 |
| 自动编辑 | `'autoEdit'` | 文件编辑自动通过，命令执行仍需确认 |
| YOLO | `'yolo'` | 跳过交互式确认；工具自检与路径安全检查仍然执行 |
| 计划模式 | `'plan'` | 只允许只读工具 |

```ts
import { createSession, PermissionMode } from '@blade-ai/agent-sdk';

const session = await createSession({
  provider: { type: 'openai', apiKey: process.env.OPENAI_API_KEY! },
  model: 'gpt-4o',
  permissionMode: PermissionMode.AUTO_EDIT,
});

// 运行时切换
session.setPermissionMode(PermissionMode.YOLO);
```

::: warning
`yolo` 只让内置 mode handler 自动批准；工具级 `ask`、自定义 handler
的 `ask` 和敏感路径确认仍可能要求用户确认。它也不会绕过工具自检或路径
安全策略，仍只应在受控环境中使用。
:::

内置文件工具的敏感文件检测只根据规范化后的路径和文件名分类，不扫描文件内容。
它是权限策略的一层防御，不是 secret scanner；生产环境仍应使用最小化的
filesystem roots 和 OS sandbox。

## 自定义权限回调

通过 `canUseTool` 实现完全自定义的权限逻辑：

```ts
import type { CanUseTool } from '@blade-ai/agent-sdk';

const canUseTool: CanUseTool = async (toolName, input, options) => {
  // options.toolKind: 'readonly' | 'write' | 'execute'
  // options.sideEffect: 'pure' | 'idempotent' | 'non_idempotent'
  // options.affectedPaths: string[]
  // options.signal: AbortSignal

  if (toolName === 'Bash' && String(input.command).includes('rm -rf')) {
    return { behavior: 'deny', message: '禁止执行危险的删除命令' };
  }

  if (options.toolKind === 'readonly') {
    return { behavior: 'allow' };
  }

  return { behavior: 'ask' };
};

const session = await createSession({
  provider: { type: 'openai', apiKey: process.env.OPENAI_API_KEY! },
  model: 'gpt-4o',
  canUseTool,
});
```

## PermissionResult

```ts
type PermissionResult =
  // 允许执行（可选修改输入）
  | {
      behavior: 'allow';
      updatedInput?: JsonObject;
      effects?: ToolEffect[];
      updatedPermissions?: PermissionUpdate[];
    }
  // 拒绝执行
  | { behavior: 'deny'; message: string; interrupt?: boolean }
  // 交给内置权限系统决定
  | { behavior: 'ask'; message?: string };
```

## CanUseToolOptions

```ts
interface CanUseToolOptions {
  signal: AbortSignal;
  toolKind: 'readonly' | 'write' | 'execute';
  sideEffect: 'pure' | 'idempotent' | 'non_idempotent';
  affectedPaths: string[];
}
```

该信号归属于当前 Request。SDK 会将 `canUseTool`、`permissionHandler`、工具输入
校验、工具级权限检查和交互式确认与此信号竞速；交互式处理器通过
`ConfirmationDetails.abortSignal` 收到同一信号。这些等待没有固定墙钟超时。
忽略取消的回调会被持续跟踪，并阻止新的工具执行以及 Session close/handoff，
直至其 Promise 结束。

`permissionHandler` 是完整的底层权限接口，`canUseTool` 是兼容旧集成的简化接口。
如果同时配置两者，SDK 只使用 `permissionHandler`，不会再调用 `canUseTool`。

## 权限与沙箱的关系

权限控制「是否询问」，沙箱控制「能做什么」。两者独立工作，可以组合使用：

| 权限模式 | 沙箱 | 效果 |
|----------|------|------|
| `default` | 开启 | 需要确认 + 受沙箱限制 |
| `autoEdit` | 开启 | 文件操作自动通过 + 受沙箱限制 |
| `yolo` | 开启 | 自动通过 + 受沙箱限制（推荐开发模式） |
| `yolo` | 关闭 | 自动通过 + 无限制（危险） |

详见 [沙箱安全](./sandbox)。
