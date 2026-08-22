# Durable Event Store

Durable Event Store 是可恢复执行内核的基础设施。它提供稳定的事件 envelope、
Session 内单调序列、compare-and-append、cursor 分页读取，以及确定性的
Session 生命周期投影。

::: warning 当前集成阶段
Session 只有在显式设置 `SessionOptions.durableEventStore` 时才写入 durable
事件；现有消息 JSONL 保持不变。活动 Request 的自动恢复尚未启用，遇到未完成
工作时 `resumeSession()` 会抛出 `DurableSessionRecoveryRequiredError`，禁止
自动重放已开始的工具。
:::

## 安装与导入

协议类型和解析器可从根入口或浏览器安全的 `/core` 导入。Node.js JSONL
adapter 从根入口或 `/local` 导入：

```ts
import {
  CommandId,
  type DurableEventDataMap,
  DurableSessionProjector,
  DurableSessionJournal,
  DurableEventType,
  EventSequence,
  InputId,
  JsonlDurableEventStore,
  PermissionRequestId,
  RequestId,
  SessionId,
} from '@blade-ai/agent-sdk';
```

## Event envelope

```ts
interface DurableEventEnvelope<TType extends DurableEventType> {
  schemaVersion: 1;
  eventId: EventId;
  sequence: EventSequence;
  sessionId: SessionId;
  type: TType;
  data: DurableEventDataMap[TType];
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

每种事件都有独立的严格 payload，并与 envelope 中必需的关联 ID 组成
`DurableEventDraft` / `DurableEventEnvelope` 判别联合。未知字段、缺失 scope ID、
无效枚举和非有限数值都会在追加前被拒绝。

| 事件 | 必需 scope | 关键 payload |
|------|-----------|--------------|
| `session_created` | Session | `source?`、`parentSessionId?` |
| `session_closed` | Session | `reason` |
| `request_accepted` | `requestId`、`commandId` | `inputId`、`input`、`priority` |
| `request_started` | `requestId` | 空对象 |
| `request_completed` | `requestId` | `output?`、`usage?` |
| `request_failed` | `requestId` | `error` |
| `request_interrupted` | `requestId` | `reason`、`byInputId?` |
| `turn_started` | `requestId`、`turnId` | `turn`、`model?` |
| `turn_completed` | `requestId`、`turnId` | `turn`、`hasToolCalls` |
| `turn_aborted` | `requestId`、`turnId` | `turn`、`reason` |
| `tool_scheduled` | Request、Turn、`toolAttemptId` | `toolCallId`、`toolName`、`input`、`interruptBehavior` |
| `tool_started` | Request、Turn、`toolAttemptId` | `toolCallId`、`toolName` |
| `tool_completed` | Request、Turn、`toolAttemptId` | 工具标识、`result` |
| `tool_failed` | Request、Turn、`toolAttemptId` | 工具标识、`error` |
| `tool_cancelled` | Request、Turn、`toolAttemptId` | 工具标识、`reason` |
| `tool_outcome_unknown` | Request、Turn、`toolAttemptId` | 工具标识、`reason` |
| `permission_requested` | Request、Turn、`toolAttemptId` | `permissionRequestId`、工具标识、`input` |
| `permission_resolved` | Request、Turn、`toolAttemptId` | `permissionRequestId`、`decision` |
| `input_applied` | `requestId`、可选 `turnId` | `inputId`、`priority` |

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
      type: DurableEventType.SESSION_CREATED,
      data: { source: 'create' },
    },
    {
      type: DurableEventType.REQUEST_ACCEPTED,
      requestId,
      commandId,
      data: {
        inputId,
        input: 'Run the deployment checks',
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
console.log(result.lastSequence);     // 3
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

## Command journal

生产代码应优先通过 `DurableSessionJournal` 提交生命周期事件。Journal 在 Store
之上增加：

- 每个实例内的串行提交。
- 写入前的 lifecycle transition 预演。
- 所有事件统一写入调用方提供的 `commandId`。
- CAS 冲突后的有界刷新与重试。
- 相同 command 的幂等 replay。
- `DURABLE_EVENT_WRITE_FAILED` 后的 read-after-failure 对账。

```ts
const journal = await DurableSessionJournal.open(store, sessionId);

const committed = await journal.commit({
  commandId: CommandId('create-session-123'),
  events: [
    {
      type: DurableEventType.SESSION_CREATED,
      data: { source: 'create' },
    },
  ],
});

