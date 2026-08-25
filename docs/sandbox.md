# 沙箱安全

Sandbox 为内置 `Bash` 工具提供尽力而为的操作系统隔离。Linux 使用 Bubblewrap，macOS 使用 Seatbelt (`sandbox-exec`)。权限系统决定是否批准调用；Sandbox 尝试限制批准后的命令。

::: danger 显式启用即为强约束
`sandbox.enabled: true` 要求当前机器具备支持的沙箱执行器。执行器不可用时，
Session 初始化会抛出 `ConfigError`；低层命令包装也会拒绝执行，不会降级为
原样运行命令。
:::

## 安全初始化

```ts
import {
  createSession,
  PermissionMode,
  getSandboxService,
} from '@blade-ai/agent-sdk/node';

const sandbox = getSandboxService();
sandbox.configure({
  enabled: true,
});

const capabilities = sandbox.getCapabilities();
if (!capabilities.available) {
  throw new Error('Required OS sandbox is unavailable');
}

const session = await createSession({
  provider,
  model,
  permissionMode: PermissionMode.DEFAULT,
  sandbox: sandbox.getSettings(),
});
```

Sandbox 与内置 `Bash` 属于本地 Node.js 宿主能力，因此从 `/node` 入口导入。

## SandboxSettings

```ts
interface SandboxSettings {
  enabled?: boolean;
  autoAllowBashIfSandboxed?: boolean;
  excludedCommands?: string[];
  allowUnsandboxedCommands?: boolean;
  network?: NetworkSandboxSettings;
  ignoreViolations?: SandboxIgnoreViolations;
  enableWeakerNestedSandbox?: boolean;
}
```

| 字段 | 默认值 | 当前行为 |
|------|--------|----------|
| `enabled` | `false` | 强制 `Bash` 使用 OS 沙箱；执行器不可用时抛出 `ConfigError` |
| `autoAllowBashIfSandboxed` | `false` | 可查询的配置标记；当前执行管道未读取，不能据此假设 Bash 会自动批准 |
| `excludedCommands` | `[]` | 显式跳过指定命令的沙箱包装；这些命令会在宿主环境直接执行，应谨慎使用 |
| `allowUnsandboxedCommands` | `false` | 允许 `SandboxService.checkCommand()` 的显式无沙箱请求进入权限确认；当前内置 Bash 不暴露该请求参数 |
| `network` | 未设置 | 传给命令包装器的网络选项 |
| `ignoreViolations` | 未设置 | 可供上层查询的忽略规则；当前命令包装器不会应用这些规则 |
| `enableWeakerNestedSandbox` | `false` | 保留配置；当前命令包装器未读取 |

## 能力检测

```ts
import { getSandboxService } from '@blade-ai/agent-sdk/node';

const capabilities = getSandboxService().getCapabilities();

console.log(capabilities.available);
console.log(capabilities.type); // 'bubblewrap' | 'seatbelt' | 'none'
console.log(capabilities.features);
```

`available === false` 是部署配置错误。启用 Sandbox 后，SDK 会 fail closed；
应用仍可在创建 Session 前检查能力，以提供自定义错误或禁用 `Bash`。

## 文件系统边界

启用且可用时：

- 工作目录可读写。
- 系统二进制和必要系统目录只读挂载或由 Seatbelt profile 放行。
- 临时目录可读写。
- 包管理器目录可能按平台 profile 放行。

这些规则只包装内置 `Bash`。自定义工具和远程 MCP Server 必须自行建立隔离边界。

## 网络配置

```ts
interface NetworkSandboxSettings {
  allowLocalBinding?: boolean;
  allowUnixSockets?: string[];
  allowAllUnixSockets?: boolean;
  httpProxyPort?: number;
  socksProxyPort?: number;
}
```

当前命令包装器只消费 `allowLocalBinding`：

- `allowLocalBinding: false` 会禁用命令的网络能力。
- 省略或设为 `true` 时允许网络。

`allowUnixSockets`、`allowAllUnixSockets`、`httpProxyPort` 和 `socksProxyPort` 目前仅由配置服务保存和查询，尚未进入 Bubblewrap/Seatbelt 包装逻辑。不要把它们视为已生效的安全策略。

## 权限与 Sandbox

| 层 | 负责内容 |
|----|----------|
| 工具自检与路径安全 | 拒绝无效输入和越界文件访问 |
| `permissionMode` / `canUseTool` | 决定 allow、deny 或 ask |
| Sandbox | 限制已获批 Bash 命令的 OS 能力 |

`PermissionMode.YOLO` 只跳过交互式确认，不会绕过工具自检或路径安全检查。它也不会让不可用的 Sandbox 自动变为可用。

## 推荐生产策略

```ts
const sandbox = getSandboxService();
sandbox.configure({
  enabled: true,
  autoAllowBashIfSandboxed: false,
  network: {
    allowLocalBinding: false,
  },
});

if (!sandbox.getCapabilities().available) {
  throw new Error('Sandbox is required for this deployment');
}
```

同时：

1. 通过 `allowedTools` 或 `disallowedTools` 控制是否暴露 `Bash`。
2. 使用 `canUseTool` 拒绝业务层不允许的命令。
3. 不把 `ignoreViolations` 或 Unix socket 配置当作已执行的隔离规则。
4. 对自定义工具和 MCP Server 单独做进程、容器或远端权限隔离。

## 排错

### 命令没有显示 sandbox 消息

检查：

```ts
const service = getSandboxService();
console.log(service.isEnabled());
console.log(service.getCapabilities());
```

如果 `available` 为 `false`，启用 Sandbox 会导致 Session 初始化失败；直接
调用低层 wrapper 也会抛出 `ConfigError`。

### 网络被完全禁用

检查是否配置了：

```ts
network: {
  allowLocalBinding: false,
}
```

当前实现将该值映射为禁用全部网络，而不只是禁止监听本地端口。

### 需要严格隔离

不要依赖自动降级。应在容器或受控主机中运行，启动时强制验证能力，并在检测失败时终止进程。
