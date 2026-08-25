# Worker Runtime

Worker Runtime 在共享 `RuntimeStore` 上提供 worker 存活、Session 路由、执行租约
和 effect outbox 恢复。PostgreSQL 是唯一协调事实源；Redis 只能用于通知、wake-up
和短期配额。

## Worker 生命周期

```ts
import {
  ExecutionLeaseId,
  SessionId,
  WorkerId,
} from '@blade-ai/agent-sdk';
import {
  effectLease,
  PostgresRuntimeStore,
} from '@blade-ai/agent-sdk/server/postgres';

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

`draining` worker 不再 claim 新 Session 或 effect，但可继续 heartbeat 并完成
已领取工作。完成 `suspendForHandoff()` 后，再持久化 handoff：

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
| `running` | Session 正在执行 | `waiting_approval`、`suspended`、`completed`、`failed` |
| `waiting_approval` | 等待外部审批，worker 仍持有 lease | `running`、`suspended`、`failed` |
| `suspended` | 无 worker 持有，可由新 worker 恢复 | `queued`、`provisioning`、`completed`、`failed` |
| `completed` | 正常终态 | 无 |
| `failed` | 失败终态 | 无 |

每次重新领取都会递增 `fencingToken`。所有状态转换都要求当前
`leaseId + fencingToken`，旧 worker 即使恢复执行，也不能提交新状态或 durable
event。

`preemptSession()` 会立即释放当前 lease，并将 Session 置为 `suspended` 或重新
放回 `queued`。它是控制面操作；调用方应同时取消旧 worker 的计算资源。

## Session execution fence

`runtimeStore.forTenant(tenantId)` 实现 `DurableExecutionLeaseStore`。调度器领取
Session 后，应把 claim 中的 owner 和 lease ID 传给 Session：

```ts
const session = await resumeSession({
  ...sessionOptions,
  sessionId: claim.route.sessionId,
  executionLease: {
    ownerId: claim.lease.ownerId,
    leaseId: claim.lease.leaseId,
    ttlMs: 30_000,
  },
});
```

一旦 Session 建立过 execution lease，该要求保持 sticky。未携带 fence、已过期
或已被新 worker 取代的 durable append 都会 fail-closed。

## Effect outbox

effect 有两种执行模式：

- `idempotent`：目标系统接受 idempotency key；执行中崩溃后可以重新领取。
- `at_most_once`：用于不能安全重放的非幂等操作；进入 `executing` 后不再自动
  重试。

```ts
await store.commitRuntimeTransaction({
  tenantId,
  sessionId,
  command,
  effects: [{
    effectId: crypto.randomUUID(),
    type: 'payment.capture',
    payload: { paymentId },
    idempotencyKey: `payment:${paymentId}`,
    executionMode: 'at_most_once',
  }],
});

const [effect] = await store.claimEffects({
  tenantId,
  workerId,
  ttlMs: 30_000,
  limit: 1,
});

if (effect) {
  const lease = effectLease(effect);
  await store.startEffect(lease);
  await executeExternalEffect(effect.payload);
  await store.completeEffect(lease, { delivered: true });
}
```

执行顺序必须是 `claim -> startEffect -> external side effect -> completeEffect`：

- 在 `startEffect` 前崩溃：lease 过期后回到 `pending`，可以安全重新领取。
- 在 `startEffect` 后崩溃：`at_most_once` effect 进入 `uncertain`，不会自动重放。
- `idempotent` effect 在执行 lease 过期后回到 `pending`，依赖目标系统的
  idempotency key 去重。

`at_most_once` 保证“不重复”，不保证“一定执行”。`uncertain` 不能直接重试；
业务对账后通过 `reconcileEffect()` 将其明确收敛为 `completed` 或 `failed`。

长任务应同时续期 worker heartbeat 和 effect lease：

```ts
await store.heartbeatWorker(workerId, 30_000);
await store.renewEffectLease(effectLease(effect), 30_000);
```

## 恢复循环

调度器应周期执行：

```ts
const recovered = await store.recoverExpiredWork();
```

该操作：

1. 将 heartbeat 过期的 worker 标记为 `offline`。
2. 释放对应 execution lease，并把活动 Session 置为 `suspended`。
3. 将尚未开始的 effect 重新放回 `pending`。
4. 只重排 `idempotent` 的执行中 effect。
5. 将 `at_most_once` 的执行中 effect 标记为 `uncertain`。

## 故障边界

- Session lease 与 effect lease 都使用单调 fencing token。
- `drain` 不会强制终止工作；必须显式 handoff。
- `preempt` 使旧 fence 立即失效。
- Worker heartbeat 和任务 lease 是独立 TTL，长任务必须分别续期。
- `uncertain` 是需要对账的终态，不能被普通 claim 重新领取。
- PostgreSQL 事务与 advisory lock 负责 correctness；Redis 故障不改变结果。
