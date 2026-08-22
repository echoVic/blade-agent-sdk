# Durable Event Store

Durable Event Store 是可恢复执行内核的基础设施。它提供稳定的事件 envelope、
Session 内单调序列、compare-and-append、cursor 分页读取，以及确定性的
Session 生命周期投影。

::: warning 当前集成阶段
Session 只有在显式设置 `SessionOptions.durableEventStore` 时才写入 durable
事件；现有消息 JSONL 保持不变。`resumeSession()` 会自动恢复已接受但尚未跨过
`request_started` 边界的 Request。已开始但尚无 Turn 的 Request，以及活动
Turn，必须先通过 Recovery Coordinator 原子 rollover；待决权限、未知工具结果、
未知模型结果和已完成 Turn 的 Request 仍需显式消解。`non_idempotent`
工具和结果未知的模型调用绝不会被自动重放。
:::

## 安装与导入

协议类型和解析器可从根入口或浏览器安全的 `/core` 导入。Node.js JSONL
adapter 从根入口或 `/local` 导入：

```ts
import {
  CommandId,
  DurableEventSubscription,
  type DurableEventDataMap,
  DurableSessionRecoveryCoordinator,
  DurableSessionProjector,
  DurableSessionJournal,
  DurableEventType,
  EventSequence,
  InputId,
  JsonlDurableEventStore,
  ModelAttemptId,
  PermissionRequestId,
  RequestId,
  SessionId,
  ToolAttemptId,
  TurnId,
} from '@blade-ai/agent-sdk';
```

## Event envelope

```ts
interface DurableEventEnvelope<TType extends DurableEventType> {
  schemaVersion: 2 | 3;
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
  modelAttemptId?: ModelAttemptId;
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
| `request_accepted` | `requestId`、`commandId` | `inputId`、`input`、`priority`、`maxTurns?`、`model?`、`context?`、`recovery?` |
| `request_started` | `requestId` | 空对象 |
| `request_completed` | `requestId` | `output?`、`usage?` |
| `request_failed` | `requestId` | `error` |
| `request_interrupted` | `requestId` | `reason`、`byInputId?` |
| `turn_started` | `requestId`、`turnId` | `turn`、`model?` |
| `turn_completed` | `requestId`、`turnId` | `turn`、`hasToolCalls` |
| `turn_aborted` | `requestId`、`turnId` | `turn`、`reason` |
| `model_request_started` | Request、Turn、`modelAttemptId` | `model`、`streaming` |
| `model_request_completed` | Request、Turn、`modelAttemptId` | 完整模型 `response` |
| `model_request_failed` | Request、Turn、`modelAttemptId` | `error` |
| `model_request_aborted` | Request、Turn、`modelAttemptId` | `reason` |
| `tool_scheduled` | Request、Turn、`toolAttemptId` | `toolCallId`、`toolName`、`input`、`sideEffect`、`interruptBehavior` |
| `tool_started` | Request、Turn、`toolAttemptId` | 工具标识、最终 `input`、解析后的 `sideEffect` |
| `tool_completed` | Request、Turn、`toolAttemptId` | 工具标识、`result` |
| `tool_failed` | Request、Turn、`toolAttemptId` | 工具标识、`error` |
| `tool_cancelled` | Request、Turn、`toolAttemptId` | 工具标识、`reason` |
| `tool_outcome_unknown` | Request、Turn、`toolAttemptId` | 工具标识、`reason` |
| `permission_requested` | Request、Turn、`toolAttemptId` | `permissionRequestId`、工具标识、`input` |
| `permission_resolved` | Request、Turn、`toolAttemptId` | `permissionRequestId`、`decision` |
| `input_applied` | `requestId`、可选 `turnId` | `inputId`、`priority` |

`request_accepted.recovery` 始终使用 v2 的
`{ requestId, turnId, turn }` wire shape。首个 Turn 前的 Request rollover 会
在同一 command 中写入一个 synthetic Turn 作为 provenance；projector 通过
`recoveryKind: 'pre_turn_request'` 暴露该语义，而不扩展持久化的 recovery
字段。

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
依赖当前 projection 生成的 command 应通过 `expectedHeadSequence` 固定其观察
到的 head，避免同进程或其他 writer 更新状态后仍提交旧决策。Recovery
Coordinator 对所有恢复 command 强制设置该前置条件；相同 command 已由竞争者
提交时仍返回 `reconciled`。

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

## 可重连事件订阅

`DurableEventSubscription` 将 cursor 分页读取封装为 pull-based
`AsyncIterableIterator`。订阅打开时固定一个 replay head，先回放该位置之前的
事件，再发送一次 `caught_up` barrier，之后到达的事件标记为 `live`：

```ts
const subscription = await DurableEventSubscription.open(store, sessionId, {
  after: savedCursor,
  pageSize: 100,
  pollIntervalMs: 250,
});

