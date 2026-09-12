# 从示例迁移到真实仓库

[`production` 示例](https://github.com/echoVic/blade-agent-sdk/tree/main/examples/production-stack)在一个一次性 Git 小仓库上跑通
了「读取 → 审批 → 修改 → 跑测试」，并且用 smoke 验证了批准、拒绝、Worker 被 SIGKILL
后的恢复、SSE 续读和取消。本文说明把它换成你自己的仓库、自己的登录系统和自己的数据
保留策略时要改哪些地方。

先读一遍 [Golden Paths](./golden-paths) 里的 production 部分，确认你已经在本地跑通过
`pnpm verify:production-example`。

## 先理解示例的安全模型

示例故意把能力收得很窄，这不是为了演示方便，而是这一层设计的重点。`RepositoryTools.mjs`
里每个工具都把模型输入限制成 argv 或 stdin，程序本身是固定字符串：

| 机制 | 示例做法 | 为什么保留它 |
|------|----------|--------------|
| 路径白名单 | `RepoRead` 只接受 `src/greeting.sh` 与 `test/greeting.test.sh` | 模型不能写出白名单外的路径，符号链接会被显式拒绝 |
| 写前校验 | `RepoWrite` 要求 `expected_content` 与磁盘内容逐字节相等 | 避免覆盖掉别人刚提交的改动，等价于一次乐观锁 |
| 测试可信 | `RepoRunTests` 先比对测试文件内容与预期，再执行 | 否则模型改测试就能「让测试通过」 |
| 无网络 | Docker 容器以 `mode: 'none'` 启动 | 仓库代码不能外联 |

迁移时最容易犯的错，是为了「让它对我的仓库也能用」而直接放宽这几条。建议先把它们映射
到你仓库的真实约束上，再放开范围。

## 第 1 步：换成你的仓库

示例在启动时把一个 fixture 复制成临时 Git 仓库。换成真实仓库时改 `run.mjs` 里创建
`repositoryPath` 的那段：

```js
// 原示例：复制一次性 fixture
const repositoryPath = join(temporaryRoot, 'repository');
await cp(join(root, 'fixture'), repositoryPath, { recursive: true });
await execFileAsync('git', ['init', '--quiet', repositoryPath]);

// 换成真实仓库：克隆一份，不要直接在工作副本上跑 Agent
const repositoryPath = join(temporaryRoot, 'repository');
await execFileAsync('git', ['clone', '--quiet', '--depth', '1',
  process.env.AGENT_REPOSITORY_URL, repositoryPath]);
```

要点：

- **永远让 Agent 工作在克隆或 worktree 上**，不要指向开发者的工作副本。示例的
  checkpoint 恢复会替换文件内容，直接作用于工作副本会丢改动。
- 私有仓库用部署密钥或短期凭据；这套凭据只用于 `git clone`，不进入容器环境变量。
- 想固定到某次提交，clone 之后 `git -C <dir> checkout <sha>`，并把该 SHA 记进日志，
  便于事后追溯这次 Agent 到底改了什么。

## 第 2 步：改工具白名单

`RepositoryTools.mjs` 里的三个固定程序都要按你的仓库改：

1. `READ_FILE` 的 `case` 分支：列出允许读取的路径。读整个仓库通常不现实，先挑 Agent
   真正需要的文件，例如构建脚本、目标源文件、配置。
2. `WRITE_FILE` 的第一个判断：`test "$1" = src/greeting.sh` 换成允许写入的路径集合。
   只允许写源文件，测试文件与 CI 配置保持在白名单外。
3. `RUN_TESTS`：把 `sh test/greeting.test.sh` 换成你仓库真实的测试命令，并保留它前面的
   测试文件内容比对。

如果白名单变长，建议改成从仓库根的一份配置读入，而不是散落在 shell 字符串里：

```js
const allowedWrites = new Set(['packages/api/src/handler.ts', 'packages/api/src/schema.ts']);
const allowedReads = new Set([...allowedWrites, 'package.json', 'pnpm-lock.yaml']);
```

同时把工具描述改成你的路径，否则模型会按示例里的 `src/greeting.sh` 去猜：

```js
defineTool({
  name: 'RepoWrite',
  description: 'Replace an allowed source file after approval.',
  // ...
});
```

## 第 3 步：接自己的登录系统

示例的认证只有一个共享 token：

```js
authenticate(request) {
  if (request.headers.get('authorization') !== 'Bearer local-demo') return null;
  return { tenantId, subject: 'browser-user', scopes: ['session:admin'] };
}
```

`authenticate` 返回的 principal 决定三件事：`tenantId` 隔离存储与事件、`subject` 参与
审批隔离、`scopes` 决定命令授权。换成真实登录时保持这个形状：

```js
authenticate(request) {
  const claims = await verifySessionCookie(request.headers.get('cookie'));
  if (!claims) return null;
  return {
    tenantId: claims.organizationId,
    subject: claims.userId,
    scopes: scopesForRole(claims.role),
  };
}
```

需要知道的边界：

- **不要把 `session:admin` 发给普通用户。** 它满足全部 scope。按角色拆成
  `session:create` / `session:read` / `session:write` / `permission:resolve`
  （`session.fork` 需要 `session:read` + `session:create`）。
- **审批按 tenant、Session、`subject`、`permissionRequestId` 四元组隔离。** 同一个
  Session 里换个人点「Approve」不会命中，这是刻意的。
- 跨租户访问统一返回 `SESSION_NOT_FOUND`，不会泄露 Session 是否存在，别把它当成
  「找不到」来排查。

## 第 4 步：定数据保留策略

示例在退出时删掉临时数据库和 checkpoint。生产环境要反过来，明确保留什么、留多久：

| 数据 | 示例行为 | 生产建议 |
|------|----------|----------|
| 路由、事件、审批、transcript | PostgreSQL，随容器删除 | 独立实例 + 定期备份；事件表按时间分区 |
| 工作区 checkpoint | 本地 `checkpointDirectory` | 换成共享存储或受控对象存储，否则跨机器恢复会失败 |
| Agent 的 Git 改动 | 留在临时仓库里 | 让 Agent 推分支或产出 patch，人工评审后再合并 |
| Docker 工作区卷 | 随容器删除 | 不要长期保留，重建成本低且易残留敏感内容 |

PostgreSQL 侧的 schema 版本是 `3`，`initialize()` 会在全局 advisory lock 下迁移；升级
SDK 版本时先读 [Runtime Store](./runtime-store) 的 schema 小节。

注意本地 checkpoint 只能用在同一台机器上恢复。多副本部署必须实现共享 `ExecutionHost`，
或用受控对象存储上传 checkpoint——把本机 checkpoint ID 当分布式事实源会在换机器恢复时
直接失败。

## 第 5 步：从 smoke 到真实使用

`smoke.mjs` 现在校验的是 fixture 的固定输出（`Tests passed (exit 0).`）。换成真实仓库后
它必然失败，这是好事：它提醒你验收标准变了。建议：

1. 保留 smoke 的**流程断言**（审批发生、Worker 被杀后能恢复、SSE 能续读、取消有效），
   把**内容断言**换成你仓库的判定，例如「指定测试文件从红变绿」。
2. 先用 `--smoke` 走确定性 provider，确认链路；再接 `OPENAI_API_KEY` 换成真实模型。
3. 上线前明确一件事：示例使用单个 API 进程，**不提供 API 故障切换，也不保证任意工具
   恰好执行一次**。测试中断且结果未知时必须停下来对账，不要自动重试。

## 迁移检查清单

- [ ] Agent 工作在 clone/worktree 上，不指向开发者工作副本
- [ ] 读写白名单覆盖真实路径，测试文件与 CI 配置不可写
- [ ] 测试命令来自可信来源，且执行前仍做内容比对
- [ ] 容器网络为 `mode: 'none'`，除非确有外联需求
- [ ] `authenticate` 返回真实 `tenantId` / `subject` / 最小 `scopes`
- [ ] checkpoint 存储跨机器可用，或明确只支持单机恢复
- [ ] smoke 的断言已按你的仓库重写，并在 CI 中定期跑
- [ ] 明确「结果未知」时的对账流程，不依赖自动重试
