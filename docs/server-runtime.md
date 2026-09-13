# Server Runtime

`AgentServer` 把 server-profile Session 暴露为版本化 command API 和可恢复的
SSE event stream。浏览器通过 `AgentClient` 调用，不直接加载模型 Provider、
工具执行器或本机能力。

## 运行时边界

| 入口 | 职责 |
|------|------|
| `@blade-ai/agent-sdk/server` | `AgentServer`、控制面 Store、租户准入和遥测 |
| `@blade-ai/agent-sdk/browser` | `AgentClient`、`RemoteAgentSession` 和协议类型 |
| `@blade-ai/agent-sdk/protocol` | browser-safe command/event schema、解析器和错误 |
| `@blade-ai/agent-sdk/node` | 本机 JSONL repository、文件、Shell、Sandbox 等 Node adapter |

`/server` 不会根据 `storagePath` 隐式访问本机文件。需要恢复 Session 时，宿主必须
显式传入 `sessionRepository` 和 `sessionEventStore`，或提供一个
`runtimeStore`；`requirePersistentSessions: true` 会使不完整配置 fail-closed。

## 创建服务端

OpenTelemetry adapter 是按需 peer；使用时先安装
`@opentelemetry/api`，再从 `/server/otel` 导入。

```ts
import {
  AgentServer,
  type AgentPrincipal,
} from '@blade-ai/agent-sdk/server';
import {
  OpenTelemetryAgentServerTelemetry,
} from '@blade-ai/agent-sdk/server/otel';
import { JsonlSessionRepository } from '@blade-ai/agent-sdk/node';

const repository = new JsonlSessionRepository('/var/lib/my-agent');

const server = new AgentServer({
  authenticate(request): AgentPrincipal | null {
    const token = request.headers.get('authorization');
    if (token !== `Bearer ${process.env.AGENT_API_TOKEN}`) {
      return null;
    }
    return {
      tenantId: 'tenant-from-auth',
      subject: 'user-from-auth',
      scopes: [
        'session:create',
        'session:read',
        'session:write',
        'permission:resolve',
      ],
    };
  },
  resolveSessionOptions({ principal }) {
    return {
      provider: {
        type: 'openai',
        apiKey: process.env.OPENAI_API_KEY!,
      },
      model: 'gpt-4o-mini',
      sessionRepository: repository,
      sessionEventStore: repository,
      defaultContext: {
        metadata: { tenantId: principal.tenantId },
      },
    };
  },
  requirePersistentSessions: true,
  telemetry: new OpenTelemetryAgentServerTelemetry(),
});

// Mount this Fetch-compatible handler in the HTTP runtime.
export function handleAgentRequest(request: Request): Promise<Response> {
  return server.handle(request);
}
```

JSONL adapter 适合单机 Node.js 部署。多实例服务必须使用一个共享
`runtimeStore`，或共享的 `SessionRepository`、`SessionEventStore` 和
`AgentServerStore`；所有 Store 都必须按认证得到的 `tenantId` 分区。客户端
body 中不存在可信 tenant 字段。

PostgreSQL 单一事实源配置见 [Runtime Store](./runtime-store)。

## SessionExecutor

`AgentServer` 只处理认证、授权、command 幂等、HTTP 和 SSE。Session 的创建、
恢复、fork、输入、abort、关闭、审批关联、并发串行化和 stream pump 均由
`SessionExecutor` 负责。

未传 `sessionExecutor` 时，`AgentServer` 根据 `resolveSessionOptions` 创建
`InProcessSessionExecutor`，行为与原来的进程内运行模式一致：

```ts
import {
  AgentServer,
  InProcessSessionExecutor,
  InMemoryAgentServerStore,
} from '@blade-ai/agent-sdk/server';

const store = new InMemoryAgentServerStore();
const executor = new InProcessSessionExecutor({
  store,
  resolveSessionOptions,
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
});

const server = new AgentServer({
  store,
  sessionExecutor: executor,
  authenticate,
});
```

