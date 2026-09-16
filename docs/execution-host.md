# Execution Host

`ExecutionHost` 是调度器与任务执行环境之间的稳定边界。服务端只依赖
`provision`、`exec`、`checkpoint`、`restore` 和 `terminate`，不依赖容器、
虚拟机或远程 worker 的具体实现。

```ts
import {
  DockerExecutionHost,
  type ExecutionHost,
  ExecutionId,
} from '@blade-ai/agent-sdk/advanced';
```

`DockerExecutionHost` 是 Node.js 参考实现。每次 provision 都创建独立、有界
tmpfs workspace 和 OCI 容器。workspace 可以为空，也可以从一个本地 Git revision
导入。

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
| 磁盘 | `diskBytes` 限制的 `/workspace` tmpfs |
| PID | `PidsLimit` |
| 运行时长 | host deadline、容器内 `sleep` deadline 和 `--rm` |
| 输出 | stdout/stderr 合计字节上限 |
| 网络 | Docker 参考实现只接受 `mode: 'none'` |

容器同时使用只读 rootfs、`no-new-privileges`、numeric non-root user 和
`cap-drop=ALL`，不重新添加 capability。

镜像默认必须使用不可变 `sha256` digest。参考实现要求镜像提供 `/bin/sh`、
`sleep` 和 `tar`。

Git workspace 使用 `git archive` 读取指定 revision，再以容器内 non-root user
解包到 tmpfs。它不创建 worktree、不复制 `.git`，也不把宿主目录 bind mount
进容器。

## 网络出口

`DockerExecutionHost` 只支持完整断网的 `mode: 'none'`。需要代理或域名
allowlist 时应使用应用自有的执行边界；SDK 的 `ExecutionHost` 契约不声明该
能力，参考实现也不会静默降级为普通 Docker 网络。普通环境变量名称不能疑似
包含 token、secret、password、API key 或 credential。

## Checkpoint 边界

Docker 参考实现使用每个 execution 的 mutex 阻止 checkpoint 与 exec 并发，
通过 Docker daemon 复制 workspace 并写入经过 schema 校验的版本化 manifest。
restore 会重新执行完整 provision 校验，再通过有界 tar stream 把 workspace
放入新容器。checkpoint 不包含进程、内存、网络连接或凭据。

默认 checkpoint 位于本机 `checkpointDirectory`，适合单机恢复和交接。跨 worker
调度必须实现共享 `ExecutionHost`，或把 checkpoint 上传到受控对象存储；不要把
本机 checkpoint ID 当作分布式事实源。
