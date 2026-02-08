# 沙箱执行

本指南介绍 Blade Agent SDK 的沙箱功能，提供 OS 级别的命令执行隔离。

## 概述

沙箱功能将 Agent 执行的命令限制在安全隔离的环境中，限制对文件系统和网络的访问。适用于：

- **安全执行** - 防止恶意或意外的系统修改
- **权限控制** - 限制文件系统和网络访问
- **自动批准** - 在沙箱内自动批准 Bash 命令

## 支持的技术

| 平台 | 技术 | 描述 |
|:-----|:-----|:-----|
| **Linux** | Bubblewrap (bwrap) | 轻量级容器化 |
| **macOS** | Seatbelt (sandbox-exec) | 内置沙箱机制 |

## 启用沙箱

创建会话时启用沙箱：

```typescript
import { createSession } from '@blade-ai/agent-sdk';

const session = await createSession({
  provider: { type: 'openai-compatible', apiKey: process.env.API_KEY },
  model: 'gpt-4o-mini',
  sandbox: {
    enabled: true,
    autoAllowBashIfSandboxed: true
  }
});
```

## 配置选项

### `SandboxSettings`

```typescript
interface SandboxSettings {
  enabled?: boolean;
  autoAllowBashIfSandboxed?: boolean;
  allowUnsandboxedCommands?: string[];
  excludedCommands?: string[];
  network?: NetworkSettings;
  ignoreFileViolations?: string[];
  ignoreNetworkViolations?: string[];
}
```

| 字段 | 类型 | 默认值 | 描述 |
|:-----|:-----|:-------|:-----|
| `enabled` | `boolean` | `false` | 启用沙箱执行 |
| `autoAllowBashIfSandboxed` | `boolean` | `false` | 沙箱内自动批准 Bash |
| `allowUnsandboxedCommands` | `string[]` | `[]` | 允许非沙箱执行的命令 |
| `excludedCommands` | `string[]` | `[]` | 完全排除沙箱的命令 |
| `network` | `NetworkSettings` | - | 网络访问设置 |
| `ignoreFileViolations` | `string[]` | `[]` | 忽略的文件违规 |
| `ignoreNetworkViolations` | `string[]` | `[]` | 忽略的网络违规 |

### `NetworkSettings`

```typescript
interface NetworkSettings {
  allowLocalBinding?: boolean;
  allowAllUnixSockets?: boolean;
  allowedUnixSockets?: string[];
}
```

| 字段 | 类型 | 默认值 | 描述 |
|:-----|:-----|:-------|:-----|
| `allowLocalBinding` | `boolean` | `false` | 允许绑定本地端口 |
| `allowAllUnixSockets` | `boolean` | `false` | 允许所有 Unix 套接字 |
| `allowedUnixSockets` | `string[]` | `[]` | 允许的特定套接字路径 |

## 常用配置

### 沙箱内自动批准 Bash

```typescript
const session = await createSession({
  sandbox: {
    enabled: true,
    autoAllowBashIfSandboxed: true
  },
  // ...
});
```

### 允许特定命令非沙箱执行

某些命令可能需要完整系统访问：

```typescript
const session = await createSession({
  sandbox: {
    enabled: true,
    allowUnsandboxedCommands: ['git', 'npm', 'docker']
  },
  // ...
});
```

### 排除特定命令

```typescript
const session = await createSession({
  sandbox: {
    enabled: true,
    excludedCommands: ['sudo', 'systemctl']
  },
  // ...
});
```

### 配置网络访问

```typescript
const session = await createSession({
  sandbox: {
    enabled: true,
    network: {
      allowLocalBinding: true,
      allowAllUnixSockets: false,
      allowedUnixSockets: ['/var/run/docker.sock']
    }
  },
  // ...
});
```

### 忽略特定违规

```typescript
const session = await createSession({
  sandbox: {
    enabled: true,
    ignoreFileViolations: ['/tmp/*', '*.log'],
    ignoreNetworkViolations: ['localhost:*']
  },
  // ...
});
```

## SandboxService API

### 获取服务实例

```typescript
import { getSandboxService } from '@blade-ai/agent-sdk';

const sandboxService = getSandboxService();
```

### 配置

```typescript
sandboxService.configure({
  enabled: true,
  autoAllowBashIfSandboxed: true
});
```

### 检查命令

```typescript
const result = sandboxService.checkCommand('npm install');
// { allowed: true, requiresPermission: false, reason: '...' }
```

### 状态检查