for await (const message of subscription) {
  if (message.type === 'caught_up') {
    markClientReady(message.headSequence);
    continue;
  }

  await deliver(message.event);
  await saveCursor(message.cursor);
}
```

也可以从已初始化的 Session 创建相同订阅：

```ts
const subscription = await session.subscribeDurableEvents({
  after: savedCursor,
});
```

cursor 是严格版本化的 JSON 值，包含 `sessionId`、`sequence` 和 `eventId`。
重连时会验证 cursor 指向的事件仍是 canonical log 中的同一事件；跨 Session、
超前、被替换或产生 sequence gap 的 cursor 会 fail closed，而不是跳过数据。

订阅只在消费者请求下一项时读取下一页，内存和读取压力由 `pageSize` 有界控制。
收到 `session_closed` 后流自动结束；`close()` 正常结束等待中的读取，
`AbortSignal` 则以 `AbortError` 终止。`follow: false` 只回放订阅创建时已经存在
的快照。应用应在成功处理事件后再持久化该 delivery 的 cursor，从而在断线重连
时获得 at-least-once 交付。

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
- `input_applied.turnId` 若存在，必须匹配当前 active Turn。
- Request 终态若携带 `causationEventId`，必须指向该 Request 最后一次持久化边界
  （例如 `request_accepted`、`request_started`、`input_applied` 或 Turn 终止事件）。
- `tool_started` 前必须完成权限决策；未完成的工具会阻止 Turn 结束。
- `causationEventId` 只能引用同一日志中已出现的事件。

任一事件校验失败后 projector 实例会保持 failed 状态；调用方必须丢弃该实例，
修复 canonical journal 后从头重新投影，不能跳过坏事件继续运行。
为兼容既有 schema v2 日志，缺失的 Request 终态 causation 仍可读取；当前
Session writer 会把所有独立 Request 终态绑定到最后一次 Request 边界，
`reconcileRequestOutcome()` 则绑定调用方确认过的最后 Turn 终止事件。Journal
preview 会拒绝新的无锚点或 stale-boundary 写入。同一 command 中紧邻的
Turn/Request 原子终止不需要引用尚未分配的 event ID；直接绕过 Journal 使用
Store 的写入方必须自行遵守同一契约。

`recoveryPlan()` 返回以下动作之一：

| 动作 | 含义 |
|------|------|
| `none` | 没有未完成工作 |
| `resume_request` | Request 已接受且未开始，可恢复同一 Request |
| `rollover_request` | Request 已开始但首个 Turn 尚未开始，可安全转成新 Request |
| `resume_turn` | Turn 尚未调用模型，或模型结果已知且工具可安全继续 |
| `resolve_permissions` | 必须重新呈现或按策略处理未决权限 |
| `reconcile_tool_outcomes` | 工具已开始但没有可靠终态，禁止自动重试 |
| `reconcile_model_outcome` | 模型请求已开始但没有可靠终态，必须先向 provider 或业务记录对账 |
| `reconcile_request_inputs` | 首个 Turn 前的已应用输入集合不明确，必须显式对账 |
| `reconcile_request_outcome` | Turn 已结束但 Request 没有终态，必须先确认最终结果 |

Recovery plan 还返回 `activeModelAttempt`，并分别返回
`retryableToolAttempts`、`cancelableToolAttempts`、`unknownToolAttempts` 和
`pendingPermissions`。started 或
`tool_outcome_unknown` 状态的 `pure` / `idempotent` 工具进入 retryable 集合；
`non_idempotent` 工具进入 unknown 集合，必须在外部对账后由
`tool_completed`、`tool_failed` 或 `tool_cancelled` 解析。在此之前投影器不会
允许 Turn 结束。

模型调用使用独立的 `ModelAttemptId`。Session 在调用 provider 前提交
`model_request_started`，并在调用返回后提交 `model_request_completed`、
`model_request_failed` 或 `model_request_aborted`。活动 model attempt 会阻止
Turn 结束；进程崩溃留下 started attempt 时，plan 返回
`reconcile_model_outcome`，不会把可能已经计费或完成的调用当作从未发生。
一次 model attempt 表示包含内部 HTTP 重试的一次逻辑模型调用；反应式压缩后的
重新调用会创建新的 attempt。高频 token delta 仍是临时流，完整响应在任何后续
Turn 终态前持久化。

## Recovery Coordinator

`DurableSessionRecoveryCoordinator` 在 projector 的恢复分类之上提供受约束的
状态变更 API：

```ts
const coordinator = await DurableSessionRecoveryCoordinator.open(
  store,
  sessionId,
);

