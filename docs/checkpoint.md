# 文件检查点

本指南介绍 Blade Agent SDK 的文件检查点功能，用于追踪 Agent 对文件的修改并支持回滚到之前的状态。

## 概述

文件检查点在 Agent 执行期间自动追踪文件修改，支持以下功能：

- **撤销错误** - 当 Agent 做出错误修改时回滚
- **追踪变更** - 查看从特定时间点以来修改了哪些文件
- **安全实验** - 尝试不同方案并可随时回滚

## 启用检查点

创建会话时启用文件检查点：

```typescript
import { createSession } from '@blade-ai/agent-sdk';

const session = await createSession({
  provider: { type: 'openai-compatible', apiKey: process.env.API_KEY },
  model: 'gpt-4o-mini',
  enableFileCheckpointing: true
});
```

## 基本用法

### 自动追踪

启用后，SDK 会自动追踪以下工具的文件操作：
- `Write` - 文件创建和覆盖
- `Edit` - 文件修改

```typescript
// Agent 修改文件
await session.send('将 src/utils.ts 重构为使用 async/await');
for await (const msg of session.stream()) {
  if (msg.type === 'content') {
    process.stdout.write(msg.delta);
  }
}
```

### 回滚文件

将文件恢复到特定消息时的状态：

```typescript
const result = await session.rewindFiles('user-message-uuid');

if (result.success) {
  console.log('已恢复文件:', result.restoredFiles);
  console.log('已删除文件:', result.deletedFiles);
} else {
  console.error('回滚错误:', result.errors);
}
```

### 查看统计信息

```typescript
const stats = session.getCheckpointStatistics();

if (stats) {
  console.log('检查点数量:', stats.checkpointCount);
  console.log('追踪的文件数:', stats.trackedFileCount);
  console.log('待处理变更数:', stats.pendingChangeCount);
}
```

## 工作原理

### 检查点创建

检查点在消息边界创建：

```
消息 1 (用户)        消息 2 (助手)          消息 3 (用户)
      │                   │                      │
      ▼                   ▼                      ▼
┌─────────────┐    ┌─────────────┐       ┌─────────────┐
│ 创建检查点  │    │ 追踪文件变更│       │ 创建检查点  │
└─────────────┘    └─────────────┘       └─────────────┘
```

### 文件追踪

每次文件操作：

1. **写入前** - 捕获当前文件状态（内容、是否存在、时间戳）
2. **执行操作** - 写入或编辑文件
3. **写入后** - 记录变更（操作类型、前后快照）

### 回滚逻辑

回滚到检查点时：

```
目标检查点                         当前状态
      │                                │
      ▼                                ▼
┌─────────┐    ┌─────────┐    ┌─────────┐
│ msg-001 │ ── │ msg-002 │ ── │ msg-003 │
│ foo.ts  │    │ bar.ts  │    │ new.ts  │
│ (原始)  │    │ (编辑)  │    │ (创建)  │
└─────────┘    └─────────┘    └─────────┘

rewindFiles('msg-001'):
- foo.ts → 恢复到 msg-001 时的状态
- bar.ts → 恢复到 msg-001 时的状态
- new.ts → 删除（在 msg-001 时不存在）
```

## 类型定义

### `RewindResult`

回滚操作的结果。

```typescript
interface RewindResult {
  success: boolean;
  restoredFiles: string[];
  deletedFiles: string[];
  errors: RewindError[];
}
```

| 字段 | 类型 | 描述 |
|:-----|:-----|:-----|
| `success` | `boolean` | 回滚是否成功完成 |
| `restoredFiles` | `string[]` | 已恢复到之前状态的文件 |
| `deletedFiles` | `string[]` | 已删除的文件（检查点后创建的） |
| `errors` | `RewindError[]` | 发生的错误 |

### `RewindError`

```typescript
interface RewindError {
  filePath: string;
  error: string;
}
```

### `FileSnapshot`

捕获某一时刻的文件状态。

```typescript
interface FileSnapshot {
  filePath: string;
  content: string | null;
  exists: boolean;
  timestamp: Date;
}
```

| 字段 | 类型 | 描述 |
|:-----|:-----|:-----|
| `filePath` | `string` | 文件的绝对路径 |
| `content` | `string \| null` | 文件内容（不存在时为 null） |
| `exists` | `boolean` | 文件是否存在 |
| `timestamp` | `Date` | 快照时间 |

