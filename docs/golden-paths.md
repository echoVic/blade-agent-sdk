# Golden Paths

仓库提供四条可直接运行的完整路径，所有示例只导入公开 package entrypoint。

## 单命令生产闭环

```bash
pnpm example:production
```

打开命令输出的本地 URL。该命令自动启动并在退出时清理 PostgreSQL、Worker
使用的 Docker 容器、volume 和临时目录。请求会完整经过：

```text
Browser AgentClient
→ AgentServer
→ PostgreSQL route queue
→ AgentWorker + SDK Session
→ Docker repository tools
→ PostgreSQL event log
→ SSE
```

无需浏览器的自动验收命令：

```bash
pnpm run build
pnpm verify:production-example
```

输出中的 `firstResultMs` 从基础设施编排开始计时；smoke 只有在五分钟内收到
真实仓库测试通过的结果后才成功。它会读取文件、批准修改，在写入检查点保存后
强制终止 Worker，再重连 SSE，确认新 Worker 以更高的 fencing token 完成任务。
同一验收还覆盖等待审批时的 Worker 重启、第二轮对话、拒绝写入、取消，以及取消后的新任务。

页面可以输入：**修复 greeting，让它输出 Hello, Blade!，然后运行测试。**
Agent 会先读文件，展示待修改内容，等待 **Approve once** 或 **Deny**，再执行
写入和测试。页面会显示工具进度、测试输出和最终回答。
不设置 API key 时，确定性的模型适配器驱动真实 SDK 工具调用；设置
`OPENAI_API_KEY` 和可选的 `OPENAI_MODEL` 后使用模型。`--smoke` 始终使用确定性适配器。

示例使用临时 Git 小仓库，允许读取两个文件、修改一个源文件，并执行固定测试命令。
接入其他仓库时，可扩展 `RepositoryTools.mjs` 的路径和工具约束。模型运行在 Worker，
文件操作和测试运行在禁用网络的 Docker 容器中。Worker 意外退出后，启动器会自动拉起新进程。启动器运行期间，聊天记录、审批、
取消意图和工作区检查点能跨 Worker 重启保存；退出启动器会删除临时数据库和检查点。
启动器不在进程内缓存恢复状态：路由状态、fencing token 和已提交的工作区检查点都从
PostgreSQL 读取，因此任何后继进程看到的是同一个恢复边界。

自动恢复只处理结果可确认的步骤：文件替换校验预期内容，保存检查点后才返回成功；
若测试执行中断且结果未知，则停止并要求核验。示例使用单个 API 进程，不提供 API
故障切换，也不保证任意工具恰好执行一次。

同一 smoke 还会验证后继 Worker 的本地 readiness 快照；只有恢复后的 Worker
ready 时验收才会通过。

## 生成独立项目

已发布的 SDK 自带 `create-blade-agent` 可执行文件。使用 `--preset` 选择所需
拓扑：

| Preset | 路径 | 额外基础设施 | 首次结果预算 |
|--------|------|--------------|----------------|
| `local` | Node + 进程内 Session | 无 | 1 分钟 |
| `web` | Browser AgentClient → AgentServer → 进程内 Session | 无 | 2 分钟 |
| `production` | Browser → AgentServer → PostgreSQL → Worker → Docker | Docker | 5 分钟 |

最小本地 Agent：

```bash
npm exec --yes --package=@blade-ai/agent-sdk@latest -- \
  create-blade-agent my-agent --preset local --verify
```

Web Agent：

```bash
npm exec --yes --package=@blade-ai/agent-sdk@latest -- \
  create-blade-agent my-agent --preset web --verify
```

完整生产拓扑：

```bash
npm exec --yes --package=@blade-ai/agent-sdk@latest -- \
  create-blade-agent my-agent --preset production --verify
```

预算从 CLI 启动开始计算，覆盖生成、安装和首个真实结果。PR 与 Release CI
会从当前 SDK tarball 安装 CLI，执行三个 preset，并分别审计生成项目的
production dependency tree。省略 `--preset` 时生成默认的 `local` starter；
省略 `--verify` 时不会执行 smoke；`--skip-install` 只生成文件。

## 本地 CLI Agent

```bash
BLADE_DEMO_MODE=mock pnpm example:local -- "检查当前仓库"
```

使用真实 OpenAI：

```bash
OPENAI_API_KEY=... pnpm example:local -- "检查当前仓库"
```

该路径覆盖 Node runtime profile、内置工具、流式输出和本地 JSONL 持久化。

## Web + AgentServer

```bash
pnpm example:web
```

打开 <http://127.0.0.1:8787>。浏览器使用 `AgentClient`，服务端使用 `AgentServer`，
状态落在 `.blade/` 下：`JsonlAgentServerStore` 保存会话记录、事件日志和审批，
`JsonlSessionRepository` 保存转录。未设置 `OPENAI_API_KEY` 时由脚本化 provider
驱动同一套真实工具；设置后调用真实模型，`OPENAI_BASE_URL` 可指向任何兼容端点。

页面是一条时间线：思考、带状态和输出的工具卡、审批卡、插入指令的标记和流式回答。
输入 **Analyze this project's dependency risks**，运行中再输入 **Focus on security
issues** 回车，指令以 `now` 优先级插入当前任务。停掉服务再启动、刷新页面后输入
**Continue the analysis**，会话记录、事件游标和转录都从磁盘恢复。`--root <dir>`
分析别的仓库，`--no-open` 不打开浏览器。

工具是 Read、Glob、Grep 和 Bash。OS 沙箱可用时（macOS seatbelt、Linux bubblewrap）
Bash 在沙箱内运行并自动放行；否则每条命令都是一张审批卡。破坏性命令始终询问。

`node examples/web-agent-server/server.mjs --smoke` 用脚本化 provider 走完 9 步：
工具、steering、在同一数据目录上重建 store 与 server 的模拟重启、续写会话。

## PostgreSQL + 两个 Worker + Docker 恢复

```bash
pnpm example:worker-recovery
```

该路径会：

1. 启动隔离的 PostgreSQL。
2. Worker A 在 Docker workspace 中写入状态并持久化 checkpoint。
3. 对 Worker A 发送 `SIGKILL`。
4. 等待 lease 过期并执行恢复扫描。
5. Worker B 使用更高 fencing token 恢复 checkpoint。
6. 验证 workspace 后完成 Session。
7. 删除 PostgreSQL、容器、volume 和临时文件。

需要本机安装 Docker。完整源码位于
[`examples/`](https://github.com/echoVic/blade-agent-sdk/tree/main/examples)。
