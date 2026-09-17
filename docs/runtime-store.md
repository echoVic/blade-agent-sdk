# Runtime Store

`RuntimeStore` 是服务端 Agent 的共享持久化边界。它统一保存 command receipt、
远程 event、Session 状态、durable journal、worker 路由和 execution lease。
`PostgresRuntimeStore` 是多进程部署的参考实现。

## 安装与导入

```bash
pnpm add @blade-ai/agent-sdk pg
```

```ts
import { AgentServer } from '@blade-ai/agent-sdk/server/infra';
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
- `SessionEventStore`：原子更新 transcript projection。
- `DurableEventStore`：Request、Turn、模型、工具与审批 journal。
- `AgentServerStore`：command receipt、远程 event 和 Session record。

配置 `runtimeStore` 后不允许再覆盖 Session 级 repository、event Store 或
durable Store；混用会返回 `SESSION_CONFLICT`，防止重新产生双写事实源。

## Command 幂等

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
await runtimeStore.completeCommand(
  tenantId,
  commandId,
  claim.leaseId,
  result,
);
```

`claimCommand()` 对 command ID 与 fingerprint 做幂等判定；已完成 command
直接返回已保存结果。`sealCommand()` 在可能产生外部副作用前将 receipt 变为
不可过期，`completeCommand()` 保存确定性结果。长时间停留在 sealed 状态的
command 会由恢复扫描标记为 abandoned，调用方必须对账，不能自动重放。

## PostgreSQL schema

`PostgresRuntimeStore.initialize()` 幂等创建十类表：

| 表 | 作用 |
|----|------|
| `*_metadata` | Runtime Store schema version |
| `*_commands` | command fingerprint、lease、状态和确定性结果 |
| `*_sessions` | tenant-scoped Session record |
| `*_stream_heads` | 每 Session、每 stream 的单调 sequence |
| `*_events` | `agent` 与 `durable` 事件 |
| `*_event_keys` | 独立于 event retention 的幂等键 |
| `*_session_states` | 完整 Session 状态投影 |
| `*_workers` | worker heartbeat、drain 状态与容量 |
| `*_execution_leases` | Session execution lease 与 fencing token |
| `*_session_routes` | Session 调度状态与当前 worker 路由 |

`schema` 与 `tablePrefix` 只接受 PostgreSQL identifier。所有数据值使用
参数化查询。并发 command 和 stream append 使用 transaction-scoped advisory lock；
PostgreSQL 是事实源，Redis 不参与 correctness path。

当前数据库 schema 版本为 `5`。`initialize()` 在全局 advisory lock 内创建当前
schema；如果 metadata 声明其他版本则直接拒绝启动。该 adapter 不携带旧 schema
迁移链，部署方应显式迁移或重新创建数据库。

`InMemoryAgentServerStore` 仍只适合测试和单进程。生产环境不得把它与
PostgreSQL transcript 混用。

## Session projection

`SessionRepository` 从本版本开始只描述 read/projection API。
`SessionEventStore` 描述 append API。实现可以同时实现两个独立端口，但 Session
要求调用方分别显式注入，且不会根据对象的方法集合自动推断能力。

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

PostgreSQL 的每次写入都会在行锁保护下原子更新 `session_states`。读取、恢复和
fork 只访问这份投影；不再维护平行 transcript event stream。

## 运维边界

- schema 初始化需要 DDL 权限；生产环境可在部署阶段提前调用 `initialize()`。
- `PostgresRuntimeStore` 自建 Pool 时 `close()` 会关闭 Pool；注入的 Pool 由调用方管理。
- `maxAgentEventsPerSession` 对可重放的远程 SSE 事件执行滚动保留。
- `maxDurableEventsPerSession`（默认 `100000`）是 durable journal 的硬写入配额。
  达到配额时 Store 拒绝追加，避免静默删除恢复或审计所需的历史。
- `maxSessionsPerTenant` 只用于 transcript projection 清理。
- worker heartbeat、Session 路由与恢复见 [Worker Runtime](./worker-runtime)。
- Redis只能用于通知、wake-up 和短期配额；丢失 Redis 数据不得影响 command、
  event、Session 状态或 lease 的正确性。