### `FileChange`

记录一次文件操作。

```typescript
interface FileChange {
  filePath: string;
  operation: 'create' | 'modify' | 'delete';
  beforeSnapshot: FileSnapshot | null;
  afterSnapshot: FileSnapshot;
  timestamp: Date;
}
```

| 字段 | 类型 | 描述 |
|:-----|:-----|:-----|
| `filePath` | `string` | 被修改的文件 |
| `operation` | `'create' \| 'modify' \| 'delete'` | 操作类型 |
| `beforeSnapshot` | `FileSnapshot \| null` | 变更前的状态 |
| `afterSnapshot` | `FileSnapshot` | 变更后的状态 |
| `timestamp` | `Date` | 变更发生时间 |

### `MessageCheckpoint`

将文件变更与消息关联。

```typescript
interface MessageCheckpoint {
  messageUuid: string;
  messageRole: 'user' | 'assistant';
  timestamp: Date;
  fileChanges: FileChange[];
  fileSnapshots: Map<string, FileSnapshot>;
}
```

## CheckpointService API

### 获取服务实例

```typescript
import { getCheckpointService } from '@blade-ai/agent-sdk';

const checkpointService = getCheckpointService();
```

### 配置

```typescript
checkpointService.configure({
  enabled: true,
  maxCheckpoints: 100,        // 可选：限制检查点数量
  excludePatterns: ['*.log']  // 可选：排除模式
});
```

### 手动操作

```typescript
// 修改前捕获文件状态
await checkpointService.captureBeforeWrite('/path/to/file.ts');

// 记录文件变更
checkpointService.trackFileChange('/path/to/file.ts', 'modify');

// 创建检查点
checkpointService.createCheckpoint('message-uuid', 'user');

// 回滚到检查点
const result = await checkpointService.rewindFiles('target-message-uuid');

// 获取检查点后变更的文件
const files = checkpointService.getChangedFilesSince('message-uuid');

// 获取统计信息
const stats = checkpointService.getStatistics();
```

## 完整示例

```typescript
import { createSession } from '@blade-ai/agent-sdk';

async function main() {
  const session = await createSession({
    provider: { type: 'openai-compatible', apiKey: process.env.API_KEY },
    model: 'gpt-4o-mini',
    enableFileCheckpointing: true
  });

  // 记录用户消息 UUID 以便后续回滚
  let checkpointMessageId: string | undefined;

  // 第一次交互 - 创建文件
  await session.send('创建一个 utils.ts 文件，包含常用工具函数');
  for await (const msg of session.stream()) {
    if (msg.type === 'turn_start') {
      checkpointMessageId = msg.sessionId;
    }
    if (msg.type === 'content') {
      process.stdout.write(msg.delta);
    }
  }

  // 查看当前统计
  const stats = session.getCheckpointStatistics();
  console.log('\n检查点统计:', stats);

  // 第二次交互 - 修改文件
  await session.send('给 utils.ts 添加更复杂的函数');
  for await (const msg of session.stream()) {
    if (msg.type === 'content') {
      process.stdout.write(msg.delta);
    }
  }

  // 对修改不满意？回滚到第一次交互
  if (checkpointMessageId) {
    console.log('\n正在回滚...');
    const result = await session.rewindFiles(checkpointMessageId);
    
    if (result.success) {
      console.log('回滚成功！');
      console.log('已恢复:', result.restoredFiles);
      console.log('已删除:', result.deletedFiles);
    } else {
      console.error('回滚失败:', result.errors);
    }
  }

  session.close();
}

main();
```

## 最佳实践

1. **记录消息 UUID** - 保存重要消息的 UUID 以便精确回滚
2. **检查统计信息** - 监控检查点统计以了解变更范围
3. **处理错误** - 始终检查 `result.success` 并处理错误
4. **及时回滚** - 发现问题后尽快回滚以减少冲突
5. **注意内存** - 检查点使用内存；长会话考虑设置限制

## 限制

- **内存存储** - 检查点存储在内存中，会话关闭后丢失
- **会话范围** - 检查点仅在当前会话内有效
- **文件系统访问** - 恢复文件需要写入权限
- **单进程** - 不支持多进程共享