console.log(committed.status); // committed | replayed | reconciled
console.log(journal.getProjection().status); // open
```

相同 `commandId` 和相同事件再次提交时返回 `replayed`，不会追加第二份事件。
若 command 已存在但内容不同，抛出 `DurableCommandConflictError`。
一个 command 的事件必须在日志中连续；同一 ID 分散在多个区间也按冲突处理。

当底层写入报错后，Journal 会重新读取 canonical log：

- 能找到完整且匹配的 command：返回 `reconciled`。
- 找不到 command 或无法重新读取：抛出
  `DurableCommandOutcomeUnknownError`，且不会自动重试。

后一种情况必须由调用方或更高层 recovery coordinator 对账。自动重试可能重复
执行已经生效但暂时不可见的写入。Journal 会在内存中记录
`getUncertainCommandId()` 并拒绝其他 command；相同 command 只能再次触发读取
对账。`maxConflictRetries` 只控制明确 compare-and-append 冲突的重试，不适用于
unknown outcome。

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

## 状态投影与恢复分类

`DurableSessionProjector` 可以逐页消费事件；`projectDurableSession()` 是一次性
便利函数。投影器会重新执行所有生命周期约束，而不是信任调用方构造的类型：

```ts
const projector = new DurableSessionProjector();
let after: EventSequence | undefined;

do {
  const page = await store.read(sessionId, { after, limit: 100 });
  projector.apply(page.events);
  after = page.nextCursor ?? undefined;
  if (!page.hasMore) break;
} while (true);

const projection = projector.snapshot();
const recovery = projector.recoveryPlan();
```

投影器 fail closed，至少验证：

- 首条事件必须创建 Session，关闭后不能继续追加生命周期事件。
- 一个 Session 同时只能有一个活动 Request，一个 Request 同时只能有一个活动 Turn。
- Request、Turn、Tool Attempt、Permission Request、Command 和已应用 Input ID 不可复用。
- Turn 编号必须连续；关联的 Session、Request、Turn 与 Tool 标识必须一致。
- `tool_started` 前必须完成权限决策；未完成的工具会阻止 Turn 结束。
- `causationEventId` 只能引用同一日志中已出现的事件。

任一事件校验失败后 projector 实例会保持 failed 状态；调用方必须丢弃该实例，
修复 canonical journal 后从头重新投影，不能跳过坏事件继续运行。

`recoveryPlan()` 返回以下动作之一：

| 动作 | 含义 |
|------|------|
| `none` | 没有未完成工作 |
| `resume_request` | Request 已接受但没有活动 Turn，可重新启动 |
| `resume_turn` | 模型调用或尚未开始的工具可以从持久化边界继续 |
| `resolve_permissions` | 必须重新呈现或按策略处理未决权限 |
| `reconcile_tool_outcomes` | 工具已开始但没有可靠终态，禁止自动重试 |

Recovery plan 还分别返回 `retryableToolAttempts`、`cancelableToolAttempts`、
`unknownToolAttempts` 和 `pendingPermissions`。`tool_outcome_unknown` 可以在外部
对账后由 `tool_completed`、`tool_failed` 或 `tool_cancelled` 解析；在此之前
投影器不会允许 Turn 结束。

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
事件会保存原始请求输入、工具输入和模型侧工具结果；调用方必须将 Store 视为
敏感数据存储，并自行配置加密、保留期限和访问控制。

## 一致性边界

`JsonlDurableEventStore` 保证单个 Node.js 进程内多个 Store 实例的串行追加。
它不提供跨进程 fencing。多个进程或多副本服务必须实现
`DurableEventStore` 接口，并使用数据库事务、CAS 或 lease 保证单写者。

`DURABLE_EVENT_WRITE_FAILED` 不代表 batch 一定没有写入：底层写入成功但
`fsync` 失败时，提交结果可能未知。调用方重试前必须重新读取 head，并通过
`commandId` 等关联字段核对结果。当前 Store 尚不提供 command 自动去重。

Store 不持久化 token delta、工具 progress 等高频 UI 事件。只有会影响恢复
决策的 domain event 应进入 durable journal。

## 错误

| 错误 | 说明 |
|------|------|
| `DurableCommandConflictError` | 相同 `commandId` 对应不同内容或非连续事件区间 |
| `DurableCommandOutcomeUnknownError` | 写入失败后无法确认 command 是否提交，Journal 已 fenced |
| `DurableSessionJournalError` | command 输入、Store page 或 commit 返回值违反契约 |
| `DurableSessionRecoveryRequiredError` | Session 存在未完成工作，必须先执行恢复或对账 |
| `SessionDurableRecorderError` | Session runtime 观察到非法 durable 生命周期状态 |
| `DurableEventProjectionError` | schema、事件顺序或关联关系不满足生命周期约束 |
| `DurableEventSequenceConflictError` | compare-and-append 前置条件失败 |
| `DurableEventStoreError` | 参数、cursor、读写或日志完整性错误 |

完整、已换行但 schema 错误或 sequence 不连续的记录被视为损坏日志；Store
不会跳过后继续执行。
