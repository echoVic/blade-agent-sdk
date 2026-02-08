# Hooks

Hooks 是用户定义的 shell 命令或 LLM 提示，在 Blade Agent SDK 生命周期的特定点自动执行。通过 Hooks，你可以：

- 在工具执行前后注入自定义逻辑
- 自动批准或拒绝权限请求
- 验证和过滤用户输入
- 在会话开始时加载开发上下文
- 阻止任务过早完成

## Hook 生命周期

当事件触发且匹配器匹配时，SDK 会将事件的 JSON 上下文传递给你的 hook 处理器。对于命令 hooks，数据通过 stdin 传入。处理器可以检查输入、执行操作，并可选地返回决策。

下表总结了每个事件的触发时机：

| 事件 | 触发时机 | 是否可阻止 |
|------|----------|------------|
| `SessionStart` | 会话开始或恢复时 | ❌ |
| `UserPromptSubmit` | 用户提交 prompt 时，在处理之前 | ✅ |
| `PreToolUse` | 工具调用执行前 | ✅ |
| `PermissionRequest` | 权限对话框出现时 | ✅ |
| `PostToolUse` | 工具调用成功后 | ❌ |
| `PostToolUseFailure` | 工具调用失败后 | ❌ |
| `Notification` | 发送通知时 | ❌ |
| `SubagentStart` | 子 Agent 启动时 | ❌ |
| `SubagentStop` | 子 Agent 完成时 | ✅ |
| `Stop` | Agent 完成响应时 | ✅ |
| `TaskCompleted` | 任务被标记为完成时 | ✅ |
| `Compaction` | 上下文压缩前 | ❌ |
| `SessionEnd` | 会话终止时 | ❌ |

## 配置

Hooks 在 `createSession` 时通过 `hooks` 配置项定义：

```typescript
import { createSession } from '@blade-ai/agent-sdk';

const session = await createSession({
  hooks: {
    enabled: true,
    defaultTimeout: 60,
    timeoutBehavior: 'ignore',
    failureBehavior: 'ignore',
    
    // 工具执行类
    PreToolUse: [
      {
        matcher: 'Bash',
        hooks: [
          {
            type: 'command',
            command: './scripts/validate-bash.sh',
            timeout: 10
          }
        ]
      }
    ],
    
    // 权限控制
    PermissionRequest: [
      {
        matcher: 'Write|Edit',
        hooks: [
          {
            type: 'command',
            command: './scripts/auto-approve-edits.sh'
          }
        ]
      }
    ]
  }
});
```

### 配置字段

| 字段 | 类型 | 默认值 | 描述 |
|------|------|--------|------|
| `enabled` | boolean | `true` | 是否启用 hooks |
| `defaultTimeout` | number | `60` | 默认超时时间（秒） |
| `timeoutBehavior` | `'ignore'` \| `'deny'` \| `'ask'` | `'ignore'` | 超时时的行为 |
| `failureBehavior` | `'ignore'` \| `'deny'` \| `'ask'` | `'ignore'` | 失败时的行为 |
| `maxConcurrentHooks` | number | `5` | 最大并发 hooks 数 |

### Matcher 模式

`matcher` 字段是一个正则表达式字符串，用于过滤 hooks 何时触发。使用 `"*"`、`""` 或省略 `matcher` 来匹配所有情况。

不同事件类型匹配不同的字段：

| 事件 | 匹配字段 | 示例 |
|------|----------|------|
| `PreToolUse`, `PostToolUse`, `PostToolUseFailure`, `PermissionRequest` | 工具名称 | `Bash`, `Edit\|Write`, `mcp__.*` |
| `SessionStart` | 会话启动方式 | `startup`, `resume`, `clear`, `compact` |
| `SessionEnd` | 会话结束原因 | `clear`, `logout`, `error`, `other` |
| `Notification` | 通知类型 | `permission_prompt`, `idle_prompt`, `info` |
| `SubagentStart`, `SubagentStop` | Agent 类型 | `Bash`, `Explore`, `Plan` |
| `Compaction` | 触发方式 | `manual`, `auto` |
| `UserPromptSubmit`, `Stop`, `TaskCompleted` | 不支持匹配器 | 每次都触发 |

### Hook 处理器类型

每个 hook 处理器可以是以下类型之一：

#### Command Hook

运行 shell 命令，通过 stdin 接收 JSON 输入，通过 stdout 返回 JSON 输出：

```typescript
{
  type: 'command',
  command: './scripts/my-hook.sh',
  timeout: 30,
  statusMessage: '正在验证...'
}
```

#### Prompt Hook

发送提示给 Claude 模型进行单轮评估：

```typescript
{
  type: 'prompt',
  prompt: '检查以下命令是否安全: $ARGUMENTS',
  model: 'claude-sonnet-4-20250514',
  timeout: 30
}
```

