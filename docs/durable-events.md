# Durable Event Store

Durable Event Store 是可恢复执行内核的第一阶段基础设施。它提供稳定的事件
envelope、Session 内单调序列、compare-and-append 和 cursor 分页读取。

::: warning 当前集成阶段
本阶段不会改变 `Session.send()`、`Session.stream()` 或现有 Session JSONL。
调用方可以独立使用 Event Store；Session 生命周期事件将在后续阶段接入。
:::

## 安装与导入

协议类型和解析器可从根入口或浏览器安全的 `/core` 导入。Node.js JSONL
adapter 从根入口或 `/local` 导入：

```ts
import {
  CommandId,
  DurableEventType,
  EventSequence,
  InputId,
  JsonlDurableEventStore,
  RequestId,
  SessionId,
} from '@blade-ai/agent-sdk';
```

## Event envelope

```ts
interface DurableEventEnvelope {
  schemaVersion: 1;
  eventId: EventId;
  sequence: EventSequence;
  sessionId: SessionId;
  type: DurableEventType;
  data: JsonObject;
  recordedAt: string;
  occurredAt: string;
  commandId?: CommandId;
  requestId?: RequestId;
  turnId?: TurnId;
  toolAttemptId?: ToolAttemptId;
  causationEventId?: EventId;
}
```

- `eventId` 标识单个事件。
- `sequence` 在一个 Session 内从 1 开始严格递增。
- `recordedAt` 是 Store 提交时间。
- `occurredAt` 是业务事件发生时间，未提供时等于 `recordedAt`。
- 关联 ID 使用 branded types，防止不同 ID 被误用。

首版保留了 Session、Request、Turn、Tool、Permission 和输入生命周期事件名。
事件 payload 当前为严格 `JsonObject`；后续阶段会为各事件增加判别联合。

| 范围 | 事件 |
|------|------|
| Session | `session_created`、`session_closed` |
| Request | `request_accepted`、`request_started`、`request_completed`、`request_failed`、`request_interrupted` |
| Turn | `turn_started`、`turn_completed`、`turn_aborted` |
| Tool | `tool_scheduled`、`tool_started`、`tool_completed`、`tool_failed`、`tool_cancelled`、`tool_outcome_unknown` |
| Permission | `permission_requested`、`permission_resolved` |
| Input | `input_applied` |

## 追加事件

```ts
const store = new JsonlDurableEventStore('/var/lib/my-agent');
const sessionId = SessionId('session-123');
const requestId = RequestId('request-123');
const commandId = CommandId('command-123');
const inputId = InputId('input-123');

const result = await store.append(
  sessionId,
  [
    {
      type: DurableEventType.REQUEST_ACCEPTED,
      requestId,
      commandId,
      data: {
        inputId,
        priority: 'next',
      },
    },
    {
      type: DurableEventType.REQUEST_STARTED,
      requestId,
      data: {},
    },
  ],
  {
    expectedLastSequence: null,
  },
);

console.log(result.previousSequence); // null
console.log(result.lastSequence);     // 2
```

一次 `append()` 的事件会写入同一个 batch。Store 在写入前完成 schema 校验并
分配连续 sequence。

## Compare-and-append

`expectedLastSequence` 提供乐观并发控制：

| 值 | 语义 |
|----|------|
| `undefined` | 在当前 head 后追加 |
| `null` | 仅允许空事件流 |
| `EventSequence(n)` | 当前 head 必须严格等于 `n` |

前置条件失败时抛出 `DurableEventSequenceConflictError`，并包含 expected 与
actual sequence。

```ts
await store.append(sessionId, events, {
  expectedLastSequence: EventSequence(12),
});
```

## Cursor 读取

```ts
const page = await store.read(sessionId, {
  after: EventSequence(20),
  limit: 100,
});

for (const event of page.events) {
  consume(event);
}

console.log(page.nextCursor);
console.log(page.headSequence);
console.log(page.hasMore);
```

`after` 是 exclusive cursor。单页限制为 1 到 1000 条；cursor 超过当前 head
会被拒绝，而不是静默返回空结果。

## JSONL 持久化

文件位于：

```text
{storageRoot}/durable-events/{base64url(sessionId)}.jsonl
```

每行是一个完整 append batch，而不是单个事件。该布局保证进程在写入中途崩溃
时，恢复逻辑可以忽略未以换行结束的尾批次，不会接受半个事务。

每次提交：

1. 在进程级 mutex 内重新读取并校验当前 head。
2. 验证 compare-and-append 前置条件。
3. 以一次 batch 写入分配连续 sequence。
4. 调用文件 `fsync` 后才返回成功。

事件文件使用 `0600` 权限，Session ID 经过 base64url 编码，不会成为文件路径。

## 一致性边界

`JsonlDurableEventStore` 保证单个 Node.js 进程内多个 Store 实例的串行追加。
它不提供跨进程 fencing。多个进程或多副本服务必须实现
`DurableEventStore` 接口，并使用数据库事务、CAS 或 lease 保证单写者。

`DURABLE_EVENT_WRITE_FAILED` 不代表 batch 一定没有写入：底层写入成功但
`fsync` 失败时，提交结果可能未知。调用方重试前必须重新读取 head，并通过
`commandId` 等关联字段核对结果。第一阶段尚不提供 command 自动去重。

Store 不持久化 token delta、工具 progress 等高频 UI 事件。只有会影响恢复
决策的 domain event 应进入 durable journal。

## 错误

| 错误 | 说明 |
|------|------|
| `DurableEventSequenceConflictError` | compare-and-append 前置条件失败 |
| `DurableEventStoreError` | 参数、cursor、读写或日志完整性错误 |

完整、已换行但 schema 错误或 sequence 不连续的记录被视为损坏日志；Store
不会跳过后继续执行。