const decision = coordinator.planResume();
if (decision.action === 'resume_accepted_request') {
  console.log(decision.request.input);
}

await coordinator.reconcileToolOutcome({
  commandId: CommandId('reconcile-deploy-42'),
  toolAttemptId: ToolAttemptId('attempt-42'),
  outcome: {
    status: 'completed',
    result: { deploymentId: 'dep-42' },
  },
});
```

对结果未知的模型调用，必须查询 provider request 日志或上层业务记录后显式
对账。命令同时绑定 Request、Turn 和 Model Attempt，且通过 Journal CAS
拒绝 stale decision：

```ts
await coordinator.reconcileModelOutcome({
  commandId: CommandId('reconcile-model-42'),
  requestId: RequestId('request-42'),
  turnId: TurnId('turn-42'),
  modelAttemptId: ModelAttemptId('model-attempt-42'),
  outcome: {
    status: 'completed',
    response: {
      content: 'Inspected result',
      usage: {
        promptTokens: 120,
        completionTokens: 30,
        totalTokens: 150,
      },
    },
  },
});
```

也可以确认 `failed` 或 `aborted`。对账后的 Turn 才能进入
`prepareTurnRecovery()`；continuation 会携带有界的已确认模型响应和所有工具
结果，因此不会把未知 provider 调用静默重发。重试同一操作必须复用原
`commandId`。

`reconcileToolOutcome()` 只允许 projector 当前仍可解析的 Tool Attempt，并复用
Journal 的 command 幂等和 CAS 语义。`completed`、`failed` 与 `cancelled`
三种结果都可显式提交；调用方重试时必须复用同一个 `commandId`。

待决权限通过 `resolvePermission()` 处理。`deny` 或 `cancel` 会把
`permission_resolved` 和对应的 `tool_cancelled` 放在同一 command/batch 中，
不会暴露“权限已拒绝但工具仍处于 scheduled”的中间状态：

```ts
await coordinator.resolvePermission({
  commandId: CommandId('deny-deploy-42'),
  permissionRequestId: PermissionRequestId('permission-42'),
  decision: 'deny',
  message: 'Deployment window closed',
});
```

权限恢复为 `allow` 后，应用必须先调用并等待
`startToolAttempt({ commandId, toolAttemptId })`，再使用返回 projection 中完全
相同的输入执行工具。该方法只使用已持久化的操作事实并把 `tool_started` 作为
独立幂等 command 提交，从而保持 persist-before-side-effect。经过权限恢复的
工具会保守标记为 `non_idempotent`，调用方不能在恢复时降低副作用等级。已经处于
`started` 的 `pure` / `idempotent` 工具可直接安全重放，再通过
`reconcileToolOutcome()` 写入终态；已经处于 `started` 的 `non_idempotent`
工具只能查询外部系统后对账，禁止再次执行。

`planResume()` 仅将没有 `input_applied` / `request_started` 且具备完整执行快照
的 accepted Request 标记为 `resume_accepted_request`。Session 会使用 durable
输入以及持久化的 `maxTurns`、模型和 Runtime Context 恢复同一个 `requestId`。
旧日志中缺少执行快照的 Request 继续返回 `recovery_required`。

`request_started` 会在 `UserPromptSubmit`、附件展开、首轮压缩以及 AgentLoop
产生 `turn_start` 之前持久化。因此“尚无 Turn”只证明主模型调用尚未开始，
不能证明 pre-Turn Hook 或其他准备步骤没有产生副作用。仅当 durable
`appliedInputIds` 恰好为初始输入时，plan 才返回 `rollover_request`；缺失初始
应用记录或存在额外 steering 输入时返回 `reconcile_request_inputs`。
初始输入和 steering 输入都在各自 Hook/附件准备前提交 `input_applied`；提交
失败时不会运行准备副作用，提交成功后即使准备失败也不会自动重放该输入。
若输入在一个已完成 Turn 与下一个 Turn 之间进入准备阶段，plan 同样返回
`reconcile_request_inputs`；`sourceLastTurn` 将 rollover 固定到调用方观察到的
Turn 编号。
该保证依赖 writer 遵守相同顺序；若自定义或旧版 writer 曾在
`input_applied` 前执行输入副作用，journal 无法证明该副作用，调用方必须
fail closed，而不能仅依据 `rollover_request` 自动继续。

两种动作都通过 `prepareRequestRecovery()` 收敛，但调用方必须先对账整个
pre-Turn 准备阶段，提供最终准备好的输入，并原样回传观察到的
`activeRequest.appliedInputIds`：

```ts
const request = coordinator.getProjection().activeRequest;
if (!request) throw new Error('No active Request');
const preparedInput = 'prepared input after external reconciliation';