#### Agent Hook

启动一个子 agent 来验证条件：

```typescript
{
  type: 'agent',
  prompt: '验证这个文件修改是否符合代码规范',
  timeout: 60
}
```

## Hook 输入和输出

### 通用输入字段

所有 hook 事件都会收到以下基础字段：

| 字段 | 类型 | 描述 |
|------|------|------|
| `session_id` | string | 当前会话 ID |
| `hook_event_name` | string | 事件名称 |
| `hook_execution_id` | string | 本次执行的唯一 ID |
| `timestamp` | string | ISO 8601 时间戳 |
| `project_dir` | string | 项目目录 |
| `permission_mode` | string | 当前权限模式 |

### 退出码

| 退出码 | 含义 |
|--------|------|
| `0` | 成功，继续执行。解析 stdout 中的 JSON 输出 |
| `2` | 阻止错误。stderr 作为错误消息反馈给 Claude |
| 其他 | 非阻止错误。stderr 在详细模式下显示 |

### JSON 输出

通用输出字段：

| 字段 | 类型 | 描述 |
|------|------|------|
| `continue` | boolean | 如果为 `false`，停止整个处理流程 |
| `stopReason` | string | 当 `continue` 为 `false` 时显示给用户的消息 |
| `suppressOutput` | boolean | 如果为 `true`，隐藏 stdout 输出 |
| `systemMessage` | string | 显示给用户的警告消息 |

---

## Hook 事件详解

### SessionStart

会话开始或恢复时触发。用于加载开发上下文或设置环境变量。

**输入字段：**

| 字段 | 类型 | 描述 |
|------|------|------|
| `source` | `'startup'` \| `'resume'` \| `'clear'` \| `'compact'` | 会话启动方式 |
| `is_resume` | boolean | 是否是恢复的会话 |
| `resume_session_id` | string? | 恢复的会话 ID |

**输出字段：**

| 字段 | 类型 | 描述 |
|------|------|------|
| `env` | `Record<string, string>` | 持久化到整个会话的环境变量 |
| `additionalContext` | string | 添加到 Claude 上下文的内容 |

**示例：**

```bash
#!/bin/bash
# session-start.sh - 加载项目上下文

echo '{"hookSpecificOutput": {"hookEventName": "SessionStart", "additionalContext": "当前分支: main, 最近提交: abc123"}}'
```

---

### UserPromptSubmit

用户提交 prompt 时触发，在 Claude 处理之前。可用于验证、过滤或修改用户输入。

**输入字段：**

| 字段 | 类型 | 描述 |
|------|------|------|
| `user_prompt` | string | 用户原始提示词 |
| `has_images` | boolean | 是否包含图片 |
| `image_count` | number | 图片数量 |

**输出字段：**

| 字段 | 类型 | 描述 |
|------|------|------|
| `decision` | `'block'` | 阻止 prompt 处理 |
| `reason` | string | 阻止原因（显示给用户） |
| `updatedPrompt` | string | 修改后的提示词 |
| `contextInjection` | string | 注入到上下文的内容 |

**示例：**

```bash
#!/bin/bash
# validate-prompt.sh - 验证用户输入

PROMPT=$(jq -r '.user_prompt')

if echo "$PROMPT" | grep -qi "password\|secret\|api.key"; then
  echo '{"decision": "block", "reason": "检测到敏感信息，请勿在提示中包含密码或密钥"}' >&2
  exit 2
fi

exit 0
```

---

### PreToolUse

工具调用执行前触发。可以阻止、修改或批准工具调用。

**输入字段：**

| 字段 | 类型 | 描述 |
|------|------|------|
| `tool_name` | string | 工具名称 |
| `tool_use_id` | string | 工具调用 ID |
| `tool_input` | object | 工具输入参数 |

**常见工具的 `tool_input` 结构：**

- **Bash**: `{ command: string, timeout?: number }`
- **Write**: `{ file_path: string, content: string }`
- **Edit**: `{ file_path: string, old_string: string, new_string: string }`
- **Read**: `{ file_path: string, offset?: number, limit?: number }`

**输出字段：**

| 字段 | 类型 | 描述 |
|------|------|------|
| `permissionDecision` | `'allow'` \| `'deny'` \| `'ask'` | 权限决策 |
| `permissionDecisionReason` | string | 决策原因 |
| `updatedInput` | object | 修改后的工具输入 |
| `additionalContext` | string | 添加到 Claude 上下文的内容 |

**示例：**

```bash
#!/bin/bash
# block-dangerous-commands.sh

COMMAND=$(jq -r '.tool_input.command')

if echo "$COMMAND" | grep -q 'rm -rf'; then
  jq -n '{
    hookSpecificOutput: {
      hookEventName: "PreToolUse",
      permissionDecision: "deny",
      permissionDecisionReason: "危险命令被阻止"
    }
  }'
else
  exit 0
fi
```

