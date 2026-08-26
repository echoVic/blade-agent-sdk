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
→ AgentWorker
→ DockerExecutionHost
→ PostgreSQL event log
→ SSE
```

无需浏览器的自动验收命令：

```bash
pnpm run build
pnpm verify:production-example
```

输出中的 `firstResultMs` 从基础设施编排开始计时；smoke 只有在五分钟内收到
Docker worker 生成的精确结果后才成功。

同一 smoke 还会验证无需鉴权的 `/v1/runtime/readyz`，以及使用本地 operator
令牌访问的、按租户隔离的 `/v1/runtime/metrics`。只有 Worker ready 且队列指标
反映已完成的 Session 时，验收才会通过。

## 生成独立项目

已发布的 SDK 自带 `create-blade-agent` 可执行文件。以下单命令会临时安装 CLI、
生成独立项目、安装项目依赖并运行完整 production smoke：

```bash
npm exec --yes --package=@blade-ai/agent-sdk@latest -- \
  create-blade-agent my-agent --verify
```

五分钟预算从 CLI 启动开始计算，覆盖生成、安装、PostgreSQL 编排、Worker
启动和首个 Docker 结果。PR 与 Release CI 会从当前 SDK tarball 安装 CLI，
执行相同流程，并对生成项目运行 production dependency audit。省略 `--verify`
时不会启动 stack；`--skip-install` 只生成文件。

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

打开 <http://127.0.0.1:8787>。浏览器代码使用 `AgentClient`，服务端使用
`AgentServer` 和 Fetch-compatible handler。未设置 `OPENAI_API_KEY` 时使用
确定性本地 provider，设置后调用真实 OpenAI。

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
