# Worker Runtime

Worker Runtime 在共享 `RuntimeStore` 上提供 worker 存活、Session 路由和执行
租约恢复。PostgreSQL 是唯一协调事实源；Redis 只能用于通知、wake-up 和短期
配额。

## AgentWorker

`AgentWorker` 把 worker 注册、heartbeat、Session claim、lease 续期和恢复扫描
组合为一个常驻执行循环。`SessionRunner` 负责执行单个已经 fencing 的 Session：

```ts
import {
  AgentWorker,
} from '@blade-ai/agent-sdk/server/infra';
import { SdkSessionRunner } from '@blade-ai/agent-sdk/advanced';
import { PostgresRuntimeStore } from '@blade-ai/agent-sdk/server/postgres';
import { WorkerId } from '@blade-ai/agent-sdk';

const store = new PostgresRuntimeStore({
  connectionString: process.env.DATABASE_URL!,
});
const worker = new AgentWorker({
  store,
  workerId: WorkerId(crypto.randomUUID()),
  capacity: 8,
  sessionRunner: new SdkSessionRunner({
    resolveSessionOptions: () => ({
      provider,
      model,
      allowedTools: [],
    }),
  }),
});

const shutdownController = new AbortController();
process.once('SIGTERM', () => shutdownController.abort());
await worker.run(shutdownController.signal);
```

`SdkSessionRunner` 恢复已经持久化的 Request，并自动注入当前 tenant Store 与
worker lease。单轮完成后路由进入 `idle` 并释放 lease；后续输入可以重新入队。

它有三条需要显式处理的契约：

- **发布流事件**：`session.stream()` 的事件不会自动进入控制面，必须传入 `publish`
  回调，否则浏览器看不到任何流式输出或结果：

  ```ts
  sessionRunner: new SdkSessionRunner({
    resolveSessionOptions: () => ({ provider, model, allowedTools: [] }),
    publish: async (tenantId, sessionId, type, data, requestId) => {
      await store.appendEvent(tenantId, sessionId, {
        protocolVersion: 1,
        sessionId,
        requestId,
        occurredAt: new Date().toISOString(),
        type,
        data,
      });
    },
  }),
  ```

- **请求关联**：每条发布的事件都绑定到产生它的 request；当事件自身不带 request id 时，
  沿用本轮的 active request id，因此同一次请求的输出不会串到相邻请求上。
- **失去路由即挂起**：worker 被 drain 或取消时 runner 返回 `{ status: 'suspended' }`，
  由 Worker 走 handoff，而不是把过期结果当作正常结束。
- **独占 persistence 与 executionLease**：`resolveSessionOptions` 若返回
  `sessionRepository`、`sessionEventStore`、`durableEventStore`、
  `durableExecutionLeaseStore` 或 `executionLease` 会直接抛 `TypeError`；结束时
  runner 会把 `durableHandoff` 合并进 route metadata。