同时配置自定义 executor 和 `runtimeStore` 时，每个 command 都会通过
`SessionExecutorCommandContext.runtimeStore` 得到认证 tenant 对应的
`RuntimeTenantStore`。自定义 executor 必须将它作为持久化 authority。

自定义 executor 必须：

- 按 tenant 隔离运行中 Session。
- 对同一 Session 的 mutation 串行化。
- 自行持久化 Session record，并把 stream/approval/close event 追加到与
  `AgentServer` 相同的 Store。
- 在 `shutdown()` 中停止接受新工作并回收所拥有的 runtime。
- 不向 command 返回值暴露 Provider credential、内部异常或非 JSON 数据。

这一端口是后续远程 worker、容器 executor 和调度器的替换边界。它不是工具
adapter，也不授予本机能力。

## HTTP API

默认 base path 是 `/v1/agent`：

| Method | Path | 说明 |
|--------|------|------|
| `POST` | `/v1/agent/commands` | 执行一个 protocol v1 command |
| `GET` | `/v1/agent/sessions/:sessionId/events` | SSE replay + live stream |
| `GET` | `/v1/agent/healthz` | 进程存活 |
| `GET` | `/v1/agent/readyz` | `AgentServerStore` readiness |

事件端点接受 `?after=<sequence>` 或标准 `Last-Event-ID`。query 参数优先。
每个 Session 的 `sequence` 单调递增；cursor 早于 Store 保留窗口时返回
`STALE_CURSOR`，客户端不会静默跳过缺失事件。

`AgentServer.handle()` 默认要求 `authenticate` 返回 principal。健康检查不认证。
直接调用 `execute(command, principal)` 和 `events(principal, sessionId)` 适用于
已完成认证的进程内 transport。

## Browser Client

```ts
import { AgentClient } from '@blade-ai/agent-sdk/browser';

const client = new AgentClient({
  baseUrl: 'https://api.example.com/v1/agent',
  client: { name: 'web-console', version: '1.0.0' },
  headers: async () => ({
    authorization: `Bearer ${await getAccessToken()}`,
  }),
});

// createSession 的唯一参数是 metadata，会随 session.create 一起持久化
const session = await client.createSession({ origin: 'console' });
await session.send('检查今天的部署风险');

for await (const event of session.events()) {
  if (event.type === 'permission.requested') {
    await client.resolvePermission(
      session.sessionId,
      event.data.permissionRequestId,
      { approved: false, reason: '需要人工变更窗口' },
    );
  }
  if (event.type === 'session.stream' && event.data.type === 'result') {
    break;
  }
}
```

`session.read` 还会返回 `recovery` 对象：Session 处于 queued/running 时给出路由状态、
attempt、fencing token 与 worker，同时给出本服务是否已加载该 Session、有多少输入已接受但
未生效，以及最后一个事件序号。丢失本地存储的客户端可以据此重连，而不必猜测；当
`loaded` 为 false 时，`messages` 表示**未知**而不是空。

`lastEventSequence` 是重连客户端应当续读的事件位置，它停在**最后一个已完成请求**上：
消息投影在请求运行期间落后于事件日志（内容增量先发布、assistant 消息在回合结束才落库），
所以游标不能等于事件头，否则刷新页面会跳过投影里还没有的输出。停在已完成请求上意味着
客户端会把正在生成的这一轮事件重放一遍，按 event id 去重即可，但不会丢内容。边界要么是
投影自己给出的（见下），要么在读取快照**之前**确定，避免两次读取之间的竞态。

查找边界是有界的：从尾部向前最多扫描若干个窗口（默认 4 × 500 条）。扫到边界就用它；
扫不到就退回**日志仍然保留的起点之前**，让客户端多放一些，而不是跳过没扫到的那一段——
扫描预算不是可以跳过的历史。日志被裁剪时游标同样被夹在保留区间内。