---

### PermissionRequest

权限对话框出现时触发。可以自动批准或拒绝权限请求。

**输入字段：**

| 字段 | 类型 | 描述 |
|------|------|------|
| `tool_name` | string | 工具名称 |
| `tool_use_id` | string | 工具调用 ID |
| `tool_input` | object | 工具输入参数 |

**输出字段：**

| 字段 | 类型 | 描述 |
|------|------|------|
| `permissionDecision` | `'approve'` \| `'deny'` \| `'ask'` | 权限决策 |
| `permissionDecisionReason` | string | 决策原因 |

**示例：**

```typescript
// 使用 canUseTool 回调（推荐的简化 API）
const session = await createSession({
  canUseTool: async (toolName, input, options) => {
    // 只读工具自动批准
    if (options.toolKind === 'readonly') {
      return { behavior: 'allow' };
    }
    
    // npm 命令自动批准
    if (toolName === 'Bash' && input.command?.startsWith('npm ')) {
      return { behavior: 'allow' };
    }
    
    // 其他情况询问用户
    return { behavior: 'ask' };
  }
});
```

---

### PostToolUse

工具调用成功后触发。用于日志记录、后处理或注入额外上下文。

**输入字段：**

| 字段 | 类型 | 描述 |
|------|------|------|
| `tool_name` | string | 工具名称 |
| `tool_use_id` | string | 工具调用 ID |
| `tool_input` | object | 工具输入参数 |
| `tool_output` | unknown | 工具输出结果 |

**输出字段：**

| 字段 | 类型 | 描述 |
|------|------|------|
| `additionalContext` | string | 添加到 Claude 上下文的内容 |
| `updatedOutput` | unknown | 修改后的工具输出 |

**示例：**

```bash
#!/bin/bash
# post-write-lint.sh - 写入文件后运行 lint

TOOL_NAME=$(jq -r '.tool_name')
FILE_PATH=$(jq -r '.tool_input.file_path')

if [[ "$TOOL_NAME" == "Write" || "$TOOL_NAME" == "Edit" ]]; then
  if [[ "$FILE_PATH" == *.ts || "$FILE_PATH" == *.tsx ]]; then
    npx eslint --fix "$FILE_PATH" 2>/dev/null
  fi
fi

exit 0
```

---

### PostToolUseFailure

工具调用失败后触发。用于错误处理和日志记录。

**输入字段：**

| 字段 | 类型 | 描述 |
|------|------|------|
| `tool_name` | string | 工具名称 |
| `tool_use_id` | string | 工具调用 ID |
| `tool_input` | object | 工具输入参数 |
| `error` | string | 错误信息 |
| `error_type` | string? | 错误类型 |
| `is_interrupt` | boolean | 是否被中断 |
| `is_timeout` | boolean | 是否超时 |

---

### Stop

Agent 完成响应时触发。可以阻止停止，让 Agent 继续工作。

**输入字段：**

| 字段 | 类型 | 描述 |
|------|------|------|
| `stop_reason` | string | 停止原因 |
| `final_response` | string? | 最终响应内容 |

**输出字段：**

| 字段 | 类型 | 描述 |
|------|------|------|
| `continue` | boolean | 如果为 `true`，阻止停止并继续执行 |
| `continueReason` | string | 继续执行的原因（反馈给 Claude） |
| `additionalContext` | string | 添加到 Claude 上下文的内容 |

**示例：**

```bash
#!/bin/bash
# ensure-tests-pass.sh - 确保测试通过后才停止

npm test > /dev/null 2>&1
if [ $? -ne 0 ]; then
  jq -n '{
    hookSpecificOutput: {
      hookEventName: "Stop",
      continue: true,
      continueReason: "测试失败，请修复后再完成任务"
    }
  }'
else
  exit 0
fi
```

---

### SubagentStart

子 Agent 启动时触发。用于注入上下文或记录日志。

**输入字段：**

| 字段 | 类型 | 描述 |
|------|------|------|
| `agent_type` | string | 子 Agent 类型（如 Bash, Explore, Plan） |
| `task_description` | string? | 任务描述 |
| `parent_agent_id` | string? | 父 Agent ID |

**输出字段：**

| 字段 | 类型 | 描述 |
|------|------|------|
| `additionalContext` | string | 注入给子 agent 的额外上下文 |

---

### SubagentStop

子 Agent 完成时触发。可以阻止子 agent 停止。

**输入字段：**

| 字段 | 类型 | 描述 |
|------|------|------|
| `agent_type` | string | 子 Agent 类型 |
| `task_description` | string? | 任务描述 |
| `success` | boolean | 是否成功 |
| `result_summary` | string? | 结果摘要 |
| `error` | string? | 错误信息 |