需要隔离 workspace 时使用 `ExecutionHostSessionRunner`。它会在 route metadata
中持久化 checkpoint 引用，后继 worker 可通过同一个 `ExecutionHost` backend
恢复。完整可运行示例见
[`examples/postgres-worker-recovery`](https://github.com/echoVic/blade-agent-sdk/tree/main/examples/postgres-worker-recovery)。

### 默认值与约束

`AgentWorker` 在未传参时使用以下默认值：

| 选项 | 默认值 | 说明 |
|------|--------|------|
| `workerTtlMs` | `15_000` | worker 注册租约 |
| `sessionLeaseTtlMs` | `30_000` | 单次 Session claim 的租约 |
| `heartbeatIntervalMs` | `5_000` | 必须小于上面两个 TTL，否则构造器抛 `TypeError` |
| `pollIntervalMs` | `250` | 空队列时的轮询间隔 |
| `recoveryIntervalMs` | `5_000` | 过期租约的恢复扫描间隔 |

## Worker 生命周期

```ts
import {
  ExecutionLeaseId,
  SessionId,
  WorkerId,
} from '@blade-ai/agent-sdk';
import { PostgresRuntimeStore } from '@blade-ai/agent-sdk/server/postgres';

const store = new PostgresRuntimeStore({
  connectionString: process.env.DATABASE_URL!,
});

const workerId = WorkerId(crypto.randomUUID());
await store.registerWorker({
  workerId,
  capacity: 8,
  ttlMs: 30_000,
  metadata: { zone: 'cn-north-1' },
});

await store.heartbeatWorker(workerId, 30_000);
```

worker 必须在 TTL 内持续 heartbeat。过期 worker 会在
`recoverExpiredWork()` 中变为 `offline`，其活动 Session 进入 `suspended`。

滚动发布时先调用：

```ts
await store.drainWorker(workerId);
```

`draining` worker 不再 claim 新 Session，但可继续 heartbeat 并完成已领取工作。
如果 drain 与 claim 竞争，worker 可能已领到 Session 但状态不再是
`running`，此时它会立刻把该 Session handoff 出去，并在 route metadata 上写入
`handoffReason: 'worker_draining_before_start'`。完成 `suspendForHandoff()` 后，
再持久化 handoff：

```ts
await store.handoffSession(tenantId, lease, {
  reason: 'rolling_deploy',
});
```

## Session 路由与状态机

```ts
const sessionId = SessionId(crypto.randomUUID());
await store.enqueueSession(tenantId, sessionId, {
  priority: 10,
});

const claim = await store.claimSession({
  tenantId,
  ownerId: workerId,
  leaseId: ExecutionLeaseId(crypto.randomUUID()),
  ttlMs: 30_000,
});

if (claim) {
  await store.transitionSession(tenantId, claim.lease, {
    expectedState: 'provisioning',
    state: 'running',
  });
}
```

公开状态：

| 状态 | 含义 | 可转换到 |
|------|------|----------|
| `queued` | 等待 worker | `provisioning`、`failed` |
| `provisioning` | worker 已领取，正在准备运行环境 | `running`、`suspended`、`failed` |
| `running` | Session 正在执行 | `waiting_approval`、`suspended`、`idle`、`completed`、`failed` |
| `waiting_approval` | 等待外部审批，worker 仍持有 lease | `running`、`suspended`、`failed` |
| `suspended` | 无 worker 持有，可由新 worker 恢复 | `queued`、`provisioning`、`idle`、`completed`、`failed` |
| `idle` | 本轮完成且未持有 lease，可接受后续输入 | `queued`、`completed`、`failed` |
| `completed` | 正常终态 | 无 |
| `failed` | 失败终态 | 无 |

每次重新领取都会递增 `fencingToken`。所有状态转换都要求当前
`leaseId + fencingToken`，旧 worker 即使恢复执行，也不能提交新状态或 durable
event。

## Session execution fence

`runtimeStore.forTenant(tenantId)` 实现 `DurableExecutionLeaseStore`。调度器领取
Session 后，应把 claim 中的 owner 和 lease ID 传给 Session：

```ts
const session = await resumeSession({
  ...sessionOptions,
  sessionId: claim.route.sessionId,
  durableExecutionLeaseStore: runtimeStore.forTenant(claim.route.tenantId),
  executionLease: {
    ownerId: claim.lease.ownerId,
    leaseId: claim.lease.leaseId,
    ttlMs: 30_000,
  },
});
```

一旦 Session 建立过 execution lease，该要求保持 sticky。未携带 fence、已过期
或已被新 worker 取代的 durable append 都会 fail-closed。

### Runner 返回结果与 finalize

`SessionRunner.run()` 返回 `SessionRunResult`；`/advanced` 同时导出
`SessionRunner`、`SessionRunnerContext` 与 `SessionRunResult`：

```ts
type SessionRunResult =
  | { status: 'idle' | 'completed' | 'suspended'; metadata?: JsonObject; finalize?: () => Promise<void> }
  | { status: 'failed'; failure: JsonObject; metadata?: JsonObject; finalize?: () => Promise<void> };
```

Worker 会按结果把路由结算为 `idle`、`completed` 或 `failed`；结果为 `suspended`
时则执行移交。`finalize` **只在**上述带执行权校验的结算或移交成功后执行，因此适合
用来发布已确认的最终结果；结算失败时它不会执行，Worker 会把该租约视为未恢复，交给
恢复流程处理。

由于 `finalize` 是条件执行的，runner 必须在 `run()` 返回前自行完成资源清理，不能
依赖 `finalize` 释放必须释放的句柄。

### 自定义 SessionRunner

`SessionRunner` 的契约由 `/advanced` 拥有。自定义实现应直接实现该接口；不要依赖
`AgentWorker` 私有状态，也不要从 deprecated `/server` 入口导入类型：

```ts
import type {
  SessionRunner,
  SessionRunnerContext,
  SessionRunResult,
} from '@blade-ai/agent-sdk/advanced';

export class RepositorySessionRunner implements SessionRunner {
  // 省略时由 AgentWorker 维护 claim lease。
  readonly managesLease = false;

  async run(context: SessionRunnerContext): Promise<SessionRunResult> {
    const { route } = context.claim;
    await context.transition('running', {
      ...route.metadata,
      executor: 'repository',
    });

    try {
      const result = await runRepositoryAgent({
        sessionId: route.sessionId,
        store: context.store.forTenant(route.tenantId),
        signal: context.signal,
        executionHost: context.executionHost,
      });

      // 必须在返回前释放文件、进程、socket 等资源。
      await result.dispose();

      return {
        status: result.completed ? 'completed' : 'idle',
        metadata: {
          ...route.metadata,
          checkpointId: result.checkpointId,
        },
        // 路由完成 fenced settlement 后才发布终态。
        finalize: () => publishTerminalResult(route, result),
      };
    } catch (error) {
      if (context.signal.aborted) {
        await suspendRepositoryAgent(route.sessionId);
        return { status: 'suspended', metadata: route.metadata };
      }
      return {
        status: 'failed',
        failure: {
          message: error instanceof Error ? error.message : String(error),
        },
        metadata: route.metadata,
      };
    }
  }
}
```

实现必须遵守以下边界：

- `run()` 只处理 `context.claim` 指定的 tenant、Session 与 fencing token。
- `transition()` 仅用于 `running` / `waiting_approval`；终态由 Worker 统一结算。
- 无法证明恢复边界完整时返回 `failed`，不能猜测为 `idle`。
- `context.signal` 中止时停止接收新副作用，并在返回前完成确定性清理。
- `finalize` 只发布已结算结果，不承担资源释放、checkpoint 或必要持久化。
- 自行维护 lease 时才设置 `managesLease = true`，并负责续租与 fencing 校验。

`SdkSessionRunner` 是 SDK Session 的默认实现；需要复用其全部语义时直接实例化并
注入 `AgentWorker`。领域执行器应实现 `SessionRunner`，而不是继承并覆写
`SdkSessionRunner` 的内部流程。

## 恢复循环

调度器应周期执行：

```ts
const recovered = await store.recoverExpiredWork();
```

该操作：

1. 将 heartbeat 过期的 worker 标记为 `offline`。
2. 释放对应 execution lease，并把活动 Session 置为 `suspended`。
3. 将超过安全窗口仍未完成的 sealed command 标记为 `abandoned`，要求调用方
   对账而不是自动重放。

## 健康与遥测

`worker.getHealth()` 是无 I/O 的本地健康快照。`ready` 要求 Worker 处于
`running` 且最近一次成功 heartbeat 未超过 worker TTL；`draining` 和
`stopped` 保持 live，但不再 ready。

`AgentWorkerTelemetry` 是显式注入端口，提供 `recordSnapshot()` 和
`recordError()`。SDK 不绑定具体 telemetry backend；实现不得向 worker
生命周期抛错，也不得保留 Session 输入或凭据。

## 故障边界

- Session lease 使用单调 fencing token。
- `drain` 不会强制终止工作；必须显式 handoff。
- Worker heartbeat 和 Session lease 是独立 TTL，长任务必须分别续期。
- sealed command 超时后只会被 abandon，不会自动重新执行。
- PostgreSQL 事务与 advisory lock 负责 correctness；Redis 故障不改变结果。