```typescript
// 检查沙箱是否启用
const isEnabled = sandboxService.isEnabled();

// 检查是否应自动批准 Bash
const shouldAutoAllow = sandboxService.shouldAutoAllowBash();

// 检查命令是否被排除
const isExcluded = sandboxService.isCommandExcluded('git status');

// 检查文件违规是否应忽略
const ignoreFile = sandboxService.shouldIgnoreFileViolation('/tmp/test.log');

// 检查网络违规是否应忽略
const ignoreNetwork = sandboxService.shouldIgnoreNetworkViolation('localhost:3000');
```

## SandboxExecutor API

### 获取执行器

```typescript
import { getSandboxExecutor } from '@blade-ai/agent-sdk';

const executor = getSandboxExecutor();
```

### 检查能力

```typescript
const capabilities = await executor.getCapabilities();
// {
//   available: true,
//   type: 'bubblewrap',
//   features: {
//     networkIsolation: true,
//     filesystemIsolation: true,
//     processIsolation: true
//   }
// }
```

### 检查可用性

```typescript
const canUse = await executor.canUseSandbox();
```

### 包装命令

```typescript
const wrappedCommand = await executor.wrapCommand('npm install', {
  workDir: '/path/to/project',
  allowNetwork: true,
  allowedReadPaths: ['/home/user'],
  allowedWritePaths: ['/path/to/project']
});
```

## 平台设置

### Linux (Bubblewrap)

安装 Bubblewrap：

```bash
# Ubuntu/Debian
sudo apt install bubblewrap

# Fedora
sudo dnf install bubblewrap

# Arch Linux
sudo pacman -S bubblewrap
```

能力：
- 文件系统隔离
- 网络隔离
- 进程隔离
- 用户命名空间隔离

### macOS (Seatbelt)

无需安装 - Seatbelt 是 macOS 内置功能。

能力：
- 文件系统限制
- 网络限制
- 进程限制

## 完整示例

```typescript
import { createSession, getSandboxExecutor } from '@blade-ai/agent-sdk';

async function main() {
  // 检查沙箱能力
  const executor = getSandboxExecutor();
  const capabilities = await executor.getCapabilities();
  
  console.log('沙箱可用:', capabilities.available);
  console.log('沙箱类型:', capabilities.type);
  console.log('功能:', capabilities.features);

  // 创建带沙箱的会话
  const session = await createSession({
    provider: { type: 'openai-compatible', apiKey: process.env.API_KEY },
    model: 'gpt-4o-mini',
    sandbox: {
      enabled: true,
      autoAllowBashIfSandboxed: true,
      allowUnsandboxedCommands: ['git'],
      network: {
        allowLocalBinding: true
      }
    }
  });

  // 命令在沙箱中运行
  await session.send('运行 npm install 安装依赖');
  for await (const msg of session.stream()) {
    if (msg.type === 'content') {
      process.stdout.write(msg.delta);
    }
    if (msg.type === 'tool_use' && msg.name === 'Bash') {
      console.log('\n执行:', msg.input);
    }
  }

  session.close();
}

main();
```

## 安全考虑

### 沙箱限制

沙箱不能防止所有安全风险：

- **资源消耗** - 进程仍可使用 CPU/内存
- **信息泄露** - 某些系统信息可能仍可访问
- **逃逸风险** - 沙箱技术可能存在漏洞

### 最佳实践

1. **最小权限** - 只授予必要的访问权限
2. **监控日志** - 关注沙箱违规日志
3. **保持更新** - 定期更新沙箱工具
4. **纵深防御** - 结合 `canUseTool` 等其他控制

## 故障排除

### Bubblewrap 不可用

```bash
# 检查安装
which bwrap

# 检查权限
ls -la /usr/bin/bwrap
```

### macOS Seatbelt 错误

常见问题：
- **SIP 限制** - 某些操作被系统完整性保护阻止
- **权限问题** - 确保应用有所需权限

### 调试日志

```typescript
import { createLogger, LogCategory } from '@blade-ai/agent-sdk';

const logger = createLogger(LogCategory.SANDBOX);
// 日志显示详细的沙箱信息
```

## 类型参考

### `SandboxCapabilities`

```typescript
interface SandboxCapabilities {
  available: boolean;
  type: 'bubblewrap' | 'seatbelt' | 'none';
  features: {
    networkIsolation: boolean;
    filesystemIsolation: boolean;
    processIsolation: boolean;
  };
}
```

### `SandboxCheckResult`

```typescript
interface SandboxCheckResult {
  allowed: boolean;
  requiresPermission: boolean;
  reason: string;
}
```