游标是否可信，取决于**消息投影自身的进度**，而不是事件日志。投影随每条消息一起提交
`historyProgress`：消息写失败时会记录 `state: 'failed'` 的缺口，之后的成功请求也**不会**
清除它（只有修复流程能清除）。记录里还带 `coveredRequestId`——投影已经完整持有的最新
请求。transcript 与事件日志是两个不共享序号的存储，请求是两者唯一共有的身份，Server 通过在
日志中定位该请求把它换算成游标。边界来自快照本身，因此快照读取与游标确定之间完成的请求
无法推动它。

投影没有覆盖记录时退回有界扫描，而该扫描本身还被**读取快照之前**观测到的事件头夹住，
读取过程中结束的请求同样被排除在外。存在缺口时，Server 不会使用缺口之后的任何边界，而是
从日志仍保留的起点重放；若日志已被裁剪、或投影报告了缺口，则同时返回
`recoveryIncomplete: true`——回退只能恢复仍然保留的部分，不会被宣称成无损。

修复入口 `repairSessionHistory()` 以 durable journal 为权威重建缺失消息：请求的已接受输入
（按 `inputId`）、完成的工具调用（按 `toolCallId`）、该轮次的 assistant 输出（按它请求的
工具调用匹配）。修复只写数据，不重跑模型或工具；重复执行不会产生重复消息；journal 本身
已被裁剪、无法补齐时保持缺口并返回 `insufficient-durable-data`。

修复的作用域是**缺口所属的请求与轮次**（从缺口记录本身读出），并且把 journal 当历史来读：
即使执行投影已经丢弃了正常结束的请求，它仍然可以被修复。assistant 消息里的工具调用声明
不等于工具结果，因此 `pending` 的工具调用会被重建而不是被当作已存在。只有在重新读取
transcript 并确认 journal 知道的每一部分都真的在之后，缺口才会被清除。

事件日志的保留区间来自 Store 的 `getEventStreamRange`，这是恢复保证的一部分：自定义
Store 若不实现该能力，Server 不会把事件头当作安全游标。此时若日志仍可从起点读取，就
保守地从 0 开始重放；连起点都无法确定（日志已裁剪）时，`recovery` 会带
`recoveryIncomplete: true` 并省略 `lastEventSequence`，明确表示无法给出安全的续读位置，
而不是给一个可能跳过内容的游标。

`appendEvent(..., { idempotencyKey })` 的幂等记录与事件保留期解耦：它按 Session 生命周期
保存，即使事件日志已经裁剪掉原事件，同一个键的重试仍会被识别为重复并返回原始事件。
7.4.4 及更早版本把幂等键写在事件自身的 `event_id` 上，没有独立记录；读取时任一侧命中
即可，旧格式会被就地回填，因此升级不会把已发布的终态结果再发一次。

`AgentClient` 为命令生成稳定的 `commandId`，网络错误、HTTP 408、HTTP 429 和所有
5xx 响应会重试同一个 command。也可通过每个方法的 `commandId` 选项显式控制幂等键。
SSE 断开后从最后一个 sequence 重连；收到 `session.closed` 后停止。

## Protocol v1

Commands：

- `initialize`
- `session.create`
- `session.read`
- `session.list`
- `session.resume`
- `session.fork`
- `session.close`
- `input.submit`
- `request.abort`
- `permission.resolve`

Events：

- `session.stream`
- `permission.requested`
- `session.closed`

所有 envelope 都包含固定的 `protocolVersion: 1`，并由 strict Zod schema
校验。未知字段、未知 command、非法 identifier 和不兼容版本会被拒绝。

## 授权

| Scope | Command |
|-------|---------|
| `session:create` | `session.create` |
| `session:read` | `session.read`、`session.list`、SSE（`session.fork` 需要 `session:read` + `session:create`） |
| `session:write` | `session.resume`、`session.close`、`input.submit`、`request.abort` |
| `permission:resolve` | `permission.resolve` |
| `session:admin` | 满足全部 scope |

