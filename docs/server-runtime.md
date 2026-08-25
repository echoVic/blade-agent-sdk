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
显式传入 `sessionRepository`；`requirePersistentSessions: true` 可使缺少该端口
的配置 fail-closed。

## 创建服务端

```ts
import {
  AgentServer,
  OpenTelemetryAgentServerTelemetry,
  type AgentPrincipal,
} from '@blade-ai/agent-sdk/server';
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

JSONL adapter 适合单机 Node.js 部署。多实例服务必须使用共享
`SessionRepository` 和共享 `AgentServerStore`；repository 还应按认证得到的
`tenantId` 分区。客户端 body 中不存在可信 tenant 字段。

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

const session = await client.createSession({ source: 'console' });
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

`AgentClient` 为命令生成稳定的 `commandId`，网络错误、HTTP 429 和 HTTP 503
重试同一个 command。也可通过每个方法的 `commandId` 选项显式控制幂等键。
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
| `session:read` | `session.read`、`session.list`、`session.fork`、SSE |
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
| `SessionRepository` | transcript append、Session state/messages projection、fork 与 list |
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
完成。审批以 tenant、Session 和 `permissionRequestId` 三元组隔离，并在超时、
请求 abort、Session close 或 server close 时取消。

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
