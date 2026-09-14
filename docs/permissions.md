# 权限控制

新的 Agent API 只暴露 `AgentOptions.advanced.permission`，用于控制工具执行是
允许、拒绝还是需要应用确认。

## 权限预设

`permission` 支持 4 个预设：

| 预设 | 说明 |
|------|------|
| `'default'` | 写入和执行类工具需要用户确认 |
| `'accept-edits'` | 文件编辑自动通过，命令执行仍需确认 |
| `'bypass-permissions'` | 自动批准非破坏性操作；破坏性操作仍需显式确认 |
| `'plan'` | 只允许只读工具 |

```ts
import { createAgent } from '@blade-ai/agent-sdk';

const agent = await createAgent({
  model: 'gpt-4o',
  apiKey: process.env.OPENAI_API_KEY!,
  advanced: {
    permission: 'accept-edits',
  },
});
```

::: warning
`bypass-permissions` 只让内置 mode handler 自动批准非破坏性操作；`isDestructive` 工具、
工具级 `ask`、自定义 handler 的 `ask` 和敏感路径确认仍可能要求用户确认。
它也不会绕过工具自检或路径安全策略，仍只应在受控环境中使用。
:::

内置文件工具的敏感文件检测只根据规范化后的路径和文件名分类，不扫描文件内容。
它是权限策略的一层防御，不是 secret scanner；生产环境仍应使用最小化的
filesystem roots 和 OS sandbox。

## 自定义权限回调

`permission` 也可以是回调。简单策略直接返回 `'allow'`、`'deny'` 或
`'ask'`：

```ts
const agent = await createAgent({
  model: 'gpt-4o',
  apiKey: process.env.OPENAI_API_KEY!,
  advanced: {
    permission: async (request) => {
      if (
        request.toolName === 'Bash'
        && String(request.input.command ?? '').includes('rm -rf')
      ) {
        return {
          behavior: 'deny',
          message: '禁止执行危险的删除命令',
        };
      }
      return request.kind === 'readonly' ? 'allow' : 'ask';
    },
  },
});
```

回调接收当前 Request 的 `signal`、工具 `kind`、副作用元数据和
`affectedPaths`。需要修改输入、更新权限规则或提供拒绝原因时，可返回完整的
`PermissionResult`：

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

## 底层 Session API

`createSession()` 继续提供 `permissionMode` 和 `permissionHandler`，供框架与
运行时集成使用。`canUseTool` 只为旧集成保留，已弃用；新代码不应同时维护三套入口。

权限回调中的信号归属于当前 Request。SDK 会将权限回调、工具输入校验、工具级
权限检查和交互式确认与此信号竞速；交互式处理器通过
`ConfirmationDetails.abortSignal` 收到同一信号。这些等待没有固定墙钟超时。
忽略取消的回调会被持续跟踪，并阻止新的工具执行以及 Session close/handoff，
直至其 Promise 结束。

低层 Session 的 4 个 `PermissionMode` 值分别是 `default`、`autoEdit`、`yolo`
和 `plan`。`session.setPermissionMode()` 仍可在运行时切换这些底层模式。

## 权限与沙箱的关系

权限控制「是否询问」，沙箱控制「能做什么」。两者独立工作，可以组合使用：

| 权限模式 | 沙箱 | 效果 |
|----------|------|------|
| `default` | 开启 | 需要确认 + 受沙箱限制 |
| `autoEdit` | 开启 | 文件操作自动通过 + 受沙箱限制 |
| `yolo` | 开启 | 自动通过 + 受沙箱限制（推荐开发模式） |
| `yolo` | 关闭 | 自动通过 + 无限制（危险） |

详见 [沙箱安全](./sandbox)。