await coordinator.prepareRequestRecovery({
  commandId: CommandId('recover-request-42'),
  requestId: RequestId('request-source-42'),
  inputId: InputId('input-source-42'),
  sourceLastTurn: request.lastTurn,
  recoveryTurnId: TurnId('synthetic-recovery-turn-42'),
  recoveryRequestId: RequestId('request-recovery-42'),
  recoveryInputId: InputId('input-recovery-42'),
  preparation: {
    status: 'reconciled',
    appliedInputIds: request.appliedInputIds ?? [],
    input: preparedInput,
  },
});
```

该 API 在一个 CAS command 中写入可选的 `request_started`（源 Request 尚为
accepted 时），随后写入
`turn_started (synthetic) → turn_aborted → request_interrupted →
request_accepted`。source Request/Input ID、`appliedInputIds` 和 Journal head
都是前置条件；并发出现真实 `turn_started` 或新的输入应用时，旧决策会失败。
恢复后的 Session 会过滤已经应用或对账的旧 pending 输入，并跳过
`UserPromptSubmit`、附件展开和首轮 `beforeTurn` 准备，确保调用方提供的
`preparedInput` 只执行一次。原始多模态 content parts 保持原结构。

如果 Request 已经完成过至少一个 Turn、当前却没有 active Turn，
`recoveryPlan()` 返回 `reconcile_request_outcome`。此时最终模型输出可能已经
发生而 Request 终态尚未持久化，SDK 不会自动重试。查询 provider 或上层业务
记录后，使用稳定 `commandId` 显式提交 `completed`、`failed` 或
`interrupted`：

```ts
const terminalPending = coordinator.getProjection().activeRequest;
if (!terminalPending?.lastTurnEventId) {
  throw new Error('No terminal-pending Turn');
}