Session record、command claim、event log 和审批都以服务端 principal 的
`tenantId` 隔离。跨租户访问返回 `SESSION_NOT_FOUND`，避免泄露 Session 是否存在。

## 幂等与背压

`AgentServerStore` 的 command lifecycle 是：

1. `claimCommand()` 抢占 command ID。
2. `sealCommand()` 在副作用前将 claim 变为不可自动过期。
3. `completeCommand()` 持久化确定性结果。

如果第三步失败，服务端返回 `COMMAND_IN_PROGRESS` 并保持 sealed。它不会依赖 TTL
重新执行一个结果未知的副作用。生产 Store 必须原子实现 claim、seal 和 complete。
每个 claim 同时保存 command payload 的 SHA-256 fingerprint；同一 `commandId`
对应不同 payload 时返回不可重试的 `COMMAND_CONFLICT`，Store 不保存 prompt 明文。

SSE 使用 pull-based `ReadableStream`，每次 pull 最多写一个 frame，
`highWaterMark` 为 1。慢客户端不会让服务端无限 enqueue。Store 的 event retention
必须有明确上限；超过上限后通过 `STALE_CURSOR` 要求客户端重新同步 Session。

## 存储职责

| Port | 事实范围 |
|------|---------|
| `SessionRepository` | transcript state/messages 的只读 projection、fork 与 list |
| `SessionEventStore` | transcript domain event append |
| `AgentServerStore` | tenant Session records、command 幂等、远程 event replay |
| `DurableEventStore` | Request/Turn/model/tool 生命周期 journal 与恢复 |

这些端口职责不同。生产实现可以落在同一个数据库中，但不得在失败时只提交其中一半。
需要多 worker 打开同一 Session 时，还必须配置支持 fencing 的
`DurableExecutionLeaseStore` 和每个 worker 唯一的 `executionLease.ownerId`。

SDK 附带的 `InMemoryAgentServerStore` 只用于单进程和测试。它不提供跨进程幂等、
全局配额或高可用 event replay。

## 准入、审批和遥测

默认每 tenant：

| 限制 | 默认值 |
|------|-------:|
| 并发 command | 8 |
| 排队 command | 64 |
| 每分钟 command | 600 |
| 活动 Session | 100 |

队列满返回 `OVERLOADED`，速率超限返回 `RATE_LIMITED`，并携带
`retryAfterMs`。等待中的 command 在请求 abort 后会从队列移除。

工具确认通过 `permission.requested` event 发布，`permission.resolve` command
完成。审批以 tenant、Session、审批者 `subject` 和 `permissionRequestId` 四元组
隔离，并在超时、请求 abort、Session close 或 server close 时取消。

`OpenTelemetryAgentServerTelemetry` 记录：

- `blade.agent.server.commands`
- `blade.agent.server.command.duration`
- `blade.agent.server.events`
- `blade.agent.server.command` span

默认 metric/span 不包含 prompt、工具参数、Provider credential、subject 或
tenant ID。只有 `includeTenantAttributes: true` 会把 tenant ID 写入 attributes。
`auditSink` 收到 command 元数据和结果，不接收输入 payload。

## 生产检查

- 使用认证系统派生 tenant 和 subject，不信任客户端身份字段。
- 使用共享、原子、持久化的 `AgentServerStore`。
- 使用共享并按 tenant 分区的 `SessionRepository`。
- 多 worker Session 配置 durable event store 和 execution lease。
- 在反向代理关闭 SSE buffering，并设置高于 heartbeat 的 idle timeout。
- 将 CORS、CSRF、cookie 和 token 策略放在 `handle()` 之前的 HTTP 边界。
- 监控 `COMMAND_IN_PROGRESS`；它表示结果不确定，需要运维对账，不能盲目重放。
- 为 event retention、Session retention 和 audit retention 定义独立策略。
- 在关闭实例前停止新流量，并完成 Session handoff 或显式关闭。
