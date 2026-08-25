# Runtime Store

`RuntimeStore` 是服务端 Agent 的共享持久化边界。它把 command receipt、domain
event、effect outbox 和 projection checkpoint 放进同一个事务，同时向现有
`AgentServer`、Session transcript 和 durable journal 暴露兼容端口。

## 安装与导入

```bash
pnpm add @blade-ai/agent-sdk
```

```ts
import { AgentServer } from '@blade-ai/agent-sdk/server';
import { PostgresRuntimeStore } from '@blade-ai/agent-sdk/server/postgres';

const runtimeStore = new PostgresRuntimeStore({
  connectionString: process.env.DATABASE_URL!,
});

const server = new AgentServer({
  runtimeStore,
  authenticate,
  resolveSessionOptions: () => ({
    provider,
    model,
  }),
  requirePersistentSessions: true,
});
```

传入 `runtimeStore` 后，默认 `InProcessSessionExecutor` 会按认证得到的
`tenantId` 调用 `forTenant()`，并把同一个 scoped Store 同时用作：

- `SessionRepository`：只读 transcript projection。
- `SessionEventStore`：追加 transcript domain event。
- `DurableEventStore`：Request、Turn、模型、工具与审批 journal。
- `AgentServerStore`：command receipt、远程 event 和 Session record。

配置 `runtimeStore` 后不允许再覆盖 Session 级 repository、event Store 或
durable Store；混用会返回 `SESSION_CONFLICT`，防止重新产生双写事实源。

## 事务模型

```ts
const claim = await runtimeStore.claimCommand(
  tenantId,
  commandId,
  commandFingerprint,
  30_000,
);

if (claim.status !== 'claimed') {
  throw new Error(`Unexpected claim: ${claim.status}`);
}

await runtimeStore.sealCommand(tenantId, commandId, claim.leaseId);

await runtimeStore.commitRuntimeTransaction({
  tenantId,
  sessionId,
  command: {
    commandId,
    fingerprint: commandFingerprint,
    leaseId: claim.leaseId,
    result: {
      protocolVersion: 1,
      commandId,
      ok: true,
      data: { accepted: true },
    },
  },
  expectedLastSequence: null,
  events: [{
    type: 'request.accepted',
    data: { requestId: 'request-1' },
  }],
  effects: [{
    effectId: 'effect-1',
    type: 'tool.execute',
    payload: { toolName: 'Search' },
    idempotencyKey: 'request-1:tool-1',
  }],
  projection: {
    name: 'request',
    expectedOffset: null,
    offset: 1,
    state: { status: 'accepted' },
  },
});
```

一次 commit 在单个 PostgreSQL transaction 中完成：

1. 校验 command fingerprint 与可选 lease。
2. compare-and-append domain events。
3. 写入具有唯一 idempotency key 的 effect intents。
4. CAS 更新 projection 和 offset。
5. 将 command receipt 标记为 completed 并保存结果。

任何一步失败都会回滚全部写入。重复提交已完成的 command 返回
`status: 'replayed'`，不会重复 event 或 effect。不同 payload 复用同一 command
ID 会抛出 `RUNTIME_STORE_COMMAND_CONFLICT`。

## PostgreSQL schema

`PostgresRuntimeStore.initialize()` 幂等创建七类表：

| 表 | 作用 |
|----|------|
| `*_metadata` | Runtime Store schema version |
| `*_commands` | command fingerprint、lease、状态和确定性结果 |
| `*_sessions` | tenant-scoped Session record |
| `*_stream_heads` | 每 Session、每 stream 的单调 sequence |
| `*_events` | `agent`、`domain`、`durable`、`transcript` 事件 |
| `*_outbox` | 待执行 effect intent |
| `*_projections` | projection state 与已消费 offset |

`schema` 与 `tablePrefix` 只接受 PostgreSQL identifier。所有数据值使用参数化
查询。并发 command 和 stream append 使用 transaction-scoped advisory lock；
PostgreSQL 是事实源，Redis 不参与 correctness path。

`InMemoryAgentServerStore` 仍只适合测试和单进程。生产环境不得把它与
PostgreSQL transcript 混用。

## Session projection

`SessionRepository` 从本版本开始只描述 read/projection API。
`SessionEventStore` 描述 append API，`SessionPersistence` 是兼容两者的组合。
现有 `JsonlSessionRepository` 继续实现组合接口，因此 Node 本地用法不变。

```ts
interface SessionRepository extends SessionStore {
  initialize(): Promise<void>;
  deleteSession(sessionId: SessionId): Promise<void>;
  cleanupOldSessions(): Promise<void>;
  getStorageStats(): Promise<SessionRepositoryStorageStats>;
  checkStorageHealth(): Promise<SessionRepositoryHealth>;
}

interface SessionEventStore {
  createSession(...): Promise<void>;
  saveMessage(...): Promise<string>;
  saveToolUse(...): Promise<PersistedToolUse>;
  saveToolResult(...): Promise<string>;
  // input、compaction 与 context append 方法
}
```

PostgreSQL transcript append 会在同一个 transaction 中追加 `transcript`
event 并更新 `session` projection。读取、恢复和 fork 只访问 projection。

## Conformance

第三方 Store 可以直接运行公开的无测试框架 conformance：

```ts
import {
  assertRuntimeStoreConformance,
} from '@blade-ai/agent-sdk/server/testing';

await assertRuntimeStoreConformance(runtimeStore, {
  tenantId: 'conformance-a',
  otherTenantId: 'conformance-b',
});
```

该套件验证 health、Session projection、tenant isolation、command receipt、
agent/durable event、原子 commit、事务回滚和 projection checkpoint。应在专用
schema 或测试数据库中运行。

## 运维边界

- schema 初始化需要 DDL 权限；生产环境可在部署阶段提前调用 `initialize()`。
- `PostgresRuntimeStore` 自建 Pool 时 `close()` 会关闭 Pool；注入的 Pool 由调用方管理。
- `maxAgentEventsPerSession` 只限制可重放的远程 SSE 事件，不裁剪 durable/domain event。
- `maxSessionsPerTenant` 只用于 transcript projection 清理。
- outbox 在本版本只提供原子写入和查询；claim、heartbeat 与执行恢复由下一阶段
  Worker lease 协议负责。
- Redis只能用于通知、wake-up 和短期配额；丢失 Redis 数据不得影响 command、
  event、effect 或 projection 的正确性。