**输出字段：**

| 字段 | 类型 | 描述 |
|------|------|------|
| `continue` | boolean | 如果为 `false`，阻止停止 |
| `continueReason` | string | 继续执行的原因 |
| `additionalContext` | string | 额外上下文 |

---

### TaskCompleted

任务被标记为完成时触发。可以阻止任务完成，确保质量。

**输入字段：**

| 字段 | 类型 | 描述 |
|------|------|------|
| `task_id` | string | 任务 ID |
| `task_description` | string | 任务描述 |
| `result_summary` | string? | 任务结果摘要 |
| `success` | boolean | 是否成功 |

**输出字段：**

| 字段 | 类型 | 描述 |
|------|------|------|
| `blockCompletion` | boolean | 阻止任务完成 |
| `blockReason` | string | 阻止原因（会反馈给 Claude） |

**示例：**

```bash
#!/bin/bash
# verify-task-completion.sh - 验证任务是否真正完成

# 运行测试
npm test > /dev/null 2>&1
TEST_RESULT=$?

# 运行类型检查
npm run type-check > /dev/null 2>&1
TYPE_RESULT=$?

if [ $TEST_RESULT -ne 0 ] || [ $TYPE_RESULT -ne 0 ]; then
  jq -n '{
    hookSpecificOutput: {
      hookEventName: "TaskCompleted",
      blockCompletion: true,
      blockReason: "测试或类型检查失败，请修复后再标记任务完成"
    }
  }'
else
  exit 0
fi
```

---

### Notification

发送通知时触发。用于自定义通知处理。

**输入字段：**

| 字段 | 类型 | 描述 |
|------|------|------|
| `notification_type` | string | 通知类型 |
| `title` | string? | 通知标题 |
| `message` | string | 通知内容 |

**通知类型：**
- `permission_prompt` - 权限提示
- `idle_prompt` - 空闲提示
- `auth_success` - 认证成功
- `elicitation_dialog` - 引导对话
- `info` / `warning` / `error` - 信息/警告/错误

---

### Compaction

上下文压缩前触发。可以阻止压缩。

**输入字段：**

| 字段 | 类型 | 描述 |
|------|------|------|
| `trigger` | `'manual'` \| `'auto'` | 触发方式 |
| `messages_before` | number | 压缩前消息数 |
| `tokens_before` | number | 压缩前 token 数 |

**输出字段：**

| 字段 | 类型 | 描述 |
|------|------|------|
| `blockCompaction` | boolean | 阻止压缩 |
| `blockReason` | string | 阻止原因 |

---

### SessionEnd

会话终止时触发。用于清理和日志记录。

**输入字段：**

| 字段 | 类型 | 描述 |
|------|------|------|
| `reason` | string | 终止原因 |
| `total_turns` | number? | 总对话轮数 |
| `total_tokens` | number? | 总 token 数 |

**终止原因：**
- `user_exit` - 用户退出
- `error` - 错误
- `max_turns` - 达到最大轮数
- `idle_timeout` - 空闲超时
- `ctrl_c` - Ctrl+C
- `clear` - 清除会话
- `logout` - 登出
- `other` - 其他

---

## canUseTool 回调

除了 Hooks 系统，SDK 还提供了更简洁的 `canUseTool` 回调来控制工具权限：

```typescript
const session = await createSession({
  canUseTool: async (toolName, input, options) => {
    // options 包含:
    // - toolKind: 'readonly' | 'write' | 'execute' | 'mcp'
    // - toolUseId: string
    // - abortSignal?: AbortSignal
    
    if (options.toolKind === 'readonly') {
      return { behavior: 'allow' };
    }
    
    if (toolName === 'Bash' && input.command?.includes('rm -rf')) {
      return { behavior: 'deny', message: '禁止危险命令' };
    }
    
    return { behavior: 'ask' };
  }
});
```

**返回值：**

| 字段 | 类型 | 描述 |
|------|------|------|
| `behavior` | `'allow'` \| `'deny'` \| `'ask'` | 权限决策 |
| `message` | string? | 拒绝时显示的消息 |

**优先级：**
- 如果提供了 `canUseTool`，它会**优先执行**
- 如果返回 `{ behavior: 'ask' }`，则回退到传统的确认流程（包括 `PermissionRequest` hooks）

---

## 最佳实践

1. **保持 hooks 快速** - hooks 会阻塞执行，尽量在 10 秒内完成
2. **使用退出码** - 用退出码 2 表示阻止，0 表示成功
3. **返回有意义的消息** - 阻止时提供清晰的原因
4. **处理错误** - 使用 `failureBehavior` 配置失败时的行为
5. **使用 canUseTool** - 对于简单的权限控制，优先使用 `canUseTool` 回调