await coordinator.reconcileRequestOutcome({
  commandId: CommandId('reconcile-request-42'),
  requestId: terminalPending.requestId,
  lastTurnEventId: terminalPending.lastTurnEventId,
  outcome: {
    status: 'completed',
    output: 'already completed',
    usage: { inputTokens: 120, outputTokens: 30, totalTokens: 150 },
  },
});
```

`lastTurnEventId` 把结论绑定到调用方实际检查过的 Turn 终止事件；若期间出现更新的
Turn，或重试时改用其他锚点，提交会 fail closed。

对于 `resume_turn`，调用 `prepareTurnRecovery()` 可在同一个 CAS command 中：

1. 取消尚未获得可信终态的 `pure` / `idempotent` 或未开始工具；
2. 以 `process_restart` 终止旧 Turn 和 Request；
3. 接受一个包含原始输入、工具终态和 source Request/Turn provenance 的新
   continuation Request。

continuation 会把从未执行的工具标记为 `not_started`，把已开始但可安全重试的
工具标记为 `interrupted_before_trusted_completion`。恢复后的消息历史会丢弃
没有配对结果的旧 tool call；上述 durable 状态随新的 user continuation 一起
送入模型，因此不会构造跨 Store 的伪造 tool result，也不会留下 provider
不接受的悬空 tool call。多模态原始输入仍以原始 content parts 传递，不会降级
成 JSON 文本。权限恢复为 `allow` 但尚未执行的工具使用权限阶段更新后的输入，
并按 `non_idempotent` 保守分类。每个工具的 input、result、error 和 permission
最多保留 4,000 个序列化字符；超限值会携带
`kind: "truncated_recovery_value"`、原始长度和 JSON 前后缀，模型不会把预览误认
为完整结果。

```ts
await coordinator.prepareTurnRecovery({
  commandId: CommandId('recover-turn-42'),
  requestId: RequestId('request-source-42'),
  turnId: TurnId('turn-source-42'),
  recoveryRequestId: RequestId('request-recovery-42'),
  recoveryInputId: InputId('input-recovery-42'),
});

const session = await resumeSession({
  ...options,
  sessionId,
});
for await (const event of session.stream()) {
  // 新 accepted Request 通过现有恢复路径执行。
}
```

整个 rollover 可按相同 `commandId` 重试，竞争进程只能提交一次。active-Turn
provenance 只有在同一 command 中紧邻
`turn_aborted → request_interrupted → request_accepted` 时才有效；pre-Turn
provenance 还要求前置 synthetic `turn_started`。`requestId` 和 `turnId` 是
调用方已观察状态的前置条件，不能隐式切换到更新后的 active Turn。任何已
`completed` / `failed`，或在开始执行后变为 `cancelled` 的
`non_idempotent` 工具都会触发
`DURABLE_RECOVERY_UNSAFE_ROLLOVER`，必须保持 fail-closed；该 API 不使用提示词
绕过未知副作用。

当前 writer 使用 schema v3，并为模型调用增加 `modelAttemptId` 及完整生命周期
事件。Reader 可继续读取 schema v2 日志，并允许在同一 Session 后续追加 v3
batch；schema 版本只能单调升级，不能在 v3 后降回 v2，且 v2 batch 不允许伪装
包含 v3 模型事件。Schema v1 不会被静默推断，需要显式迁移后才能由当前 runtime
恢复。

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
事件会保存原始请求输入、完整模型响应、工具输入和模型侧工具结果；调用方必须将
Store 视为敏感数据存储，并自行配置加密、保留期限和访问控制。

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
| `DurableEventSubscriptionError` | 订阅配置、cursor 锚点或 Store page 不满足续读契约 |
| `DurableSessionRecoveryRequiredError` | Session 存在未完成工作，必须先执行恢复或对账 |
| `SessionDurableRecorderError` | Session runtime 观察到非法 durable 生命周期状态 |
| `DurableEventProjectionError` | schema、事件顺序或关联关系不满足生命周期约束 |
| `DurableEventSequenceConflictError` | compare-and-append 前置条件失败 |
| `DurableEventStoreError` | 参数、cursor、读写或日志完整性错误 |

完整、已换行但 schema 错误或 sequence 不连续的记录被视为损坏日志；Store
不会跳过后继续执行。
