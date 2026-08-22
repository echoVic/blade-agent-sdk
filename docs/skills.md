# Skills 系统

Skills 是可复用的指令模板，以 `SKILL.md` 文件形式存在，支持 YAML 前置元数据和内联命令。

## 目录结构

```
<cwd>/skills/              # 配置 cwd 后的默认项目目录
  deploy/
    SKILL.md
    scripts/
      deploy.sh
```

Session 默认只在 filesystem context 的 `cwd` 下扫描 `skills/`。当前公开
`SessionOptions` 不提供用户级目录或额外来源配置；需要这些来源时，应由上层
应用完成发现并把能力显式接入。

::: warning 多 workspace 进程
Skill registry 当前是进程级单例，并在第一次初始化后缓存结果。同一进程承载
多个不同 `cwd` 时，不应假设每个 Session 都有独立的 Skill 目录；需要隔离时
请使用独立进程。
:::

## SKILL.md 格式

```markdown
---
name: deploy-staging
description: 部署到 staging 环境
allowed-tools: [Bash, Read, Glob]
user-invocable: true
argument-hint: "<environment>"
model: inherit
scope: turn
when_to_use: "当用户要求部署到 staging 或测试环境时触发"
---

# 部署到 Staging

1. 运行测试：!`npm test`
2. 构建项目：!`npm run build`
3. 部署到 staging：!`./scripts/deploy.sh staging`
```

### 前置元数据

| 字段 | 类型 | 默认值 | 说明 |
|------|------|--------|------|
| `name` | `string` | — | Skill 唯一标识，小写+数字+连字符，≤64 字符 |
| `description` | `string` | — | 激活描述，≤1024 字符 |
| `allowed-tools` | `string[]` | 全部 | 限制 Skill 执行期间可用的工具，如 `['Read', 'Grep', 'Bash(git:*)']` |
| `disallowed-tools` | `string[]` | 无 | Skill 激活期间禁止的工具 |
| `version` | `string` | — | 版本号 |
| `argument-hint` | `string` | — | 参数提示，显示在可用 Skills 列表中，如 `<file_path>` |
| `user-invocable` | `boolean` | `false` | 是否支持用户通过 `/skill-name` 命令调用 |
| `disable-model-invocation` | `boolean` | `false` | 是否禁止 AI 自动调用。为 `true` 时不出现在可用列表，但仍可通过 `/skill-name` 调用 |
| `model` | `string` | 当前模型 | 执行模型。`inherit` 显式继承当前模型，或指定具体模型名切换 |
| `effort` | `number` | — | 运行时模型 effort 覆盖 |
| `scope` | `'turn' \| 'session'` | `'session'` | 运行时效果的生命周期 |
| `paths` | `string \| string[]` | — | 路径激活条件 |
| `shell` | `boolean \| string[] \| object` | 按来源策略 | 内联命令执行策略 |
| `hooks` | `object[]` | — | 激活时注册的运行时 Hook |
| `when_to_use` | `string` | — | 额外触发条件描述，补充 `description` 帮助 AI 判断何时使用 |
| `license` | `string` | — | 许可证，如 `Apache-2.0`、`MIT` |
| `compatibility` | `string` | — | 环境兼容性说明（≤500 字符），如 `Requires git, python3 and network access` |
| `metadata` | `Record<string, unknown>` | — | 任意元数据键值对 |

### 运行时效果 (Runtime Effects)

当 Skill 被激活后，SDK 会自动应用以下运行时效果：

- **工具限制**：如果设置了 `allowed-tools`，当前 Agent 循环中只允许使用指定的工具
- **模型切换**：如果设置了 `model`（且不为 `inherit`），会自动切换到指定模型执行

默认 `scope: session`，效果持续到 Session 结束。只有显式设置
`scope: turn` 时，效果才会在当前轮结束后解除。

### 内联命令

使用 `` !`command` `` 语法标记可执行命令，SDK 会自动执行这些命令。

### scripts/ 目录

每个 Skill 可以包含一个 `scripts/` 目录，SDK 会自动发现并告知 LLM 可用的脚本文件。

## 工作机制

1. 内置 `Skill` 工具让 LLM 可以发现和调用 Skills
2. LLM 读取 SKILL.md 内容，按照其中的指令执行
3. 内联命令 `` !`command` `` 会被 SDK 自动执行
4. `scripts/` 目录中的脚本会被列为可用资源
5. Skill 激活后，`allowed-tools` 和 `model` 等运行时效果自动生效

## 完整示例

### 代码审查 Skill

```markdown
---
name: code-review
description: 对当前变更进行代码审查，检查类型安全、错误处理和性能问题
allowed-tools: [Read, Glob, Grep]
user-invocable: true
argument-hint: "<file_or_directory>"
model: inherit
when_to_use: "当用户请求代码审查、review、或检查代码质量时触发"
license: MIT
---

# 代码审查

请对指定的文件或目录进行代码审查，关注以下方面：

1. 类型安全和潜在的运行时错误
2. 错误处理是否完善
3. 性能隐患
4. 安全漏洞（OWASP Top 10）

输出格式：按严重程度排序的问题列表，每个问题包含文件、行号、描述和修复建议。
```

### 仅用户可调用的 Skill

```markdown
---
name: setup-env
description: 初始化本地开发环境
user-invocable: true
disable-model-invocation: true
---

# 环境初始化

!`npm install`
!`cp .env.example .env`
!`npm run db:migrate`
```

::: tip
`user-invocable` 和 `disable-model-invocation` 是供上层应用读取的发现元数据。
SDK 不提供 `/setup-env` 这样的命令解析器；CLI 或 UI 需要自行把用户命令映射到 Skill 激活。
:::
