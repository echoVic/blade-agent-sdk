# Execution Host

`ExecutionHost` 是调度器与任务执行环境之间的稳定边界。服务端只依赖
`provision`、`exec`、`checkpoint`、`restore` 和 `terminate`，不依赖容器、
虚拟机或远程 worker 的具体实现。

```ts
import type { ExecutionHost } from '@blade-ai/agent-sdk/server';
import {
  DockerExecutionHost,
  EphemeralCredentialBroker,
  ExecutionId,
} from '@blade-ai/agent-sdk/node';
```

`DockerExecutionHost` 是 Node.js 参考实现。每次 provision 都创建独立临时目录、
可选 Git worktree staging 和独立 OCI 容器。

## 生命周期

```ts
const host = new DockerExecutionHost();
const executionId = ExecutionId(crypto.randomUUID());

const execution = await host.provision({
  executionId,
  image: 'registry.example.com/agent@sha256:<digest>',
  workspace: {
    kind: 'git-worktree',
    repositoryPath: '/srv/repositories/project',
    revision: 'main',
  },
  resources: {
    cpus: 2,
    memoryBytes: 4 * 1024 ** 3,
    diskBytes: 10 * 1024 ** 3,
    pids: 256,
    runtimeMs: 30 * 60_000,
    maxOutputBytes: 8 * 1024 ** 2,
  },
  network: { mode: 'none' },
});

const result = await host.exec(execution.executionId, {
  command: '/bin/sh',
  args: ['-c', 'npm test'],
  timeoutMs: 10 * 60_000,
});

const checkpoint = await host.checkpoint(execution.executionId, {
  reason: 'handoff',
});
await host.terminate(execution.executionId);

const restored = await host.restore({
  checkpointId: checkpoint.checkpointId,
});
```

`terminate()` 是幂等操作。command 超时、输出超限或 abort 时，Docker 参考实现会
销毁整个容器，而不是只终止 `docker exec` 客户端进程。

## 隔离边界

所有 `ExecutionResourceLimits` 都是必填项：

| 资源 | 强制机制 |
|------|----------|
| CPU | Docker `NanoCpus` |
| 内存 | `Memory` 与相同值的 `MemorySwap` |
| 磁盘 | 从同一预算切分的 `/workspace` 匿名 tmpfs volume、`/tmp` 与 `/dev/shm` |
| PID | `PidsLimit` |
| 运行时长 | host deadline、容器内自终止 deadline 和 `--rm` |
| 输出 | stdout/stderr 合计字节上限 |
| 网络 | 默认 `none`；proxy 模式只接受 `ExecutionEgressController` 创建的隔离网络 |

容器同时使用只读 rootfs、`no-new-privileges`、numeric non-root user 和
`cap-drop=ALL`，不重新添加 capability。provision 完成前会反向读取 Docker
`inspect`；任何限制没有实际生效都会 fail-closed。

镜像默认必须使用不可变 `sha256` digest。参考实现要求镜像提供 `/bin/sh`、
`sleep`、`cat`、`rm` 和 `tar`。镜像中存在疑似长期凭据的环境变量时，
provision 会被拒绝。

Git worktree 是宿主侧的临时 staging。文件复制到有界 tmpfs 后，容器内会删除
worktree 的 `.git` 控制文件，避免泄露宿主仓库路径；宿主 worktree 在 provision
返回前移除。容器 workspace 因此是指定 revision 的隔离快照，不是宿主仓库的
可写挂载。

## 网络出口

`none` 是默认且完整断网。`proxy` 模式必须注入控制器：

```ts
const egressController: ExecutionEgressController = {
  async provision(executionId, policy) {
    const networkName = await createIsolatedProxyNetwork(
      executionId,
      policy.allowedHosts,
    );
    return {
      networkName,
      environment: {
        HTTPS_PROXY: 'http://proxy.internal:8080',
      },
    };
  },
  async release(executionId) {
    await removeIsolatedProxyNetwork(executionId);
  },
};
```

`DockerExecutionHost` 负责验证并连接控制器返回的专用网络；域名 allowlist 的
DNS、IP、TLS 和 CONNECT enforcement 由控制器负责。`none`、`host`、`bridge`
等保留网络不能作为 proxy lease。代理 URL 不允许内嵌用户名或密码。

## 短期凭据

长期 secret 不得通过 provision 或普通 exec environment 传入。用
`CredentialBroker` 为单次 command 签发短期凭据：

```ts
const credentialBroker = new EphemeralCredentialBroker({
  github: {
    environmentVariable: 'GITHUB_EPHEMERAL_TOKEN',
    async issue({ audience, scopes, expiresBy }) {
      return issueGitHubToken({ audience, scopes, expiresBy });
    },
  },
});

const host = new DockerExecutionHost({ credentialBroker });
await host.exec(executionId, {
  command: 'git',
  args: ['fetch', 'origin'],
  credentials: [{
    name: 'github',
    audience: 'github.com',
    scopes: ['contents:read'],
  }],
});
```

环境变量名由 issuer 固定，调用方不能指定。凭据值只进入单个 `docker exec`
子进程的环境，不进入 CLI 参数、容器配置、checkpoint 或长期 Agent 环境。
stdout/stderr 中的原值会被遮蔽。command 结束或 lease 到期后执行 revoke；
issuer 返回超过请求 TTL 的凭据会被拒绝。

## Checkpoint 边界

Docker 参考实现暂停主容器，由无网络、只读 rootfs、drop-all-capabilities 的临时
sidecar 读取同一个 workspace volume，再写入版本化 manifest。restore 会重新
执行完整 provision 校验，再通过有界 tar stream 把 workspace 放入新容器。
checkpoint 不包含进程、内存、网络连接或凭据。

默认 checkpoint 位于本机 `checkpointDirectory`，适合单机恢复和交接。跨 worker
调度必须实现共享 `ExecutionHost`，或把 checkpoint 上传到受控对象存储；不要把
本机 checkpoint ID 当作分布式事实源。
